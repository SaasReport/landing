import { test } from "node:test";
import assert from "node:assert/strict";
import { defineConfig, KitConfigError, DEFAULT_CONTRACTS } from "../src/index.js";
import { faConfig, enConfig } from "./helpers.mjs";

test("defineConfig fills defaults from the locale", () => {
  const fa = defineConfig(faConfig());
  assert.equal(fa.site.dir, "rtl");
  assert.equal(fa.calendar.system, "jalali");
  assert.deepEqual(fa.calendar.weekend, [5]);
  assert.equal(fa.calendar.holidays, "iran");
  assert.deepEqual(Object.keys(fa.calendar.profiles), ["bank", "government", "market"]);
  assert.equal(fa.features.blog && fa.features.sitemap && fa.features.llms, true);
  assert.equal(fa.series[0].on, 6); // sat
  assert.equal(fa.series[0].at, "06:00");
  assert.equal(fa.series[0].slug, "{id}-{date}");
  assert.equal(fa.series[2].rotation, "round-robin");
  assert.deepEqual(fa.series[2].contract, DEFAULT_CONTRACTS.term);
  assert.equal(fa.shows.weekly.feed, "/podcasts/feed.xml");
  assert.equal(fa.shows.daily.feed, "/podcasts/daily/feed.xml");
  assert.equal(fa.site.org.name, "نمونه");
  const en = defineConfig(enConfig());
  assert.equal(en.site.url, "https://demo.example"); // trailing slash trimmed
  assert.equal(en.site.dir, "ltr");
  assert.equal(en.calendar.system, "gregorian");
  assert.deepEqual(en.calendar.weekend, [0, 6]);
  assert.equal(en.calendar.holidays, "none");
  assert.equal(defineConfig(en), en); // idempotent
});

test("defineConfig keeps keys other packages read", () => {
  const c = defineConfig({ ...faConfig(), tts: { provider: "gemini", model: "m", voices: { host: "a" }, chunk: 10 }, strings: { podcast: { intro: "x" }, home: "Home!" },
    shows: { weekly: { title: "W", short: "w", cover: "/c.png" }, daily: { title: "D" } } });
  assert.equal(c.tts.chunk, 10);
  assert.deepEqual(c.strings.podcast, { intro: "x" });
  assert.equal(c.shows.weekly.short, "w");
  const s = defineConfig({ ...faConfig(), series: [{ id: "w", kind: "topic", podcast: { show: "weekly", slug: "{id}", calendar: true } }] }).series[0];
  assert.equal(s.podcast.calendar, true);
  assert.equal(s.podcast.maxSeconds, 150);
});

test("defineConfig lists every problem in one error", () => {
  let err;
  try {
    defineConfig({
      site: { url: "demo.example", locale: "??", timezone: "Mars/Olympus", dir: "up" },
      calendar: { system: "mayan", weekend: "sunday", settlement: 99 },
      hosts: { host: {} },
      shows: { a: { feed: "feed.xml" } },
      series: [
        { id: "Weekly", kind: "blog", every: "year" },
        { id: "w", kind: "topic", every: "week", on: "someday", at: "25:00" },
        { id: "w", kind: "term", start: "2026-13-01", rotation: "random", podcast: { show: "nope" } },
        { id: "m", kind: "report", every: "month", on: 40, start: "2026-02-01", end: "2026-01-01" },
      ],
      features: { blog: "yes", teleport: true },
      colours: {},
    });
  } catch (e) { err = e; }
  assert.ok(err instanceof KitConfigError);
  const want = [
    /unknown top-level key "colours"/, /site\.name is required/, /site\.url must be an absolute/, /site\.locale is not a valid/, /site\.dir must be/,
    /site\.timezone is not a valid/, /calendar\.system must be/, /calendar\.weekend must be/, /calendar\.settlement/, /hosts\.host\.name is required/,
    /shows\.a\.title is required/, /shows\.a\.feed must be a site path/, /series\[0\] \(Weekly\)\.id must be a lowercase slug/, /series\[0\].*kind must be one of/,
    /series\[0\].*every must be one of/, /series\[1\].*on must be a weekday/, /series\[1\].*at must be a local time/, /series\[2\].*"w" is used twice/,
    /series\[2\].*start must be an ISO date/, /series\[2\].*rotation must be/, /series\[2\].*podcast\.show "nope"/, /series\[3\].*on must be a day of the month/,
    /series\[3\].*end is before start/, /features\.blog must be true or false/, /features\.teleport is unknown/,
  ];
  for (const re of want) assert.ok(err.problems.some((p) => re.test(p)), `missing problem ${re}\n${err.message}`);
  assert.match(err.message, /^Invalid kit config \(\d+ problems\):\n  - /);
  assert.throws(() => defineConfig({}), /site is required/);
  assert.throws(() => defineConfig({ site: { name: "x", url: "https://x.y" }, series: [{ id: "d", kind: "term" }] }), /start is required for a term series/);
});
