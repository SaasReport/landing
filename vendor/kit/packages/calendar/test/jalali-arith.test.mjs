/* Solar Hijri is arithmetic in @saasreport/calendar: no runtime ICU, so a skewed ICU (Workers put Nowruz 1405 a day early)
   cannot move a date. */
import test from "node:test";
import assert from "node:assert/strict";

test("toJalali and nowruz ignore a skewed ICU Persian calendar", async () => {
  const Real = Intl.DateTimeFormat;
  // Stand-in for a broken runtime: every Persian-calendar formatter is a day ahead.
  globalThis.Intl.DateTimeFormat = function (loc, opts) {
    const f = new Real(loc, opts);
    if (!/ca-persian/.test(String(loc))) return f;
    return { formatToParts: (d) => f.formatToParts(new Date(+d + 86400000)), format: (d) => f.format(new Date(+d + 86400000)), resolvedOptions: () => f.resolvedOptions() };
  };
  try {
    const C = await import(`../src/index.js?skewed-icu=${Date.now()}`);
    const at = (iso) => { const j = C.toJalali(C.fromISO(iso)); return `${j.jy}/${j.jm}/${j.jd}`; };
    assert.equal(at("2026-03-21"), "1405/1/1");
    assert.equal(at("2026-03-20"), "1404/12/29");
    assert.equal(at("2026-10-03"), "1405/7/11");
    assert.equal(C.toISO(C.nowruz(1405)), "2026-03-21");
  } finally {
    globalThis.Intl.DateTimeFormat = Real;
  }
});

test("Nowruz dates match the published Iranian calendar", async () => {
  const C = await import("../src/index.js");
  const known = { 1399: "2020-03-20", 1400: "2021-03-21", 1401: "2022-03-21", 1402: "2023-03-21", 1403: "2024-03-20", 1404: "2025-03-21", 1405: "2026-03-21", 1406: "2027-03-21", 1407: "2028-03-20" };
  for (const [jy, iso] of Object.entries(known)) assert.equal(C.toISO(C.nowruz(+jy)), iso, `Nowruz ${jy}`);
  assert.equal(C.isLeap(1403), true);
  assert.equal(C.isLeap(1404), false);
});

test("every day in RANGE round-trips through fromJalali", async () => {
  const C = await import("../src/index.js");
  for (let n = C.nowruz(C.RANGE.min); n < C.nowruz(C.RANGE.max); n++) {
    const j = C.toJalali(n);
    assert.equal(C.fromJalali(j.jy, j.jm, j.jd), n);
  }
});
