// SMA (Basel Framework OPE25, OPE10; BCBS d424). Fixture: OPE25.7 footnote 2, BI = EUR 35bn gives BIC = 1 x 12% + 29 x 15% + 5 x 18% = EUR 5.37bn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTables, runSma, TABLES, PROFILES } from "../src/index.js";

const TB = loadTables();
const EUR_BN = 100000000000n; // EUR 1bn in cents (minorExponent 2)
const year = (o = {}) => ({ interestIncome: 0, interestExpense: 0, interestEarningAssets: 0, dividendIncome: 0, otherOperatingIncome: 0, otherOperatingExpense: 0, feeIncome: 0, feeExpense: 0, tradingBookPnl: 0, bankingBookPnl: 0, ...o });
const sma = (years, extra = {}) => runSma(TB, { currency: "EUR", minorExponent: 2, years, ...extra });
const feeBank = (bn) => { const f = String(BigInt(bn) * EUR_BN); return [year({ feeIncome: f }), year({ feeIncome: f }), year({ feeIncome: f })]; };
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test("OPE25.7 fn 2: BI = EUR 35bn gives BIC = EUR 5.37bn exactly (bucket 3)", () => {
  const r = sma(feeBank(35));
  assert.equal(BigInt(r.bi), 35n * EUR_BN);
  assert.equal(BigInt(r.bic), 537n * EUR_BN / 100n);
  assert.equal(r.bucket, 3);
  assert.equal(r.ilm, 1);
  assert.equal(r.ilmApplied, false);
  assert.match(r.note, /fewer than 5 years/);
  assert.equal(r.orc, r.bic);
});

test("OPE25.7: bucket 1 is 12% of BI; the BIC is continuous at EUR 1bn and EUR 30bn (marginal coefficients)", () => {
  assert.equal(BigInt(sma(feeBank(1)).bic), 12n * EUR_BN / 100n);
  assert.equal(sma(feeBank(1)).bucket, 1);
  assert.match(sma(feeBank(1)).note, /first bucket/);
  assert.equal(BigInt(sma(feeBank(30)).bic), (12n * EUR_BN) / 100n + 29n * 15n * EUR_BN / 100n);
  assert.equal(sma(feeBank(30)).bucket, 2);
  const f = (cents) => { const x = String(cents); return sma([year({ feeIncome: x }), year({ feeIncome: x }), year({ feeIncome: x })]); };
  const at1 = BigInt(f(EUR_BN).bic), above = BigInt(f(EUR_BN + 100n).bic);
  assert.equal(above - at1, 15n); // 100 cents x 15%
  assert.equal(f(EUR_BN).bucket, 1);
  assert.equal(f(EUR_BN + 1n).bucket, 2);
});

test("OPE10 and OPE25.5: the BI components, net items per year first, then the 3-year average (hand computation)", () => {
  const ys = [
    year({ interestIncome: 1000, interestExpense: 400, interestEarningAssets: 100000, dividendIncome: 10, otherOperatingIncome: 30, otherOperatingExpense: 50, feeIncome: 200, feeExpense: 120, tradingBookPnl: -60, bankingBookPnl: 20 }),
    year({ interestIncome: 500, interestExpense: 800, interestEarningAssets: 100000, dividendIncome: 20, otherOperatingIncome: 60, otherOperatingExpense: 40, feeIncome: 100, feeExpense: 300, tradingBookPnl: 90, bankingBookPnl: -10 }),
    year({ interestIncome: 900, interestExpense: 300, interestEarningAssets: 100000, dividendIncome: 30, otherOperatingIncome: 90, otherOperatingExpense: 30, feeIncome: 300, feeExpense: 180, tradingBookPnl: 30, bankingBookPnl: 40 }),
  ];
  const r = runSma(TB, { currency: "EUR", minorExponent: 0, years: ys });
  // |II - IE|: 600, 300, 600 -> avg 500; cap 2.25% x 100000 = 2250 -> 500; + avg dividends 20  => ILDC 520
  assert.equal(r.ildc, 520);
  // max(avg OOI 60, avg OOE 40) = 60; max(avg FI 200, avg FE 200) = 200 => SC 260
  assert.equal(r.sc, 260);
  // avg |trading| (60 + 90 + 30) / 3 = 60; avg |banking| (20 + 10 + 40) / 3 = 23.33 -> 23 => FC 83
  assert.equal(r.fc, 83);
  assert.equal(r.bi, 863);
});

test("ILDC cap: the net interest item is capped at 2.25% of average interest earning assets", () => {
  const y = year({ interestIncome: 100000, interestEarningAssets: 1000000 });
  const r = runSma(TB, { currency: "EUR", minorExponent: 0, years: [y, y, y] });
  assert.equal(r.ildc, 22500);
});

const lossBank = (lossPerYear, years = 10, extra = {}) => ({ years: years, events: Array.from({ length: years }, (_, i) => ({ yearIndex: i, amount: String(lossPerYear) })), ...extra });

test("OPE25.8: ILM = 1 when LC = BIC, above 1 when losses are high, below 1 when low; ORC = BIC x ILM; RWA = 12.5 x ORC", () => {
  const bank = feeBank(2); // BI EUR 2bn: BIC = 12% x 1bn + 15% x 1bn = EUR 270m
  const bic = 27000000000n; // cents
  const lcEq = (bic / 15n); // LC = 15 x avg annual loss, so annual loss = BIC / 15 gives LC = BIC (10 equal years)
  const eq = sma(bank, { lossHistory: lossBank(lcEq) });
  assert.equal(BigInt(eq.bic), bic);
  assert.equal(BigInt(eq.lossComponent), lcEq * 15n);
  near(eq.ilm, 1, 1e-12);
  const hi = sma(bank, { lossHistory: lossBank(lcEq * 3n) }), lo = sma(bank, { lossHistory: lossBank(lcEq / 3n) });
  assert.ok(hi.ilm > 1 && lo.ilm < 1);
  near(hi.ilm, Math.log(Math.E - 1 + 3 ** 0.8), 1e-9); // ILM = ln(e - 1 + (LC/BIC)^0.8)
  near(lo.ilm, Math.log(Math.E - 1 + (1 / 3) ** 0.8), 1e-9);
  near(Number(hi.orc), Number(bic) * hi.ilm, 1);
  near(Number(hi.rwa), 12.5 * Number(hi.orc), 2);
  assert.equal(hi.ilmApplied, true);
  // ILM grows with losses
  let prev = 0;
  for (const k of [0, 1, 2, 4, 8, 16]) { const x = sma(bank, { lossHistory: lossBank(lcEq * BigInt(k) / 2n + 2000000n) }).ilm; assert.ok(x > prev); prev = x; }
});

test("loss data: events under the EUR 20,000 threshold are not counted; 5 to 9 years average over the years given; fewer than 5 years: BIC only; bucket 1: no ILM", () => {
  const bank = feeBank(2);
  const big = { yearIndex: 0, amount: "3000000000" }, small = { yearIndex: 1, amount: "1999999" }, atThr = { yearIndex: 2, amount: "2000000" };
  const a = sma(bank, { lossHistory: { years: 10, events: [big, small] } }), b = sma(bank, { lossHistory: { years: 10, events: [big] } });
  assert.equal(BigInt(a.lossComponent), BigInt(b.lossComponent));
  assert.equal(BigInt(sma(bank, { lossHistory: { years: 10, events: [big, atThr] } }).lossComponent), 15n * 3002000000n / 10n);
  const five = sma(bank, { lossHistory: { years: 5, events: [big] } });
  assert.equal(BigInt(five.lossComponent), 15n * 3000000000n / 5n);
  assert.equal(five.lossYears, 5);
  const four = sma(bank, { lossHistory: { years: 4, events: [big] } });
  assert.equal(four.ilm, 1);
  assert.equal(four.lossComponent, null);
  const b1 = sma(feeBank(1), { lossHistory: lossBank(100000000n) });
  assert.equal(b1.ilm, 1);
  assert.equal(b1.ilmApplied, false);
});

test("refusals: another currency, a missing item, a bad year index, negative amounts, a loss history over 10 years", () => {
  assert.throws(() => runSma(TB, { currency: "USD", minorExponent: 2, years: feeBank(2) }), /thresholds are in EUR/);
  const y = year();
  delete y.feeIncome;
  assert.throws(() => sma([y, year(), year()]), /feeIncome is required/);
  assert.throws(() => sma(feeBank(2), { lossHistory: { years: 10, events: [{ yearIndex: 10, amount: 5 }] } }), /yearIndex/);
  assert.throws(() => sma(feeBank(2), { lossHistory: { years: 11, events: [] } }), /at most 10/);
  assert.throws(() => sma([year({ feeIncome: -1 }), year(), year()]), /not negative/);
  assert.throws(() => sma([year(), year()]), /three/);
  assert.throws(() => sma(feeBank(2), { minorExponent: 9 }), /minorExponent/);
});

test("mutation: changed coefficients, thresholds or exponent are caught by the EUR 35bn example and the ILM identity", () => {
  const mutated = (id, value) => {
    const reg = { tables: structuredClone(TABLES), profiles: { baseline: PROFILES.baseline } };
    const row = reg.tables.sma.factors.find((f) => f.id === id);
    row.value = value; delete row.min; delete row.max;
    return loadTables("baseline", reg);
  };
  const want = 537n * EUR_BN / 100n;
  for (const [id, v] of [["bucket1-coefficient", 1100], ["bucket2-coefficient", 1600], ["bucket3-coefficient", 1900], ["threshold1", 2000000000], ["threshold2", 25000000000]]) assert.notEqual(BigInt(runSma(mutated(id, v), { currency: "EUR", minorExponent: 2, years: feeBank(35) }).bic), want, id);
  const bank = feeBank(2), lcEq = 27000000000n / 15n;
  for (const [id, v] of [["ilm-exponent", 7000], ["loss-component-multiplier", 14], ["rwa-multiplier", 120000]]) {
    const r = runSma(mutated(id, v), { currency: "EUR", minorExponent: 2, years: bank, lossHistory: lossBank(lcEq * 3n) });
    assert.ok(Math.abs(r.ilm - Math.log(Math.E - 1 + 3 ** 0.8)) > 1e-6 || Math.abs(Number(r.rwa) - 12.5 * Number(r.orc)) > 5, id);
  }
});
