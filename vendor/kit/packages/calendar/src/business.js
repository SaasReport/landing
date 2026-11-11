/* @saasreport/calendar business-day maths across one or more market profiles.

   `profiles` is a profile id ("sa"), a list (["sa", "us"]) or profile objects. With several profiles a
   day is a business day only when every market is open: a SAR/USD corridor settles on days both Riyadh
   and the Federal Reserve are open. Half days (Türkiye's eves) are open days.

   Results carry `uncertain: true` when a predicted (moon-sighting) holiday decides the answer: a
   predicted holiday on a day that would otherwise be open for that market. Iran profiles ("ir",
   "ir:government", "ir:market") delegate to index.js, so their answers are exactly the Iran engine's.

   Make-up working days (markets.js `workdays`, China's 调休) are weekend days that are working days: on them a
   market is open, `weekend` is false and `makeUp: true`, so every function here (adjust, addBusinessDays,
   settlement, businessDaysBetween, businessDays, monthEnd) counts them. */
import * as IR from "./index.js";
import { market, weekendOf, holidaysOn, dow, settlementCycle, isMakeUpWorkday, MarketError } from "./markets.js";
import { toHijri } from "./hijri.js";

const DAY = 86400000;
const isoOf = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const list = (p) => (Array.isArray(p) ? p : [p]).map(market);
const ir = (m) => ({ profile: m.iran });
// Iran-only profiles keep the Jalali months for the "modified" conventions and month-end.
const defaultSystem = (profiles) => (list(profiles).every((m) => m.iran) ? "jalali" : "gregorian");

/** Why each market is closed (or open) on day n. */
export function marketStatus(n, profile) {
  const m = market(profile);
  if (m.iran) {
    const s = IR.dayStatus(n, ir(m));
    return { profile: m.id, open: s.business, weekend: s.weekend, holiday: s.holiday, half: false, uncertain: s.uncertain, holidays: IR.holidaysOn(n).map((e) => ({ title: { fa: e.title }, predicted: e.status === "predicted" })) };
  }
  const hol = holidaysOn(m.id, n), closing = hol.filter((h) => !h.half);
  const makeUp = isMakeUpWorkday(m.id, n);
  const weekend = !makeUp && weekendOf(m.id, n).includes(dow(n));
  const uncertain = !weekend && closing.length > 0 && closing.every((h) => h.predicted);
  const s = { profile: m.id, open: !weekend && !closing.length, weekend, holiday: closing.length > 0, half: !weekend && !closing.length && hol.some((h) => h.half), uncertain, holidays: hol };
  if (makeUp) s.makeUp = true;
  return s;
}
/** Status of day n across profiles: { business, closed: [ids], markets: [...], uncertain }. */
export function dayStatus(n, profiles) {
  const ms = list(profiles).map((m) => marketStatus(n, m));
  return { date: n, iso: isoOf(n), business: ms.every((s) => s.open), closed: ms.filter((s) => !s.open).map((s) => s.profile), half: ms.some((s) => s.half), uncertain: ms.some((s) => s.uncertain), markets: ms };
}
export const isBusinessDay = (n, profiles) => list(profiles).every((m) => marketStatus(n, m).open);

const touchesPredicted = (a, b, profiles) => {
  const ms = list(profiles);
  for (let n = Math.min(a, b); n <= Math.max(a, b); n++) if (ms.some((m) => marketStatus(n, m).uncertain)) return true;
  return false;
};

/** The month of a day in a calendar system, for the "modified" conventions and month-end. */
function monthKey(n, system = "gregorian") {
  if (system === "jalali") { const j = IR.toJalali(n); return j.jy * 12 + j.jm; }
  if (system === "hijri-umalqura" || system === "hijri-civil") { const h = toHijri(n, system.slice(6)); return h.hy * 12 + h.hm; }
  const d = new Date(n * DAY); return d.getUTCFullYear() * 12 + d.getUTCMonth() + 1;
}

export const CONVENTIONS = ["following", "modified_following", "preceding", "modified_preceding", "nearest", "none"];
/** Roll a day to a business day. { system } picks the month the "modified" conventions stay in
 *  (gregorian by default; jalali when every profile is Iranian). "nearest" takes the closer of the next and
 *  previous business days; a tie goes forward. */
export function adjust(n, convention = "following", profiles, { system = defaultSystem(profiles) } = {}) {
  if (!CONVENTIONS.includes(convention)) throw new MarketError("invalid_convention", `Convention must be one of ${CONVENTIONS.join(", ")}.`);
  if (convention === "none" || isBusinessDay(n, profiles)) return { date: n, iso: isoOf(n), moved: 0, uncertain: touchesPredicted(n, n, profiles) };
  const step = (dir) => { let d = n; do d += dir; while (!isBusinessDay(d, profiles)); return d; };
  let d;
  if (convention === "nearest") { const f = step(1), p = step(-1); d = f - n <= n - p ? f : p; }
  else d = convention.endsWith("preceding") ? step(-1) : step(1);
  if (convention.startsWith("modified_") && monthKey(d, system) !== monthKey(n, system)) d = convention === "modified_following" ? step(-1) : step(1);
  return { date: d, iso: isoOf(d), moved: d - n, uncertain: touchesPredicted(n, d, profiles) };
}
/** n plus k business days (k may be negative). k = 0 rolls forward to a business day. */
export function addBusinessDays(n, k, profiles) {
  if (!Number.isInteger(k) || Math.abs(k) > 3650) throw new MarketError("invalid_days", "Business days must be an integer between -3650 and 3650.");
  if (k === 0) return adjust(n, "following", profiles);
  let d = n, left = Math.abs(k); const dir = Math.sign(k);
  while (left) { d += dir; if (isBusinessDay(d, profiles)) left--; }
  return { date: d, iso: isoOf(d), moved: d - n, uncertain: touchesPredicted(n, d, profiles) };
}
/** T+n settlement: n business days after the trade date, counting only days every profile is open.
 *  Without t, uses the longest official cycle of the profiles on the trade date (throws when none is known). */
export function settlement(n, profiles, { t } = {}) {
  let cycle = t;
  if (cycle == null) {
    const known = list(profiles).map((m) => settlementCycle(m, n));
    if (known.some((c) => !c)) throw new MarketError("no_cycle", "No official settlement cycle is recorded for every profile; pass { t }.");
    cycle = Math.max(...known.map((c) => c.t));
  }
  return { t: cycle, ...addBusinessDays(n, cycle, profiles) };
}
/** Business days in (a, b], negative when b < a, plus the days in between that are closed and why. */
export function businessDaysBetween(a, b, profiles) {
  const [lo, hi, s] = a <= b ? [a, b, 1] : [b, a, -1];
  let c = 0; const closed = [];
  for (let d = lo + 1; d <= hi; d++) { const st = dayStatus(d, profiles); if (st.business) c++; else closed.push({ date: d, iso: st.iso, closed: st.closed }); }
  return { business: c * s, calendar: b - a, closed, uncertain: touchesPredicted(lo, hi, profiles) };
}
/** The business days in [a, b] (inclusive) as day numbers. */
export function businessDays(a, b, profiles) {
  const out = [];
  for (let d = Math.min(a, b); d <= Math.max(a, b); d++) if (isBusinessDay(d, profiles)) out.push(d);
  return out;
}
/** Last business day of the month containing n (in `system`; gregorian by default, jalali for Iran-only). */
export function monthEnd(n, profiles, { system = defaultSystem(profiles) } = {}) {
  const k = monthKey(n, system);
  let last = n; while (monthKey(last + 1, system) === k) last++;
  let d = last; while (!isBusinessDay(d, profiles)) d--;
  if (monthKey(d, system) !== k) throw new MarketError("no_business_day", "No business day in that month for these profiles.");
  return { date: d, iso: isoOf(d), calendarEnd: last, uncertain: touchesPredicted(d, last, profiles) };
}
