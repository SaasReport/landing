/* India, China, Singapore and Australia: every holiday of each published year against the official list, the
   substitution rules, China's make-up working days, expected marking beyond the published years, the lunisolar
   tables and the feeds. The expected lists below were copied from the official pages on 2026-10-01. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../src/index.js";
import * as M from "../src/markets.js";
import * as B from "../src/business.js";
import * as L from "../src/chinese.js";
import { marketIcs } from "../src/ics.js";
import { events, unfold, assertValidIcs } from "./ics-assert.mjs";

const D = (iso) => C.fromISO(iso);
const isos = (id, y, keep = () => true) => [...new Set(M.yearHolidays(id, y).filter(keep).map((h) => h.iso))];
const mmdd = (y, list) => list.map((d) => `${y}-${d}`);
const run = (from, n) => Array.from({ length: n }, (_, i) => C.toISO(D(from) + i));

/* ------------------------------------------------------------------ official lists */
test("India: every RBI NI Act holiday for Mumbai, 2025 and 2026", () => {
  // Source: https://www.rbi.org.in/Scripts/HolidayMatrixDisplay.aspx (Regional Office: Mumbai, All Months, 2026 / 2025).
  // The RBI lists only working days: holidays on Sundays and on second and fourth Saturdays are not on it.
  const rbi = {
    2026: mmdd(2026, ["01-15", "01-26", "02-19", "03-03", "03-19", "03-21", "03-26", "03-31", "04-01", "04-03", "04-14", "05-01", "05-28",
      "06-26", "08-15", "08-26", "09-14", "10-02", "10-20", "11-10", "11-24", "12-25"]),
    2025: mmdd(2025, ["02-19", "02-26", "03-14", "03-31", "04-01", "04-10", "04-14", "04-18", "05-01", "05-12", "06-07", "08-15", "08-27",
      "09-08", "10-02", "10-21", "10-22", "11-05", "12-25"]),
  };
  const onRbiList = (h) => { const d = new Date(h.date * 864e5); const wd = d.getUTCDay(), k = Math.ceil(d.getUTCDate() / 7); return wd !== 0 && !(wd === 6 && (k === 2 || k === 4)); };
  for (const [y, want] of Object.entries(rbi)) {
    assert.deepEqual(isos("in", +y, onRbiList), want, `in ${y}`);
    assert.ok(M.yearHolidays("in", +y).every((h) => !h.predicted), `in ${y}: published, nothing expected`);
  }
  assert.equal(M.yearHolidays("in", 2026).find((h) => h.id === "eid-al-fitr").source, "https://www.rbi.org.in/Scripts/HolidayMatrixDisplay.aspx");
  // Republic Day 2025 fell on a Sunday: a holiday, though not on the RBI's working-day list.
  assert.ok(isos("in", 2025).includes("2025-01-26"));
});

test("China: every day off and make-up working day of the State Council notices for 2025 and 2026", () => {
  // Source 2026: 国务院办公厅关于2026年部分节假日安排的通知 (国办发明电〔2025〕7号), https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
  const off2026 = [...run("2026-01-01", 3), ...run("2026-02-15", 9), ...run("2026-04-04", 3), ...run("2026-05-01", 5), ...run("2026-06-19", 3), ...run("2026-09-25", 3), ...run("2026-10-01", 7)];
  const work2026 = ["2026-01-04", "2026-02-14", "2026-02-28", "2026-05-09", "2026-09-20", "2026-10-10"];
  // Source 2025: 国务院办公厅关于2025年部分节假日安排的通知 (国办发明电〔2024〕12号), https://www.gov.cn/zhengce/content/202411/content_6986382.htm
  const off2025 = ["2025-01-01", ...run("2025-01-28", 8), ...run("2025-04-04", 3), ...run("2025-05-01", 5), ...run("2025-05-31", 3), ...run("2025-10-01", 8)];
  const work2025 = ["2025-01-26", "2025-02-08", "2025-04-27", "2025-09-28", "2025-10-11"];
  for (const [y, off, work] of [[2026, off2026, work2026], [2025, off2025, work2025]]) {
    assert.deepEqual(isos("cn", y), off, `cn ${y} days off`);
    assert.deepEqual(M.makeUpWorkdays("cn", y).map((w) => w.iso), work, `cn ${y} make-up days`);
    assert.ok(M.yearHolidays("cn", y).every((h) => !h.predicted && h.source.startsWith("https://www.gov.cn/")), `cn ${y}: from the notice`);
    for (const w of work) assert.ok(M.isWeekend("cn", D(w)), `${w} is a Saturday or Sunday`);
  }
  // 6 October 2025 is Mid-Autumn inside the merged National Day break.
  assert.deepEqual(M.holidaysOn("cn", D("2025-10-06")).map((h) => h.id), ["mid-autumn"]);
  assert.equal(M.holidayTitle(M.holidaysOn("cn", D("2026-02-17"))[0], "zh"), "春节");
  assert.deepEqual(M.yearHolidays("cn", 2024), [], "no data before the 2024 regulation took effect");
});

test("Singapore: every MOM public holiday, 2025–2027, with the Monday after a Sunday holiday", () => {
  // Source: https://www.mom.gov.sg/employment-practices/public-holidays (tabs 2025, 2026, 2027).
  const mom = {
    2027: mmdd(2027, ["01-01", "02-06", "02-07", "02-08", "03-10", "03-26", "05-01", "05-17", "05-20", "08-09", "10-28", "12-25"]),
    2026: mmdd(2026, ["01-01", "02-17", "02-18", "03-21", "04-03", "05-01", "05-27", "05-31", "06-01", "08-09", "08-10", "11-08", "11-09", "12-25"]),
    2025: mmdd(2025, ["01-01", "01-29", "01-30", "03-31", "04-18", "05-01", "05-03", "05-12", "06-07", "08-09", "10-20", "12-25"]),
  };
  for (const [y, want] of Object.entries(mom)) {
    assert.deepEqual(isos("sg", +y), want, `sg ${y}`);
    assert.ok(M.yearHolidays("sg", +y).every((h) => !h.predicted), `sg ${y}: published`);
  }
  // "Monday, 8 February 2027, will be a public holiday if your rest day falls on 7 February 2027."
  const mon = M.holidaysOn("sg", D("2027-02-08"))[0];
  assert.deepEqual([mon.id, mon.observed, mon.of], ["chinese-new-year", true, "2027-02-07"]);
});

test("Australia (NSW): every public holiday on the NSW lists, 2021–2027", () => {
  // Source 2026–2027: https://www.nsw.gov.au/about-nsw/public-holidays ("NSW public holidays 2026 to 2027").
  // Source 2024–2026: NSW Guide to Public Holidays 2024, 2025 and 2026 (PDF; it does not list the Bank Holiday).
  // Source 2021–2023: NSW Public Holidays 2021-2023 (PDF).
  const nsw = {
    2027: ["01-01", "01-26", "03-26", "03-27", "03-28", "03-29", "04-25", "04-26", "06-14", "08-02", "10-04", "12-25", "12-26", "12-27", "12-28"],
    2026: ["01-01", "01-26", "04-03", "04-04", "04-05", "04-06", "04-25", "04-27", "06-08", "08-03", "10-05", "12-25", "12-26", "12-28"],
    2025: ["01-01", "01-27", "04-18", "04-19", "04-20", "04-21", "04-25", "06-09", "10-06", "12-25", "12-26"],
    2024: ["01-01", "01-26", "03-29", "03-30", "03-31", "04-01", "04-25", "06-10", "10-07", "12-25", "12-26"],
    2023: ["01-01", "01-02", "01-26", "04-07", "04-08", "04-09", "04-10", "04-25", "06-12", "08-07", "10-02", "12-25", "12-26"],
    2022: ["01-01", "01-03", "01-26", "04-15", "04-16", "04-17", "04-18", "04-25", "06-13", "08-01", "10-03", "12-25", "12-26", "12-27"],
    2021: ["01-01", "01-26", "04-02", "04-03", "04-04", "04-05", "04-25", "06-14", "08-02", "10-04", "12-25", "12-26", "12-27", "12-28"],
  };
  for (const [y, want] of Object.entries(nsw)) {
    const keep = (h) => !(y === "2024" || y === "2025") || h.id !== "bank-holiday";
    assert.deepEqual(isos("au", +y, keep), mmdd(y, want), `au ${y}`);
  }
  assert.ok(M.yearHolidays("au", 2027).every((h) => !h.predicted));
  assert.equal(M.yearHolidays("au", 2022).find((h) => h.date === D("2022-06-13")).title.en, "Queen's Birthday");
  assert.equal(M.yearHolidays("au", 2027).find((h) => h.date === D("2027-06-14")).title.en, "King's Birthday");
});

/* ------------------------------------------------------------------ substitution */
test("substitution: NSW additional days, Australia Day moved, Easter weekend and Anzac Day", () => {
  const on = (iso) => M.holidaysOn("au", D(iso)).map((h) => `${h.id}${h.observed ? `<${h.of}` : ""}`);
  // Australia Day on a Sunday: no holiday on the 26th, the Monday instead.
  assert.deepEqual(on("2025-01-26"), []);
  assert.deepEqual(on("2025-01-27"), ["australia-day<2025-01-26"]);
  // On a Saturday (26 January 2030): the following Monday, 28 January.
  assert.deepEqual([on("2030-01-26"), on("2030-01-28")], [[], ["australia-day<2030-01-26"]]);
  // Christmas on Saturday and Boxing Day on Sunday: Monday 27 and Tuesday 28.
  assert.deepEqual([on("2021-12-27"), on("2021-12-28")], [["christmas<2021-12-25"], ["boxing-day<2021-12-26"]]);
  // Christmas on Sunday: Boxing Day keeps Monday 26, the additional day is Tuesday 27.
  assert.deepEqual([on("2022-12-26"), on("2022-12-27")], [["boxing-day"], ["christmas<2022-12-25"]]);
  // Boxing Day on Saturday: Monday 28.
  assert.deepEqual(on("2026-12-28"), ["boxing-day<2026-12-26"]);
  // New Year's Day on Saturday / Sunday.
  assert.deepEqual([on("2022-01-03"), on("2023-01-02")], [["new-year<2022-01-01"], ["new-year<2023-01-01"]]);
  // Easter Saturday and Sunday never give an additional day.
  assert.ok(M.yearHolidays("au", 2026).filter((h) => h.observed).every((h) => !h.id.startsWith("easter")));
  // Anzac Day: no additional day until 2025 (2021 was a Sunday), the following Monday from 2026.
  assert.deepEqual(on("2021-04-26"), []);
  assert.deepEqual([on("2026-04-27"), on("2027-04-26"), on("2032-04-26")], [["anzac-day<2026-04-25"], ["anzac-day<2027-04-25"], ["anzac-day<2032-04-25"]]);
  // Singapore: Sunday moves to Monday, Saturday does not.
  assert.deepEqual(M.holidaysOn("sg", D("2026-08-10")).map((h) => [h.id, h.observed]), [["national-day", true]]);
  assert.deepEqual(M.holidaysOn("sg", D("2027-05-03")), [], "Labour Day 2027 is a Saturday: no substitute");
  // India and China: no substitute days.
  assert.ok([2026, 2027, 2028].every((y) => M.yearHolidays("in", y).every((h) => !h.observed) && M.yearHolidays("cn", y).every((h) => !h.observed)));
});

/* ------------------------------------------------------------------ make-up working days */
test("China make-up working days: open in every business-day function", () => {
  const sat = D("2026-02-14"); // Saturday, worked for the Spring Festival break
  assert.equal(M.isWeekend("cn", sat), true);
  assert.equal(M.isMakeUpWorkday("cn", sat), true);
  assert.equal(M.isMakeUpWorkday("cn", D("2026-02-21")), false);
  assert.equal(M.isMakeUpWorkday("us", sat), false);
  assert.deepEqual(B.marketStatus(sat, "cn"), { profile: "cn", open: true, weekend: false, holiday: false, half: false, uncertain: false, holidays: [], makeUp: true });
  assert.equal(B.isBusinessDay(sat, "cn"), true);
  assert.equal(B.isBusinessDay(sat, ["cn", "us"]), false, "the US is still closed that Saturday");
  // Arithmetic across the make-up Saturday: Thursday 12 Feb + 2 = Saturday 14 Feb; + 3 = Tuesday 24 Feb (the break is 15–23 Feb).
  assert.equal(B.addBusinessDays(D("2026-02-12"), 2, "cn").iso, "2026-02-14");
  assert.equal(B.addBusinessDays(D("2026-02-12"), 3, "cn").iso, "2026-02-24");
  assert.equal(B.addBusinessDays(D("2026-02-24"), -1, "cn").iso, "2026-02-14");
  assert.equal(B.settlement(D("2026-02-13"), "cn", { t: 1 }).iso, "2026-02-14");
  assert.equal(B.adjust(sat, "following", "cn").moved, 0);
  assert.equal(B.adjust(D("2026-02-15"), "preceding", "cn").iso, "2026-02-14");
  // February 2026: 20 weekdays − 6 in the break (16–20, 23) + 2 make-up Saturdays (14, 28) = 16 business days.
  assert.equal(B.businessDays(D("2026-02-01"), D("2026-02-28"), "cn").length, 16);
  assert.equal(B.businessDaysBetween(D("2026-01-31"), D("2026-02-28"), "cn").business, 16);
  assert.equal(B.monthEnd(D("2026-02-10"), "cn").iso, "2026-02-28", "the last business day of February 2026 is a make-up Saturday");
  assert.equal(B.monthEnd(D("2026-02-10"), "us").iso, "2026-02-27");
  assert.equal(B.dayStatus(D("2026-02-28"), "cn").business, true);
  // Each make-up day names the holiday it makes up for and the notice.
  const w = M.makeUpWorkdays("cn", 2026)[1];
  assert.deepEqual([w.iso, w.for, w.title.en, w.title.zh, w.source], ["2026-02-14", "spring-festival", "Working day (make-up for Spring Festival)", "春节调休上班", "https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm"]);
  assert.deepEqual(M.makeUpWorkdays("cn", 2027), [], "not announced yet");
  assert.deepEqual(M.makeUpWorkdaysBetween("uk", D("2026-01-01"), D("2026-12-31")), []);
});

/* ------------------------------------------------------------------ beyond the published years */
test("expected marking beyond the published years; no data where no algorithm exists", () => {
  const by = (id, y) => { const g = {}; for (const h of M.yearHolidays(id, y)) (g[h.id] ||= []).push(h); return g; };
  // China 2027: statutory days only; lunisolar ones expected, Gregorian ones certain.
  const cn = by("cn", 2027);
  assert.deepEqual(cn["spring-festival"].map((h) => h.iso), ["2027-02-05", "2027-02-06", "2027-02-07", "2027-02-08"], "eve and days 1–3 (lunar New Year 6 February)");
  for (const id of ["spring-festival", "qingming", "dragon-boat", "mid-autumn"]) assert.ok(cn[id].every((h) => h.predicted && h.note === M.LUNISOLAR_NOTE), id);
  assert.deepEqual([cn.qingming[0].iso, cn["dragon-boat"][0].iso, cn["mid-autumn"][0].iso], ["2027-04-05", "2027-06-09", "2027-09-15"]);
  for (const id of ["new-year", "labour-day", "national-day"]) assert.ok(cn[id].every((h) => !h.predicted), id);
  assert.deepEqual(cn["national-day"].map((h) => h.iso), ["2027-10-01", "2027-10-02", "2027-10-03"]);
  // A predicted holiday makes a business-day answer uncertain.
  assert.equal(B.marketStatus(D("2027-02-08"), "cn").uncertain, true);
  // Singapore 2028: Chinese New Year computed, Hari Raya predicted from Umm al-Qura, Vesak and Deepavali absent.
  const sg = by("sg", 2028);
  assert.deepEqual(sg["chinese-new-year"].map((h) => [h.iso, h.predicted]), [["2028-01-26", true], ["2028-01-27", true]]);
  assert.ok(sg["eid-al-fitr"].every((h) => h.predicted && h.note === M.PREDICTED_NOTE));
  assert.ok(sg["eid-al-adha"].every((h) => h.predicted));
  assert.equal(sg["vesak-day"], undefined); assert.equal(sg.deepavali, undefined);
  assert.ok(sg["new-year"].every((h) => !h.predicted));
  // India 2027: fixed holidays certain, Islamic ones predicted, festivals with no algorithm absent.
  const ind = by("in", 2027);
  for (const id of ["eid-al-fitr", "eid-al-adha", "muharram", "mawlid"]) assert.ok(ind[id]?.length && ind[id].every((h) => h.predicted), id);
  for (const id of ["republic-day", "independence-day", "gandhi-jayanti", "good-friday", "annual-closing"]) assert.ok(ind[id].every((h) => !h.predicted), id);
  for (const id of ["holi", "gudhi-padwa", "ram-navami", "mahavir-jayanti", "buddha-pournima", "ganesh-chaturthi", "dasara", "diwali-bali-pratipada", "guru-nanak-jayanti"]) assert.equal(ind[id], undefined, id);
  // A Hijri rule in a published year keeps the UID key of its prediction (the Hijri year).
  assert.equal(M.yearHolidays("in", 2026).find((h) => h.id === "eid-al-fitr").hijriYear, 1447);
  // Australia: rules only, nothing predicted in any year.
  assert.ok([2030, 2040, 2099].every((y) => M.yearHolidays("au", y).every((h) => !h.predicted)));
});

/* ------------------------------------------------------------------ the Chinese calendar */
test("Chinese lunisolar calendar (Hong Kong Observatory tables)", () => {
  // Lunar New Year, from the HKO conversion tables and the State Council notices.
  const cny = { 1901: "1901-02-19", 1985: "1985-02-20", 2000: "2000-02-05", 2024: "2024-02-10", 2025: "2025-01-29", 2026: "2026-02-17", 2027: "2027-02-06", 2028: "2028-01-26", 2033: "2033-01-31", 2099: "2099-01-21" };
  for (const [y, iso] of Object.entries(cny)) assert.equal(C.toISO(L.lunarNewYear(+y)), iso, y);
  assert.deepEqual(L.LUNAR_RANGE, { from: 1901, to: 2099 });
  assert.equal(L.leapMonth(2025), 6); assert.equal(L.leapMonth(2026), 0); assert.equal(L.leapMonth(2033), 11);
  assert.equal(L.lunarMonths(2025).length, 13);
  assert.equal(C.toISO(L.fromLunar(2025, 6, 1, { leap: true })), "2025-07-25");
  assert.equal(L.fromLunar(2026, 6, 1, { leap: true }), null);
  assert.equal(C.toISO(L.fromLunar(2025, 12, "last")), "2026-02-16", "Spring Festival eve 2026");
  assert.equal(L.fromLunar(1900, 1, 1), null); assert.equal(L.fromLunar(2100, 5, 5), null);
  assert.deepEqual([2025, 2026, 2027, 2028].map((y) => C.toISO(L.qingming(y))), ["2025-04-04", "2026-04-05", "2027-04-05", "2028-04-04"]);
  // fromLunar and toLunar are inverse over the whole table.
  for (let n = L.lunarNewYear(1901); n < L.lunarNewYear(2100); n += 13) {
    const l = L.toLunar(n);
    assert.equal(L.fromLunar(l.ly, l.lm, l.ld, { leap: l.leap }), n, C.toISO(n));
  }
});

/* ------------------------------------------------------------------ profiles, packs, feeds */
test("APAC profiles: time zones, weekends, data versions, sources and packs", () => {
  const tz = { in: "Asia/Kolkata", cn: "Asia/Shanghai", sg: "Asia/Singapore", au: "Australia/Sydney" };
  for (const [id, zone] of Object.entries(tz)) {
    const m = M.market(id), p = M.holidayPack(id);
    assert.equal(m.timeZone, zone); assert.equal(M.MARKET_TIME_ZONES[id], zone);
    assert.deepEqual(M.weekendIsoOf(id, D("2026-10-01")), [6, 7]);
    assert.equal(m.dataVersion, `${id}-2026.10.01`); assert.equal(p.dataVersion, `${id}-2026.10.01`);
    assert.ok(p.sourceUrls.length && p.sourceUrls.every((u) => u.startsWith("https://")), id);
    assert.ok(p.holidays.every((h) => h.checked === "2026-10-01"), id);
  }
  assert.equal(M.market("in").name.en, "India (Mumbai, RBI NI Act bank holidays)");
  assert.equal(M.market("au").name.en, "Australia (New South Wales)");
  assert.deepEqual(M.holidayPack("cn").published, [2025, 2026]);
  assert.deepEqual(M.holidayPack("sg").published, [2025, 2026, 2027]);
  assert.equal(M.holidayPack("cn").workdays.length, 11);
  assert.equal(M.holidayPack("cn").coverage.to, 2099);
  assert.ok(M.holidayPack("in").coverage.basis.some((b) => b.startsWith("no data outside the published years for: mahashivratri, holi")));
  assert.equal(M.holidayPack("au").published, undefined);
  assert.equal(M.holidayPack("sg").holidays.find((h) => h.id === "chinese-new-year").predicted, true);
  assert.deepEqual(M.holidayPack("sg").holidays.find((h) => h.id === "vesak-day"), { id: "vesak-day", kind: "table", title: { en: "Vesak Day", ar: "يوم فيساك" }, predicted: false, source: "https://www.mom.gov.sg/employment-practices/public-holidays", checked: "2026-10-01", published: [2025, 2026, 2027] });
});

test("feeds: RFC-valid for each new market; make-up days, EXDATEs and expected events", () => {
  for (const id of ["in", "cn", "sg", "au"]) for (const locale of ["en", "ar"]) for (const [from, to] of [[2025, 2027], [2028, 2030]]) {
    const ev = assertValidIcs(marketIcs(id, { from, to, locale, weekends: true, uidPrefix: "acme-", domain: "acme.example" }), `${id}/${locale}/${from}`);
    assert.ok(ev.length > 0);
  }
  const t = marketIcs("cn", { from: 2026, to: 2027, weekends: true, uidPrefix: "x-", domain: "example.org" });
  const ev = events(t);
  const work = ev.filter((e) => e.CATEGORIES === "WORKDAY,OFFICIAL");
  assert.deepEqual(work.map((e) => e["DTSTART;VALUE=DATE"]), ["20260104", "20260214", "20260228", "20260509", "20260920", "20261010"]);
  assert.equal(work[1].SUMMARY, "Working day (make-up for Spring Festival)");
  assert.equal(work[1].UID, "x-cn-20260214-workday@example.org");
  assert.equal(work[1].STATUS, "CONFIRMED");
  const wk = ev.find((e) => e.CATEGORIES === "WEEKEND");
  assert.equal(wk["EXDATE;VALUE=DATE"], "20260104,20260214,20260228,20260509,20260920,20261010");
  // Published days are confirmed and announced; computed ones tentative and "(expected)".
  const sf26 = ev.find((e) => e["DTSTART;VALUE=DATE"] === "20260217");
  assert.deepEqual([sf26.SUMMARY, sf26.STATUS, sf26.SEQUENCE], ["Spring Festival", "CONFIRMED", "1"]);
  assert.match(sf26.DESCRIPTION, /content_7047091/);
  const sf27 = ev.find((e) => e["DTSTART;VALUE=DATE"] === "20270206");
  assert.deepEqual([sf27.SUMMARY, sf27.STATUS], ["Spring Festival (expected)", "TENTATIVE"]);
  assert.match(sf27.DESCRIPTION, /Chinese lunisolar calendar/);
  // workdays: false leaves the events out; feeds of markets without make-up days carry none.
  assert.ok(!unfold(marketIcs("cn", { from: 2026, workdays: false })).includes("WORKDAY"));
  assert.ok(!unfold(marketIcs("au", { from: 2026, weekends: true })).includes("EXDATE"));
  // Australia: substitute days labelled, everything confirmed.
  const au = events(marketIcs("au", { from: 2027 }));
  assert.ok(au.some((e) => e.SUMMARY === "Boxing Day (substitute day)" && e["DTSTART;VALUE=DATE"] === "20271228"));
  assert.ok(au.every((e) => e.STATUS === "CONFIRMED"));
});
