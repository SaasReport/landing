import { test } from "node:test";
import assert from "node:assert/strict";
import { defineConfig, agenda } from "../src/index.js";
import { faConfig, enConfig, topicFa, topicEn, termFa, termEn, talkFa } from "./helpers.mjs";

const cats = [{ key: "a", name: "دسته الف" }, { key: "b", name: "دسته ب" }];

test("agenda: stats per series, gaps and problems, markdown tables", () => {
  const config = defineConfig(faConfig());
  const content = {
    weekly: [topicFa("2026-10-03"), topicFa("2026-10-10", { talk: talkFa(10, 180) })],   // second is over the 150 s budget
    monthly: [{ month: "1405-08", title: "آبان", intro: "مقدمه ".repeat(40) }],
    daily: { categories: cats, terms: [termFa("a1", "a"), termFa("b1", "b"), termFa("a2", "a")] },
  };
  const r = agenda(config, content, { from: "2026-09-30", days: 28 }); // 30 Sep – 27 Oct 2026
  const s = r.stats.series;
  assert.equal(r.stats.from, "2026-09-30");
  assert.equal(r.stats.to, "2026-10-27");
  assert.deepEqual([s.weekly.items, s.weekly.missing, s.weekly.episodes, s.weekly.posts], [2, 2, 2, 2]);   // 4 Saturdays, 2 without topics
  assert.deepEqual([s.monthly.items, s.monthly.missing], [1, 0]);                                   // 1 Aban
  assert.deepEqual([s.daily.items, s.daily.missing, s.daily.episodes], [3, 25, 3]);
  assert.equal(r.stats.total, 6);
  assert.equal(r.stats.episodes, 5);
  assert.ok(s.daily.seconds.min > 0 && s.daily.seconds.max >= s.daily.seconds.avg);
  assert.ok(r.problems.includes("weekly 2026-10-17: no scheduled topic"));
  assert.ok(r.problems.includes("daily 2026-10-03: no term left in the rotation (day 4)"));
  assert.ok(r.problems.some((p) => /^weekly-2026-10-10: about 164 s, over the 150 s budget/.test(p)), r.problems.join("\n"));
  assert.equal(r.stats.problems, r.problems.length);
  assert.match(r.markdown, /^# تقویم انتشار نمونه/);
  assert.match(r.markdown, /- weekly: ۲ مورد، ۲ قسمت صوتی، ۲ جای خالی/);
  assert.match(r.markdown, /\| ۱ \| چهارشنبه ۸ مهر ۱۴۰۵ \| واژه a1 \(a1\) \| دسته الف \| ۰:[۰-۹]{2} \|/);
  assert.match(r.markdown, /\| جمعه ۱ آبان ۱۴۰۵ \| آبان؛ نمای ماه کاری آبان ۱۴۰۵ \|/);
  assert.match(r.markdown, /## مشکلات\n\n- /);
  assert.equal(r.items.length, 6);
});

test("agenda: a clean English schedule has no problems and accepts exact episode lines", () => {
  const config = defineConfig(enConfig([
    { id: "weekly", kind: "topic", every: "week", on: "mon", podcast: { show: "weekly", maxSeconds: 150 } },
    { id: "daily", kind: "term", every: "day", start: "2026-10-05", end: "2026-10-06" },
  ]));
  const content = { weekly: [topicEn("2026-10-05"), topicEn("2026-10-12")], daily: { categories: [{ key: "a", name: "A" }], terms: [termEn("x", "a"), termEn("y", "a")] } };
  const r = agenda(config, content, { from: "2026-10-05", days: 14 });
  assert.deepEqual(r.problems, []);
  assert.equal(r.stats.series.weekly.items, 2);
  assert.equal(r.stats.series.daily.items, 2);
  assert.match(r.markdown, /\| 1 \| Monday, October 5, 2026 \| Topic 2026-10-05 \| 8 turns, about 1:21 \|/);
  assert.match(r.markdown, /No problems\./);
  const long = agenda(config, content, { from: "2026-10-05", days: 7, episode: () => [{ speaker: "host", text: "x".repeat(2000) }] });
  assert.equal(long.problems.length, 1);
  assert.match(long.problems[0], /over the 150 s budget/);
});

test("agenda: a series' own podcast.cps (the rate measured for its voice) replaces speech.cps in the length estimate", () => {
  const mk = (cps) => defineConfig(enConfig([{ id: "weekly", kind: "topic", every: "week", on: "mon", start: "2026-10-05", podcast: { show: "weekly", maxSeconds: 150, ...(cps ? { cps } : {}) } }]));
  const content = { weekly: [topicEn("2026-10-05")] };
  const lines = () => [{ speaker: "ada", text: "x".repeat(1700) }];   // 155 s at the default 11 characters a second, 85 s at 20
  const slow = agenda(mk(), content, { from: "2026-10-05", days: 7, episode: lines });
  assert.equal(slow.problems.length, 1, slow.problems.join());
  assert.match(slow.problems[0], /about 155 s, over the 150 s budget/);
  const fast = agenda(mk(20), content, { from: "2026-10-05", days: 7, episode: lines });
  assert.deepEqual(fast.problems, []);
  assert.throws(() => defineConfig(enConfig([{ id: "weekly", kind: "topic", every: "week", on: "mon", podcast: { show: "weekly", maxSeconds: 150, cps: -1 } }])), /podcast\.cps must be a positive number/);
});
