/* @saasreport/calendar — financial calendar engine: Solar Hijri, Gregorian and lunar Hijri dates,
   official Iranian holidays, business days, settlement and instalment schedules.
   One dependency-free ES module, shared by the browser UI and the Worker API.

   Days are integers: days since 1970-01-01 (UTC). Every "today" is the civil day in
   Asia/Tehran. Solar Hijri is computed arithmetically here (Borkowski's leap-year breaks, as in
   jalaali-js, MIT), never from the runtime's ICU: ICU builds disagree (Workers put Nowruz 1405 a
   day early). Lunar Hijri comes from ICU islamic-civil, which is arithmetic — Iran fixes lunar holidays by moon sighting, so a
   computed lunar holiday is marked `predicted` (±1 day) until an official table for that
   year is registered with registerOfficialLunar(). Business logic never hides that
   uncertainty: results that depend on a predicted holiday carry `uncertain: true`. */

import { toJalali, nowruzDay, J_MONTH_NAMES } from "./instant.js";
import { COPY, fill } from "./copy.js";

export const VERSION = "1.4.0"; // keep equal to package.json (test/regressions.test.mjs checks it)
export const TZ = "Asia/Tehran";
export const RANGE = { min: 1300, max: 1500 };
const DAY = 86400000;

/* ------------------------------------------------------------------ names */
export const J_MONTHS = J_MONTH_NAMES.fa;
export const H_MONTHS = ["محرم", "صفر", "ربیع‌الاول", "ربیع‌الثانی", "جمادی‌الاول", "جمادی‌الثانی", "رجب", "شعبان", "رمضان", "شوال", "ذی‌القعده", "ذی‌الحجه"];
export const G_MONTHS = ["ژانویه", "فوریه", "مارس", "آوریل", "مه", "ژوئن", "ژوئیه", "اوت", "سپتامبر", "اکتبر", "نوامبر", "دسامبر"];
export const WEEKDAYS = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه"]; // index 0 = Saturday
export const SEASONS = ["بهار", "تابستان", "پاییز", "زمستان"];

const FA = "۰۱۲۳۴۵۶۷۸۹";
export const fa = (v) => String(v).replace(/\d/g, (d) => FA[d]);
export const latin = (s) => String(s).replace(/[۰-۹]/g, (d) => FA.indexOf(d)).replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
const pad = (n, w = 2) => String(n).padStart(w, "0");

/* ------------------------------------------------------------------ day numbers */
export const fromISO = (s) => Math.floor(Date.parse(`${s}T00:00:00Z`) / DAY);
export const toISO = (n) => new Date(n * DAY).toISOString().slice(0, 10);
// Legacy convention (kept unchanged): 0 = شنبه (Saturday) … 6 = جمعه (Friday). New code uses isoWeekday
// (ISO 8601: 1 = Monday … 7 = Sunday) and the converters in weekday.js.
export const weekday = (n) => (new Date(n * DAY).getUTCDay() + 1) % 7; // 0 = شنبه … 6 = جمعه
/** ISO weekday of day n: 1 = Monday … 7 = Sunday (the canonical convention; see weekday.js). */
export const isoWeekday = (n) => ((((n + 3) % 7) + 7) % 7) + 1;
function validZone(tz) { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return typeof tz === "string" && tz.length > 0; } catch { return false; /* Intl refuses it: not a valid time zone */ } }
export function today(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]));
  return fromISO(`${p.year}-${p.month}-${p.day}`);
}

const partsFmt = (cal) => new Intl.DateTimeFormat(`en-u-ca-${cal}-nu-latn`, { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric" });
const ISLAMIC = partsFmt("islamic-civil");
const read = (fmt, n) => { const o = {}; for (const p of fmt.formatToParts(new Date(n * DAY + DAY / 2))) if (p.type !== "literal") o[p.type] = parseInt(p.value, 10); return o; };

/* Solar Hijri, ICU-free: the arithmetic lives in instant.js (no imports, so the browser bundle carries the same code). */
export { toJalali };
export function toHijri(n) { const p = read(ISLAMIC, n); return { hy: p.year, hm: p.month, hd: p.day }; }
export function toGregorian(n) { const d = new Date(n * DAY); return { gy: d.getUTCFullYear(), gm: d.getUTCMonth() + 1, gd: d.getUTCDate() }; }

const nowruzCache = new Map();
export function nowruz(jy) {
  validateYear(jy);
  let n = nowruzCache.get(jy);
  if (n == null) { n = nowruzDay(jy); nowruzCache.set(jy, n); }
  return n;
}
export const isLeap = (jy) => nowruz(jy + 1) - nowruz(jy) === 366;
export const monthLength = (jy, jm) => (jm <= 6 ? 31 : jm <= 11 ? 30 : isLeap(jy) ? 30 : 29);
export function fromJalali(jy, jm, jd) {
  validateYear(jy);
  if (!(jm >= 1 && jm <= 12) || !(jd >= 1 && jd <= monthLength(jy, jm))) throw new CalendarError("invalid_date", fill(COPY.errors.invalid_date, { jy: fa(jy), jm: fa(jm), jd: fa(jd) }));
  return nowruz(jy) + (jm <= 6 ? (jm - 1) * 31 : 186 + (jm - 7) * 30) + jd - 1;
}
function validateYear(jy) { if (!(jy >= RANGE.min - 1 && jy <= RANGE.max + 1)) throw new CalendarError("out_of_range", fill(COPY.errors.out_of_range, { min: fa(RANGE.min), max: fa(RANGE.max) })); }

export class CalendarError extends Error { constructor(code, message) { super(message); this.code = code; } }

/* Accepts 1405/07/07, ۱۴۰۵-۰۷-۰۷, 2026-09-29, "today" (years below 1700 are Jalali). */
export function parseDate(input, now) {
  if (typeof input === "number") return input;
  const s = latin(String(input ?? "").trim());
  if (!s || s === "today" || s === COPY.today) return today(now);
  const m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (!m) throw new CalendarError("invalid_date", COPY.errors.date_format);
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (y < 1700) return fromJalali(y, mo, d);
  const n = fromISO(`${y}-${pad(mo)}-${pad(d)}`);
  if (Number.isNaN(n) || toGregorian(n).gd !== d) throw new CalendarError("invalid_date", COPY.errors.gregorian_invalid);
  return n;
}

/* ------------------------------------------------------------------ holidays */
// Official public holidays, from the calendar's copy (copy.js): Solar Hijri, lunar Hijri (day 0 = last day of the month) and the
// non-holiday markers that matter to finance and everyday use (kind decides how they render).
const SOLAR_HOLIDAYS = COPY.holidays.solar, LUNAR_HOLIDAYS = COPY.holidays.lunar, SOLAR_MARKERS = COPY.holidays.markers;

// Official lunar tables: { [jy]: { "hm-hd": "jm-jd" } }. Registered years override prediction.
const OFFICIAL = {};
export function registerOfficialLunar(table) { for (const [y, rows] of Object.entries(table || {})) { OFFICIAL[+y] = { ...rows }; hCache.delete(+y); } }
export const officialYears = () => Object.keys(OFFICIAL).map(Number).sort();

const hCache = new Map();
/** All holidays and markers in a Jalali year → Map(dayNumber → entry[]). */
export function yearEvents(jy) {
  let map = hCache.get(jy);
  if (map) return map;
  map = new Map();
  const add = (n, e) => { const l = map.get(n) || []; l.push(e); map.set(n, l); };
  for (const [m, d, t] of SOLAR_HOLIDAYS) add(fromJalali(jy, m, d), { title: t, holiday: true, kind: "solar", status: "official" });
  for (const [m, d, t, k] of SOLAR_MARKERS) add(fromJalali(jy, m, d === -1 ? monthLength(jy, m) : d), { title: t, holiday: false, kind: k, status: "fixed" });
  const start = nowruz(jy), end = nowruz(jy + 1);
  const official = OFFICIAL[jy];
  for (let n = start; n < end; n++) {
    const h = toHijri(n), last = toHijri(n + 1).hd === 1;
    for (const [hm, hd, t] of LUNAR_HOLIDAYS) {
      if (h.hm !== hm || !(hd === h.hd || (hd === 0 && last))) continue;
      const key = `${hm}-${hd === 0 ? "last" : hd}`;
      if (official && official[key]) {
        const [om, od] = official[key].split("-").map(Number);
        add(fromJalali(jy, om, od), { title: t, holiday: true, kind: "lunar", status: "official", hijri: key });
      } else add(n, { title: t, holiday: true, kind: "lunar", status: "predicted", hijri: key });
    }
  }
  hCache.set(jy, map);
  return map;
}
export const eventsOn = (n) => yearEvents(toJalali(n).jy).get(n) || [];
export const holidaysOn = (n) => eventsOn(n).filter((e) => e.holiday);
export function holidays(jy) {
  return [...yearEvents(jy)].flatMap(([n, l]) => l.filter((e) => e.holiday).map((e) => ({ ...e, date: n }))).sort((a, b) => a.date - b.date);
}

/* ------------------------------------------------------------------ business days */
// Friday is the Iranian weekend. Thursday is a working day for banks and the payment
// network but not for most government offices, so weekend is a profile, not a constant.
export const PROFILES = {
  bank: { title: "بانک و شبکه پرداخت", weekend: [6] },
  government: { title: "دستگاه‌های دولتی", weekend: [5, 6] },
  market: { title: "بازار سرمایه", weekend: [5, 6] },
};
const weekendOf = (o = {}) => o.weekend || PROFILES[o.profile || "bank"].weekend;

// opts.holidays === false ignores the built-in (Iranian) holiday table: weekends only.
const holidaysFor = (n, opts) => (opts && opts.holidays === false ? [] : holidaysOn(n));
export function dayStatus(n, opts) {
  const hol = holidaysFor(n, opts), wk = weekendOf(opts).includes(weekday(n));
  return { business: !wk && !hol.length, weekend: wk, holiday: hol.length > 0, uncertain: predictedMatters(n, opts) };
}
export const isBusinessDay = (n, opts) => dayStatus(n, opts).business;

// True when a predicted lunar holiday falls in [a, b] on a day that would otherwise be a
// working day — only then can moon sighting move the result. A prediction that lands on
// Friday or on an official holiday changes nothing.
function touchesPredicted(a, b, opts) {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  for (let n = lo; n <= hi; n++) if (predictedMatters(n, opts)) return true;
  return false;
}
function predictedMatters(n, opts) {
  const hol = holidaysFor(n, opts);
  return hol.some((h) => h.status === "predicted") && !hol.some((h) => h.status === "official") && !weekendOf(opts).includes(weekday(n));
}

export const CONVENTIONS = {
  following: "روز کاری بعد",
  modified_following: "روز کاری بعد، مگر به ماه بعد برود",
  preceding: "روز کاری قبل",
  modified_preceding: "روز کاری قبل، مگر به ماه قبل برود",
  none: "بدون تعدیل",
  nearest: "نزدیک‌ترین روز کاری (در تساوی، روز کاری بعد)",
};
export function adjust(n, convention = "following", opts) {
  if (!(convention in CONVENTIONS)) throw new CalendarError("invalid_convention", COPY.errors.invalid_convention);
  if (convention === "none" || isBusinessDay(n, opts)) return { date: n, moved: 0, uncertain: touchesPredicted(n, n, opts) };
  const step = (dir) => { let d = n; do d += dir; while (!isBusinessDay(d, opts)); return d; };
  let d;
  if (convention === "nearest") { const f = step(1), p = step(-1); d = f - n <= n - p ? f : p; } // ties go forward
  else d = convention.endsWith("preceding") ? step(-1) : step(1);
  if (convention.startsWith("modified_") && toJalali(d).jm !== toJalali(n).jm) d = convention === "modified_following" ? step(-1) : step(1);
  return { date: d, moved: d - n, uncertain: touchesPredicted(n, d, opts) };
}
export function addBusinessDays(n, k, opts) {
  if (!Number.isInteger(k) || Math.abs(k) > 3650) throw new CalendarError("invalid_days", COPY.errors.invalid_days);
  if (k === 0) return adjust(n, "following", opts);
  let d = n, left = Math.abs(k); const dir = Math.sign(k);
  while (left) { d += dir; if (isBusinessDay(d, opts)) left--; }
  return { date: d, moved: d - n, uncertain: touchesPredicted(n, d, opts) };
}
/** Business days in (a, b] — the count a T+n settlement uses. Negative when b < a. */
export function businessDaysBetween(a, b, opts) {
  const [lo, hi, s] = a <= b ? [a, b, 1] : [b, a, -1];
  let c = 0; for (let d = lo + 1; d <= hi; d++) if (isBusinessDay(d, opts)) c++;
  return { business: c * s, calendar: b - a, uncertain: touchesPredicted(lo, hi, opts) };
}
export const settlement = (n, t = 1, opts) => addBusinessDays(n, t, opts);

/** Monthly instalments on the Jalali calendar: same day each month (clamped to month
 *  length), then moved by the business-day convention. Amounts are integers (rial);
 *  the rounding remainder goes to the last instalment. */
export function schedule({ start, count = 12, amount = 0, day, convention = "following", interval = 1, ...opts } = {}) {
  if (!(Number.isInteger(count) && count >= 1 && count <= 360)) throw new CalendarError("invalid_count", COPY.errors.invalid_count);
  if (!(Number.isInteger(interval) && interval >= 1 && interval <= 12)) throw new CalendarError("invalid_interval", COPY.errors.invalid_interval);
  const s = toJalali(parseDate(start));
  const dom = day || s.jd, each = Math.floor(amount / count);
  const rows = [];
  for (let i = 1; i <= count; i++) {
    const idx = s.jm - 1 + i * interval, jy = s.jy + Math.floor(idx / 12), jm = (idx % 12) + 1;
    const scheduled = fromJalali(jy, jm, Math.min(dom, monthLength(jy, jm)));
    const a = adjust(scheduled, convention, opts);
    rows.push({ n: i, scheduled, due: a.date, moved: a.moved, uncertain: a.uncertain, amount: i === count ? amount - each * (count - 1) : each });
  }
  return rows;
}
/** A deadline `days` after n: calendar days, or business days (then rolled to a business day). */
export function deadline(n, days, type = "business", opts) {
  if (type === "business") return addBusinessDays(n, days, opts);
  return adjust(n + days, "following", opts);
}

/* ------------------------------------------------------------------ views */
export function describe(n, opts) {
  const j = toJalali(n), h = toHijri(n), g = toGregorian(n), st = dayStatus(n, opts);
  const doy = n - nowruz(j.jy) + 1;
  return {
    date: n, iso: toISO(n), weekday: weekday(n), weekday_fa: WEEKDAYS[weekday(n)],
    jalali: { ...j, text: `${j.jy}/${pad(j.jm)}/${pad(j.jd)}`, long: `${WEEKDAYS[weekday(n)]} ${fa(j.jd)} ${J_MONTHS[j.jm - 1]} ${fa(j.jy)}` },
    hijri: { ...h, long: `${fa(h.hd)} ${H_MONTHS[h.hm - 1]} ${fa(h.hy)}` },
    gregorian: { ...g, long: `${fa(g.gd)} ${G_MONTHS[g.gm - 1]} ${fa(g.gy)}` },
    season: SEASONS[Math.floor((j.jm - 1) / 3)], quarter: Math.floor((j.jm - 1) / 3) + 1,
    day_of_year: doy, days_in_year: isLeap(j.jy) ? 366 : 365, leap_year: isLeap(j.jy),
    events: eventsOn(n), ...st,
  };
}
/** Month grid, Saturday first, with neighbour-month padding. */
export function month(jy, jm, opts) {
  const first = fromJalali(jy, jm, 1), len = monthLength(jy, jm);
  const lead = weekday(first), cells = [];
  const total = Math.ceil((lead + len) / 7) * 7;
  for (let i = 0; i < total; i++) { const n = first - lead + i; cells.push({ ...describe(n, opts), inMonth: i >= lead && i < lead + len }); }
  return { jy, jm, title: `${J_MONTHS[jm - 1]} ${fa(jy)}`, length: len, first, cells };
}

/* ------------------------------------------------------------------ iCalendar */
/** The official holidays as an iCalendar feed.
 *  Range: `from`/`to` are Jalali years (legacy: an integer below 3000, e.g. 1403–1407) or dates: ISO text
 *  ("2026-10-01"), Jalali text ("1405/07/09") or engine day numbers; both ends are inclusive. `unit: "year" | "day"`
 *  forces how numbers are read. With neither from nor to, the current Jalali year (at `now`, in Asia/Tehran);
 *  with one of them, that single year or day.
 *  Options: name (X-WR-CALNAME), timeZone (X-WR-TIMEZONE; default Asia/Tehran), domain (right of the UID @),
 *  uidPrefix (default "cal-"; a project passes its own), prodid. */
export function ics({ from, to, unit, now, name = COPY.ics.name, domain = "calendar.invalid", timeZone = TZ, uidPrefix = "cal-", prodid = "-//saasreport-kit//calendar " + VERSION + "//FA" } = {}) {
  if (!/^[A-Za-z0-9._-]*$/.test(String(uidPrefix))) throw new CalendarError("invalid_option", "uidPrefix may only contain letters, digits, '.', '_' and '-'.");
  if (!validZone(timeZone)) throw new CalendarError("invalid_time_zone", `Unknown time zone ${JSON.stringify(timeZone)}.`);
  if (unit != null && unit !== "year" && unit !== "day") throw new CalendarError("invalid_option", 'unit must be "year" or "day".');
  if (from == null && to == null) from = to = toJalali(today(now)).jy;
  else if (from == null) from = to;
  else if (to == null) to = from;
  // Legacy reading: an integer below 3000 is a Jalali year (day 3000 is 1978-03-20; pass unit: "day" for earlier days).
  const isYear = (v) => unit === "year" || (unit == null && Number.isInteger(v) && v > 0 && v < 3000);
  let list;
  if (isYear(from) && isYear(to)) {
    list = [];
    for (let y = from; y <= to; y++) list.push(...holidays(y));
  } else {
    const a = unit === "day" || typeof from === "number" ? from : parseDate(from), b = unit === "day" || typeof to === "number" ? to : parseDate(to);
    if (!Number.isInteger(a) || !Number.isInteger(b)) throw new CalendarError("invalid_date", "from and to must be dates (ISO, Jalali or day numbers) or Jalali years.");
    if (b < a) throw new CalendarError("invalid_range", "from must not be after to.");
    if (b - a > 366 * 20) throw new CalendarError("invalid_range", "A range may span at most 20 years.");
    list = [];
    for (let y = Math.max(RANGE.min, toJalali(a).jy); y <= Math.min(RANGE.max, toJalali(b).jy); y++) list.push(...holidays(y).filter((h) => h.date >= a && h.date <= b));
  }
  const esc = (s) => String(s).replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
  const d8 = (n) => toISO(n).replace(/-/g, "");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${prodid}`, "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(name)}`, `X-WR-TIMEZONE:${timeZone}`, "REFRESH-INTERVAL;VALUE=DURATION:P1D", "X-PUBLISHED-TTL:P1D"];
  for (const h of list) {
    lines.push("BEGIN:VEVENT", `UID:${uidPrefix}${d8(h.date)}-${h.kind}-${(h.hijri || "s").replace(/\W/g, "")}@${domain}`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${d8(h.date)}`, `DTEND;VALUE=DATE:${d8(h.date + 1)}`, `SUMMARY:${esc(h.title)}`,
      `DESCRIPTION:${esc(h.status === "predicted" ? COPY.holidays.predictedOfficial : COPY.holidays.official)}`,
      "TRANSP:TRANSPARENT", `CATEGORIES:${h.status === "predicted" ? "PREDICTED" : "OFFICIAL"}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  // RFC 5545: fold at 75 octets.
  const enc = new TextEncoder();
  return lines.map((l) => { const out = []; let cur = ""; for (const ch of l) { if (enc.encode(cur + ch).length > (out.length ? 74 : 75)) { out.push(cur); cur = ""; } cur += ch; } out.push(cur); return out.join("\r\n "); }).join("\r\n") + "\r\n";
}
