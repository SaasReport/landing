/* @saasreport/calendar/locale — month and weekday names and date labels for the Gregorian, Hijri
   (Umm al-Qura or civil) and Jalali calendars in en, ar and fa, and labels that show two calendars
   at once ("18 February 2026 (1 Ramadan 1447 AH)").

   A site locale pack (packages/site/src/locales/*.js) can be passed as `pack`: its month names
   (pack.months.gregorian / hijri / jalali), digits ("latin" | "arabic" | "persian") and hijriSuffix
   win over the tables here, so a project's overrides show up in every label. Weekdays here count from
   Sunday (0 = Sunday), like Date#getUTCDay. */
import * as IR from "./index.js";
import { J_MONTH_NAMES } from "./instant.js";
import { toHijri, fromHijri, hijriMonthLength } from "./hijri.js";

const DAY = 86400000;
export const SYSTEMS = ["gregorian", "hijri-umalqura", "hijri-civil", "jalali"];
export const LOCALES = ["en", "ar", "fa"];
export const DIGITS = { latin: "0123456789", arabic: "٠١٢٣٤٥٦٧٨٩", persian: "۰۱۲۳۴۵۶۷۸۹" };
export const DEFAULT_DIGITS = { en: "latin", ar: "arabic", fa: "persian" };

export const MONTHS = {
  gregorian: {
    en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    ar: ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"],
    "ar-gulf": null,
    "ar-levant": ["كانون الثاني", "شباط", "آذار", "نيسان", "أيار", "حزيران", "تموز", "آب", "أيلول", "تشرين الأول", "تشرين الثاني", "كانون الأول"],
    fa: IR.G_MONTHS,
  },
  hijri: {
    en: ["Muharram", "Safar", "Rabi al-Awwal", "Rabi al-Thani", "Jumada al-Ula", "Jumada al-Akhirah", "Rajab", "Sha'ban", "Ramadan", "Shawwal", "Dhu al-Qa'dah", "Dhu al-Hijjah"],
    ar: ["محرم", "صفر", "ربيع الأول", "ربيع الآخر", "جمادى الأولى", "جمادى الآخرة", "رجب", "شعبان", "رمضان", "شوال", "ذو القعدة", "ذو الحجة"],
    fa: IR.H_MONTHS,
  },
  jalali: { en: J_MONTH_NAMES.en, ar: J_MONTH_NAMES.ar, fa: IR.J_MONTHS },
};
const WEEKDAYS = {
  en: { long: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], short: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] },
  ar: { long: ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"] },
  fa: { long: [...IR.WEEKDAYS.slice(1), IR.WEEKDAYS[0]] }, // index.js is Saturday-first
};
const ERA = { hijri: { en: " AH", ar: " هـ", fa: " ق" }, jalali: { en: " SH", ar: " هـ.ش", fa: "" }, gregorian: { en: "", ar: "", fa: "" } };

const family = (system) => (system.startsWith("hijri") ? "hijri" : system);
const variantOf = (system) => (system === "hijri-civil" ? "civil" : "umalqura");
function checkSystem(system) {
  if (system === "hijri") return "hijri-umalqura";
  if (!SYSTEMS.includes(system)) throw new Error(`calendar system must be one of ${SYSTEMS.join(", ")} (got ${JSON.stringify(system)})`);
  return system;
}
const langOf = (locale, pack) => String(pack?.code || pack?.lang || locale || "en").slice(0, 2);

/** Replace ASCII digits by the digits of a set ("latin" | "arabic" | "persian"). */
export const toDigits = (v, digits = "latin") => { const t = DIGITS[digits] || DIGITS.latin; return String(v ?? "").replace(/[0-9]/g, (d) => t[d]); };

/** Twelve month names of a calendar system in a locale. Arabic Gregorian names: `variant: "gulf"`
 *  (default; يناير، فبراير … as in Egypt and the Gulf) or `variant: "levant"` (كانون الثاني، شباط …). */
export function monthNames(system, locale = "en", { pack, variant } = {}) {
  const fam = family(checkSystem(system)), lang = langOf(locale, pack);
  const fromPack = pack?.months?.[fam];
  if (Array.isArray(fromPack) && fromPack.length === 12) return fromPack;
  const t = MONTHS[fam];
  if (variant != null && !["gulf", "levant"].includes(variant)) throw new Error(`month-name variant must be "gulf" or "levant" (got ${JSON.stringify(variant)})`);
  return (variant && t[`${lang}-${variant}`]) || t[lang] || t.en;
}
/** Seven weekday names, Sunday first unless `start` is given (0 = Sunday … 6 = Saturday). */
export function weekdayNames(locale = "en", { start = 0, style = "long" } = {}) {
  const w = WEEKDAYS[String(locale).slice(0, 2)] || WEEKDAYS.en, names = w[style] || w.long;
  return Array.from({ length: 7 }, (_, i) => names[(start + i) % 7]);
}

/** Year, month and day of day number n in a calendar system. */
export function dateParts(n, system = "gregorian") {
  const s = checkSystem(system);
  if (s === "jalali") { const j = IR.toJalali(n); return { year: j.jy, month: j.jm, day: j.jd }; }
  if (s.startsWith("hijri")) { const h = toHijri(n, variantOf(s)); return { year: h.hy, month: h.hm, day: h.hd }; }
  const d = new Date(n * DAY); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
/** First day number and length of month m of year y in a calendar system (for month grids). */
export function monthSpan(system, y, m) {
  const s = checkSystem(system);
  if (s === "jalali") return { first: IR.fromJalali(y, m, 1), length: IR.monthLength(y, m) };
  if (s.startsWith("hijri")) return { first: fromHijri(y, m, 1, variantOf(s)), length: hijriMonthLength(y, m, variantOf(s)) };
  return { first: Math.floor(Date.UTC(y, m - 1, 1) / DAY), length: new Date(Date.UTC(y, m, 0)).getUTCDate() };
}

/** "18 February 2026", "1 Ramadan 1447 AH", "١ رمضان ١٤٤٧ هـ"; { weekday: true } prefixes the weekday.
 *  Digits: options.digits, else the pack's, else the locale's default (arabic for ar). */
export function formatDate(n, { system = "gregorian", locale = "en", pack, digits, weekday = false, era = true, variant } = {}) {
  const s = checkSystem(system), fam = family(s), lang = langOf(locale, pack);
  const { year, month, day } = dateParts(n, s);
  const names = monthNames(s, lang, { pack, variant });
  const suffix = !era ? "" : fam === "hijri" && pack?.hijriSuffix != null ? pack.hijriSuffix : (ERA[fam][lang] ?? ERA[fam].en);
  const wd = weekday ? `${weekdayNames(lang)[(((n + 4) % 7) + 7) % 7]}${lang === "en" ? ", " : " "}` : "";
  return toDigits(`${wd}${day} ${names[month - 1]} ${year}${suffix}`, digits || pack?.digits || DEFAULT_DIGITS[lang] || "latin");
}
/** "Month Year" title for a table or grid header. */
export function monthTitle(system, y, m, { locale = "en", pack, digits, era = true, variant } = {}) {
  const s = checkSystem(system), fam = family(s), lang = langOf(locale, pack);
  const suffix = !era ? "" : fam === "hijri" && pack?.hijriSuffix != null ? pack.hijriSuffix : (ERA[fam][lang] ?? ERA[fam].en);
  return toDigits(`${monthNames(s, lang, { pack, variant })[m - 1]} ${y}${suffix}`, digits || pack?.digits || DEFAULT_DIGITS[lang] || "latin");
}
/** One day in every configured system: { primary, secondary: [..], text: "18 February 2026 (1 Ramadan 1447 AH)" }. */
export function formatDual(n, { systems = ["gregorian", "hijri-umalqura"], primary, ...o } = {}) {
  const list = systems.map(checkSystem), first = primary ? checkSystem(primary) : list[0];
  const rest = list.filter((s) => s !== first);
  const a = formatDate(n, { ...o, system: first }), b = rest.map((s) => formatDate(n, { ...o, system: s, weekday: false }));
  const sep = langOf(o.locale, o.pack) === "en" ? ", " : "، ";
  return { primary: a, secondary: b, text: b.length ? `${a} (${b.join(sep)})` : a };
}
