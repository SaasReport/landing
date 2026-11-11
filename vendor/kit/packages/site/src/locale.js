/**
 * Locale packs: direction, digits, number and date formatting, calendar system and UI chrome strings.
 * `fa`, `en` and `ar` ship with the kit; a project can override any field (strings merge key by key)
 * or pass a whole pack of its own.
 *
 * Dates are formatted by @saasreport/calendar/locale with the pack (its month names, digits and Hijri suffix); the
 * Hijri variant (Umm al-Qura or civil) and the first day of the week come from the project's calendar config and
 * its market profile, not from the pack: packs list weekday names from Sunday, and `L.weekdays` starts on the
 * profile's first working day (Saturday where the weekend is Friday, Sunday where it is Friday–Saturday, Monday
 * where it is Saturday–Sunday).
 */
import { DIGIT_SETS, digits as toLocaleDigits, formatNumber, formatPercent } from "@saasreport/format";
import { fromISO } from "@saasreport/calendar";
import { formatDate } from "@saasreport/calendar/locale";
import { dateTag } from "@saasreport/calendar/instant";
import { weekendOf, market } from "@saasreport/calendar/markets";
import { resolveCalendarConfig } from "@saasreport/calendar/config";
import fa from "./locales/fa.js";
import en from "./locales/en.js";
import ar from "./locales/ar.js";

export const LOCALES = { fa, en, ar };
export const DIGITS = DIGIT_SETS;
export const CALENDARS = ["jalali", "gregorian", "hijri"];
export const DIRS = ["rtl", "ltr"];

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = isObj(v) && isObj(a?.[k]) ? merge(a[k], v) : v;
  return out;
}

/** Replace {name} placeholders. */
export const fill = (s, vars = {}) => String(s ?? "").replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));

/** The first day of the week (0 = Sunday) of a market profile: the day after its weekend; Monday without a profile. */
export function weekStartOf(profile, n = Math.floor(Date.now() / 864e5)) {
  if (!profile) return 1;
  const w = weekendOf(profile, n);
  for (let d = 0; d < 7; d++) if (!w.includes(d) && w.includes((d + 6) % 7)) return d;
  return 1;
}

/**
 * A locale runtime from a code ("fa", "en", "ar") or a pack, with optional overrides and the project's calendar
 * config ({ systems, primary, profiles, digits, weekStart? } of @saasreport/calendar/config):
 * { ...pack, weekdays (from the week start), weekStart, hijri ("hijri-umalqura" | "hijri-civil"), toDigits(v),
 *   number(n, { decimals }), percent(n), date(day | "YYYY-MM-DD", { calendar }), t(key, vars) }.
 */
export function createLocale(spec, overrides = {}, { calendar } = {}) {
  const base = typeof spec === "string" ? LOCALES[spec] : spec;
  if (!base) throw new Error(`unknown locale "${spec}" (known: ${Object.keys(LOCALES).join(", ")}; or pass a pack)`);
  const merged = merge(typeof spec === "string" || !spec?.extends ? base : merge(LOCALES[spec.extends], base), overrides);
  // <html lang> and hreflang: the canonical BCP 47 tag without extensions ("en-gb" → "en-GB"), the form the Worker's
  // shell uses too (normalizeConfig site.localeBase), so a site's static and Worker pages declare the same language
  const canon = (tag) => (tag ? new Intl.Locale(Intl.getCanonicalLocales(String(tag).replace(/_/g, "-"))[0]).baseName : tag);
  const pack = { ...merged, lang: canon(merged.lang), hreflang: canon(merged.hreflang) };
  // Numbers and digits: @saasreport/format, the kit's one formatter (docs/CONSTITUTION.md §7), with the pack's digits
  // and separators.
  const numerals = DIGITS[pack.digits] ? pack.digits : "latin", table = DIGITS[numerals];
  const toDigits = (v) => toLocaleDigits(v, numerals);
  const number = (n, { decimals } = {}) => formatNumber(n, pack.code, { decimals, numerals, separators: pack.number });
  const percent = (n, o = {}) => formatPercent(n, pack.code, { decimals: o.decimals, maxDecimals: o.decimals == null ? 20 : undefined, numerals, separators: pack.number });
  // calendar config: the Hijri variant and the market profile (for the week start)
  const cal = resolveCalendarConfig(calendar ?? {}, { locale: pack.code });
  const variant = cal.profile ? market(cal.profile).hijri : null;
  const hijri = cal.systems.find((x) => x.startsWith("hijri")) || (variant ? `hijri-${variant}` : "hijri-umalqura");
  const weekStart = calendar?.weekStart ?? weekStartOf(cal.profile);
  const weekdays = pack.weekdays.map((_, i) => pack.weekdays[(weekStart + i) % 7]);
  // short names for narrow screens: the pack's own, else the Intl short form (1 Jan 2023 was a Sunday)
  const short = pack.weekdaysShort || pack.weekdays.map((w, i) => {
    try { return new Intl.DateTimeFormat(dateTag(pack.lang || pack.code, "gregorian"), { weekday: "short", timeZone: "UTC" }).format(Date.UTC(2023, 0, 1 + i)); } catch { return w; /* this ICU has no names for the locale: the configured weekday name stays */ }
  });
  const weekdaysShort = short.map((_, i) => short[(weekStart + i) % 7]);
  function date(d, { calendar: system = pack.calendar } = {}) {
    const day = typeof d === "number" ? d : fromISO(String(d));
    if (!pack.months[system]) throw new Error(`locale ${pack.code} has no month names for the ${system} calendar`);
    return formatDate(day, { system: system === "hijri" ? hijri : system, locale: pack.code, pack, era: system === "hijri" });
  }
  const t = (key, vars) => {
    const v = key.split(".").reduce((o, k) => (o == null ? o : o[k]), pack.strings);
    return fill(v ?? key, vars);
  };
  return { ...pack, ...intlTags(pack, hijri), weekdays, weekdaysShort, weekStart, hijri, digitChars: table, toDigits, number, percent, date, t };
}

const CA = { hijri: "islamic-umalqura" };
const CA_HIJRI = { "hijri-umalqura": "islamic-umalqura", "hijri-civil": "islamic-civil" };
const NU = { persian: "arabext", arabic: "arab", latin: "latn" };
// Default numbering of a language in browsers' ICU, where it is reliable (fa-IR: Persian digits; en: Latin). For the
// others (ar: Latin or Arabic-Indic depending on the ICU version), the tag always names the digits.
const NU_DEFAULT = { fa: "arabext", en: "latn", fr: "latn", de: "latn", es: "latn", tr: "latn", ms: "latn", id: "latn" };
/**
 * Intl locale tags for the browser: numberIntl (numbers in the pack's digits), dateIntl (its calendar and digits),
 * dateIntlLatn (its calendar, Latin digits). A pack may set any of them itself. The date tags never resolve to ICU's
 * Persian calendar (older Safari and WebViews can be a day off): a Jalali pack gets the Gregorian calendar for layout
 * ("fa-IR-u-ca-gregory", "fa-IR-u-ca-gregory-nu-latn") and client code formats with KitFormat.formatInstant /
 * formatJalali (@saasreport/calendar's arithmetic); a Hijri pack keeps islamic-umalqura / islamic-civil.
 */
export function intlTags(pack, hijri = "hijri-umalqura") {
  const base = pack.intl || pack.lang;
  const def = NU_DEFAULT[String(base).split("-")[0]] ?? null;
  const nu = NU[pack.digits] || "latn";
  const tag = (kv) => (kv.length ? `${base}-u-${kv.join("-")}` : base);
  const ca = pack.calendar === "hijri" ? ["ca", CA_HIJRI[hijri] || CA.hijri] : CA[pack.calendar] ? ["ca", CA[pack.calendar]] : [];
  return {
    numberIntl: pack.numberIntl ?? tag(nu !== def ? ["nu", nu] : []),
    dateIntl: dateTag(pack.dateIntl ?? tag([...ca, ...(nu !== def ? ["nu", nu] : [])]), pack.calendar),
    dateIntlLatn: dateTag(pack.dateIntlLatn ?? tag([...ca, ...(def !== "latn" ? ["nu", "latn"] : [])]), pack.calendar),
  };
}

/** Problems with a locale pack (an empty list when it is complete). */
export function checkLocale(pack, where = "locale") {
  const p = [];
  const need = ["code", "lang", "dir", "hreflang", "og", "digits", "counter", "calendar", "number", "arrow", "weekdays", "months", "strings"];
  for (const k of need) if (pack?.[k] == null) p.push(`${where}: missing ${k}`);
  if (pack?.dir && !DIRS.includes(pack.dir)) p.push(`${where}: dir must be rtl or ltr`);
  if (pack?.digits && !DIGITS[pack.digits]) p.push(`${where}: digits must be one of ${Object.keys(DIGITS).join(", ")}`);
  if (pack?.calendar && !CALENDARS.includes(pack.calendar)) p.push(`${where}: calendar must be one of ${CALENDARS.join(", ")}`);
  if (pack?.calendar && pack?.months && !pack.months[pack.calendar]) p.push(`${where}: no month names for its calendar ${pack.calendar}`);
  if (pack?.weekdays && pack.weekdays.length !== 7) p.push(`${where}: weekdays must list 7 names`);
  const ref = LOCALES.fa.strings;
  const walk = (a, b, path) => { for (const k of Object.keys(a)) { if (isObj(a[k])) walk(a[k], b?.[k], `${path}${k}.`); else if (typeof b?.[k] !== "string" || !b[k]) p.push(`${where}: missing string ${path}${k}`); } };
  if (pack?.strings) walk(ref, pack.strings, "");
  return p;
}
