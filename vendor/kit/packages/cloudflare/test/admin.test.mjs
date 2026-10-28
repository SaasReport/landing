import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeKit, seed } from "./helpers.mjs";

const LEDGER_SQL = readFileSync(new URL("../../comms/migrations/0003_comms_form_deliveries.sql", import.meta.url), "utf8");

const auth = { authorization: "Bearer secret-token", "content-type": "application/json" };

test("podcast admin API: Bearer token required (constant-time compare)", async () => {
  const { get } = makeKit("en");
  assert.equal((await get("/api/podcasts/admin")).status, 401);
  assert.equal((await get("/api/podcasts/admin", { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await get("/api/podcasts/generate", { method: "POST", body: "{}" })).status, 401);
  const dual = makeKit("en", { env: { ADMIN_TOKEN: "internal-daemon-only", PODCAST_ADMIN_TOKEN: "operator-bearer" } });
  assert.equal((await dual.get("/api/podcasts/admin", { headers: { authorization: "Bearer operator-bearer" } })).status, 200);
  assert.equal((await dual.get("/api/podcasts/admin", { headers: { authorization: "Bearer internal-daemon-only" } })).status, 200);
  assert.equal((await dual.get("/api/podcasts/admin", { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await dual.get("/api/podcasts/admin", { headers: { authorization: "Bearer " } })).status, 401);
  const noToken = makeKit("en", { env: { ADMIN_TOKEN: undefined } });
  assert.equal((await noToken.get("/api/podcasts/admin", { headers: { authorization: "Bearer " } })).status, 401);
});

test("podcast admin API: generate by series + ref (date or term slug), status, list, force", async () => {
  const { get, env } = makeKit("en");
  let r = await get("/api/podcasts/generate", { method: "POST", headers: auth, body: JSON.stringify({ series: "weekly", ref: "2026-10-05" }) });
  let j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.deepEqual([j.slug, j.status, j.created], ["weekly-2026-10-05", "queued", true]);
  assert.equal(env.PODCAST_WF.created[0].params.slug, "weekly-2026-10-05");
  r = await get("/api/podcasts/generate", { method: "POST", headers: auth, body: JSON.stringify({ series: "daily", ref: "ledger" }) });
  j = await r.json();
  assert.equal(j.slug, "daily-ledger");
  const row = await env.DB.prepare("SELECT number, source_ref, show FROM podcast_episodes WHERE slug = 'daily-ledger'").first();
  assert.deepEqual(row, { number: 2, source_ref: "ledger", show: "daily" }, "term number from the rotation");
  // again without force → not re-queued; with force → re-queued
  j = await (await get("/api/podcasts/generate", { method: "POST", headers: auth, body: JSON.stringify({ series: "daily", ref: "ledger" }) })).json();
  assert.equal(j.created, false);
  j = await (await get("/api/podcasts/generate", { method: "POST", headers: auth, body: JSON.stringify({ series: "daily", ref: "ledger", force: true }) })).json();
  assert.equal(j.created, true);
  assert.equal(env.PODCAST_WF.created.length, 3);
  r = await get("/api/podcasts/generate", { method: "POST", headers: auth, body: JSON.stringify({ series: "monthly", ref: "2026-11" }) });
  assert.equal(r.status, 422); assert.equal((await r.json()).error, "unknown_series");
  r = await get("/api/podcasts/generate", { method: "POST", headers: auth, body: JSON.stringify({ series: "weekly", ref: "1999-01-01" }) });
  assert.equal(r.status, 422);
  j = await (await get("/api/podcasts/admin/daily-ledger", { headers: auth })).json();
  assert.equal(j.episode.status, "queued"); assert.equal(j.workflow.status, "running");
  assert.equal((await get("/api/podcasts/admin/nope", { headers: auth })).status, 404);
  j = await (await get("/api/podcasts/admin", { headers: auth })).json();
  assert.equal(j.tts_configured, true); assert.equal(j.episodes.length, 2);
  assert.equal((await get("/api/podcasts/generate", { headers: auth })).status, 405);
});

test("podcast admin API: 409 without TTS configured", async () => {
  const { get } = makeKit("en", { env: { GEMINI_API_KEY: undefined } });
  const r = await get("/api/podcasts/generate", { method: "POST", headers: auth, body: JSON.stringify({ series: "weekly", ref: "2026-10-05" }) });
  assert.equal(r.status, 409);
});

test("PodcastWorkflow comes from createPodcastWorkflow({config, content, storage, calendarBit})", async () => {
  let got;
  // a Persian site's gate before TTS comes from the project's own persian.config.json: built without it, createKit refuses
  assert.throws(() => makeKit("fa", { options: { storage: { bucket: "AUDIO" } }, deps: { createPodcastWorkflow: () => class PodcastWorkflow {} } }), /needs the `persian` option/);
  const persian = { config: { classes: { brand: ["نمونه"] } }, packs: [] };
  const { kit } = makeKit("fa", { options: { storage: { bucket: "AUDIO" }, persian }, deps: { createPodcastWorkflow: (o) => { got = o; return class PodcastWorkflow {}; } } });
  assert.equal(typeof kit.PodcastWorkflow, "function");
  assert.equal(got.persian, persian);
  assert.equal(got.config.site.url, "https://fa.example.org");
  assert.deepEqual(got.storage, { bucket: "AUDIO" });
  assert.equal(typeof got.calendarBit, "function");
  const bit = got.calendarBit({ item: { date: "2026-10-03" } });
  assert.equal(bit.lines.length, 2); assert.match(bit.summary, /روز کاری/);
  // content resolver: rebuilds the lines of an episode row from the content pack
  const lines = await got.content({ series: "daily", source_ref: "iban", number: 1 });
  assert.ok(Array.isArray(lines) && lines.length >= 4);
  assert.equal(await got.content({ series: "nope", source_ref: "x" }), null);
});

test("event RSVP (opt-in): validation, honeypot, stored lead, delivered as a declared form through the comms engine's submit (receipt and owner), rate limit", async () => {
  const sent = [];
  const urls = [];
  const delivered = { ok: true, delivery: { receipt: { status: "sent" }, owner: { status: "sent" } } };
  const { get, env } = makeKit("en", { now: "2026-10-01T08:00:00Z", options: { events: { rsvp: true } },
    env: { COMMS: { fetch: async (url, init) => { urls.push(String(url)); sent.push(JSON.parse(init.body)); return new Response(JSON.stringify(delivered)); } } } });
  env.DB.sqlite.exec(LEDGER_SQL);
  await seed(env, { lang: "en" });
  const html = await (await get("/events/webinar")).text();
  assert.match(html, /data-form="event-rsvp"/);
  const rsvp = (body, headers = {}) => get("/api/forms/event-rsvp", { method: "POST", headers: { "content-type": "application/json", origin: "https://en.example.org", "cf-connecting-ip": "192.0.2.1", ...headers }, body: JSON.stringify(body) });
  const ok = { event: "webinar", name: "Ann", email: "Ann@Example.org", consent: true };
  assert.equal((await rsvp({ ...ok, consent: false })).status, 422);
  assert.equal((await rsvp({ ...ok, email: "nope" })).status, 422);
  assert.equal((await rsvp({ ...ok, event: "meetup" })).status, 422, "past event");
  assert.equal((await rsvp(ok, { origin: "https://evil.example" })).status, 403);
  let j = await (await rsvp({ ...ok, website: "spam" })).json();
  assert.equal(j.ok, true); assert.equal(sent.length, 0, "honeypot pretends success");
  j = await (await rsvp(ok)).json();
  assert.equal(j.ok, true); assert.equal(j.email_status, "sent");
  assert.equal(sent.at(-1).test, false, "a plain submission is never a test");
  // `test` only with the drill header signed by FORMS_DRILL_KEY: refused otherwise, never quietly accepted or dropped
  assert.equal((await rsvp({ ...ok, test: true })).status, 403);
  assert.equal((await rsvp({ ...ok, test: "yes" })).status, 422);
  env.FORMS_DRILL_KEY = "drill-key-for-the-test";
  const { signDrill, DRILL_HEADER } = await import("@saasreport/core/form-deliveries");
  const at = Date.parse("2026-10-01T08:00:00Z");
  const header = await signDrill(env.FORMS_DRILL_KEY, "event-rsvp", at);
  const leadsBefore = (await env.DB.prepare("SELECT COUNT(*) AS n FROM leads").first()).n;
  // authenticated before anything is written: a refused drill leaves no lead behind
  assert.equal((await rsvp({ ...ok, test: true }, { [DRILL_HEADER]: await signDrill("wrong", "event-rsvp", at) })).status, 403);
  assert.equal((await rsvp({ ...ok, test: true }, { [DRILL_HEADER]: await signDrill(env.FORMS_DRILL_KEY, "contact", at) })).status, 403, "a header signed for another form");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM leads").first()).n, leadsBefore, "a refused test wrote no lead");
  assert.equal((await rsvp({ ...ok, test: true }, { [DRILL_HEADER]: header })).status, 200);
  assert.equal(sent.at(-1).test, true);
  assert.equal((await rsvp({ ...ok, test: true }, { [DRILL_HEADER]: header })).status, 403, "the same header twice is a replay");
  delete env.FORMS_DRILL_KEY;
  assert.equal(urls[0], "https://comms/v1/comms/submit", "never /v1/comms/dispatch: the engine sends the receipt and the owner's notification together");
  assert.equal(sent[0].form_id, "event-rsvp"); assert.deepEqual(sent[0].submitter, { email: "ann@example.org" });
  assert.equal(sent[0].template_id, undefined); assert.equal(sent[0].to, undefined);
  assert.match(sent[0].params.fields_text, /Ann/);
  assert.equal(sent[0].params.event_add, "https://en.example.org/events/webinar/add");
  const lead = await env.DB.prepare("SELECT form, ref, email FROM leads").first();
  assert.deepEqual(lead, { form: "event-rsvp", ref: "webinar", email: "ann@example.org" });
  for (let i = 0; i < 6; i++) await rsvp(ok);   // 8 leads from this address in ten minutes (the refused tests above wrote none), then the limit
  assert.equal((await rsvp(ok)).status, 429);
});

test("event RSVP: a submission the engine did not record is written as failed by the site, and an unrecordable one is never answered ok (review of 7cd5873)", async () => {
  const LEDGER = LEDGER_SQL;
  const { get, env } = makeKit("en", { now: "2026-10-01T08:00:00Z", options: { events: { rsvp: true } },
    env: { COMMS: { fetch: async () => Response.json({ ok: false, error: "undeclared_form" }, { status: 404 }) } } });
  env.DB.sqlite.exec(LEDGER);
  await seed(env, { lang: "en" });
  const post = (g) => g("/api/forms/event-rsvp", { method: "POST", headers: { "content-type": "application/json", origin: "https://en.example.org", "cf-connecting-ip": "192.0.2.9" }, body: JSON.stringify({ event: "webinar", name: "Ann", email: "ann@example.org", consent: true }) });
  const log = console.error; console.error = () => {};
  try {
    const r = await post(get);
    const j = await r.json();
    assert.equal(r.status, 200); assert.equal(j.email_status, "failed");
    const row = env.DB.sqlite.prepare("SELECT owner_status, owner_error, form_id FROM comms_form_deliveries WHERE reference = ?").get(j.reference);
    assert.deepEqual({ ...row }, { owner_status: "failed", owner_error: "undeclared_form", form_id: "event-rsvp" }, "the site recorded what the engine refused");
    const s = await (await get("/api/forms/deliveries")).json();
    assert.equal(s.ok, false, "the monitor goes red");
    // no ledger table at all: nothing can be recorded, so the visitor is told (503), never ok
    const bare = makeKit("en", { now: "2026-10-01T08:00:00Z", options: { events: { rsvp: true } }, env: { COMMS: { fetch: async () => new Response("x", { status: 500 }) } } });
    await seed(bare.env, { lang: "en" });
    const r2 = await post(bare.get);
    assert.equal(r2.status, 503); assert.equal((await r2.json()).error, "not_recorded");
  } finally { console.error = log; }
});

test("must fail: a drill that ended in 503 not_recorded counts as the day's drill (no row, yet last_test_at is set), with its outcome", async () => {
  const { get, env } = makeKit("en", { now: "2026-10-01T08:00:00Z", options: { events: { rsvp: true } }, env: { FORMS_DRILL_KEY: "k", COMMS: { fetch: async () => new Response("x", { status: 500 }) } } });
  env.DB.sqlite.exec(LEDGER_SQL);
  await seed(env, { lang: "en" });
  const real = env.DB.prepare;   // the ledger refuses every write of a submission row
  env.DB.prepare = (sql) => { if (/^INSERT INTO comms_form_deliveries/.test(sql)) throw new Error("D1 down"); return real(sql); };
  const { signDrill, DRILL_HEADER } = await import("@saasreport/core/form-deliveries");
  const log = console.error; console.error = () => {};
  try {
    assert.equal((await (await get("/api/forms/deliveries")).json()).last_test_at, null);
    const r = await get("/api/forms/event-rsvp", { method: "POST", headers: { "content-type": "application/json", origin: "https://en.example.org", "cf-connecting-ip": "192.0.2.5", [DRILL_HEADER]: await signDrill("k", "event-rsvp", Date.parse("2026-10-01T08:00:00Z")) },
      body: JSON.stringify({ event: "webinar", name: "Drill", email: "monitor-drill@en.example.org", consent: true, test: true }) });
    assert.deepEqual([r.status, (await r.json()).error], [503, "not_recorded"]);
    assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM comms_form_deliveries").get().n, 0, "no ledger row");
    assert.equal(env.DB.sqlite.prepare("SELECT outcome FROM comms_form_drills").get().outcome, "not_recorded");
    assert.equal((await (await get("/api/forms/deliveries")).json()).last_test_at, "2026-10-01T08:00:00.000Z", "the attempt is the day's drill");
  } finally { console.error = log; }
});

test("event RSVP endpoint is absent unless enabled", async () => {
  const { get } = makeKit("en");
  assert.equal((await get("/api/forms/event-rsvp", { method: "POST", body: "{}" })).status, 404);
});

test("calendarBit hook: series.podcast.calendarBit (config) or options.calendarBit replaces the generic segment", async () => {
  const seen = [];
  const hook = (ctx) => { seen.push(ctx); return { lines: [["host", "Q?"], ["expert", `A ${ctx.day} ${typeof ctx.calendar.isBusinessDay} ${ctx.fallback().lines.length}`]], summary: "custom summary." }; };
  const { kit } = makeKit("en", { config: (c) => ({ ...c, series: c.series.map((s) => (s.id === "weekly" ? { ...s, podcast: { ...s.podcast, calendarBit: hook } } : s)) }) });
  const item = { date: "2026-10-05", title: "T", summary: "S", talk: [["host", "a"], ["expert", "b"]] };
  const ep = kit.context.episodeFor(kit.config.series.find((s) => s.id === "weekly"), item, { ref: "2026-10-05" });
  assert.deepEqual(ep.lines.slice(-4, -2).map((l) => l.text), ["Q?", `A ${Math.floor(Date.parse("2026-10-05") / 864e5)} function 2`]);
  assert.match(ep.summary, /custom summary\.$/);
  assert.equal(seen.length, 1);
  // createKit option: the same hook for every weekly series
  const k2 = makeKit("en", { options: { calendarBit: () => ({ lines: [["expert", "from options"]] }) } }).kit;
  const ep2 = k2.context.episodeFor(k2.config.series.find((s) => s.id === "weekly"), item, { ref: "2026-10-05" });
  assert.ok(ep2.lines.some((l) => l.text.includes("from options")));
  // a hook returning null: no segment
  const k3 = makeKit("en", { options: { calendarBit: () => null } }).kit;
  const ep3 = k3.context.episodeFor(k3.config.series.find((s) => s.id === "weekly"), item, { ref: "2026-10-05" });
  assert.ok(!ep3.lines.some((l) => l.text.includes("from options")));
  assert.ok(ep3.lines.map((l) => l.text).join("").length < ep2.lines.map((l) => l.text).join("").length);
});

test("episodeFor passes the glossary categories: term summaries end with (category)", async () => {
  const { kit } = makeKit("fa");
  await kit.context.c.ready();
  const s = kit.config.series.find((x) => x.id === "daily");
  const term = (await kit.context.c.items("daily"))[0];
  const ep = kit.context.episodeFor(s, term, { number: 1, ref: term.slug });
  const cat = (await kit.context.c.series("daily")).categories.find((c) => c.key === term.category);
  assert.equal(ep.summary, `${term.short} (${cat.name})`);
});
