/**
 * Curves. Internally every curve is a set of continuously compounded zero rates z(t) with discount factor
 * DF(t) = exp(-z(t) t). A curve is built from a CurveInput (kit.curve-input.v1):
 *   zero  : zero rates at tenors, any of continuous / annual / semiannual compounding, interpolated linearly in z(t),
 *           flat before the first tenor, REFUSED beyond the last (no extrapolation: an out-of-range price is not a price);
 *   par   : par-bond yields, BOOTSTRAPPED to zero rates (bootstrap.js), never read as zero rates;
 *   nss   : Nelson-Siegel-Svensson parameters (nss.js), valid on (0, maxTenor].
 * Time is in years on an ACT/365F basis from the valuation date (an assumption the runs list).
 */
import { SimError, need, isNum } from "./errors.js";
import { nssRate, validateNss } from "./nss.js";
import { bootstrapPar } from "./bootstrap.js";

export const CURVE_LIMITS = Object.freeze({ maxTenor: 100, minRate: -0.1, maxRate: 1, minPillars: 2, maxPillars: 200 });
const EPS = 1e-9;

/** Rate in a compounding convention to a continuously compounded rate. */
export function toContinuous(rate, compounding, path = "") {
  switch (compounding) {
    case "continuous": return rate;
    case "annual": need(rate > -1, "bad-rate", "an annually compounded rate must exceed -100%", path); return Math.log(1 + rate);
    case "semiannual": need(rate > -2, "bad-rate", "a semiannually compounded rate must exceed -200%", path); return 2 * Math.log(1 + rate / 2);
    default: throw new SimError("bad-compounding", "compounding is continuous, annual or semiannual", path);
  }
}

/** Continuous rate back to a convention. */
export function fromContinuous(z, compounding) {
  switch (compounding) {
    case "continuous": return z;
    case "annual": return Math.exp(z) - 1;
    case "semiannual": return 2 * (Math.exp(z / 2) - 1);
    default: throw new SimError("bad-compounding", "compounding is continuous, annual or semiannual");
  }
}

function checkPillars(tenors, rates, path) {
  need(Array.isArray(tenors) && Array.isArray(rates) && tenors.length === rates.length, "bad-curve", "tenors and rates must be arrays of the same length", path);
  need(tenors.length >= CURVE_LIMITS.minPillars && tenors.length <= CURVE_LIMITS.maxPillars, "bad-curve", `a curve has ${CURVE_LIMITS.minPillars} to ${CURVE_LIMITS.maxPillars} pillars`, path);
  tenors.forEach((t, i) => {
    need(isNum(t) && t > 0 && t <= CURVE_LIMITS.maxTenor, "bad-curve", `a tenor is a number of years in (0, ${CURVE_LIMITS.maxTenor}]`, `${path}/tenors/${i}`);
    if (i) need(t > tenors[i - 1], "bad-curve", "tenors must be strictly increasing", `${path}/tenors/${i}`);
    need(isNum(rates[i]) && rates[i] >= CURVE_LIMITS.minRate && rates[i] <= CURVE_LIMITS.maxRate, "rate-out-of-range", `a rate is a decimal in [${CURVE_LIMITS.minRate}, ${CURVE_LIMITS.maxRate}]`, `${path}/rates/${i}`);
  });
}

function pillarCurve(tenors, zeros, source) {
  const max = tenors[tenors.length - 1];
  const base = (t) => {
    if (t <= tenors[0]) return zeros[0];
    let i = 1;
    while (tenors[i] < t) i++;
    const w = (t - tenors[i - 1]) / (tenors[i] - tenors[i - 1]);
    return zeros[i - 1] + w * (zeros[i] - zeros[i - 1]);
  };
  return { kind: "pillars", source, tenors: [...tenors], zeros: [...zeros], max, base };
}

/** Build a curve from a CurveInput. */
export function curveFromInput(input, path = "curve") {
  need(input && typeof input === "object", "bad-curve", "a curve input is an object", path);
  if (input.kind === "nss") {
    const p = validateNss(input.nss, `${path}/nss`);
    const max = input.maxTenor;
    need(isNum(max) && max > 0 && max <= CURVE_LIMITS.maxTenor, "bad-curve", `maxTenor is required and in (0, ${CURVE_LIMITS.maxTenor}] years (no hidden default)`, `${path}/maxTenor`);
    return { kind: "nss", source: "nss", nss: p, max, base: (t) => nssRate(t, p) };
  }
  checkPillars(input.tenors, input.rates, path);
  if (input.kind === "zero") {
    const zeros = input.rates.map((r, i) => toContinuous(r, input.compounding, `${path}/rates/${i}`));
    return pillarCurve(input.tenors, zeros, "zero");
  }
  if (input.kind === "par") {
    const { tenors, zeros } = bootstrapPar(input.tenors, input.rates, input.frequency, path);
    return pillarCurve(tenors, zeros, "par-bootstrapped");
  }
  throw new SimError("bad-curve", "kind is zero, par or nss", `${path}/kind`);
}

export function zeroRate(c, t) {
  need(isNum(t) && t >= 0, "bad-maturity", "maturity must be a finite number >= 0");
  if (t > c.max + EPS) throw new SimError("outside-curve", `maturity ${t.toFixed(4)}y is beyond the curve's last point (${c.max}y); the engine does not extrapolate`);
  return c.base(Math.min(t, c.max));
}
export const discountFactor = (c, t) => Math.exp(-zeroRate(c, t) * t);

/** Simple forward rate over [t1, t2] implied by the discount factors: (DF1/DF2 - 1) / (t2 - t1). */
export function forwardRate(c, t1, t2) {
  need(t2 > t1, "bad-forward", "a forward needs t2 > t1");
  return (discountFactor(c, t1) / discountFactor(c, t2) - 1) / (t2 - t1);
}

/** A curve with a shift s(t) (decimal, continuously compounded) added to every zero rate. */
export function shiftCurve(c, s) {
  return { ...c, kind: `${c.kind}+shift`, base: (t) => c.base(t) + s(t) };
}
