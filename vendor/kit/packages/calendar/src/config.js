/* @saasreport/calendar/config — the project's `calendar` block, validated and bound to the engine.

   calendar: {
     systems:  ["gregorian", "hijri-umalqura"],      // shown side by side; "hijri" = "hijri-umalqura"
     primary:  "gregorian",                          // leads labels and month grids (default: systems[0])
     profiles: ["sa", "ae", "my", "us", "uk", "eu"], // market profiles; the first is the default market
     digits:   "arabic",                             // optional; else the locale pack's / the locale default
   }

   The older shape ({ system: "jalali", holidays: "iran" }) still resolves: systems ["jalali"], profiles
   ["ir"], so an existing config needs no change. An already-normalised block (defineConfig(...).calendar, with the market ids
   in `markets`) resolves to the same profiles again. */
import { SYSTEMS, formatDate, formatDual, monthTitle } from "./locale.js";
import { market, MARKET_IDS, yearHolidays, holidaysBetween, settlementCycle } from "./markets.js";
import * as B from "./business.js";

const DEFAULT_SYSTEMS = { fa: ["jalali"], ar: ["gregorian", "hijri-umalqura"], en: ["gregorian"] };
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Normalise a `calendar` config block. Returns { systems, primary, secondary, profiles, profile, digits, problems }. */
export function resolveCalendarConfig(c = {}, { locale = "en" } = {}) {
  const problems = [];
  if (c != null && !isObj(c)) { problems.push("calendar must be an object"); c = {}; }
  c = c || {};
  const lang = String(locale).slice(0, 2);
  let systems = c.systems ?? (c.system ? [c.system] : DEFAULT_SYSTEMS[lang] || DEFAULT_SYSTEMS.en);
  if (!Array.isArray(systems) || !systems.length) { problems.push("calendar.systems must be a non-empty array"); systems = DEFAULT_SYSTEMS.en; }
  systems = [...new Set(systems.map((s) => (s === "hijri" ? "hijri-umalqura" : s)))];
  for (const s of systems) if (!SYSTEMS.includes(s)) problems.push(`calendar.systems: unknown system ${JSON.stringify(s)} (known: ${SYSTEMS.join(", ")})`);
  const primary = c.primary === "hijri" ? "hijri-umalqura" : c.primary ?? systems[0];
  if (!systems.includes(primary)) problems.push(`calendar.primary must be one of calendar.systems (got ${JSON.stringify(c.primary)})`);

  let profiles;
  // Idempotent: core's defineConfig(...).calendar keeps the market ids in `markets` and turns `profiles` into an
  // object per market, so read `markets` when `profiles` is not a list (resolving a resolved block is a no-op).
  if (!Array.isArray(c.profiles) && Array.isArray(c.markets)) profiles = c.markets.map((p) => String(p).toLowerCase());
  else if (Array.isArray(c.profiles)) profiles = c.profiles.map((p) => String(p).toLowerCase());
  else if (c.profiles == null || isObj(c.profiles)) profiles = c.holidays === "iran" || (c.holidays == null && systems[0] === "jalali") ? ["ir"] : [];
  else { problems.push("calendar.profiles must be an array of market ids"); profiles = []; }
  for (const p of profiles) if (!MARKET_IDS.includes(p)) problems.push(`calendar.profiles: unknown market ${JSON.stringify(p)} (known: ${MARKET_IDS.join(", ")})`);
  if (c.digits != null && !["latin", "arabic", "persian"].includes(c.digits)) problems.push('calendar.digits must be "latin", "arabic" or "persian"');

  return { systems, primary, secondary: systems.filter((s) => s !== primary), profiles, profile: profiles[0] || null, digits: c.digits || null, problems };
}

/** The engine bound to a config: labels in its systems, business days across its profiles. */
export function createCalendar(c = {}, { locale = "en", pack } = {}) {
  const r = resolveCalendarConfig(c, { locale });
  if (r.problems.length) throw new Error(`calendar config: ${r.problems.join("; ")}`);
  const fmt = { locale, pack, digits: r.digits || undefined };
  const pick = (p) => (p == null ? r.profiles : p);
  return {
    ...r,
    markets: r.profiles.map(market),
    label: (n, o = {}) => formatDual(n, { systems: r.systems, primary: r.primary, ...fmt, ...o }),
    format: (n, o = {}) => formatDate(n, { system: r.primary, ...fmt, ...o }),
    monthTitle: (y, m, o = {}) => monthTitle(o.system || r.primary, y, m, { ...fmt, ...o }),
    holidays: (gy, p) => pick(p).flatMap((id) => yearHolidays(id, gy)).sort((a, b) => a.date - b.date),
    holidaysBetween: (a, b, p) => pick(p).flatMap((id) => holidaysBetween(id, a, b)).sort((x, y) => x.date - y.date),
    dayStatus: (n, p) => B.dayStatus(n, pick(p)),
    isBusinessDay: (n, p) => B.isBusinessDay(n, pick(p)),
    addBusinessDays: (n, k, p) => B.addBusinessDays(n, k, pick(p)),
    settlement: (n, o = {}, p) => B.settlement(n, pick(p), o),
    settlementCycle: (n, p = r.profile) => settlementCycle(p, n),
    businessDaysBetween: (a, b, p) => B.businessDaysBetween(a, b, pick(p)),
    businessDays: (a, b, p) => B.businessDays(a, b, pick(p)),
    monthEnd: (n, p, o = {}) => B.monthEnd(n, pick(p), { system: r.primary, ...o }),
    adjust: (n, convention, p, o = {}) => B.adjust(n, convention, pick(p), o),
  };
}
