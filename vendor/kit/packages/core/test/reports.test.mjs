import { test } from "node:test";
import assert from "node:assert/strict";
import { defineConfig, planner, calendarTables, weekReport, monthReport, buildPost, toDay } from "../src/index.js";
import { faConfig, enConfig, topicFa, topicEn } from "./helpers.mjs";

const fa = defineConfig(faConfig());
const en = defineConfig(enConfig());

test("calendarTables: business days per profile, holidays, settlement", () => {
  const t = calendarTables(fa, { from: "2026-03-21", to: "2026-03-27" }); // Nowruz week, Sat–Fri
  assert.equal(t.days.length, 7);
  assert.deepEqual(t.counts.map((c) => [c.key, c.business]), [["bank", 2], ["government", 1], ["market", 1]]);
  assert.ok(t.holidays.some((h) => /نوروز/.test(h.title)));
  assert.equal(t.days[0].status, "holiday");
  assert.equal(t.days[6].status, "weekend");
  assert.ok(t.days[5].settlement.day > t.days[5].day);
  const g = calendarTables(en, { from: "2026-12-21", to: "2026-12-27" });
  assert.deepEqual(g.counts.map((c) => [c.key, c.business]), [["business", 5]]);
  assert.deepEqual(g.holidays, []);
  assert.equal(g.days[0].label, "Monday, December 21, 2026");
});

test("week report (legacy weekSnapshot): Nowruz week", () => {
  const w = weekReport(fa, "2026-03-21");
  assert.match(w.body_md, /جشن نوروز/);
  assert.match(w.title, /۱ فروردین تا ۷ فروردین ۱۴۰۵/);
  assert.match(w.body_md, /روز کاری بانک و شبکه پرداخت \(آخر هفته: جمعه\): \*\*۲ روز\*\*/);
  assert.match(w.body_md, /\| روز \| وضعیت \| تسویه T\+1 \| مناسبت \|/);
  assert.match(w.body_md, /\[تقویم مالی\]\(\/calendar\/\)/);
  assert.doesNotMatch(w.body_md + w.title + w.summary, /undefined|NaN|\[object/);
});

test("month report (legacy monthSnapshot): Farvardin 1405 and a themed month", () => {
  const m = monthReport(fa, "1405-01");
  assert.equal(m.title, "نمای ماه کاری: فروردین ۱۴۰۵");
  assert.match(m.body_md, /آغاز سال مالی/);
  assert.match(m.body_md, /\| بانک و شبکه پرداخت \| جمعه \| .+ از ۳۱ \|/);
  const t = monthReport(fa, "1405-08", { theme: { title: "پول درست", intro: "مقدمه ماه." }, topics: [topicFa("2026-10-24")] });
  assert.equal(t.title, "پول درست؛ نمای ماه کاری آبان ۱۴۰۵");
  assert.match(t.body_md, /^مقدمه ماه\.\n\n## برنامه آبان/);
  assert.match(t.body_md, /- شنبه ۲ آبان ۱۴۰۵: \*\*موضوع 2026-10-24\*\*/);
});

test("buildPost: weekly topics lead with the article and the podcast link, then the week's tables", () => {
  const plan = planner(fa, { weekly: [topicFa("2026-10-03")], monthly: [{ month: "1405-08", title: "آبان", intro: "مقدمه ".repeat(40) }], daily: { categories: [], terms: [] } });
  const [e] = plan.due("2026-10-03");
  const p = buildPost(plan, e);
  assert.equal(p.slug, "weekly-2026-10-03");
  assert.equal(p.title, "موضوع 2026-10-03");
  assert.equal(p.published_at, "2026-10-03T02:30:00.000Z");
  assert.ok(p.body_md.startsWith(topicFa("2026-10-03").article.slice(0, 40)));
  assert.match(p.body_md, /## تقویم کاری هفته: ۱۱ مهر تا ۱۷ مهر ۱۴۰۵/);
  assert.match(p.body_md, /\[قسمت این هفته پادکست\]\(\/podcasts\/weekly-2026-10-03\)/);
  const m = buildPost(plan, plan.due("2026-10-23")[0]);
  assert.match(m.title, /^آبان؛ نمای ماه کاری آبان ۱۴۰۵$/);
});

test("English, Gregorian reports use English strings and no holiday sections", () => {
  const plan = planner(en, { weekly: [topicEn("2026-10-05")], monthly: [], daily: { categories: [], terms: [] } });
  const p = buildPost(plan, plan.due("2026-10-05")[0]);
  assert.match(p.body_md, /## This week's business calendar: October 5 – October 11, 2026/);
  assert.match(p.body_md, /- Business days, standard week \(weekend: Sunday and Saturday\): \*\*5\*\*/);
  assert.doesNotMatch(p.body_md, /Public holiday|predicted/i);
  const m = buildPost(plan, plan.due("2026-11-01")[0]);
  assert.equal(m.title, "Business month: November 2026");
  assert.match(m.body_md, /\| standard week \| Sunday and Saturday \| 21 of 30 \|/);
  const custom = defineConfig({ ...enConfig(), strings: { monthTitle: "Month {name}" } });
  assert.equal(monthReport(custom, "2026-11").title, "Month November 2026");
});

test("report options: calendar.weekMerge, strings weekFooter / eventSep, series.postKind", () => {
  const c = defineConfig({ ...faConfig(), calendar: { ...faConfig().calendar, weekMerge: true }, strings: { weekFooter: "پانویس هفته.", eventSep: " | " } });
  const w = weekReport(c, "2026-03-21");
  assert.match(w.body_md, /روز کاری دستگاه‌های دولتی و بازار سرمایه \(آخر هفته: پنجشنبه و جمعه\): \*\*۱ روز\*\*/);
  assert.doesNotMatch(w.body_md, /^- روز کاری بازار سرمایه/m);
  assert.ok(w.body_md.endsWith("\n\nپانویس هفته."));
  assert.doesNotMatch(weekReport(fa, "2026-03-21").body_md, /پانویس/);
  const days = w.tables.days.filter((d) => d.events.length > 1);
  if (days.length) assert.match(w.body_md, / \| [^|]+ \| [^|]+ \| /);
  const raw = faConfig();
  raw.series = raw.series.map((x) => (x.kind === "topic" ? { ...x, postKind: (e) => (e.item ? "article" : "snapshot") } : x.kind === "report" ? { ...x, postKind: "snapshot" } : x));
  const plan = planner(defineConfig(raw), { weekly: [topicFa("2026-10-03")], monthly: [{ month: "1405-08", title: "آبان", intro: "مقدمه ".repeat(40) }], daily: { categories: [], terms: [] } });
  assert.equal(buildPost(plan, plan.due("2026-10-03")[0]).kind, "article");
  assert.equal(buildPost(plan, plan.due("2026-10-23")[0]).kind, "snapshot");
  const plain = planner(fa, { weekly: [topicFa("2026-10-03")], monthly: [], daily: { categories: [], terms: [] } });
  assert.equal(buildPost(plain, plain.due("2026-10-03")[0]).kind, "topic");
});

test("buildPost: a topic's sources follow the article as one line of links", () => {
  const src = [{ title: "OSI", url: "https://opensource.org/licenses/MIT" }, { title: "SPDX", url: "https://spdx.org/licenses/" }];
  const plan = planner(fa, { weekly: [topicFa("2026-10-03", { sources: src })], monthly: [], daily: { categories: [], terms: [] } });
  const p = buildPost(plan, plan.due("2026-10-03")[0]);
  assert.match(p.body_md, /\*\*منابع:\*\* \[OSI\]\(https:\/\/opensource\.org\/licenses\/MIT\)، \[SPDX\]\(https:\/\/spdx\.org\/licenses\/\)\n\n/);
  assert.ok(p.body_md.indexOf("منابع") < p.body_md.indexOf("## تقویم کاری هفته"));
  const plain = planner(en, { weekly: [topicEn("2026-10-05")], monthly: [], daily: { categories: [], terms: [] } });
  assert.doesNotMatch(buildPost(plain, plain.due("2026-10-05")[0]).body_md, /Sources:/);
});
