/* @saasreport/calendar/hijri — lunar Hijri calendars on the engine's day numbers (days since 1970-01-01, UTC).

   Two variants:
   - "umalqura": the official Umm al-Qura calendar of Saudi Arabia (KACST), AH 1300–1600. It comes from
     ICU's `islamic-umalqura` calendar through Intl.DateTimeFormat; ICU embeds the Umm al-Qura month-length
     table for exactly AH 1300–1600 and falls back to arithmetic outside it, so this module refuses dates
     outside that span instead of returning a guess. A runtime without that ICU calendar throws
     `unsupported_calendar` rather than silently returning another calendar.
   - "civil": the tabular Islamic calendar (30-year cycle, leap years 2, 5, 7, 10, 13, 16, 18, 21, 24, 26, 29;
     Friday epoch, 16 July 622 Julian). Pure arithmetic, no Intl; identical to ICU's `islamic-civil`.

   Neither is a moon-sighting calendar. Religious holidays computed from either are predictions and the
   markets module marks them `predicted: true`. */

const DAY = 86400000;
export const HIJRI_VARIANTS = ["umalqura", "civil"];
export const UMALQURA_RANGE = { min: 1300, max: 1600 };
export const CIVIL_RANGE = { min: 1, max: 3000 };

export class HijriError extends Error { constructor(code, message) { super(message); this.code = code; } }

/* ------------------------------------------------------------------ civil (tabular) */
const EPOCH = -492148; // 1 Muharram AH 1 (civil, Friday epoch) as a day number
const civilDays = (hy, hm, hd) => hd + Math.ceil(29.5 * (hm - 1)) + (hy - 1) * 354 + Math.floor((3 + 11 * hy) / 30) + EPOCH - 1;
export const isCivilLeap = (hy) => (14 + 11 * hy) % 30 < 11;
function civilFrom(n) {
  const hy = Math.floor((30 * (n - EPOCH) + 10646) / 10631);
  const hm = Math.min(12, Math.ceil((n - 29 - civilDays(hy, 1, 1)) / 29.5) + 1);
  return { hy, hm, hd: n - civilDays(hy, hm, 1) + 1 };
}
const civilMonthLength = (hy, hm) => (hm % 2 === 1 || (hm === 12 && isCivilLeap(hy)) ? 30 : 29);

/* ------------------------------------------------------------------ Umm al-Qura (ICU) */
let UQ = null;
function uqFormat() {
  if (UQ) return UQ;
  let f;
  try { f = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura-nu-latn", { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric" }); } catch { f = null; /* this ICU has no Umm al-Qura calendar: hasUmmAlQura() reports it */ }
  if (!f || f.resolvedOptions().calendar !== "islamic-umalqura") throw new HijriError("unsupported_calendar", "This runtime's Intl has no islamic-umalqura calendar (needs full ICU).");
  return (UQ = f);
}
/** True when this runtime's Intl provides the Umm al-Qura calendar. */
export function hasUmmAlQura() { try { uqFormat(); return true; } catch { return false; /* no Umm al-Qura calendar in this ICU: false is the answer */ } }

const uqCache = new Map();
// Raw ICU reading, no range check (used at the edges of the table).
function uqRaw(n) {
  let r = uqCache.get(n);
  if (r) return r;
  const o = {};
  for (const p of uqFormat().formatToParts(new Date(n * DAY + DAY / 2))) if (p.type === "year" || p.type === "month" || p.type === "day") o[p.type] = parseInt(p.value, 10);
  r = { hy: o.year, hm: o.month, hd: o.day };
  uqCache.set(n, r);
  return r;
}
const outOfTable = () => new HijriError("out_of_range", `Umm al-Qura dates exist for AH ${UMALQURA_RANGE.min}–${UMALQURA_RANGE.max} only.`);
function uqFrom(n) {
  const r = uqRaw(n);
  if (!(r.hy >= UMALQURA_RANGE.min && r.hy <= UMALQURA_RANGE.max)) throw outOfTable();
  return { ...r };
}
// Month starts of a Hijri year: 13 day numbers (the 13th is 1 Muharram of the next year).
const uqYears = new Map();
function uqYear(hy) {
  let starts = uqYears.get(hy);
  if (starts) return starts;
  if (!(hy >= UMALQURA_RANGE.min && hy <= UMALQURA_RANGE.max)) throw outOfTable();
  // The tabular date is within a few days of Umm al-Qura; walk to the real 1 Muharram.
  let n = civilDays(hy, 1, 1);
  for (let guard = 0; ; guard++) {
    if (guard > 60) throw new HijriError("internal", `Could not locate 1 Muharram ${hy}.`);
    const h = uqRaw(n);
    if (h.hy === hy && h.hm === 1) { n -= h.hd - 1; break; }
    n += h.hy < hy ? 1 : -1;
  }
  starts = [n];
  for (let m = 1; m <= 12; m++) { const s = starts[m - 1]; starts.push(uqRaw(s + 29).hd === 1 ? s + 29 : s + 30); }
  uqYears.set(hy, starts);
  return starts;
}

/* ------------------------------------------------------------------ public API */
const check = (variant) => { if (!HIJRI_VARIANTS.includes(variant)) throw new HijriError("invalid_variant", `Hijri variant must be one of ${HIJRI_VARIANTS.join(", ")} (got ${JSON.stringify(variant)}).`); };

/** Day number → { hy, hm, hd } in the given variant ("umalqura" by default). */
export function toHijri(n, variant = "umalqura") {
  check(variant);
  if (variant === "civil") return civilFrom(n);
  return uqFrom(n);
}
/** Days in Hijri month hm of year hy (29 or 30). */
export function hijriMonthLength(hy, hm, variant = "umalqura") {
  check(variant);
  if (!(hm >= 1 && hm <= 12)) throw new HijriError("invalid_date", `Hijri month must be 1–12 (got ${hm}).`);
  if (variant === "civil") return civilMonthLength(hy, hm);
  const s = uqYear(hy);
  return s[hm] - s[hm - 1];
}
export const hijriYearLength = (hy, variant = "umalqura") => Array.from({ length: 12 }, (_, i) => hijriMonthLength(hy, i + 1, variant)).reduce((a, b) => a + b, 0);
/** { hy, hm, hd } → day number. `hd` may be "last" for the month's last day. Throws on a day the month lacks. */
export function fromHijri(hy, hm, hd, variant = "umalqura") {
  check(variant);
  const len = hijriMonthLength(hy, hm, variant);
  const d = hd === "last" ? len : hd;
  if (!(Number.isInteger(d) && d >= 1 && d <= len)) throw new HijriError("invalid_date", `${hy}/${hm}/${hd} does not exist in the ${variant} calendar (that month has ${len} days).`);
  if (variant === "civil") {
    if (!(hy >= CIVIL_RANGE.min && hy <= CIVIL_RANGE.max)) throw new HijriError("out_of_range", `Civil Hijri years ${CIVIL_RANGE.min}–${CIVIL_RANGE.max} only.`);
    return civilDays(hy, hm, d);
  }
  return uqYear(hy)[hm - 1] + d - 1;
}
/** Same as fromHijri, but null instead of throwing when the day does not exist (30th of a 29-day month). */
export function tryFromHijri(hy, hm, hd, variant = "umalqura") {
  try { return fromHijri(hy, hm, hd, variant); } catch (e) { if (e instanceof HijriError && e.code !== "invalid_variant" && e.code !== "unsupported_calendar") return null; throw e; }
}
/** Hijri years that overlap the Gregorian year gy. */
export function hijriYearsOf(gy, variant = "umalqura") {
  const a = Math.floor(Date.UTC(gy, 0, 1) / DAY), b = Math.floor(Date.UTC(gy, 11, 31) / DAY);
  const ya = toHijri(a, variant).hy, yb = toHijri(b, variant).hy;
  const out = [];
  for (let y = ya; y <= yb; y++) out.push(y);
  return out;
}
