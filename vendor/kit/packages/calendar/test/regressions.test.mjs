/* Regression tests for the bugs found in the calendar verification run of 2026-10-01 (B2, B3, B4, B7, B9,
   letter normalisation, nearest roll). Each test failed on kit main 0ea5fcd. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as C from "../src/index.js";
import * as B from "../src/business.js";
import * as T from "../src/time.js";
import * as CFG from "../src/config.js";
import * as P from "../src/parse.js";
import * as W from "../src/weekday.js";

// Namespace imports, so a missing export fails its own test instead of the whole file.
const { Instant, ZonedDateTime, TimeError, addMonths } = T;
const { resolveCalendarConfig, createCalendar } = CFG;
const { parseInput, normalizeText, parseMonthName } = P;
const { parseWeekday } = W;
const D = (iso) => C.fromISO(iso);
const THR = "Asia/Tehran";

/* ------------------------------------------------------------------ B2 */
test("B2: VERSION equals package.json version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(C.VERSION, pkg.version);
  assert.match(C.ics({ from: 1405, to: 1405 }), new RegExp(`PRODID:-//saasreport-kit//calendar ${pkg.version.replace(/\./g, "\\.")}//FA`));
});

/* ------------------------------------------------------------------ B3 */
test("B3: ZonedDateTime.plus({ months }) and ({ years }) move the date (Gregorian by default), clamped to month end", () => {
  const z = ZonedDateTime.from("2026-10-01T10:30:00+03:30[Asia/Tehran]");
  assert.equal(z.plus({ months: 1 }).toString(), "2026-11-01T10:30:00+03:30[Asia/Tehran]");
  assert.equal(z.plus({ years: 1 }).toString(), "2027-10-01T10:30:00+03:30[Asia/Tehran]");
  assert.equal(z.minus({ months: 10 }).toString(), "2025-12-01T10:30:00+03:30[Asia/Tehran]");
  const jan31 = ZonedDateTime.from("2026-01-31T09:00:00Z[UTC]");
  assert.equal(jan31.plus({ months: 1 }).toString(), "2026-02-28T09:00:00+00:00[UTC]");
  assert.equal(ZonedDateTime.from("2028-02-29T00:00:00Z[UTC]").plus({ years: 1 }).toString(), "2029-02-28T00:00:00+00:00[UTC]");
  // years, then months, then days, then time (Temporal's order)
  assert.equal(jan31.plus({ months: 1, days: 1, hours: 2 }).toString(), "2026-03-01T11:00:00+00:00[UTC]");
  // across a DST change the wall-clock time is kept
  assert.equal(ZonedDateTime.from("2026-02-08T09:00:00-05:00[America/New_York]").plus({ months: 1 }).toString(), "2026-03-08T09:00:00-04:00[America/New_York]");
});

test("B3: calendar-aware months in Jalali and Hijri (clamped to month end)", () => {
  // 31 Shahrivar 1405 = 2026-09-22; + 1 Jalali month → 30 Mehr 1405 (Mehr has 30 days) = 2026-10-22
  const z = ZonedDateTime.from({ timeZone: THR, year: 2026, month: 9, day: 22, hour: 8 });
  const m = z.plus({ months: 1 }, { calendar: "jalali" });
  assert.deepEqual(C.toJalali(m.dayNumber), { jy: 1405, jm: 7, jd: 30 });
  assert.equal(m.hour, 8);
  assert.deepEqual(C.toJalali(z.plus({ years: 1 }, { calendar: "jalali" }).dayNumber), { jy: 1406, jm: 6, jd: 31 });
  // 30 Esfand 1403 (leap) + 1 Jalali year → 29 Esfand 1404
  const e = C.fromJalali(1403, 12, 30);
  assert.deepEqual(C.toJalali(addMonths(e, 12, "jalali")), { jy: 1404, jm: 12, jd: 29 });
  // Umm al-Qura: 1 Oct 2026 = 20 Rabi al-Thani 1448 → +1 month = 20 Jumada al-Ula 1448 = 2026-10-31
  const h = ZonedDateTime.from({ timeZone: THR, year: 2026, month: 10, day: 1 }).plus({ months: 1 }, { calendar: "hijri" });
  assert.equal(h.toLocalDate().toString(), "2026-10-31");
  assert.equal(addMonths(D("2026-10-01"), -1, "gregorian"), D("2026-09-01"));
  assert.equal(addMonths(D("2026-03-31"), -1), D("2026-02-28"));
});

test("B3: unknown units and fractional months throw instead of being ignored", () => {
  const z = ZonedDateTime.from("2026-10-01T10:30:00+03:30[Asia/Tehran]");
  assert.throws(() => z.plus({ month: 1 }), (e) => e instanceof TimeError && e.code === "invalid_duration");
  assert.throws(() => z.plus({ months: 1.5 }), { code: "invalid_duration" });
  assert.throws(() => z.plus({ months: 1 }, { calendar: "mayan" }), { code: "invalid_calendar" });
  const i = Instant.from("2026-10-01T00:00:00Z");
  assert.throws(() => i.plus({ months: 1 }), { code: "invalid_duration" });
  assert.throws(() => i.plus({ hour: 1 }), { code: "invalid_duration" });
  assert.equal(i.plus({ hours: 1 }).toString(), "2026-10-01T01:00:00.000Z");
});

/* ------------------------------------------------------------------ B4 */
test("B4: String(), template literals and + give the ISO text; numeric comparison still works", () => {
  const z = ZonedDateTime.from("2026-10-01T10:30:00+03:30[Asia/Tehran]");
  const iso = "2026-10-01T10:30:00+03:30[Asia/Tehran]";
  assert.equal(String(z), iso);
  assert.equal(`${z}`, iso);
  assert.equal("" + z, iso);
  assert.equal(z.toJSON(), iso);
  assert.equal(JSON.stringify({ z }), `{"z":"${iso}"}`);
  const later = z.plus({ hours: 1 });
  assert.ok(z < later);
  assert.equal(later - z, 3600000);
  assert.equal(+z, z.epochMs);
  const i = z.toInstant();
  assert.equal(`${i}`, "2026-10-01T07:00:00.000Z");
  assert.equal(+i, z.epochMs);
});

/* ------------------------------------------------------------------ B7 */
test("B7: resolveCalendarConfig accepts the already-normalised shape (markets + profiles object)", () => {
  const raw = { systems: ["gregorian", "hijri"], profiles: ["sa", "ae", "us"] };
  const first = resolveCalendarConfig(raw);
  // what core's defineConfig(...).calendar looks like: market ids in `markets`, `profiles` an object per market
  const normalised = { ...first, markets: first.profiles, profiles: { sa: { key: "sa", weekend: [5, 6] }, ae: { key: "ae", weekend: [0, 6] }, us: { key: "us", weekend: [0, 6] } }, system: "gregorian", holidays: "none" };
  const again = resolveCalendarConfig(normalised);
  assert.deepEqual(again.profiles, ["sa", "ae", "us"]);
  assert.equal(again.profile, "sa");
  assert.deepEqual(again.problems, []);
  assert.deepEqual(resolveCalendarConfig(again).profiles, ["sa", "ae", "us"]);
  assert.deepEqual(createCalendar(normalised).profiles, ["sa", "ae", "us"]);
  // legacy shape still resolves to ir
  assert.deepEqual(resolveCalendarConfig({ system: "jalali", holidays: "iran", profiles: { bank: "bank" } }).profiles, ["ir"]);
});

/* ------------------------------------------------------------------ B9 */
const events = (cal) => [...cal.matchAll(/^DTSTART;VALUE=DATE:(\d{8})/gm)].map((m) => m[1]);
test("B9: ics() takes ISO-date or day-number ranges as well as Jalali years", () => {
  const byYear = events(C.ics({ from: 1405, to: 1405 }));
  assert.equal(byYear.length, 28);
  // ISO dates (inclusive)
  const q4 = events(C.ics({ from: "2026-10-01", to: "2026-12-31" }));
  assert.deepEqual(q4, ["20261114", "20261223"]);
  // day numbers
  assert.deepEqual(events(C.ics({ from: D("2026-10-01"), to: D("2026-12-31") })), q4);
  // Jalali date text
  assert.deepEqual(events(C.ics({ from: "1405/07/09", to: "1405/10/10" })), q4);
  // a range across Nowruz spans two Jalali years
  const nowruz = events(C.ics({ from: "2027-03-15", to: "2027-04-10" }));
  assert.ok(nowruz.includes("20270321") && nowruz.includes("20270320"));
  // unit forces the reading of a number
  assert.deepEqual(events(C.ics({ from: 1405, to: 1405, unit: "day" })), []);
  assert.throws(() => C.ics({ from: "2026-12-31", to: "2026-10-01" }), { code: "invalid_range" });
});

test("B9: ics() with no arguments covers the current Jalali year", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  assert.deepEqual(events(C.ics({ now })), events(C.ics({ from: 1405, to: 1405 })));
  assert.ok(events(C.ics()).length > 0);
});

test("B9: ics() time zone, calendar name and UID prefix are configurable; defaults unchanged", () => {
  const def = C.ics({ from: 1405, to: 1405 });
  assert.match(def, /^X-WR-TIMEZONE:Asia\/Tehran$/m);
  assert.match(def, /^UID:cal-\d{8}-/m);
  const cal = C.ics({ from: "2026-10-01", to: "2026-12-31", timeZone: "Europe/London", name: "Example Calendar", uidPrefix: "feed-", domain: "example.org" });
  assert.match(cal, /^X-WR-TIMEZONE:Europe\/London$/m);
  assert.match(cal, /^X-WR-CALNAME:Example Calendar$/m);
  assert.match(cal, /^UID:feed-20261114-lunar-63@example\.org$/m);
  assert.doesNotMatch(cal, /UID:cal-/);
  assert.throws(() => C.ics({ from: 1405, to: 1405, timeZone: "Mars/Olympus" }), { code: "invalid_time_zone" });
  assert.throws(() => C.ics({ from: 1405, to: 1405, uidPrefix: "bad prefix" }), { code: "invalid_option" });
});

/* ------------------------------------------------------------------ letter normalisation */
test("parse: Arabic ي/ك, Persian and Arabic-Indic digits and ZWNJ normalise in month and weekday names", () => {
  assert.equal(normalizeText("ربيع‌الثاني ١٤٤٨ يكشنبه ۱۲"), "ربیع‌الثانی 1448 یکشنبه 12");
  assert.equal(parseWeekday("يكشنبه"), 7); // Arabic yeh and kaf
  assert.equal(parseWeekday("سه‌شنبه"), 2);
  assert.equal(parseWeekday("سه شنبه"), 2);
  assert.equal(parseWeekday("پنج شنبه"), 4);
  assert.equal(parseWeekday("الاثنين"), 1);
  assert.equal(parseWeekday("الإثنين"), 1);
  assert.equal(parseWeekday("الاربعاء"), 3);
  assert.deepEqual(parseMonthName("دي"), { system: "jalali", month: 10 });
  assert.deepEqual(parseMonthName("ربيع الثاني"), { system: "hijri", month: 4 });
  assert.deepEqual(parseMonthName("ربیع‌الثانی"), { system: "hijri", month: 4 });
  assert.deepEqual(parseMonthName("October"), { system: "gregorian", month: 10 });
  assert.equal(parseMonthName("Brumaire"), null);

  const mehr = C.fromJalali(1405, 7, 9);
  for (const s of ["۹ مهر ۱۴۰۵", "9 Mehr 1405", "پنجشنبه ۹ مهر ۱۴۰۵", "پنج‌شنبه ۹ مهر ۱۴۰۵", "٩ مهر ١٤٠٥"]) {
    const r = parseInput(s);
    assert.ok(r.ok, `${s}: ${JSON.stringify(r.error)}`);
    assert.equal(r.day, mehr, s);
    assert.equal(r.system, "jalali", s);
  }
  const dey = parseInput("۱ دي ۱۴۰۵");
  assert.ok(dey.ok); assert.equal(dey.day, C.fromJalali(1405, 10, 1));
  const h = parseInput("٢٠ ربيع الآخر ١٤٤٨ هـ");
  assert.ok(h.ok, JSON.stringify(h.error)); assert.equal(h.iso, "2026-10-01"); assert.equal(h.system, "hijri-umalqura");
  const g = parseInput("1 October 2026");
  assert.ok(g.ok); assert.equal(g.iso, "2026-10-01");
  assert.equal(parseInput("October 1, 2026").iso, "2026-10-01");
  // a weekday that does not match the date is an error, not ignored
  assert.equal(parseInput("جمعه ۹ مهر ۱۴۰۵").error.code, "invalid_date");
  assert.equal(parseInput("31 Mehr 1405").error.code, "invalid_date");
});

/* ------------------------------------------------------------------ nearest roll */
test("adjust: nearest business day (ties go forward)", () => {
  // UK: Sat 26 Dec 2026 is closed, Sun 27 closed, Mon 28 substitute holiday; 24 Dec (Thu) open, 29 Dec (Tue) open
  // Sat 26 Dec → back 2 days to Thu 24 Dec (Fri 25 Dec closed) vs forward 3 to Tue 29 → 24 Dec
  assert.equal(B.adjust(D("2026-12-26"), "nearest", "uk").iso, "2026-12-24");
  // Sun 27 Dec → 3 back (24th), 2 forward (29th) → 29 Dec
  assert.equal(B.adjust(D("2026-12-27"), "nearest", "uk").iso, "2026-12-29");
  // US: Sat 10 Oct 2026 → Fri 9 Oct (1 back) vs Tue 13 Oct (Columbus Day on 12th) → 9 Oct
  assert.equal(B.adjust(D("2026-10-10"), "nearest", "us").iso, "2026-10-09");
  // Sun 4 Oct → Fri 2 Oct (2 back) vs Mon 5 Oct (1 forward) → 5 Oct
  assert.equal(B.adjust(D("2026-10-04"), "nearest", "us").iso, "2026-10-05");
  // a business day stays put
  assert.equal(B.adjust(D("2026-10-01"), "nearest", "us").moved, 0);
  assert.ok(B.CONVENTIONS.includes("nearest"));
  // Iran engine (index.js): Friday 2026-10-02 bank → Thu 1 Oct (1 back) vs Sat 3 Oct (1 forward) → tie goes forward
  assert.equal(C.toISO(C.adjust(D("2026-10-02"), "nearest").date), "2026-10-03");
  // government (Thu+Fri weekend): Fri 2 Oct → Wed 30 Sep (2 back) vs Sat 3 Oct (1 forward) → 3 Oct; Thu 1 Oct → Wed 30 Sep
  assert.equal(C.toISO(C.adjust(D("2026-10-01"), "nearest", { profile: "government" }).date), "2026-09-30");
  assert.ok("nearest" in C.CONVENTIONS);
});
