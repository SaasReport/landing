// Locale-neutral formatting of engine values for headlines and tables. Integers in, strings out, no Intl, no floats.
// Money is "USD 1,234.56": the ISO code, never a symbol, so it is unambiguous in every language and currency.
import { roundDiv, relativeChangeBp } from "./money.js";

const group = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function exponentOf(currencies, currency) {
  if (currencies.zero_decimal.includes(currency)) return 0;
  if (currencies.three_decimal.includes(currency)) return 3;
  return currencies.default_exponent;
}

/** formatMoney(currencies, "usd", 123456) -> "USD 1,234.56". A negative amount keeps its minus after the code: "USD -0.05". */
export function formatMoney(currencies, currency, minor) {
  if (!Number.isSafeInteger(minor)) throw new TypeError("amount must be an integer in minor units");
  const e = exponentOf(currencies, currency), neg = minor < 0, abs = String(Math.abs(minor)).padStart(e + 1, "0");
  const whole = group(abs.slice(0, abs.length - e)), frac = e ? `.${abs.slice(abs.length - e)}` : "";
  return `${currency.toUpperCase()} ${neg ? "-" : ""}${whole}${frac}`;
}

/** Basis points as a percentage with two decimals: 9406 -> "94.06%", -250 -> "-2.50%". */
export function formatBp(bp) {
  if (!Number.isSafeInteger(bp)) throw new TypeError("basis points must be an integer");
  const abs = Math.abs(bp);
  return `${bp < 0 ? "-" : ""}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}%`;
}

export const formatCount = (n) => {
  if (!Number.isSafeInteger(n)) throw new TypeError("count must be an integer");
  return `${n < 0 ? "-" : ""}${group(String(Math.abs(n)))}`;
};

/** Relative change from prior to current in basis points (half away from zero); null when prior is 0 or either is missing. */
export function changeBp(current, prior) {
  if (current == null || prior == null) return null;
  return relativeChangeBp(current, prior);
}

/** Format a metric value by its unit from the metrics registry. */
export function formatValue({ currencies, unit, currency, value }) {
  if (value === null || value === undefined) return "n/a";
  return unit === "money_minor" ? formatMoney(currencies, currency, value) : unit === "ratio_bp" ? formatBp(value) : formatCount(value);
}
