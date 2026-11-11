// POST /api/forms/event-rsvp against its contract (packages/cloudflare/contracts/openapi.json): every status the handler answers is
// documented, every documented status is answered, and each body conforms to the schema the contract names for that status
// (review of 74113248: the contract listed 200/422/429 with an untyped 200 and missed 403 drill_not_signed and 503 not_recorded).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createValidator, formatProblems } from "@saasreport/core/schema";
import { signDrill, DRILL_HEADER } from "@saasreport/core/form-deliveries";
import { makeKit, seed } from "./helpers.mjs";

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const SPEC = read("../contracts/openapi.json");
const NOTE = read("../../core/schemas/form-notification.schema.json");
const LEDGER = readFileSync(new URL("../../comms/migrations/0003_comms_form_deliveries.sql", import.meta.url), "utf8");
const OP = SPEC.paths["/api/forms/event-rsvp"].post;
const V = createValidator([NOTE]);

/** The schema a response (or the request) names, with the contract's #/components/schemas refs moved into the document's $defs. */
const schemaOf = (node, id) => {
  const defs = JSON.parse(JSON.stringify(SPEC.components.schemas).replaceAll("#/components/schemas/", "#/$defs/"));
  return { $schema: "https://json-schema.org/draft/2020-12/schema", $id: `urn:rsvp-contract:${id}`, $defs: defs, ...JSON.parse(JSON.stringify(node).replaceAll("#/components/schemas/", "#/$defs/")) };
};
const conforms = (status, value) => {
  const node = OP.responses[status]?.content?.["application/json"]?.schema;
  assert.ok(node, `${status} is not documented with a JSON body`);
  assert.deepEqual(formatProblems(createValidator([NOTE, schemaOf(node, status)]).validate(value, `urn:rsvp-contract:${status}`)), [], `the ${status} body does not conform to its contract`);
};

const GOOD = { event: "webinar", name: "Ann", email: "ann@example.org", consent: true };
const delivered = { ok: true, delivery: { receipt: { status: "sent" }, owner: { status: "sent" } } };

test("every status the RSVP handler answers is documented, every documented status is answered, and each body conforms", async () => {
  const seen = new Set();
  const log = console.error; console.error = () => {};
  try {
    const { get, env } = makeKit("en", { now: "2026-10-01T08:00:00Z", options: { events: { rsvp: true } }, env: { COMMS: { fetch: async () => Response.json(delivered) } } });
    env.DB.sqlite.exec(LEDGER);
    await seed(env, { lang: "en" });
    const post = async (body, { headers = {}, ip = "192.0.2.50", raw } = {}) => {
      const r = await get("/api/forms/event-rsvp", { method: "POST", headers: { "content-type": "application/json", origin: "https://en.example.org", "cf-connecting-ip": ip, ...headers }, body: raw ?? JSON.stringify(body) });
      const j = await r.json(); seen.add(String(r.status)); conforms(String(r.status), j); return { status: r.status, j };
    };
    // the request side: what the contract calls a valid request is one
    assert.deepEqual(formatProblems(createValidator([NOTE, schemaOf(OP.requestBody.content["application/json"].schema, "request")]).validate(GOOD, "urn:rsvp-contract:request")), []);
    let r = await post(GOOD);
    assert.equal(r.status, 200); assert.deepEqual([r.j.ok, r.j.email_status, r.j.recorded], [true, "sent", true]);
    r = await post({ ...GOOD, website: "spam" }); assert.equal(r.status, 200, "the honeypot answer conforms too");
    assert.equal((await post(null, { raw: "null" })).status, 400);
    assert.equal((await post(GOOD, { headers: { origin: "https://evil.example" } })).status, 403);
    r = await post({ ...GOOD, test: true }); assert.deepEqual([r.status, r.j.error], [403, "drill_not_signed"]);
    assert.equal((await post(GOOD, { raw: "x".repeat(70_000) })).status, 413);
    assert.equal((await post(GOOD, { headers: { "content-type": "text/plain" } })).status, 415);
    assert.equal((await post({ ...GOOD, consent: false })).status, 422);
    const g405 = await get("/api/forms/event-rsvp"); seen.add(String(g405.status)); conforms(String(g405.status), await g405.json());
    const g411 = await get("/api/forms/event-rsvp", { method: "POST", headers: { "content-type": "application/json", origin: "https://en.example.org" }, body: new Blob([JSON.stringify(GOOD)]) });
    seen.add(String(g411.status)); conforms(String(g411.status), await g411.json());
    for (let i = 0; i < 8; i++) await post(GOOD, { ip: "192.0.2.77" });
    assert.equal((await post(GOOD, { ip: "192.0.2.77" })).status, 429);
    // the engine's final status write failed after the row existed: recorded, answered 200 with the outcome flag, no second lead
    const flaky = makeKit("en", { now: "2026-10-01T08:00:00Z", options: { events: { rsvp: true } }, env: { COMMS: { fetch: async () => Response.json({ ...delivered, outcome_recorded: false }) } } });
    flaky.env.DB.sqlite.exec(LEDGER);
    await seed(flaky.env, { lang: "en" });
    const f = await flaky.get("/api/forms/event-rsvp", { method: "POST", headers: { "content-type": "application/json", origin: "https://en.example.org", "cf-connecting-ip": "192.0.2.61" }, body: JSON.stringify(GOOD) });
    const fj = await f.json(); seen.add(String(f.status)); conforms(String(f.status), fj);
    assert.deepEqual([f.status, fj.ok, fj.recorded, fj.outcome_recorded], [200, true, true, false]);
    assert.equal(flaky.env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM leads").get().n, 1, "one lead");
    // a signed drill passes the header contract
    env.FORMS_DRILL_KEY = "drill-key";
    const header = await signDrill(env.FORMS_DRILL_KEY, "event-rsvp", Date.parse("2026-10-01T08:00:00Z"));
    assert.match(header, new RegExp(OP.parameters[0].schema.pattern));
    assert.equal((await post({ ...GOOD, test: true }, { headers: { [DRILL_HEADER]: header }, ip: "192.0.2.51" })).status, 200);
    // no ledger at all: nothing can be recorded
    const bare = makeKit("en", { now: "2026-10-01T08:00:00Z", options: { events: { rsvp: true } }, env: { COMMS: { fetch: async () => new Response("x", { status: 500 }) } } });
    await seed(bare.env, { lang: "en" });
    const b = await bare.get("/api/forms/event-rsvp", { method: "POST", headers: { "content-type": "application/json", origin: "https://en.example.org", "cf-connecting-ip": "192.0.2.60" }, body: JSON.stringify(GOOD) });
    const bj = await b.json(); seen.add(String(b.status)); conforms(String(b.status), bj);
    assert.deepEqual([b.status, bj.error], [503, "not_recorded"]);
  } finally { console.error = log; }
  assert.deepEqual([...seen].sort(), Object.keys(OP.responses).sort(), "the statuses answered and the statuses documented are the same set");
});
