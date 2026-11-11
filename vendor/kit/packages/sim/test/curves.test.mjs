// Curves: par -> zero bootstrap, NSS, discount factors, forwards, bump-and-reprice risk, key-rate durations.
// Published worked examples used (each cited at its test): Hull, Options, Futures and Other Derivatives (Ch. 4, "Duration" and
// "Determination of Treasury zero rates" examples). Independent recomputations are labelled as such.
import { test } from "node:test";
import assert from "node:assert/strict";
import { curveFromInput, zeroRate, discountFactor, forwardRate, shiftCurve, bootstrapPar, nssRate, fitNss, NSS_BOUNDS, presentValue, solveYield, riskMeasures, tent, SimError, LIMITS } from "../src/index.js";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b} (tol ${tol})`);
const flat = (z, max = 30) => curveFromInput({ kind: "zero", compounding: "continuous", tenors: [1, max], rates: [z, z] });
const risk = (priceAt, c, o = {}) => riskMeasures(priceAt, c, { bump: LIMITS.defaultBump, ...o });
const cfs = (amounts, step = 0.5) => amounts.map((amount, i) => ({ t: (i + 1) * step, amount }));

test("Hull Table 4.6 (duration): 3y 10% semiannual bond at a 12% continuously compounded yield: price 94.213, duration 2.653 (tol 0.001)", () => {
  const c = flat(0.12), b = cfs([5, 5, 5, 5, 5, 105]);
  near(presentValue(b, c), 94.213, 0.001, "price");
  const r = risk((cc) => presentValue(b, cc), c);
  near(r.effectiveDuration, 2.653, 0.001, "duration"); // bump-and-reprice equals Macaulay for a continuous yield
  // Hull's price/duration relation: dP = -D P dy
  near(risk((cc) => presentValue(b, cc), c, { bump: 0.0005 }).effectiveDuration, r.effectiveDuration, 1e-4);
});

test("Hull (zero rates 5.0, 5.8, 6.4, 6.8% at 0.5..2y): 2y 6% bond price 98.39 (tol 0.005) and yield 6.76% continuous (tol 0.0001)", () => {
  const c = curveFromInput({ kind: "zero", compounding: "continuous", tenors: [0.5, 1, 1.5, 2], rates: [0.05, 0.058, 0.064, 0.068] });
  const b = cfs([3, 3, 3, 103]);
  const p = presentValue(b, c);
  near(p, 98.39, 0.005);
  near(solveYield(b, p, "continuous"), 0.0676, 0.0001);
  near(solveYield(b, p, "semiannual"), 0.0688, 0.0001);
});

test("bootstrap: par bonds reprice to exactly 100 with the bootstrapped discount factors (tol 1e-12)", () => {
  const tenors = [0.5, 1, 2, 3, 5, 7, 10], rates = [0.03, 0.032, 0.035, 0.0375, 0.04, 0.042, 0.045];
  const { tenors: ts, discountFactors: dfs } = bootstrapPar(tenors, rates, 2);
  assert.equal(ts.length, 20);
  const par = (T) => {
    let c = null;
    // interpolated par yield at coupon date T
    if (T <= tenors[0]) c = rates[0];
    else { let i = 1; while (tenors[i] < T - 1e-12) i++; c = rates[i - 1] + ((T - tenors[i - 1]) / (tenors[i] - tenors[i - 1])) * (rates[i] - rates[i - 1]); }
    return c;
  };
  for (const k of [2, 4, 6, 10, 14, 20]) {
    const c = par(k / 2) / 2;
    let pv = 0;
    for (let j = 1; j <= k; j++) pv += (j === k ? 1 + c : c) * dfs[j - 1];
    near(pv, 1, 1e-12, `par bond ${k / 2}y`);
  }
});

test("bootstrap: independent recomputation (Python, same formula, tol 1e-12): par 4.0/4.5/5.0/5.5% semiannual to 2y", () => {
  const { discountFactors: d, zeros: z } = bootstrapPar([0.5, 1, 1.5, 2], [0.04, 0.045, 0.05, 0.055], 2);
  [0.9803921568627451, 0.9564216884797929, 0.9283703940160357, 0.896552246635172].forEach((x, i) => near(d[i], x, 1e-12));
  [0.03960525459235951, 0.04455636644911798, 0.049549662896614215, 0.05459935458988884].forEach((x, i) => near(z[i], x, 1e-12));
});

test("bootstrap: a flat par curve is a flat zero curve in the same compounding (annual par, f = 1), and the par-as-zero shortcut is wrong on a sloped curve", () => {
  const { zeros } = bootstrapPar([1, 10], [0.05, 0.05], 1);
  zeros.forEach((z) => near(Math.exp(z) - 1, 0.05, 1e-12));
  // Upward sloping par curve: the zero rate at 10y is ABOVE the 10y par yield (the flaw of reading par as zero)
  const sloped = curveFromInput({ kind: "par", frequency: 1, tenors: [1, 10], rates: [0.02, 0.06] });
  const z10 = Math.exp(zeroRate(sloped, 10)) - 1;
  assert.ok(z10 > 0.06 + 1e-4, `zero(10y) ${z10} must exceed par 6%`);
  const parAsZero = 1 / 1.06 ** 10;
  assert.ok(Math.abs(discountFactor(sloped, 10) - parAsZero) > 1e-3, "the discount factor differs from the par-as-zero shortcut");
});

test("bootstrap: refuses what it cannot bootstrap", () => {
  assert.throws(() => bootstrapPar([1, 2.3], [0.03, 0.03], 2), /whole number of coupon periods/);
  assert.throws(() => curveFromInput({ kind: "par", frequency: 3, tenors: [1, 2], rates: [0.03, 0.03] }), SimError);
});

test("curve: interpolation, forward rates, compounding conversions, no extrapolation", () => {
  const c = curveFromInput({ kind: "zero", compounding: "annual", tenors: [1, 2, 5], rates: [0.03, 0.035, 0.04] });
  near(zeroRate(c, 1), Math.log(1.03), 1e-15);
  near(zeroRate(c, 1.5), (Math.log(1.03) + Math.log(1.035)) / 2, 1e-15);
  near(zeroRate(c, 0.25), Math.log(1.03), 1e-15); // flat before the first pillar
  near(forwardRate(c, 1, 2), discountFactor(c, 1) / discountFactor(c, 2) - 1, 1e-15);
  near(Math.exp(zeroRate(c, 2)) - 1, 0.035, 1e-15);
  assert.throws(() => zeroRate(c, 5.01), /does not extrapolate/);
  assert.throws(() => zeroRate(c, -1), SimError);
  const sa = curveFromInput({ kind: "zero", compounding: "semiannual", tenors: [1, 2], rates: [0.04, 0.04] });
  near(zeroRate(sa, 1), 2 * Math.log(1.02), 1e-15);
  assert.throws(() => curveFromInput({ kind: "zero", compounding: "continuous", tenors: [2, 1], rates: [0.01, 0.01] }), /strictly increasing/);
  assert.throws(() => curveFromInput({ kind: "zero", compounding: "continuous", tenors: [1, 2], rates: [0.01, 7] }), /rate/);
  assert.throws(() => curveFromInput({ kind: "zero", compounding: "continuous", tenors: [1, 101], rates: [0.01, 0.01] }), /tenor/);
});

test("NSS: formula limits (z(0+) = b0 + b1, z(inf) = b0) and an independent recomputation at t = 2 (Python, tol 1e-12)", () => {
  const p = { beta0: 0.05, beta1: -0.02, beta2: 0.01, beta3: 0.005, tau1: 1.5, tau2: 8 };
  near(nssRate(0, p), 0.03, 1e-6);
  near(nssRate(1e6, p), 0.05, 1e-6);
  near(nssRate(2, p), 0.04237098757792557, 1e-12);
});

test("NSS fit: recovers known parameters from noise-free zero rates (tol: rmse 1e-9, rates within 1e-8) and is deterministic", () => {
  const p = { beta0: 0.05, beta1: -0.02, beta2: 0.01, beta3: 0.005, tau1: 1.5, tau2: 8 };
  const pts = [0.25, 0.5, 1, 2, 3, 5, 7, 10, 15, 20, 30].map((t) => ({ t, rate: nssRate(t, p) }));
  const f = fitNss(pts), g = fitNss(pts);
  assert.ok(f.rmse < 1e-9, `rmse ${f.rmse}`);
  pts.forEach((x) => near(nssRate(x.t, f.params), x.rate, 1e-8));
  assert.deepEqual(f, g); // pure: no random state
  assert.equal(f.starts, 9);
});

test("NSS fit: a bootstrapped par curve is fitted as ZERO rates; documented bounds are enforced", () => {
  const c = curveFromInput({ kind: "par", frequency: 2, tenors: [0.5, 1, 2, 3, 5, 7, 10, 20, 30], rates: [0.03, 0.032, 0.035, 0.0375, 0.04, 0.042, 0.045, 0.048, 0.0485] });
  const f = fitNss(c.tenors.map((t, i) => ({ t, rate: c.zeros[i] })));
  assert.ok(f.rmse < 5e-4, `rmse ${f.rmse}`); // a 6-parameter smooth family on a smooth bootstrapped curve: within 5 bp (stated tolerance)
  assert.ok(f.params.tau1 >= NSS_BOUNDS.tau1[0] && f.params.tau2 <= NSS_BOUNDS.tau2[1]);
  assert.throws(() => fitNss([{ t: 1, rate: 0.01 }]), /at least 6/);
  assert.throws(() => fitNss(Array.from({ length: 6 }, (_, i) => ({ t: i + 1, rate: 5 }))), SimError); // 500% rates: beyond the validated range
  assert.throws(() => curveFromInput({ kind: "nss", nss: { beta0: 0.05, beta1: 0, beta2: 0, beta3: 0, tau1: 0.01, tau2: 5 } }), /tau1/);
  assert.throws(() => curveFromInput({ kind: "nss", nss: { beta0: 0.05, beta1: 0, beta2: 0, beta3: 0, tau1: 2, tau2: 2.1 } }), /tau2/);
  const n = curveFromInput({ kind: "nss", maxTenor: 10, nss: { beta0: 0.05, beta1: -0.02, beta2: 0.01, beta3: 0.005, tau1: 1.5, tau2: 8 } });
  near(zeroRate(n, 2), 0.04237098757792557, 1e-12);
  assert.throws(() => zeroRate(n, 10.5), /extrapolate/);
});

test("property: a zero shift changes nothing; shifts add; duration sign and DV01 sign for a fixed bond", () => {
  const c = flat(0.04), b = cfs([2, 2, 2, 2, 2, 2, 2, 102]);
  const price = (cc) => presentValue(b, cc);
  assert.equal(price(shiftCurve(c, () => 0)), price(c));
  near(price(shiftCurve(shiftCurve(c, () => 0.001), () => 0.002)), price(shiftCurve(c, () => 0.003)), 1e-12);
  const r = risk(price, c);
  assert.ok(r.effectiveDuration > 0 && r.dv01 > 0 && r.convexity > 0);
  assert.ok(price(shiftCurve(c, () => 0.01)) < price(c) && price(shiftCurve(c, () => -0.01)) > price(c)); // price falls when rates rise
  // independent recomputation of the 8-period 2% bond on a flat 4% continuous curve, DV01 = price gain for a 1 bp fall (plain arithmetic)
  const pv = (z) => [2, 2, 2, 2, 2, 2, 2, 102].reduce((sum, a, i) => sum + a * Math.exp(-z * (i + 1) * 0.5), 0);
  near(r.price, pv(0.04), 1e-12);
  near(r.dv01, (pv(0.04 - 0.0001) - pv(0.04 + 0.0001)) / 2, 1e-12);
  near(r.effectiveDuration, (pv(0.04 - 0.0001) - pv(0.04 + 0.0001)) / (2 * pv(0.04) * 0.0001), 1e-12);
});

test("property: parallel shifts are antisymmetric to first order and the asymmetry is the convexity", () => {
  const c = flat(0.05), b = cfs([4, 4, 4, 4, 104], 1);
  const price = (cc) => presentValue(b, cc);
  const h = 0.0005, p0 = price(c), up = price(shiftCurve(c, () => h)), dn = price(shiftCurve(c, () => -h));
  const r = risk(price, c, { bump: h });
  near((dn - up) / 2, r.effectiveDuration * p0 * h, 1e-12);
  near(up + dn - 2 * p0, r.convexity * p0 * h * h, 1e-12);
  assert.ok(up + dn - 2 * p0 > 0);
  // a zero-coupon bond is exactly linear in log price: ln P(+h) + ln P(-h) = 2 ln P0
  const zc = (cc) => 100 * discountFactor(cc, 5);
  near(Math.log(zc(shiftCurve(c, () => h))) + Math.log(zc(shiftCurve(c, () => -h))), 2 * Math.log(zc(c)), 1e-12);
  near(risk(zc, c).effectiveDuration, 5, 1e-6); // duration of a zero-coupon bond is its maturity
  near(risk(zc, c).convexity, 25, 1e-3); // convexity of a continuous zero-coupon bond is T^2
});

test("key-rate durations: tents sum to one everywhere; the key-rate durations sum to the parallel duration (tol 1e-6)", () => {
  const keys = [1, 2, 5, 10, 20];
  for (const t of [0.1, 1, 1.5, 2, 3.7, 5, 7.5, 10, 15, 20, 25]) near(keys.reduce((s, _, i) => s + tent(keys, i, t), 0), 1, 1e-12, `t=${t}`);
  const c = curveFromInput({ kind: "zero", compounding: "continuous", tenors: [0.5, 1, 2, 5, 10, 20, 30], rates: [0.03, 0.032, 0.035, 0.04, 0.043, 0.046, 0.047] });
  const b = cfs([3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 103], 1); // 20y annual 3%
  const r = risk((cc) => presentValue(b, cc), c, { keyTenors: keys });
  near(r.keyRates.reduce((s, k) => s + k.duration, 0), r.effectiveDuration, 1e-6);
  near(r.keyRates.reduce((s, k) => s + k.dv01, 0), r.dv01, 1e-6);
  assert.ok(r.keyRates[3].duration > r.keyRates[0].duration); // most of a 20y bond's risk is not at 1y
  // a 5y zero-coupon bond has all its key-rate risk at the 5y key
  const zc = risk((cc) => 100 * discountFactor(cc, 5), c, { keyTenors: keys });
  near(zc.keyRates[2].duration, 5, 1e-6);
  zc.keyRates.forEach((k, i) => { if (i !== 2) near(k.duration, 0, 1e-6); });
  assert.throws(() => risk((cc) => presentValue(b, cc), c, { keyTenors: [5, 3] }), SimError);
  assert.throws(() => risk((cc) => presentValue(b, cc), c, { keyTenors: [50] }), SimError);
});

test("risk: the bump is refused outside its validated range", () => {
  const c = flat(0.04), pr = (cc) => 100 * discountFactor(cc, 5);
  for (const bump of [0, 1e-9, 0.5, -0.0001, Number.NaN]) assert.throws(() => riskMeasures(pr, c, { bump }), /bump/, String(bump));
});

// #124 review 9: x-minTau2OverTau1 (curve-input schema, 1.2) is enforced by validateNss; the bound itself, one step below and above.
test("nss tau2 / tau1 bound: below is refused, exactly at the bound and above pass (must-fail and must-pass forms)", () => {
  const nss = (tau1, tau2) => ({ kind: "nss", maxTenor: 10, nss: { beta0: 0.05, beta1: 0, beta2: 0, beta3: 0, tau1, tau2 } });
  assert.equal(NSS_BOUNDS.minRatio, 1.2);
  const refuse = [[1, 1], [1, 1.19], [1, 1.1999999], [2, 2.39], [0.5, 0.5], [4, 4.79]];
  const pass = [[1, 1.2], [1, 1.2000001], [1, 1.21], [1, 5], [0.5, 0.6], [0.5, 30], [2, 2.4]];
  for (const [t1, t2] of refuse) assert.throws(() => curveFromInput(nss(t1, t2)), /tau2/, `tau1 ${t1}, tau2 ${t2}`);
  for (const [t1, t2] of pass) assert.doesNotThrow(() => curveFromInput(nss(t1, t2)), `tau1 ${t1}, tau2 ${t2}`);
});
