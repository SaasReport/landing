// GET /api/health derived from the monitor (kit.health.v1) and GET /api/build (kit.build.v1): the two endpoints that make production
// visible (docs/RELEASE.md). Every case that hid a failure on 2026-10-13 is a must-fail here first: a constant {ok: true} while the
// monitor read "failing" on three sites for a week, and a 404 on /api/build so nobody could tell which commit was live.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createValidator, formatProblems } from "@saasreport/core/schema";
import { healthResponse, healthOf, readMonitorStatus } from "../src/health.js";
import { withBuild, buildBehind, commitOf, UNREACHABLE, BUILD_PATH } from "../src/build.js";

const schema = (f) => JSON.parse(readFileSync(new URL(`../../core/schemas/${f}`, import.meta.url), "utf8"));
const HEALTH = schema("health.schema.json"), BUILD = schema("build.schema.json");
const v = createValidator([HEALTH, BUILD]);
const valid = (doc, s) => assert.deepEqual(formatProblems(v.validate(doc, s.$id)), [], JSON.stringify(doc));
const SHA = "a".repeat(40), SHA2 = "b".repeat(40);
const monitor = (doc, { status = 200, type = "application/json" } = {}) => ({ fetch: async () => new Response(typeof doc === "string" ? doc : JSON.stringify(doc), { status, headers: { "content-type": type } }) });
const run = (ok, journeys) => ({ started_at: "2026-10-13T02:46:09.413Z", ok, journeys });

test("must-fail: the monitor reads failing, so /api/health is not ok (503), and says which journeys failed", async () => {
  const env = { MONITOR: monitor({ ok: true, status: "failing", last: run(false, [{ name: "landing", ok: true }, { name: "publishing", ok: false, error: "daily: today's episode (14) is not published" }]) }) };
  const r = await healthResponse(env, { component: "site-web" });
  assert.equal(r.status, 503);
  const j = await r.json();
  valid(j, HEALTH);
  assert.deepEqual([j.ok, j.monitor.status, j.monitor.failed, j.monitor.last], [false, "failing", ["publishing"], "2026-10-13T02:46:09.413Z"]);
  assert.ok(!JSON.stringify(j).includes("episode (14)"), "the error text stays in the monitor; health carries names only");
});

test("must-fail: stale, unknown, a monitor that is not bound, unreachable or answers no JSON: never ok", async () => {
  const cases = [
    [{ MONITOR: monitor({ ok: true, status: "stale", last: run(true, []) }) }, "stale"],
    [{ MONITOR: monitor({ ok: true, status: "unknown", last: null, recent: [] }) }, "unknown"],      // a monitor that had never run
    [{}, "not-bound"],
    [{ MONITOR: { fetch: async () => { throw new Error("down"); } } }, "unreachable"],
    [{ MONITOR: monitor("<html>", { type: "text/html" }) }, "unreachable"],
    [{ MONITOR: monitor({ ok: true, status: "something-else" }) }, "unknown"],
  ];
  for (const [env, want] of cases) {
    const r = await healthResponse(env, { component: "site-web" });
    const j = await r.json();
    valid(j, HEALTH);
    assert.deepEqual([r.status, j.ok, j.monitor.status], [503, false, want], want);
  }
});

test("a hung monitor is bounded: 503, never a hanging health check", async () => {
  const keep = setInterval(() => {}, 1000);
  try {
    const r = await healthResponse({ MONITOR: { fetch: () => new Promise(() => {}) } }, { component: "site-web", timeoutMs: 50 });
    assert.equal(r.status, 503);
    assert.equal((await readMonitorStatus({ MONITOR: { fetch: () => new Promise(() => {}) } }, { timeoutMs: 20 })).reason, "timeout");
  } finally { clearInterval(keep); }
});

test("must-pass: passing is the only ok; the site's own facts ride along and cannot claim ok", async () => {
  const env = { MONITOR: monitor({ ok: true, status: "passing", last: run(true, [{ name: "landing", ok: true }]) }) };
  const r = await healthResponse(env, { component: "site-web", extra: () => ({ podcasts: "on", ok: true, monitor: "forged", component: "other" }) });
  const j = await r.json();
  valid(j, HEALTH);
  assert.deepEqual([r.status, j.ok, j.component, j.monitor.status, j.podcasts], [200, true, "site-web", "passing", "on"]);
  const forged = healthOf("site-web", { ok: true, doc: { status: "failing", last: run(false, []) } }, { ok: true });
  assert.equal(forged.ok, false, "extra can never set ok");
  await assert.rejects(healthResponse(env, {}), /component/);
});

test("must-fail: a Worker without withBuild has no /api/build; with it, the commit it was deployed from (kit.build.v1)", async () => {
  const worker = { fetch: async () => new Response("site", { status: 404 }) };
  assert.equal((await worker.fetch(new Request(`https://x${BUILD_PATH}`), {})).status, 404, "the 2026-10-13 state: /api/build 404");
  const w = withBuild(worker);
  const r = await w.fetch(new Request(`https://x${BUILD_PATH}`), { BUILD_COMMIT: SHA });
  assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "no-store");
  const j = await r.json(); valid(j, BUILD);
  assert.deepEqual(j, { commit: SHA, services: {} });
  assert.equal(await (await w.fetch(new Request("https://x/other"), {})).text(), "site", "every other path is the Worker's");
  assert.equal((await w.fetch(new Request(`https://x${BUILD_PATH}`, { method: "POST" }), {})).status, 405);
});

test("a shell deploy (no BUILD_COMMIT, or not a sha) answers null: a drift, never a guess", async () => {
  for (const env of [{}, { BUILD_COMMIT: "" }, { BUILD_COMMIT: "main" }, { BUILD_COMMIT: SHA.slice(1) }]) assert.equal(commitOf(env), null);
  const j = await (await withBuild({ fetch: async () => new Response("") }).fetch(new Request(`https://x${BUILD_PATH}`), {})).json();
  valid(j, BUILD); assert.equal(j.commit, null);
});

test("the Workers behind service bindings answer under role keys; one that does not answer is unreachable, not null", async () => {
  const mail = withBuild({ fetch: async () => new Response("") });
  const engine = withBuild({ fetch: async () => new Response("") }, async (env) => ({ delivery: await buildBehind(env.MAIL) }));
  const site = withBuild({ fetch: async () => new Response("") }, async (env) => ({ messages: await buildBehind(env.COMMS), monitor: await buildBehind(env.MISSING) }));
  const MAIL = { fetch: (req) => mail.fetch(req, { BUILD_COMMIT: SHA2 }) };
  const COMMS = { fetch: (req) => engine.fetch(req, { BUILD_COMMIT: SHA, MAIL }) };
  const j = await (await site.fetch(new Request(`https://x${BUILD_PATH}`), { BUILD_COMMIT: SHA, COMMS })).json();
  valid(j, BUILD);
  assert.deepEqual(j, { commit: SHA, services: { messages: { commit: SHA, services: { delivery: { commit: SHA2, services: {} } } }, monitor: { commit: UNREACHABLE, services: {} } } });
  const broken = await buildBehind({ fetch: async () => new Response("no", { status: 500 }) });
  assert.equal(broken.commit, UNREACHABLE);
});
