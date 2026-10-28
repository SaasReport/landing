import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../src/index.js";
import * as H from "../src/hijri.js";
import { parseInput, parse, normalizeDigits } from "../src/parse.js";
import { Instant, ZonedDateTime } from "../src/time.js";

const D = (iso) => C.fromISO(iso);
const ok = (input, o) => { const r = parseInput(input, o); assert.equal(r.ok, true, `${input}: ${JSON.stringify(r.error)}`); return r; };
const err = (input, code, o) => { const r = parseInput(input, o); assert.equal(r.ok, false, `${input} should fail`); assert.equal(r.error.code, code, `${input}: ${r.error.message}`); assert.ok(r.error.message.length > 0); return r; };

test("parse: ISO dates (Gregorian)", () => {
  const r = ok("2026-09-30");
  assert.deepEqual({ kind: r.kind, system: r.system, day: r.day, iso: r.iso, parts: r.parts, weekday: r.weekday }, { kind: "date", system: "gregorian", day: D("2026-09-30"), iso: "2026-09-30", parts: { year: 2026, month: 9, day: 30 }, weekday: 3 });
  assert.equal(ok("2026/09/30").day, D("2026-09-30"));
  assert.equal(ok("٢٠٢٦-٠٩-٣٠").day, D("2026-09-30"), "Arabic-Indic digits");
  assert.equal(ok("‏2026-09-30‎").day, D("2026-09-30"), "bidi marks ignored");
  assert.equal(ok("2024-02-29").iso, "2024-02-29");
  err("2026-02-29", "invalid_date");
  err("2026-13-01", "invalid_date");
  err("2026-04-31", "invalid_date");
  assert.equal(ok(D("2026-09-30")).iso, "2026-09-30", "a day number passes through");
});

test("parse: ISO datetimes with offset (and zone suffix or option)", () => {
  const r = ok("2026-03-08T03:30:00-04:00");
  assert.equal(r.kind, "datetime");
  assert.ok(r.instant instanceof Instant && r.zoned instanceof ZonedDateTime);
  assert.equal(r.instant.toString(), "2026-03-08T07:30:00.000Z");
  assert.equal(r.offsetMinutes, -240);
  assert.equal(r.iso, "2026-03-08", "the date as written");
  assert.equal(r.timeZone, "UTC");
  assert.equal(ok("2026-03-08T07:30Z").instant.toString(), "2026-03-08T07:30:00.000Z");
  assert.equal(ok("2026-03-08 11:00+0330").instant.toString(), "2026-03-08T07:30:00.000Z");
  assert.equal(ok("2026-03-08T11:00:00.5+03:30").instant.toString(), "2026-03-08T07:30:00.500Z");
  assert.equal(ok("۲۰۲۶-۰۳-۰۸T۱۱:۰۰+۰۳:۳۰").instant.toString(), "2026-03-08T07:30:00.000Z", "Persian digits");
  // late evening with a negative offset: the written date, not the UTC date
  const late = ok("2026-03-08T23:30:00-05:00");
  assert.equal(late.iso, "2026-03-08");
  assert.equal(late.instant.toString(), "2026-03-09T04:30:00.000Z");
  // zone suffix: wall time in the zone; offset must agree
  const z = ok("2026-11-01T01:30:00[America/New_York]");
  assert.equal(z.zoned.toString(), "2026-11-01T01:30:00-04:00[America/New_York]");
  assert.equal(ok("2026-11-01T01:30:00-05:00[America/New_York]").zoned.toString(), "2026-11-01T01:30:00-05:00[America/New_York]");
  err("2026-03-08T12:00:00-05:00[America/New_York]", "offset_mismatch");
  err("2026-03-08T12:00:00[Nowhere/City]", "invalid_time_zone");
  // without an offset: only with options.timeZone (gap and fold disambiguation)
  err("2026-03-08T02:30:00", "missing_offset");
  assert.equal(ok("2026-03-08T02:30:00", { timeZone: "America/New_York" }).zoned.toString(), "2026-03-08T03:30:00-04:00[America/New_York]");
  err("2026-03-08T02:30:00", "nonexistent_time", { timeZone: "America/New_York", disambiguation: "reject" });
  err("2026-11-01T01:30:00", "ambiguous_time", { timeZone: "America/New_York", disambiguation: "reject" });
  assert.equal(ok("2021-06-01T08:00", { timeZone: "Asia/Tehran" }).offsetMinutes, 270, "Tehran DST 2021");
  assert.equal(ok("2026-06-01T08:00", { timeZone: "Asia/Tehran" }).offsetMinutes, 210);
  err("2026-09-30T24:30:00Z", "invalid_time");
  err("2026-09-30T10:61Z", "invalid_time");
  err("2026-09-30T10:00+25:00", "invalid_offset");
  err("2026-02-30T10:00Z", "invalid_date");
  err("2026-09-30T10", "invalid_format");
  // Date / Instant / ZonedDateTime inputs
  assert.equal(ok(new Date("2026-03-08T07:30:00Z")).instant.toString(), "2026-03-08T07:30:00.000Z");
  assert.equal(ok(Instant.from("2026-09-30T21:00:00Z"), { timeZone: "Asia/Tehran" }).iso, "2026-10-01");
  assert.equal(ok(ZonedDateTime.from({ timeZone: "Europe/London", year: 2026, month: 10, day: 25, hour: 1, minute: 30 })).timeZone, "Europe/London");
});

test("parse: Jalali with Persian or Latin digits; leap years", () => {
  const r = ok("1405/07/08");
  assert.deepEqual([r.system, r.iso, r.parts.year, r.parts.month, r.parts.day, r.weekday], ["jalali", "2026-09-30", 1405, 7, 8, 3]);
  assert.equal(ok("۱۴۰۵/۰۷/۰۸").day, r.day);
  assert.equal(ok("۱۴۰۵-۷-۸").day, r.day);
  assert.equal(ok("1405/07/08 ه.ش").day, r.day);
  assert.equal(ok("۱۴۰۵/۰۷/۰۸ هـ.ش").day, r.day);
  // same answers as the legacy parser
  for (const s of ["1405/07/08", "۱۴۰۵-۰۷-۰۸", "1404/12/29", "1403/12/30"]) assert.equal(ok(s).day, C.parseDate(s), s);
  // leap years: Esfand has 30 days in 1399, 1403 and 1408, 29 in the others
  for (const y of [1399, 1403, 1408]) assert.equal(ok(`${y}/12/30`).day + 1, C.nowruz(y + 1), `${y} leap`);
  for (const y of [1400, 1401, 1402, 1404, 1405, 1406, 1407]) { const e = err(`${y}/12/30`, "invalid_date"); assert.match(e.error.message, /not a leap year/); }
  assert.equal(ok("1403/12/30").iso, "2025-03-20");
  assert.equal(ok("1404/01/01").iso, "2025-03-21");
  err("1405/07/31", "invalid_date"); // Mehr has 30 days
  err("1405/13/01", "invalid_date");
  err("1200/01/01", "out_of_range");
});

test("parse: Hijri with هـ (Umm al-Qura by default, civil on request); month ends", () => {
  const r = ok("1447/09/01 هـ");
  assert.deepEqual([r.system, r.iso, r.parts.month], ["hijri-umalqura", "2026-02-18", 9]);
  assert.equal(ok("١٤٤٧/٠٩/٠١ هـ").day, r.day, "Arabic-Indic digits");
  assert.equal(ok("۱۴۴۷/۰۹/۰۱ ق").day, r.day, "Persian ق (qamari)");
  assert.equal(ok("1447-09-01 AH").day, r.day);
  assert.equal(ok("1447/9/1هـ").day, r.day, "no space before the suffix");
  assert.equal(ok("1447/09/01 هـ.ق").day, r.day);
  // Ramadan 1447 has 30 days (Umm al-Qura), Safar 1447 has 29
  assert.equal(ok("1447/09/30 هـ").iso, "2026-03-19");
  assert.equal(ok("1447/10/01 هـ").iso, "2026-03-20");
  err("1447/02/30 هـ", "invalid_date");
  // every month end of AH 1447 in both variants
  for (const variant of ["umalqura", "civil"]) for (let m = 1; m <= 12; m++) {
    const len = H.hijriMonthLength(1447, m, variant);
    assert.equal(ok(`1447/${m}/${len} هـ`, { hijri: variant }).day, H.fromHijri(1447, m, "last", variant), `${variant} ${m}`);
    if (len === 29) err(`1447/${m}/30 هـ`, "invalid_date", { hijri: variant });
  }
  assert.equal(ok("1447/09/01 هـ", { hijri: "civil" }).system, "hijri-civil");
  err("1601/01/01 هـ", "out_of_range");
  err("1447/09/01 هـ", "invalid_option", { hijri: "lunar" });
  // without the suffix a year below 1700 is Jalali, never Hijri
  assert.equal(ok("1447/09/01").system, "jalali");
});

test("parse: today, errors are tagged, never throws", () => {
  const now = new Date("2026-09-30T21:00:00Z"); // 00:30 on 1 October in Tehran
  assert.equal(ok("today", { now }).iso, "2026-09-30");
  assert.equal(ok("امروز", { now, timeZone: "Asia/Tehran" }).iso, "2026-10-01");
  assert.equal(ok("اليوم", { now, timeZone: "Asia/Riyadh" }).iso, "2026-10-01");
  err("", "empty");
  err("   ", "empty");
  err("30/09/2026", "invalid_format");
  err("next tuesday", "invalid_format");
  err("2026-09-30", "invalid_time_zone", { timeZone: "Europe/Frankfurt" });
  for (const v of [null, undefined, {}, [], Symbol("x"), 1.5, NaN, () => 1, "\u0000", "9999999-01-01", "2026-09-30T10:00:00+05:30[Asia/Kolkata]"]) {
    let r;
    assert.doesNotThrow(() => { r = parseInput(v); });
    assert.equal(typeof r.ok, "boolean");
    if (!r.ok) assert.ok(r.error.code && r.error.message);
  }
  assert.equal(parse, parseInput);
  assert.equal(normalizeDigits(" ۱۴۰۵/۰۷/۰۸ "), "1405/07/08");
});
