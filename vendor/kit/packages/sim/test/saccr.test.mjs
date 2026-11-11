// SA-CCR (Basel Framework CRE52). Fixtures: the worked examples of CRE99 (BCBS 279 Annex 4), amounts in USD thousands (minorExponent 0).
// The standard's text prints the intermediate numbers (supervisory duration, adjusted and effective notionals, entity add-ons, the
// systematic and idiosyncratic components, maturity factors); the final EADs are in formula images, so the final figures are
// checked against a recomputation from the standard's own quoted intermediates (tolerance 2 thousand: the standard rounds
// each intermediate). Nothing here is a copy of BaselTools output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTables, runSaccr, supervisoryDelta, normalCdf, TABLES, PROFILES } from "../src/index.js";

const TB = loadTables();
const near = (a, b, tol, msg) => assert.ok(Math.abs(Number(a) - b) <= tol, `${msg ?? ""} ${a} vs ${b} (tol ${tol})`);
const trs = (r) => [...r.trades].sort((a, b) => (a.id < b.id ? -1 : 1)); // the engine reports trades in canonical order
const run = (trades, extra = {}, T = TB) => runSaccr(T, { minorExponent: 0, trades, ...extra });

const ex1 = [
  { id: "1", assetClass: "ir", currency: "USD", notional: 10000, position: "long", startYears: 0, endYears: 10, maturityYears: 10, mtm: 30 },
  { id: "2", assetClass: "ir", currency: "USD", notional: 10000, position: "short", startYears: 0, endYears: 4, maturityYears: 4, mtm: -20 },
  { id: "3", assetClass: "ir", currency: "EUR", notional: 5000, startYears: 1, endYears: 11, maturityYears: 11, mtm: 50, option: { kind: "put", position: "bought", underlying: 0.06, strike: 0.05, expiryYears: 1 } },
];
const ex2 = [
  { id: "1", assetClass: "credit", subclass: "AA", referenceId: "Firm A", notional: 10000, position: "long", startYears: 0, endYears: 3, maturityYears: 3, mtm: 20 },
  { id: "2", assetClass: "credit", subclass: "BBB", referenceId: "Firm B", notional: 10000, position: "short", startYears: 0, endYears: 6, maturityYears: 6, mtm: -40 },
  { id: "3", assetClass: "credit", subclass: "index-IG", referenceId: "CDX.IG", notional: 10000, position: "long", startYears: 0, endYears: 5, maturityYears: 5, mtm: 0 },
];
const ex3 = [
  { id: "1", assetClass: "commodity", hedgingSet: "energy", referenceId: "crude oil", notional: 10000, position: "long", maturityYears: 0.75, mtm: -50 },
  { id: "2", assetClass: "commodity", hedgingSet: "energy", referenceId: "crude oil", notional: 20000, position: "short", maturityYears: 2, mtm: -30 },
  { id: "3", assetClass: "commodity", hedgingSet: "metals", referenceId: "silver", notional: 10000, position: "long", maturityYears: 5, mtm: 100 },
];

test("Example 1 (CRE99.22 to 99.40), interest rate netting set: quoted intermediates (tol 1 thousand) and EAD", () => {
  const r = run(ex1);
  assert.deepEqual(trs(r).map((t) => Math.round(t.adjustedNotional)), [78694, 36254, 37428]); // CRE99.29
  near(trs(r)[2].delta, -0.2694, 5e-5); // CRE99.31
  assert.deepEqual(trs(r).map((t) => Math.round(t.effectiveNotional)), [78694, -36254, -10083]); // CRE99.32
  assert.equal(r.replacementCost, 60); // CRE99.24: V = 60, C = 0
  assert.equal(r.multiplier, 1); // CRE99.25
  // CRE99.36 to 99.40 recomputed from the quoted effective notionals
  const usd = Math.sqrt(36254 ** 2 + 78694 ** 2 + 1.4 * (-36254) * 78694); // buckets 2 and 3 of the USD set
  const addOn = 0.005 * (usd + 10083); // plus the EUR set (one bucket)
  near(r.addOn.ir, addOn, 1);
  near(r.ead, 1.4 * (60 + addOn), 2);
  assert.equal(r.ead, 569);
  assert.equal(r.addOn.aggregate, r.addOn.ir);
});

test("Example 2 (CRE99.41 to 99.58), credit netting set: SD, entity add-ons, systematic and idiosyncratic parts, multiplier", () => {
  const r = run(ex2);
  assert.deepEqual(trs(r).map((t) => Math.round(t.adjustedNotional)), [27858, 51836, 44240]); // CRE99.47
  assert.deepEqual(["Firm A", "Firm B", "CDX.IG"].map((n) => Math.round(r.entities.credit.find((e) => e.entity === n).addOn)), [106, -280, 168]); // CRE99.52
  near(r.components.creditSystematic, 2253, 1); // CRE99.55
  near(r.components.creditIdiosyncratic, 77344, 1);
  near(r.addOn.credit, Math.sqrt(2253 + 77344), 1);
  assert.equal(r.replacementCost, 0); // V - C = -20 < 0
  const mult = Math.min(1, 0.05 + 0.95 * Math.exp(-20 / (1.9 * Math.sqrt(2253 + 77344)))); // CRE52.23, CRE99.57
  near(r.multiplier, mult, 1e-3);
  near(r.ead, 1.4 * mult * Math.sqrt(2253 + 77344), 2);
  assert.ok(r.multiplier < 1);
});

test("Example 3 (CRE99.59 to 99.76), commodity netting set: maturity factor (9/12)^0.5, hedging-set add-ons (3 + 1800 and 2041)", () => {
  const r = run(ex3);
  near(trs(r)[0].maturityFactor, Math.sqrt(9 / 12), 1e-12);
  assert.deepEqual(trs(r).map((t) => Math.round(t.effectiveNotional)), [8660, -20000, 10000]); // CRE99.66
  const hs = Object.fromEntries(r.hedgingSets.commodity.map((h) => [h.hedgingSet, h.addOn]));
  near(hs.energy, 2041, 1); // |-11,340 x 0.18|, CRE99.69 and 99.72
  near(hs.metals, 1800, 1e-9);
  assert.equal(r.replacementCost, 20);
  assert.equal(r.multiplier, 1);
  near(r.ead, 1.4 * (20 + 2041 + 1800), 2);
});

test("Example 4 (CRE99.77 to 99.79): examples 1 and 2 in one netting set: add-ons of the two classes are summed, V = 40", () => {
  const r = run([...ex1, ...ex2]);
  assert.equal(r.replacementCost, 40);
  assert.equal(r.addOn.aggregate, r.addOn.ir + r.addOn.credit + 0);
  near(r.addOn.ir, run(ex1).addOn.ir, 1);
  near(r.addOn.credit, run(ex2).addOn.credit, 1);
  assert.equal(r.multiplier, 1);
  near(r.ead, 1.4 * (40 + r.addOn.aggregate), 2);
});

test("Example 5 (CRE99.80 to 99.96), margined: MPOR 14 = 9 + 5, MF = 1.5 sqrt(14/250), effective notionals and add-ons, RC = 0", () => {
  const r = run([...ex1, ...ex3.map((t) => ({ ...t, id: `c${t.id}` }))], { collateral: 200, margin: { threshold: 0, mta: 5, nica: 150, remarginingDays: 5 } });
  assert.equal(r.mporDays, 14); // CRE99.83
  near(trs(r)[0].maturityFactor, 1.5 * Math.sqrt(14 / 250), 1e-12);
  assert.deepEqual(trs(r).slice(0, 3).map((t) => Math.round(t.effectiveNotional)), [27934, -12869, -3579]); // CRE99.85 (tol: the standard rounds MF to 0.355)
  near(trs(r)[3].effectiveNotional, 3550, 2); // CRE99.90
  near(trs(r)[4].effectiveNotional, -7100, 2);
  assert.equal(r.v, 80); // 30 - 20 + 50 - 50 - 30 + 100, CRE99.82
  assert.equal(r.replacementCost, 0); // max(80 - 200, 0 + 5 - 150, 0)
  const hs = Object.fromEntries(r.hedgingSets.commodity.map((h) => [h.hedgingSet, h.addOn]));
  near(hs.energy, 639, 2); // CRE99.92 and 99.93
  near(hs.metals, 639, 2);
  assert.equal(r.cappedAtUnmargined, false);
  assert.ok(r.eadMargined < r.eadUnmargined);
  near(r.addOn.ir, 0.005 * (Math.sqrt(12869 ** 2 + 27934 ** 2 - 1.4 * 12869 * 27934) + 3579), 2);
});

test("a margined EAD is capped at the unmargined EAD (CRE52.2): a huge threshold cannot raise the exposure above the unmargined one", () => {
  const r = run(ex1, { collateral: 0, margin: { threshold: 100000, mta: 0, nica: 0 } });
  assert.equal(r.cappedAtUnmargined, true);
  assert.equal(r.ead, r.eadUnmargined);
  assert.ok(r.eadMargined > r.eadUnmargined);
});

test("supervisory delta (CRE52.40): the four option cases and a linear trade", () => {
  const o = (kind, position) => ({ option: { kind, position, underlying: 0.06, strike: 0.05, expiryYears: 1 } });
  const vol = 0.5, d1 = (Math.log(0.06 / 0.05) + 0.5 * vol * vol) / vol;
  near(supervisoryDelta(o("call", "bought"), vol, "t"), normalCdf(d1), 1e-12);
  near(supervisoryDelta(o("call", "sold"), vol, "t"), -normalCdf(d1), 1e-12);
  near(supervisoryDelta(o("put", "bought"), vol, "t"), -normalCdf(-d1), 1e-12);
  near(supervisoryDelta(o("put", "sold"), vol, "t"), normalCdf(-d1), 1e-12);
  near(supervisoryDelta(o("put", "bought"), vol, "t"), -0.2694, 5e-5); // CRE99.31
  assert.equal(supervisoryDelta({ position: "long" }, vol, "t"), 1);
  assert.equal(supervisoryDelta({ position: "short" }, vol, "t"), -1);
  assert.throws(() => supervisoryDelta({ option: { kind: "call", position: "bought", underlying: -0.01, strike: 0.01, expiryYears: 1 } }, vol, "t"), /shift/); // CRE52.40 FAQ2
  near(supervisoryDelta({ option: { kind: "call", position: "bought", underlying: -0.01, strike: 0.01, expiryYears: 1, shift: 0.03 } }, vol, "t"), normalCdf((Math.log(0.02 / 0.04) + 0.125) / 0.5), 1e-12);
});

test("normal CDF: reference values (tol 1e-14)", () => {
  near(normalCdf(0), 0.5, 1e-15);
  near(normalCdf(1.96), 0.9750021048517795, 1e-14);
  near(normalCdf(-1), 0.15865525393145707, 1e-14);
  near(normalCdf(3), 0.9986501019683699, 1e-14);
  near(normalCdf(-8), 6.220960574271785e-16, 1e-17);
  for (const x of [0.3, 1.1, 2.7, 5]) near(normalCdf(x) + normalCdf(-x), 1, 1e-14);
});

test("multiplier (CRE52.23): 1 when V - C >= 0, floored at 5%, falls as collateral rises; EAD is alpha x (RC + PFE)", () => {
  const base = run(ex3);
  assert.equal(base.multiplier, 1);
  const lo = run(ex3, { collateral: 100000 });
  near(lo.multiplier, 0.05, 1e-5);
  assert.equal(lo.replacementCost, 0);
  let prev = 2;
  for (const c of [0, 50, 100, 500, 2000, 10000]) { const m = run(ex3, { collateral: c }).multiplier; assert.ok(m <= prev); prev = m; }
  near(base.ead, 1.4 * (Number(base.replacementCost) + Number(base.pfe)), 1);
  assert.equal(base.alpha, 1.4);
  assert.ok(base.ead >= base.pfe);
});

test("FX, equity and mixed classes: |sum D| x 4%, entity add-ons with one systematic factor, class add-ons are summed", () => {
  const fx = run([{ assetClass: "fx", currencyPair: "EURUSD", notional: 1000, position: "long", maturityYears: 2 }, { assetClass: "fx", currencyPair: "EURUSD", notional: 400, position: "short", maturityYears: 2 }]);
  near(fx.addOn.fx, 0.04 * 600, 1e-9);
  const eq = run([{ assetClass: "equity", subclass: "single", referenceId: "X", notional: 1000, position: "long", maturityYears: 2 }, { assetClass: "equity", subclass: "index", referenceId: "I", notional: 1000, position: "long", maturityYears: 2 }]);
  const a = 0.32 * 1000, b = 0.2 * 1000;
  near(eq.addOn.equity, Math.sqrt((0.5 * a + 0.8 * b) ** 2 + (1 - 0.25) * a * a + (1 - 0.64) * b * b), 1);
  const mix = run([...ex1, { assetClass: "fx", currencyPair: "EURUSD", notional: 1000, position: "long", maturityYears: 2 }]);
  assert.equal(mix.addOn.aggregate, mix.addOn.ir + mix.addOn.fx);
  // basis hedging sets use half the supervisory factor (CRE52.73)
  const basis = run([{ assetClass: "ir", currency: "USD", notional: 1000, position: "long", startYears: 0, endYears: 3, maturityYears: 3, basis: true }]);
  const plain = run([{ assetClass: "ir", currency: "USD", notional: 1000, position: "long", startYears: 0, endYears: 3, maturityYears: 3 }]);
  near(Number(basis.addOn.ir) * 2, Number(plain.addOn.ir), 1);
});

test("unsupported and out-of-range inputs are refused, never approximated", () => {
  const t = ex1[0];
  const bad = [
    [{ ...t, cdoTranche: true }, /CDO/], [{ ...t, assetClass: "swap" }, /assetClass/], [{ ...t, position: "flat" }, /position/], [{ ...t, endYears: 0 }, /startYears/],
    [{ ...t, maturityYears: 200 }, /maturityYears/], [{ ...t, notional: -5 }, /not negative/], [{ ...t, currency: undefined }, /currency/], [{ ...t, basis: true, volatility: true }, /both/],
    [{ assetClass: "credit", subclass: "XX", referenceId: "a", notional: 1, position: "long", startYears: 0, endYears: 1, maturityYears: 1 }, /subclass/],
    [{ assetClass: "commodity", hedgingSet: "weather", referenceId: "a", notional: 1, position: "long", maturityYears: 1 }, /hedgingSet/],
    [{ assetClass: "credit", subclass: "AA", referenceId: "a", notional: 1, position: "long", startYears: 0, endYears: 1, maturityYears: 1, basis: true }, /basis and volatility/],
  ];
  for (const [x, re] of bad) assert.throws(() => run([x]), re);
  assert.throws(() => run([]), /1 to 100000/);
  assert.throws(() => runSaccr(TB, { minorExponent: 9, trades: [t] }), /minorExponent/);
  assert.throws(() => run([t], { margin: { remarginingDays: 0 } }), /remarginingDays/);
  assert.throws(() => run([t], { margin: { cleared: true, remarginingDays: 3 } }), /daily/);
});

test("mutation: a changed table constant moves a worked example out of tolerance", () => {
  const mutate = (id, value) => {
    const reg = { tables: structuredClone(TABLES), profiles: { baseline: PROFILES.baseline } };
    const row = reg.tables["saccr-supervisory"].factors.find((f) => f.id === id);
    row.value = value; delete row.min; delete row.max;
    return loadTables("baseline", reg);
  };
  const ok = (T) => { const r = run(ex1, {}, T); return Math.abs(Number(r.ead) - 569) <= 2; };
  assert.ok(ok(TB));
  for (const [id, v] of [["alpha", 13000], ["sf-ir", 60], ["sd-rate", 400], ["ir-bucket-corr-adjacent", 6000], ["vol-ir", 4000]]) assert.equal(ok(mutate(id, v)), false, id);
  assert.ok(Math.abs(Number(run(ex3, { collateral: 100000 }, mutate("multiplier-floor", 1000)).multiplier) - 0.05) > 0.04, "floor");
  const okCredit = (T) => Math.abs(Number(run(ex2, {}, T).ead) - 381) <= 2;
  assert.ok(okCredit(TB));
  for (const [id, v] of [["sf-credit-bbb", 60], ["corr-credit-index", 7000], ["corr-credit-single", 4000]]) assert.equal(okCredit(mutate(id, v)), false, id);
});

test("IR buckets 1 and 3 use the 0.6 cross term (CRE52.57 step 5), recomputed by hand; a mutated far correlation is caught", () => {
  const sd = (s, e) => (Math.exp(-0.05 * s) - Math.exp(-0.05 * e)) / 0.05;
  const t = [
    { assetClass: "ir", currency: "USD", notional: 10000, position: "long", startYears: 0, endYears: 0.5, maturityYears: 0.5 },
    { assetClass: "ir", currency: "USD", notional: 10000, position: "short", startYears: 0, endYears: 10, maturityYears: 10 },
  ];
  const d1 = 10000 * sd(0, 0.5) * Math.sqrt(0.5), d3 = -10000 * sd(0, 10);
  const en = Math.sqrt(d1 * d1 + d3 * d3 + 0.6 * d1 * d3);
  near(run(t).addOn.ir, 0.005 * en, 1);
  const reg = { tables: structuredClone(TABLES), profiles: { baseline: PROFILES.baseline } };
  const far = reg.tables["saccr-supervisory"].factors.find((f) => f.id === "ir-bucket-corr-far");
  far.value = 2000; delete far.min; delete far.max;
  assert.ok(Math.abs(Number(run(t, {}, loadTables("baseline", reg)).addOn.ir) - 0.005 * en) > 1);
});
