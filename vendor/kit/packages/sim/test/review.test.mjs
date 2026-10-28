// Independent review of #106: each finding reproduced as a test that fails before its fix. Expected values are recomputed
// here from the standards' formulas and plain arithmetic (Date.UTC for day counts), not from the code under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as S from "../src/index.js";

const {
  runScenario, toSimResult, validateRun, validateResult, validateScenario, priceInstrument, curveFromInput, bootstrapPar, runIrrbb, irrbbParams,
  generateLadder, createRng, riskMeasures, shiftCurve, presentValue, yearFraction, SCHEMAS, CURVE_LIMITS, NSS_BOUNDS, RISK_LIMITS, INSTRUMENT_LIMITS, LIMITS, SimError,
} = S;

const near = (a, b, tol, msg) => assert.ok(Math.abs(Number(a) - b) <= tol, `${msg ?? ""} ${a} vs ${b} (tol ${tol})`);
const zero = { kind: "zero", compounding: "continuous", tenors: [0.5, 1, 2, 5, 10, 20, 30], rates: [0.03, 0.032, 0.035, 0.04, 0.043, 0.046, 0.047] };
const scen = (engine, inputs, over = {}) => ({ schema: "kit.sim-scenario.v1", id: `r.${engine}`, engine, seed: 1, asOf: "2026-10-07T00:00:00Z", source: { kind: "sandbox-mock" }, inputs, ...over });
const bond = { id: "b", type: "fixed", notional: 100, rate: 0.04, dayCount: "30/360", startDate: "2025-01-15", maturityDate: "2030-01-15", valuationDate: "2025-01-15", frequency: 2 };

// 1
test("1: non-JSON values (NaN, Infinity, BigInt, undefined in an array) give a refused run, never a throw", () => {
  const cases = [
    scen("curve", { curve: { ...zero, rates: [Number.NaN, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01] } }),
    scen("curve", { curve: { ...zero, rates: [Infinity, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01] } }),
    scen("price-risk", { curve: zero, instruments: [bond], bump: Number.NaN }),
    scen("price-risk", { curve: zero, instruments: [bond], keyTenors: [1n] }),
    scen("curve", { curve: { ...zero, tenors: [0.5, 1, 2, 5, 10, 20, undefined] } }),
    scen("sma", { currency: "EUR", minorExponent: 2, years: [10n, 2, 3] }),
  ];
  for (const s of cases) {
    let r;
    assert.doesNotThrow(() => { r = runScenario(s); });
    assert.equal(r.validation.status, "refused");
    assert.equal(r.outputs, null);
    assert.match(r.inputsHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(validateRun(r), []);
    assert.ok(r.validation.problems.length >= 1);
  }
  assert.doesNotThrow(() => runScenario(undefined));
  assert.doesNotThrow(() => runScenario(() => 1));
  assert.equal(runScenario({ id: "x", engine: "curve", inputs: { a: Symbol("s") } }).validation.status, "refused");
});

// 2
test("2: run and result contracts are enforced at emit and in the schemas", () => {
  const s = scen("curve", { curve: zero });
  const run = runScenario(s);
  assert.deepEqual(validateRun(run), []);
  // refused implies outputs null; validated implies an object output and no problems
  assert.ok(validateRun({ ...run, validation: { ...run.validation, status: "refused" } }).length > 0);
  assert.ok(validateRun({ ...run, outputs: null }).length > 0);
  assert.ok(validateRun({ ...run, outputs: [1] }).length > 0);
  const refused = runScenario(scen("curve", { curve: { ...zero, tenors: [2, 1] } }));
  assert.ok(validateRun({ ...refused, outputs: { a: 1 } }).length > 0);
  assert.ok(validateRun({ ...refused, validation: { ...refused.validation, problems: [] } }).length > 0);
  assert.ok(validateResult({ ...toSimResult(s, run), data: 5 }).length > 0);
  // toSimResult validates its inputs
  assert.throws(() => toSimResult({ ...s, source: undefined }, run), SimError);
  assert.throws(() => toSimResult({ ...s, source: { kind: "mock" } }, run), SimError);
  assert.throws(() => toSimResult(s, refused), /refused/);
  assert.throws(() => toSimResult({ ...s, id: "other" }, run), /does not match/);
  // instrument type-conditional requireds
  const inst = (o) => scen("price-risk", { curve: zero, instruments: [{ ...bond, ...o }] });
  const { rate, ...noRate } = bond;
  void rate;
  const without = (o, ...ks) => Object.fromEntries(Object.entries(o).filter(([k]) => !ks.includes(k)));
  assert.ok(validateScenario(scen("price-risk", { curve: zero, instruments: [noRate] })).length > 0, "fixed needs rate");
  assert.ok(validateScenario(scen("price-risk", { curve: zero, instruments: [without({ ...bond, type: "floating" }, "rate")] })).length > 0, "floating needs spread");
  assert.ok(validateScenario(inst({ type: "amortising" })).length > 0, "amortising needs amortisation");
  assert.ok(validateScenario(scen("price-risk", { curve: zero, instruments: [without({ ...bond, type: "profit-rate" }, "rate")] })).length > 0, "profit-rate needs contract and profitRate");
  assert.deepEqual(validateScenario(scen("price-risk", { curve: zero, instruments: [without({ ...bond, type: "floating", spread: 0 }, "rate")] })), []);
  // curve contract: zero/par curves with unequal lengths are refused (schema cannot compare lengths; the engine refuses, tested here as the contract)
  const r2 = runScenario(scen("curve", { curve: { ...zero, rates: [0.03, 0.03] } }));
  assert.equal(r2.validation.status, "refused");
  assert.ok(validateScenario(scen("curve", { curve: { ...zero, tenors: [1, 1, 2, 5, 10, 20, 30] } })).length > 0, "tenors are unique");
  assert.equal(runScenario(scen("curve", { curve: { ...zero, tenors: [2, 1, 5, 10, 20, 30, 40] } })).validation.status, "refused");
  assert.ok(validateScenario(scen("curve", { curve: { kind: "nss", nss: { beta0: 0.05, beta1: 0, beta2: 0, beta3: 0, tau1: 1, tau2: 5 } } })).length > 0, "nss needs maxTenor: no hidden default");
  assert.ok(validateScenario(scen("price-risk", { curve: zero, instruments: [bond], keyTenors: Array.from({ length: 60 }, (_, i) => i + 1) })).length > 0, "10: keyTenors maxItems");
  assert.ok(validateScenario(scen("curve", { curve: zero, forwardTenors: Array.from({ length: 300 }, (_, i) => i / 10 + 0.1) })).length > 0, "10: forwardTenors maxItems");
});

// 3
test("3: a floater with zero spread values at par for every day count (flat 4%), not 1002.5 per 1000 on ACT/360", () => {
  const flat = curveFromInput({ kind: "zero", compounding: "continuous", tenors: [1, 30], rates: [0.04, 0.04] });
  for (const dayCount of ["ACT/360", "ACT/365F", "30/360"]) {
    const r = priceInstrument({ ...bond, notional: 1000, type: "floating", spread: 0, dayCount, rate: undefined }, flat);
    near(r.dirty, 1000, 1e-9, dayCount);
  }
  // with a spread, the extra coupon is spread x notional x accrual x DF, in the instrument's day count (independent recomputation)
  const spread = 0.01, fl = priceInstrument({ ...bond, notional: 1000, type: "floating", spread, dayCount: "ACT/360", rate: undefined }, flat);
  const days = (a, b) => (Date.UTC(...b) - Date.UTC(...a)) / 864e5;
  const ends = [[2025, 6, 15], [2026, 0, 15], [2026, 6, 15], [2027, 0, 15], [2027, 6, 15], [2028, 0, 15], [2028, 6, 15], [2029, 0, 15], [2029, 6, 15], [2030, 0, 15]];
  let prev = [2025, 0, 15], extra = 0;
  for (const e of ends) { extra += 1000 * spread * (days(prev, e) / 360) * Math.exp(-0.04 * (days([2025, 0, 15], e) / 365)); prev = e; }
  near(fl.dirty, 1000 + extra, 1e-9);
});

// 4
test("4: an IRRBB floor never reverses a shock: a base rate already below the floor is not lifted by it", () => {
  const P = irrbbParams();
  const lowCurve = curveFromInput({ kind: "zero", compounding: "continuous", tenors: [1, 30], rates: [-0.05, -0.05] });
  const ladder = { schema: "kit.cashflow-ladder.v1", minorExponent: 0, items: [{ id: "a", kind: "asset", amount: 1000000, repricingYears: 9.5 }] };
  const r = runIrrbb(P, { currency: "USD", curve: lowCurve, ladder, floor: { startBp: -100, perYearBp: 0 } });
  const down = r.scenarios.find((s) => s.id === "parallel-down"), up = r.scenarios.find((s) => s.id === "parallel-up");
  assert.equal(down.deltaEve, 0, "a down shock on a rate below the floor changes nothing");
  assert.ok(up.deltaEve < 0);
  near(up.deltaEve, 1000000 * (Math.exp(-(-0.05 + 0.02) * 9.5) - Math.exp(0.05 * 9.5)), 1);
  const nii = runIrrbb(P, { currency: "USD", curve: lowCurve, ladder: { ...ladder, items: [{ ...ladder.items[0], repricingYears: 0.5 }] }, floor: { startBp: -100, perYearBp: 0 } }).nii.find((n) => n.id === "parallel-down");
  assert.equal(nii.deltaNii, 0);
  // a rate above the floor is still floored when the shock would cross it
  const mid = curveFromInput({ kind: "zero", compounding: "continuous", tenors: [1, 30], rates: [0, 0] });
  const m = runIrrbb(P, { currency: "USD", curve: mid, ladder, floor: { startBp: -100, perYearBp: 0 } }).scenarios.find((s) => s.id === "parallel-down");
  near(m.deltaEve, 1000000 * (Math.exp(0.01 * 9.5) - 1), 1); // shocked to -1% not -2%
});

// 6, 7
test("6: generated ladder items land in the bucket whose midpoint they carry, for every bucket", () => {
  const P = irrbbParams();
  const spec = { minorExponent: 0, assets: { count: 400, total: "1000000000", maxRepricingYears: 100 }, liabilities: { count: 400, total: "1000000000", maxRepricingYears: 100 } };
  const l = generateLadder(createRng(3), P, spec);
  const seen = new Set();
  for (const it of l.items) {
    const run = runIrrbb(P, { currency: "USD", curve: curveFromInput({ kind: "zero", compounding: "continuous", tenors: [1, 30], rates: [0.03, 0.03] }), ladder: { ...l, items: [it] } });
    assert.equal(run.slots.length, 1);
    assert.equal(run.slots[0].midpointYears, it.repricingYears, `${it.repricingYears} slotted at ${run.slots[0].midpointYears}`);
    seen.add(it.repricingYears);
  }
  assert.equal(seen.size, 19);
});
test("7: generated ladder totals are exact beyond 2^53", () => {
  const P = irrbbParams();
  const spec = { minorExponent: 0, assets: { count: 7, total: "1000000000000000100", maxRepricingYears: 25 }, liabilities: { count: 3, total: "9007199254740993", maxRepricingYears: 5 } };
  const l = generateLadder(createRng(11), P, spec);
  const tot = (k) => l.items.filter((i) => i.kind === k).reduce((s, i) => s + BigInt(i.amount), 0n);
  assert.equal(tot("asset"), 1000000000000000100n);
  assert.equal(tot("liability"), 9007199254740993n);
});

// 8
test("8: par bootstrap refuses pillars shorter than a coupon period and cannot run past the pillars", () => {
  assert.throws(() => bootstrapPar([0.25, 5], [0.03, 0.04], 2), /coupon period/);
  assert.throws(() => bootstrapPar([0.5, 2.0000001], [0.03, 0.04], 2), SimError);
  for (const f of [1, 2, 4, 12]) {
    const { zeros } = bootstrapPar([1, 3, 7], [0.02, 0.03, 0.04], f);
    assert.ok(zeros.every(Number.isFinite), `frequency ${f}`);
  }
  assert.throws(() => curveFromInput({ kind: "par", frequency: 2, tenors: [0.25, 5], rates: [0.03, 0.04] }), /coupon period/);
});

// 9, 10
test("9: limits have one source; the schemas and the code agree", () => {
  const curve = SCHEMAS.curve.properties, sc = SCHEMAS.scenario.$defs;
  assert.equal(curve.tenors.items.maximum, CURVE_LIMITS.maxTenor);
  assert.equal(curve.rates.items.minimum, CURVE_LIMITS.minRate);
  assert.equal(curve.rates.items.maximum, CURVE_LIMITS.maxRate);
  assert.equal(curve.tenors.minItems, CURVE_LIMITS.minPillars);
  assert.equal(curve.tenors.maxItems, CURVE_LIMITS.maxPillars);
  assert.equal(curve.maxTenor.maximum, CURVE_LIMITS.maxTenor);
  const nss = curve.nss.properties;
  assert.deepEqual([nss.tau1.minimum, nss.tau1.maximum], NSS_BOUNDS.tau1);
  assert.deepEqual([nss.tau2.minimum, nss.tau2.maximum], NSS_BOUNDS.tau2);
  for (const k of ["beta0", "beta1", "beta2", "beta3"]) assert.deepEqual([nss[k].minimum, nss[k].maximum], NSS_BOUNDS.beta);
  assert.equal(curve.nss["x-minTau2OverTau1"], NSS_BOUNDS.minRatio);
  assert.deepEqual([sc.priceRiskInputs.properties.bump.minimum, sc.priceRiskInputs.properties.bump.maximum], [RISK_LIMITS.minBump, RISK_LIMITS.maxBump]);
  const ins = sc.instrument.properties;
  assert.deepEqual(ins.frequency.enum, INSTRUMENT_LIMITS.frequencies);
  assert.deepEqual([ins.rate.minimum, ins.rate.maximum], [INSTRUMENT_LIMITS.minRate, INSTRUMENT_LIMITS.maxRate]);
  assert.deepEqual([ins.spread.minimum, ins.spread.maximum], [-INSTRUMENT_LIMITS.maxSpread, INSTRUMENT_LIMITS.maxSpread]);
  assert.equal(sc.priceRiskInputs.properties.keyTenors.maxItems, LIMITS.maxKeyTenors);
  assert.equal(sc.curveInputs.properties.forwardTenors.maxItems, LIMITS.maxReportTenors);
  assert.equal(SCHEMAS.ladder.properties.items.maxItems, LIMITS.maxLadderItems);
  assert.equal(sc.saccrInputs.properties.trades.maxItems, S.SACCR_LIMITS.maxTrades);
});
test("9: the default bump and the DV01 unit are one constant; no magic 0.0001 or 0.01 bp literal outside limits.js", () => {
  for (const f of ["run", "risk", "cashflows", "curve", "irrbb", "nss"]) {
    const src = readFileSync(new URL(`../src/${f}.js`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(src, /0\.0001\b|1e-4\b/, f);
  }
  assert.equal(LIMITS.oneBp, 0.0001);
  assert.equal(LIMITS.defaultBump, LIMITS.oneBp);
  const c = curveFromInput(zero), b = [{ t: 5, amount: 100 }];
  const price = (cc) => presentValue(b, cc);
  assert.throws(() => riskMeasures(price, c, {}), /bump/); // no hidden default in the engine; the caller passes it
  near(riskMeasures(price, c, { bump: LIMITS.defaultBump }).dv01, (price(shiftCurve(c, () => -LIMITS.oneBp)) - price(shiftCurve(c, () => LIMITS.oneBp))) / 2, 1e-12);
  near(riskMeasures(price, c, { bump: 0.001 }).dv01, (price(shiftCurve(c, () => -0.001)) - price(shiftCurve(c, () => 0.001))) / 2 * (LIMITS.oneBp / 0.001), 1e-12); // DV01 stays per 1 bp whatever the bump
});

// 11
test("11: day count label, level payments never negative, prototype keys are not currencies", () => {
  near(yearFraction("30/360", "2007-01-31", "2007-03-31"), 60 / 360, 1e-15);
  const P = irrbbParams();
  for (const k of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.throws(() => runIrrbb(P, { currency: k, curve: curveFromInput(zero), ladder: { schema: "kit.cashflow-ladder.v1", minorExponent: 0, items: [{ id: "a", kind: "asset", amount: 1, repricingYears: 1 }] } }), /no prescribed shock sizes/, k);
  }
  const r = runScenario(scen("irrbb", { currency: "constructor", curve: zero, generate: { minorExponent: 0, assets: { count: 1, total: 10, maxRepricingYears: 5 }, liabilities: { count: 1, total: 10, maxRepricingYears: 5 } } }));
  assert.equal(r.validation.status, "refused");
  assert.throws(() => irrbbParams("constructor"), /no IRRBB table/);
  // a level-payment loan whose first (stub) period carries more interest than the payment never has negative principal
  const loan = { type: "amortising", amortisation: "level", rate: 1, notional: 1000, dayCount: "ACT/360", startDate: "2025-01-15", maturityDate: "2032-01-15", valuationDate: "2025-01-15", frequency: 12 };
  const cf = priceInstrument(loan, curveFromInput({ kind: "zero", compounding: "continuous", tenors: [1, 10], rates: [0.03, 0.03] })).cashflows;
  assert.ok(cf.every((c) => c.principal >= 0), "principal is never negative");
});
