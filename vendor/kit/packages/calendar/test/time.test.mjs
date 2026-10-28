import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../src/index.js";
import * as M from "../src/markets.js";
import * as L from "../src/locale.js";
import * as W from "../src/weekday.js";
import { Instant, ZonedDateTime, LocalDate, LocalTime, TimeError, startOfDay, endOfDay, dayBounds, dayOf, offsetMinutes, formatDateTime, workingHours, isValidTimeZone, wallToEpoch } from "../src/time.js";

const D = (iso) => C.fromISO(iso);
const NY = "America/New_York", LON = "Europe/London", THR = "Asia/Tehran";
const zs = (i, tz) => Instant.from(i).toZoned(tz).toString();

/* ------------------------------------------------------------------ weekdays */
test("weekday: ISO 1 = Monday … 7 = Sunday, one convention with converters to the legacy ones", () => {
  assert.equal(W.isoWeekday(0), 4); // 1970-01-01 was a Thursday
  assert.equal(W.isoWeekday(D("2026-09-28")), 1);
  assert.equal(W.isoWeekday(D("2026-10-04")), 7);
  for (let n = -800; n < 800; n += 1) {
    const js = new Date(n * 86400000).getUTCDay(), iso = W.isoWeekday(n);
    assert.equal(iso, js === 0 ? 7 : js);
    assert.equal(C.isoWeekday(n), iso, "index.js alias");
    assert.equal(M.isoDow(n), iso, "markets.js alias");
    assert.equal(W.fromSundayIndex(M.dow(n)), iso, "legacy markets dow");
    assert.equal(W.fromSaturdayIndex(C.weekday(n)), iso, "legacy index.js weekday");
    assert.equal(W.toSaturdayIndex(iso), C.weekday(n));
    assert.equal(W.toSundayIndex(iso), M.dow(n));
  }
  for (const a of ["iso", "sunday0", "saturday0"]) for (const b of ["iso", "sunday0", "saturday0"]) for (let iso = 1; iso <= 7; iso++) {
    const v = W.convertWeekday(iso, "iso", a);
    assert.equal(W.convertWeekday(W.convertWeekday(v, a, b), b, "iso"), iso, `${a}→${b}`);
  }
  assert.equal(W.convertWeekday(6, "saturday0", "iso"), W.FRIDAY);
  assert.equal(W.convertWeekday(0, "sunday0", "iso"), W.SUNDAY);
  assert.throws(() => W.fromSundayIndex(7), RangeError);
  assert.throws(() => W.toSundayIndex(0), RangeError);
  assert.throws(() => W.convertWeekday(1, "iso", "monday0"), RangeError);
  assert.equal(W.WEEKDAY_CONVENTIONS.iso.legacy, false);
  assert.equal(W.WEEKDAY_CONVENTIONS.saturday0.legacy, true);
  for (const [v, iso] of [[3, 3], ["thu", 4], ["Friday", 5], ["جمعه", 5], ["یکشنبه", 7], ["سه‌شنبه", 2], ["الأحد", 7], ["7", 7]]) assert.equal(W.parseWeekday(v), iso, String(v));
  for (const v of [0, 8, "noday", null]) assert.equal(W.parseWeekday(v), null);
});

test("weekday: market weekends as ISO weekdays; legacy outputs unchanged", () => {
  assert.deepEqual(M.weekendIsoOf("sa"), [5, 6]);
  assert.deepEqual(M.weekendIsoOf("uk"), [6, 7]);
  assert.deepEqual(M.weekendIsoOf("ae", D("2021-12-19")), [5, 6]);
  assert.deepEqual(M.weekendIsoOf("ae", D("2022-01-02")), [6, 7]);
  assert.deepEqual(M.weekendIsoOf("ir"), [5]);
  assert.deepEqual(M.weekendIsoOf("ir:government"), [4, 5]);
  // the legacy numbers are untouched
  assert.deepEqual(C.PROFILES.bank.weekend, [6]);
  assert.deepEqual(M.weekendOf("ir"), [5]);
  assert.deepEqual(M.weekendOf("uk"), [6, 0]);
});

/* ------------------------------------------------------------------ Instant */
test("Instant: epoch ms, ISO with offset, arithmetic", () => {
  const a = Instant.from("2026-03-08T07:30:00Z");
  assert.equal(a.epochMs, Date.UTC(2026, 2, 8, 7, 30));
  assert.ok(Instant.from("2026-03-08T03:30:00-04:00").equals(a));
  assert.ok(Instant.from("2026-03-08T11:00+03:30").equals(a));
  assert.ok(Instant.from("2026-03-08T11:00:00.000+0330").equals(a));
  assert.ok(Instant.from("2026-03-08 02:30:00[America/New_York]").equals(a), "wall time in a zone (gap → compatible)");
  assert.equal(Instant.from(new Date(a.epochMs)).toString(), "2026-03-08T07:30:00.000Z");
  assert.equal(a.plus({ hours: 1, minutes: 30 }).toString(), "2026-03-08T09:00:00.000Z");
  assert.equal(a.minus({ days: 1 }).toString(), "2026-03-07T07:30:00.000Z");
  assert.equal(a.until(a.plus({ seconds: 5 })), 5000);
  assert.equal(a.compare("2026-03-08T07:30:01Z"), -1);
  assert.equal(JSON.stringify({ a }), '{"a":"2026-03-08T07:30:00.000Z"}');
  assert.equal(Instant.fromEpochSeconds(1).epochMs, 1000);
  assert.ok(Object.isFrozen(a));
  assert.throws(() => Instant.from("2026-03-08T07:30:00"), { code: "missing_offset" });
  assert.throws(() => Instant.from("2026-02-30T07:30:00Z"), { code: "invalid_date" });
  assert.throws(() => Instant.from("yesterday"), { code: "invalid_format" });
  assert.throws(() => new Instant(NaN), { code: "invalid_instant" });
});

/* ------------------------------------------------------------------ zones and DST */
test("time zones: Intl only; invalid zones fail clearly", () => {
  assert.equal(isValidTimeZone("Asia/Tehran"), true);
  assert.equal(isValidTimeZone("Europe/Frankfurt"), false);
  assert.equal(isValidTimeZone(""), false);
  assert.throws(() => startOfDay(0, "Mars/Olympus"), { code: "invalid_time_zone" });
  for (const m of M.markets()) assert.ok(isValidTimeZone(m.timeZone), `${m.id}: ${m.timeZone}`);
});

test("America/New_York: spring-forward gap and autumn fold", () => {
  const z = (h, m, o) => ZonedDateTime.from({ timeZone: NY, year: 2026, month: 3, day: 8, hour: h, minute: m }, o).toString();
  assert.equal(z(1, 59), "2026-03-08T01:59:00-05:00[America/New_York]");
  assert.equal(z(2, 30), "2026-03-08T03:30:00-04:00[America/New_York]", "compatible: forward by the gap");
  assert.equal(z(2, 30, { disambiguation: "later" }), "2026-03-08T03:30:00-04:00[America/New_York]");
  assert.equal(z(2, 30, { disambiguation: "earlier" }), "2026-03-08T01:30:00-05:00[America/New_York]");
  assert.throws(() => z(2, 30, { disambiguation: "reject" }), { code: "nonexistent_time" });
  assert.equal(z(3, 0), "2026-03-08T03:00:00-04:00[America/New_York]");
  const f = (o) => ZonedDateTime.from({ timeZone: NY, year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, o);
  assert.equal(f().toString(), "2026-11-01T01:30:00-04:00[America/New_York]", "compatible: earlier");
  assert.equal(f({ disambiguation: "later" }).toString(), "2026-11-01T01:30:00-05:00[America/New_York]");
  assert.equal(f({ disambiguation: "later" }).epochMs - f().epochMs, 3600000);
  assert.throws(() => f({ disambiguation: "reject" }), { code: "ambiguous_time" });
  // day lengths and bounds
  assert.equal(dayBounds(D("2026-03-08"), NY).hours, 23);
  assert.equal(dayBounds(D("2026-11-01"), NY).hours, 25);
  assert.equal(dayBounds(D("2026-11-02"), NY).hours, 24);
  assert.equal(startOfDay(D("2026-03-08"), NY).toString(), "2026-03-08T00:00:00-05:00[America/New_York]");
  assert.equal(endOfDay(D("2026-03-08"), NY).toString(), "2026-03-08T23:59:59.999-04:00[America/New_York]");
  assert.equal(endOfDay(D("2026-11-01"), NY).toString(), "2026-11-01T23:59:59.999-05:00[America/New_York]");
  // offsets
  assert.equal(offsetMinutes(Date.UTC(2026, 0, 15), NY), -300);
  assert.equal(offsetMinutes(Date.UTC(2026, 6, 15), NY), -240);
});

test("ZonedDateTime: calendar days keep wall time across DST, hours are exact", () => {
  const sat = ZonedDateTime.from({ timeZone: NY, year: 2026, month: 3, day: 7, hour: 12 });
  const sun = sat.plus({ days: 1 });
  assert.equal(sun.toString(), "2026-03-08T12:00:00-04:00[America/New_York]");
  assert.equal(sun.epochMs - sat.epochMs, 23 * 3600000);
  assert.equal(sat.plus({ hours: 24 }).toString(), "2026-03-08T13:00:00-04:00[America/New_York]");
  assert.equal(sun.minus({ days: 1 }).toString(), sat.toString());
  assert.equal(sat.plus({ weeks: 1 }).dayNumber, D("2026-03-14"));
  assert.equal(sun.hoursInDay, 23);
  assert.equal(sun.isoWeekday, 7);
  assert.equal(sun.dayNumber, D("2026-03-08"));
  assert.equal(sun.toLocalDate().toString(), "2026-03-08");
  assert.equal(sun.toLocalTime().toString(), "12:00");
  assert.equal(sun.withTime("02:30").toString(), "2026-03-08T03:30:00-04:00[America/New_York]");
  assert.equal(sun.startOfDay().toString(), "2026-03-08T00:00:00-05:00[America/New_York]");
  assert.equal(sun.withTimeZone(THR).toString(), "2026-03-08T19:30:00+03:30[Asia/Tehran]");
  // ISO text round trip, and offset vs zone check
  assert.ok(ZonedDateTime.from(sun.toString()).equals(sun));
  assert.throws(() => ZonedDateTime.from("2026-03-08T12:00:00-05:00[America/New_York]"), { code: "offset_mismatch" });
  assert.equal(ZonedDateTime.from("2026-03-08T12:00:00", { timeZone: LON }).offset, "+00:00");
  assert.throws(() => ZonedDateTime.from("2026-03-08T12:00:00"), { code: "missing_offset" });
  assert.throws(() => ZonedDateTime.from({ year: 2026, month: 3, day: 8 }), { code: "invalid_time_zone" });
  assert.throws(() => ZonedDateTime.from({ timeZone: NY, year: 2026, month: 2, day: 29 }), { code: "invalid_date" });
  assert.equal(JSON.stringify(sun), JSON.stringify(sun.toString()));
});

test("Europe/London: BST starts and ends at 01:00 UTC", () => {
  assert.equal(dayBounds(D("2026-03-29"), LON).hours, 23);
  assert.equal(dayBounds(D("2026-10-25"), LON).hours, 25);
  assert.equal(zs("2026-03-29T00:59:59Z", LON), "2026-03-29T00:59:59+00:00[Europe/London]");
  assert.equal(zs("2026-03-29T01:00:00Z", LON), "2026-03-29T02:00:00+01:00[Europe/London]");
  assert.equal(ZonedDateTime.from({ timeZone: LON, year: 2026, month: 3, day: 29, hour: 1, minute: 30 }).toString(), "2026-03-29T02:30:00+01:00[Europe/London]");
  assert.equal(ZonedDateTime.from({ timeZone: LON, year: 2026, month: 10, day: 25, hour: 1, minute: 30 }).offset, "+01:00");
  assert.equal(ZonedDateTime.from({ timeZone: LON, year: 2026, month: 10, day: 25, hour: 1, minute: 30 }, { disambiguation: "later" }).offset, "+00:00");
});

test("Asia/Tehran: DST until 2022 (+04:30 summers, midnight gap), +03:30 all year since 2023", () => {
  assert.equal(offsetMinutes(Date.UTC(2021, 5, 1), THR), 270);
  assert.equal(offsetMinutes(Date.UTC(2021, 11, 1), THR), 210);
  assert.equal(offsetMinutes(Date.UTC(2022, 5, 1), THR), 270);
  assert.equal(offsetMinutes(Date.UTC(2023, 5, 1), THR), 210);
  // 2021-03-22 (1400/01/02): clocks went from 00:00 to 01:00 — the day starts at 01:00 and has 23 hours
  const s = startOfDay(D("2021-03-22"), THR);
  assert.equal(s.toString(), "2021-03-22T01:00:00+04:30[Asia/Tehran]");
  assert.equal(dayBounds(D("2021-03-22"), THR).hours, 23);
  assert.equal(endOfDay(D("2021-03-21"), THR).toString(), "2021-03-21T23:59:59.999+03:30[Asia/Tehran]");
  assert.throws(() => wallToEpoch(THR, { year: 2021, month: 3, day: 22, hour: 0, minute: 30 }, "reject"), { code: "nonexistent_time" });
  // 2021-09-22 00:00 (+04:30) went back to 2021-09-21 23:00 (+03:30): 21 September had 25 hours
  assert.equal(dayBounds(D("2021-09-21"), THR).hours, 25);
  assert.equal(dayBounds(D("2021-09-22"), THR).hours, 24);
  const fold = { year: 2021, month: 9, day: 21, hour: 23, minute: 30 };
  assert.equal(wallToEpoch(THR, fold, "later") - wallToEpoch(THR, fold, "earlier"), 3600000);
  // 2022 still had DST; from 2023 every day is 24 hours long
  assert.equal(dayBounds(D("2022-03-22"), THR).hours, 23);
  assert.equal(dayBounds(D("2022-09-21"), THR).hours, 25);
  for (let n = D("2023-01-01"); n <= D("2026-12-31"); n++) assert.equal(dayBounds(n, THR).hours, 24, C.toISO(n));
  // the engine's today() is the Tehran civil day
  for (const t of ["2026-09-30T20:29:59Z", "2026-09-30T20:30:00Z", "2021-06-01T19:29:00Z", "2021-06-01T19:31:00Z"]) assert.equal(dayOf(t, THR), C.today(new Date(t)), t);
  assert.equal(C.toISO(dayOf("2021-06-01T19:31:00Z", THR)), "2021-06-02"); // 00:01 at +04:30
});

/* ------------------------------------------------------------------ LocalDate / LocalTime */
test("LocalDate and LocalTime", () => {
  const d = LocalDate.of(2024, 2, 29);
  assert.equal(d.toString(), "2024-02-29");
  assert.equal(d.dayNumber, D("2024-02-29"));
  assert.equal(LocalDate.fromDay(d.dayNumber).toString(), "2024-02-29");
  assert.equal(d.plusDays(1).toString(), "2024-03-01");
  assert.equal(d.isoWeekday, 4);
  assert.equal(LocalDate.parse("2026-09-30").compare(d), 1);
  assert.throws(() => LocalDate.of(2026, 2, 29), { code: "invalid_date" });
  assert.throws(() => LocalDate.parse("2026/09/30"), { code: "invalid_format" });
  assert.equal(LocalTime.parse("8:05").toString(), "08:05");
  assert.equal(LocalTime.parse("۱۶:۳۰").milliseconds, 16.5 * 3600000);
  assert.equal(LocalTime.parse("24:00").milliseconds, 86400000);
  assert.equal(LocalTime.parse("10:00:30").toString(), "10:00:30");
  assert.equal(LocalTime.fromMilliseconds(3723004).toString(), "01:02:03.004");
  assert.throws(() => LocalTime.parse("24:01"), { code: "invalid_time" });
  assert.throws(() => LocalTime.parse("7pm"), { code: "invalid_time" });
});

/* ------------------------------------------------------------------ formatting */
test("formatDateTime: fa / en / ar, Jalali / Gregorian / Hijri, with time", () => {
  const i = Instant.from("2026-09-30T05:00:00Z"); // 08:30 in Tehran, 08:00 in Riyadh
  assert.equal(formatDateTime(i, { timeZone: THR, locale: "fa" }), "۸ مهر ۱۴۰۵، ۰۸:۳۰");
  assert.equal(formatDateTime(i, { timeZone: THR, locale: "fa", system: "gregorian" }), "۳۰ سپتامبر ۲۰۲۶، ۰۸:۳۰");
  assert.equal(formatDateTime(i, { timeZone: THR, locale: "en", system: "jalali", offset: true }), "8 Mehr 1405 SH, 08:30 +03:30");
  assert.equal(formatDateTime(i, { timeZone: LON, locale: "en", seconds: true, timeZoneName: true }), "30 September 2026, 06:00:00 (Europe/London)");
  assert.equal(formatDateTime(i, { timeZone: NY, locale: "en", weekday: true }), "Wednesday, 30 September 2026, 01:00");
  const hijri = L.formatDate(D("2026-09-30"), { system: "hijri-umalqura", locale: "ar" });
  assert.equal(formatDateTime(i, { timeZone: "Asia/Riyadh", locale: "ar", system: "hijri" }), `${hijri}، ٠٨:٠٠`);
  assert.equal(formatDateTime(i, { timeZone: "Asia/Riyadh", locale: "ar", system: "hijri", digits: "latin" }), `${L.formatDate(D("2026-09-30"), { system: "hijri-umalqura", locale: "ar", digits: "latin" })}، 08:00`);
  assert.equal(formatDateTime(i, { timeZone: "Asia/Riyadh", locale: "ar", offset: true }).endsWith("⁦+٠٣:٠٠⁩"), true, "offset isolated for RTL");
  // the local date decides the calendar day: 23:30 UTC is already the next day in Tehran
  assert.equal(formatDateTime("2026-09-30T21:00:00Z", { timeZone: THR, locale: "fa" }), "۹ مهر ۱۴۰۵، ۰۰:۳۰");
  // a ZonedDateTime keeps its own zone
  assert.equal(formatDateTime(ZonedDateTime.fromInstant(i, NY), { locale: "en" }), "30 September 2026, 01:00");
});

/* ------------------------------------------------------------------ working hours */
test("working hours (US, New York): open/closed across DST, weekends and Fed holidays", () => {
  const w = workingHours({ profiles: "us", hours: "09:00-17:00" });
  assert.equal(w.timeZone, NY);
  assert.equal(w.isOpen("2026-03-06T14:30:00Z"), true, "Fri 09:30 EST");
  assert.equal(w.isOpen("2026-03-09T13:30:00Z"), true, "Mon 09:30 EDT");
  assert.equal(w.isOpen("2026-03-09T12:30:00Z"), false, "Mon 08:30 EDT");
  assert.equal(w.isOpen("2026-03-09T21:00:00Z"), false, "17:00 is closed (sessions are [open, close))");
  assert.equal(w.isOpen("2026-03-07T15:00:00Z"), false, "Saturday");
  // weekend: Friday 16:00 + 2h → Monday 10:00
  assert.equal(zs(w.addBusinessHours(Instant.from("2026-10-02T20:00:00Z"), 2), NY), "2026-10-05T10:00:00-04:00[America/New_York]");
  // Thanksgiving (Thu 26 Nov 2026) is closed
  assert.equal(zs(w.nextOpen("2026-11-26T15:00:00Z"), NY), "2026-11-27T09:00:00-05:00[America/New_York]");
  assert.equal(zs(w.addBusinessHours("2026-11-25T20:00:00Z", 3), NY), "2026-11-27T10:00:00-05:00[America/New_York]");
  // across the March change: Fri 16:00 EST + 2h = Mon 10:00 EDT
  assert.equal(zs(w.addBusinessHours("2026-03-06T21:00:00Z", 2), NY), "2026-03-09T10:00:00-04:00[America/New_York]");
  // landing on the close returns the close; 8h from the open is the same day's close
  assert.equal(zs(w.addBusinessHours("2026-10-05T13:00:00Z", 8), NY), "2026-10-05T17:00:00-04:00[America/New_York]");
  assert.equal(zs(w.addBusinessHours("2026-10-05T13:00:00Z", 8.5), NY), "2026-10-06T09:30:00-04:00[America/New_York]");
  // backwards and zero
  assert.equal(zs(w.addBusinessHours("2026-10-05T14:00:00Z", -2), NY), "2026-10-02T16:00:00-04:00[America/New_York]");
  assert.equal(zs(w.addBusinessHours("2026-10-03T14:00:00Z", 0), NY), "2026-10-05T09:00:00-04:00[America/New_York]");
  assert.equal(w.nextOpen("2026-10-05T14:00:00Z").toString(), "2026-10-05T14:00:00.000Z", "already open");
  assert.equal(zs(w.nextClose("2026-10-05T14:00:00Z"), NY), "2026-10-05T17:00:00-04:00[America/New_York]");
  assert.equal(zs(w.previousClose("2026-10-04T14:00:00Z"), NY), "2026-10-02T17:00:00-04:00[America/New_York]");
  assert.equal(w.businessHoursBetween("2026-10-02T20:00:00Z", "2026-10-05T14:00:00Z"), 2);
  assert.equal(w.businessHoursBetween("2026-10-05T14:00:00Z", "2026-10-02T20:00:00Z"), -2);
  assert.equal(w.businessHoursBetween("2026-11-23T00:00:00Z", "2026-11-30T00:00:00Z"), 32, "Thanksgiving week: 4 days × 8h");
  const st = w.status("2026-11-26T15:00:00Z");
  assert.equal(st.open, false);
  assert.equal(st.business.business, false);
  assert.deepEqual(st.business.closed, ["us"]);
});

test("working hours (UK, London): BST change and bank holidays", () => {
  const w = workingHours({ profiles: "uk", hours: "08:00-16:00" });
  assert.equal(w.timeZone, LON);
  assert.equal(zs(w.addBusinessHours("2026-03-27T15:00:00Z", 2), LON), "2026-03-30T09:00:00+01:00[Europe/London]");
  assert.equal(w.isOpen("2026-03-30T07:30:00Z"), true, "08:30 BST");
  assert.equal(w.isOpen("2026-03-27T07:30:00Z"), false, "07:30 GMT");
  // Good Friday 3 April and Easter Monday 6 April 2026 are bank holidays
  assert.equal(zs(w.nextOpen("2026-04-02T16:00:00Z"), LON), "2026-04-07T08:00:00+01:00[Europe/London]");
  assert.equal(w.sessions(D("2026-04-03")).length, 0);
});

test("working hours (Iran, Tehran): Friday weekend, Nowruz, per-weekday hours", () => {
  const w = workingHours({ profiles: "ir", hours: "08:00-16:00", byWeekday: { thursday: "08:00-12:00" } });
  assert.equal(w.timeZone, THR);
  // Thursday 1404/12/28 (2026-03-19) closes at 12:00; then Friday, Esfand 29 and Nowruz: next open Wed 1405/01/05
  assert.equal(w.isOpen(ZonedDateTime.from({ timeZone: THR, year: 2026, month: 3, day: 19, hour: 11, minute: 59 })), true);
  assert.equal(w.isOpen(ZonedDateTime.from({ timeZone: THR, year: 2026, month: 3, day: 19, hour: 12 })), false);
  const next = w.nextOpen(ZonedDateTime.from({ timeZone: THR, year: 2026, month: 3, day: 19, hour: 12 }));
  assert.equal(zs(next, THR), "2026-03-25T08:00:00+03:30[Asia/Tehran]");
  assert.equal(dayOf(next, THR), C.addBusinessDays(D("2026-03-19"), 1, { profile: "bank" }).date, "agrees with the day engine");
  // 3 business hours from Thursday 11:00 → 1h Thursday + 2h on Wednesday 1405/01/05
  assert.equal(zs(w.addBusinessHours(ZonedDateTime.from({ timeZone: THR, year: 2026, month: 3, day: 19, hour: 11 }), 3), THR), "2026-03-25T10:00:00+03:30[Asia/Tehran]");
  // weekday override by ISO number closes Thursdays
  const g = workingHours({ profiles: "ir", byWeekday: { 4: null } });
  assert.equal(g.sessions(D("2026-10-01")).length, 0, "Thursday");
  assert.equal(g.sessions(D("2026-09-30")).length, 1, "Wednesday");
  // ir:government closes Thursday through the profile itself
  assert.equal(workingHours({ profiles: "ir:government" }).sessions(D("2026-10-01")).length, 0);
});

test("working hours: split sessions, half days, several markets, DST-length days", () => {
  const w = workingHours({ profiles: "uk", hours: ["08:00-12:00", { open: "13:00", close: "16:00" }] });
  assert.equal(w.isOpen("2026-10-05T11:30:00Z"), false, "12:30 BST lunch");
  assert.equal(w.businessHoursBetween("2026-10-05T00:00:00Z", "2026-10-06T00:00:00Z"), 7);
  assert.equal(zs(w.addBusinessHours("2026-10-05T10:00:00Z", 2), LON), "2026-10-05T14:00:00+01:00[Europe/London]");
  // Türkiye: Republic Day eve (28 Oct) is a half day from 13:00
  const tr = workingHours({ profiles: "tr", hours: "09:00-18:00" });
  assert.equal(tr.timeZone, "Europe/Istanbul");
  const eve = tr.sessions(D("2026-10-28"));
  assert.equal(eve.length, 1);
  assert.equal(zs(eve[0].end, "Europe/Istanbul"), "2026-10-28T13:00:00+03:00[Europe/Istanbul]");
  assert.equal(workingHours({ profiles: "tr", hours: "09:00-18:00", halfDayClose: null }).sessions(D("2026-10-28"))[0].end.toZoned("Europe/Istanbul").hour, 18);
  assert.equal(tr.sessions(D("2026-10-29")).length, 0, "Republic Day");
  // SAR/USD in Riyadh hours: closed on Saudi National Day and on US holidays
  const sa = workingHours({ profiles: ["sa", "us"], hours: "10:00-15:00" });
  assert.equal(sa.timeZone, "Asia/Riyadh");
  assert.equal(sa.sessions(D("2026-09-23")).length, 0);
  assert.equal(sa.sessions(D("2026-09-22")).length, 1);
  assert.equal(sa.sessions(D("2026-09-27")).length, 0, "Sunday: open in Riyadh, closed in New York");
  // 24-hour sessions see 23- and 25-hour days
  M.registerMarket({ id: "test-always", weekend: [], holidays: [], timezone: THR });
  const all = workingHours({ profiles: "test-always", hours: "00:00-24:00" });
  assert.equal(all.businessHoursBetween(startOfDay(D("2021-03-22"), THR), startOfDay(D("2021-03-23"), THR)), 23);
  assert.equal(all.businessHoursBetween(startOfDay(D("2021-09-21"), THR), startOfDay(D("2021-09-22"), THR)), 25);
  const ny = workingHours({ profiles: "test-always", timeZone: NY, hours: "00:00-24:00" });
  assert.equal(ny.businessHoursBetween(startOfDay(D("2026-11-01"), NY), startOfDay(D("2026-11-02"), NY)), 25);
  // a session opening inside the gap starts when the clock jumps
  const gap = workingHours({ profiles: "test-always", timeZone: NY, hours: "02:30-04:00" });
  assert.equal(zs(gap.sessions(D("2026-03-08"))[0].start, NY), "2026-03-08T03:30:00-04:00[America/New_York]");
});

test("working hours: configuration errors", () => {
  assert.throws(() => workingHours({}), { code: "invalid_profiles" });
  assert.throws(() => workingHours({ profiles: "us", hours: "17:00-09:00" }), { code: "invalid_hours" });
  assert.throws(() => workingHours({ profiles: "us", hours: ["08:00-12:00", "11:00-16:00"] }), { code: "invalid_hours" });
  assert.throws(() => workingHours({ profiles: "us", hours: "9 to 5" }), { code: "invalid_hours" });
  assert.throws(() => workingHours({ profiles: "us", byWeekday: { 0: "09:00-12:00" } }), { code: "invalid_weekday" });
  assert.throws(() => workingHours({ profiles: "us", timeZone: "Nowhere/City" }), { code: "invalid_time_zone" });
  assert.throws(() => workingHours({ profiles: "zz" }), { code: "unknown_market" });
  M.registerMarket({ id: "test-never", weekend: [0, 1, 2, 3, 4, 5, 6], holidays: [], timezone: "UTC" });
  const never = workingHours({ profiles: "test-never" });
  assert.throws(() => never.nextOpen("2026-01-01T00:00:00Z"), { code: "no_business_time" });
  assert.throws(() => workingHours({ profiles: "us" }).addBusinessHours("2026-01-01T00:00:00Z", Infinity), { code: "invalid_hours" });
  assert.ok(new TimeError("x", "y") instanceof Error);
});
