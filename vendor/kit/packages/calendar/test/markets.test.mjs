import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../src/index.js";
import * as H from "../src/hijri.js";
import * as M from "../src/markets.js";
import * as B from "../src/business.js";
import * as L from "../src/locale.js";
import { resolveCalendarConfig, createCalendar } from "../src/config.js";

const D = (iso) => C.fromISO(iso);
const iso = (n) => C.toISO(n);
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* ------------------------------------------------------------------ Hijri */
test("Umm al-Qura: official month starts", () => {
  // Official Umm al-Qura dates (KACST table; the same days Saudi Arabia announced).
  const known = [
    [1445, 9, 1, "2024-03-11"], [1446, 9, 1, "2025-03-01"], [1446, 10, 1, "2025-03-30"],
    [1447, 1, 1, "2025-06-26"], [1447, 9, 1, "2026-02-18"], [1447, 10, 1, "2026-03-20"],
    [1447, 12, 10, "2026-05-27"], [1448, 1, 1, "2026-06-16"], [1448, 3, 12, "2026-08-25"],
    [1300, 1, 1, "1882-11-12"],
  ];
  for (const [hy, hm, hd, g] of known) {
    assert.equal(iso(H.fromHijri(hy, hm, hd)), g, `${hd}/${hm}/${hy}`);
    assert.deepEqual(H.toHijri(D(g)), { hy, hm, hd }, g);
  }
  assert.equal(H.hijriMonthLength(1447, 9), 30); // Ramadan 1447: 18 Feb – 19 Mar 2026
  assert.equal(H.hasUmmAlQura(), true);
});

test("Umm al-Qura: the whole AH 1300–1600 table is consistent; outside it throws", () => {
  let prevEnd = null;
  for (let hy = 1300; hy <= 1600; hy++) {
    const len = H.hijriYearLength(hy);
    assert.ok(len === 354 || len === 355 || len === 353 || len === 356, `${hy}: ${len}`);
    const first = H.fromHijri(hy, 1, 1);
    if (prevEnd != null) assert.equal(first, prevEnd + 1, `${hy} follows ${hy - 1}`);
    prevEnd = H.fromHijri(hy, 12, "last");
  }
  assert.throws(() => H.toHijri(H.fromHijri(1300, 1, 1) - 1), { code: "out_of_range" });
  assert.throws(() => H.fromHijri(1601, 1, 1), { code: "out_of_range" });
  assert.throws(() => H.fromHijri(1447, 2, 30), { code: "invalid_date" }); // Safar 1447 has 29 days
  assert.equal(H.tryFromHijri(1447, 2, 30), null);
  assert.throws(() => H.toHijri(0, "lunar"), { code: "invalid_variant" });
});

test("civil (tabular) Hijri matches ICU islamic-civil and round-trips", () => {
  const f = new Intl.DateTimeFormat("en-u-ca-islamic-civil-nu-latn", { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric" });
  for (let n = -30000; n < 60000; n += 97) {
    const o = {};
    for (const p of f.formatToParts(new Date(n * 86400000 + 43200000))) if (p.type !== "literal") o[p.type] = +p.value;
    const h = H.toHijri(n, "civil");
    assert.deepEqual([h.hy, h.hm, h.hd], [o.year, o.month, o.day], iso(n));
    assert.equal(H.fromHijri(h.hy, h.hm, h.hd, "civil"), n);
  }
  // index.js (Iran) keeps its own islamic-civil reading
  assert.deepEqual(C.toHijri(D("2026-02-18")), (({ hy, hm, hd }) => ({ hy, hm, hd }))(H.toHijri(D("2026-02-18"), "civil")));
});

/* ------------------------------------------------------------------ weekends */
test("weekends per market", () => {
  const week = (id, at = "2026-09-27") => { const s = D(at); return [0, 1, 2, 3, 4, 5, 6].filter((i) => M.isWeekend(id, s + i)).map((i) => M.dow(s + i)).sort().map((d) => DOW[d]); };
  for (const id of ["sa", "bh", "qa", "kw", "om"]) assert.deepEqual(week(id), ["Fri", "Sat"], id);
  for (const id of ["ae", "my", "id", "pk", "tr", "uk", "us", "eu"]) assert.deepEqual(week(id), ["Sun", "Sat"], id);
  assert.deepEqual(week("ae", "2021-12-19"), ["Fri", "Sat"], "UAE before 2022");
  assert.deepEqual(week("ae", "2022-01-02"), ["Sun", "Sat"], "UAE from 1 January 2022");
  assert.deepEqual(week("ir"), ["Fri"]);
  assert.deepEqual(week("ir:government"), ["Thu", "Fri"]);
  assert.deepEqual(week("ir:market"), ["Thu", "Fri"]);
});

/* ------------------------------------------------------------------ holidays vs official lists */
test("UK: bank holidays equal GOV.UK (England and Wales) 2019–2028", () => {
  const govuk = ["2019-01-01", "2019-04-19", "2019-04-22", "2019-05-06", "2019-05-27", "2019-08-26", "2019-12-25", "2019-12-26", "2020-01-01", "2020-04-10", "2020-04-13", "2020-05-08", "2020-05-25", "2020-08-31", "2020-12-25", "2020-12-28", "2021-01-01", "2021-04-02", "2021-04-05", "2021-05-03", "2021-05-31", "2021-08-30", "2021-12-27", "2021-12-28", "2022-01-03", "2022-04-15", "2022-04-18", "2022-05-02", "2022-06-02", "2022-06-03", "2022-08-29", "2022-09-19", "2022-12-26", "2022-12-27", "2023-01-02", "2023-04-07", "2023-04-10", "2023-05-01", "2023-05-08", "2023-05-29", "2023-08-28", "2023-12-25", "2023-12-26", "2024-01-01", "2024-03-29", "2024-04-01", "2024-05-06", "2024-05-27", "2024-08-26", "2024-12-25", "2024-12-26", "2025-01-01", "2025-04-18", "2025-04-21", "2025-05-05", "2025-05-26", "2025-08-25", "2025-12-25", "2025-12-26", "2026-01-01", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25", "2026-08-31", "2026-12-25", "2026-12-28", "2027-01-01", "2027-03-26", "2027-03-29", "2027-05-03", "2027-05-31", "2027-08-30", "2027-12-27", "2027-12-28", "2028-01-03", "2028-04-14", "2028-04-17", "2028-05-01", "2028-05-29", "2028-08-28", "2028-12-25", "2028-12-26"];
  const closedWeekdays = [];
  for (let n = D("2019-01-01"); n <= D("2028-12-31"); n++) if (!M.isWeekend("uk", n) && !B.isBusinessDay(n, "uk")) closedWeekdays.push(iso(n));
  assert.deepEqual(closedWeekdays, govuk);
});

test("US: Federal Reserve K.8 holidays 2026–2030, Sunday → Monday, Saturday stays", () => {
  const k8 = {
    2026: ["01-01", "01-19", "02-16", "05-25", "06-19", "09-07", "10-12", "11-11", "11-26", "12-25"],
    2027: ["01-01", "01-18", "02-15", "05-31", "07-05", "09-06", "10-11", "11-11", "11-25"],
    2028: ["01-17", "02-21", "05-29", "06-19", "07-04", "09-04", "10-09", "11-23", "12-25"],
    2029: ["01-01", "01-15", "02-19", "05-28", "06-19", "07-04", "09-03", "10-08", "11-12", "11-22", "12-25"],
    2030: ["01-01", "01-21", "02-18", "05-27", "06-19", "07-04", "09-02", "10-14", "11-11", "11-28", "12-25"],
  };
  for (const [y, days] of Object.entries(k8)) {
    const closed = [];
    for (let n = D(`${y}-01-01`); n <= D(`${y}-12-31`); n++) if (!M.isWeekend("us", n) && !B.isBusinessDay(n, "us")) closed.push(iso(n).slice(5));
    assert.deepEqual(closed, days, y);
  }
  assert.equal(B.isBusinessDay(D("2026-07-03"), "us"), true, "4 July 2026 is a Saturday: Reserve Banks open on Friday");
});

test("euro area: T2 closing days", () => {
  const closed = [];
  for (let n = D("2026-01-01"); n <= D("2027-12-31"); n++) if (!M.isWeekend("eu", n) && !B.isBusinessDay(n, "eu")) closed.push(iso(n));
  assert.deepEqual(closed, ["2026-01-01", "2026-04-03", "2026-04-06", "2026-05-01", "2026-12-25", "2027-01-01", "2027-03-26", "2027-03-29"]);
});

test("Bahrain: equals the CBB 2026 bank-holiday list; Islamic days predicted", () => {
  const cbb = ["2026-01-01", "2026-03-20", "2026-03-21", "2026-03-22", "2026-05-01", "2026-05-27", "2026-05-28", "2026-05-29", "2026-06-16", "2026-06-24", "2026-06-25", "2026-08-25", "2026-12-16", "2026-12-17"];
  const hs = M.yearHolidays("bh", 2026);
  assert.deepEqual(hs.map((h) => h.iso), cbb);
  for (const h of hs) {
    const islamic = !["new-year", "labour-day", "national-day"].includes(h.id);
    assert.equal(h.predicted, islamic, `${h.iso} ${h.id}`);
    if (islamic) assert.match(h.note.en, /moon sighting or official announcement/);
  }
});

test("UAE, Oman, Türkiye, Pakistan, Malaysia, Saudi: rules from their sources", () => {
  const ids = (id, y) => M.yearHolidays(id, y).map((h) => `${h.iso} ${h.id}${h.half ? " half" : ""}${h.observed ? " observed" : ""}`);
  assert.deepEqual(ids("ae", 2026), [
    "2026-01-01 new-year", "2026-03-19 eid-al-fitr-30-ramadan", "2026-03-20 eid-al-fitr", "2026-03-21 eid-al-fitr", "2026-03-22 eid-al-fitr",
    "2026-05-26 arafah", "2026-05-27 eid-al-adha", "2026-05-28 eid-al-adha", "2026-05-29 eid-al-adha", "2026-06-16 islamic-new-year",
    "2026-08-25 mawlid", "2026-12-02 national-day", "2026-12-03 national-day",
  ]);
  // 30 Ramadan only when Ramadan has 30 days (1446: 29 days)
  assert.equal(H.hijriMonthLength(1446, 9), 29);
  assert.ok(!ids("ae", 2025).some((s) => s.includes("30-ramadan")));
  // Oman: 29 Ramadan – 3 Shawwal, 9–12 Dhu al-Hijjah, National Day moved to 20–21 November in 2025
  const om = ids("om", 2026);
  assert.ok(om.includes("2026-03-18 eid-al-fitr") && om.includes("2026-03-22 eid-al-fitr") && om.includes("2026-11-20 national-day") && om.includes("2026-11-21 national-day"));
  assert.ok(ids("om", 2024).includes("2024-11-18 national-day"));
  // Türkiye: eves are half days and stay business days
  const tr = ids("tr", 2026);
  assert.ok(tr.includes("2026-10-28 republic-day-eve half") && tr.includes("2026-05-26 eid-al-adha-eve half") && tr.includes("2026-05-30 eid-al-adha"));
  assert.equal(B.isBusinessDay(D("2026-10-28"), "tr"), true);
  assert.equal(B.dayStatus(D("2026-10-28"), "tr").half, true);
  assert.equal(B.isBusinessDay(D("2026-10-29"), "tr"), false);
  // Pakistan: last Friday of Ramadan, Youm-e-Takbeer since 2024
  assert.ok(ids("pk", 2026).includes("2026-03-13 last-friday-ramadan"));
  assert.ok(!ids("pk", 2023).some((s) => s.includes("takbeer")) && ids("pk", 2024).includes("2024-05-28 youm-e-takbeer"));
  // Malaysia: Sunday holiday moves to Monday (Federal Territory Day 2026)
  assert.ok(ids("my", 2026).includes("2026-02-02 federal-territory-day observed"));
  assert.equal(B.isBusinessDay(D("2026-02-02"), "my"), false);
  // Saudi: Founding Day from 2022
  assert.ok(ids("sa", 2026).includes("2026-02-22 founding-day") && !ids("sa", 2021).some((s) => s.includes("founding")));
});

test("profiles: status, sources and unverified profiles carry only predicted Islamic holidays", () => {
  const status = Object.fromEntries(M.markets().filter((m) => !m.iran).map((m) => [m.id, m.status]));
  assert.deepEqual(status, { sa: "partial", ae: "verified", bh: "verified", qa: "unverified", kw: "unverified", om: "verified", my: "partial", id: "unverified", pk: "verified", tr: "verified", uk: "verified", us: "verified", eu: "verified", in: "partial", cn: "partial", sg: "partial", au: "verified" });
  for (const m of M.markets()) {
    if (m.iran) continue;
    if (m.status === "unverified") {
      assert.ok(m.holidays.every((r) => r.kind === "hijri"), m.id);
      for (let y = 2025; y <= 2027; y++) assert.ok(M.yearHolidays(m.id, y).every((h) => h.predicted), `${m.id} ${y}`);
    } else {
      assert.ok(m.sources.length && m.sources.every((s) => /^https:\/\//.test(s.url)), m.id);
      assert.ok(m.holidays.every((r) => /^https:\/\//.test(r.source)), `${m.id}: every rule cites a source`);
    }
  }
});

test("registerOfficial replaces a prediction with announced dates", () => {
  M.registerMarket({ ...M.market("pk"), id: "pk-test" });
  assert.deepEqual(M.yearHolidays("pk-test", 2026).filter((h) => h.id === "eid-al-fitr").map((h) => h.iso), ["2026-03-20", "2026-03-21", "2026-03-22"]);
  M.registerOfficial("pk-test", { 1447: { "eid-al-fitr": ["2026-03-21", "2026-03-22", "2026-03-23"] } });
  const eid = M.yearHolidays("pk-test", 2026).filter((h) => h.id === "eid-al-fitr");
  assert.deepEqual(eid.map((h) => [h.iso, h.predicted]), [["2026-03-21", false], ["2026-03-22", false], ["2026-03-23", false]]);
  assert.equal(B.isBusinessDay(D("2026-03-20"), "pk-test"), true);
});

/* ------------------------------------------------------------------ business-day maths */
test("T+2 in a Friday–Saturday market, a Saturday–Sunday market and across both", () => {
  const thu = D("2026-10-01");
  assert.equal(iso(B.addBusinessDays(thu, 2, "sa").date), "2026-10-05"); // Sun 4, Mon 5
  assert.equal(iso(B.addBusinessDays(thu, 2, "ae").date), "2026-10-05"); // Fri 2, Mon 5
  assert.equal(iso(B.addBusinessDays(thu, 1, "sa").date), "2026-10-04");
  assert.equal(iso(B.addBusinessDays(thu, 1, "ae").date), "2026-10-02");
  const both = B.settlement(thu, ["sa", "ae"], { t: 2 });
  assert.equal(both.iso, "2026-10-06"); // Fri (SA), Sat (both), Sun (AE) closed → Mon 5, Tue 6
  assert.equal(both.t, 2);
  assert.equal(both.uncertain, false);
  // SAR/USD corridor across Saudi National Day
  assert.equal(B.settlement(D("2026-09-21"), ["sa", "us"], { t: 2 }).iso, "2026-09-24");
  // a predicted UAE holiday on a working day makes the answer uncertain
  const eid = B.settlement(D("2026-03-17"), "ae", { t: 2 });
  assert.equal(eid.iso, "2026-03-23");
  assert.equal(eid.uncertain, true);
});

test("official settlement cycles; business days in a range; month-end", () => {
  assert.equal(M.settlementCycle("us", D("2024-05-27")).t, 2);
  assert.equal(M.settlementCycle("us", D("2024-05-28")).t, 1);
  assert.equal(M.settlementCycle("uk", D("2027-10-08")).t, 2);
  assert.equal(M.settlementCycle("eu", D("2027-10-11")).t, 1);
  assert.equal(M.settlementCycle("sa", D("2026-10-01")), null);
  assert.equal(B.settlement(D("2026-12-23"), ["uk", "eu"]).iso, "2026-12-29"); // T+2; 25, 26 (EU), 28 (UK) closed
  assert.throws(() => B.settlement(D("2026-10-01"), ["sa", "us"]), { code: "no_cycle" });

  const r = B.businessDaysBetween(D("2026-09-20"), D("2026-09-30"), ["sa", "us"]);
  assert.equal(r.business, 6); // 21, 22, 24, 28, 29, 30
  assert.deepEqual(r.closed.filter((c) => c.closed.length === 1).map((c) => [c.iso, c.closed[0]]), [["2026-09-23", "sa"], ["2026-09-25", "sa"], ["2026-09-27", "us"]]);
  assert.deepEqual(B.businessDays(D("2026-09-20"), D("2026-09-24"), ["sa", "us"]).map(iso), ["2026-09-21", "2026-09-22", "2026-09-24"]);
  assert.equal(B.businessDaysBetween(D("2026-09-30"), D("2026-09-20"), ["sa", "us"]).business, -6);

  assert.equal(B.monthEnd(D("2026-10-10"), "sa").iso, "2026-10-29"); // 30 Fri, 31 Sat
  assert.equal(B.monthEnd(D("2026-10-10"), "ae").iso, "2026-10-30");
  assert.equal(B.monthEnd(D("2026-10-10"), ["sa", "ae"]).iso, "2026-10-29");
  assert.equal(B.monthEnd(D("2026-12-01"), ["uk", "eu"]).iso, "2026-12-31");
  // month-end of Ramadan 1447 (Umm al-Qura month)
  assert.equal(B.monthEnd(D("2026-03-01"), "sa", { system: "hijri-umalqura" }).iso, "2026-03-19");
  assert.equal(iso(B.adjust(D("2026-10-31"), "modified_following", "sa").date), "2026-10-29");
});

/* ------------------------------------------------------------------ Iran unchanged */
test("Iran through the markets API gives exactly the engine's answers", () => {
  const from = C.fromJalali(1404, 1, 1), to = C.fromJalali(1405, 12, 29);
  for (const [id, profile] of [["ir", "bank"], ["ir:government", "government"], ["ir:market", "market"]]) {
    for (let n = from; n <= to; n++) {
      const s = C.dayStatus(n, { profile }), b = B.marketStatus(n, id);
      assert.deepEqual([b.open, b.weekend, b.holiday, b.uncertain], [s.business, s.weekend, s.holiday, s.uncertain], `${id} ${iso(n)}`);
      if (n % 4 === 0) {
        const a = C.settlement(n, 2, { profile }), m = B.addBusinessDays(n, 2, id);
        assert.deepEqual([m.date, m.moved, m.uncertain], [a.date, a.moved, a.uncertain]);
        for (const c of Object.keys(C.CONVENTIONS)) { const x = C.adjust(n, c, { profile }), y = B.adjust(n, c, id); assert.deepEqual([y.date, y.moved, y.uncertain], [x.date, x.moved, x.uncertain], `${c} ${iso(n)}`); }
      }
    }
  }
  const nowruz = M.yearHolidays("ir", 2026).filter((h) => h.iso === "2026-03-21");
  assert.ok(nowruz.some((h) => h.title.fa === "جشن نوروز" && !h.predicted));
});

/* ------------------------------------------------------------------ locale */
test("Arabic and English names: Hijri, Gregorian (Gulf and Levant), weekdays", () => {
  assert.deepEqual(L.monthNames("hijri-umalqura", "en"), ["Muharram", "Safar", "Rabi al-Awwal", "Rabi al-Thani", "Jumada al-Ula", "Jumada al-Akhirah", "Rajab", "Sha'ban", "Ramadan", "Shawwal", "Dhu al-Qa'dah", "Dhu al-Hijjah"]);
  assert.deepEqual(L.monthNames("hijri-umalqura", "ar"), ["محرم", "صفر", "ربيع الأول", "ربيع الآخر", "جمادى الأولى", "جمادى الآخرة", "رجب", "شعبان", "رمضان", "شوال", "ذو القعدة", "ذو الحجة"]);
  assert.deepEqual(L.monthNames("hijri-civil", "ar"), L.monthNames("hijri", "ar"));
  const gulf = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
  assert.deepEqual(L.monthNames("gregorian", "ar"), gulf);
  assert.deepEqual(L.monthNames("gregorian", "ar", { variant: "gulf" }), gulf);
  assert.deepEqual(L.monthNames("gregorian", "ar", { variant: "levant" }), ["كانون الثاني", "شباط", "آذار", "نيسان", "أيار", "حزيران", "تموز", "آب", "أيلول", "تشرين الأول", "تشرين الثاني", "كانون الأول"]);
  assert.throws(() => L.monthNames("gregorian", "ar", { variant: "maghreb" }));
  assert.equal(L.monthNames("gregorian", "en")[1], "February");
  assert.deepEqual(L.weekdayNames("ar"), ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"]);
  assert.deepEqual(L.weekdayNames("en", { start: 1, style: "short" }), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  assert.deepEqual(L.weekdayNames("ar", { start: 6 })[0], "السبت");
});

test("formatting: '1 Ramadan 1447 AH', «١ رمضان ١٤٤٧ هـ», digits, both calendars at once", () => {
  const n = D("2026-02-18");
  assert.equal(L.formatDate(n, { system: "hijri-umalqura" }), "1 Ramadan 1447 AH");
  assert.equal(L.formatDate(n, { system: "hijri-umalqura", locale: "ar" }), "١ رمضان ١٤٤٧ هـ");
  assert.equal(L.formatDate(n, { system: "hijri-umalqura", locale: "ar", digits: "latin" }), "1 رمضان 1447 هـ");
  assert.equal(L.formatDate(n, { system: "hijri", locale: "en", digits: "arabic" }), "١ Ramadan ١٤٤٧ AH");
  assert.equal(L.formatDate(n), "18 February 2026");
  assert.equal(L.formatDate(n, { weekday: true }), "Wednesday, 18 February 2026");
  assert.equal(L.formatDate(n, { locale: "ar", weekday: true }), "الأربعاء ١٨ فبراير ٢٠٢٦");
  assert.equal(L.formatDate(n, { locale: "ar", variant: "levant" }), "١٨ شباط ٢٠٢٦");
  assert.equal(L.formatDual(n).text, "18 February 2026 (1 Ramadan 1447 AH)");
  assert.equal(L.formatDual(n, { locale: "ar" }).text, "١٨ فبراير ٢٠٢٦ (١ رمضان ١٤٤٧ هـ)");
  assert.equal(L.formatDual(n, { primary: "hijri-umalqura" }).text, "1 Ramadan 1447 AH (18 February 2026)");
  assert.equal(L.monthTitle("hijri-umalqura", 1447, 9, { locale: "ar" }), "رمضان ١٤٤٧ هـ");
  assert.equal(L.toDigits("2026-02-18", "arabic"), "٢٠٢٦-٠٢-١٨");
  assert.deepEqual(L.monthSpan("hijri-umalqura", 1447, 9), { first: n, length: 30 });
  // a site locale pack: its names, digits and suffix win
  const pack = { code: "ar", digits: "latin", hijriSuffix: " هجري", months: { hijri: L.monthNames("hijri", "ar") } };
  assert.equal(L.formatDate(n, { system: "hijri-umalqura", pack }), "1 رمضان 1447 هجري");
});

test("holiday names in English and Arabic", () => {
  for (const m of M.markets()) {
    if (m.iran) continue;
    for (const y of [2020, 2022, 2026]) for (const h of M.yearHolidays(m.id, y)) {
      assert.ok(h.title.en && h.title.ar, `${m.id} ${h.iso} ${h.id}`);
      assert.match(h.title.ar, /[؀-ۿ]/);
    }
  }
  const eid = M.yearHolidays("ae", 2026).find((h) => h.id === "eid-al-fitr");
  assert.equal(M.holidayTitle(eid, "en"), "Eid al-Fitr");
  assert.equal(M.holidayTitle(eid, "ar"), "عيد الفطر");
  assert.equal(eid.note.ar.length > 0, true);
});

/* ------------------------------------------------------------------ config */
test("calendar config: systems, profiles, primary; the legacy shape still resolves to Iran", () => {
  const r = resolveCalendarConfig({ systems: ["gregorian", "hijri-umalqura"], profiles: ["sa", "ae", "my", "us", "uk", "eu"], primary: "gregorian" });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.secondary, ["hijri-umalqura"]);
  assert.equal(r.profile, "sa");
  assert.deepEqual(resolveCalendarConfig({ system: "jalali", holidays: "iran" }).profiles, ["ir"]);
  assert.deepEqual(resolveCalendarConfig({}, { locale: "fa" }).systems, ["jalali"]);
  assert.deepEqual(resolveCalendarConfig({}, { locale: "ar" }).systems, ["gregorian", "hijri-umalqura"]);
  assert.deepEqual(resolveCalendarConfig({ systems: ["hijri"], primary: "hijri" }).systems, ["hijri-umalqura"]);
  const bad = resolveCalendarConfig({ systems: ["mayan"], profiles: ["xx"], primary: "jalali" });
  assert.equal(bad.problems.length, 3);

  const cal = createCalendar({ systems: ["gregorian", "hijri-umalqura"], profiles: ["sa", "us"] }, { locale: "ar" });
  assert.equal(cal.label(D("2026-02-18")).text, "١٨ فبراير ٢٠٢٦ (١ رمضان ١٤٤٧ هـ)");
  assert.equal(cal.settlement(D("2026-09-21"), { t: 2 }).iso, "2026-09-24");
  assert.equal(cal.isBusinessDay(D("2026-09-23")), false);
  assert.equal(cal.isBusinessDay(D("2026-09-23"), ["us"]), true);
  assert.ok(cal.holidays(2026).some((h) => h.profile === "us") && cal.holidays(2026).some((h) => h.profile === "sa"));
  assert.throws(() => createCalendar({ profiles: ["zz"] }));
  const legacy = createCalendar({ system: "jalali", holidays: "iran" }, { locale: "fa" });
  assert.equal(legacy.addBusinessDays(C.parseDate("1404/12/28"), 1).date, C.settlement(C.parseDate("1404/12/28"), 1).date);
});
