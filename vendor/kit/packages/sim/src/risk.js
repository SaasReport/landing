/**
 * Bump-and-reprice risk: effective duration, convexity, DV01 and key-rate durations by full revaluation.
 *
 *   P0, P+ = P(z + h), P- = P(z - h)  with z the zero curve and h the bump (parallel, continuously compounded; the caller names it)
 *   effective duration D = (P- - P+) / (2 P0 h)         convexity C = (P+ + P- - 2 P0) / (P0 h^2)
 *   DV01 = (P- - P+) / 2 x (1 bp / h): the price GAIN for a 1 bp fall in rates, positive for a long fixed-rate bond
 * (Fabozzi, Fixed Income Mathematics, ch. on duration and convexity; Tuckman & Serrat ch. 5; central differences).
 * Key-rate durations (Ho 1992) shift the zero curve by a triangular tent centred on each key tenor; the tents sum to
 * one at every maturity, so the key-rate durations add up to the parallel effective duration (to O(h^2)).
 */
import { need, isNum } from "./errors.js";
import { shiftCurve } from "./curve.js";
import { LIMITS } from "./limits.js";

export const RISK_LIMITS = Object.freeze({ minBump: 1e-6, maxBump: 0.01 });

function checkBump(h) { need(isNum(h) && h >= RISK_LIMITS.minBump && h <= RISK_LIMITS.maxBump, "bump-out-of-range", `the bump is a decimal rate in [${RISK_LIMITS.minBump}, ${RISK_LIMITS.maxBump}] (0.01 bp to 100 bp); the caller names it`, "bump"); }

/** Weight of key tenor i at maturity t (triangular; flat beyond the first and last key). */
export function tent(keys, i, t) {
  const k = keys[i];
  if (i === 0 && t <= k) return 1;
  if (i === keys.length - 1 && t >= k) return 1;
  if (i > 0 && t >= keys[i - 1] && t <= k) return (t - keys[i - 1]) / (k - keys[i - 1]);
  if (i < keys.length - 1 && t > k && t <= keys[i + 1]) return (keys[i + 1] - t) / (keys[i + 1] - k);
  return 0;
}

/** @param {(curve)=>number} priceAt */
export function riskMeasures(priceAt, curve, { bump, keyTenors = [] } = {}) {
  checkBump(bump);
  const p0 = priceAt(curve);
  need(isNum(p0) && p0 !== 0, "bad-price", "the base price must be a non-zero number");
  const up = priceAt(shiftCurve(curve, () => bump)), dn = priceAt(shiftCurve(curve, () => -bump));
  const out = {
    price: p0,
    effectiveDuration: (dn - up) / (2 * p0 * bump),
    convexity: (up + dn - 2 * p0) / (p0 * bump * bump),
    dv01: ((dn - up) / 2) * (LIMITS.oneBp / bump),
  };
  need(keyTenors.length <= LIMITS.maxKeyTenors, "too-many-key-tenors", `at most ${LIMITS.maxKeyTenors} key tenors`, "keyTenors");
  if (keyTenors.length) {
    keyTenors.forEach((k, i) => {
      need(isNum(k) && k > 0 && k <= curve.max && (i === 0 || k > keyTenors[i - 1]), "bad-key-tenor", "key tenors are increasing years inside the curve", `keyTenors/${i}`);
    });
    out.keyRates = keyTenors.map((k, i) => {
      const u = priceAt(shiftCurve(curve, (t) => bump * tent(keyTenors, i, t)));
      const d = priceAt(shiftCurve(curve, (t) => -bump * tent(keyTenors, i, t)));
      return { tenor: k, duration: (d - u) / (2 * p0 * bump), dv01: ((d - u) / 2) * (LIMITS.oneBp / bump) };
    });
  }
  return out;
}
