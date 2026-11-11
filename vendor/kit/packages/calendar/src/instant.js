/**
 * Solar Hijri by arithmetic, for day numbers and for instants in a time zone. The runtime's ICU Persian calendar is
 * never used: the Workers runtime put Nowruz 1405 a day early (2026-10-03 read 12 Mehr, not 11), and older Safari and
 * WebViews can be a day off too. Intl only supplies what has no calendar in it: the wall-clock date in a time zone
 * (Gregorian parts), the layout of a formatted date, weekday names and clock times, always with Latin digits.
 *
 * This file has no imports: index.js re-exports its arithmetic, and @saasreport/format/browser inlines it into the
 * classic browser script (KitFormat.formatJalali …), so Workers, Node and browsers run the same code.
 *
 *   toJalali(n)                              → { jy, jm, jd } of a day number (days since 1970-01-01)
 *   zonedDay(date, timeZone)                 → the day number of the instant's local date in timeZone
 *   jalaliFor(date, timeZone)                 → { jy, jm, jd, n }
 *   formatJalali(date, { locale, timeZone, months, ...Intl options incl. dateStyle/timeStyle })
 *                                            → "Saturday, Mehr 11, 1405" / "شنبه 11 مهر 1405" (Latin digits)
 *   dateTag(locale, system)                  → an Intl tag that never resolves to the Persian calendar
 *   formatInstant(date, { locale, calendar, timeZone, ...options })
 *                                            → formatJalali for "jalali", else Intl in the locale's own calendar
 */
const DAY = 86400000;
const pad2 = (n) => String(n).padStart(2, "0");
const isoDay = (s) => Math.floor(Date.parse(`${s}T00:00:00Z`) / DAY);

/** Jalali month names: Persian (the kit's), English transliteration, Arabic. Other languages use English. */
export const J_MONTH_NAMES = Object.freeze({
//#if fa,ar
  fa: Object.freeze(["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"]),
//#end
  en: Object.freeze(["Farvardin", "Ordibehesht", "Khordad", "Tir", "Mordad", "Shahrivar", "Mehr", "Aban", "Azar", "Dey", "Bahman", "Esfand"]),
//#if fa,ar
  ar: Object.freeze(["فروردين", "أرديبهشت", "خرداد", "تير", "مرداد", "شهريور", "مهر", "آبان", "آذر", "دي", "بهمن", "إسفند"]),
//#end
});

/* Solar Hijri, ICU-free. The March day of Nowruz for year jy follows Borkowski's break years
   (K. M. Borkowski, "The Persian calendar for 3000 years", Earth, Moon and Planets 74, 1996), as ported
   in jalaali-js (MIT, (c) Behrang Noruzi Niya); it matches the Iranian astronomical calendar across 1300–1500. */
const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
const div = (a, b) => ~~(a / b), mod = (a, b) => a - ~~(a / b) * b;
function marchDay(jy) {
  const gy = jy + 621;
  let leapJ = -14, jp = BREAKS[0], jump = 0;
  for (let i = 1; i < BREAKS.length; i++) {
    const jm = BREAKS[i]; jump = jm - jp;
    if (jy < jm) break;
    leapJ += div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  const n = jy - jp;
  leapJ += div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  return 20 + leapJ - leapG;
}
/** Day number of Nowruz (1 Farvardin) of Jalali year jy, unchecked. */
export const nowruzDay = (jy) => isoDay(`${jy + 621}-03-${pad2(marchDay(jy))}`);

const jCache = new Map();
/** Jalali { jy, jm, jd } of day number n, by arithmetic. */
export function toJalali(n) {
  let r = jCache.get(n);
  if (!r) {
    let jy = new Date(n * DAY).getUTCFullYear() - 621, start = nowruzDay(jy);
    if (n < start) start = nowruzDay(--jy);
    const k = n - start;
    r = k < 186 ? { jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 } : { jy, jm: 7 + div(k - 186, 30), jd: mod(k - 186, 30) + 1 };
    jCache.set(n, r);
  }
  return r;
}

const DAY_PARTS = new Map();
/** The day number of an instant's wall-clock date in a time zone (Gregorian Intl parts only). */
export function zonedDay(date, timeZone = "UTC") {
  const d = date instanceof Date ? date : new Date(date);
  if (!DAY_PARTS.has(timeZone)) DAY_PARTS.set(timeZone, new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }));
  const p = {};
  for (const x of DAY_PARTS.get(timeZone).formatToParts(d)) p[x.type] = x.value;
  return isoDay(`${p.year}-${p.month}-${p.day}`);
}

/** The Jalali date of an instant in a time zone: { jy, jm, jd, n }. */
export function jalaliFor(date, timeZone = "UTC") {
  const n = zonedDay(date, timeZone);
  return Object.assign({}, toJalali(n), { n });
}

// CLDR's calendar preference puts the Persian calendar first for Iran and Afghanistan and for Persian/Pashto with no
// region, so a tag without a calendar keyword can still resolve to ICU's Persian calendar.
const PERSIAN_DEFAULT = (lang, region) => region === "IR" || region === "AF" || (!region && (lang === "fa" || lang === "ps"));
/** Canonical tag split without building an Intl.Locale (so a -u-ca-persian tag is never resolved): its language,
 * region, calendar keyword, and the tag without that keyword. */
function parseTag(locale) {
  let tag = "en";
  try { tag = Intl.getCanonicalLocales(String(locale || "en").replace(/_/g, "-"))[0] || "en"; } catch { /* not a canonical locale tag: English is the documented fallback */ }
  const sub = tag.split("-"), lang = sub[0].toLowerCase();
  let region, ca, i = 1;
  for (; i < sub.length && sub[i].length > 1; i++) if (/^([a-z]{2}|\d{3})$/i.test(sub[i])) region = region || sub[i].toUpperCase();
  const u = sub.findIndex((x, k) => k > 0 && x.toLowerCase() === "u" && (k === sub.length - 1 || sub[k + 1].length >= 2));
  let bare = tag;
  if (u > 0) {
    let k = u + 1;
    while (k < sub.length && sub[k].length > 2) k++; // u-extension attributes
    const out = sub.slice(0, k);
    while (k < sub.length && sub[k].length !== 1) {
      const key = sub[k], vals = [];
      k++;
      while (k < sub.length && sub[k].length > 2) vals.push(sub[k++]);
      if (key.toLowerCase() === "ca") ca = vals.join("-").toLowerCase(); else out.push(key, ...vals);
    }
    const rest = sub.slice(k);
    bare = (out.length === u + 1 ? out.slice(0, u) : out).concat(rest).join("-");
  }
  return { tag, bare, lang, region, ca };
}
/** The locale tag without its calendar keyword, never resolved through ICU ("fa-IR-u-ca-persian-nu-latn" → "fa-IR-u-nu-latn"). */
export const withoutCalendar = (locale) => parseTag(locale).bare;
/** "jalali" when the locale's own calendar is Persian (an explicit -u-ca-persian, or CLDR's default for fa, ps, IR, AF). */
export function ownSystem(locale) {
  const { lang, region, ca } = parseTag(locale);
  return (ca ? ca === "persian" : PERSIAN_DEFAULT(lang, region)) ? "jalali" : undefined;
}

/**
 * An Intl tag for dates in `system` that never resolves to ICU's Persian calendar. Jalali sites get the Gregorian
 * calendar (Intl only lays out; formatJalali puts the Jalali date in). Any other system keeps the locale's own
 * calendar (ar-SA-u-ca-islamic-umalqura stays Hijri, th-TH stays Buddhist) unless that calendar is Persian, which
 * becomes Gregorian. Other extensions (nu-arab …) are kept.
 */
export function dateTag(locale, system) {
  const { tag, bare, lang, region, ca } = parseTag(locale);
  const persian = ca ? ca === "persian" : PERSIAN_DEFAULT(lang, region);
  if (system !== "jalali" && !persian) return tag;
  return new Intl.Locale(bare, { calendar: "gregory" }).toString();
}

const NUMERIC = /^\d+$/;
/**
 * An instant formatted with Intl's layout for the locale and options (weekday, year, month, day, hour …, or
 * dateStyle/timeStyle), the year, month and day replaced by the Jalali ones and no era. Month names: `months` if
 * given, else J_MONTH_NAMES for the language (English for others). Latin digits; the caller maps them.
 */
export function formatJalali(date, { locale = "fa", timeZone = "UTC", months, ...options } = {}) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(+d)) return "";
  const { lang } = parseTag(locale);
  const tag = new Intl.Locale(dateTag(locale, "jalali"), { numberingSystem: "latn" }).toString();
  const f = new Intl.DateTimeFormat(tag, Object.assign({ timeZone }, options));
  const o = f.resolvedOptions(), j = jalaliFor(d, timeZone);
  const names = months || J_MONTH_NAMES[lang] || J_MONTH_NAMES.en;
  // numeric parts keep the width Intl chose ("07" for 2-digit or a short dateStyle); names come from the table
  const num = (v, opt, width) => (opt === "2-digit" || (!opt && width === 2 && v.startsWith("0")) ? pad2 : String);
  const parts = f.formatToParts(d).map((p) => {
    if (p.type === "year") return { type: "year", value: p.value.length === 2 ? pad2(j.jy % 100) : String(j.jy) };
    if (p.type === "month") return { type: "month", value: NUMERIC.test(p.value) ? num(p.value, o.month, p.value.length)(j.jm) : names[j.jm - 1] };
    if (p.type === "day") return { type: "day", value: num(p.value, o.day, p.value.length)(j.jd) };
    return p;
  });
  // The Gregorian era ("AD", "میلادی") does not belong to a Jalali date: drop it with the space that joined it.
  let era;
  while ((era = parts.findIndex((p) => p.type === "era")) >= 0) {
    const before = parts[era - 1], after = parts[era + 1], space = (p) => p && p.type === "literal" && /^\s+$/.test(p.value);
    if (space(before)) parts.splice(era - 1, 2); else if (space(after)) parts.splice(era, 2); else parts.splice(era, 1);
  }
  return parts.map((p) => p.value).join("").trim();
}

/**
 * Format an instant in a calendar system: "jalali" (or no system on a locale whose own calendar is Persian) through
 * formatJalali (arithmetic), anything else through Intl in dateTag(locale, calendar), the locale's own calendar.
 * Latin or the tag's digits; callers map digits with @saasreport/format.
 */
export function formatInstant(date, { locale = "en", calendar, timeZone = "UTC", ...options } = {}) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(+d)) return "";
  if ((calendar || ownSystem(locale)) === "jalali") return formatJalali(d, Object.assign({ locale, timeZone }, options));
  return new Intl.DateTimeFormat(dateTag(locale, calendar), Object.assign({ timeZone }, options)).format(d);
}
