/**
 * Cash-flow generation and pricing of a bond, loan or sukuk-style instrument off a curve.
 *
 * Instrument types: fixed (bullet, fixed coupon), floating (bullet, coupon = projected forward + spread), amortising
 * (level payment / annuity or linear principal), profit-rate (a fixed contractual profit schedule: murabaha-style
 * deferred-sale instalments or ijara-style rentals plus a residual price).
 *
 * "profit-rate" is a PRICING ANALOGUE: it values a fixed contractual cash-flow schedule off a benchmark profit-rate
 * curve with the same discounting maths. It asserts nothing about whether a contract is Shariah-compliant and carries
 * no interest-bearing-debt assumptions: the rate is a contractual profit / rental rate, the schedule is fixed at
 * signing (no resets, no penalty accrual), and the curve is whatever benchmark profit curve the caller supplies.
 *
 * Schedules run on calendar dates (no business-day calendar, no end-of-month rule: assumptions the runs list). Periods
 * are generated backward from maturity in steps of 12/frequency months; a short first period is a stub. Discount times
 * are ACT/365F years from the valuation date. A period that has started but not ended is paid in full; accrued
 * interest is the pro-rata share (day count of the instrument) of that period's interest.
 */
import { SimError, need, isNum } from "./errors.js";
import { addMonths, daysBetween, yearFraction, DAY_COUNTS } from "./daycount.js";
import { discountFactor } from "./curve.js";

export const INSTRUMENT_LIMITS = Object.freeze({ maxYears: 100, minRate: -0.1, maxRate: 1, frequencies: [1, 2, 4, 12], maxPeriods: 1200, maxSpread: 0.5 });

export function buildPeriods(startDate, maturityDate, frequency) {
  need(INSTRUMENT_LIMITS.frequencies.includes(frequency), "bad-instrument", `frequency is one of ${INSTRUMENT_LIMITS.frequencies}`, "frequency");
  need(daysBetween(startDate, maturityDate) > 0, "bad-instrument", "maturity must be after the start date", "maturityDate");
  const step = 12 / frequency, ends = [];
  for (let k = 0; ; k++) {
    const d = addMonths(maturityDate, -k * step);
    if (daysBetween(startDate, d) <= 0) break;
    ends.push(d);
    need(ends.length <= INSTRUMENT_LIMITS.maxPeriods, "bad-instrument", "too many periods", "frequency");
  }
  ends.reverse();
  return ends.map((end, i) => ({ start: i === 0 ? startDate : ends[i - 1], end }));
}

function checkInstrument(x) {
  need(x && typeof x === "object", "bad-instrument", "an instrument is an object", "instrument");
  need(["fixed", "floating", "amortising", "profit-rate"].includes(x.type), "bad-instrument", "type is fixed, floating, amortising or profit-rate", "type");
  need(isNum(x.notional) && x.notional > 0, "bad-instrument", "notional must be a number > 0 (major units)", "notional");
  need(DAY_COUNTS.includes(x.dayCount), "bad-day-count", `dayCount is one of ${DAY_COUNTS.join(", ")}`, "dayCount");
  for (const k of ["startDate", "maturityDate", "valuationDate"]) need(typeof x[k] === "string", "bad-instrument", `${k} is required (YYYY-MM-DD)`, k);
  const years = daysBetween(x.valuationDate, x.maturityDate) / 365;
  need(years > 0, "bad-instrument", "the instrument has matured: maturity must be after the valuation date", "maturityDate");
  need(years <= INSTRUMENT_LIMITS.maxYears, "bad-instrument", `maturity is at most ${INSTRUMENT_LIMITS.maxYears} years out`, "maturityDate");
  const rate = (k, lo = INSTRUMENT_LIMITS.minRate, hi = INSTRUMENT_LIMITS.maxRate) => need(isNum(x[k]) && x[k] >= lo && x[k] <= hi, "rate-out-of-range", `${k} must be a decimal in [${lo}, ${hi}]`, k);
  if (x.type === "fixed" || x.type === "amortising") rate("rate");
  if (x.type === "floating") { rate("spread", -INSTRUMENT_LIMITS.maxSpread, INSTRUMENT_LIMITS.maxSpread); if (x.lastFixing !== undefined) rate("lastFixing"); }
  if (x.type === "amortising") need(["level", "linear"].includes(x.amortisation), "bad-instrument", "amortisation is level or linear", "amortisation");
  if (x.type === "profit-rate") {
    need(["murabaha", "ijara"].includes(x.contract), "bad-instrument", "contract is murabaha or ijara", "contract");
    rate("profitRate", 0, INSTRUMENT_LIMITS.maxRate);
    if (x.contract === "ijara") need(isNum(x.residualFraction) && x.residualFraction >= 0 && x.residualFraction <= 1, "bad-instrument", "residualFraction (final purchase price as a share of cost) is in [0, 1]", "residualFraction");
  }
}

/**
 * Cash flows still to be paid at the valuation date.
 * @returns {{cashflows: {date:string, t:number, interest:number, principal:number, amount:number}[], accrued:number, periods:number}}
 */
export function generateCashflows(x, curve = null) {
  checkInstrument(x);
  const periods = buildPeriods(x.startDate, x.maturityDate, x.frequency);
  const n = periods.length;
  const yf = (a, b) => yearFraction(x.dayCount, a, b);
  const rows = [];
  let out = x.notional;
  const level = x.type === "amortising" && x.amortisation === "level";
  const pmt = level ? (x.rate > 0 ? (x.notional * (x.rate / x.frequency)) / (1 - (1 + x.rate / x.frequency) ** -n) : x.notional / n) : 0;
  let salePrice = 0, profitTotal = 0;
  if (x.type === "profit-rate" && x.contract === "murabaha") {
    profitTotal = x.notional * x.profitRate * yf(x.startDate, x.maturityDate);
    salePrice = x.notional + profitTotal;
  }
  periods.forEach((p, i) => {
    const last = i === n - 1;
    let interest = 0, principal = 0, rate = null;
    if (x.type === "fixed") { interest = out * x.rate * yf(p.start, p.end); principal = last ? out : 0; }
    else if (x.type === "amortising") {
      interest = out * x.rate * yf(p.start, p.end);
      principal = last ? out : level ? Math.max(0, Math.min(pmt - interest, out)) : x.notional / n;
    } else if (x.type === "floating") {
      if (daysBetween(p.start, x.valuationDate) > 0) {
        need(x.lastFixing !== undefined, "floating-fixing-missing", "a floating instrument whose current period has started needs lastFixing", "lastFixing");
        rate = x.lastFixing + x.spread;
      } else {
        need(curve, "curve-required", "a floating instrument is projected off a curve", "curve");
        const t1 = daysBetween(x.valuationDate, p.start) / 365, t2 = daysBetween(x.valuationDate, p.end) / 365;
        // forward in the INSTRUMENT's day count: (DF1 / DF2 - 1) / accrual, so that coupon = N x forward x accrual telescopes to par
        rate = (discountFactor(curve, t1) / discountFactor(curve, t2) - 1) / yf(p.start, p.end) + x.spread;
      }
      interest = out * rate * yf(p.start, p.end);
      principal = last ? out : 0;
    } else if (x.contract === "murabaha") {
      const inst = salePrice / n;
      principal = x.notional / n; // cost recovered straight-line; the rest of the instalment is the profit share
      interest = inst - principal;
    } else {
      interest = x.notional * x.profitRate * yf(p.start, p.end); // ijara rental on the cost, fixed at signing
      principal = last ? x.notional * x.residualFraction : 0;
    }
    rows.push({ p, interest, principal, out });
    if (x.type !== "profit-rate") out -= principal;
  });
  const cashflows = [];
  let accrued = 0;
  for (const { p, interest, principal } of rows) {
    const d = daysBetween(x.valuationDate, p.end);
    if (d <= 0) continue; // paid on or before the valuation date
    if (daysBetween(p.start, x.valuationDate) > 0) accrued += interest * (yf(p.start, x.valuationDate) / yf(p.start, p.end));
    cashflows.push({ date: p.end, t: d / 365, interest, principal, amount: interest + principal });
  }
  return { cashflows, accrued, periods: n };
}

/** Present value of cash flows ({t, amount}) off a curve. */
export const presentValue = (cashflows, curve) => cashflows.reduce((s, c) => s + c.amount * discountFactor(curve, c.t), 0);

/** Dirty price, accrued interest and clean price of an instrument off a curve (major units). */
export function priceInstrument(x, curve) {
  const { cashflows, accrued, periods } = generateCashflows(x, curve);
  const dirty = presentValue(cashflows, curve);
  return { dirty, accrued, clean: dirty - accrued, cashflows, periods };
}

/** Yield that discounts the cash flows to `price` under a compounding convention (bisection; refuses if unbracketed). */
export function solveYield(cashflows, price, compounding = "annual") {
  const df = (y, t) => (compounding === "continuous" ? Math.exp(-y * t) : compounding === "annual" ? (1 + y) ** -t : (1 + y / 2) ** (-2 * t));
  const pv = (y) => cashflows.reduce((s, c) => s + c.amount * df(y, c.t), 0);
  let lo = -0.5, hi = 2;
  need((pv(lo) - price) * (pv(hi) - price) <= 0, "yield-not-bracketed", "no yield in [-50%, 200%] reprices to that price", "price");
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if ((pv(mid) - price) * (pv(lo) - price) <= 0) hi = mid; else lo = mid; }
  return (lo + hi) / 2;
}

export { SimError };
