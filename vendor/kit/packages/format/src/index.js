/**
 * @saasreport/format: the one place the kit turns numbers into reader-facing text (docs/CONSTITUTION.md §7).
 *
 * Every number a reader sees goes through here: the site renderer, widgets, calendar output, Markdown twins, llms.txt,
 * OG and SVG text, email templates and podcast pages. For fa (and ar) the digits are the locale's own and the
 * separators are the Arabic-script ones:
 *
 *   formatNumber(1234567.5, "fa")      → "۱٬۲۳۴٬۵۶۷٫۵"
 *   formatPercent(12.5, "fa")          → "۱۲٫۵٪"
 *   formatOrdinal(3, "fa")             → "سوم"          formatOrdinal(21, "fa", { style: "numeric" }) → "۲۱ام"
 *   formatRange(1, 5, "fa")            → "۱ تا ۵"
 *   formatTime("06:00", "fa")          → "۰۶:۰۰"
 *   formatDate("2026-10-01", "en")     → "October 1, 2026"  (Solar Hijri dates: @saasreport/calendar, never ICU)
 *   digits(1405, "fa")                 → "۱۴۰۵"          (no grouping: years, counts inside identifiers of copy)
 *
 * No Intl numbering system is trusted for the digits (ICU versions differ): numbers are built from ASCII and then
 * mapped, so the output is the same in Node, workerd and every browser. No dependencies.
 */

/** Digit sets by name. */
//#if fa,ar
export const DIGIT_SETS = Object.freeze({ latin: "0123456789", persian: "۰۱۲۳۴۵۶۷۸۹", arabic: "٠١٢٣٤٥٦٧٨٩" });
//#else
//| export const DIGIT_SETS = Object.freeze({ latin: "0123456789" });
//#end
/** The digit set of a language (languages not listed use Latin digits). */
//#if fa,ar
export const LOCALE_DIGITS = Object.freeze({ fa: "persian", ar: "arabic" });
//#else
//| export const LOCALE_DIGITS = Object.freeze({});
//#end
/** Separators by language: thousands group, decimal point, percent sign, minus, range and list joiners. */
export const SEPARATORS = Object.freeze({
//#if fa,ar
  fa: Object.freeze({ group: "٬", decimal: "٫", percent: "٪", minus: "−", range: " تا ", list: "، ", and: " و " }),
  ar: Object.freeze({ group: "٬", decimal: "٫", percent: "٪", minus: "−", range: " إلى ", list: "، ", and: " و" }),
//#end
  en: Object.freeze({ group: ",", decimal: ".", percent: "%", minus: "-", range: "–", list: ", ", and: " and " }),
});

/** Language subtag of a BCP-47 locale, a config ({ site: { locale } }) or a locale pack ({ code }): "fa-IR" → "fa". */
export function lang(x) {
  const loc = typeof x === "string" ? x : x?.site?.locale ?? x?.code ?? x?.lang ?? x?.locale;
  return String(loc || "en").toLowerCase().split(/[-_]/)[0];
}
const sepOf = (l) => SEPARATORS[l] || SEPARATORS.en;
/** The digit set name of a locale ("persian" for fa). An explicit set name passes through. */
export const digitSetOf = (locale) => (typeof locale === "string" && DIGIT_SETS[locale] ? locale : LOCALE_DIGITS[lang(locale)] || "latin");

//#if fa,ar
const ANY_DIGIT = /[0-9۰-۹٠-٩]/g;
//#else
//| const ANY_DIGIT = /[0-9]/g;
//#end
const valueOf = (ch) => { const c = ch.charCodeAt(0); return c <= 57 ? c - 48 : c >= 0x6f0 ? c - 0x6f0 : c - 0x660; };

/** Every digit (ASCII, Persian or Arabic-Indic) in the digits of the locale (or of a set name: "persian"). */
export function digits(v, locale = "en") {
  const set = DIGIT_SETS[digitSetOf(locale)];
  return String(v ?? "").replace(ANY_DIGIT, (d) => set[valueOf(d)]);
}
/** Persian / Arabic-Indic digits → ASCII (for parsing input). */
export const toLatinDigits = (v) => digits(v, "latin");
/** ASCII → Persian digits (shorthand of digits(v, "fa")). */
export const toPersianDigits = (v) => digits(v, "fa");

/**
 * A number in the locale's digits and separators.
 * options: decimals (fixed fraction digits), maxDecimals (round, drop trailing zeros), grouping (default true),
 * minInt (pad the integer part with zeros, e.g. 2 for clock fields); for a site locale pack whose numbers differ from
 * its language's: numerals (a digit set name) and separators ({ group, decimal, percent }).
 */
export function formatNumber(n, locale = "en", { decimals, maxDecimals, grouping = true, minInt, numerals, separators } = {}) {
  const x = Number(n), set = numerals || locale;
  if (!Number.isFinite(x)) return digits(String(n ?? ""), set);
  const l = lang(locale), sep = { ...sepOf(l), ...(separators || {}) };
  let s = decimals != null ? Math.abs(x).toFixed(decimals) : maxDecimals != null ? String(Number(Math.abs(x).toFixed(maxDecimals))) : String(Math.abs(x));
  if (/e/i.test(s)) s = Math.abs(x).toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
  let [int, frac] = s.split(".");
  if (minInt) int = int.padStart(minInt, "0");
  if (grouping) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, "\u0000");
  const out = int.replace(/\u0000/g, sep.group) + (frac ? sep.decimal + frac : "");
  return (x < 0 && Number(s) !== 0 ? sep.minus : "") + digits(out, set);
}
/** A count or amount without grouping ("۱۴۰۵"): years, episode numbers. */
export const formatInteger = (n, locale = "en") => formatNumber(Math.trunc(Number(n)), locale, { grouping: false });

/** A percentage of n (12.5 → "۱۲٫۵٪" in fa, "12.5%" in en). options as formatNumber; default maxDecimals 1. */
export function formatPercent(n, locale = "en", options = {}) {
  const o = options.decimals == null && options.maxDecimals == null ? { ...options, maxDecimals: 1 } : options;
  return formatNumber(n, locale, o) + (options.separators?.percent ?? sepOf(lang(locale)).percent);
}

//#if fa,ar
// Persian number words (0–999 999), for ordinals and spoken-style copy.
const FA_ONES = ["صفر", "یک", "دو", "سه", "چهار", "پنج", "شش", "هفت", "هشت", "نه", "ده", "یازده", "دوازده", "سیزده", "چهارده", "پانزده", "شانزده", "هفده", "هجده", "نوزده"];
const FA_TENS = ["", "", "بیست", "سی", "چهل", "پنجاه", "شصت", "هفتاد", "هشتاد", "نود"];
const FA_HUNDREDS = ["", "صد", "دویست", "سیصد", "چهارصد", "پانصد", "ششصد", "هفتصد", "هشتصد", "نهصد"];
function faBelow1000(n) {
  const parts = [];
  if (n >= 100) { parts.push(FA_HUNDREDS[Math.floor(n / 100)]); n %= 100; }
  if (n >= 20) { parts.push(FA_TENS[Math.floor(n / 10)]); n %= 10; }
  if (n > 0) parts.push(FA_ONES[n]);
  return parts.join(" و ");
}
/** Persian words for an integer 0 … 999 999 ("بیست و یک"); larger numbers fall back to digits. */
export function faWords(n) {
  const x = Math.trunc(Math.abs(Number(n)));
  if (!Number.isFinite(x) || x > 999999) return formatNumber(n, "fa");
  if (x < 20) return FA_ONES[x];
  if (x < 1000) return faBelow1000(x);
  const th = Math.floor(x / 1000), rest = x % 1000;
  const head = th === 1 ? "هزار" : `${faBelow1000(th)} هزار`;
  return rest ? `${head} و ${faBelow1000(rest)}` : head;
}
//#else
//| /** Persian number words are not built into this file: the site has no Persian or Arabic locale. */
//| export function faWords(n) { throw new RangeError("faWords is not built into this format.js: the site has no Persian or Arabic locale"); }
//#end

/**
 * An ordinal. fa: words by default ("یکم", "دوم", "سوم", "بیست و یکم", "سی‌ام"; options.first: "اول" for 1),
 * style "numeric" → digits + "ام" ("۲۱ام"). en: "1st", "22nd", "13th".
 */
export function formatOrdinal(n, locale = "en", { style = "word", first } = {}) {
  const x = Math.trunc(Number(n)), l = lang(locale);
//#if fa,ar
  if (l === "fa") {
    if (style === "numeric" || x < 1 || x > 999999) return `${formatInteger(x, locale)}ام`;
    if (x === 1 && first) return first;
    const w = faWords(x);
    if (w.endsWith("سه")) return `${w.slice(0, -2)}سوم`;
    if (w.endsWith("ی")) return `${w}‌ام`;
    return `${w}م`;
  }
//#end
  const s = (x % 100 >= 11 && x % 100 <= 13) ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[x % 10] || "th");
  return `${digits(x, locale)}${s}`;
}

/** A range "from to": fa "۱ تا ۵", en "1–5". Each end is formatted by `format` (default formatNumber). */
export function formatRange(a, b, locale = "en", { format = (v) => (typeof v === "number" ? formatNumber(v, locale) : digits(v, locale)), joiner } = {}) {
  return `${format(a)}${joiner ?? sepOf(lang(locale)).range}${format(b)}`;
}

/** A list joined the locale's way: ["الف", "ب", "پ"] → "الف، ب و پ" (fa). Items are passed through digits(). */
export function formatList(items, locale = "en") {
  const sep = sepOf(lang(locale)), xs = [...items].map((x) => digits(x, locale));
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(sep.list)}${sep.and}${xs.at(-1)}`;
}

const pad2 = (n) => String(n).padStart(2, "0");
/**
 * A clock time "HH:MM" in the locale's digits. Accepts "06:00", minutes after midnight ({ minutes: 360 }),
 * or a Date (with options.timeZone; default UTC). options.seconds adds ":SS".
 */
export function formatTime(t, locale = "en", { timeZone = "UTC", seconds = false } = {}) {
  let h, m, s = 0;
  if (t instanceof Date || typeof t === "number") {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(t instanceof Date ? t : new Date(t)).map((x) => [x.type, x.value]));
    [h, m, s] = [Number(p.hour), Number(p.minute), Number(p.second)];
  } else if (t && typeof t === "object" && "minutes" in t) {
    [h, m] = [Math.floor(t.minutes / 60), t.minutes % 60];
  } else {
    [h, m, s = 0] = toLatinDigits(t).split(":").map(Number);
  }
  return digits(`${pad2(h)}:${pad2(m)}${seconds ? `:${pad2(s)}` : ""}`, locale);
}

/** A duration in seconds as a clock "M:SS" (or "H:MM:SS"), in the locale's digits: 95 → "۱:۳۵". */
export function formatDuration(totalSeconds, locale = "en") {
  const t = Math.max(0, Math.round(Number(totalSeconds) || 0)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return digits(h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`, locale);
}

const CAL = { gregorian: "gregory", gregory: "gregory", hijri: "islamic-umalqura", "hijri-umalqura": "islamic-umalqura", "hijri-civil": "islamic-civil" };
/**
 * A Gregorian or Hijri date through Intl (month names of the locale), digits mapped here: formatDate("2026-10-01", "ar",
 * { calendar: "hijri" }). options.weekday adds the weekday; options.month: "long" | "numeric".
 * Solar Hijri ("jalali" / "persian") is refused: ICU's Persian calendar is a day off on Workers in 1405 (2026-10-03
 * read ۱۲ مهر, not ۱۱). Use @saasreport/calendar's arithmetic: formatJalali(date, { locale, timeZone, ...options }) from
 * @saasreport/calendar/instant for an instant, or @saasreport/calendar/locale formatDate for a day number, then digits().
 */
export function formatDate(d, locale = "en", { calendar = "gregorian", timeZone = "UTC", weekday = false, month = "long" } = {}) {
  const date = d instanceof Date ? d : new Date(typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00Z` : d);
  const l = lang(locale), ca = CAL[calendar] || calendar;
  const opts = { timeZone, year: "numeric", month, day: "numeric", ...(weekday ? { weekday: "long" } : {}) };
  if (calendar === "jalali" || calendar === "persian") {
    throw new TypeError('formatDate: Solar Hijri dates come from formatJalali / formatInstant (@saasreport/calendar/instant, also exported here), never ICU\'s Persian calendar');
  }
  let s;
  try { s = new Intl.DateTimeFormat(`${l}-u-ca-${ca}-nu-latn`, opts).format(date); } catch { s = new Intl.DateTimeFormat(`${l}-u-nu-latn`, opts).format(date); }
  return digits(s, locale);
}

/** Every formatter bound to one locale: const f = formatter("fa"); f.number(1200) → "۱٬۲۰۰". */
export function formatter(locale = "en") {
  return {
    lang: lang(locale), separators: sepOf(lang(locale)), digitSet: digitSetOf(locale),
    digits: (v) => digits(v, locale), number: (n, o) => formatNumber(n, locale, o), integer: (n) => formatInteger(n, locale),
    percent: (n, o) => formatPercent(n, locale, o), ordinal: (n, o) => formatOrdinal(n, locale, o),
    range: (a, b, o) => formatRange(a, b, locale, o), list: (xs) => formatList(xs, locale),
    time: (t, o) => formatTime(t, locale, o), duration: (s) => formatDuration(s, locale), date: (d, o) => formatDate(d, locale, o),
  };
}

// Dates of instants in a calendar system (Solar Hijri by arithmetic, never ICU's Persian calendar): one implementation,
// @saasreport/calendar/instant, which has no imports; browser.js inlines it into KitFormat.
export { formatInstant, formatJalali, jalaliFor, zonedDay } from "@saasreport/calendar/instant";
export { localizeText, segments, PERSIAN_LETTER } from "./text.js";
export { localizeHtml, READER_ATTRS, META_CONTENT, LD_KEYS } from "./html.js";
export { localizeMarkdown, localizeMarkdownLine } from "./markdown.js";
