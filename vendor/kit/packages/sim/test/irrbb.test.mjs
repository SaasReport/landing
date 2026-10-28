// IRRBB: the six prescribed shocks of Basel Framework SRP31 (BCBS d368), EVE, NII, outlier test, synthetic ladder.
// Published worked examples: SRP31.92 (short-rate 41.7bp at t=3.5y; steepener +25.4bp; flattener -1.6bp for the JPY-sized 100/100bp shocks).
import { test } from "node:test";
import assert from "node:assert/strict";
import { irrbbParams, shockAt, runIrrbb, bucketIndex, generateLadder, createRng, curveFromInput, validateLadder, hashOf, SimError, EVE_SCENARIOS } from "../src/index.js";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b} (tol ${tol})`);
const P = irrbbParams();
const curve = (z = 0.03) => curveFromInput({ kind: "zero", compounding: "continuous", tenors: [1, 30], rates: [z, z] });

// An independent copy of SRP31.90 Table 2 (parallel, short, long in bp), typed from the standard, to catch a data edit.
const TABLE2 = {
  ARS: [400, 500, 300], AUD: [300, 450, 200], BRL: [400, 500, 300], CAD: [200, 300, 150], CHF: [100, 150, 100], CNY: [250, 300, 150], EUR: [200, 250, 100],
  GBP: [250, 300, 150], HKD: [200, 250, 100], IDR: [400, 500, 300], INR: [400, 500, 300], JPY: [100, 100, 100], KRW: [300, 400, 200], MXN: [400, 500, 300],
  RUB: [400, 500, 300], SAR: [200, 300, 150], SEK: [200, 300, 150], SGD: [150, 200, 100], TRY: [400, 500, 300], USD: [200, 300, 150], ZAR: [400, 500, 300],
};

test("SRP31.90 Table 2: every currency's shock sizes equal the standard's (21 currencies)", () => {
  assert.deepEqual(Object.keys(P.shocksBp.currencies).sort(), Object.keys(TABLE2).sort());
  for (const [c, [par, sh, lg]] of Object.entries(TABLE2)) assert.deepEqual(P.shocksBp.currencies[c], { parallel: par, short: sh, long: lg }, c);
});

test("SRP31.96 Table 3: 19 buckets with the standard's midpoints", () => {
  assert.deepEqual(P.buckets.items.map((b) => b.midpointYears), [0.0028, 0.0417, 0.1667, 0.375, 0.625, 0.875, 1.25, 1.75, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5, 12.5, 17.5, 25]);
  assert.equal(P.buckets.items.length, 19);
  const idx = (y) => P.buckets.items[bucketIndex(P, y)].id;
  assert.equal(idx(0), "overnight");
  assert.equal(idx(1 / 12), "up-to-1m");
  assert.equal(idx(1), "9m-1y");
  assert.equal(idx(1.0001), "1y-1.5y");
  assert.equal(idx(10), "9y-10y");
  assert.equal(idx(20), "15y-20y");
  assert.equal(idx(20.5), "over-20y");
  assert.equal(idx(99), "over-20y");
});

test("SRP31.92 worked examples at t = 3.5y (tol 0.05 bp: the standard rounds the scalar to 0.417)", () => {
  assert.equal(P.shapingDecayYears.value, 4);
  near(Math.exp(-3.5 / 4), 0.417, 5e-4);
  // short rate shock +100bp: the increase at 3.5y is 41.7bp (JPY short = 100bp)
  near(shockAt(P, "JPY", "short-up", 3.5) * 1e4, 41.7, 0.05);
  near(shockAt(P, "JPY", "steepener", 3.5) * 1e4, 25.4, 0.05); // -0.65 x 100 x 0.417 + 0.9 x 100 x (1 - 0.417)
  near(shockAt(P, "JPY", "flattener", 3.5) * 1e4, -1.6, 0.05); // +0.8 x 100 x 0.417 - 0.6 x 100 x (1 - 0.417)
});

test("shapes: parallel is flat, short decays to zero, steepener/flattener rotate (EUR 200/250/100)", () => {
  near(shockAt(P, "EUR", "parallel-up", 1) * 1e4, 200, 1e-9);
  near(shockAt(P, "EUR", "parallel-down", 25) * 1e4, -200, 1e-9);
  near(shockAt(P, "EUR", "short-up", 0.0028) * 1e4, 250 * Math.exp(-0.0028 / 4), 1e-9);
  assert.ok(shockAt(P, "EUR", "short-up", 25) * 1e4 < 1); // 250 x e^-6.25 = 0.48bp
  assert.ok(shockAt(P, "EUR", "steepener", 0.0028) < 0 && shockAt(P, "EUR", "steepener", 25) > 0);
  assert.ok(shockAt(P, "EUR", "flattener", 0.0028) > 0 && shockAt(P, "EUR", "flattener", 25) < 0);
  for (const s of EVE_SCENARIOS) assert.ok(Number.isFinite(shockAt(P, "USD", s, 7)));
  assert.throws(() => shockAt(P, "XXX", "parallel-up", 1), /no prescribed shock sizes/);
  assert.throws(() => shockAt(P, "USD", "twist", 1), /scenario/);
});

const simple = (assets, liabilities, e = 0) => ({
  schema: "kit.cashflow-ladder.v1", minorExponent: e,
  items: [...assets.map(([amount, y], i) => ({ id: `a${i}`, kind: "asset", amount, repricingYears: y })), ...liabilities.map(([amount, y], i) => ({ id: `l${i}`, kind: "liability", amount, repricingYears: y }))],
});

test("EVE: a long fixed-rate asset funded short loses on a parallel rise and gains on a fall; the reverse bank does the opposite (sign property)", () => {
  const a = runIrrbb(P, { currency: "USD", curve: curve(), ladder: simple([[1000000, 9.5]], [[1000000, 0.0417]]) });
  const up = a.scenarios.find((s) => s.id === "parallel-up"), dn = a.scenarios.find((s) => s.id === "parallel-down");
  assert.ok(up.deltaEve < 0 && dn.deltaEve > 0);
  assert.equal(a.worstScenario !== null, true);
  assert.equal(up.loss, -up.deltaEve);
  assert.equal(dn.loss, 0);
  const b = runIrrbb(P, { currency: "USD", curve: curve(), ladder: simple([[1000000, 0.0417]], [[1000000, 9.5]]) });
  assert.ok(b.scenarios.find((s) => s.id === "parallel-up").deltaEve > 0);
  assert.equal(a.maxLoss, Math.max(...a.scenarios.map((s) => s.loss)));
});

test("EVE: independent recomputation for one bucket (tol: 1 minor unit): 1,000,000 asset at 9.5y, parallel up 200bp (USD), 3% curve", () => {
  const r = runIrrbb(P, { currency: "USD", curve: curve(0.03), ladder: simple([[1000000, 9.5]], []) });
  const base = 1000000 * Math.exp(-0.03 * 9.5), shocked = 1000000 * Math.exp(-0.05 * 9.5);
  near(r.baseEve, base, 1);
  near(r.scenarios[0].deltaEve, shocked - base, 1);
});

test("property: zero shocks change nothing (EVE and NII), a balanced ladder with equal slots is immune to every shock", () => {
  const Z = structuredClone(P);
  for (const c of Object.values(Z.shocksBp.currencies)) { c.parallel = 0; c.short = 0; c.long = 0; }
  const r = runIrrbb(Z, { currency: "USD", curve: curve(), ladder: simple([[5000000, 0.5], [3000000, 4], [2000000, 12]], [[7000000, 0.1], [3000000, 6]]) });
  r.scenarios.forEach((s) => assert.equal(s.deltaEve, 0));
  r.nii.forEach((n) => assert.equal(n.deltaNii, 0));
  assert.equal(r.maxLoss, 0);
  assert.equal(r.worstScenario, null);
  const bal = runIrrbb(P, { currency: "EUR", curve: curve(), ladder: simple([[1000000, 5]], [[1000000, 5]]) });
  bal.scenarios.forEach((s) => assert.equal(s.deltaEve, 0));
});

test("slotting nets per bucket exactly (BigInt) and amounts beyond 2^53 stay exact", () => {
  const big = "9007199254740993";
  const r = runIrrbb(P, { currency: "USD", curve: curve(), ladder: simple([[big, 5], [1, 5]], [[1, 5]]) });
  assert.equal(r.slots.length, 1);
  assert.equal(r.slots[0].net, "9007199254740993"); // 2^53 + 1 asset + 1 asset - 1 liability
  assert.equal(r.assetTotal, "9007199254740994");
  assert.equal(r.liabilityTotal, 1);
});

test("NII: asset repricing inside 12 months gains on a rise; only items repricing before the horizon count; weight (1 - t)", () => {
  const r = runIrrbb(P, { currency: "USD", curve: curve(), ladder: simple([[1000000, 0.5], [1000000, 3]], []) });
  const up = r.nii.find((n) => n.id === "parallel-up"), dn = r.nii.find((n) => n.id === "parallel-down");
  near(up.deltaNii, 1000000 * 0.02 * 0.5, 1); // 200bp for the half year after repricing
  near(dn.deltaNii, -1000000 * 0.02 * 0.5, 1);
  assert.deepEqual(r.nii.map((n) => n.id), ["parallel-up", "parallel-down"]);
});

test("floor (SRP31.93: a floor may not exceed zero): a floor at 0 limits the down shock on a 1% curve; a positive floor is refused", () => {
  const lad = simple([[1000000, 9.5]], []);
  const noFloor = runIrrbb(P, { currency: "USD", curve: curve(0.01), ladder: lad }).scenarios.find((s) => s.id === "parallel-down");
  const floored = runIrrbb(P, { currency: "USD", curve: curve(0.01), ladder: lad, floor: { startBp: 0, perYearBp: 0 } }).scenarios.find((s) => s.id === "parallel-down");
  const base = 1000000 * Math.exp(-0.01 * 9.5);
  near(floored.deltaEve, 1000000 * Math.exp(0) - base, 1); // shocked rate floored at 0
  assert.ok(floored.deltaEve < noFloor.deltaEve);
  assert.throws(() => runIrrbb(P, { currency: "USD", curve: curve(), ladder: lad, floor: { startBp: 50, perYearBp: 0 } }), /greater than zero/);
});

test("outlier test (SRP31.82): maximum loss against 15% of Tier 1, exact integer comparison", () => {
  const lad = simple([[1000000, 9.5]], [[1000000, 0.0417]]);
  const r = runIrrbb(P, { currency: "USD", curve: curve(), ladder: lad, tier1: 1000000 });
  assert.equal(r.outlierTest.thresholdBp, 1500);
  assert.equal(r.outlierTest.outlier, BigInt(r.maxLoss) * 10000n > 1000000n * 1500n);
  const huge = runIrrbb(P, { currency: "USD", curve: curve(), ladder: lad, tier1: "1000000000000" });
  assert.equal(huge.outlierTest.outlier, false);
  const tiny = runIrrbb(P, { currency: "USD", curve: curve(), ladder: lad, tier1: 1 });
  assert.equal(tiny.outlierTest.outlier, true);
  assert.throws(() => runIrrbb(P, { currency: "USD", curve: curve(), ladder: lad, tier1: 0 }), SimError);
});

test("refusals: unknown currency, curve shorter than a used bucket midpoint, bad ladder", () => {
  assert.throws(() => runIrrbb(P, { currency: "XXX", curve: curve(), ladder: simple([[1, 1]], []) }), /no prescribed shock sizes/);
  const short = curveFromInput({ kind: "zero", compounding: "continuous", tenors: [1, 10], rates: [0.03, 0.03] });
  assert.throws(() => runIrrbb(P, { currency: "USD", curve: short, ladder: simple([[1, 30]], []) }), /extrapolate/);
  assert.throws(() => runIrrbb(P, { currency: "USD", curve: curve(), ladder: simple([[-5, 1]], []) }), /negative/);
  assert.throws(() => runIrrbb(P, { currency: "USD", curve: curve(), ladder: { ...simple([[1, 1]], []), minorExponent: 9 } }), SimError);
  assert.throws(() => runIrrbb(P, { currency: "USD", curve: curve(), ladder: { minorExponent: 0, items: [] } }), SimError);
});

test("synthetic ladder: seeded, exact totals, replayable (regression pin), schema-valid; another seed differs", () => {
  const spec = { minorExponent: 2, assets: { count: 8, total: "100000000", maxRepricingYears: 25 }, liabilities: { count: 6, total: "90000000", maxRepricingYears: 3 } };
  const a = generateLadder(createRng(2026), P, spec), b = generateLadder(createRng(2026), P, spec), c = generateLadder(createRng(2027), P, spec);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.deepEqual(validateLadder(a), []);
  const tot = (k) => a.items.filter((i) => i.kind === k).reduce((s, i) => s + BigInt(i.amount), 0n);
  assert.equal(tot("asset"), 100000000n);
  assert.equal(tot("liability"), 90000000n);
  assert.ok(a.items.filter((i) => i.kind === "liability").every((i) => i.repricingYears <= 3));
  assert.equal(hashOf(a), GOLDEN_LADDER_HASH);
  assert.throws(() => generateLadder(createRng(1), P, { ...spec, assets: { ...spec.assets, count: 0 } }), SimError);
});

test("mutation: a changed constant in the standard's data is caught by the worked examples", () => {
  const worked = (Q) => [shockAt(Q, "JPY", "short-up", 3.5) * 1e4, shockAt(Q, "JPY", "steepener", 3.5) * 1e4, shockAt(Q, "JPY", "flattener", 3.5) * 1e4];
  const ok = (v) => Math.abs(v[0] - 41.7) <= 0.05 && Math.abs(v[1] - 25.4) <= 0.05 && Math.abs(v[2] + 1.6) <= 0.05;
  assert.ok(ok(worked(P)));
  const mutants = [
    (Q) => { Q.shapingDecayYears.value = 5; },
    (Q) => { Q.rotation.steepener.shortCoefficient = -0.6; },
    (Q) => { Q.rotation.steepener.longCoefficient = 0.95; },
    (Q) => { Q.rotation.flattener.shortCoefficient = 0.85; },
    (Q) => { Q.rotation.flattener.longCoefficient = -0.65; },
    (Q) => { Q.shocksBp.currencies.JPY.short = 101; },
    (Q) => { Q.shocksBp.currencies.JPY.long = 99; },
  ];
  mutants.forEach((m, i) => { const Q = structuredClone(P); m(Q); assert.equal(ok(worked(Q)), false, `mutant ${i} survived`); });
  const Q = structuredClone(P); Q.outlier.tier1ShareBp = 1000;
  const lad = simple([[1000000, 9.5]], [[1000000, 0.0417]]);
  const loss = Number(runIrrbb(P, { currency: "USD", curve: curve(), ladder: lad }).maxLoss);
  const tier1 = Math.round(loss / 0.12); // the loss is 12% of Tier 1: an outlier at a 10% threshold, not at 15%
  assert.equal(runIrrbb(P, { currency: "USD", curve: curve(), ladder: lad, tier1 }).outlierTest.outlier, false);
  assert.equal(runIrrbb(Q, { currency: "USD", curve: curve(), ladder: lad, tier1 }).outlierTest.outlier, true);
});

// Independent recomputation of EVE and NII for all six prescribed scenarios: shocks from the SRP31.91 / 31.92 formulas written out here
// (own copies of the coefficients and of Table 2 rows), slotting into the SRP31.96 buckets by hand, discounting by plain arithmetic.
test("independent EVE for all six scenarios and NII for both parallel ones, three currencies, a multi-bucket ladder (tol 1 minor unit)", () => {
  const MID = [0.0028, 0.0417, 0.1667, 0.375, 0.625, 0.875, 1.25, 1.75, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5, 12.5, 17.5, 25];
  const UP = [0.0028, 1 / 12, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, Infinity];
  const slot = (y) => UP.findIndex((u) => y <= u + 1e-12);
  const SIZES = { USD: [200, 300, 150], EUR: [200, 250, 100], JPY: [100, 100, 100] };
  const shock = (ccy, id, t) => {
    const [par, sh, lg] = SIZES[ccy], S = Math.exp(-t / 4), b = (x) => x / 1e4;
    return { "parallel-up": b(par), "parallel-down": -b(par), "short-up": b(sh) * S, "short-down": -b(sh) * S,
      steepener: -0.65 * b(sh) * S + 0.9 * b(lg) * (1 - S), flattener: 0.8 * b(sh) * S - 0.6 * b(lg) * (1 - S) }[id];
  };
  const zc = [[0.5, 0.03], [2, 0.034], [10, 0.041], [30, 0.047]];
  const curveIn = { kind: "zero", compounding: "continuous", tenors: zc.map((x) => x[0]), rates: zc.map((x) => x[1]) };
  const z = (t) => { if (t <= zc[0][0]) return zc[0][1]; for (let i = 1; i < zc.length; i++) if (t <= zc[i][0]) return zc[i - 1][1] + ((t - zc[i - 1][0]) / (zc[i][0] - zc[i - 1][0])) * (zc[i][1] - zc[i - 1][1]); return NaN; };
  const items = [["asset", 5000000, 0.3], ["asset", 3000000, 2.2], ["asset", 4000000, 7], ["asset", 1000000, 12], ["liability", 6000000, 0.01], ["liability", 2500000, 0.9], ["liability", 3500000, 4.4], ["liability", 800000, 24]];
  const ladder = { schema: "kit.cashflow-ladder.v1", minorExponent: 2, items: items.map(([kind, amount, repricingYears], i) => ({ id: `i${i}`, kind, amount, repricingYears })) };
  for (const ccy of ["USD", "EUR", "JPY"]) {
    const net = new Array(19).fill(0);
    for (const [kind, amount, y] of items) net[slot(y)] += kind === "asset" ? amount : -amount;
    const eve = (id) => net.reduce((s, n, k) => s + (n / 100) * Math.exp(-(z(MID[k]) + (id ? shock(ccy, id, MID[k]) : 0)) * MID[k]), 0) * 100;
    const run = runIrrbb(P, { currency: ccy, curve: curveFromInput(curveIn), ladder });
    near(run.baseEve, eve(null), 1);
    for (const s of run.scenarios) { near(s.eve, eve(s.id), 1, `${ccy} ${s.id}`); near(s.deltaEve, eve(s.id) - eve(null), 1, `${ccy} ${s.id}`); }
    for (const id of ["parallel-up", "parallel-down"]) {
      const d = items.filter(([, , y]) => y < 1).reduce((s, [kind, amount, y]) => s + (kind === "asset" ? amount : -amount) * shock(ccy, id, y) * (1 - y), 0);
      near(run.nii.find((n) => n.id === id).deltaNii, d, 1, `${ccy} NII ${id}`);
    }
  }
});

const GOLDEN_LADDER_HASH = "af13508f172b946e6ec7d86a9503676536fc40ada11bc141e09ddfdfb05c441f";
