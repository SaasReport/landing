import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../src/index.js";
import * as P from "../src/picker.js";

const J = (y, m, d) => C.fromJalali(y, m, d);
const days = (mx) => mx.weeks.flat().filter(Boolean);

test("month matrix: Saturday-first weeks, 31/30/29/30-day months", () => {
  const cases = [
    [1405, 1, 31], [1405, 6, 31], [1405, 7, 30], [1405, 11, 30],
    [1404, 12, 29], [1405, 12, 29], [1403, 12, 30], [1408, 12, 30], // Esfand: 1403 and 1408 are leap
  ];
  for (const [jy, jm, len] of cases) {
    const m = P.monthMatrix(jy, jm);
    assert.equal(m.length, len, `${jy}/${jm}`);
    const ds = days(m);
    assert.equal(ds.length, len);
    assert.deepEqual(ds.map((c) => c.jd), Array.from({ length: len }, (_, i) => i + 1));
    assert.ok(m.weeks.every((w) => w.length === 7));
    // column index == weekday (0 = Saturday)
    m.weeks.forEach((w) => w.forEach((c, i) => c && assert.equal(c.weekday, i)));
    const lead = m.weeks[0].findIndex(Boolean);
    assert.equal(lead, C.weekday(J(jy, jm, 1)));
    assert.equal(m.weeks.length, Math.ceil((lead + len) / 7));
  }
  assert.equal(C.isLeap(1403), true);
  assert.equal(C.isLeap(1404), false);
  // Farvardin 1406 starts on Sunday (2027-03-21) → one padding cell
  assert.equal(P.monthMatrix(1406, 1).weeks[0][0], null);
  assert.equal(P.monthMatrix(1406, 1).weeks[0][1].jd, 1);
  assert.equal(P.monthMatrix(1405, 7).title, "مهر ۱۴۰۵");
});

test("month matrix marks holidays: official solid, lunar predicted", () => {
  const far = days(P.monthMatrix(1406, 1));
  for (const d of [1, 2, 3, 4, 12, 13]) {
    const c = far[d - 1];
    assert.equal(c.holiday, true, `Farvardin ${d}`);
    assert.equal(c.predicted, false);
    assert.equal(c.business, false);
  }
  assert.equal(far[4].holiday, false); // 5 Farvardin
  const esf = days(P.monthMatrix(1405, 12));
  assert.equal(esf[28].holidays[0].title, "روز ملی شدن صنعت نفت");
  const pred = esf.filter((c) => c.predicted);
  assert.ok(pred.length >= 1, "a predicted lunar holiday in Esfand 1405");
  assert.ok(pred.every((c) => c.holidays.every((h) => h.status === "predicted")));
});

test("weekend profiles and business-only / min / max disabling", () => {
  const thu = J(1405, 7, 9), fri = J(1405, 7, 10), sat = J(1405, 7, 11);
  assert.equal(C.WEEKDAYS[C.weekday(fri)], "جمعه");
  assert.equal(P.isDisabled(fri), false);
  assert.equal(P.isDisabled(fri, { businessOnly: true }), true);
  assert.equal(P.isDisabled(thu, { businessOnly: true, profile: "bank" }), false);
  assert.equal(P.isDisabled(thu, { businessOnly: true, profile: "government" }), true);
  assert.equal(P.isDisabled(sat, { businessOnly: true }), false);
  assert.equal(P.isDisabled(J(1406, 1, 2), { businessOnly: true }), true); // Nowruz
  const min = P.parseBound("۱۴۰۵/۰۷/۰۵"), max = P.parseBound("2026-10-01");
  assert.equal(min, J(1405, 7, 5));
  assert.equal(max, J(1405, 7, 9));
  assert.equal(P.isDisabled(J(1405, 7, 4), { min, max }), true);
  assert.equal(P.isDisabled(J(1405, 7, 5), { min, max }), false);
  assert.equal(P.isDisabled(J(1405, 7, 9), { min, max }), false);
  assert.equal(P.isDisabled(J(1405, 7, 10), { min, max }), true);
  assert.equal(P.parseBound(""), null);
  const gov = P.monthMatrix(1405, 7, { profile: "government", businessOnly: true });
  assert.deepEqual(gov.weekend, [5, 6]);
  assert.ok(days(gov).filter((c) => c.weekday === 5 || c.weekday === 6).every((c) => c.disabled && c.weekend));
  assert.ok(days(P.monthMatrix(1405, 7, { profile: "bank" })).filter((c) => c.weekday === 5).every((c) => !c.weekend));
});

test("range selection state", () => {
  let s = P.rangeSelect(null, 10);
  assert.deepEqual(s, { start: 10, end: null });
  s = P.rangeSelect(s, 15);
  assert.deepEqual(s, { start: 10, end: 15 });
  assert.deepEqual(P.rangeSelect(s, 20), { start: 20, end: null }); // third pick restarts
  assert.deepEqual(P.rangeSelect({ start: 10, end: null }, 4), { start: 4, end: 10 }); // earlier end swaps
  assert.deepEqual(P.rangeSelect({ start: 10, end: null }, 10), { start: 10, end: 10 });
  const a = J(1405, 7, 8), b = J(1405, 7, 12);
  const m = P.monthMatrix(1405, 7, { range: { start: a, end: b } });
  const ds = days(m);
  assert.deepEqual(ds.filter((c) => c.inRange).map((c) => c.jd), [9, 10, 11]);
  assert.deepEqual(ds.filter((c) => c.selected).map((c) => c.jd), [8, 12]);
  assert.equal(ds[7].rangeStart, true);
  assert.equal(ds[11].rangeEnd, true);
  // preview while choosing the end
  const pv = days(P.monthMatrix(1405, 7, { range: { start: a, end: null }, preview: a + 3 }));
  assert.deepEqual(pv.filter((c) => c.inRange).map((c) => c.jd), [9, 10]);
});

test("parse typed input: Persian, Arabic and Latin digits, ranges, partial months", () => {
  const n = J(1405, 7, 8);
  for (const s of ["1405/07/08", "۱۴۰۵/۰۷/۰۸", "١٤٠٥/٠٧/٠٨", "1405-7-8", "۱۴۰۵.۷.۸", " 1405/07/08 ", "2026-09-30"]) assert.deepEqual(P.parseInput(s), { date: n }, s);
  assert.deepEqual(P.parseInput("۱۴۰۵/۰۷/۰۸ – ۱۴۰۵/۰۷/۱۲"), { start: n, end: n + 4 });
  assert.deepEqual(P.parseInput("1405/07/12 تا 1405/07/08"), { start: n, end: n + 4 });
  assert.deepEqual(P.parseInput("۱۴۰۵/۱۲"), { jy: 1405, jm: 12, partial: true });
  assert.deepEqual(P.parseInput("1406/1/"), { jy: 1406, jm: 1, partial: true });
  for (const bad of ["", "abc", "1405/13/01", "1404/12/30", "1405/07", "2026-02-30", "1250/01/01", "1405/07/08 – x"]) {
    const r = P.parseInput(bad);
    assert.ok(r === null || r.partial, `${bad} → ${JSON.stringify(r)}`);
  }
  assert.equal(P.parseInput("1405/13"), null);
  assert.equal(P.parseInput("1404/12/30"), null); // 1404 is not leap
  assert.deepEqual(P.parseInput("1403/12/30"), { date: J(1403, 12, 30) });
});

test("keyboard model is RTL: ArrowLeft = next day", () => {
  const n = J(1405, 7, 8); // Wednesday (index 4)
  assert.equal(P.moveKey(n, "ArrowLeft"), n + 1);
  assert.equal(P.moveKey(n, "ArrowRight"), n - 1);
  assert.equal(P.moveKey(n, "ArrowDown"), n + 7);
  assert.equal(P.moveKey(n, "ArrowUp"), n - 7);
  assert.equal(P.moveKey(n, "ArrowLeft", { rtl: false }), n - 1);
  assert.equal(P.moveKey(n, "Home"), n - C.weekday(n));
  assert.equal(C.weekday(P.moveKey(n, "End")), 6);
  assert.equal(P.moveKey(n, "PageDown"), J(1405, 8, 8));
  assert.equal(P.moveKey(n, "PageUp"), J(1405, 6, 8));
  assert.equal(P.moveKey(n, "PageDown", { shift: true }), J(1406, 7, 8));
  assert.equal(P.moveKey(J(1405, 6, 31), "PageDown"), J(1405, 7, 30)); // clamped
  assert.equal(P.moveKey(J(1403, 12, 30), "PageDown", { shift: true }), J(1404, 12, 29));
  assert.equal(P.moveKey(n, "x"), null);
  assert.deepEqual(P.shiftMonth(1405, 12, 1), { jy: 1406, jm: 1 });
  assert.deepEqual(P.shiftMonth(1406, 1, -1), { jy: 1405, jm: 12 });
});

test("day detail carries business status, holidays and T+n settlement from the engine", () => {
  const n = J(1405, 12, 28);
  const d = P.dayDetail(n, { settlement: 1 });
  assert.equal(d.jalali, "1405/12/28");
  assert.equal(d.iso, C.toISO(n));
  assert.equal(d.business, false); // Friday
  const t1 = C.settlement(n, 1);
  assert.equal(d.settlement.iso, C.toISO(t1.date));
  assert.equal(d.settlement.long, C.describe(t1.date).jalali.long);
  assert.equal(d.settlement.long, "پنجشنبه ۵ فروردین ۱۴۰۶");
  assert.equal(P.dayDetail(J(1406, 1, 1)).holidays[0].title, "جشن نوروز");
  assert.equal("settlement" in P.dayDetail(n), false);
  assert.equal(P.formatJalali(n, { digits: "fa" }), "۱۴۰۵/۱۲/۲۸");
});

test("picker Hijri: Umm al-Qura by default, civil on request, civil where Umm al-Qura is unavailable", async () => {
  const { toHijri, hasUmmAlQura } = await import("../src/hijri.js");
  const n = C.fromISO("2026-10-07");
  const civil = toHijri(n, "civil");
  const civilText = `${C.fa(civil.hd)} ${C.H_MONTHS[civil.hm - 1]} ${C.fa(civil.hy)}`;
  assert.equal(P.dayDetail(n, { hijri: "civil" }).hijri, civilText);
  assert.equal(P.dayDetail(n, { hijri: "civil" }).hijriVariant, "civil");
  assert.equal(P.dayDetail(n, { hijri: "nonsense" }).hijriVariant, "umalqura");
  if (hasUmmAlQura()) {
    const uq = toHijri(n, "umalqura");
    assert.equal(P.dayDetail(n).hijri, `${C.fa(uq.hd)} ${C.H_MONTHS[uq.hm - 1]} ${C.fa(uq.hy)}`);
    assert.equal(P.dayDetail(n).hijriVariant, "umalqura");
    assert.equal(P.hijriLong(n), P.dayDetail(n).hijri);
    // the two methods differ on this day (the reason the default moved), and civil is still one call away
    assert.notEqual(P.hijriLong(n), P.hijriLong(n, "civil"));
  }
  // outside the Umm al-Qura table (AH 1300–1600) the picker falls back to civil instead of throwing
  const far = C.fromISO("1850-01-01");
  assert.equal(P.hijriLong(far), P.hijriLong(far, "civil"));
});
