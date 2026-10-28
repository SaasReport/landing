// runScenario / SimRun / SimResult: contracts, determinism, refusals, provenance badges.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runScenario, toSimResult, toSourceEnvelope, badgeFor, validateRun, validateResult, validateScenario, hashOf, ENGINE_VERSION, SimError } from "../src/index.js";
import { createValidator, formatProblems } from "@saasreport/core/schema";

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const AS_OF = "2026-10-07T00:00:00Z";
const zero = { kind: "zero", compounding: "continuous", tenors: [0.5, 1, 2, 5, 10, 20, 30], rates: [0.03, 0.032, 0.035, 0.04, 0.043, 0.046, 0.047] };
const scen = (engine, inputs, over = {}) => ({ schema: "kit.sim-scenario.v1", id: `t.${engine}`, engine, seed: 42, asOf: AS_OF, source: { kind: "sandbox-mock" }, inputs, ...over });
const bond = { id: "b1", type: "fixed", notional: 100, rate: 0.04, dayCount: "30/360", startDate: "2025-01-15", maturityDate: "2030-01-15", valuationDate: "2025-01-15", frequency: 2 };

test("curve engine: a par curve is bootstrapped; the run validates against kit.sim-run.v1 and replays byte for byte", () => {
  const s = scen("curve", { curve: { kind: "par", frequency: 2, tenors: [0.5, 1, 2, 5, 10], rates: [0.03, 0.032, 0.035, 0.04, 0.043] }, fitNss: false, forwardTenors: [1, 5, 10] });
  const a = runScenario(s), b = runScenario(structuredClone(s));
  assert.equal(a.validation.status, "validated");
  assert.deepEqual(validateRun(a), []);
  assert.deepEqual(a, b);
  assert.equal(a.inputsHash, hashOf(s));
  assert.equal(a.engineVersion, ENGINE_VERSION);
  assert.equal(a.seed, 42);
  assert.equal(a.outputs.curveSource, "par-bootstrapped");
  assert.ok(a.assumptions.some((x) => /bootstrapped to zero rates/.test(x)));
  assert.equal(a.outputs.zeroRates.length, 3);
  assert.equal(a.outputs.zeroRates[2].forward1y, null); // 11y is beyond the curve: no extrapolation
});

test("curve engine: NSS fit output and an NSS curve needs forwardTenors", () => {
  const r = runScenario(scen("curve", { curve: zero, fitNss: true }));
  assert.equal(r.validation.status, "validated");
  assert.ok(r.outputs.nssFit.rmse < 5e-4);
  const nss = { kind: "nss", maxTenor: 30, nss: { beta0: 0.05, beta1: -0.02, beta2: 0.01, beta3: 0.005, tau1: 1.5, tau2: 8 } };
  const need = runScenario(scen("curve", { curve: nss }));
  assert.equal(need.validation.status, "refused");
  assert.equal(need.validation.problems[0].code, "tenors-required");
  assert.equal(runScenario(scen("curve", { curve: nss, forwardTenors: [2] })).outputs.zeroRates[0].zero, 0.0423709876);
});

test("price-risk engine: price, duration, convexity, DV01 and key rates per instrument", () => {
  const r = runScenario(scen("price-risk", { curve: zero, instruments: [bond, { ...bond, id: "frn", type: "floating", spread: 0, dayCount: "ACT/365F" }], keyTenors: [1, 5, 10] }));
  assert.equal(r.validation.status, "validated");
  const [fx, fl] = r.outputs.instruments;
  assert.ok(fx.effectiveDuration > 3.5 && fx.effectiveDuration < 5 && fx.dv01 > 0 && fx.convexity > 0);
  near(fl.dirty, 100, 1e-8);
  assert.ok(fl.effectiveDuration < 0.51); // an FRN at reset behaves like a short-dated instrument
  assert.equal(fx.keyRates.length, 3);
  near(fx.keyRates.reduce((s, k) => s + k.duration, 0), fx.effectiveDuration, 1e-5);
});

test("irrbb engine: a synthetic ladder from the scenario's seed, same seed same run, different seed different run", () => {
  const inputs = { currency: "USD", curve: zero, generate: { minorExponent: 2, assets: { count: 8, total: "100000000", maxRepricingYears: 25 }, liabilities: { count: 6, total: "90000000", maxRepricingYears: 3 } }, tier1: "10000000" };
  const a = runScenario(scen("irrbb", inputs)), b = runScenario(scen("irrbb", inputs)), c = runScenario(scen("irrbb", inputs, { seed: 43 }));
  assert.equal(a.validation.status, "validated");
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.outputs.ladder, c.outputs.ladder);
  assert.equal(a.outputs.scenarios.length, 6);
  assert.ok(a.outputs.outlierTest);
});

test("determinism: regression pins of the outputs (a pin detects change, it does not prove correctness: the formulas are checked elsewhere against independent values; the same pins hold on every Node version CI runs)", () => {
  const r1 = runScenario(scen("price-risk", { curve: zero, instruments: [bond], keyTenors: [1, 5, 10] }));
  const r2 = runScenario(scen("irrbb", { currency: "EUR", curve: zero, generate: { minorExponent: 0, assets: { count: 5, total: 5000000, maxRepricingYears: 20 }, liabilities: { count: 5, total: 4000000, maxRepricingYears: 2 } } }, { seed: 7 }));
  assert.equal(hashOf(r1.outputs), GOLDEN.priceRisk);
  assert.equal(hashOf(r2.outputs), GOLDEN.irrbb);
});

test("refusals: off-schema scenarios and out-of-range inputs come back as validation.status refused, never as numbers", () => {
  const cases = [
    [scen("curve", { curve: zero }, { engine: "swaps" }), "invalid-scenario"],
    [{ ...scen("curve", { curve: zero }), seed: -1 }, "invalid-scenario"],
    [scen("curve", { curve: { ...zero, rates: [0.03, 0.032, 0.035, 0.04, 0.043, 0.046, 9] } }), "invalid-scenario"],
    [scen("price-risk", { curve: zero, instruments: [{ ...bond, maturityDate: "2070-01-15" }] }), "outside-curve"],
    [scen("price-risk", { curve: zero, instruments: [{ ...bond, valuationDate: "2031-01-01" }] }), "bad-instrument"],
    [scen("price-risk", { curve: zero, instruments: [bond], bump: 0.5 }), "invalid-scenario"],
    [scen("irrbb", { currency: "XXX", curve: zero, generate: { minorExponent: 0, assets: { count: 1, total: 10, maxRepricingYears: 5 }, liabilities: { count: 1, total: 10, maxRepricingYears: 5 } } }), "unknown-currency"],
    [scen("irrbb", { currency: "USD", curve: { kind: "zero", compounding: "continuous", tenors: [1, 10], rates: [0.03, 0.03] }, ladder: { schema: "kit.cashflow-ladder.v1", minorExponent: 0, items: [{ id: "a", kind: "asset", amount: 1, repricingYears: 50 }] } }, {}), "outside-curve"],
    [scen("irrbb", { currency: "USD", curve: zero, generate: { minorExponent: 0, assets: { count: 1, total: 10, maxRepricingYears: 5 }, liabilities: { count: 1, total: 10, maxRepricingYears: 5 } } }, { profile: "nowhere" }), "unknown-profile"],
    [null, "invalid-scenario"],
  ];
  for (const [s, code] of cases) {
    const r = runScenario(s);
    assert.equal(r.validation.status, "refused", code);
    assert.equal(r.outputs, null);
    assert.equal(r.validation.problems[0].code, code);
    assert.deepEqual(validateRun(r), [], code);
  }
});

test("SimResult: badge by kind, provenance block, schema-valid; the badge is derived, never stored", () => {
  const s = scen("price-risk", { curve: zero, instruments: [bond] });
  const run = runScenario(s);
  const res = toSimResult(s, run);
  assert.deepEqual(validateResult(res), []);
  assert.equal(res.provenance.rawHash, run.inputsHash);
  assert.equal(res.provenance.seed, 42);
  assert.equal(res.provenance.asOfBasis, "seed");
  assert.equal(res.source.origin, "computed");
  assert.equal("badge" in res, false);
  assert.deepEqual(["sandbox-mock", "customer-dataset", "computed"].map(badgeFor), ["SYNTHETIC", "YOURS", "COMPUTED"]);
  assert.throws(() => badgeFor("mock"), SimError);
  const mine = { ...s, source: { kind: "customer-dataset", id: "my.book", name: "My book" } };
  const yours = toSimResult(mine, runScenario(mine));
  assert.equal(yours.source.origin, undefined);
  assert.equal(yours.provenance.asOfBasis, "source");
  const gen = scen("irrbb", { currency: "USD", curve: zero, generate: { minorExponent: 0, assets: { count: 2, total: 100, maxRepricingYears: 5 }, liabilities: { count: 2, total: 90, maxRepricingYears: 5 } } });
  assert.equal(toSimResult(gen, runScenario(gen)).source.origin, "generated");
});

test("SourceEnvelope alignment: the mapper emits every required key of the workbench envelope (kit.source-envelope.v1, workbench archetype PR #100)", () => {
  const ENVELOPE_REQUIRED = ["schema", "source", "asOf", "fetchedAt", "licence", "freshness", "reach", "provenance", "data"]; // copied from that schema's `required`, no dependency
  const s = scen("price-risk", { curve: zero, instruments: [bond] });
  const res = toSimResult(s, runScenario(s));
  const env = toSourceEnvelope(res, { fetchedAt: "2026-10-07T01:00:00Z" });
  for (const k of ENVELOPE_REQUIRED) assert.ok(k in env, k);
  assert.deepEqual(Object.keys(env.source).sort(), ["id", "kind", "name", "origin"]);
  assert.equal(env.source.kind, "sandbox-mock"); // computed maps to sandbox-mock + origin computed in the envelope's vocabulary
  assert.equal(env.source.origin, "computed");
  assert.deepEqual(Object.keys(env.provenance).sort(), ["adapter", "adapterVersion", "asOfBasis", "rawHash", "seed"]);
  assert.throws(() => toSourceEnvelope(res, { fetchedAt: "yesterday" }), SimError);
  const own = { ...s, source: { kind: "customer-dataset" } };
  const mine = toSourceEnvelope(toSimResult(own, runScenario(own)), { fetchedAt: "2026-10-07T01:00:00Z" });
  assert.equal(mine.source.kind, "customer-dataset");
});

test("the registered schemas compile together and reject what they should", () => {
  assert.deepEqual(validateScenario(scen("curve", { curve: zero })), []);
  assert.ok(validateScenario({ ...scen("curve", { curve: zero }), extra: 1 }).length > 0);
  assert.ok(validateScenario(scen("curve", { curve: { kind: "par", tenors: [1, 2], rates: [0.01, 0.02] } })).length > 0); // par needs a frequency
  assert.ok(validateScenario(scen("irrbb", { currency: "USD", curve: zero })).length > 0); // a ladder or a generator
  const idx = JSON.parse(readFileSync(new URL("../../core/schemas/index.json", import.meta.url), "utf8"));
  for (const n of ["sim-scenario", "sim-run", "sim-result", "curve-input", "cashflow-ladder", "sim-origin", "sim-irrbb-params", "sim-factor-table", "sim-profile"]) assert.ok(idx.schemas.some((e) => e.name === n), n);
});

test("ORIGIN.json: valid, names every inspiring repository with licence and what was not taken", () => {
  const origin = JSON.parse(readFileSync(new URL("../ORIGIN.json", import.meta.url), "utf8"));
  const schema = JSON.parse(readFileSync(new URL("../../core/schemas/sim-origin.schema.json", import.meta.url), "utf8"));
  const v = createValidator([schema]);
  assert.deepEqual(formatProblems(v.validate(origin, schema.$id)), []);
  assert.deepEqual(origin.inspirations.map((i) => [i.repository, i.license]), [["ommaganti/yield-curve-sim", "MIT"], ["TommasoBelluzzo/BaselTools", "Apache-2.0"], ["mgao6767/brms", "MIT"]]);
  assert.ok(origin.inspirations.every((i) => i.notTaken.length));
  const notice = readFileSync(new URL("../NOTICE", import.meta.url), "utf8");
  for (const i of origin.inspirations) assert.ok(notice.includes(i.repository), i.repository);
});

test("the package has no runtime dependency beyond the kit's schema validator; no I/O, clock or randomness reaches the engines (static scan and a runtime poison test)", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(pkg.dependencies), ["@saasreport/core"]);
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(new URL("../src/", import.meta.url)).filter((f) => f.endsWith(".js"));
  assert.ok(files.length >= 16);
  for (const f of files) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(src, /Math\s*(\.\s*random|\[)|\bDate\s*\.\s*now|new\s+Date\b|\bDate\s*\(|performance|crypto|node:|\bfetch\b|process\b|globalThis|\beval\b|new\s+Function|\bimport\s*\(|require\s*\(|setTimeout|Intl\./, f);
  }
  // runtime: every engine runs with the clock, the random sources and the network poisoned
  const poison = (obj, name) => { const old = Object.getOwnPropertyDescriptor(obj, name); Object.defineProperty(obj, name, { configurable: true, writable: true, value: () => { throw new Error(`${name} was called`); } }); return () => (old ? Object.defineProperty(obj, name, old) : delete obj[name]); };
  const undo = [poison(Math, "random"), poison(Date, "now"), poison(globalThis, "fetch"), poison(globalThis.crypto, "getRandomValues")];
  const RealDate = globalThis.Date;
  try {
    globalThis.Date = new Proxy(RealDate, { construct(t, a) { if (a.length === 0) throw new Error("new Date() was called"); return new t(...a); } });
    const generate = { minorExponent: 0, assets: { count: 3, total: 1000, maxRepricingYears: 10 }, liabilities: { count: 3, total: 900, maxRepricingYears: 2 } };
    for (const s of [scen("curve", { curve: zero, fitNss: true }), scen("price-risk", { curve: zero, instruments: [bond], keyTenors: [1, 5] }), scen("irrbb", { currency: "USD", curve: zero, generate })]) assert.equal(runScenario(s).validation.status, "validated");
  } finally { globalThis.Date = RealDate; undo.reverse().forEach((f) => f()); }
});

const CAP = { minorExponent: 0, trades: [
  { id: "1", assetClass: "ir", currency: "USD", notional: 10000, position: "long", startYears: 0, endYears: 10, maturityYears: 10, mtm: 30 },
  { id: "2", assetClass: "ir", currency: "USD", notional: 10000, position: "short", startYears: 0, endYears: 4, maturityYears: 4, mtm: -20 },
  { id: "3", assetClass: "ir", currency: "EUR", notional: 5000, startYears: 1, endYears: 11, maturityYears: 11, mtm: 50, option: { kind: "put", position: "bought", underlying: 0.06, strike: 0.05, expiryYears: 1 } },
] };
const fee = "3500000000000";
const SMA = { currency: "EUR", minorExponent: 2, years: [0, 1, 2].map(() => ({ interestIncome: 0, interestExpense: 0, interestEarningAssets: 0, dividendIncome: 0, otherOperatingIncome: 0, otherOperatingExpense: 0, feeIncome: fee, feeExpense: 0, tradingBookPnl: 0, bankingBookPnl: 0 })) };
const LCR = { minorExponent: 0, hqla: [{ class: "level1", amount: 100 }], outflows: [{ category: "retail-stable", amount: 100 }, { category: "retail-less-stable", amount: 50 }] };
const NSFR = { minorExponent: 0, asf: [{ category: "stable-retail", amount: 1000 }], rsf: [{ category: "rsf-65", amount: 1000 }] };

test("capital and liquidity engines through runScenario: validated runs, tables named in the assumptions, replayable", () => {
  const cases = [["saccr", CAP, (o) => assert.equal(o.ead, 569)], ["sma", SMA, (o) => assert.equal(BigInt(o.bic), 537n * 100000000000n / 100n)], ["lcr", LCR, (o) => assert.equal(o.netOutflows, 10)], ["nsfr", NSFR, (o) => assert.equal(o.ratioBp, 14615)]];
  for (const [engine, inputs, check] of cases) {
    const s = scen(engine, inputs, { source: { kind: "customer-dataset", id: "my.book" } });
    const a = runScenario(s), b = runScenario(structuredClone(s));
    assert.equal(a.validation.status, "validated", engine);
    assert.deepEqual(validateRun(a), []);
    assert.deepEqual(a, b);
    check(a.outputs);
    assert.ok(a.assumptions.some((x) => /^Tables: profile baseline;/.test(x)), engine);
    assert.deepEqual(validateResult(toSimResult(s, a)), []);
  }
});

test("capital and liquidity engines refuse: unknown profile, unsupported features, out-of-range inputs, bad categories, prototype keys", () => {
  const cases = [
    [scen("saccr", CAP, { profile: "nowhere" }), "unknown-profile"],
    [scen("saccr", CAP, { profile: "constructor" }), "unknown-profile"],
    [scen("saccr", { ...CAP, trades: [{ ...CAP.trades[0], cdoTranche: true }] }), "unsupported"],
    [scen("saccr", { ...CAP, trades: [{ ...CAP.trades[0], maturityYears: 500 }] }), "invalid-scenario"],
    [scen("sma", { ...SMA, currency: "USD" }), "currency-mismatch"],
    [scen("lcr", { ...LCR, outflows: [{ category: "retail-stableish", amount: 1 }] }), "unknown-category"],
    [scen("lcr", { ...LCR, outflows: [{ category: "constructor", amount: 1 }] }), "unknown-category"],
    [scen("lcr", { ...LCR, hqla: [{ class: "constructor", amount: 1 }] }), "invalid-scenario"],
    [scen("lcr", { ...LCR, outflows: [] }), "no-net-outflows"],
    [scen("nsfr", { ...NSFR, rsf: [] }), "no-required-funding"],
    [scen("nsfr", { ...NSFR, asf: [{ category: "stable-retail", amount: "12.5" }] }), "invalid-scenario"],
  ];
  for (const [s, code] of cases) {
    const r = runScenario(s);
    assert.equal(r.validation.status, "refused", code);
    assert.equal(r.validation.problems[0].code, code);
    assert.equal(r.outputs, null);
  }
});

const GOLDEN = { priceRisk: "0e85d6a6c92241086be72bf886b923ec8f218769ef26bcea10bc72216b69f279", irrbb: "bea21b4df5c5452b07aefa0814a0707fc01d4a2c99a74e26c42bb37f7da6da99" };
