// Every operation against the real handler: the 200 shape, the errors, the limits, CORS, caching, determinism.
// Every response is validated against the schema the contract declares for that status and media type.
import test from "node:test";
import assert from "node:assert/strict";
import { call, env, limiter, assertConforms, contract, COMMIT } from "./helpers.mjs";

const LIMITS = contract["x-limits"];
const get = async (path, e) => { const r = await call(path, { e }); assertConforms(r, "GET", path.split("?")[0].replace(/^\/v1\/registries\/[^/]+$/, "/v1/registries/{name}").replace(/^\/v1\/sample\/stakeholders\/[^/]+$/, "/v1/sample/stakeholders/{id}"), assert); return r; };

test("GET /v1/health answers ok, uncached", async () => {
  const r = await get("/v1/health");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { status: "ok", service: "saasreport-api", api_version: contract.info.version });
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("GET /v1/build answers the served commit, and null when the version carries none", async () => {
  assert.deepEqual((await get("/v1/build")).json, { commit: COMMIT });
  assert.deepEqual((await get("/v1/build", env({ BUILD_COMMIT: undefined }))).json, { commit: null });
  assert.deepEqual((await get("/v1/build", env({ BUILD_COMMIT: "not-a-sha" }))).json, { commit: null });
});

test("/api/build answers kit.build.v1 with the same commit, as the release verifier reads it", async () => {
  const r = await call("/api/build");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { commit: COMMIT, services: {} });
});

test("GET /v1/registries lists every registry with its schema, and each href is served", async () => {
  const r = await get("/v1/registries");
  assert.equal(r.status, 200);
  assert.equal(r.json.registries.length, 8);
  for (const reg of r.json.registries) {
    assert.match(reg.schema, /^https:\/\/saasreport\.ai\/schemas\/.+\.schema\.json$/);
    assert.equal((await get(reg.href)).status, 200);
  }
});

test("GET /v1/registries/{name} serves each core registry as the core publishes it", async () => {
  for (const name of contract.components.parameters.RegistryName.schema.enum) {
    const r = await get(`/v1/registries/${name}`);
    assert.equal(r.status, 200, name);
    const file = JSON.parse((await import("node:fs")).readFileSync(new URL(`../../../vendor/core/registry/${name}.json`, import.meta.url), "utf8"));
    assert.deepEqual(r.json, file, name);
    assert.equal(r.headers.get("cache-control"), "public, max-age=300");
  }
});

test("GET /v1/registries/{name} for an unknown or unserved registry is a 404 problem", async () => {
  for (const name of ["nope", "company", "legal", "naming", "__proto__", "Stakeholders"]) {
    const r = await call(`/v1/registries/${name}`);
    assert.equal(r.status, 404, name);
    assert.equal(r.headers.get("content-type"), "application/problem+json; charset=utf-8");
    assert.equal(r.json.type, "https://api.saasreport.ai/problems/not-found");
    assert.equal(r.json.instance, `/v1/registries/${name}`);
    assertConforms(r, "GET", "/v1/registries/{name}", assert);
  }
});

test("GET /v1/sample/stakeholders/{id} is the engine on sample data, labelled sample", async () => {
  const ids = (await call("/v1/registries/stakeholders")).json.stakeholders.map((s) => s.id);
  assert.ok(ids.length > 3);
  for (const id of ids) {
    const r = await get(`/v1/sample/stakeholders/${id}`);
    assert.equal(r.status, 200, id);
    assert.equal(r.json.sample, true);
    assert.equal(r.json.meta.label, "SAMPLE");
    assert.equal(r.json.stakeholder.id, id);
    assert.deepEqual(r.json.figures.map((f) => f.metric), r.json.stakeholder.priority_metrics);
    for (const f of r.json.figures) assert.ok(f.value === null || Number.isInteger(f.value), `${id} ${f.metric}: an integer or null, never a float`);
  }
});

test("GET /v1/sample/stakeholders/{id} for an unknown stakeholder is a 404 problem", async () => {
  const r = await call("/v1/sample/stakeholders/nobody");
  assert.equal(r.status, 404);
  assertConforms(r, "GET", "/v1/sample/stakeholders/{id}", assert);
});

test("GET /v1/sample/findings is every finding rule that fires on the sample, once, labelled sample", async () => {
  const r = await get("/v1/sample/findings");
  assert.equal(r.status, 200);
  assert.equal(r.json.sample, true);
  assert.ok(r.json.findings.length > 0);
  assert.equal(new Set(r.json.findings.map((f) => f.rule)).size, r.json.findings.length);
});

test("GET /v1/sample/report is the report as the stakeholder reads it; every offered pair works", async () => {
  const types = (await call("/v1/registries/report-types")).json.report_types;
  let n = 0;
  for (const t of types) for (const s of t.stakeholders) {
    const r = await get(`/v1/sample/report?type=${t.id}&stakeholder=${s}`);
    assert.equal(r.status, 200, `${t.id} ${s}`);
    assert.equal(r.json.sample, true);
    assert.ok(r.json.sections.length > 0);
    n++;
  }
  assert.ok(n >= types.length);
});

test("GET /v1/sample/report: 400 without or with a malformed parameter, 404 unknown id, 422 not offered", async () => {
  const types = (await call("/v1/registries/report-types")).json.report_types;
  const stakeholders = (await call("/v1/registries/stakeholders")).json.stakeholders.map((s) => s.id);
  const t = types[0];
  const notOffered = stakeholders.find((s) => !t.stakeholders.includes(s));
  assert.ok(notOffered, "the fixture needs a stakeholder the first report type is not offered to");
  const cases = [
    [`/v1/sample/report`, 400], [`/v1/sample/report?type=${t.id}`, 400], [`/v1/sample/report?stakeholder=${t.stakeholders[0]}`, 400],
    [`/v1/sample/report?type=Bad%20Id&stakeholder=${t.stakeholders[0]}`, 400], [`/v1/sample/report?type=${"a".repeat(65)}&stakeholder=x`, 400],
    [`/v1/sample/report?type=nope&stakeholder=${t.stakeholders[0]}`, 404], [`/v1/sample/report?type=${t.id}&stakeholder=nobody`, 404],
    [`/v1/sample/report?type=${t.id}&stakeholder=${notOffered}`, 422],
  ];
  for (const [path, status] of cases) {
    const r = await call(path);
    assert.equal(r.status, status, path);
    assertConforms(r, "GET", "/v1/sample/report", assert);
  }
});

test("sample responses are deterministic: the same bytes every time, in a fresh isolate and in the same one", async () => {
  const paths = ["/v1/sample/findings", "/v1/sample/stakeholders/ceo_founder", "/v1/sample/report?type=revenue-health&stakeholder=ceo_founder", "/v1/registries"];
  for (const p of paths) {
    const a = await call(p), b = await call(p);
    assert.equal(a.text, b.text, p);
  }
  const fresh = await import(`../src/engine.js?again=${Date.now()}`);
  assert.equal(JSON.stringify(fresh.sampleFindings()), (await call("/v1/sample/findings")).text);
});

test("POST /v1/guard: allow when every number is a fact, deny and list the others", async () => {
  const allow = await call("/v1/guard", { method: "POST", body: { text: "Retention was 104%.", facts: ["104%"] } });
  assert.deepEqual(allow.json, { ok: true, decision: "allow", unsupported: [] });
  const deny = await call("/v1/guard", { method: "POST", body: { text: "Retention was 104% and 7 deals closed.", facts: ["104%"] } });
  assertConforms(allow, "POST", "/v1/guard", assert);
  assert.equal(deny.status, 200);
  assert.deepEqual(deny.json, { ok: false, decision: "deny", unsupported: ["7"] });
  assertConforms(deny, "POST", "/v1/guard", assert);
  assert.equal(deny.headers.get("cache-control"), "no-store");
});

test("POST /v1/guard: 415 for another media type, 400 for broken JSON or a body off the schema", async () => {
  assert.equal((await call("/v1/guard", { method: "POST", body: "text=1", headers: { "content-type": "text/plain" } })).status, 415);
  const broken = await call("/v1/guard", { method: "POST", body: "{not json" });
  assert.equal(broken.status, 400);
  for (const body of [{}, { text: "x" }, { text: 1, facts: [] }, { text: "x", facts: "no" }, { text: "x", facts: [1] }, { text: "x", facts: [], extra: true }, { text: "x".repeat(4001), facts: [] }, { text: "x", facts: Array(201).fill("1") }, { text: "x", facts: ["1".repeat(65)] }]) {
    const r = await call("/v1/guard", { method: "POST", body });
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    assertConforms(r, "POST", "/v1/guard", assert);
  }
});

test("POST /v1/guard: the size cap holds for a declared length and for a stream with none, and the body is not read past it", async () => {
  const cap = LIMITS.max_body_bytes;
  const big = JSON.stringify({ text: "a".repeat(cap), facts: [] });
  const declared = await call("/v1/guard", { method: "POST", body: big, headers: { "content-length": String(big.length) } });
  assert.equal(declared.status, 413);
  assertConforms(declared, "POST", "/v1/guard", assert);
  let pulled = 0;
  const stream = new ReadableStream({ pull(c) { pulled += 1024; c.enqueue(new Uint8Array(1024).fill(97)); if (pulled > cap * 50) c.close(); } });
  const { default: worker } = await import("../src/worker.js");
  const res = await worker.fetch(new Request("https://api.saasreport.ai/v1/guard", { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" }), env(), {});
  assert.equal(res.status, 413);
  assert.ok(pulled <= cap + 64 * 1024, `read ${pulled} bytes for a cap of ${cap}`);
  const justUnder = await call("/v1/guard", { method: "POST", body: JSON.stringify({ text: "a".repeat(3000), facts: [] }) });
  assert.equal(justUnder.status, 200);
});

test("the rate limit is enforced per client address and answers 429 with Retry-After", async () => {
  const e = env({ RATE_LIMITER: limiter(LIMITS.rate.limit) });
  for (let i = 0; i < LIMITS.rate.limit; i++) assert.equal((await call("/v1/health", { e, headers: { "cf-connecting-ip": "203.0.113.7" } })).status, 200);
  const over = await call("/v1/health", { e, headers: { "cf-connecting-ip": "203.0.113.7" } });
  assert.equal(over.status, 429);
  assert.equal(over.headers.get("retry-after"), String(LIMITS.rate.period_seconds));
  assertConforms(over, "GET", "/v1/health", assert);
  assert.equal((await call("/v1/health", { e, headers: { "cf-connecting-ip": "203.0.113.8" } })).status, 200, "another client is not limited");
  assert.equal((await call("/v1/guard", { e, method: "POST", body: { text: "x", facts: [] }, headers: { "cf-connecting-ip": "203.0.113.7" } })).status, 429, "the guard shares the limit");
});

test("without a rate limiter the API answers 503 and nothing else", async () => {
  for (const p of ["/v1/health", "/v1/registries", "/v1/sample/findings"]) {
    const r = await call(p, { e: { BUILD_COMMIT: COMMIT } });
    assert.equal(r.status, 503, p);
    assertConforms(r, "GET", p, assert);
  }
});

test("CORS is open on every answer, errors included, and a preflight is answered", async () => {
  for (const p of ["/v1/health", "/v1/registries/nope", "/v1/nowhere"]) assert.equal((await call(p)).headers.get("access-control-allow-origin"), "*", p);
  const over = await call("/v1/health", { e: env({ RATE_LIMITER: limiter(0) }) });
  assert.equal(over.headers.get("access-control-allow-origin"), "*");
  assert.match(over.headers.get("access-control-expose-headers"), /Retry-After/);
  const pre = await call("/v1/guard", { method: "OPTIONS", headers: { origin: "https://saasreport.ai", "access-control-request-method": "POST" } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-methods"), /POST/);
  assert.match(pre.headers.get("access-control-allow-headers"), /content-type/i);
});

test("data answers are cacheable, and no answer sets a cookie", async () => {
  for (const p of ["/v1/registries", "/v1/registries/metrics", "/v1/sample/findings", "/v1/sample/stakeholders/cfo"]) {
    const r = await call(p);
    assert.match(r.headers.get("cache-control"), /^public, max-age=\d+$/, p);
    assert.equal(r.headers.get("set-cookie"), null);
  }
});

test("an unknown path is a 404 problem and a wrong method is a 405 problem with Allow", async () => {
  const none = await call("/v1/nowhere");
  assert.equal(none.status, 404);
  assert.equal(none.json.type, "https://api.saasreport.ai/problems/not-found");
  const wrong = await call("/v1/health", { method: "POST", body: {} });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get("allow"), "GET");
  const del = await call("/v1/guard", { method: "DELETE" });
  assert.equal(del.status, 405);
  assert.equal(del.headers.get("allow"), "POST");
});

test("no answer carries an email address, a mailto link or a secret-shaped string", async () => {
  const paths = ["/v1/health", "/v1/build", "/v1/registries", ...contract.components.parameters.RegistryName.schema.enum.map((n) => `/v1/registries/${n}`), "/v1/sample/findings", "/v1/sample/stakeholders/ceo_founder", "/v1/sample/report?type=revenue-health&stakeholder=ceo_founder"];
  for (const p of paths) {
    const { text } = await call(p);
    assert.doesNotMatch(text, /mailto:/i, p);
    assert.doesNotMatch(text, /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i, p);
    assert.doesNotMatch(text, /\b(sk|rk)_(live|test)_|whsec_|BEGIN [A-Z ]*PRIVATE KEY/, p);
  }
});
