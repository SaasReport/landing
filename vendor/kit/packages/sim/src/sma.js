/**
 * SMA: the Basel III standardised measurement approach for operational risk.
 * Standard: Basel Framework OPE25 (components, BIC, ILM, loss component) and OPE10 (BI definition); BCBS d424, December 2017.
 *
 *   ILDC = min(avg |interest income - interest expense|, 2.25% avg interest earning assets) + avg dividend income
 *   SC   = max(avg other operating income, avg other operating expense) + max(avg fee income, avg fee expense)
 *   FC   = avg |net P&L trading book| + avg |net P&L banking book|           (net items first per year, then the 3-year average; OPE25.5 fn 1)
 *   BI = ILDC + SC + FC;  BIC = 12% x BI up to EUR 1bn, 15% to EUR 30bn, 18% above (marginal)          OPE25.7 Table 1
 *   LC = 15 x average annual losses over 10 years (events of at least the threshold)                      OPE25.8
 *   ILM = ln(e - 1 + (LC / BIC)^0.8); ILM = 1 for BI up to EUR 1bn                                        OPE25.8, 25.11
 *   ORC = BIC x ILM;  RWA = 12.5 x ORC                                                                    OPE25.2
 * The final standard is implemented. The 2016 consultative SMA (11/15/19/23% at 1/3/10/30bn, ILM = ln(1.7183 + LC/BIC)) that
 * the BaselTools repository implements is superseded and is NOT implemented. With 5 to 9 years of loss data (transition,
 * OPE25.10) the average is over the years given; with fewer than 5 the capital is the BIC (ILM = 1). Amounts are in the
 * table's currency (EUR): another currency is refused rather than converted (a profile would have to restate the thresholds).
 */
import { need } from "./errors.js";
import { toMinor, divRound, mulBp, fromMinor, sum, BP } from "./money.js";

const T = "sma";
export const SMA_YEARS = 3;
export const SMA_ITEMS = ["interestIncome", "interestExpense", "interestEarningAssets", "dividendIncome", "otherOperatingIncome", "otherOperatingExpense", "feeIncome", "feeExpense", "tradingBookPnl", "bankingBookPnl"];
const abs = (b) => (b < 0n ? -b : b);
const max = (a, b) => (a > b ? a : b);
const min = (a, b) => (a < b ? a : b);

export function runSma(TB, input) {
  const v = (id) => TB.value(T, id);
  const cur = TB.tables[T].currency;
  need(input.currency === cur, "currency-mismatch", `the SMA thresholds are in ${cur}; amounts in ${input.currency} are refused (restate the thresholds in a profile, no conversion is done here)`, "currency");
  const e = input.minorExponent;
  need(Number.isInteger(e) && e >= 0 && e <= 6, "bad-input", "minorExponent is an integer 0..6", "minorExponent");
  need(Array.isArray(input.years) && input.years.length === SMA_YEARS, "bad-input", "years has the three most recent financial years (t-2, t-1, t)", "years");
  const ys = input.years.map((y, i) => {
    const o = {};
    for (const k of SMA_ITEMS) {
      need(y && y[k] !== undefined, "bad-input", `${k} is required`, `years/${i}/${k}`);
      o[k] = toMinor(y[k], `years/${i}/${k}`);
    }
    for (const k of ["interestIncome", "interestExpense", "interestEarningAssets", "dividendIncome", "otherOperatingIncome", "otherOperatingExpense", "feeIncome", "feeExpense"]) need(o[k] >= 0n, "bad-input", `${k} is not negative`, `years/${i}/${k}`);
    return o;
  });
  const avg = (f) => divRound(sum(ys.map(f)), BigInt(SMA_YEARS));
  const ildc = min(avg((y) => abs(y.interestIncome - y.interestExpense)), mulBp(avg((y) => y.interestEarningAssets), v("ildc-cap"))) + avg((y) => y.dividendIncome);
  const sc = max(avg((y) => y.otherOperatingIncome), avg((y) => y.otherOperatingExpense)) + max(avg((y) => y.feeIncome), avg((y) => y.feeExpense));
  const fc = avg((y) => abs(y.tradingBookPnl)) + avg((y) => abs(y.bankingBookPnl));
  const bi = ildc + sc + fc;
  const unit = 10n ** BigInt(e);
  const t1 = BigInt(v("threshold1")) * unit, t2 = BigInt(v("threshold2")) * unit;
  const c1 = v("bucket1-coefficient"), c2 = v("bucket2-coefficient"), c3 = v("bucket3-coefficient");
  const bic = mulBp(min(bi, t1), c1) + (bi > t1 ? mulBp(min(bi, t2) - t1, c2) : 0n) + (bi > t2 ? mulBp(bi - t2, c3) : 0n);
  const bucket = bi <= t1 ? 1 : bi <= t2 ? 2 : 3;
  let lc = null, ilm = 1, lossYears = null, note = null;
  if (bucket === 1) note = "BI is within the first bucket: the ILM is 1 and internal losses do not enter (OPE25.11)";
  else {
    const h = input.lossHistory;
    const minYears = v("loss-years-min"), fullYears = v("loss-years-full");
    if (!h || !Number.isInteger(h.years) || h.years < minYears) note = `fewer than ${minYears} years of loss data: capital is the BIC (OPE25.10)`;
    else {
      need(h.years <= fullYears, "bad-input", `lossHistory.years is at most ${fullYears}`, "lossHistory/years");
      const thr = BigInt(v("loss-threshold")) * unit;
      need(Array.isArray(h.events), "bad-input", "lossHistory.events is a list", "lossHistory/events");
      let total = 0n;
      h.events.forEach((ev, i) => {
        need(Number.isInteger(ev.yearIndex) && ev.yearIndex >= 0 && ev.yearIndex < h.years, "bad-input", "yearIndex is inside the loss history", `lossHistory/events/${i}/yearIndex`);
        const a = toMinor(ev.amount, `lossHistory/events/${i}/amount`);
        need(a >= 0n, "bad-input", "a loss amount is not negative", `lossHistory/events/${i}/amount`);
        if (a >= thr) total += a;
      });
      lossYears = h.years;
      lc = divRound(BigInt(v("loss-component-multiplier")) * total, BigInt(h.years));
      need(bic > 0n, "bad-input", "BIC is zero: the loss ratio is undefined", "years");
      // the loss ratio from exact integers (18 digits), so amounts beyond 2^53 lose nothing before the logarithm
      const ratio = Number((lc * 10n ** 18n) / bic) / 1e18;
      ilm = Math.log(Math.E - 1 + ratio ** (v("ilm-exponent") / BP));
      need(Number.isFinite(ilm), "not-finite", "the internal loss multiplier is not finite", "lossHistory");
    }
  }
  // ORC = BIC x ILM in integers: the multiplier is scaled to 12 decimals and the product rounded half-even, exact at any size
  const orc = divRound(bic * BigInt(Math.round(ilm * 1e12)), 10n ** 12n);
  return {
    currency: cur, minorExponent: e,
    ildc: fromMinor(ildc), sc: fromMinor(sc), fc: fromMinor(fc), bi: fromMinor(bi), bucket, bic: fromMinor(bic),
    lossComponent: lc === null ? null : fromMinor(lc), lossYears, ilm, ilmApplied: lc !== null, orc: fromMinor(orc), rwa: fromMinor(mulBp(orc, v("rwa-multiplier"))), note,
  };
}
