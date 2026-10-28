/* @saasreport/calendar/parse — one input parser for the new APIs. It never throws: every call returns a tagged
   result, { ok: true, … } or { ok: false, error: { code, message } }.

   Accepted (Latin, Persian ۰–۹ or Arabic-Indic ٠–٩ digits; bidi marks are ignored):
   - ISO date                      2026-09-30, 2026/09/30            → Gregorian (years ≥ 1700)
   - ISO datetime with offset      2026-03-08T03:30:00-04:00, …Z, …+0330, …[Asia/Tehran]
                                   (without an offset only when options.timeZone is given, or a [zone] suffix)
   - Jalali (Solar Hijri)          1405/07/08, ۱۴۰۵-۰۷-۰۸, 1405/07/08 ه.ش   → years below 1700 are Jalali
   - Hijri (lunar)                 1447/09/01 هـ, ١٤٤٧/٠٩/٠١ هـ, 1447-09-01 AH, ۱۴۴۷/۰۹/۰۱ ق
                                   → options.hijri: "umalqura" (default) or "civil"
   - today, امروز, اليوم             → the local day in options.timeZone at options.now
   - month names                   ۹ مهر ۱۴۰۵, پنجشنبه ۹ مهر ۱۴۰۵, 9 Mehr 1405, ٢٠ ربيع الآخر ١٤٤٨ هـ, 1 October 2026,
                                   October 1, 2026 → the month name picks the calendar (Jalali, Hijri, Gregorian;
                                   en, fa and ar names). A leading weekday must match the date (else invalid_date).
   Names match across Arabic/Persian letter forms (ي/ی, ك/ک), digit sets and ZWNJ/space spellings (normalizeText).

   Result: { ok, input, kind: "date" | "datetime", system, day (engine day number of the date as written),
   iso, parts: { year, month, day } in `system`, weekday (ISO 1 = Monday … 7 = Sunday) } and, for a datetime,
   { instant, zoned, offsetMinutes, timeZone }.
   Error codes: empty, invalid_format, invalid_date, out_of_range, invalid_time, invalid_offset,
   missing_offset, offset_mismatch, invalid_time_zone, invalid_option, unsupported_calendar. */
import * as IR from "./index.js";
import { fromHijri, HijriError } from "./hijri.js";
import { Instant, ZonedDateTime, TimeError, isoDateTimeFields, isValidTimeZone, canonicalTimeZone, dayOf, wallToEpoch, offsetMinutes } from "./time.js";
import { isoWeekday, parseWeekday, normalizeText, foldName } from "./weekday.js";
import { monthNames } from "./locale.js";

export { normalizeText };

const DAY = 86400000;
const isoOf = (n) => new Date(n * DAY).toISOString().slice(0, 10);

/** Persian and Arabic-Indic digits → Latin; bidi and tatweel marks removed (letters unchanged; see normalizeText). */
export const normalizeDigits = (s) => String(s ?? "")
  .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
  .replace(/[‎‏؜‪-‮⁦-⁩ـ]/g, "").replace(/\s+/g, " ").trim();

const fail = (input, code, message) => ({ ok: false, input, error: { code, message } });
const MESSAGES = {
  empty: "Enter a date.",
  invalid_format: "Use 2026-09-30, 2026-03-08T03:30:00-04:00, 1405/07/08 (Jalali) or 1447/09/01 هـ (Hijri).",
};

// Suffixes: Jalali first (ه.ش contains ه), then Hijri.
const JALALI_SUFFIX = /\s*(?:هـ\s*\.?\s*ش|ه\s*\.?\s*ش|ش|SH|AP)\.?$/i;
const HIJRI_SUFFIX = /\s*(?:هـ\s*\.?\s*ق|ه\s*\.?\s*ق|هـ|ه‍|ه|ق|AH|A\.H\.?)$/i;
const YMD = /^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/;
const GREGORIAN_SUFFIX = /\s*(?:میلادی|م|AD|CE)\.?$/i;

/* ------------------------------------------------------------------ month names */
// Every month name the locale tables know (en, fa, ar; Arabic Gulf and Levant Gregorian), plus common English
// short forms and transliterations. A key that two calendars share would be ambiguous and is left out.
const EXTRA = {
  gregorian: { jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 },
  jalali: { amordad: 5, adhar: 9, esfand: 12, esfend: 12, "فروردين": 1 },
  hijri: { "rabi al-akhir": 4, "rabi i": 3, "rabi ii": 4, "rabi' al-awwal": 3, "rabi' al-thani": 4, "jumada i": 5, "jumada ii": 6, "jumada al-awwal": 5, "jumada al-thani": 6,
    shaban: 8, "dhu al-qadah": 11, "dhul qadah": 11, "dhul hijjah": 12, "ربیع‌الآخر": 4, "جمادی‌الاولی": 5, "جمادی‌الثانیه": 6, "جمادی‌الآخر": 6, "ذیقعده": 11, "ذیحجه": 12 },
};
let MONTH_KEYS = null;
function monthKeys() {
  if (MONTH_KEYS) return MONTH_KEYS;
  const seen = new Map();
  const add = (system, name, month) => {
    const k = foldName(name); if (!k) return;
    const prev = seen.get(k);
    if (prev === undefined) seen.set(k, { system, month });
    else if (prev && (prev.system !== system || prev.month !== month)) seen.set(k, null); // ambiguous
  };
  for (const system of ["gregorian", "jalali", "hijri"]) {
    const sys = system === "hijri" ? "hijri-umalqura" : system;
    for (const lang of ["en", "fa", "ar"]) monthNames(sys, lang).forEach((n, i) => add(system, n, i + 1));
    if (system === "gregorian") monthNames(sys, "ar", { variant: "levant" }).forEach((n, i) => add(system, n, i + 1));
    for (const [n, m] of Object.entries(EXTRA[system])) add(system, n, m);
  }
  MONTH_KEYS = new Map([...seen].filter(([, v]) => v));
  return MONTH_KEYS;
}
/** { system: "gregorian" | "jalali" | "hijri", month: 1–12 } for a month name in en, fa or ar (any letter forms,
 *  digits, ZWNJ or spacing); null when unknown. */
export function parseMonthName(name) {
  const hit = monthKeys().get(foldName(name));
  return hit ? { ...hit } : null;
}

function dateResult(input, system, day, parts) {
  return { ok: true, input, kind: "date", system, day, iso: isoOf(day), parts, weekday: isoWeekday(day) };
}

/** Parse a date or datetime. Never throws. */
export function parseInput(input, options = {}) {
  const { now = new Date(), hijri = "umalqura", disambiguation = "compatible" } = options;
  if (!["umalqura", "civil"].includes(hijri)) return fail(input, "invalid_option", `options.hijri must be "umalqura" or "civil" (got ${JSON.stringify(hijri)}).`);
  if (!["compatible", "earlier", "later", "reject"].includes(disambiguation)) return fail(input, "invalid_option", "options.disambiguation must be compatible, earlier, later or reject.");
  const tzGiven = options.timeZone != null;
  if (tzGiven && !isValidTimeZone(options.timeZone)) return fail(input, "invalid_time_zone", `Unknown time zone ${JSON.stringify(options.timeZone)}.`);
  const timeZone = tzGiven ? canonicalTimeZone(options.timeZone) : "UTC";

  if (typeof input === "number") {
    if (!Number.isInteger(input)) return fail(input, "invalid_format", "A day number must be an integer.");
    return dateResult(input, "gregorian", input, gParts(input));
  }
  if (input instanceof Date || input instanceof Instant || input instanceof ZonedDateTime) {
    try { return datetimeResult(input, Instant.from(input), input instanceof ZonedDateTime ? input.timeZone : timeZone, null); }
    catch (e) { return fail(input, e.code || "invalid_format", e.message); }
  }
  if (typeof input !== "string") return fail(input, "invalid_format", MESSAGES.invalid_format);
  const s = normalizeText(normalizeDigits(input));
  if (!s) return fail(input, "empty", MESSAGES.empty);

  try {
    if (/^(today|امروز|اليوم|الیوم)$/i.test(s)) { const n = dayOf(now, timeZone); return dateResult(input, "gregorian", n, gParts(n)); }

    // ISO datetime
    if (/^\d{4}-\d{2}-\d{2}[T ]\d/i.test(s)) {
      const f = isoDateTimeFields(s);
      if (!f) return fail(input, "invalid_format", MESSAGES.invalid_format);
      if (!(f.month >= 1 && f.month <= 12) || !gValid(f.year, f.month, f.day)) return fail(input, "invalid_date", `${f.year}-${f.month}-${f.day} is not a Gregorian date.`);
      if (!(f.hour <= 23 && f.minute <= 59 && f.second <= 59)) return fail(input, "invalid_time", "Time must be 00:00–23:59:59.");
      if (f.offset != null && Number.isNaN(f.offset)) return fail(input, "invalid_offset", "A UTC offset must be ±HH:MM (hours 00–23, minutes 00–59).");
      if (f.timeZone && !isValidTimeZone(f.timeZone)) return fail(input, "invalid_time_zone", `Unknown time zone ${JSON.stringify(f.timeZone)}.`);
      const zone = f.timeZone ? canonicalTimeZone(f.timeZone) : timeZone;
      const written = Math.floor(Date.UTC(f.year, f.month - 1, f.day) / DAY);
      let ms;
      if (f.offset == null) {
        if (!f.timeZone && !tzGiven) return fail(input, "missing_offset", "Add a UTC offset (Z, +03:30, -05:00) or pass options.timeZone.");
        ms = wallToEpoch(zone, f, disambiguation);
      } else {
        const local = new Date(0); local.setUTCFullYear(f.year, f.month - 1, f.day); local.setUTCHours(f.hour, f.minute, f.second, f.millisecond);
        ms = local.getTime() - f.offset * 60000;
        if (f.timeZone && offsetMinutes(ms, zone) !== f.offset) return fail(input, "offset_mismatch", `The offset does not match ${zone} at that time.`);
      }
      return datetimeResult(input, new Instant(ms), zone, written, f.offset);
    }

    // Dates with a month name: "۹ مهر ۱۴۰۵", "پنجشنبه ۹ مهر ۱۴۰۵", "1 October 2026", "October 1, 2026"
    if (/[^\d\s\/\-.:+،,]/.test(s.replace(JALALI_SUFFIX, "").replace(HIJRI_SUFFIX, "").replace(GREGORIAN_SUFFIX, ""))) {
      const named = parseNamed(input, s, hijri);
      if (named) return named;
    }

    // Hijri (needs its suffix), then Jalali / Gregorian
    let system = null, body = s;
    if (JALALI_SUFFIX.test(body)) { system = "jalali"; body = body.replace(JALALI_SUFFIX, "").trim(); }
    else if (HIJRI_SUFFIX.test(body)) { system = `hijri-${hijri}`; body = body.replace(HIJRI_SUFFIX, "").trim(); }
    const m = YMD.exec(body);
    if (!m) return fail(input, "invalid_format", MESSAGES.invalid_format);
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    if (!system) system = y < 1700 ? "jalali" : "gregorian";

    if (system === "gregorian") {
      if (!(mo >= 1 && mo <= 12) || !gValid(y, mo, d)) return fail(input, "invalid_date", `${y}-${mo}-${d} is not a Gregorian date.`);
      const n = Math.floor(Date.UTC(y, mo - 1, d) / DAY);
      return dateResult(input, "gregorian", n, { year: y, month: mo, day: d });
    }
    if (system === "jalali") {
      if (!(y >= IR.RANGE.min && y <= IR.RANGE.max)) return fail(input, "out_of_range", `Jalali years ${IR.RANGE.min}–${IR.RANGE.max} only.`);
      if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= IR.monthLength(y, mo))) return fail(input, "invalid_date", `${y}/${mo}/${d} is not a Jalali date${mo === 12 && d === 30 ? ` (${y} is not a leap year)` : ""}.`);
      return dateResult(input, "jalali", IR.fromJalali(y, mo, d), { year: y, month: mo, day: d });
    }
    const n = fromHijri(y, mo, d, hijri);
    return dateResult(input, system, n, { year: y, month: mo, day: d });
  } catch (e) {
    if (e instanceof HijriError || e instanceof TimeError || e instanceof IR.CalendarError) return fail(input, e.code === "invalid_variant" ? "invalid_option" : e.code, e.message);
    return fail(input, "invalid_format", e && e.message ? e.message : MESSAGES.invalid_format);
  }
}
// "[weekday] D Month Y [era]" or "[weekday] Month D Y [era]". null when the text is not in that shape.
function parseNamed(input, s, hijri) {
  let t = s.replace(/[،,]/g, " ").replace(/\s+/g, " ").trim(), era = null;
  if (JALALI_SUFFIX.test(t)) { const r = t.replace(JALALI_SUFFIX, "").trim(); if (/\d$/.test(r)) { era = "jalali"; t = r; } }
  if (!era && HIJRI_SUFFIX.test(t)) { const r = t.replace(HIJRI_SUFFIX, "").trim(); if (/\d$/.test(r)) { era = "hijri"; t = r; } }
  if (!era && GREGORIAN_SUFFIX.test(t)) { const r = t.replace(GREGORIAN_SUFFIX, "").trim(); if (/\d$/.test(r)) { era = "gregorian"; t = r; } }
  let prefix = "", day, month, year;
  let m = /^(\D*?)\s*(\d{1,2})\s+(\D+?)\s+(\d{1,4})$/.exec(t);
  if (m) { prefix = m[1].trim(); day = +m[2]; month = parseMonthName(m[3]); year = +m[4]; }
  else {
    m = /^(\D+?)\s+(\d{1,2})\s+(\d{1,4})$/.exec(t);
    if (!m) return null;
    day = +m[2]; year = +m[3];
    const words = m[1].trim().split(" ");
    for (let i = 0; i < words.length && !month; i++) { const mo = parseMonthName(words.slice(i).join(" ")); if (mo) { month = mo; prefix = words.slice(0, i).join(" "); } }
  }
  if (!month) return fail(input, "invalid_format", `Unknown month name. ${MESSAGES.invalid_format}`);
  if (era && era !== month.system) return fail(input, "invalid_format", `The era suffix does not match the ${month.system} month name.`);
  let wd = null;
  if (prefix) { wd = parseWeekday(prefix); if (wd == null) return fail(input, "invalid_format", `Unknown weekday ${JSON.stringify(prefix)}.`); }
  let n, system = month.system;
  if (system === "jalali") {
    if (!(year >= IR.RANGE.min && year <= IR.RANGE.max)) return fail(input, "out_of_range", `Jalali years ${IR.RANGE.min}–${IR.RANGE.max} only.`);
    if (!(day >= 1 && day <= IR.monthLength(year, month.month))) return fail(input, "invalid_date", `${year}/${month.month}/${day} is not a Jalali date.`);
    n = IR.fromJalali(year, month.month, day);
  } else if (system === "hijri") {
    system = `hijri-${hijri}`;
    n = fromHijri(year, month.month, day, hijri);
  } else {
    if (!gValid(year, month.month, day)) return fail(input, "invalid_date", `${year}-${month.month}-${day} is not a Gregorian date.`);
    const g = new Date(0); g.setUTCFullYear(year, month.month - 1, day); n = Math.floor(g.getTime() / DAY);
  }
  if (wd != null && wd !== isoWeekday(n)) return fail(input, "invalid_date", `${prefix} is not the weekday of that date.`);
  return dateResult(input, system, n, { year, month: month.month, day });
}

/** Same as parseInput (short name). */
export const parse = parseInput;

function gParts(n) { const d = new Date(n * DAY); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }; }
function gValid(y, m, d) { const t = new Date(0); t.setUTCFullYear(y, m - 1, d); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; }
function datetimeResult(input, instant, timeZone, writtenDay, offset) {
  const zoned = ZonedDateTime.fromInstant(instant, timeZone);
  const day = writtenDay ?? zoned.dayNumber;
  return { ok: true, input, kind: "datetime", system: "gregorian", day, iso: isoOf(day), parts: gParts(day), weekday: isoWeekday(day), instant, zoned, offsetMinutes: offset ?? zoned.offsetMinutes, timeZone: zoned.timeZone };
}
