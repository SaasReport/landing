import { test } from "node:test";
import assert from "node:assert/strict";
import { defineConfig, planner, roundRobin, toDay, iso } from "../src/index.js";
import { faConfig, enConfig, topicFa, topicEn, termFa, termEn } from "./helpers.mjs";

const cats = [{ key: "a", name: "A" }, { key: "b", name: "B" }, { key: "c", name: "C" }];
const terms = (mk) => [mk("a1", "a"), mk("a2", "a"), mk("a3", "a"), mk("b1", "b"), mk("c1", "c"), mk("c2", "c")];

test("round-robin rotation takes each category's next term in turn", () => {
  assert.deepEqual(roundRobin(cats, terms(termFa)).map((t) => t.slug), ["a1", "b1", "c1", "a2", "c2", "a3"]);
});

test("jalali planner: weekly on Saturday, monthly on the 1st of the Solar Hijri month, daily rotation", () => {
  const config = defineConfig(faConfig());
  const content = {
    weekly: [topicFa("2026-10-03"), topicFa("2026-10-10")],
    monthly: [{ month: "1405-08", title: "آبان", intro: "مقدمه ".repeat(40) }],
    daily: { categories: cats, terms: terms(termFa) },
  };
  const plan = planner(config, content);
  // Saturday 11 Mehr 1405 = 2026-10-03, 06:00 Tehran = 02:30Z
  const sat = plan.due("2026-10-03");
  assert.deepEqual(sat.map((e) => [e.series, e.slug]), [["weekly", "weekly-2026-10-03"], ["daily", "daily-a2"]]);
  assert.equal(sat[0].publishAt, "2026-10-03T02:30:00.000Z");
  assert.equal(sat[0].item.title, "موضوع 2026-10-03");
  assert.equal(sat[1].number, 4);
  assert.equal(sat[1].category.name, "A");
  // 1 Aban 1405 = 2026-10-23 (a Friday; not a weekly slot)
  const m = plan.due("2026-10-23");
  assert.deepEqual(m.map((e) => e.slug), ["monthly-1405-08"]);
  assert.equal(m[0].key, "1405-08");
  // 1 Azar 1405: no theme, but report series publish their tables anyway (empty: "tables")
  const azar = plan.due("2026-11-22");
  assert.equal(azar[0].slug, "monthly-1405-09");
  assert.equal(azar[0].missing, true);
  // A Saturday without a topic publishes nothing for a topic series (empty: "skip") but is a slot
  assert.equal(plan.due("2026-10-17").length, 0);
  assert.equal(plan.slotsOn("2026-10-17")[0].missing, true);
  // term rotation: 6 terms from 2026-09-30, nothing before or after
  assert.equal(plan.due("2026-09-29").length, 0);
  assert.equal(plan.slotsOn("2026-10-06").find((e) => e.series === "daily").missing, true);
  assert.deepEqual(plan.range("2026-09-30", "2026-10-05").filter((e) => e.series === "daily").map((e) => [e.number, e.item.slug]),
    [[1, "a1"], [2, "b1"], [3, "c1"], [4, "a2"], [5, "c2"], [6, "a3"]]);
  assert.equal(iso(plan.dayOf("daily", "a3")), "2026-10-05");
  assert.equal(plan.find("daily", "c1").number, 3);
  assert.equal(plan.find("daily", "daily-c1").date, "2026-10-02");
  assert.equal(plan.find("weekly", "2026-10-10").item.title, "موضوع 2026-10-10");
  assert.equal(plan.find("weekly", "weekly-2026-10-10").date, "2026-10-10");
  assert.equal(plan.find("weekly", "2026-10-11"), null); // not a Saturday
  assert.equal(plan.find("monthly", "1405-08").date, "2026-10-23");
  assert.equal(plan.find("monthly", "monthly-1405-08").date, "2026-10-23");
});

test("gregorian planner: Monday weekly, calendar-month reports, DST-aware publish times", () => {
  const config = defineConfig(enConfig());
  const content = {
    weekly: [topicEn("2026-10-26"), topicEn("2026-11-02")],
    monthly: [{ month: "2026-11", title: "November", intro: "Intro ".repeat(40) }],
    daily: { categories: cats, terms: terms(termEn) },
  };
  const plan = planner(config, content);
  const before = plan.due("2026-10-26"), after = plan.due("2026-11-02");
  assert.equal(before[0].slug, "weekly-2026-10-26");
  assert.equal(before[0].publishAt, "2026-10-26T10:00:00.000Z"); // EDT (UTC-4)
  assert.equal(after[0].publishAt, "2026-11-02T11:00:00.000Z");  // EST (UTC-5) after 1 Nov
  const nov = plan.due("2026-11-01");
  assert.deepEqual(nov.map((e) => e.slug), ["monthly-2026-11"]);
  assert.equal(nov[0].publishAt, "2026-11-01T12:30:00.000Z");     // 07:30 EST
  assert.equal(plan.due("2026-10-01").find((e) => e.series === "monthly").key, "2026-10");
  assert.equal(plan.due("2026-10-01").find((e) => e.series === "daily").number, 1);
  assert.equal(plan.find("monthly", "2026-12").date, "2026-12-01");
});

test("weekly and monthly rotation series number their slots; last-day-of-month slots; end dates; slug templates", () => {
  const config = defineConfig({ ...faConfig([
    { id: "wterm", kind: "term", every: "week", on: "wed", start: "2026-09-30", rotation: "sequential", slug: "w-{number}-{slug}" },
    { id: "mterm", kind: "term", every: "month", on: -1, start: "2026-09-30" },
    { id: "topics", kind: "topic", every: "day", start: "2026-10-01", end: "2026-10-02", slug: (v) => `t/${v.date}` },
  ]), shows: {} });
  const t = { categories: cats, terms: terms(termFa) };
  const plan = planner(config, { wterm: t, mterm: t, topics: [topicFa("2026-10-01"), topicFa("2026-10-02"), topicFa("2026-10-03")] });
  assert.deepEqual(plan.range("2026-09-30", "2026-10-14").filter((e) => e.series === "wterm").map((e) => [e.date, e.number, e.slug]),
    [["2026-09-30", 1, "w-1-a1"], ["2026-10-07", 2, "w-2-a2"], ["2026-10-14", 3, "w-3-a3"]]);
  // last day of Mehr 1405 = 2026-10-22 (30 days), of Aban = 2026-11-21
  const m = plan.range("2026-09-30", "2026-11-30").filter((e) => e.series === "mterm");
  assert.deepEqual(m.map((e) => [e.date, e.number, e.item.slug]), [["2026-10-22", 1, "a1"], ["2026-11-21", 2, "b1"]]);
  assert.equal(iso(plan.dayOf("mterm", "c1")), "2026-12-21");
  assert.deepEqual(plan.range("2026-09-30", "2026-10-05").filter((e) => e.series === "topics").map((e) => e.slug), ["t/2026-10-01", "t/2026-10-02"]);
  assert.equal(plan.isSlot("wterm", toDay("2026-10-07")), true);
});

test("loadContent resolves series sources (module namespaces, default exports, inline content)", async () => {
  const { loadContent, checkContent } = await import("../src/index.js");
  const config = defineConfig(faConfig([
    { id: "weekly", kind: "topic", on: "sat", source: async () => ({ default: [topicFa("2026-10-03")] }) },
    { id: "monthly", kind: "report", source: async () => ({ items: [{ month: "1405-08", title: "آبان", intro: "مقدمه ".repeat(40) }] }) },
    { id: "daily", kind: "term", start: "2026-09-30", source: { categories: [{ key: "a", name: "A", terms: [termFa("x", "a")] }] } },
  ]));
  const content = await loadContent(config);
  assert.deepEqual(checkContent(config, content), []);
  const plan = planner(config, content);
  assert.deepEqual(plan.due("2026-09-30").map((e) => e.slug), ["daily-x"]);
  assert.equal(plan.due("2026-10-03")[0].item.title, "موضوع 2026-10-03");
  assert.equal(plan.due("2026-10-23")[0].item.title, "آبان");
});
