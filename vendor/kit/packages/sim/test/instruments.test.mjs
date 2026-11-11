// Cash-flow generation and pricing: fixed, floating, amortising and the profit-rate pricing analogue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { curveFromInput, buildPeriods, generateCashflows, priceInstrument, discountFactor, SimError } from "../src/index.js";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b} (tol ${tol})`);
const curve = (z = 0.04) => curveFromInput({ kind: "zero", compounding: "continuous", tenors: [1, 30], rates: [z, z] });
const base = { notional: 1000, dayCount: "30/360", startDate: "2025-01-15", maturityDate: "2030-01-15", valuationDate: "2025-01-15", frequency: 2 };

test("schedule: backward from maturity, calendar dates, stub first period", () => {
  const p = buildPeriods("2025-01-15", "2026-01-15", 2);
  assert.deepEqual(p.map((x) => x.end), ["2025-07-15", "2026-01-15"]);
  const stub = buildPeriods("2025-03-01", "2026-01-15", 2);
  assert.deepEqual(stub.map((x) => [x.start, x.end]), [["2025-03-01", "2025-07-15"], ["2025-07-15", "2026-01-15"]]);
  assert.equal(buildPeriods("2025-01-31", "2025-04-30", 12).length, 3);
  assert.throws(() => buildPeriods("2025-01-01", "2025-01-01", 2), SimError);
  assert.throws(() => buildPeriods("2025-01-01", "2026-01-01", 5), /frequency/);
});

test("fixed bond: coupons, principal, dirty = clean + accrued; dirty price equals an independent PV with dates by hand (tol 1e-9)", () => {
  const z = 0.04, c = curve(z), cpn = 0.05;
  const x = { ...base, type: "fixed", rate: cpn, notional: 100 };
  const r = priceInstrument(x, c);
  // 30/360 coupons of 100 x 5% / 2 = 2.5 on 15 Jul and 15 Jan; discount times ACT/365F from 2025-01-15 (days counted with Date.UTC, not the engine)
  const d = (y, m, dd) => (Date.UTC(y, m, dd) - Date.UTC(2025, 0, 15)) / 864e5;
  const ends = [[2025, 6, 15], [2026, 0, 15], [2026, 6, 15], [2027, 0, 15], [2027, 6, 15], [2028, 0, 15], [2028, 6, 15], [2029, 0, 15], [2029, 6, 15], [2030, 0, 15]];
  const pv = ends.reduce((s, e, i) => s + (2.5 + (i === 9 ? 100 : 0)) * Math.exp(-z * d(...e) / 365), 0);
  near(r.dirty, pv, 1e-9);
  assert.equal(r.cashflows.length, 10);
  near(r.cashflows.at(-1).amount, 100 + 100 * cpn / 2, 1e-9);
  assert.equal(r.accrued, 0);
  const mid = priceInstrument({ ...x, valuationDate: "2025-04-15" }, c); // a quarter into the first period
  near(mid.accrued, (100 * cpn / 2) * 0.5, 1e-9); // 30/360: 90 of 180 days
  near(mid.clean, mid.dirty - mid.accrued, 1e-12);
  const dm = (y, m, dd) => (Date.UTC(y, m, dd) - Date.UTC(2025, 3, 15)) / 864e5;
  near(mid.dirty, ends.reduce((s, e, i) => s + (2.5 + (i === 9 ? 100 : 0)) * Math.exp(-z * dm(...e) / 365), 0), 1e-9);
  assert.equal(mid.cashflows.length, 10); // the running period is paid in full
  assert.equal(priceInstrument({ ...x, valuationDate: "2025-07-15" }, c).cashflows.length, 9); // a coupon paid on the valuation date is gone
});

test("fixed bond: a higher coupon is worth more; a day count changes the coupon, not the dates", () => {
  const c = curve();
  const a = priceInstrument({ ...base, type: "fixed", rate: 0.05 }, c).dirty, b = priceInstrument({ ...base, type: "fixed", rate: 0.06 }, c).dirty;
  assert.ok(b > a);
  const act = generateCashflows({ ...base, type: "fixed", rate: 0.05, dayCount: "ACT/360" }).cashflows, d30 = generateCashflows({ ...base, type: "fixed", rate: 0.05 }).cashflows;
  assert.deepEqual(act.map((x) => x.date), d30.map((x) => x.date));
  assert.ok(act[0].interest > d30[0].interest); // 181/360 > 180/360
  near(d30[0].interest, 1000 * 0.05 * 0.5, 1e-9);
});

test("floating note: valued at its reset date with zero spread it is worth exactly its notional, whatever the curve (telescoping forwards, tol 1e-9)", () => {
  for (const cv of [curve(0.02), curveFromInput({ kind: "zero", compounding: "continuous", tenors: [1, 5, 10], rates: [0.01, 0.03, 0.05] })]) {
    const x = { ...base, type: "floating", spread: 0, dayCount: "ACT/365F" };
    near(priceInstrument(x, cv).dirty, 1000, 1e-9);
  }
  const withSpread = priceInstrument({ ...base, type: "floating", spread: 0.01, dayCount: "ACT/365F" }, curve(0.02)).dirty;
  assert.ok(withSpread > 1000);
  assert.throws(() => priceInstrument({ ...base, type: "floating", spread: 0, valuationDate: "2025-03-01" }, curve()), /lastFixing/);
  near(priceInstrument({ ...base, type: "floating", spread: 0, valuationDate: "2025-03-01", lastFixing: 0.03 }, curve()).cashflows[0].interest, 1000 * 0.03 * 0.5, 1e-9);
});

test("amortising: level payment (annuity) and linear principal; balances end at zero; principal sums to the notional", () => {
  const lv = generateCashflows({ ...base, type: "amortising", rate: 0.06, amortisation: "level", maturityDate: "2027-01-15" }).cashflows;
  const sumP = lv.reduce((s, c) => s + c.principal, 0);
  near(sumP, 1000, 1e-9);
  // Annuity formula: PMT = N i / (1 - (1+i)^-n), i = 3% per half year, n = 4 (standard)
  near(lv[0].amount, (1000 * 0.03) / (1 - 1.03 ** -4), 1e-9);
  near(lv[1].amount, lv[0].amount, 1e-9);
  near(lv[2].amount, lv[0].amount, 1e-9);
  const li = generateCashflows({ ...base, type: "amortising", rate: 0.06, amortisation: "linear", maturityDate: "2027-01-15" }).cashflows;
  li.forEach((c) => near(c.principal, 250, 1e-9));
  near(li[0].interest, 30, 1e-9);
  near(li[3].interest, 1000 * 0.06 * 0.5 * 0.25, 1e-9);
  const p = priceInstrument({ ...base, type: "amortising", rate: 0.04, amortisation: "level", maturityDate: "2027-01-15" }, curve(0.04));
  assert.ok(p.dirty > 900 && p.dirty < 1100);
  const zero = generateCashflows({ ...base, type: "amortising", rate: 0, amortisation: "level", maturityDate: "2027-01-15" }).cashflows;
  near(zero[0].amount, 250, 1e-9);
});

test("profit-rate (pricing analogue): murabaha-style instalments and ijara-style rentals are fixed schedules priced off a profit-rate curve", () => {
  const mu = generateCashflows({ ...base, type: "profit-rate", contract: "murabaha", profitRate: 0.05, maturityDate: "2027-01-15", dayCount: "ACT/360" }).cashflows;
  const yf = 730 / 360; // 2025-01-15 to 2027-01-15
  const sale = 1000 + 1000 * 0.05 * yf;
  mu.forEach((c) => near(c.amount, sale / 4, 1e-9));
  near(mu.reduce((s, c) => s + c.amount, 0), sale, 1e-9);
  near(mu.reduce((s, c) => s + c.principal, 0), 1000, 1e-9); // cost recovered; the rest is the profit share
  const ij = generateCashflows({ ...base, type: "profit-rate", contract: "ijara", profitRate: 0.05, residualFraction: 0.1, maturityDate: "2027-01-15" }).cashflows;
  near(ij[0].amount, 1000 * 0.05 * 0.5, 1e-9);
  near(ij.at(-1).amount, 1000 * 0.05 * 0.5 + 100, 1e-9);
  const profitCurve = curveFromInput({ kind: "zero", label: "benchmark profit rate", compounding: "continuous", tenors: [1, 5], rates: [0.05, 0.05] });
  const pv = priceInstrument({ ...base, type: "profit-rate", contract: "ijara", profitRate: 0.05, residualFraction: 1, maturityDate: "2027-01-15", dayCount: "ACT/365F" }, profitCurve);
  assert.ok(pv.dirty > 0 && pv.dirty < 1100);
  // the schedule is fixed at signing: a different curve changes the value, never the cash flows
  const other = priceInstrument({ ...base, type: "profit-rate", contract: "ijara", profitRate: 0.05, residualFraction: 1, maturityDate: "2027-01-15", dayCount: "ACT/365F" }, curve(0.09));
  assert.deepEqual(other.cashflows, pv.cashflows);
  assert.ok(other.dirty < pv.dirty);
  assert.throws(() => generateCashflows({ ...base, type: "profit-rate", contract: "ijara", profitRate: 0.05, residualFraction: 2 }), SimError);
});

test("instruments are refused outside their validated ranges", () => {
  const ok = { ...base, type: "fixed", rate: 0.05 };
  assert.doesNotThrow(() => generateCashflows(ok));
  const bad = [{ notional: 0 }, { notional: -5 }, { rate: 3 }, { rate: -0.5 }, { dayCount: "ACT/ACT" }, { maturityDate: "2024-01-01" }, { valuationDate: "2030-01-15" }, { maturityDate: "2200-01-15" }, { type: "swap" }, { frequency: 3 }, { valuationDate: "2025-02-30" }];
  for (const b of bad) assert.throws(() => generateCashflows({ ...ok, ...b }), SimError, JSON.stringify(b));
  assert.throws(() => generateCashflows({ ...base, type: "amortising", rate: 0.05 }), /amortisation/);
  assert.throws(() => priceInstrument({ ...ok, maturityDate: "2060-01-15" }, curve()), /extrapolate/); // beyond the 30y curve
  assert.throws(() => priceInstrument({ ...base, type: "floating", spread: 0 }), /curve/);
});

test("discounting uses ACT/365F years from the valuation date", () => {
  const c = curve(0.03);
  const r = priceInstrument({ ...base, type: "fixed", rate: 0, notional: 100, maturityDate: "2026-01-15" }, c);
  near(r.dirty, 100 * discountFactor(c, 365 / 365), 1e-12);
});
