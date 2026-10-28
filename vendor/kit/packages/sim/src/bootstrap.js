/**
 * Par yield to zero curve, the bootstrap (standard coupon-bond bootstrap; e.g. Hull, Options, Futures and Other
 * Derivatives, "Determination of Treasury zero rates"; Tuckman & Serrat, Fixed Income Securities, ch. 2).
 *
 * A par bond with coupon c paying f times a year and maturing at t_k = k/f is priced at 100, so with discount factors
 * DF_j at the coupon dates:   1 = (c/f) * sum_{j<=k} DF_j + DF_k   =>   DF_k = (1 - (c/f) * sum_{j<k} DF_j) / (1 + c/f).
 * The par yield at each coupon date is read from the input pillars by linear interpolation (flat before the first
 * pillar; the last pillar must be a coupon date). The output is the zero curve at the coupon dates, continuously
 * compounded: z_k = -ln(DF_k) / t_k. Re-pricing every input par bond with these discount factors returns 100
 * (tested to 1e-12).
 *
 * The flaw this replaces: treating the par yield as the zero rate (yield-curve-sim curve.py `discount`). For an upward
 * sloping curve the par yield is below the zero rate at long tenors, so that shortcut mis-prices every cash flow.
 */
import { need } from "./errors.js";

export function bootstrapPar(tenors, parRates, frequency, path = "curve") {
  need([1, 2, 4, 12].includes(frequency), "bad-curve", "a par curve declares its coupon frequency (1, 2, 4 or 12 a year)", `${path}/frequency`);
  const h = 1 / frequency, last = tenors[tenors.length - 1];
  need(tenors[0] >= h - 1e-9, "bad-curve", `the first par tenor (${tenors[0]}y) must be at least one coupon period (1/${frequency} y); money-market pillars are not bootstrapped, give them as a zero curve`, `${path}/tenors/0`);
  const K = Math.round(last / h);
  need(Math.abs(K * h - last) < 1e-9, "bad-curve", `the last par tenor (${last}y) must be a whole number of coupon periods (1/${frequency} y)`, `${path}/tenors`);
  need(K <= 1200, "bad-curve", "too many coupon dates", `${path}/tenors`);
  const par = (t) => {
    if (t <= tenors[0]) return parRates[0];
    let i = 1;
    while (i < tenors.length - 1 && tenors[i] < t - 1e-12) i++;
    const w = (t - tenors[i - 1]) / (tenors[i] - tenors[i - 1]);
    return parRates[i - 1] + w * (parRates[i] - parRates[i - 1]);
  };
  const ts = [], zs = [], dfs = [];
  let annuity = 0; // sum of DF_j for j < k
  for (let k = 1; k <= K; k++) {
    const t = k * h, c = par(t) / frequency;
    const df = (1 - c * annuity) / (1 + c);
    need(df > 0, "bootstrap-failed", `the par curve implies a non-positive discount factor at ${t}y: the rates are not a valid par curve`, `${path}/rates`);
    annuity += df;
    dfs.push(df); ts.push(t); zs.push(-Math.log(df) / t);
  }
  return { tenors: ts, zeros: zs, discountFactors: dfs };
}
