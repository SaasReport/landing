/**
 * Standard normal CDF, Phi(x), to about 1e-15 absolute: Phi(x) = 1/2 + phi(x) * sum_{n>=0} x^(2n+1) / (1 * 3 * 5 * ... * (2n+1))
 * (Abramowitz & Stegun 26.2.? series form; all terms of one sign, so no cancellation). |x| > 9 returns 0 or 1 (the tail is below 1e-19).
 */
export function normalCdf(x) {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? NaN : x > 0 ? 1 : 0;
  if (x > 9) return 1;
  if (x < -9) return 0;
  const a = Math.abs(x);
  const phi = Math.exp(-0.5 * a * a) / Math.sqrt(2 * Math.PI);
  if (a > 3) {
    // upper tail by the continued fraction Q(a) = phi(a) / (a + 1/(a + 2/(a + 3/(a + ...)))) (A&S 26.2.? ; converges fast for a > 3)
    let f = a;
    for (let k = 80; k >= 1; k--) f = a + k / f;
    const q = phi / f;
    return x > 0 ? 1 - q : q;
  }
  let term = a, sum = a;
  for (let n = 1; n < 200; n++) {
    term *= (a * a) / (2 * n + 1);
    sum += term;
    if (term < 1e-17 * sum) break;
  }
  const p = 0.5 + phi * sum;
  return x >= 0 ? p : 1 - p;
}
