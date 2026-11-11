// Staleness class podcast-behind-schedule: the newest feed item older than cadence + grace is a finding. Cadence from kit.config.js, grace from
// podcast.config.json. The must-fail is the outage: daily feeds ten days old.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fileTempDir } from "../../core/test/support/temp.mjs";
import { podcastBehindSchedule, newestItem, PODCAST_BEHIND, CADENCE_DAYS } from "../src/podcast-staleness.js";

const KIT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BASE = fileTempDir("kit-stale-");
let SEQ = 0;
const NOW = new Date("2026-10-14T08:00:00Z");
const project = (podcast = { schedule: { graceMinutes: 180 } }) => {
  const root = join(BASE, `p${SEQ++}`);
  cpSync(join(KIT_ROOT, "examples/podcast-site"), root, { recursive: true });
  symlinkSync(join(KIT_ROOT, "node_modules"), join(root, "node_modules"));
  if (podcast) writeFileSync(join(root, "podcast.config.json"), JSON.stringify(podcast));
  return root;
};
const rss = (...dates) => `<rss><channel>${dates.map((d) => `<item><title>t</title><pubDate>${new Date(d).toUTCString()}</pubDate></item>`).join("")}</channel></rss>`;
const feeds = (daily, weekly = "2026-10-10T03:00:00Z") => ({ fetch: async (url) => (url.endsWith("/podcasts/daily/feed.xml") ? new Response(daily === null ? "nope" : rss(...[].concat(daily)), { status: daily === null ? 500 : 200 }) : new Response(rss(weekly))) });
const run = (root, deps) => podcastBehindSchedule(root, { now: NOW, deps });

test("MUST FAIL: a daily feed whose newest item is ten days old (the outage) is a finding, with its age", async () => {
  const r = await run(project(), feeds("2026-10-04T03:00:00Z"));
  assert.equal(r.checked, true);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].class, PODCAST_BEHIND);
  assert.equal(r.findings[0].subject, "https://saasreport.ai/podcasts/daily/feed.xml");
  assert.equal(r.findings[0].age_days, 10);
  assert.match(r.findings[0].problem, /behind schedule/);
});

test("MUST PASS: yesterday's episode is within a day plus the grace; the newest of several items counts", async () => {
  assert.deepEqual((await run(project(), feeds(["2026-09-01T03:00:00Z", "2026-10-13T08:00:00Z"]))).findings, []);
});

test("the limit is cadence + grace from the configs: 1 day + 180 min passes at 26 h and fails at 28 h; a weekly series gets 7 days", async () => {
  assert.equal((await run(project(), feeds("2026-10-13T06:00:00Z"))).findings.length, 0, "26 h");
  assert.equal((await run(project(), feeds("2026-10-13T04:00:00Z"))).findings.length, 1, "28 h");
  assert.equal((await run(project(), feeds("2026-10-13T06:00:00Z", "2026-10-05T03:00:00Z"))).findings.filter((f) => f.subject.endsWith("/podcasts/feed.xml")).length, 1, "the weekly feed, nine days old");
  assert.equal(CADENCE_DAYS.week, 7);
  const tight = project({ schedule: { graceMinutes: 60 } });
  assert.equal((await run(tight, feeds("2026-10-13T06:00:00Z"))).findings.length, 1, "grace comes from podcast.config.json");
});

test("MUST FAIL: an unreadable feed, an empty feed and an undeclared grace are findings (unreadable), never fresh", async () => {
  const down = await run(project(), feeds(null));
  assert.equal(down.findings[0].unreadable, true);
  const empty = await run(project(), { fetch: async () => new Response("<rss><channel></channel></rss>") });
  assert.ok(empty.findings.every((f) => f.unreadable && /no dated item/.test(f.problem)));
  const noGrace = await run(project({ schedule: {} }), feeds("2026-10-13T03:00:00Z"));
  assert.match(noGrace.findings[0].problem, /graceMinutes is not declared/);
});

test("a series that has not started owes no item; a repository with no podcast is not checked, and says why", async () => {
  const r = await podcastBehindSchedule(project(), { now: new Date("2026-09-01T00:00:00Z"), deps: { fetch: async (url) => { assert.ok(!url.includes("/daily/"), "the daily series has not started"); return new Response(rss("2026-08-30T03:00:00Z")); } } });
  assert.deepEqual(r.findings, []);
  const none = await run(project(null), feeds("2026-10-13T08:00:00Z"));
  assert.equal(none.checked, false);
  assert.match(none.reason, /no podcast/);
  void mkdirSync;
});

test("newestItem reads the newest pubDate and ignores a feed without items", () => {
  assert.equal(newestItem(rss("2026-10-01T00:00:00Z", "2026-10-03T00:00:00Z")).toISOString(), "2026-10-03T00:00:00.000Z");
  assert.equal(newestItem("<rss></rss>"), null);
});


test("shared show: each series is measured independently, so a fresh neighbour cannot conceal a stopped series", async () => {
  const root = project();
  const file = join(root, "kit.config.js");
  const config = readFileSync(file, "utf8");
  assert.ok(config.includes("series: ["), "test fixture has a canonical series registry");
  writeFileSync(file, config.replace("series: [", `series: [
    { id: "other-weekly", title: "Other weekly", kind: "topic", every: "week", on: "sat", at: "06:00", slug: "other-week-{date}",
      podcast: { show: "weekly", slug: "other-week-{ref}", maxSeconds: 150 } },`));
  const requested = [];
  const data = (series, date) => ({ ok: true, episodes: [{ series, published_at: date }] });
  const r = await run(root, { fetch: async (url) => {
    requested.push(url);
    if (url.includes("series=weekly&")) return Response.json(data("weekly", "2026-10-13T06:00:00Z"));
    if (url.includes("series=other-weekly&")) return Response.json(data("other-weekly", "2026-10-01T06:00:00Z"));
    return new Response(rss("2026-10-13T06:00:00Z")); // daily is on time
  } });
  assert.ok(requested.some((u) => u.includes("series=weekly&limit=1")));
  assert.ok(requested.some((u) => u.includes("series=other-weekly&limit=1")));
  assert.equal(r.findings.length, 1, JSON.stringify(r.findings));
  assert.match(r.findings[0].subject, /series=other-weekly&limit=1/);
  assert.equal(r.findings[0].age_days, 13);
});

test("shared show: malformed, missing and wrong-series API evidence fails closed", async () => {
  const root = project();
  const file = join(root, "kit.config.js");
  const config = readFileSync(file, "utf8");
  writeFileSync(file, config.replace("series: [", `series: [
    { id: "other-weekly", title: "Other weekly", kind: "topic", every: "week", on: "sat", at: "06:00", slug: "other-week-{date}",
      podcast: { show: "weekly", slug: "other-week-{ref}", maxSeconds: 150 } },`));
  const r = await run(root, { fetch: async (url) => url.includes("/api/podcasts?")
    ? Response.json({ ok: true, episodes: [{ series: "wrong", published_at: "2026-10-14T08:00:00Z" }] })
    : new Response(rss("2026-10-13T08:00:00Z")) });
  assert.equal(r.findings.length, 2, JSON.stringify(r.findings));
  assert.ok(r.findings.every((f) => f.unreadable && /no verifiable dated episode/.test(f.problem)));
});


test("an ended series is not stale forever, but a missing final episode remains a finding", async () => {
  const root = project();
  const file = join(root, "kit.config.js");
  const old = readFileSync(file, "utf8");
  assert.ok(old.includes('id: "weekly"'), "fixture declares the weekly series");
  writeFileSync(file, old.replace('id: "weekly",', 'id: "weekly", end: "2026-10-08",'));
  const afterEnd = { fetch: async (url) => new Response(url.includes("weekly") || url.endsWith("/podcasts/feed.xml")
    ? rss("2026-10-06T06:00:00Z") : rss("2026-10-13T08:00:00Z")) };
  assert.deepEqual((await run(root, afterEnd)).findings, [],
    "published final weekly episode remains fresh after the season closes on Oct 8");
  const missedFinal = { fetch: async (url) => new Response(url.includes("weekly") || url.endsWith("/podcasts/feed.xml")
    ? rss("2026-09-20T06:00:00Z") : rss("2026-10-13T08:00:00Z")) };
  const bad = await run(root, missedFinal);
  assert.equal(bad.findings.length, 1, JSON.stringify(bad.findings));
  assert.match(bad.findings[0].problem, /behind schedule|final episode is missing/,
    "the final scheduled episode is still owed even though the series has ended");
  const missing = { fetch: async (url) => new Response(url.includes("weekly") || url.endsWith("/podcasts/feed.xml")
    ? "<rss><channel></channel></rss>" : rss("2026-10-13T08:00:00Z")) };
  const noItem = await run(root, missing);
  assert.equal(noItem.findings.length, 1);
  assert.equal(noItem.findings[0].unreadable, true, "end of season does not waive missing proof");
});


test("ended daily series near midnight cannot hide a missing final slot behind the cadence window", async () => {
  const root = project();
  const file = join(root, "kit.config.js");
  const old = readFileSync(file, "utf8");
  const daily = 'id: "daily", title: DAILY, kind: "term", every: "day", at: "06:00",';
  assert.ok(old.includes(daily), "fixture has a daily slot");
  writeFileSync(file, old.replace(daily, 'id: "daily", title: DAILY, kind: "term", every: "day", at: "23:00", end: "2026-10-08",'));
  const missed = await run(root, feeds("2026-10-07T19:00:00Z", "2026-10-10T03:00:00Z"));
  assert.equal(missed.findings.length, 1, JSON.stringify(missed.findings));
  assert.match(missed.findings[0].problem, /final scheduled daily episode.*missing/);
  assert.equal(missed.findings[0].expected, "2026-10-08T19:00:00.000Z",
    "the publisher uses Asia/Dubai, not a UTC midnight guess");
  const complete = await run(root, feeds("2026-10-08T19:00:00Z", "2026-10-10T03:00:00Z"));
  assert.deepEqual(complete.findings, [], "a published final slot stays valid after the declared end");
});
