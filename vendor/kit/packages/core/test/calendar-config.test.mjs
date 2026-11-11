// The calendar block: the market shape of @saasreport/calendar/config ({ systems, primary, profiles: [markets], digits })
// next to the original shape ({ system, weekend, holidays, profiles: { key: weekend } }), which is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { defineConfig, KitConfigError, planner, buildPost } from "../src/index.js";

const site = { name: "Demo", url: "https://demo.example", locale: "ar", timezone: "Asia/Riyadh" };

test("market shape: resolveCalendarConfig's fields merged in; the reports' fields keep their meaning", () => {
  const c = defineConfig({ site, calendar: { systems: ["gregorian", "hijri"], profiles: ["sa", "ae"], digits: "arabic" } }).calendar;
  assert.deepEqual([c.systems, c.primary, c.secondary, c.markets, c.profile, c.digits], [["gregorian", "hijri-umalqura"], "gregorian", ["hijri-umalqura"], ["sa", "ae"], "sa", "arabic"]);
  assert.equal(c.system, "gregorian");
  assert.deepEqual(c.weekend, [5, 6], "the first market's weekend");
  assert.equal(c.holidays, "none");
  assert.deepEqual(Object.keys(c.profiles), ["sa", "ae"]);
  assert.deepEqual(c.profiles.sa, { key: "sa", weekend: [5, 6], label: "المملكة العربية السعودية" });
  assert.deepEqual(c.profiles.ae.weekend, [6, 0], "the market's current weekend");
  const only = defineConfig({ site, calendar: { systems: ["gregorian"] } }).calendar;
  assert.deepEqual([only.markets, only.weekend, Object.keys(only.profiles)], [[], [0, 6], ["business"]]);
});

test("market shape: problems come from @saasreport/calendar/config", () => {
  assert.throws(() => defineConfig({ site, calendar: { systems: ["gregorian"], profiles: ["zz"] } }), (e) => e instanceof KitConfigError && e.problems.some((p) => /calendar.profiles: unknown market "zz"/.test(p)));
  assert.throws(() => defineConfig({ site, calendar: { systems: ["mayan"] } }), /calendar.systems: unknown system "mayan"/);
  assert.throws(() => defineConfig({ site, calendar: { systems: ["gregorian"], primary: "jalali" } }), /calendar.primary must be one of calendar.systems/);
});

test("market shape publishes: weekly reports count business days per market", () => {
  const config = defineConfig({ site, calendar: { systems: ["gregorian", "hijri"], profiles: ["sa"] },
    series: [{ id: "weekly", kind: "report", every: "week", on: "sun", start: "2026-10-04" }] });
  const plan = planner(config, { weekly: [] });
  const post = buildPost(plan, plan.due("2026-10-04")[0]);
  assert.match(post.body_md, /- أيام العمل، المملكة العربية السعودية \(العطلة: الجمعة والسبت\): \*\*٥\*\*/);
});

test("the legacy shape is unchanged", () => {
  const c = defineConfig({ site: { name: "x", url: "https://x.example", locale: "fa-IR" }, calendar: { system: "jalali", weekend: "bank", holidays: "iran", settlement: 1, weekMerge: true } }).calendar;
  assert.deepEqual(JSON.parse(JSON.stringify(c)), {
    system: "jalali", weekend: [5], holidays: "iran", settlement: 1, weekMerge: true, weekendName: "bank", ahead: 30,
    profiles: { bank: { key: "bank", weekend: [5] }, government: { key: "government", weekend: [4, 5] }, market: { key: "market", weekend: [4, 5] } },
  });
  for (const k of ["systems", "markets", "primary", "digits"]) assert.equal(c[k], undefined, k);
  assert.throws(() => defineConfig({ site, calendar: { system: "hijri" } }), /calendar.system must be "jalali" or "gregorian"/);
  assert.throws(() => defineConfig({ site, calendar: { profiles: "sa" } }), /calendar.profiles must be an object/);
});

test("B7: the normalised block resolves again to the same markets (resolveCalendarConfig and defineConfig are idempotent)", async () => {
  const { resolveCalendarConfig } = await import("@saasreport/calendar/config");
  const c = defineConfig({ site, calendar: { systems: ["gregorian", "hijri"], profiles: ["sa", "ae", "us"] } }).calendar;
  const r = resolveCalendarConfig(c, { locale: "ar" });
  assert.deepEqual([r.profiles, r.profile, r.problems], [["sa", "ae", "us"], "sa", []]);
  const again = defineConfig({ site, calendar: c }).calendar;
  assert.deepEqual([again.markets, Object.keys(again.profiles), again.weekend], [c.markets, Object.keys(c.profiles), c.weekend]);
});
