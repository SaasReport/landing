/* @saasreport/calendar/time — the time layer over the day-granular engine.

   The engine counts whole days (integers, days since 1970-01-01). This module adds instants and wall-clock
   time without dependencies: time zones come from Intl (IANA tz database bundled with the runtime), so
   daylight saving time is right wherever the runtime's tzdata is — America/New_York and Europe/London
   every spring and autumn, and Asia/Tehran's historical DST (+04:30 in summer; the last period ended
   on 2022-09-21, and Iran has kept +03:30 all year since 2023).

   - Instant: an exact moment, epoch milliseconds (UTC).
   - ZonedDateTime: an Instant seen in an IANA time zone (wall-clock fields, offset, engine day number);
     plus/minus take years and months in a calendar (Gregorian, Jalali or Hijri; clamped to month end).
   - addMonths: engine day number + whole months in a calendar system.
   - LocalDate / LocalTime: a Gregorian date and a time of day without a zone.
   - startOfDay / endOfDay / dayBounds / dayOf: engine day number ↔ zoned instants.
   - formatDateTime: date (Jalali, Gregorian, Hijri) and time in fa, en or ar.
   - workingHours: market profiles + time zone + opening hours → isOpen, nextOpen, nextClose,
     addBusinessHours, businessHoursBetween.

   Weekdays here are ISO 8601: 1 = Monday … 7 = Sunday (see weekday.js).

   Wall-clock times that do not exist (spring-forward gap) or exist twice (autumn fold) follow Temporal's
   `disambiguation`: "compatible" (default: a gap moves forward by its length, a fold takes the earlier
   instant), "earlier", "later" or "reject" (throws TimeError "nonexistent_time" / "ambiguous_time"). */
import { formatDate, toDigits, DEFAULT_DIGITS } from "./locale.js";
import { market } from "./markets.js";
import * as B from "./business.js";
import { isoWeekday, parseWeekday } from "./weekday.js";
import * as IR from "./index.js";
import { toHijri, fromHijri, hijriMonthLength } from "./hijri.js";

const DAY = 86400000, HOUR = 3600000, MINUTE = 60000;
export class TimeError extends Error { constructor(code, message) { super(message); this.code = code; } }

const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, "0");
const dayOfUTC = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / DAY);
const isoDay = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const fullUTC = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => { const t = new Date(0); t.setUTCFullYear(y, mo - 1, d); t.setUTCHours(h, mi, s, ms); return t.getTime(); };

/* ------------------------------------------------------------------ time zones */
const FMT = new Map();
function zoneFormat(tz) {
  let f = FMT.get(tz);
  if (f) return f;
  try {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, calendar: "gregory", numberingSystem: "latn", hourCycle: "h23", era: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  } catch { throw new TimeError("invalid_time_zone", `Unknown time zone ${JSON.stringify(tz)} (use an IANA name such as "Asia/Tehran").`); }
  FMT.set(tz, f);
  return f;
}
/** True when tz is an IANA time zone this runtime knows. */
export function isValidTimeZone(tz) { if (typeof tz !== "string" || !tz) return false; try { zoneFormat(tz); return true; } catch { return false; /* Intl refuses it: not a valid time zone */ } }
/** The runtime's canonical name for tz ("asia/tehran" → "Asia/Tehran"). */
export const canonicalTimeZone = (tz) => zoneFormat(tz).resolvedOptions().timeZone;

// Wall-clock fields of an epoch ms in tz (whole seconds; ms carried separately).
function wallFields(ms, tz) {
  const o = {};
  for (const p of zoneFormat(tz).formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = p.value;
  let year = +o.year;
  if (o.era === "BC" || o.era === "B") year = 1 - year;
  const milli = ((ms % 1000) + 1000) % 1000;
  return { year, month: +o.month, day: +o.day, hour: +o.hour % 24, minute: +o.minute, second: +o.second, millisecond: milli };
}
/** UTC offset of tz at an instant, in minutes (Tehran: 210, or 270 in summer before 2022). */
export function offsetMinutes(epochMs, tz) {
  const w = wallFields(epochMs, tz);
  return Math.round((fullUTC(w.year, w.month, w.day, w.hour, w.minute, w.second, w.millisecond) - epochMs) / MINUTE);
}
export const formatOffset = (min) => `${min < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(min) / 60))}:${pad(Math.abs(min) % 60)}`;

/** Epoch ms of a wall-clock time in tz. See `disambiguation` above. */
export function wallToEpoch(tz, f, disambiguation = "compatible") {
  const { year, month = 1, day = 1, hour = 0, minute = 0, second = 0, millisecond = 0 } = f;
  const local = fullUTC(year, month, day, hour, minute, second, millisecond);
  const before = offsetMinutes(local - DAY, tz), after = offsetMinutes(local + DAY, tz);
  const hits = [...new Set([before, after])].map((o) => local - o * MINUTE).filter((t) => offsetMinutes(t, tz) * MINUTE === local - t).sort((a, b) => a - b);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) { // fold: the wall time happens twice
    if (disambiguation === "reject") throw new TimeError("ambiguous_time", `${fmtWall(f)} happens twice in ${tz}.`);
    return disambiguation === "later" ? hits[hits.length - 1] : hits[0];
  }
  // gap: the wall time does not exist
  if (disambiguation === "reject") throw new TimeError("nonexistent_time", `${fmtWall(f)} does not exist in ${tz} (clocks jump forward).`);
  return disambiguation === "earlier" ? local - after * MINUTE : local - before * MINUTE;
}
const fmtWall = (f) => `${pad(f.year, 4)}-${pad(f.month ?? 1)}-${pad(f.day ?? 1)}T${pad(f.hour ?? 0)}:${pad(f.minute ?? 0)}`;

/* ------------------------------------------------------------------ calendar months */
const MONTH_CALENDARS = ["gregorian", "jalali", "hijri", "hijri-umalqura", "hijri-civil"];
/** Engine day n moved by `months` whole months in a calendar system ("gregorian" (default), "jalali", "hijri" =
 *  "hijri-umalqura", "hijri-civil"). The day of the month is kept and clamped to the target month's last day
 *  (31 Shahrivar + 1 Jalali month = 30 Mehr; 31 January + 1 month = 28/29 February). Years are 12 months. */
export function addMonths(n, months, calendar = "gregorian") {
  if (!Number.isInteger(n)) throw new TimeError("invalid_date", `Not a day number: ${n}.`);
  if (!Number.isInteger(months)) throw new TimeError("invalid_duration", `Months must be a whole number (got ${months}).`);
  if (!MONTH_CALENDARS.includes(calendar)) throw new TimeError("invalid_calendar", `calendar must be one of ${MONTH_CALENDARS.join(", ")} (got ${JSON.stringify(calendar)}).`);
  if (!months) return n;
  const step = (y, m) => { const i = y * 12 + (m - 1) + months; return [Math.floor(i / 12), (i % 12) + 1]; };
  if (calendar === "gregorian") {
    const d = new Date(n * DAY), [y, m] = step(d.getUTCFullYear(), d.getUTCMonth() + 1);
    const len = new Date(fullUTC(y, m + 1, 0)).getUTCDate();
    return Math.floor(fullUTC(y, m, Math.min(d.getUTCDate(), len)) / DAY);
  }
  if (calendar === "jalali") {
    const j = IR.toJalali(n), [y, m] = step(j.jy, j.jm);
    return IR.fromJalali(y, m, Math.min(j.jd, IR.monthLength(y, m)));
  }
  const variant = calendar === "hijri-civil" ? "civil" : "umalqura";
  const h = toHijri(n, variant), [y, m] = step(h.hy, h.hm);
  return fromHijri(y, m, Math.min(h.hd, hijriMonthLength(y, m, variant)), variant);
}
// Every duration unit plus() accepts; anything else (a typo such as { month: 1 }) throws.
const UNITS = { instant: ["days", "hours", "minutes", "seconds", "milliseconds"], zoned: ["years", "months", "weeks", "days", "hours", "minutes", "seconds", "milliseconds"] };
function checkDuration(d, kind) {
  if (d == null || typeof d !== "object") throw new TimeError("invalid_duration", "A duration must be an object such as { days: 1, hours: 2 }.");
  for (const [k, v] of Object.entries(d)) {
    if (!UNITS[kind].includes(k)) throw new TimeError("invalid_duration", `Unknown duration unit ${JSON.stringify(k)}${kind === "instant" && (k === "months" || k === "years" || k === "weeks") ? " (an Instant has no calendar: use ZonedDateTime.plus)" : ""}; use ${UNITS[kind].join(", ")}.`);
    if (typeof v !== "number" || !Number.isFinite(v)) throw new TimeError("invalid_duration", `${k} must be a finite number (got ${JSON.stringify(v)}).`);
    if ((k === "years" || k === "months") && !Number.isInteger(v)) throw new TimeError("invalid_duration", `${k} must be a whole number (got ${v}).`);
  }
  return d;
}

/* ------------------------------------------------------------------ ISO datetime text */
// 2026-03-08T07:30:00Z, 2026-03-08 03:30-04:00, 2026-03-08T03:30:00.250+04:30[Asia/Tehran]
export const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?(?:\[([^\]]+)\])?$/i;
/** Split an ISO datetime into fields (no zone resolution). null when the text is not one. */
export function isoDateTimeFields(text) {
  const m = ISO_DATETIME.exec(String(text).trim());
  if (!m) return null;
  const f = { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: +(m[6] || 0), millisecond: m[7] ? Math.floor(+`0.${m[7]}` * 1000) : 0 };
  let offset = null;
  if (m[8]) {
    if (/^z$/i.test(m[8])) offset = 0;
    else { const s = m[8][0] === "-" ? -1 : 1, d = m[8].slice(1).replace(":", ""); const h = +d.slice(0, 2), mi = +(d.slice(2) || 0); offset = h > 23 || mi > 59 ? NaN : s * (h * 60 + mi); }
  }
  return { ...f, offset, timeZone: m[9] || null };
}
function validFields(f) {
  if (![f.year, f.month, f.day].every(Number.isInteger)) return false;
  const d = new Date(fullUTC(f.year, f.month, f.day));
  if (d.getUTCFullYear() !== f.year || d.getUTCMonth() + 1 !== f.month || d.getUTCDate() !== f.day) return false;
  const { hour = 0, minute = 0, second = 0, millisecond = 0 } = f;
  return hour >= 0 && (hour < 24 || (hour === 24 && !minute && !second && !millisecond)) && minute >= 0 && minute < 60 && second >= 0 && second < 60;
}

/* ------------------------------------------------------------------ Instant */
export class Instant {
  constructor(epochMs) {
    if (!Number.isFinite(epochMs) || Math.abs(epochMs) > 8.64e15) throw new TimeError("invalid_instant", `Not a valid epoch ms: ${epochMs}.`);
    this.epochMs = Math.trunc(epochMs);
    Object.freeze(this);
  }
  /** Instant from an Instant, a ZonedDateTime, a Date, epoch ms, or ISO text with an offset (or Z). */
  static from(v) {
    if (v instanceof Instant) return v;
    if (v instanceof ZonedDateTime) return v.toInstant();
    if (v instanceof Date) return new Instant(v.getTime());
    if (typeof v === "number") return new Instant(v);
    if (typeof v === "string") {
      const f = isoDateTimeFields(v);
      if (!f) throw new TimeError("invalid_format", `Not an ISO datetime: ${JSON.stringify(v)}.`);
      if (!validFields(f)) throw new TimeError("invalid_date", `No such date or time: ${JSON.stringify(v)}.`);
      if (f.offset == null) {
        if (!f.timeZone) throw new TimeError("missing_offset", `An instant needs an offset or Z: ${JSON.stringify(v)}.`);
        return new Instant(wallToEpoch(f.timeZone, f));
      }
      if (Number.isNaN(f.offset)) throw new TimeError("invalid_offset", `Invalid UTC offset in ${JSON.stringify(v)}.`);
      return new Instant(fullUTC(f.year, f.month, f.day, f.hour, f.minute, f.second, f.millisecond) - f.offset * MINUTE);
    }
    throw new TimeError("invalid_instant", "Instant.from needs an Instant, Date, epoch ms or ISO string.");
  }
  static now() { return new Instant(Date.now()); }
  static fromEpochSeconds(s) { return new Instant(s * 1000); }
  get epochSeconds() { return Math.floor(this.epochMs / 1000); }
  /** Exact-time arithmetic: { days (×24h), hours, minutes, seconds, milliseconds }. */
  plus(d = {}) { const { days = 0, hours = 0, minutes = 0, seconds = 0, milliseconds = 0 } = checkDuration(d, "instant"); return new Instant(this.epochMs + days * DAY + hours * HOUR + minutes * MINUTE + seconds * 1000 + milliseconds); }
  minus(d = {}) { return this.plus(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, -v]))); }
  until(other) { return Instant.from(other).epochMs - this.epochMs; }
  compare(other) { return Math.sign(this.epochMs - Instant.from(other).epochMs); }
  equals(other) { return this.compare(other) === 0; }
  toZoned(timeZone) { return ZonedDateTime.fromInstant(this, timeZone); }
  toDate() { return new Date(this.epochMs); }
  toString() { return new Date(this.epochMs).toISOString(); }
  toJSON() { return this.toString(); }
  valueOf() { return this.epochMs; }
  /** `${instant}` and "" + instant give the ISO text; +instant, a - b and a < b use epoch ms. */
  [Symbol.toPrimitive](hint) { return hint === "number" ? this.epochMs : this.toString(); }
}

/* ------------------------------------------------------------------ LocalDate / LocalTime */
export class LocalDate {
  constructor(year, month, day) {
    if (![year, month, day].every(Number.isInteger) || !validFields({ year, month, day, hour: 0, minute: 0, second: 0 })) throw new TimeError("invalid_date", `No such date: ${year}-${month}-${day}.`);
    Object.assign(this, { year, month, day });
    Object.freeze(this);
  }
  static of(y, m, d) { return new LocalDate(y, m, d); }
  /** From an engine day number. */
  static fromDay(n) { const d = new Date(n * DAY); return new LocalDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }
  static parse(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim()); if (!m) throw new TimeError("invalid_format", `Not an ISO date: ${JSON.stringify(s)}.`); return new LocalDate(+m[1], +m[2], +m[3]); }
  /** The engine's day number (days since 1970-01-01). */
  get dayNumber() { return Math.floor(fullUTC(this.year, this.month, this.day) / DAY); }
  get isoWeekday() { return isoWeekday(this.dayNumber); }
  plusDays(k) { return LocalDate.fromDay(this.dayNumber + k); }
  compare(o) { return Math.sign(this.dayNumber - o.dayNumber); }
  equals(o) { return this.compare(o) === 0; }
  toString() { return `${pad(this.year, 4)}-${pad(this.month)}-${pad(this.day)}`; }
  toJSON() { return this.toString(); }
}

export class LocalTime {
  constructor(hour = 0, minute = 0, second = 0, millisecond = 0) {
    const ok = [hour, minute, second, millisecond].every(Number.isInteger) && minute >= 0 && minute < 60 && second >= 0 && second < 60 && millisecond >= 0 && millisecond < 1000
      && hour >= 0 && (hour < 24 || (hour === 24 && !minute && !second && !millisecond));
    if (!ok) throw new TimeError("invalid_time", `No such time of day: ${hour}:${minute}:${second}.`);
    Object.assign(this, { hour, minute, second, millisecond });
    Object.freeze(this);
  }
  static of(h, m = 0, s = 0, ms = 0) { return new LocalTime(h, m, s, ms); }
  /** "08:00", "8:30", "16:45:10", "24:00" (end of day), Persian or Arabic-Indic digits. */
  static parse(s) {
    if (s instanceof LocalTime) return s;
    const t = String(s ?? "").trim().replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
    if (!m) throw new TimeError("invalid_time", `Not a time of day (HH:mm): ${JSON.stringify(s)}.`);
    return new LocalTime(+m[1], +m[2], +(m[3] || 0));
  }
  static fromMilliseconds(ms) { return new LocalTime(Math.floor(ms / HOUR), Math.floor(ms / MINUTE) % 60, Math.floor(ms / 1000) % 60, ms % 1000); }
  /** Milliseconds since midnight. */
  get milliseconds() { return this.hour * HOUR + this.minute * MINUTE + this.second * 1000 + this.millisecond; }
  compare(o) { return Math.sign(this.milliseconds - LocalTime.parse(o).milliseconds); }
  toString() { return `${pad(this.hour)}:${pad(this.minute)}${this.second || this.millisecond ? `:${pad(this.second)}` : ""}${this.millisecond ? `.${pad(this.millisecond, 3)}` : ""}`; }
  toJSON() { return this.toString(); }
}

/* ------------------------------------------------------------------ ZonedDateTime */
export class ZonedDateTime {
  constructor(epochMs, timeZone) {
    const instant = new Instant(epochMs);
    const tz = canonicalTimeZone(timeZone);
    const w = wallFields(instant.epochMs, tz);
    Object.assign(this, { epochMs: instant.epochMs, timeZone: tz, ...w, offsetMinutes: Math.round((fullUTC(w.year, w.month, w.day, w.hour, w.minute, w.second, w.millisecond) - instant.epochMs) / MINUTE) });
    Object.freeze(this);
  }
  static fromInstant(i, timeZone) { return new ZonedDateTime(Instant.from(i).epochMs, timeZone); }
  /** From wall-clock fields: { timeZone, year, month, day, hour?, minute?, second?, millisecond? }; or ISO text
   *  "2026-03-08T03:30-04:00[America/New_York]" (an offset that disagrees with the zone throws offset_mismatch). */
  static from(v, { disambiguation = "compatible", timeZone } = {}) {
    if (v instanceof ZonedDateTime) return timeZone ? v.withTimeZone(timeZone) : v;
    if (typeof v === "string") {
      const f = isoDateTimeFields(v);
      if (!f) throw new TimeError("invalid_format", `Not an ISO datetime: ${JSON.stringify(v)}.`);
      if (!validFields(f)) throw new TimeError("invalid_date", `No such date or time: ${JSON.stringify(v)}.`);
      const tz = f.timeZone || timeZone;
      if (f.offset == null) { if (!tz) throw new TimeError("missing_offset", "A zoned datetime needs a time zone or an offset."); return new ZonedDateTime(wallToEpoch(tz, f, disambiguation), tz); }
      if (Number.isNaN(f.offset)) throw new TimeError("invalid_offset", `Invalid UTC offset in ${JSON.stringify(v)}.`);
      const ms = fullUTC(f.year, f.month, f.day, f.hour, f.minute, f.second, f.millisecond) - f.offset * MINUTE;
      const z = new ZonedDateTime(ms, tz || "UTC");
      if (f.timeZone && z.offsetMinutes !== f.offset) throw new TimeError("offset_mismatch", `${formatOffset(f.offset)} is not the offset of ${f.timeZone} at that time (${formatOffset(z.offsetMinutes)}).`);
      return z;
    }
    if (v && typeof v === "object") {
      const tz = v.timeZone || timeZone;
      if (!tz) throw new TimeError("invalid_time_zone", "ZonedDateTime.from needs a timeZone.");
      const f = { hour: 0, minute: 0, second: 0, millisecond: 0, ...v };
      if (!validFields(f)) throw new TimeError("invalid_date", `No such date or time: ${fmtWall(f)}.`);
      return new ZonedDateTime(wallToEpoch(tz, f, disambiguation), tz);
    }
    throw new TimeError("invalid_format", "ZonedDateTime.from needs fields, ISO text or a ZonedDateTime.");
  }
  /** The engine's day number of the local date. */
  get dayNumber() { return dayOfUTC(this.year, this.month, this.day); }
  get isoWeekday() { return isoWeekday(this.dayNumber); }
  get offset() { return formatOffset(this.offsetMinutes); }
  /** Length of this local day in hours (23 or 25 on DST change days). */
  get hoursInDay() { const b = dayBounds(this.dayNumber, this.timeZone); return (b.end.epochMs - b.start.epochMs) / HOUR; }
  toInstant() { return new Instant(this.epochMs); }
  toLocalDate() { return new LocalDate(this.year, this.month, this.day); }
  toLocalTime() { return new LocalTime(this.hour, this.minute, this.second, this.millisecond); }
  withTimeZone(tz) { return new ZonedDateTime(this.epochMs, tz); }
  /** Same date, another wall-clock time ("compatible" across gaps by default). */
  withTime(t, { disambiguation = "compatible" } = {}) { const lt = LocalTime.parse(t); return ZonedDateTime.from({ timeZone: this.timeZone, year: this.year, month: this.month, day: this.day, hour: lt.hour, minute: lt.minute, second: lt.second, millisecond: lt.millisecond }, { disambiguation }); }
  startOfDay() { return startOfDay(this.dayNumber, this.timeZone); }
  /** Calendar arithmetic, in Temporal's order: years and months (in `calendar`: "gregorian" by default, "jalali",
   *  "hijri" / "hijri-umalqura" or "hijri-civil"; the day of the month is clamped to the target month's length), then
   *  weeks and days (all of these keep the wall-clock time, so a day can be 23 or 25 hours across DST), then
   *  hours/minutes/seconds/milliseconds as exact time. Unknown units and fractional months or years throw
   *  TimeError "invalid_duration". */
  plus(dur = {}, { disambiguation = "compatible", calendar = "gregorian" } = {}) {
    const { years = 0, months = 0, weeks = 0, days = 0, hours = 0, minutes = 0, seconds = 0, milliseconds = 0 } = checkDuration(dur, "zoned");
    if (!MONTH_CALENDARS.includes(calendar)) throw new TimeError("invalid_calendar", `calendar must be one of ${MONTH_CALENDARS.join(", ")} (got ${JSON.stringify(calendar)}).`);
    let z = this;
    const dd = days + weeks * 7, mm = years * 12 + months;
    const target = (mm ? addMonths(this.dayNumber, mm, calendar) : this.dayNumber) + dd;
    if (target !== this.dayNumber) { const d = new Date(target * DAY); z = ZonedDateTime.from({ timeZone: this.timeZone, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: this.hour, minute: this.minute, second: this.second, millisecond: this.millisecond }, { disambiguation }); }
    const ms = hours * HOUR + minutes * MINUTE + seconds * 1000 + milliseconds;
    return ms ? new ZonedDateTime(z.epochMs + ms, this.timeZone) : z;
  }
  minus(d = {}, o) { return this.plus(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, -v])), o); }
  compare(o) { return Math.sign(this.epochMs - Instant.from(o).epochMs); }
  equals(o) { return o instanceof ZonedDateTime && o.epochMs === this.epochMs && o.timeZone === this.timeZone; }
  /** "2026-03-08T03:30:00-04:00[America/New_York]" */
  toString() { return `${pad(this.year, 4)}-${pad(this.month)}-${pad(this.day)}T${pad(this.hour)}:${pad(this.minute)}:${pad(this.second)}${this.millisecond ? `.${pad(this.millisecond, 3)}` : ""}${this.offset}[${this.timeZone}]`; }
  toJSON() { return this.toString(); }
  valueOf() { return this.epochMs; }
  /** String(z), `${z}` and "" + z give the ISO text with offset and [zone]; +z, a - b and a < b use epoch ms. */
  [Symbol.toPrimitive](hint) { return hint === "number" ? this.epochMs : this.toString(); }
}

/* ------------------------------------------------------------------ day number ↔ zoned */
/** First instant of local day n in tz (01:00 when midnight falls in a DST gap, as in Tehran on 2021-03-22). */
export function startOfDay(n, timeZone) {
  const d = new Date(n * DAY);
  return new ZonedDateTime(wallToEpoch(timeZone, { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }, "compatible"), timeZone);
}
/** Last millisecond of local day n in tz (the instant before the next day starts). */
export const endOfDay = (n, timeZone) => new ZonedDateTime(startOfDay(n + 1, timeZone).epochMs - 1, timeZone);
/** { start, end (exclusive, = next day's start), hours } of local day n in tz. */
export function dayBounds(n, timeZone) {
  const start = startOfDay(n, timeZone).toInstant(), end = startOfDay(n + 1, timeZone).toInstant();
  return { day: n, iso: isoDay(n), start, end, hours: (end.epochMs - start.epochMs) / HOUR };
}
/** Engine day number of the local date of an instant in tz. dayOf(Instant.now(), "Asia/Tehran") === today(). */
export function dayOf(instant, timeZone) { const w = wallFields(Instant.from(instant).epochMs, canonicalTimeZone(timeZone)); return dayOfUTC(w.year, w.month, w.day); }

/* ------------------------------------------------------------------ formatting */
const DEFAULT_SYSTEM = { fa: "jalali", ar: "gregorian", en: "gregorian" };
/** Date and time in a calendar and locale: "۸ مهر ۱۴۰۵، ۰۸:۳۰", "30 September 2026, 08:30", "٨ ربيع الآخر ١٤٤٨ هـ، ٠٨:٣٠".
 *  options: timeZone (required for an Instant), locale (fa | en | ar), system (jalali | gregorian | hijri |
 *  hijri-umalqura | hijri-civil; default jalali for fa, gregorian otherwise), seconds, offset (append "+03:30"),
 *  timeZoneName (append the zone id), weekday, digits, pack, variant, era. */
export function formatDateTime(v, { timeZone, locale = "en", system, seconds = false, offset = false, timeZoneName = false, ...rest } = {}) {
  const z = v instanceof ZonedDateTime ? (timeZone ? v.withTimeZone(timeZone) : v) : ZonedDateTime.fromInstant(Instant.from(v), timeZone || "UTC");
  const lang = String(rest.pack?.code || locale).slice(0, 2);
  const sys = system === "hijri" ? "hijri-umalqura" : system || DEFAULT_SYSTEM[lang] || "gregorian";
  const date = formatDate(z.dayNumber, { ...rest, locale, system: sys });
  const digits = rest.digits || rest.pack?.digits || DEFAULT_DIGITS[lang] || "latin";
  let time = `${pad(z.hour)}:${pad(z.minute)}${seconds ? `:${pad(z.second)}` : ""}`;
  if (offset) time += ` ${z.offset}`;
  time = toDigits(time, digits);
  // The offset's sign stays Latin-direction: wrap it so RTL text does not reorder "+03:30".
  if (offset && lang !== "en") time = time.replace(/([+-][^ ]+)$/, "⁦$1⁩");
  const zone = timeZoneName ? ` (${z.timeZone})` : "";
  return `${date}${lang === "en" ? ", " : "، "}${time}${zone}`;
}

/* ------------------------------------------------------------------ working hours */
// hours: "08:00-16:00" | ["08:00-12:00", "13:00-16:00"] | { open, close } | [{ open, close }] | null (closed)
function parseSessions(v, where) {
  if (v == null || v === false) return [];
  const list = Array.isArray(v) ? v : [v];
  const out = list.map((s) => {
    let open, close;
    if (typeof s === "string") { const m = s.split(/\s*[-–]\s*/); if (m.length !== 2) throw new TimeError("invalid_hours", `${where}: hours must look like "08:00-16:00" (got ${JSON.stringify(s)}).`); [open, close] = m; }
    else if (s && typeof s === "object") ({ open, close } = s);
    else throw new TimeError("invalid_hours", `${where}: invalid session ${JSON.stringify(s)}.`);
    const a = LocalTime.parse(open), b = LocalTime.parse(close);
    if (b.milliseconds <= a.milliseconds) throw new TimeError("invalid_hours", `${where}: a session must close after it opens (overnight sessions are not supported): ${a}–${b}.`);
    return { open: a, close: b };
  }).sort((x, y) => x.open.milliseconds - y.open.milliseconds);
  for (let i = 1; i < out.length; i++) if (out[i].open.milliseconds < out[i - 1].close.milliseconds) throw new TimeError("invalid_hours", `${where}: sessions overlap.`);
  return out;
}
const MAX_DAYS = 3660;

/** Opening hours over market profiles in one time zone.
 *  workingHours({ profiles: "us", hours: "09:00-17:00" }) — timeZone defaults to the first profile's.
 *  byWeekday: { 4: "08:00-12:00", thursday: null, … } overrides the hours by ISO weekday (or name); null closes.
 *  halfDayClose: closing time on half days (Türkiye's eves; "13:00" by default; null ignores half days).
 *  A day has sessions only when it is a business day for every profile (business.js) on its local date. */
export function workingHours({ profiles, timeZone, hours = "09:00-17:00", byWeekday = {}, halfDayClose = "13:00" } = {}) {
  if (profiles == null || (Array.isArray(profiles) && !profiles.length)) throw new TimeError("invalid_profiles", "workingHours needs at least one market profile.");
  const list = (Array.isArray(profiles) ? profiles : [profiles]).map((p) => market(p));
  const tz = canonicalTimeZone(timeZone || list[0].timeZone || list[0].timezone || "UTC");
  const base = parseSessions(hours, "hours");
  const overrides = {};
  for (const [k, v] of Object.entries(byWeekday || {})) {
    const wd = parseWeekday(/^\d+$/.test(k) ? +k : k);
    if (wd == null) throw new TimeError("invalid_weekday", `byWeekday: unknown ISO weekday ${JSON.stringify(k)} (1 = Monday … 7 = Sunday).`);
    overrides[wd] = parseSessions(v, `byWeekday.${k}`);
  }
  const half = halfDayClose == null ? null : LocalTime.parse(halfDayClose);
  const cache = new Map();

  /** Sessions of local day n: [{ start, end }] as Instants (empty when closed). */
  function sessions(n) {
    let s = cache.get(n);
    if (s) return s;
    const st = B.dayStatus(n, list);
    s = [];
    if (st.business) {
      let defs = overrides[isoWeekday(n)] ?? base;
      if (st.half && half) defs = defs.filter((d) => d.open.milliseconds < half.milliseconds).map((d) => ({ open: d.open, close: d.close.milliseconds > half.milliseconds ? half : d.close }));
      const date = new Date(n * DAY), f = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
      const at = (t) => (t.hour === 24 ? startOfDay(n + 1, tz).epochMs : wallToEpoch(tz, { ...f, hour: t.hour, minute: t.minute, second: t.second, millisecond: t.millisecond }, "compatible"));
      for (const d of defs) { const a = at(d.open), b = at(d.close); if (b > a) s.push({ start: new Instant(a), end: new Instant(b) }); }
    }
    s = Object.freeze(s.map((x) => Object.freeze({ ...x, day: n, uncertain: st.uncertain })));
    if (cache.size > 4096) cache.clear();
    cache.set(n, s);
    return s;
  }
  const at = (i) => Instant.from(i);
  /** The session containing an instant, or null. Sessions are [start, end). */
  function sessionAt(i) {
    const t = at(i).epochMs, n = dayOf(t, tz);
    return sessions(n).find((s) => s.start.epochMs <= t && t < s.end.epochMs) || null;
  }
  const isOpen = (i) => sessionAt(i) != null;
  function scan(t, dir, pick) {
    const n0 = dayOf(t, tz);
    for (let k = 0; k <= MAX_DAYS; k++) {
      const n = n0 + dir * k, ss = dir > 0 ? sessions(n) : [...sessions(n)].reverse();
      for (const s of ss) { const r = pick(s); if (r) return r; }
    }
    throw new TimeError("no_business_time", `No open session within ${MAX_DAYS} days for ${list.map((m) => m.id).join("+")}.`);
  }
  /** The instant itself when open, else the start of the next session. */
  function nextOpen(i) { const t = at(i).epochMs; return scan(t, 1, (s) => (s.end.epochMs > t ? new Instant(Math.max(t, s.start.epochMs)) : null)); }
  /** The end of the current session when open, else the end of the next one. */
  function nextClose(i) { const t = at(i).epochMs; return scan(t, 1, (s) => (s.end.epochMs > t ? s.end : null)); }
  /** The latest instant at or before i that was open (the end of the previous session when closed). */
  function previousClose(i) { const t = at(i).epochMs; return scan(t, -1, (s) => (s.start.epochMs < t ? new Instant(Math.min(t, s.end.epochMs)) : null)); }
  /** Move by `h` business hours (fractional allowed; negative goes back). Landing on a session's end returns
   *  that closing instant (8 hours from 08:00 in an 08:00–16:00 day is 16:00 the same day). */
  function addBusinessHours(i, h) {
    if (typeof h !== "number" || !Number.isFinite(h) || Math.abs(h) > 24 * MAX_DAYS) throw new TimeError("invalid_hours", "Business hours must be a finite number.");
    const t = at(i).epochMs;
    let left = Math.round(Math.abs(h) * HOUR);
    if (left === 0) return nextOpen(t);
    if (h > 0) return scan(t, 1, (s) => {
      if (s.end.epochMs <= t) return null;
      const from = Math.max(t, s.start.epochMs), avail = s.end.epochMs - from;
      if (left <= avail) return new Instant(from + left);
      left -= avail; return null;
    });
    return scan(t, -1, (s) => {
      if (s.start.epochMs >= t) return null;
      const to = Math.min(t, s.end.epochMs), avail = to - s.start.epochMs;
      if (left <= avail) return new Instant(to - left);
      left -= avail; return null;
    });
  }
  /** Business hours between two instants (negative when b < a). */
  function businessHoursBetween(a, b) {
    let x = at(a).epochMs, y = at(b).epochMs, sign = 1;
    if (y < x) { [x, y] = [y, x]; sign = -1; }
    let ms = 0;
    for (let n = dayOf(x, tz); n <= dayOf(y, tz); n++) for (const s of sessions(n)) ms += Math.max(0, Math.min(y, s.end.epochMs) - Math.max(x, s.start.epochMs));
    return (sign * ms) / HOUR;
  }
  /** { open, session, day, business (business.js dayStatus of the local day) } at an instant. */
  function status(i) {
    const t = at(i).epochMs, n = dayOf(t, tz), s = sessionAt(t);
    return { open: !!s, session: s, day: n, iso: isoDay(n), business: B.dayStatus(n, list) };
  }
  return Object.freeze({ timeZone: tz, profiles: list.map((m) => m.id), sessions, sessionAt, isOpen, nextOpen, nextClose, previousClose, addBusinessHours, businessHoursBetween, status });
}
