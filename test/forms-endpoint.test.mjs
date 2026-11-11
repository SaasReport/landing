// The form endpoint (src/form-intake.js) against its contract (contracts/forms.openapi.json), over a real SQLite database
// behind the D1 interface: every status the contract documents is answered here, and no other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { withD1Limits } from "@saasreport/core/d1-limits";
import { intake, validate, reference, MAX_BODY_BYTES, MAX_PER_HOUR, TABLE } from "../src/form-intake.js";
import FORMS from "../src/forms.generated.js";
import { FORMS as DECLARED } from "../src/forms.js";

const contract = JSON.parse(readFileSync(new URL("../contracts/forms.openapi.json", import.meta.url), "utf8"));
const op = contract.paths["/api/forms/{id}"].post;
const URL0 = "https://saasreport.ai/api/forms/early-access";

/** The D1 interface (prepare, bind, first, run, batch) over node:sqlite. */
function d1() {
  const db = withD1Limits(new DatabaseSync(":memory:"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
    all: async () => ({ results: db.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())), raw: db };
}
const good = () => ({ name: "Ada Example", email: "ada@example.com", company: "Example Ltd", role: "Finance lead", reports: [FORMS["early-access"].fields.find((f) => f.key === "reports").options[0]], message: "", consent: true });
const post = (body, { type = "application/json", headers = {}, url = URL0, method = "POST" } = {}) =>
  new Request(url, { method, headers: { ...(type ? { "content-type": type } : {}), origin: "https://saasreport.ai", ...headers }, ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
const send = (req, env, id = "early-access", deps) => intake(req, env, id, FORMS, deps);
const seen = new Set();
async function answer(res, status, code) {
  seen.add(String(res.status));
  assert.equal(res.status, status);
  assert.equal(res.headers.get("cache-control"), "no-store");
  if (status >= 400) {
    assert.match(res.headers.get("content-type"), /^application\/problem\+json/);
    const p = await res.json();
    for (const k of contract.components.schemas.Problem.required) assert.ok(k in p, `problem has ${k}`);
    assert.equal(p.status, status);
    assert.equal(p.code, code);
    return p;
  }
  return res;
}

test("a valid request is stored once and answered 201 with its reference", async () => {
  const db = d1();
  const res = await send(post(good()), { FORMS_DB: db }, "early-access", { now: () => new Date("2026-11-11T10:00:00Z"), uuid: () => "0a1b2c3d-0000-4000-8000-000000000000" });
  await answer(res, 201);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, reference: "SR-20261111-0A1B2C3D" });
  assert.match(body.reference, new RegExp(op.responses[201].content["application/json"].schema.properties.reference.pattern));
  const rows = db.raw.prepare(`SELECT * FROM ${TABLE}`).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, "ada@example.com");
  assert.equal(rows[0].form_id, "early-access");
  assert.equal(rows[0].consent, 1);
  assert.equal(rows[0].created_at, "2026-11-11T10:00:00.000Z");
  assert.deepEqual(JSON.parse(rows[0].fields), { name: "Ada Example", email: "ada@example.com", company: "Example Ltd", role: "Finance lead", reports: good().reports, message: "" });
});

test("a form post without script is stored and sent back to the page with no personal data in the address", async () => {
  const db = d1();
  const p = new URLSearchParams({ name: "Ada Example", email: "ada@example.com", company: "Example Ltd", role: "Finance lead", message: "", consent: "on" });
  for (const r of FORMS["early-access"].fields.find((f) => f.key === "reports").options.slice(0, 2)) p.append("reports", r);
  const res = await send(post(p.toString(), { type: "application/x-www-form-urlencoded" }), { FORMS_DB: db });
  await answer(res, 303);
  const to = res.headers.get("location");
  assert.match(to, /^\/\?request=SR-\d{8}-[0-9A-F]{8}$/);
  for (const v of ["ada", "example", "Finance"]) assert.ok(!to.includes(v));
  assert.equal(JSON.parse(db.raw.prepare(`SELECT fields FROM ${TABLE}`).get().fields).reports.length, 2);
});

test("an undeclared form is 404 before the body is read", async () => {
  const req = post(good(), { url: "https://saasreport.ai/api/forms/nope" });
  await answer(await send(req, { FORMS_DB: d1() }, "nope"), 404, "unknown_form");
  assert.equal(req.bodyUsed, false);
  // a declared form at a path that is not the contract's is not this endpoint
  for (const url of ["https://saasreport.ai/api/forms/early-access/extra", "https://saasreport.ai/forms/early-access", "https://saasreport.ai/api/forms/"]) await answer(await send(post(good(), { url }), { FORMS_DB: d1() }), 404, "unknown_form");
  for (const id of ["__proto__", "constructor", "toString"]) await answer(await send(post(good()), { FORMS_DB: d1() }, id), 404, "unknown_form");
});

test("only POST is allowed", async () => {
  const res = await send(post(null, { method: "GET", type: null }), { FORMS_DB: d1() });
  await answer(res, 405, "method_not_allowed");
  assert.equal(res.headers.get("allow"), "POST");
});

test("a request from another origin is refused; a request with no Origin is not", async () => {
  for (const origin of ["https://evil.example", "https://saasreport.ai.evil.example", "null", "not a url"]) await answer(await send(post(good(), { headers: { origin } }), { FORMS_DB: d1() }), 403, "foreign_origin");
  const req = new Request(URL0, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(good()) });
  await answer(await send(req, { FORMS_DB: d1() }), 201);
});

test("only JSON and form bodies are read", async () => {
  for (const type of ["text/plain", "multipart/form-data; boundary=x", null]) await answer(await send(post("x", { type }), { FORMS_DB: d1() }), 415, "unsupported_media_type");
  await answer(await send(post(good(), { type: "application/json; charset=utf-8" }), { FORMS_DB: d1() }), 201);
});

test("a body over the limit is refused, by its declared length and by its real length", async () => {
  assert.equal(contract["x-limits"].maxBodyBytes, MAX_BODY_BYTES);
  const big = JSON.stringify({ ...good(), message: "x".repeat(MAX_BODY_BYTES) });
  await answer(await send(post(big, { headers: { "content-length": String(big.length) } }), { FORMS_DB: d1() }), 413, "too_large");
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
  const req = new Request(URL0, { method: "POST", headers: { "content-type": "application/json", origin: "https://saasreport.ai" }, body: stream, duplex: "half" });
  await answer(await send(req, { FORMS_DB: d1() }), 413, "too_large");
});

test("a body that is not a flat object is 400", async () => {
  for (const body of ["{", "null", "[1]", '"text"', "7"]) await answer(await send(post(body), { FORMS_DB: d1() }), 400, "malformed");
});

test("every field rule answers 422 with the field and its code, and nothing is stored", async () => {
  const db = d1();
  const cases = [
    [{ name: "" }, "name", "required"], [{ name: "   " }, "name", "required"], [{ name: undefined }, "name", "required"],
    [{ name: "x".repeat(121) }, "name", "too_long"], [{ name: 7 }, "name", "invalid_type"], [{ name: ["a"] }, "name", "invalid_type"],
    [{ email: "not-an-address" }, "email", "invalid_email"], [{ email: "a@b" }, "email", "invalid_email"], [{ email: "a b@c.d" }, "email", "invalid_email"],
    [{ reports: ["Not a report"] }, "reports", "unknown_option"], [{ reports: [good().reports[0], good().reports[0]] }, "reports", "duplicate_option"], [{ reports: [1] }, "reports", "invalid_type"],
    [{ message: "x".repeat(2001) }, "message", "too_long"],
    [{ consent: false }, "consent", "required"], [{ consent: undefined }, "consent", "required"], [{ consent: "no" }, "consent", "required"],
    [{ extra: "x" }, "extra", "unknown_field"], [{ __proto__: "x" }, "__proto__", "unknown_field", '{"__proto__":"x",'],
  ];
  for (const [change, field, code, rawPrefix] of cases) {
    const body = rawPrefix ? rawPrefix + JSON.stringify(good()).slice(1) : { ...good(), ...change };
    const p = await answer(await send(post(body), { FORMS_DB: db }), 422, "invalid");
    assert.ok(p.errors.some((e) => e.field === field && e.code === code), `${field}: ${code} in ${JSON.stringify(p.errors)}`);
  }
  const all = await answer(await send(post({}), { FORMS_DB: db }), 422, "invalid");
  assert.deepEqual(all.errors.map((e) => e.field).sort(), ["company", "consent", "email", "name", "role"]);
  assert.equal(db.raw.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(TABLE), undefined, "no table is made for a refused request");
});

test("values are trimmed, optional answers may be absent, and the declaration is the one of src/forms.js", () => {
  const { values, errors } = validate(FORMS["early-access"], new Map(Object.entries({ name: "  Ada  ", email: " ada@example.com ", company: "Example", role: "Lead", consent: true })));
  assert.deepEqual(errors, []);
  assert.deepEqual(values, { name: "Ada", email: "ada@example.com", company: "Example", role: "Lead", reports: [], message: "" });
  assert.deepEqual(Object.keys(FORMS), Object.keys(DECLARED));
  for (const id of Object.keys(DECLARED)) assert.deepEqual(FORMS[id].fields.map((f) => f.key), DECLARED[id].fields.map((f) => f.key));
  assert.deepEqual(contract.components.schemas["early-access"].required, ["name", "email", "company", "role", "consent"]);
  assert.equal(reference("abcdef12-0000-4000-8000-000000000000", "2026-01-02T03:04:05.000Z"), "SR-20260102-ABCDEF12");
});

test("with no database (a preview deployment) a valid request is 503 and a refused one is still refused", async () => {
  await answer(await send(post(good()), {}), 503, "not_configured");
  await answer(await send(post({}), {}), 422, "invalid");
});

test("a database that fails answers 503 and logs nothing", async () => {
  const logged = [];
  const log = console.log, err = console.error;
  console.log = console.error = (...a) => logged.push(a);
  try {
    const broken = { prepare: () => ({ bind() { return this; }, run: async () => { throw new Error("ada@example.com"); }, first: async () => { throw new Error("x"); } }), batch: async () => { throw new Error("down"); } };
    await answer(await send(post(good()), { FORMS_DB: broken }), 503, "store_failed");
  } finally { console.log = log; console.error = err; }
  assert.deepEqual(logged, []);
});

test("more requests than the hourly limit are 429 and not stored; an hour later they are accepted again", async () => {
  assert.equal(contract["x-limits"].maxPerHour, MAX_PER_HOUR);
  const db = d1();
  let t = Date.parse("2026-11-11T10:00:00Z");
  const deps = { now: () => new Date(t) };
  for (let i = 0; i < MAX_PER_HOUR; i++) { t += 1000; assert.equal((await send(post(good()), { FORMS_DB: db }, "early-access", deps)).status, 201); }
  const res = await send(post(good()), { FORMS_DB: db }, "early-access", deps);
  await answer(res, 429, "too_many");
  assert.equal(res.headers.get("retry-after"), "3600");
  assert.equal(db.raw.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get().n, MAX_PER_HOUR);
  t += 3600000;
  await answer(await send(post(good()), { FORMS_DB: db }, "early-access", deps), 201);
});

test("the statuses answered are exactly the ones the contract documents", () => {
  assert.deepEqual([...seen].sort(), Object.keys(op.responses).sort());
});
