/**
 * Date helpers shared by the planner, reports and agenda. Days are integers (days since 1970-01-01, UTC),
 * the same day numbers @saasreport/calendar uses. Months are keyed "YYYY-MM" in the config's calendar system.
 */
import * as C from "@saasreport/calendar";
import { formatJalali } from "@saasreport/calendar/instant";
import { monthNames } from "@saasreport/calendar/locale";
import { digits, lang, strings } from "./i18n.js";

const DAY = 86400000;
const pad = (n, w = 2) => String(n).padStart(w, "0");

/** Day number from a day number, ISO date ("2026-09-30"), Jalali date ("1405/07/08") or Date. */
export function toDay(x) {
  if (typeof x === "number" && Number.isInteger(x)) return x;
  if (x instanceof Date) return Math.floor(x.getTime() / DAY);
  const s = String(x ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const n = C.fromISO(s); if (Number.isFinite(n) && C.toISO(n) === s) return n; }
  if (s) { try { return C.parseDate(s); } catch { /* the calendar parser refuses it too: the TypeError below reports it */ } }
  throw new TypeError(`not a date: ${JSON.stringify(x)}`);
}
export const iso = (n) => C.toISO(n);
/** JavaScript weekday (0 = Sunday … 6 = Saturday). */
export const jsWeekday = (n) => new Date(n * DAY).getUTCDay();
export const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/** "sat" | "saturday" | 0-6 (JS numbering) → 0-6, or -1. */
export function weekdayIndex(v) {
  if (Number.isInteger(v) && v >= 0 && v <= 6) return v;
  const i = WEEKDAY_NAMES.indexOf(String(v ?? "").toLowerCase().slice(0, 3));
  return i;
}
/** JS weekday numbers → @saasreport/calendar weekday numbers (0 = Saturday). */
export const toCalWeekdays = (js) => js.map((d) => (d + 1) % 7);

const isJalali = (config) => (config?.calendar?.system || "jalali") === "jalali";

/** {y, m, d} of day n in the config's calendar system. */
export function ymd(config, n) {
  if (isJalali(config)) { const j = C.toJalali(n); return { y: j.jy, m: j.jm, d: j.jd }; }
  const g = C.toGregorian(n); return { y: g.gy, m: g.gm, d: g.gd };
}
export const monthLength = (config, y, m) => (isJalali(config) ? C.monthLength(y, m) : new Date(Date.UTC(y, m, 0)).getUTCDate());
/** Day number of y/m/d in the config's calendar system. */
export const fromYmd = (config, y, m, d) => (isJalali(config) ? C.fromJalali(y, m, d) : Math.floor(Date.UTC(y, m - 1, d) / DAY));
export const monthKey = (config, n) => { const { y, m } = ymd(config, n); return `${y}-${pad(m)}`; };
export function parseMonthKey(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key ?? ""));
  if (!m || +m[2] < 1 || +m[2] > 12) return null;
  return { y: +m[1], m: +m[2] };
}
/** First and last day of a month key. */
export function monthBounds(config, key) {
  const p = parseMonthKey(key);
  if (!p) throw new TypeError(`not a month key (YYYY-MM): ${key}`);
  const first = fromYmd(config, p.y, p.m, 1);
  return { first, last: first + monthLength(config, p.y, p.m) - 1, length: monthLength(config, p.y, p.m), ...p };
}
/** Month key shifted by k months. */
export function addMonths(key, k) {
  const p = parseMonthKey(key); const idx = p.y * 12 + (p.m - 1) + k;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}
export const monthIndex = (key) => { const p = parseMonthKey(key); return p.y * 12 + p.m - 1; };

/** UTC offset (ms) of a time zone at an instant. */
export function tzOffset(ms, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(ms)).filter((x) => x.type !== "literal").map((x) => [x.type, +x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
/** Local wall time ("YYYY-MM-DD", "HH:MM") in a time zone → ISO UTC timestamp. */
export function zonedToUtc(date, time = "00:00", timeZone = "UTC") {
  const [h, mi] = String(time).split(":").map(Number);
  const n = typeof date === "number" ? date : toDay(date);
  const wall = n * DAY + (h || 0) * 3600000 + (mi || 0) * 60000;
  let t = wall - tzOffset(wall, timeZone);
  t = wall - tzOffset(t, timeZone); // second pass settles DST transitions
  return new Date(t).toISOString();
}
/** The civil day number "now" in a time zone. */
export function localDay(timeZone = "UTC", now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]));
  return C.fromISO(`${p.year}-${p.month}-${p.day}`);
}

/* ------------------------------------------------------------------ labels */
// Intl only lays out Gregorian dates; Solar Hijri dates come from @saasreport/calendar's arithmetic (ICU's Persian
// calendar is a day off on Workers in 1405), so a Jalali label is Intl's layout with the arithmetic year/month/day.
const intlLocale = (config) => `${config?.site?.locale || "en-US"}-u-ca-gregory`;
const fmtCache = new Map();
const fmt = (config, o) => {
  const k = intlLocale(config) + JSON.stringify(o);
  if (!fmtCache.has(k)) fmtCache.set(k, new Intl.DateTimeFormat(intlLocale(config), { timeZone: "UTC", ...o }));
  return fmtCache.get(k);
};
const label = (config, n, o) => (isJalali(config)
  ? formatJalali(new Date(n * DAY), { locale: config?.site?.locale || "en-US", timeZone: "UTC", ...o })
  : fmt(config, o).format(new Date(n * DAY)));
const faJalali = (config) => isJalali(config) && lang(config) === "fa";
/** Month name in the config's calendar and language ("آبان", "October"). */
export function monthName(config, y, m) {
  if (faJalali(config)) return C.J_MONTHS[m - 1];
  if (!isJalali(config) && lang(config) === "fa") return C.G_MONTHS[m - 1];
  if (isJalali(config)) return monthNames("jalali", config?.site?.locale || "en")[m - 1];
  return fmt(config, { month: "long" }).format(new Date(fromYmd(config, y, m, 15) * DAY));
}
/** "آبان ۱۴۰۵" / "October 2026" for a month key. */
export function monthLabel(config, key) {
  const p = parseMonthKey(key);
  return `${monthName(config, p.y, p.m)} ${digits(config, p.y)}`;
}
/** Long day label: "شنبه ۱۱ مهر ۱۴۰۵" / "Saturday, October 3, 2026". */
export function dayLabel(config, n) {
  if (faJalali(config)) return C.describe(n).jalali.long;
  if (lang(config) === "fa") { const g = C.toGregorian(n); return `${strings(config).weekdays.split(",")[jsWeekday(n)]} ${digits(config, g.gd)} ${C.G_MONTHS[g.gm - 1]} ${digits(config, g.gy)}`; }
  return label(config, n, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
/** Short day label without weekday and year: "۱۱ مهر" / "October 3". */
export function dayMonth(config, n) {
  const { y, m, d } = ymd(config, n);
  if (lang(config) === "fa") return `${digits(config, d)} ${monthName(config, y, m)}`;
  return label(config, n, { day: "numeric", month: "long" });
}
/** Localized weekday name for a JS weekday number. */
export const weekdayName = (config, js) => strings(config).weekdays.split(",")[js];
