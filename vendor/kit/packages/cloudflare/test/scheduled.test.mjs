import { test } from "node:test";
import assert from "node:assert/strict";
import { makeKit, sample } from "./helpers.mjs";

const DAY = 864e5;
const dayOf = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY);
const SAT = "2026-10-03", FIRST = "2026-10-23", NORMAL = "2026-10-06"; // Saturday · 1 Aban 1405 (Friday) · a Tuesday
const { content } = sample("fa");
const term = (i) => content.daily.terms[i];

/** A fake planner: fixed entries per day; records every call. */
function fakePlanner(calls) {
  const entries = {
    [SAT]: [
      { series: "weekly", kind: "topic", day: dayOf(SAT), date: SAT, key: SAT, slug: `weekly-${SAT}`, item: content.weekly[0], publishAt: "2026-10-03T02:30:00.000Z", missing: false },
      { series: "daily", kind: "term", day: dayOf(SAT), date: SAT, key: "iban", slug: "daily-iban", item: term(0), number: 4, publishAt: "2026-10-03T02:30:00.000Z", missing: false },
    ],
    [FIRST]: [
      { series: "monthly", kind: "report", day: dayOf(FIRST), date: FIRST, key: "1405-08", slug: "monthly-1405-08", item: content.monthly[0], publishAt: "2026-10-23T02:30:00.000Z", missing: false },
      { series: "daily", kind: "term", day: dayOf(FIRST), date: FIRST, key: "ledger", slug: "daily-ledger", item: term(1), number: 24, publishAt: "2026-10-23T02:30:00.000Z", missing: false },
    ],
    [NORMAL]: [
      { series: "daily", kind: "term", day: dayOf(NORMAL), date: NORMAL, key: "card", slug: "daily-card", item: term(2), number: 7, publishAt: "2026-10-06T02:30:00.000Z", missing: false },
    ],
  };
  return () => ({
    config: {}, content: {},
    due: (day) => { calls.due.push(day); return entries[new Date(day * DAY).toISOString().slice(0, 10)] || []; },
    find: () => null,
  });
}

function setup(envExtra = {}) {
  const calls = { due: [], buildPost: [], announce: [] };
  const k = makeKit("fa", {
    env: envExtra,
    deps: {
      planner: fakePlanner(calls),
      buildPost: (plan, e) => { calls.buildPost.push(e.slug); return { slug: e.slug, series: e.series, kind: e.kind, title: `T ${e.slug}`, summary: "s", body_md: "b", tags: ["x"], published_at: e.publishAt, source: "auto" }; },
      announcePending: async (env, config, opts) => { calls.announce.push({ config, when: typeof opts.when }); return { configured: true, sent: 1 }; },
    },
  });
  return { ...k, calls };
}
const run = (k, iso) => k.kit.scheduled({ scheduledTime: Date.parse(`${iso}T02:30:00Z`), cron: "30 2 * * *" }, k.env, { waitUntil() {} });
const rows = async (env, sql) => (await env.DB.prepare(sql).all()).results;

test("Saturday: weekly topic post + weekly and daily episodes queued + channels announced", async () => {
  const k = setup();
  const r = await run(k, SAT);
  assert.deepEqual(k.calls.due, [dayOf(SAT)]);
  assert.deepEqual(k.calls.buildPost, [`weekly-${SAT}`], "term series publish no post");
  assert.deepEqual(r.posts, [`weekly-${SAT}`]);
  const posts = await rows(k.env, "SELECT slug, series, kind, published_at, channel_state FROM posts");
  assert.deepEqual(posts, [{ slug: `weekly-${SAT}`, series: "weekly", kind: "topic", published_at: "2026-10-03T02:30:00.000Z", channel_state: "pending" }]);
  assert.deepEqual(r.episodes.sort(), ["daily-iban", `weekly-${SAT}`].sort());
  assert.deepEqual(k.env.PODCAST_WF.created.map((x) => x.params.slug).sort(), ["daily-iban", `weekly-${SAT}`].sort());
  const eps = await rows(k.env, "SELECT slug, series, show, kind, source_type, source_ref, status, number, published_at, script_json FROM podcast_episodes ORDER BY slug");
  const daily = eps.find((e) => e.slug === "daily-iban");
  assert.deepEqual({ ...daily, script_json: undefined }, { slug: "daily-iban", series: "daily", show: "daily", kind: "term", source_type: "term", source_ref: "iban", status: "queued", number: 4, published_at: "2026-10-03T02:30:00.000Z", script_json: undefined });
  const weekly = eps.find((e) => e.slug === `weekly-${SAT}`);
  const lines = JSON.parse(weekly.script_json);
  assert.ok(lines.length >= 4 && lines.every((l) => ["sara", "omid"].includes(l.speaker)), "speakers mapped to config.hosts");
  assert.ok(lines.some((l) => /روز کاری/.test(l.text)), "calendar bit appended to the weekly topic episode");
  assert.equal(k.calls.announce.length, 1);
  assert.equal(k.calls.announce[0].when, "function");
});

test("1st of the month: monthly report post + daily episode", async () => {
  const k = setup();
  const r = await run(k, FIRST);
  assert.deepEqual(k.calls.buildPost, ["monthly-1405-08"]);
  assert.deepEqual(r.posts, ["monthly-1405-08"]);
  assert.deepEqual(r.episodes, ["daily-ledger"]);
  assert.equal((await rows(k.env, "SELECT kind FROM posts"))[0].kind, "report");
  assert.equal(k.calls.announce.length, 1);
});

test("a normal day: only the term of the day (episode), no post", async () => {
  const k = setup();
  const r = await run(k, NORMAL);
  assert.deepEqual(k.calls.buildPost, []);
  assert.deepEqual(r.posts, []);
  assert.deepEqual(r.episodes, ["daily-card"]);
  assert.equal(k.calls.announce.length, 1);
});

test("idempotent: a second run upserts the same post and does not re-queue episodes", async () => {
  const k = setup();
  await run(k, SAT);
  await k.env.DB.prepare("UPDATE posts SET channel_state = 'sent'").run();
  const r = await run(k, SAT);
  assert.deepEqual(r.episodes, []);
  assert.equal(k.env.PODCAST_WF.created.length, 2);
  assert.deepEqual(await rows(k.env, "SELECT COUNT(*) AS n, MIN(channel_state) AS s FROM posts"), [{ n: 1, s: "sent" }], "channel state is kept");
});

test("without TTS secrets episodes are skipped (posts still publish)", async () => {
  const k = setup({ GEMINI_API_KEY: undefined });
  await assert.rejects(run(k, SAT), /scheduled publishing failed.*tts_not_configured/, "missing TTS is a failed Cron, never a successful no-op");
  assert.deepEqual((await rows(k.env, "SELECT slug FROM posts")).map((x) => x.slug), [`weekly-${SAT}`], "unaffected blog posts remain published");
  assert.equal(k.env.PODCAST_WF.created.length, 0);
});

test("with the real planner (fa, jalali): Saturday week post with calendar tables; 1 Aban monthly report", async () => {
  const k = makeKit("fa", { deps: { announcePending: async () => ({ configured: false }) } });
  let r = await run(k, SAT);
  assert.deepEqual(r.errors, []);
  assert.ok(r.posts.includes(`weekly-${SAT}`));
  const post = await k.env.DB.prepare("SELECT * FROM posts WHERE slug = ?").bind(`weekly-${SAT}`).first();
  assert.equal(post.title, content.weekly[0].title);
  assert.match(post.body_md, /\| (روز|Day) \|/, "week table from core");
  assert.ok(r.episodes.includes(`weekly-${SAT}`));
  r = await run(k, FIRST);
  assert.deepEqual(r.errors, []);
  assert.ok(r.posts.includes("monthly-1405-08"));
  const report = await k.env.DB.prepare("SELECT * FROM posts WHERE slug = 'monthly-1405-08'").first();
  assert.ok(report.title.includes(content.monthly[0].title), report.title);
  assert.equal(report.published_at, "2026-10-23T02:30:00.000Z");
  assert.equal((await k.kit.fetch(new Request("https://fa.example.org/blog/monthly-1405-08"), k.env, {})).status, 404, "not before its publish time");
});

test("must-fail: a failed episode insert is logged with its cause, never only counted (the 2026-10-07..13 outage logged \"errors\":2)", async (t) => {
  const k = setup();
  const prepare = k.env.DB.prepare.bind(k.env.DB);
  k.env.DB.prepare = (sql) => (/INSERT[^]*podcast_episodes/i.test(sql) ? { bind: () => ({ run: async () => { throw new Error("LIKE or GLOB pattern too complex: SQLITE_ERROR"); }, first: async () => { throw new Error("LIKE or GLOB pattern too complex: SQLITE_ERROR"); } }) } : prepare(sql));
  const logged = [];
  t.mock.method(console, "error", (...a) => logged.push(a.join(" ")));
  await assert.rejects(run(k, NORMAL), /scheduled publishing failed.*GLOB pattern too complex/, "D1 insert failures must reject the Cron");
  assert.ok(logged.some((l) => l.includes("[kit] scheduled publishing failed") && l.includes("GLOB pattern too complex")), logged.join("\\n"));
  assert.ok(logged.some((l) => l.includes("[kit] daily error") && l.includes("daily-card") && l.includes("GLOB pattern too complex")), logged.join("\n"));
});
