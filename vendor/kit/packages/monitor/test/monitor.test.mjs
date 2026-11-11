import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMonitor, runJourney, summarize, expect, journeys, journeyList, journeyContext, BUILTINS,
  podcastSeries, hasStarted, localParts, isDueToday, seriesDueToday, statusDocument, statusHandler, alertFor, canaryFor, drillFor, DELIVERY_KINDS, reasonCode, REASON_CODES, routeFreshness,
} from "../src/index.js";

const CONFIG = {
  site: { name: "Example", url: "https://example.org/", locale: "en-US", timezone: "UTC" },
  calendar: { system: "gregorian" },
  series: [
    { id: "weekly", kind: "topic", every: "week", on: "sat", at: "06:00", post: true, podcast: { show: "weekly", maxSeconds: 150 }, slugPattern: "week-{date}" },
    { id: "monthly", kind: "report", every: "month", on: 1, at: "06:00", post: true },
    { id: "daily", kind: "term", every: "day", at: "06:00", start: "2026-09-30", podcast: { show: "daily", maxSeconds: 80 }, glossary: true },
  ],
  shows: { weekly: { title: "W", feed: "/podcasts/feed.xml" }, daily: { title: "D" } },
};

// ---------- flake policy ----------

test("flake policy: one retry, only two consecutive failures count", async () => {
  let n = 0;
  const flaky = await runJourney("flaky", async () => { if (n++ === 0) throw new Error("first"); return "ok second time"; });
  assert.equal(flaky.ok, true); assert.equal(flaky.attempts, 2); assert.equal(flaky.notes, "ok second time");
  const broken = await runJourney("broken", async () => expect(false, "h1 missing"));
  assert.equal(broken.ok, false); assert.equal(broken.attempts, 2); assert.equal(broken.error, "h1 missing");
  const first = await runJourney("fine", async () => undefined);
  assert.deepEqual({ ok: first.ok, attempts: first.attempts, notes: first.notes }, { ok: true, attempts: 1, notes: undefined });
  const none = await runJourney("strict", async () => { throw new Error("x"); }, { retries: 0 });
  assert.equal(none.attempts, 1);
  let cleaned = 0;
  await runJourney("cleanup", async () => { throw new Error("y"); }, { onRetry: () => { cleaned++; } });
  assert.equal(cleaned, 1, "onRetry runs between attempts only");
});

test("summarize", () => {
  const r = [{ name: "a", ok: true, attempts: 1 }, { name: "b", ok: true, attempts: 2 }, { name: "c", ok: false, attempts: 2 }];
  assert.deepEqual(summarize(r), { ok: false, passed: 2, failed: ["c"], flaky: ["b"], total: 3 });
  assert.equal(summarize(r.slice(0, 2)).ok, true);
  assert.deepEqual(summarize([]), { ok: true, passed: 0, failed: [], flaky: [], total: 0 });
});

// ---------- journey derivation ----------

test("journey list derives from features, series and shows", () => {
  assert.deepEqual(journeyList(CONFIG), ["landing", "glossary", "podcasts", "publishing", "calendar", "feeds", "form-deliveries"]);
  assert.deepEqual(journeyList({ site: { url: "https://x" } }), ["landing", "glossary", "calendar", "feeds", "form-deliveries"], "no series → no podcasts/publishing");
  assert.deepEqual(journeyList({ ...CONFIG, features: { glossary: false, podcasts: false, calendar: false } }), ["landing", "publishing", "feeds", "form-deliveries"]);
  assert.deepEqual(journeyList({ ...CONFIG, monitor: { skip: ["calendar", "feeds"] } }), ["landing", "glossary", "podcasts", "publishing", "form-deliveries"]);
  assert.deepEqual(journeyList({ ...CONFIG, monitor: { forms: false } }).slice(-1), ["feeds"], "a site with no form opts out explicitly");
  assert.deepEqual(journeyList({ ...CONFIG, monitor: { drill: { form: "contact" } } }).slice(-2), ["form-deliveries", "form-drill"]);
});

// ---------- form deliveries (docs/FORMS.md): the owner hears of every submission, or the monitor alerts ----------

const formCtx = (routes, extra = {}) => {
  const calls = [];
  const get = async (path, init = {}) => {
    calls.push([init.method || "GET", path, init.body ? JSON.parse(init.body) : undefined, init.headers || {}]);
    const h = routes.find(([re]) => re.test(path));
    if (!h) return new Response("not found", { status: 404 });
    const [status, body] = typeof h[1] === "function" ? h[1](calls.length) : h[1];
    return Response.json(body, { status });
  };
  return { calls, ctx: journeyContext({ site: { url: "https://x.example" }, ...extra.config }, { page: null, get, site: "https://x.example", trigger: extra.trigger, now: extra.now, env: extra.env ?? { FORMS_DRILL_KEY: "drill-key" } }) };
};

test("must fail: form-deliveries fails when an owner delivery failed or is stale, with the counts; passes when every owner delivery went", async () => {
  const ok = formCtx([[/deliveries$/, [200, { ok: true, window_hours: 24, pending_after_min: 15, submissions: 3, owner_sent: 3, owner_failed: 0, owner_pending_stale: 0, receipt_failed: 0, last_owner_failure_at: null }]]]);
  await BUILTINS["form-deliveries"].run(ok.ctx);
  const bad = formCtx([[/deliveries$/, [503, { ok: false, window_hours: 24, pending_after_min: 15, submissions: 3, owner_sent: 2, owner_failed: 1, owner_pending_stale: 0, receipt_failed: 0, last_owner_failure_at: "2026-10-13T10:00:00Z" }]]]);
  await assert.rejects(BUILTINS["form-deliveries"].run(bad.ctx), /form deliveries: 503; owner failed 1.*last owner failure 2026-10-13T10:00:00Z/);
  const gone = formCtx([[/deliveries$/, [503, { ok: false, error: "ledger_unreadable" }]]]);
  await assert.rejects(BUILTINS["form-deliveries"].run(gone.ctx), /503 ledger_unreadable/);
});

test("form-drill: on a drill only, a test-marked synthetic submission, then both deliveries proved in the ledger; a missing owner delivery fails it", async () => {
  const config = { monitor: { drill: { form: "contact", fields: { message: "Alert drill: synthetic data" }, timeoutMs: 1, weekday: "mon", at: "08:00" } } };
  const sent = { reference: "C-DRJLL23XXXXXXXXX", form_id: "contact", test: true, receipt: { status: "sent" }, owner: { status: "sent" } };
  // Never use the runner clock: Monday after 08:00 UTC is a real due slot,
  // so an unfrozen "quiet" fixture starts a drill and tries a nonexistent ledger.
  const quiet = formCtx([], { config, trigger: "cron", now: new Date("2026-10-13T09:00:00Z") });
  await BUILTINS["form-drill"].run(quiet.ctx);
  assert.equal(quiet.calls.length, 0, "no drill, no submission");
  const good = formCtx([[/\/api\/forms\/contact$/, [200, { ok: true, reference: "C-DRJLL23XXXXXXXXX" }]], [/deliveries\/C-DRJLL23XXXXXXXXX$/, [200, sent]]], { config, trigger: "drill" });
  await BUILTINS["form-drill"].run(good.ctx);
  const [method, path, body] = good.calls[0];
  assert.deepEqual([method, path], ["POST", "/api/forms/contact"]);
  assert.equal(body.test, true); assert.equal(body.consent, true); assert.match(body.email, /@x\.example$/); assert.equal(body.message, "Alert drill: synthetic data");
  assert.match(good.calls[0][3]["x-kit-form-drill"], /^[0-9]+\.[0-9a-f]{64}$/, "signed with FORMS_DRILL_KEY");
  // scheduled: the cron run of the declared weekday, past its time slot, drills too (2026-10-12 is a Monday); any other weekday does not
  const summary = (last) => [/deliveries$/, [200, { ok: true, last_test_at: last }]];
  const monday = formCtx([summary(null), [/\/api\/forms\/contact$/, [200, { ok: true, reference: "C-DRJLL23XXXXXXXXX" }]], [/deliveries\/C-DRJLL23XXXXXXXXX$/, [200, sent]]], { config, trigger: "cron", now: new Date("2026-10-12T09:00:00Z") });
  await BUILTINS["form-drill"].run(monday.ctx);
  assert.deepEqual(monday.calls.map(([m, p]) => `${m} ${p}`), ["GET /api/forms/deliveries", "POST /api/forms/contact", "GET /api/forms/deliveries/C-DRJLL23XXXXXXXXX"]);
  const { verifyDrill } = await import("@saasreport/core/form-deliveries");
  assert.equal(await verifyDrill("drill-key", "contact", monday.calls[1][3]["x-kit-form-drill"], Date.parse("2026-10-12T09:00:00Z")), true, "signed for the drill's form");
  const tuesday = formCtx([], { config, trigger: "cron", now: new Date("2026-10-13T09:00:00Z") });
  await BUILTINS["form-drill"].run(tuesday.ctx);
  assert.equal(tuesday.calls.length, 0);
  // before the time slot (drill.at) nothing happens, not even a ledger read
  const early = formCtx([], { config, trigger: "cron", now: new Date("2026-10-12T07:59:00Z") });
  await BUILTINS["form-drill"].run(early.ctx);
  assert.equal(early.calls.length, 0);
  // the submission carries the signed drill header; without the shared secret the drill fails before it posts
  // must fail: two cron runs on the same Monday are one drill: the ledger already holds today's test row at the second run
  const runs = [new Date("2026-10-12T08:00:00Z"), new Date("2026-10-12T08:15:00Z"), new Date("2026-10-12T23:45:00Z")];
  let lastTest = null; const posts = [];
  for (const now of runs) {
    const run = formCtx([[/deliveries$/, () => [200, { ok: true, last_test_at: lastTest }]], [/\/api\/forms\/contact$/, () => { posts.push(now); lastTest = now.toISOString(); return [200, { ok: true, reference: "C-DRJLL23XXXXXXXXX" }]; }], [/deliveries\/C-DRJLL23XXXXXXXXX$/, [200, sent]]], { config, trigger: "cron", now });
    await BUILTINS["form-drill"].run(run.ctx);
  }
  assert.equal(posts.length, 1, "one drill for the day, however many cron runs");
  // the next Monday is a new day: the old test row does not suppress it
  const next = formCtx([[/deliveries$/, [200, { ok: true, last_test_at: "2026-10-12T08:00:00Z" }]], [/\/api\/forms\/contact$/, [200, { ok: true, reference: "C-DRJLL23XXXXXXXXX" }]], [/deliveries\/C-DRJLL23XXXXXXXXX$/, [200, sent]]], { config, trigger: "cron", now: new Date("2026-10-19T08:30:00Z") });
  await BUILTINS["form-drill"].run(next.ctx);
  assert.equal(next.calls.filter(([m]) => m === "POST").length, 1);
  // a ledger that cannot say whether today's drill ran is a failure, never a second drill
  const blind = formCtx([[/deliveries$/, [500, { error: "x" }]]], { config, trigger: "cron", now: new Date("2026-10-12T08:30:00Z") });
  await assert.rejects(BUILTINS["form-drill"].run(blind.ctx), /cannot tell whether today's drill already ran/);
  assert.equal(blind.calls.filter(([m]) => m === "POST").length, 0);
  const noKey = formCtx([], { config, trigger: "drill", env: {} });
  await assert.rejects(BUILTINS["form-drill"].run(noKey.ctx), /no FORMS_DRILL_KEY/);
  assert.equal(noKey.calls.length, 0);
  const noOwner = formCtx([[/\/api\/forms\/contact$/, [200, { ok: true, reference: "C-DRJLL23XXXXXXXXX" }]], [/deliveries\/C-DRJLL23XXXXXXXXX$/, [200, { ...sent, owner: { status: "failed", error: "owner_recipients_missing" } }]]], { config, trigger: "drill" });
  await assert.rejects(BUILTINS["form-drill"].run(noOwner.ctx), /owner failed owner_recipients_missing/);
  const pending = formCtx([[/\/api\/forms\/contact$/, [200, { ok: true, reference: "C-DRJLL23XXXXXXXXX" }]], [/deliveries\/C-DRJLL23XXXXXXXXX$/, [200, { ...sent, owner: { status: "pending" } }]]], { config, trigger: "drill" });
  await assert.rejects(BUILTINS["form-drill"].run(pending.ctx), /owner pending/);
  const refused = formCtx([[/\/api\/forms\/contact$/, [404, { ok: false, error: "unknown_form" }]]], { config, trigger: "drill" });
  await assert.rejects(BUILTINS["form-drill"].run(refused.ctx), /drill: POST \/api\/forms\/contact → 404 unknown_form/);
});

test("custom journeys and builtin selection from config.monitor.journeys", () => {
  const cfg = { ...CONFIG, monitor: { journeys: ["feeds", "landing", { name: "pricing", path: "/pricing", selectors: ["h1"] }, { name: "api", run: async () => "ok" }] } };
  const js = journeys(cfg);
  assert.deepEqual(js.map((j) => j.name), ["feeds", "landing", "pricing", "api"]);
  assert.deepEqual(js.map((j) => j.builtin), [true, true, false, false]);
  assert.deepEqual(journeyList({ ...CONFIG, monitor: { journeys: [{ path: "/x" }] } }).slice(-1), ["custom-1"]);
  assert.throws(() => journeys({ monitor: { journeys: ["nope"] } }), /unknown builtin/);
  assert.throws(() => journeys({ monitor: { journeys: [{ name: "landing", path: "/" }] } }), /duplicate/);
  assert.throws(() => journeys({ monitor: { journeys: [{ name: "x" }] } }), /needs run\(\) or path/);
});

test("podcastSeries: show and maxSeconds per series (fallback to shows)", () => {
  assert.deepEqual(podcastSeries(CONFIG), [{ series: "weekly", show: "weekly", maxSeconds: 150 }, { series: "daily", show: "daily", maxSeconds: 80 }]);
  assert.deepEqual(podcastSeries({ series: [{ id: "s", podcast: true }], shows: { s: { maxSeconds: 60 } } }), [{ series: "s", show: "s", maxSeconds: 60 }]);
});

// ---------- due today ----------

test("localParts and isDueToday across timezones and calendar systems", () => {
  const sat = new Date("2026-10-03T07:00:00Z"); // Saturday
  const p = localParts(CONFIG, sat);
  assert.deepEqual(p, { iso: "2026-10-03", weekday: 6, day: 3, localDay: 3, hm: "07:00" });
  assert.deepEqual(seriesDueToday(CONFIG, sat).map((s) => s.id), ["weekly", "daily"]);
  assert.deepEqual(seriesDueToday(CONFIG, new Date("2026-10-03T05:00:00Z")).map((s) => s.id), [], "not yet published");
  assert.deepEqual(seriesDueToday(CONFIG, new Date("2026-10-01T08:00:00Z")).map((s) => s.id), ["monthly", "daily"]);
  assert.deepEqual(seriesDueToday(CONFIG, new Date("2026-09-29T08:00:00Z")).map((s) => s.id), [], "before start");
  // Jalali month day: 2026-09-23 is 1405/07/01; late UTC evening is already the next day further east.
  const fa = { ...CONFIG, site: { ...CONFIG.site, timezone: "Asia/Dubai" }, calendar: { system: "jalali" } };
  const q = localParts(fa, new Date("2026-09-22T21:00:00Z"));
  assert.equal(q.iso, "2026-09-23"); assert.equal(q.localDay, 1); assert.equal(q.hm, "01:00");
  assert.equal(isDueToday({ every: "month", on: 1 }, q), true);
  assert.equal(isDueToday({ every: "week", on: ["tue", "wed"] }, q), true);
  assert.equal(isDueToday({ every: "week", on: 5 }, q), false);
  assert.equal(isDueToday({ every: "year" }, q), false);
});

// ---------- journeys against a fake site ----------

function fakeSite(routes) {
  const calls = [];
  const get = async (path, init) => {
    calls.push([path, init]);
    const h = routes[path];
    if (!h) return new Response("nf", { status: 404 });
    const v = typeof h === "function" ? h(init) : h;
    if (v instanceof Response) return v;
    return typeof v === "string" ? new Response(v) : Response.json(v);
  };
  get.calls = calls;
  return get;
}

test("publishing journey checks today's glossary episode and the weekly slug", async () => {
  const get = fakeSite({
    "/api/glossary/today": { term: { slug: "apr", term: "APR" }, number: 12, episode: { slug: "daily-12" } },
    "/api/podcasts?series=weekly&limit=3": { episodes: [{ slug: "week-2026-10-03", published_at: "2026-10-03T06:00:00Z" }] },
    "/blog/week-2026-10-03": "<html>",
  });
  const ctx = journeyContext(CONFIG, { page: null, get, site: "https://example.org", now: new Date("2026-10-03T07:00:00Z") });
  assert.equal(ctx.today, "2026-10-03");
  const notes = await BUILTINS.publishing.run(ctx);
  assert.equal(notes, "weekly: week-2026-10-03; daily: apr");

  const missing = fakeSite({ "/api/glossary/today": { term: { slug: "apr" }, number: 12 }, "/api/podcasts?series=weekly&limit=3": { episodes: [] } });
  const ctx2 = journeyContext(CONFIG, { page: null, get: missing, site: "s", now: new Date("2026-10-03T07:00:00Z") });
  await assert.rejects(BUILTINS.publishing.run(ctx2), /week-2026-10-03 is not published/);
  const ctx3 = journeyContext(CONFIG, { page: null, get: missing, site: "s", now: new Date("2026-10-02T07:00:00Z") });
  await assert.rejects(BUILTINS.publishing.run(ctx3), /today's episode \(12, apr\) is not published/);
});

test("publishing: without a slug pattern an episode published today (site timezone) counts", async () => {
  const cfg = { site: { url: "https://e", timezone: "Asia/Tokyo" }, series: [{ id: "w", every: "day", podcast: true }] };
  const get = fakeSite({ "/api/podcasts?series=w&limit=3": { episodes: [{ slug: "e1", published_at: "2026-10-02T20:00:00Z" }] } });
  const ctx = journeyContext(cfg, { page: null, get, site: "https://e", now: new Date("2026-10-03T01:00:00Z") });
  assert.equal(await BUILTINS.publishing.run(ctx), "w: e1");
});

test("feeds journey derives feed paths from shows and features", async () => {
  const rss = "<rss><channel><item></item></channel></rss>";
  const get = fakeSite({
    "/blog/feed.xml": rss, "/podcasts/feed.xml": rss, "/podcasts/daily/feed.xml": rss,
    "/sitemap.xml": "<urlset><url><loc>https://example.org/glossary/apr</loc></url></urlset>",
    "/llms.txt": "# Example\n", "/robots.txt": "User-agent: *\nSitemap: https://example.org/sitemap.xml",
  });
  const ctx = journeyContext(CONFIG, { page: null, get, site: "https://example.org" });
  const notes = await BUILTINS.feeds.run(ctx);
  assert.equal(notes, "/blog/feed.xml /podcasts/feed.xml /podcasts/daily/feed.xml /sitemap.xml /llms.txt /robots.txt");

  const noItems = fakeSite({ "/blog/feed.xml": "<rss></rss>" });
  await assert.rejects(BUILTINS.feeds.run(journeyContext(CONFIG, { page: null, get: noItems, site: "s" })), /\/blog\/feed.xml is not an RSS feed/);

  const minimal = fakeSite({ "/robots.txt": "User-agent: *" });
  const off = { features: { blog: false, podcasts: false, sitemap: false, llms: false } };
  assert.equal(await BUILTINS.feeds.run(journeyContext(off, { page: null, get: minimal, site: "s" })), "/robots.txt");
});

test("declarative custom journey (plain fetch)", async () => {
  const [j] = journeys({ features: {}, monitor: { journeys: ["feeds", { name: "health", path: "/health", contains: "ok" }] } }).slice(1);
  const ctx = journeyContext({}, { page: null, get: fakeSite({ "/health": "all ok" }), site: "s" });
  await j.run(ctx);
  const bad = journeyContext({}, { page: null, get: fakeSite({ "/health": "down" }), site: "s" });
  await assert.rejects(j.run(bad), /does not contain «ok»/);
});


// ---------- fakes: a ready monitor (two routes, its own D1 by id, a healthchecks.io dead-man). Values are fixtures, not real. ----------

const HC = "https://hc-ping.com/0f2c5c3e-6a1b-4c1d-9e2f-3a4b5c6d7e8f";
function fakeDB({ last = null, failWrite = false, failUpdate = false, onUpdate = null } = {}) {
  const rows = [], updates = [], deliveries = [];
  return { rows, updates, deliveries, prepare: (sql) => ({
    first: async () => (last ? { started_at: last } : null),
    bind: (...a) => ({ run: async () => {
      if (failWrite && /INSERT INTO monitor_runs/.test(sql)) throw new Error("D1 down");
      if (failUpdate && /^UPDATE monitor_runs/.test(sql)) throw new Error("D1 update down");
      if (/INSERT INTO monitor_deliveries/.test(sql)) deliveries.push(a); else if (/^UPDATE/.test(sql)) { updates.push(a); onUpdate?.(a); } else rows.push([sql, a]);
      return { meta: { changes: 1 } };
    }, all: async () => ({ results: [] }),
    // today's delivered canary for a route (L11: once per route per UTC day)
    first: async () => (/FROM monitor_deliveries/.test(sql) ? (deliveries.find((d) => d[1] === a[0] && d[2] === "canary" && d[3] === 1 && d[5] >= a[1]) ? { done: 1 } : null) : null) }),
  }) };
}
function fakeComms(log, { status = 200 } = {}) { return { fetch: async (url, init) => { log.push(["email", JSON.parse(init.body)]); return new Response(JSON.stringify({ id: "d1" }), { status }); } }; }
const ALERT_CFG = { channels: { email: { templates: { alert: "ops.alert" } } } };
const readyEnv = (log = [], extra = {}) => ({
  MONITOR_ROUTES: "email,telegram", MONITOR_NOTIFY_TO: "ops@example.invalid", COMMS: fakeComms(log),
  MONITOR_TELEGRAM_CHAT_ID: "-1001234567", TELEGRAM_BOT_TOKEN: "123456:fixture",
  MONITOR_DB: fakeDB(), MONITOR_DB_ID: "mon-db-id", MONITOR_WATCHED_DB_IDS: "site-db-id,comms-db-id",
  MONITOR_DEADMAN_PROVIDER: "healthchecks.io", MONITOR_DEADMAN_URL: HC, MONITOR_STALE_AFTER_MIN: "1560", MONITOR_FETCH_TIMEOUT_MS: "10000", ...extra,
});
/** fetch for the runner: dead-man pings, the Telegram Bot API (per-plan), and the site. */
function router(log, { telegram = "ok", hc = 200, site = () => new Response("nf", { status: 404 }) } = {}) {
  return async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://hc-ping.com/")) { log.push(["ping", u]); return new Response("OK", { status: hc }); }
    if (u.startsWith("https://api.telegram.org/")) {
      log.push(["telegram", JSON.parse(init.body).text]);
      if (telegram === "network") throw new TypeError("fetch failed (injected)");
      return new Response(JSON.stringify(telegram === "ok" ? { ok: true, result: { message_id: 1 } } : { ok: false, description: "chat not found (injected)" }));
    }
    return site(u, init);
  };
}
function fakeStorage() { const m = new Map(); return { get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } }; }
const QUIET = { features: { blog: false, podcasts: false, sitemap: false, llms: false, glossary: false, calendar: false } };
const cfgWith = (journeys, extra = {}) => ({ site: { name: "Example", url: "https://example.org" }, ...QUIET, ...ALERT_CFG, monitor: { skip: Object.keys(BUILTINS), journeys }, ...extra });

// ---------- status (contract kit.monitor-status.v1) ----------

import { readFileSync } from "node:fs";
import { createValidator, formatProblems } from "@saasreport/core/schema";
const STATUS_SCHEMA = JSON.parse(readFileSync(new URL("../contracts/status.schema.json", import.meta.url), "utf8"));
const statusProblems = (doc) => formatProblems(createValidator([STATUS_SCHEMA]).validate(doc, STATUS_SCHEMA.$id));

test("status document and handler follow the contract; no fallback to the site's DB", async () => {
  assert.deepEqual(statusDocument([]), { ok: true, status: "unknown", last: null, recent: [], routes: [] });
  const rows = [{ started_at: "2026-10-01T02:45:00.000Z", finished_at: "2026-10-01T02:46:00.000Z", trigger: "cron", ok: 0, results_json: '[{"name":"x","ok":false}]' }, { started_at: "2026-09-30T02:45:00.000Z", ok: 1, trigger: "cron", results_json: "[]" }];
  const deliveries = [{ route: "email", ok: 1, at: "2026-10-01T02:46:00.000Z" }, { route: "telegram", ok: 0, error: "chat not found", at: "2026-10-01T02:46:00.000Z" }, { route: "telegram", ok: 1, at: "2026-09-30T02:46:00.000Z" }];
  const d = statusDocument(rows, { now: Date.parse("2026-10-01T05:00:00Z"), staleAfterMin: 1560, deliveries });
  assert.equal(d.status, "failing"); assert.equal(d.last.journeys[0].name, "x"); assert.equal(d.recent.length, 2);
  assert.deepEqual(d.routes.find((r) => r.route === "telegram"), { route: "telegram", last_attempt_at: "2026-10-01T02:46:00.000Z", last_ok_at: "2026-09-30T02:46:00.000Z", last_reason: "rejected", failed: 1 });
  assert.doesNotMatch(JSON.stringify(d), /chat not found/, "L12: the public document carries the reason code, never the provider's text");
  assert.deepEqual(statusProblems(d), [], "the contract holds for what the producer makes");
  assert.ok(statusProblems({ ok: true }).length, "an empty document is not a status");
  const env = { MONITOR_DB: { prepare: (q) => ({ bind: () => ({ all: async () => ({ results: /monitor_runs/.test(q) ? rows : deliveries }) }) }) } };
  const res = await statusHandler(env, { now: Date.parse("2026-10-01T05:00:00Z") });
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(statusProblems(await res.json()), []);
  assert.equal((await statusHandler({ DB: env.MONITOR_DB })).status, 503, "no fallback to the site's DB");
  const noTable = { MONITOR_DB: { prepare: () => ({ bind: () => ({ all: async () => { throw new Error("D1_ERROR: no such table: monitor_runs"); } }) }) } };
  assert.equal((await (await statusHandler(noTable)).json()).status, "unknown");
  // re-review: the 503 of an unbound monitor database carries a reason code, not a sentence
  const unbound = await statusHandler({});
  assert.equal(unbound.status, 503); assert.deepEqual(await unbound.json(), { ok: false, status: "unknown", reason: "not-configured" });
});

test("a drill run reads as a drill in GET /status, in the contract; the old mapping (drill → manual) fails", () => {
  const rows = [{ started_at: "2026-10-09T10:21:52.000Z", finished_at: "2026-10-09T10:22:05.000Z", trigger: "drill", ok: 1, results_json: "[]" }, { started_at: "2026-10-09T06:15:00.000Z", trigger: "cron", ok: 1, results_json: "[]" }];
  const d = statusDocument(rows, { now: Date.parse("2026-10-09T11:00:00Z"), staleAfterMin: 1560, deliveries: [] });
  assert.equal(d.last.trigger, "drill");
  assert.deepEqual(d.recent.map((r) => r.trigger), ["drill", "cron"]);
  assert.deepEqual(statusProblems(d), []);
  // must-fail: the mapping before drill mode reported a drill as manual
  const old = (t) => (t === "cron" ? "cron" : "manual");
  assert.notEqual(old("drill"), d.last.trigger);
  assert.notDeepEqual(statusProblems({ ...d, last: { ...d.last, trigger: "panic" } }), [], "an unknown trigger is outside the contract");
});

test("delivery kinds have one source, the contract: every kind the runner sends is in it, and an unknown kind is refused before it is written", async () => {
  const DELIVERY_SCHEMA = JSON.parse(readFileSync(new URL("../contracts/delivery.schema.json", import.meta.url), "utf8"));
  const sent = [...readFileSync(new URL("../src/runner.js", import.meta.url), "utf8").matchAll(/kind: "([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(sent)].filter((k) => !DELIVERY_SCHEMA.properties.kind.enum.includes(k)), []);
  assert.deepEqual([...DELIVERY_KINDS].sort(), [...DELIVERY_SCHEMA.properties.kind.enum].sort());
  const log = [];
  const env = readyEnv(log);
  const { MonitorRunner } = createMonitor(cfgWith([{ name: "ok", run: async () => "fine" }]), { fetch: router(log) });
  const r = new MonitorRunner({ storage: fakeStorage() }, env);
  await r.run("drill");
  const v = createValidator([DELIVERY_SCHEMA]);
  for (const d of env.MONITOR_DB.deliveries) {
    const row = { run_started_at: d[0], route: d[1], kind: d[2], ok: d[3], error: d[4], at: d[5] };
    assert.deepEqual(formatProblems(v.validate(row, DELIVERY_SCHEMA.$id)), [], JSON.stringify(row));
  }
  await assert.rejects(r.recordDelivery("2026-10-09T00:00:00.000Z", "email", "panic", true, null), /delivery kind "panic" is not in contracts\/delivery\.schema\.json/);
});

test("REVIEW 6: a stale limit that is not configured reads as not configured (the status says so); no literal stands in for it", async () => {
  const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) };
  for (const bad of ["abc", "0", "-5", "1.5", ""]) {
    const body = await (await statusHandler({ MONITOR_DB: db, MONITOR_STALE_AFTER_MIN: bad }, { now: Date.parse("2026-10-01T05:00:00Z") })).json();
    assert.equal(body.reason, "not-configured", `"${bad}" is not a limit`); assert.equal(body.status, "unknown"); assert.equal("stale_after_min" in body, false, "no invented limit is reported");
    assert.deepEqual(statusProblems(body), []);
  }
  const unset = await (await statusHandler({ MONITOR_DB: db }, { now: Date.parse("2026-10-01T05:00:00Z") })).json();
  assert.deepEqual([unset.status, unset.reason, "stale_after_min" in unset], ["unknown", "not-configured", false], "unset: not configured, no invented limit");
  assert.equal(statusDocument([], { now: 1, staleAfterMin: NaN }).reason, "not-configured");
  const set = await (await statusHandler({ MONITOR_DB: db, MONITOR_STALE_AFTER_MIN: "90" }, { now: Date.parse("2026-10-01T05:00:00Z") })).json();
  assert.equal(set.stale_after_min, 90, "the declared value, from the environment");
  // guard.js holds the settings: no default for a number there, nor in the status and the runner
  assert.deepEqual(Object.keys(GUARD_DEFAULTS).sort(), ["dbBinding", "deadManEnv"], "names only");
  assert.deepEqual([guardSettings({}, {}).staleAfterMin, guardSettings({}, {}).fetchTimeoutMs], [NaN, NaN]);
  assert.deepEqual([guardSettings({ monitor: { staleAfterMin: 90, fetchTimeoutMs: 5000 } }, {}).staleAfterMin, guardSettings({}, { MONITOR_FETCH_TIMEOUT_MS: "5000" }).fetchTimeoutMs], [90, 5000]);
  for (const k of ["MONITOR_STALE_AFTER_MIN", "MONITOR_FETCH_TIMEOUT_MS"]) {
    const env = readyEnv(); delete env[k];
    assert.equal(readiness(env, ALERT_CFG).filter((p) => p.startsWith(`${k} (or `)).length, 1, `${k} unset: the run is refused`);
  }
  assert.equal(staleness("2026-10-01T00:00:00Z", Date.parse("2026-10-01T00:01:00Z")).stale, true, "no limit: stale, never fresh");
  for (const file of ["guard.js", "status.js", "runner.js"]) assert.doesNotMatch(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), /\b(1560|10000)\b/, `${file} has no copy of a default`);
});

test("REVIEW 8: a declared route that was never attempted appears as never-attempted, and the watcher fails on it", async () => {
  const rows = routeFreshness([{ route: "email", kind: "canary", ok: 1, error: null, at: "2026-10-03T02:46:00.000Z" }], ["email", "telegram"]);
  assert.deepEqual(rows.find((r) => r.route === "telegram"), { route: "telegram", last_attempt_at: null, last_ok_at: null, last_reason: "never-attempted", failed: 0 });
  assert.equal(routeFreshness([], ["email"]).length, 1);
  const db = { prepare: (q) => ({ bind: () => ({ all: async () => ({ results: /monitor_runs/.test(q) ? [] : [{ route: "email", kind: "canary", ok: 1, error: null, at: "2026-10-03T02:46:00.000Z" }] }) }) }) };
  const doc = await (await statusHandler({ MONITOR_DB: db, MONITOR_ROUTES: "email,telegram" }, { now: Date.parse("2026-10-03T05:00:00Z") })).json();
  assert.deepEqual(statusProblems(doc), []); assert.equal(doc.routes.find((r) => r.route === "telegram").last_reason, "never-attempted");
  const { watchStatus } = await import("../../cli/src/resilience/watch.js");
  const now = Date.parse("2026-10-03T05:00:00Z");
  const withRun = { ...doc, status: "passing", last: { started_at: "2026-10-03T04:00:00.000Z", finished_at: null, trigger: "cron", ok: true, journeys: [] }, recent: [] };
  const r = await watchStatus("https://m.example/status", { staleAfterMin: 1560, routes: [], now, fetch: async () => new Response(JSON.stringify(withRun), { headers: { "content-type": "application/json" } }) });
  assert.equal(r.ok, false); assert.match(r.problems.join("\n"), /route telegram: never attempted/, "failed even when the watcher was not told about the route");
});

test("REVIEW 8: the latest delivery is read per declared route, so a chatty route cannot push another route's delivery out of the rows", async () => {
  // email has 300 deliveries since 2026-10-02; telegram has ONE, older than all of them: a global LIMIT 200 would lose it
  const all = [];
  for (let i = 0; i < 300; i++) all.push({ route: "email", kind: "alert", ok: 1, error: null, at: new Date(Date.parse("2026-10-02T00:00:00Z") + i * 60000).toISOString() });
  all.push({ route: "telegram", kind: "canary", ok: 1, error: null, at: "2026-10-01T02:46:00.000Z" });
  const seen = [];
  const db = { prepare: (q) => ({ bind: (...a) => ({ all: async () => {
    if (/monitor_runs/.test(q)) return { results: [] };
    seen.push({ q, a });
    const route = a[0], rows = all.filter((d) => d.route === route).sort((x, y) => (x.at < y.at ? 1 : -1));
    const lastOk = rows.find((d) => d.ok)?.at ?? "";
    return { results: rows.filter((d) => d.at >= lastOk).slice(0, a[2]) };
  } }) }) };
  const doc = await (await statusHandler({ MONITOR_DB: db, MONITOR_ROUTES: "email,telegram", MONITOR_STALE_AFTER_MIN: "1560" }, { now: Date.parse("2026-10-02T06:00:00Z") })).json();
  assert.deepEqual(seen.map((x) => x.a[0]), ["email", "telegram"], "one query per declared route");
  assert.ok(seen.every((x) => /WHERE route = \? AND at >= COALESCE/.test(x.q) && !/LIMIT 200/.test(x.q)));
  assert.deepEqual(doc.routes.map((r) => [r.route, r.last_attempt_at, r.last_ok_at, r.last_reason, r.failed]), [["email", "2026-10-02T04:59:00.000Z", "2026-10-02T04:59:00.000Z", null, 0], ["telegram", "2026-10-01T02:46:00.000Z", "2026-10-01T02:46:00.000Z", null, 0]]);
  assert.deepEqual(statusProblems(doc), []);
});

test("REVIEW 7: every outbound call has a timeout (configurable, a default from GUARD_DEFAULTS): a hung URL cannot hold the run", async () => {
  // no timeout configured: no call goes out at all (a default in code could differ from resilience.json)
  let called = 0;
  const none = await pingDeadMan({ MONITOR_DEADMAN_PROVIDER: "healthchecks.io", MONITOR_DEADMAN_URL: HC }, {}, "ok", { fetch: async () => { called++; return new Response("", { status: 200 }); } });
  assert.deepEqual([none.sent, called, /^MONITOR_FETCH_TIMEOUT_MS is not set/.test(none.error)], [false, 0, true]);
  const hung = (u, init) => new Promise((_, rej) => { init?.signal?.addEventListener("abort", () => rej(new Error("The operation was aborted due to timeout"))); });
  const env = { MONITOR_DEADMAN_PROVIDER: "healthchecks.io", MONITOR_DEADMAN_URL: HC };
  const keep = setInterval(() => {}, 1000);   // AbortSignal.timeout does not keep a Node process alive; a real Worker is kept by the request
  const r = await pingDeadMan(env, { monitor: { fetchTimeoutMs: 40 } }, "ok", { fetch: hung }).finally(() => clearInterval(keep));
  assert.equal(r.sent, false); assert.match(r.error, /timeout/, "the aborted call answered, so the run was not held");
  assert.ok(readiness(readyEnv([], { MONITOR_FETCH_TIMEOUT_MS: "soon" }), ALERT_CFG).some((p) => /MONITOR_FETCH_TIMEOUT_MS/.test(p)), "a timeout that is not a positive whole number refuses the run");
  // a route whose adapter never answers (a service binding ignores signals): the run still finishes, and says which route hung
  const log = [];
  const hungComms = { fetch: () => new Promise(() => {}) };
  const { MonitorRunner } = createMonitor(cfgWith([{ name: "ok", run: async () => "fine" }], { monitor: { skip: Object.keys(BUILTINS), journeys: [{ name: "ok", run: async () => "fine" }], fetchTimeoutMs: 60 } }), { fetch: router(log) });
  const out = await new MonitorRunner({ storage: fakeStorage() }, readyEnv(log, { COMMS: hungComms })).run("cron");
  assert.equal(out.ok, false); assert.match(out.routes.email.error, /timed out/);
});

test("a run whose stored results cannot be read is failing, whatever its stored ok (Codex review of #122)", () => {
  const d = statusDocument([{ started_at: "c", ok: 1, results_json: "{not json" }]);
  assert.equal(d.last.ok, false);
  assert.equal(d.status, "failing");
  assert.match(d.last.journeys[0].error, /not JSON/);
});

test("alert text", () => {
  const a = alertFor({ site: { name: "Example" } }, "https://example.org", { total: 3 }, [{ name: "a", ok: true }, { name: "b", ok: false, error: "boom" }], "2026-10-03T07:00:00Z");
  assert.equal(a.subject, "Example: 1 of 3 monitor journeys failed");
  assert.deepEqual(a.lines, ["b: boom"]);
  assert.equal(a.idempotencyKey, "monitor:2026-10-03T07:00:00Z");
  assert.match(canaryFor({ site: { name: "Example" } }, "https://example.org", "t").subject, /canary/);
});

// ---------- worker + runner ----------

test("worker: POST /run needs the bearer token; unknown paths 404", async () => {
  const { worker } = createMonitor({ ...CONFIG, ...ALERT_CFG }, { fetch: router([]) });
  let ran = 0;
  const env = { ...readyEnv(), MONITOR_TOKEN: "secret", RUNNER: { idFromName: (n) => n, get: (id) => ({ fetch: async () => { ran++; return Response.json({ ok: true, id }); } }) } };
  assert.equal((await worker.fetch(new Request("https://m/run", { method: "POST" }), env)).status, 401);
  assert.equal((await worker.fetch(new Request("https://m/run", { method: "POST", headers: { authorization: "Bearer nope" } }), env)).status, 401);
  assert.equal((await worker.fetch(new Request("https://m/run", { method: "POST", headers: { authorization: "Bearer secret" } }), { ...env, MONITOR_TOKEN: "" })).status, 401);
  const ok = await worker.fetch(new Request("https://m/run", { method: "POST", headers: { authorization: "Bearer secret" } }), env);
  assert.deepEqual(await ok.json(), { ok: true, id: "example.org" });
  assert.equal((await worker.fetch(new Request("https://m/run"), env)).status, 405);
  assert.equal((await worker.fetch(new Request("https://m/"), env)).status, 404);
  const waits = [];
  await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.equal(ran, 2);
});

test("runner: records results, retries flaky journeys, alerts on failure, canary on every route, locks", async () => {
  let flakes = 0;
  const cfg = { site: { name: "Example", url: "https://example.org" }, ...ALERT_CFG, monitor: { journeys: [
    "feeds",
    { name: "flaky", run: async () => { if (flakes++ === 0) throw new Error("blip"); return "ok"; } },
    { name: "browser", run: async ({ page }) => { const { p } = await page("/x"); expect(await p.$("h1"), "no h1"); } },
  ] }, ...QUIET };
  const launched = [];
  const fakePage = { on() {}, setViewport: async () => {}, goto: async () => ({ status: () => 200 }), $: async () => null, close: async () => {} };
  const puppeteer = { connect: async () => { throw new Error("expired"); }, launch: async (_b, opts) => { launched.push(opts); return { sessionId: () => "s1", newPage: async () => fakePage, disconnect: async () => {} }; } };
  const log = [];
  const { MonitorRunner } = createMonitor(cfg, { puppeteer, fetch: router(log, { site: (u) => new Response(u.endsWith("/robots.txt") ? "User-agent: *" : "nf", { status: u.endsWith("/robots.txt") ? 200 : 404 }) }) });
  const env = readyEnv(log, { BROWSER: {} });
  const storage = fakeStorage();
  const r = new MonitorRunner({ storage }, env);
  const out = await r.run("cron");
  assert.equal(out.ok, false);
  assert.deepEqual(out.failed, ["browser"]);
  assert.deepEqual(out.flaky, ["flaky"]);
  assert.equal(launched[0].keep_alive, 600000);
  assert.equal(env.MONITOR_DB.rows.length, 1);
  assert.equal(env.MONITOR_DB.rows[0][1][2], "cron"); assert.equal(env.MONITOR_DB.rows[0][1][3], 0);
  assert.equal(env.MONITOR_DB.rows[0][1][5], "sent");
  const emails = log.filter((x) => x[0] === "email").map((x) => x[1].params.subject), chats = log.filter((x) => x[0] === "telegram").map((x) => x[1]);
  assert.ok(emails.some((t) => /1 of 3/.test(t)) && emails.some((t) => /canary/.test(t)), "the failure alert and the canary by email");
  assert.ok(chats.some((t) => /1 of 3/.test(t)) && chats.some((t) => /canary/.test(t)), "and by telegram");
  assert.deepEqual(env.MONITOR_DB.deliveries.map((d) => [d[1], d[2], d[3]]), [["email", "alert", 1], ["email", "canary", 1], ["telegram", "alert", 1], ["telegram", "canary", 1]]);
  assert.deepEqual(log.filter((x) => x[0] === "ping").map((x) => x[1]), [HC]);
  assert.equal(env.MONITOR_DB.updates.at(-1)[0], "sent", "the dead-man result is stored in the run row");
  assert.equal(await storage.get("lock"), undefined, "lock released");
  await storage.put("lock", Date.now());
  assert.deepEqual(await r.run("manual"), { ok: false, error: "already_running" });
});

test("runner without a site url records a runner failure, alerts it, and the dead-man hears fail", async () => {
  const log = [];
  const { MonitorRunner } = createMonitor({ ...ALERT_CFG, monitor: { journeys: ["feeds"] } }, { fetch: router(log) });
  const env = readyEnv(log);
  const out = await new MonitorRunner({ storage: fakeStorage() }, env).run();
  assert.equal(out.ok, false);
  assert.match(out.results[0].error, /no site url/);
  assert.equal(env.MONITOR_DB.rows.length, 1);
  assert.match(log.find((x) => x[0] === "ping")[1], /\/fail$/);
});

test("landing: monitor.landing.counts must match exactly", async () => {
  const els = { h1: 1, ".chips a": 14 };
  const p = { $: async (s) => (els[s] ? {} : null), $$: async (s) => Array.from({ length: els[s] || 0 }), bringToFront: async () => {} };
  const cfg = { site: { url: "https://e" }, features: { podcasts: false, glossary: false, calendar: false }, monitor: { landing: { counts: { ".chips a": 14 } } } };
  const ctx = journeyContext(cfg, { page: async () => ({ p, errors: [] }), get: fakeSite({}), site: "https://e" });
  await BUILTINS.landing.run(ctx);
  els[".chips a"] = 13;
  await assert.rejects(BUILTINS.landing.run(ctx), /\.chips a: 13 \(expected 14\)/);
});

test("landing: the lazy section is reached although the page grows above it while it scrolls (the term of the day on two downstream sites)", async () => {
  // a page like acme.example on 2026-10-13 (shortened): the glossary section starts at 14000 px, and every scroll step loads lazy
  // content above it (+260 px). A target measured once ends ~5000 px short; the observer fires only when the section is within the viewport.
  const VIEW = 900;
  const page = (grow) => {
    let y = 0, sectionAt = 14000;
    const rect = () => ({ top: sectionAt - y });
    return {
      $: async (s) => (s === "h1" || s === "#glossary" || (s === "[data-glossary-today]" && rect().top < VIEW) ? {} : null),
      $$: async () => [], bringToFront: async () => {},
      $eval: async (s, fn) => fn({ getBoundingClientRect: rect }),
      mouse: { wheel: async ({ deltaY }) => { y += deltaY; sectionAt += grow; } },
      waitForSelector: async () => { if (rect().top >= VIEW || rect().top < -400) throw new Error("timeout"); return {}; },
    };
  };
  const cfg = { site: { url: "https://e" }, features: { podcasts: false, glossary: true, calendar: false }, monitor: { landing: { sections: ["glossary"] } } };
  for (const grow of [0, 260]) {
    const p = page(grow);
    const ctx = journeyContext(cfg, { page: async () => ({ p, errors: [] }), get: fakeSite({}), site: "https://e" });
    await BUILTINS.landing.run(ctx);
    const top = await p.$eval("#glossary", (e) => e.getBoundingClientRect().top);
    assert.ok(top < VIEW && top > -400, `grow ${grow}: the section ends at ${top} px, inside the viewport`);
  }
  // a section that cannot be scrolled to the top (the page's end) stops when a step moves nothing, not after 400 steps
  let steps = 0;
  const end = { $: async () => ({}), $$: async () => [], bringToFront: async () => {}, $eval: async (s, fn) => fn({ getBoundingClientRect: () => ({ top: 600 }) }), mouse: { wheel: async () => { steps++; } }, waitForSelector: async () => ({}) };
  await BUILTINS.landing.run(journeyContext(cfg, { page: async () => ({ p: end, errors: [] }), get: fakeSite({}), site: "https://e" }));
  assert.equal(steps, 1);
});

test("hasStarted / podcastSeries(config, parts): a show announced before its first slot is not expected yet", () => {
  const s = { id: "legal", every: "week", on: "sun", at: "06:00", start: "2026-10-02", podcast: { show: "legal" } }; // first Sunday: 2026-10-04
  const at = (iso, hm = "12:00") => ({ iso, hm });
  assert.equal(hasStarted(s, at("2026-10-03")), false);
  assert.equal(hasStarted(s, at("2026-10-04", "05:59")), false);
  assert.equal(hasStarted(s, at("2026-10-04", "06:00")), true);
  assert.equal(hasStarted(s, at("2026-11-01")), true);
  assert.equal(hasStarted({ id: "x" }, at("2000-01-01")), true);
  const cfg = { ...CONFIG, series: [...CONFIG.series, s] };
  assert.deepEqual(podcastSeries(cfg, at("2026-09-30")).map((x) => x.series), ["weekly", "daily"]);
  assert.deepEqual(podcastSeries(cfg, at("2026-10-05")).map((x) => x.series), ["weekly", "daily", "legal"]);
  assert.equal(podcastSeries(cfg).length, 3);
});

test("podcasts journey: an episode without an accepted provenance record fails the monitor (the t=0 rule on production)", async () => {
  const ep = (extra) => ({ slug: "e1", url: "https://example.org/podcasts/e1", audio: "/podcasts/audio/e1.mp3", duration_ms: 60_000, ...extra });
  const AUDIT0 = { published: 9, unaccepted: 0, problems: [], catchup: { count: 0, slugs: [] }, missing: [], missing_count: 0 };
  const AUDIT = { published: 9, unaccepted: 0, problems: [], catchup: { count: 0, slugs: [] }, missing: [], missing_count: 0 };
  const site = (e, audit = AUDIT) => fakeSite({
    "/api/podcasts?series=weekly&limit=1": { episodes: [e], audit }, "/api/podcasts?series=daily&limit=1": { episodes: [e], audit },
    "/podcasts/audio/e1.mp3": () => new Response("x", { status: 206, headers: { "content-range": "bytes 0-0/200000" } }),
  });
  const page = async () => ({ p: { $: async () => true }, errors: [] });
  const run = (e, cfg = CONFIG, audit) => BUILTINS.podcasts.run(journeyContext(cfg, { page, get: site(e, audit), site: "https://example.org", now: new Date("2026-10-03T07:00:00Z") }));
  assert.match(await run(ep({ provenance_problem: null, origin: "cron" })), /weekly: e1 60s/);
  await assert.rejects(run(ep({ provenance_problem: "no provenance record" })), /e1: no provenance record/);
  await assert.rejects(run(ep({ provenance_problem: 'origin "admin" is not accepted (cron, cron-retry)' })), /origin "admin"/);
  await assert.rejects(run(ep({})), /does not report provenance/);
  await assert.rejects(run(ep({ provenance_problem: null }), CONFIG, { published: 9, unaccepted: 2, problems: [{ slug: "old-1", problem: "no provenance record" }] }), /2 of 9 published episodes have no accepted provenance, e\.g\. old-1: no provenance record/, "the newest episode is fine, an older one is not");
  assert.match(await run(ep({}), { ...CONFIG, monitor: { podcasts: { provenance: false } } }), /weekly: e1/);
  // catch-ups are reported distinctly; a day still missing after the window is an alert
  assert.match(await run(ep({ provenance_problem: null }), CONFIG, { ...AUDIT0, catchup: { count: 2, slugs: ["week-2026-10-05", "term-card"] } }), /catch-ups: 2 episode\(s\) made by the cron for missed days \(week-2026-10-05, term-card\)/);
  await assert.rejects(run(ep({ provenance_problem: null }), CONFIG, { ...AUDIT0, missing_count: 1, missing: [{ date: "2026-10-05", slug: "week-2026-10-05" }] }), /1 due day\(s\) have no episode \(catch-up did not fill them\), e\.g\. 2026-10-05 week-2026-10-05/);
});


// ---------- t=0 guards (guard.js): every review finding reproduced first ----------

import { readiness, assertReady, staleness, pingDeadMan, routes, MonitorNotReady, staleAlert, guardSettings, deadManUrlProblem, GUARD_DEFAULTS } from "../src/index.js";

test("guard: a ready monitor has no problems; every route goes through resolveChannels (the function that sends)", () => {
  assert.deepEqual(readiness(readyEnv(), ALERT_CFG), []);
  assert.deepEqual(routes(readyEnv(), ALERT_CFG).map((r) => [r.channel, Boolean(r.adapter)]), [["email", true], ["telegram", true]]);
  assert.throws(() => assertReady({}, {}), MonitorNotReady);
});

test("REVIEW R2: the monitor's database is compared by ID, never by object identity", () => {
  assert.match(readiness(readyEnv([], { MONITOR_WATCHED_DB_IDS: "site-db-id,mon-db-id" }), ALERT_CFG).join(), /is a database this monitor watches/);
  assert.match(readiness(readyEnv([], { MONITOR_DB_ID: "" }), ALERT_CFG).join(), /MONITOR_DB_ID is not set/);
  assert.match(readiness(readyEnv([], { MONITOR_WATCHED_DB_IDS: "" }), ALERT_CFG).join(), /MONITOR_WATCHED_DB_IDS is not set/);
  const { MONITOR_DB, ...noDb } = readyEnv();
  assert.match(readiness(noDb, ALERT_CFG).join(), /MONITOR_DB is missing/);
});

test("REVIEW R3: malformed destinations, a missing COMMS binding or template, a blank token and a non-https webhook are NOT ready", () => {
  const p = (extra, cfg = ALERT_CFG) => readiness(readyEnv([], extra), cfg).join("\n");
  assert.match(p({ MONITOR_NOTIFY_TO: "not-an-email" }), /route email: .*not an email address/);
  assert.match(p({ MONITOR_NOTIFY_TO: "a@b.example;c@d.example" }), /route email: .*other than a comma/);
  assert.match(p({ MONITOR_NOTIFY_TO: " , " }), /route email: MONITOR_NOTIFY_TO is empty/);
  assert.match(p({ COMMS: undefined }), /route email: service binding COMMS is missing/);
  assert.match(p({}, {}), /route email: no email template/);
  assert.match(p({ TELEGRAM_BOT_TOKEN: " " }), /route telegram: TELEGRAM_BOT_TOKEN is empty or malformed/);
  assert.match(p({ MONITOR_TELEGRAM_CHAT_ID: "x" }), /route telegram: MONITOR_TELEGRAM_CHAT_ID is not a chat id/);
  assert.match(p({ MONITOR_ROUTES: "webhook", MONITOR_WEBHOOK_URL: "x" }), /route webhook: MONITOR_WEBHOOK_URL is not an https URL/);
  assert.match(p({ MONITOR_ROUTES: "" }), /no alert route is declared/);
});

test("REVIEW R5: the dead-man provider is declared and its URL shape checked per provider; github-actions needs no URL", () => {
  const p = (extra) => readiness(readyEnv([], extra), ALERT_CFG).join("\n");
  assert.match(p({ MONITOR_DEADMAN_PROVIDER: "" }), /MONITOR_DEADMAN_PROVIDER must be one of/);
  assert.match(p({ MONITOR_DEADMAN_URL: "https://" }), /MONITOR_DEADMAN_URL: is not an https URL/);
  assert.match(p({ MONITOR_DEADMAN_URL: ` ${HC}` }), /is not an https URL/);
  assert.match(p({ MONITOR_DEADMAN_URL: "https://example.org/ping" }), /not a healthchecks.io ping URL/);
  assert.equal(deadManUrlProblem("other", "https://example.org/ping"), null);
  assert.deepEqual(readiness(readyEnv([], { MONITOR_DEADMAN_PROVIDER: "github-actions", MONITOR_DEADMAN_URL: "" }), ALERT_CFG), []);
});

test("REVIEW R6 / low: staleness is exact, a future run is stale, and a non-numeric limit is refused (no NaN default)", () => {
  assert.deepEqual(staleness("2026-10-01T00:00:00Z", Date.parse("2026-10-01T01:00:59Z"), 60), { stale: true, ageMin: 60, future: false });
  assert.equal(staleness("2026-10-01T00:00:00Z", Date.parse("2026-10-01T01:00:00Z"), 60).stale, false);
  assert.deepEqual(staleness("2099-01-01T00:00:00Z", Date.parse("2026-10-01T00:00:00Z"), 60).future, true);
  assert.equal(staleness("2099-01-01T00:00:00Z", Date.parse("2026-10-01T00:00:00Z"), 60).stale, true);
  assert.equal(statusDocument([{ started_at: "2099-01-01T00:00:00Z", ok: 1, trigger: "cron", results_json: "[]" }], { now: Date.parse("2026-10-01T00:00:00Z"), staleAfterMin: 60 }).status, "stale");
  assert.equal(guardSettings({ monitor: { staleAfterMin: "60" } }).staleAfterMin, 60);
  assert.ok(Number.isNaN(guardSettings({}, { MONITOR_STALE_AFTER_MIN: "abc" }).staleAfterMin));
  assert.match(readiness(readyEnv([], { MONITOR_STALE_AFTER_MIN: "abc" }), ALERT_CFG).join(), /not set to a positive whole number/);
});

test("worker: scheduled() on an unready monitor FAILS the cron (throws) and the dead-man switch hears fail", async () => {
  const log = [];
  const { worker } = createMonitor({ ...CONFIG, ...ALERT_CFG }, { fetch: router(log) });
  await assert.rejects(worker.scheduled({}, readyEnv(log, { MONITOR_NOTIFY_TO: "" }), {}), /refuses to run: route email/);
  assert.deepEqual(log.filter((x) => x[0] === "ping").map((x) => x[1]), [`${HC}/fail`]);
  assert.equal((await createMonitor(CONFIG).worker.fetch(new Request("https://m/status"), {})).status, 503);
});

test("runner: refuses with 503 when a route would not deliver, and records nothing", async () => {
  const env = readyEnv([], { MONITOR_NOTIFY_TO: "" });
  const { MonitorRunner } = createMonitor({ ...CONFIG, ...ALERT_CFG }, { fetch: router([]) });
  const r = new MonitorRunner({ storage: fakeStorage() }, env);
  assert.equal((await r.run("cron")).error, "monitor_not_ready");
  assert.equal(env.MONITOR_DB.rows.length, 0);
  assert.equal((await r.fetch(new Request("https://monitor/run?trigger=cron"))).status, 503);
});

test("stale-run detection: the runner alerts when the previous run is too old", async () => {
  const log = [];
  const { MonitorRunner } = createMonitor(cfgWith([{ name: "ok", run: async () => "fine" }]), { now: () => new Date("2026-10-05T00:00:00Z"), fetch: router(log) });
  const out = await new MonitorRunner({ storage: fakeStorage() }, readyEnv(log, { MONITOR_DB: fakeDB({ last: "2026-10-01T00:00:00Z" }) })).run("cron");
  assert.equal(out.ok, true);
  assert.ok(log.some((x) => x[0] === "email" && /missed its schedule/.test(x[1].params.subject)));
  assert.match(staleAlert(cfgWith([]), "https://example.org", "x", 3000, "r", 1560).subject, /50 h ago/);
});

test("re-review M3: a transient failure that a later delivery cleared does not count; failures since the last delivery do", () => {
  const rows = [
    { route: "telegram", kind: "canary", ok: 1, error: null, at: "2026-10-03T02:46:00.000Z" },
    { route: "telegram", kind: "canary", ok: 0, error: "Telegram 502", at: "2026-10-02T02:46:00.000Z" },
    { route: "email", kind: "canary", ok: 0, error: "timeout", at: "2026-10-03T02:46:00.000Z" },
    { route: "email", kind: "canary", ok: 0, error: "Bad 403", at: "2026-10-02T02:46:00.000Z" },
    { route: "email", kind: "canary", ok: 1, error: null, at: "2026-10-01T02:46:00.000Z" },
    { route: "email", kind: "canary", ok: 0, error: "old 500", at: "2026-09-30T02:46:00.000Z" },
  ];
  const by = Object.fromEntries(routeFreshness(rows).map((r) => [r.route, r]));
  assert.deepEqual([by.telegram.failed, by.telegram.last_reason], [0, null], "cleared by the delivery after it");
  assert.deepEqual([by.email.failed, by.email.last_reason], [2, "timeout"], "two since the last delivery; the older one is not counted");
});

test("L12: reason codes: one public code per failure, never the text", () => {
  assert.deepEqual(["MONITOR_NOTIFY_TO is not set", "Telegram 403: bot was blocked", "Bale answered 502", "The operation was aborted due to timeout", "fetch failed: ENOTFOUND", "chat -100123 not found", "weird", null]
    .map(reasonCode), ["not-configured", "rejected", "provider-error", "timeout", "unreachable", "rejected", "failed", null]);
  for (const c of REASON_CODES) assert.ok(STATUS_SCHEMA.$defs.reason.enum.includes(c), `${c} is in the contract`);
  assert.deepEqual([...STATUS_SCHEMA.$defs.reason.enum].sort(), [...REASON_CODES].sort());
});

test("REVIEW R3: the canary goes through EVERY route each run, even when nothing failed", async () => {
  const log = [];
  const env = readyEnv(log);
  const { MonitorRunner } = createMonitor(cfgWith([{ name: "ok", run: async () => "fine" }]), { fetch: router(log) });
  const out = await new MonitorRunner({ storage: fakeStorage() }, env).run("cron");
  assert.equal(out.ok, true);
  assert.deepEqual(env.MONITOR_DB.deliveries.map((d) => [d[1], d[2], d[3]]), [["email", "canary", 1], ["telegram", "canary", 1]]);
  assert.equal(env.MONITOR_DB.rows[0][1][5], "none");
});

test("L11: the canary is daily: a second run the same UTC day sends no second canary on a route that delivered one; a failed canary is retried", async () => {
  const log = [];
  const env = readyEnv(log);
  const { MonitorRunner } = createMonitor(cfgWith([{ name: "ok", run: async () => "fine" }]), { fetch: router(log) });
  await new MonitorRunner({ storage: fakeStorage() }, env).run("cron");
  await new MonitorRunner({ storage: fakeStorage() }, env).run("cron");
  assert.deepEqual(env.MONITOR_DB.deliveries.map((d) => [d[1], d[2], d[3]]), [["email", "canary", 1], ["telegram", "canary", 1]], "one canary per route per day");
  env.MONITOR_DB.deliveries[1][3] = 0; // today's telegram canary failed
  await new MonitorRunner({ storage: fakeStorage() }, env).run("cron");
  assert.deepEqual(env.MONITOR_DB.deliveries.slice(2).map((d) => [d[1], d[2], d[3]]), [["telegram", "canary", 1]], "a failed canary is sent again");
  assert.match(canaryFor({}, "https://e.org", "2026-10-01T03:00:00Z").idempotencyKey, /monitor-canary:2026-10-01$/);
});

test("drill mode: a healthy run after today's canary still delivers a marked drill message through every route, and reports each route", async () => {
  const log = [];
  const env = readyEnv(log);
  const { MonitorRunner } = createMonitor(cfgWith([{ name: "ok", run: async () => "fine" }]), { fetch: router(log) });
  await new MonitorRunner({ storage: fakeStorage() }, env).run("cron");   // today's canary has gone on both routes
  log.length = 0;
  const out = await new MonitorRunner({ storage: fakeStorage() }, env).run("drill");
  assert.equal(out.ok, true);
  assert.deepEqual(out.routes, { email: { ok: true, error: null }, telegram: { ok: true, error: null } }, "the drill's answer reports every route");
  assert.deepEqual(out.drill, { email: { ok: true, error: null }, telegram: { ok: true, error: null } }, "and the drill message's own result per route");
  assert.deepEqual(env.MONITOR_DB.deliveries.slice(2).map((d) => [d[1], d[2], d[3]]), [["email", "drill", 1], ["telegram", "drill", 1]], "recorded as kind drill, no second canary");
  assert.ok(log.some((x) => x[0] === "email" && /ALERT DRILL — not an incident/.test(JSON.stringify(x[1]))), "the email is marked");
  assert.ok(log.some((x) => x[0] === "telegram" && /ALERT DRILL — not an incident/.test(x[1])), "the Telegram message is marked");
  assert.equal(env.MONITOR_DB.rows.at(-1)[1][2], "drill", "the run row says drill");
  assert.match(drillFor({}, "https://e.org", "2026-10-01T03:00:00Z").subject, /^e\.org: ALERT DRILL — not an incident$/);
});

test("drill mode, must-fail: a route that refuses the drill message fails the run and the route's entry says so", async () => {
  const log = [];
  const env = readyEnv(log);
  const { MonitorRunner } = createMonitor(cfgWith([{ name: "ok", run: async () => "fine" }]), { fetch: router(log) });
  await new MonitorRunner({ storage: fakeStorage() }, env).run("cron");
  const refusing = { ...env, COMMS: fakeComms(log, { status: 502 }) };
  const out = await new MonitorRunner({ storage: fakeStorage() }, refusing).run("drill");
  assert.equal(out.ok, false);
  assert.equal(out.routes.email.ok, false, "email did not deliver the drill");
  assert.equal(out.routes.telegram.ok, true);
  assert.deepEqual(refusing.MONITOR_DB.deliveries.filter((d) => d[2] === "drill").map((d) => [d[1], d[3]]), [["email", 0], ["telegram", 1]]);
});

test("drill mode, must-fail (Codex on #141, P2): a failed canary on a route does not hide that the drill message delivered; the run still fails", async () => {
  const log = [];
  let canaryCalls = 0;
  // the email route refuses the daily canary (the first message of the run on it) and accepts the drill message that follows
  const flaky = { fetch: async (url, init) => { const body = JSON.parse(init.body); log.push(["email", body]); const canary = /monitor canary/.test(body.params.subject); if (canary && ++canaryCalls === 1) return new Response("down", { status: 502 }); return new Response(JSON.stringify({ id: "d1" }), { status: 200 }); } };
  const env = readyEnv(log, { COMMS: flaky });
  const { MonitorRunner } = createMonitor(cfgWith([{ name: "ok", run: async () => "fine" }]), { fetch: router(log) });
  const out = await new MonitorRunner({ storage: fakeStorage() }, env).run("drill");
  assert.equal(out.ok, false, "a canary that did not deliver fails the run");
  assert.equal(out.routes.email.ok, false, "the route's verdict for the run: not every message delivered");
  assert.deepEqual(out.drill, { email: { ok: true, error: null }, telegram: { ok: true, error: null } }, "the drill message's own result per route");
  assert.deepEqual(env.MONITOR_DB.deliveries.filter((d) => d[1] === "email").map((d) => [d[2], d[3]]), [["canary", 0], ["drill", 1]]);
  assert.deepEqual(env.MONITOR_DB.deliveries.filter((d) => d[1] === "telegram").map((d) => [d[2], d[3]]), [["canary", 1], ["drill", 1], ["route-failure", 1]], "the route failure is told through the route that works");
  // and the other way round: the drill message refused on a route reads as a failed drill on that route
  const out2 = await new MonitorRunner({ storage: fakeStorage() }, readyEnv([], { COMMS: fakeComms([], { status: 502 }) })).run("drill");
  assert.equal(out2.drill.email.ok, false); assert.equal(out2.drill.telegram.ok, true); assert.equal(out2.ok, false);
  // a normal run carries no drill field
  assert.equal("drill" in (await new MonitorRunner({ storage: fakeStorage() }, readyEnv([])).run("cron")), false);
});

test("a normal run never sends the drill message (cron, manual), healthy or not; the daily canary rule is unchanged", async () => {
  for (const trigger of ["cron", "manual"]) {
    const log = [];
    const env = readyEnv(log);
    const { MonitorRunner } = createMonitor(cfgWith([{ name: "x", run: async () => { throw new Error("down"); } }]), { fetch: router(log) });
    await new MonitorRunner({ storage: fakeStorage() }, env).run(trigger);
    await new MonitorRunner({ storage: fakeStorage() }, env).run(trigger);
    assert.ok(!env.MONITOR_DB.deliveries.some((d) => d[2] === "drill"), `${trigger}: no drill delivery`);
    assert.ok(!log.some((x) => /ALERT DRILL/.test(JSON.stringify(x))), `${trigger}: no drill text anywhere`);
    assert.equal(env.MONITOR_DB.deliveries.filter((d) => d[2] === "canary").length, 2, `${trigger}: one canary per route per day`);
  }
});

test("worker: POST /run?mode=drill runs the drill (same bearer token); an unknown mode is refused, never guessed", async () => {
  const { worker } = createMonitor({ ...CONFIG, ...ALERT_CFG }, { fetch: router([]) });
  const asked = [];
  const env = { ...readyEnv(), MONITOR_TOKEN: "secret", RUNNER: { idFromName: (n) => n, get: () => ({ fetch: async (u) => { asked.push(new URL(u).searchParams.get("trigger")); return Response.json({ ok: true }); } }) } };
  const post = (q, auth = "Bearer secret") => worker.fetch(new Request(`https://m/run${q}`, { method: "POST", headers: { authorization: auth } }), env);
  assert.equal((await post("?mode=drill", "Bearer nope")).status, 401, "the drill needs the token too");
  assert.equal((await post("?mode=drill")).status, 200);
  assert.equal((await post("")).status, 200);
  assert.equal((await post("?mode=panic")).status, 400);
  assert.deepEqual(asked, ["drill", "manual"]);
});

test("REVIEW R3: a route that refuses is alerted through the others, fails the run, and the dead-man hears fail", async () => {
  const log = [];
  const env = readyEnv(log);
  const { MonitorRunner } = createMonitor(cfgWith([{ name: "ok", run: async () => "fine" }]), { fetch: router(log, { telegram: "refuse" }) });
  const out = await new MonitorRunner({ storage: fakeStorage() }, env).run("cron");
  assert.equal(out.ok, false, "a route failure is a failed run");
  assert.match(out.monitor_failures.join(), /route telegram: .*chat not found/);
  assert.ok(log.some((x) => x[0] === "email" && /alert route telegram did not deliver/.test(x[1].params.subject)), "told through the email route");
  assert.equal(env.MONITOR_DB.rows[0][1][5], "failed"); assert.match(env.MONITOR_DB.rows[0][1][6], /chat not found/);
  assert.match(log.filter((x) => x[0] === "ping")[0][1], /\/fail$/);
  assert.equal(env.MONITOR_DB.updates.at(-1)[1], 0, "the row says failed");
  // and the scheduled worker fails its cron invocation when the monitor itself broke
  const { worker } = createMonitor(cfgWith([{ name: "ok", run: async () => "fine" }]));
  const ns = { idFromName: (n) => n, get: () => ({ fetch: async () => Response.json(out) }) };
  const waits = [];
  await worker.scheduled({}, { ...readyEnv(), RUNNER: ns }, { waitUntil: (p) => waits.push(p) });
  await assert.rejects(Promise.all(waits), /monitor run failed: route telegram/);
});

test("REVIEW R5: a failed dead-man ping is stored in the row, fails the run and is alerted through the routes", async () => {
  const log = [];
  const env = readyEnv(log);
  const { MonitorRunner } = createMonitor(cfgWith([{ name: "ok", run: async () => "fine" }]), { fetch: router(log, { hc: 500 }) });
  const out = await new MonitorRunner({ storage: fakeStorage() }, env).run("cron");
  assert.equal(out.ok, false);
  assert.match(env.MONITOR_DB.updates.at(-1)[0], /^failed: dead-man ping answered 500/);
  assert.equal(env.MONITOR_DB.updates.at(-1)[1], 0);
  assert.ok(log.some((x) => x[0] === "email" && /dead-man ping failed/.test(x[1].params.subject)));
});

test("dead-man ping: ok, fail, start; github-actions sends nothing; a ping that did not go out is reported", async () => {
  const seen = [];
  const f = async (u) => { seen.push(String(u)); return new Response("", { status: 200 }); };
  const env = { MONITOR_DEADMAN_PROVIDER: "healthchecks.io", MONITOR_DEADMAN_URL: HC, MONITOR_FETCH_TIMEOUT_MS: "10000" };
  assert.deepEqual(await pingDeadMan(env, {}, "ok", { fetch: f }), { sent: true, provider: "healthchecks.io", status: 200 });
  await pingDeadMan(env, {}, "fail", { fetch: f }); await pingDeadMan(env, {}, "start", { fetch: f });
  assert.deepEqual(seen, [HC, `${HC}/fail`, `${HC}/start`]);
  assert.match((await pingDeadMan(env, {}, "ok", { fetch: async () => new Response("", { status: 500 }) })).error, /500/);
  assert.match((await pingDeadMan(env, {}, "ok", { fetch: async () => { throw new Error("offline"); } })).error, /offline/);
  assert.equal((await pingDeadMan({ MONITOR_DEADMAN_PROVIDER: "github-actions" }, {}, "ok", { fetch: f })).skipped, "the scheduled watcher is the dead-man");
});

test("a monitor database that cannot be written is surfaced (record failure), not swallowed", async () => {
  const log = [];
  const { MonitorRunner } = createMonitor(cfgWith([{ name: "ok", run: async () => "fine" }]), { fetch: router(log) });
  const out = await new MonitorRunner({ storage: fakeStorage() }, readyEnv(log, { MONITOR_DB: fakeDB({ failWrite: true }) })).run("cron");
  assert.ok(out.monitor_failures.some((m) => /record failed: D1 down/.test(m)));
  assert.match(log.find((x) => x[0] === "ping")[1], /\/fail$/);
});

test("MUST FAIL: when the only update after the ping fails, the run is not ok and the persisted row is left NOT passing (/api/health and the watcher would say passing)", async () => {
  const log = [], db = fakeDB({ failUpdate: true });
  const { MonitorRunner } = createMonitor(cfgWith([{ name: "ok", run: async () => "fine" }]), { fetch: router(log) });
  const out = await new MonitorRunner({ storage: fakeStorage() }, readyEnv(log, { MONITOR_DB: db })).run("cron");
  assert.equal(out.ok, false);
  assert.ok(out.monitor_failures.some((m) => /record of the dead-man result failed: D1 update down/.test(m)));
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0][1][3], 0, "inserted not passing");
  assert.equal(db.rows[0][1][7], "pending", "and pending");
  assert.equal(db.updates.length, 0, "no update succeeded, so the row never became passing");
});

test("MUST FAIL (review of 7fa30afa): the row is inserted not passing and pending; only the update after the ping sets ok = 1, and only for a ping that was sent", async () => {
  const log = [], db = fakeDB({ onUpdate: (a) => log.push(["update", a[1]]) });
  const { MonitorRunner } = createMonitor(cfgWith([{ name: "ok", run: async () => "fine" }]), { fetch: router(log) });
  const out = await new MonitorRunner({ storage: fakeStorage() }, readyEnv(log, { MONITOR_DB: db })).run("cron");
  assert.equal(out.ok, true);
  const order = log.map((x) => x[0]);
  assert.ok(order.indexOf("update") > order.indexOf("ping"), `the only update follows the ping: ${order.join(",")}`);
  assert.equal(order.filter((x) => x === "update").length, 1);
  assert.deepEqual(log.find((x) => x[0] === "update"), ["update", 1]);
  assert.equal(db.rows[0][1][3], 0);
  assert.equal(db.rows[0][1][7], "pending");
});

test("monitor.drill is schema-checked: a scheduled drill needs its weekday and its time slot together", async () => {
  const { createValidator, formatProblems } = await import("@saasreport/core/schema");
  const { readFileSync } = await import("node:fs");
  const schema = JSON.parse(readFileSync(new URL("../../core/schemas/kit-config.schema.json", import.meta.url), "utf8"));
  const V = createValidator([schema]);
  const bad = (drill) => formatProblems(V.validate({ site: { name: "x", url: "https://x.example" }, monitor: { drill } }, schema.$id));
  assert.deepEqual(bad({ form: "contact", weekday: "mon", at: "08:00" }), []);
  assert.deepEqual(bad({ form: "contact" }), [], "manual drills only");
  assert.notDeepEqual(bad({ form: "contact", weekday: "mon" }), [], "a weekday without a time slot would drill on every cron run");
  assert.notDeepEqual(bad({ form: "contact", at: "08:00" }), []);
  assert.notDeepEqual(bad({ form: "contact", weekday: "mon", at: "8am" }), []);
  assert.notDeepEqual(bad({ form: "contact", weekday: "someday", at: "08:00" }), []);
  assert.notDeepEqual(bad({ weekday: "mon", at: "08:00" }), [], "a drill names its form");
});
