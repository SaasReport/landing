/**
 * Decimal-safe money: an amount is an integer count of minor units held as a BigInt (a currency's exponent says how
 * many decimals one major unit has: 2 for cents, 0 for a unit with none). Sums, weights in basis points and ratios
 * are exact integer arithmetic with round-half-to-even; floats appear only inside risk maths (exp, sqrt, ln) and
 * are rounded back to minor units once, at the edge.
 */
import { SimError } from "./errors.js";

/** Basis points: 10000 = 100%. The one place the scaling is written. */
export const BP = 10000;
export const BPN = 10000n;

/** An input amount: a safe integer, or a string of digits, in minor units. */
export function toMinor(v, path = "") {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  throw new SimError("bad-amount", "an amount is an integer of minor units (a safe integer or a digit string)", path);
}

/** An output amount: a number while it is a safe integer, a digit string beyond. */
export const fromMinor = (b) => (b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b.toString());

/** BigInt division rounded half to even. */
export function divRound(num, den) {
  if (den === 0n) throw new SimError("div-zero", "division by zero");
  if (den < 0n) { num = -num; den = -den; }
  const q = num / den, r = num % den;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice < den) return q;
  if (twice > den) return r < 0n ? q - 1n : q + 1n;
  return q % 2n === 0n ? q : r < 0n ? q - 1n : q + 1n;
}

/** amount x basisPoints / 10000, exact, half-even. */
export const mulBp = (amount, bp) => divRound(amount * BigInt(bp), BPN);

/** amount x num / den, exact, half-even. */
export const mulRatio = (amount, num, den) => divRound(amount * BigInt(num), BigInt(den));

/** A float in minor units to a BigInt, half-even; refuses non-finite and beyond 2^53 (a float that large has lost its cents). */
export function roundMinor(x, path = "") {
  if (!Number.isFinite(x) || Math.abs(x) > Number.MAX_SAFE_INTEGER) throw new SimError("not-representable", "the amount cannot be held exactly in minor units", path);
  const f = Math.floor(x), d = x - f;
  let n = d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
  if (Object.is(n, -0)) n = 0;
  return BigInt(n);
}

/** Minor units to a float of major units (for risk maths only). */
export const toMajor = (b, exponent) => Number(b) / 10 ** exponent;

export const sum = (xs) => xs.reduce((a, b) => a + b, 0n);
export const max0 = (b) => (b > 0n ? b : 0n);

/** "12.34" with exponent 2 to 1234n; refuses more decimals than the exponent (no silent rounding of a typed amount). */
export function parseDecimal(s, exponent, path = "") {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(s));
  if (!m || (m[3] ?? "").length > exponent) throw new SimError("bad-amount", `not a decimal with at most ${exponent} places`, path);
  const frac = (m[3] ?? "").padEnd(exponent, "0");
  const v = BigInt(m[2] + frac);
  return m[1] ? -v : v;
}

/** 1234n with exponent 2 to "12.34". */
export function formatMinor(b, exponent) {
  const neg = b < 0n, a = neg ? -b : b;
  const s = a.toString().padStart(exponent + 1, "0");
  const out = exponent ? `${s.slice(0, -exponent)}.${s.slice(-exponent)}` : s;
  return neg ? `-${out}` : out;
}
