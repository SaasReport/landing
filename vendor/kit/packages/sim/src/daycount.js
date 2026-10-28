/**
 * Calendar arithmetic on ISO dates (YYYY-MM-DD) by integer day numbers (the proleptic Gregorian days-from-civil
 * algorithm); no Date object, no time zone, no clock. Day counts: ACT/360, ACT/365F (ISDA "Actual/365 Fixed"),
 * 30/360 (ISDA 2006 s4.16(f) "30/360", also called Bond Basis: d1 = min(d1, 30); d2 = 30 when d2 = 31 and d1 = 30; no end-of-February rule, which separates it from the NASD 30U/360). No business-day calendar:
 * schedules are on calendar dates (an assumption every pricing run lists).
 */
import { SimError } from "./errors.js";

export const DAY_COUNTS = Object.freeze(["ACT/360", "ACT/365F", "30/360"]);

export function parseDate(s, path = "") {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) throw new SimError("bad-date", "a date is YYYY-MM-DD", path);
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (mo < 1 || mo > 12 || d < 1 || d > monthLength(y, mo)) throw new SimError("bad-date", `${s} is not a calendar date`, path);
  return { y, m: mo, d };
}

export const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const monthLength = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

/** Days since 1970-01-01. */
export function dayNumber({ y, m, d }) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export const formatDate = ({ y, m, d }) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

export const daysBetween = (a, b) => dayNumber(parseDate(b)) - dayNumber(parseDate(a));

/** Add whole months, clamping the day to the month's length. */
export function addMonths(s, n) {
  const { y, m, d } = parseDate(s);
  const t = y * 12 + (m - 1) + n;
  const ny = Math.floor(t / 12), nm = (t % 12 + 12) % 12 + 1;
  return formatDate({ y: ny, m: nm, d: Math.min(d, monthLength(ny, nm)) });
}

/** Year fraction of [a, b) under a convention. */
export function yearFraction(convention, a, b) {
  const da = parseDate(a), db = parseDate(b);
  const days = dayNumber(db) - dayNumber(da);
  switch (convention) {
    case "ACT/360": return days / 360;
    case "ACT/365F": return days / 365;
    case "30/360": {
      const d1 = Math.min(da.d, 30);
      const d2 = db.d === 31 && d1 === 30 ? 30 : db.d;
      return (360 * (db.y - da.y) + 30 * (db.m - da.m) + (d2 - d1)) / 360;
    }
    default: throw new SimError("bad-day-count", `day count must be one of ${DAY_COUNTS.join(", ")}`, "dayCount");
  }
}
