// Integer money. Amounts are whole minor units (cents); ratios are whole basis points. No floating point anywhere.
// Every multiplication that scales a value (by 10000, by 12, by a period factor) happens in BigInt, so a large
// tenant (hundreds of billions in a zero-decimal currency) cannot overflow before the division.

const MAX = BigInt(Number.MAX_SAFE_INTEGER);

function big(x) {
  if (!Number.isSafeInteger(x)) throw new RangeError("needs safe integers");
  return BigInt(x);
}

/** n / d rounded half away from zero; d is non-zero. BigInt in, BigInt out. */
export function divRoundBig(n, d) {
  if (d === 0n) throw new RangeError("zero denominator");
  if (d < 0n) { n = -n; d = -d; }
  const negative = n < 0n;
  if (negative) n = -n;
  const q = (2n * n + d) / (2n * d);
  return negative ? -q : q;
}

/** (product of numerators) / (product of denominators), half away from zero; the result must be a safe integer. */
export function mulDiv(numerators, denominators = [1]) {
  const n = numerators.reduce((p, x) => p * big(x), 1n);
  const d = denominators.reduce((p, x) => p * big(x), 1n);
  const q = divRoundBig(n, d);
  if (q > MAX || q < -MAX) throw new RangeError("result exceeds the safe integer range");
  return Number(q);
}

/** Divide two integers, rounding half away from zero. */
export const roundDiv = (numerator, denominator) => mulDiv([numerator], [denominator]);

/** numerator / denominator as basis points (10000 = 100%), half away from zero; null when the denominator is zero. */
export const ratioBp = (numerator, denominator) => (denominator === 0 ? null : mulDiv([numerator, 10000], [denominator]));

/**
 * Relative change from prior to current in basis points, half away from zero; null when prior is 0.
 * A change too large to represent (more than 9 quadrillion basis points) is clamped to +/- Number.MAX_SAFE_INTEGER,
 * which keeps every threshold comparison correct without failing the report.
 */
export function relativeChangeBp(current, prior) {
  if (prior === 0) return null;
  const q = divRoundBig((big(current) - big(prior)) * 10000n, big(prior) < 0n ? -big(prior) : big(prior));
  return Number(q > MAX ? MAX : q < -MAX ? -MAX : q);
}
