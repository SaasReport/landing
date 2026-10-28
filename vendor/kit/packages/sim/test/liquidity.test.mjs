// LCR and NSFR (Basel Framework LCR20/30/40, NSF20/30). Published fixtures: LCR40.7 fn 43 (a 150 deposit with 100 insured: 100 stable, 50 less stable);
// the caps of LCR30.31 to 30.36 by hand; the factor tables against an independent copy typed from the standard. The standard publishes no
// numeric LCR or NSFR case beyond these, so ratios are validated by hand computation, the caps by their defining inequalities
// (property tests on a seeded generator), and the tables by the independent copy; this is stated, not hidden.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTables, runLcr, runNsfr, TABLES, PROFILES, createRng, hashOf, SimError } from "../src/index.js";

const TB = loadTables();
const lcr = (x, T = TB) => runLcr(T, { minorExponent: 0, outflows: [], inflows: [], ...x });
const B = (x) => BigInt(x);
const near = (a, b, tol) => assert.ok(Math.abs(Number(a) - b) <= tol, `${a} vs ${b}`);
const out1 = [{ category: "other-contractual-outflows", amount: 100 }];

// independent copy of the key rows, bp (typed from LCR30, LCR40, NSF30)
const LCR_ROWS = {
  "lcr-hqla": { "level1-haircut": 0, "level2a-haircut": 1500, "level2b-rmbs-haircut": 2500, "level2b-other-haircut": 5000, "level2-cap": 4000, "level2b-cap": 1500 },
  "lcr-outflows": { "retail-stable": 500, "retail-less-stable": 1000, "operational-deposits": 2500, "corporate-sovereign-general": 4000, "corporate-sovereign-insured": 2000, "other-legal-entities": 10000, "secured-level2a": 1500, "secured-level2b-other": 5000, "facility-retail-small-business": 500, "facility-credit-corporate": 1000, "facility-liquidity-corporate": 3000, "facility-bank": 4000, "facility-liquidity-financial": 10000, "derivatives-net-outflows": 10000 },
  "lcr-inflows": { "reverse-repo-level1": 0, "reverse-repo-level2a": 1500, "reverse-repo-level2b-rmbs": 2500, "reverse-repo-level2b-other": 5000, "reverse-repo-other": 10000, "retail-small-business-performing": 5000, "wholesale-financial-performing": 10000, "inflow-cap": 7500 },
  "nsfr-asf": { "capital-and-long-term": 10000, "stable-retail": 9500, "less-stable-retail": 9000, "wholesale-corporate-operational": 5000, "other-six-to-twelve-months": 5000, "all-other-liabilities": 0 },
  "nsfr-rsf": { "rsf-0": 0, "rsf-5": 500, "rsf-10": 1000, "rsf-15": 1500, "rsf-50": 5000, "rsf-65": 6500, "rsf-85": 8500, "rsf-100": 10000 },
};

test("tables: every key factor equals the standard's value, every row has a paragraph reference, all tables share a version", () => {
  for (const [t, rows] of Object.entries(LCR_ROWS)) for (const [id, v] of Object.entries(rows)) assert.equal(TB.value(t, id), v, `${t}/${id}`);
  for (const t of Object.values(TB.tables)) for (const [id, r] of Object.entries(t.rows)) assert.ok(/^(CRE|OPE|LCR|NSF)\d+/.test(r.ref), `${t.id}/${id}: ${r.ref}`);
  assert.equal(TB.get("lcr-outflows", "secured-level2a").ref, "LCR40.46 table");
});

test("LCR40.7 fn 43: a deposit of 150 with 100 insured is 100 stable (5%) and 50 less stable (10%): outflow 10", () => {
  const r = lcr({ hqla: [{ class: "level1", amount: 100 }], outflows: [{ category: "retail-stable", amount: 100 }, { category: "retail-less-stable", amount: 50 }] });
  assert.equal(r.outflows.total, 10);
  assert.equal(r.netOutflows, 10);
  assert.equal(r.ratioBp, 100000); // 100 / 10
  assert.equal(r.meetsMinimum, true);
});

test("HQLA caps (LCR30.35, 30.36, 30.38, 30.39), hand cases", () => {
  const stock = (l1, l2a, l2bR = 0, l2bO = 0) => lcr({ hqla: [{ class: "level1", amount: l1 }, { class: "level2a", amount: l2a }, { class: "level2b-rmbs", amount: l2bR }, { class: "level2b-other", amount: l2bO }].filter((x) => x.amount), outflows: out1 }).hqla;
  // no haircut effect on level 1; level 2A 100 -> 85 after the 15% haircut
  assert.equal(stock(60, 40).stock, 60 + 34); // 40 x 0.85 = 34 <= 2/3 x 60 = 40: no cap
  assert.equal(stock(60, 100).stock, 60 + 40); // 85 > 40: Level 2 capped at 2/3 of Level 1
  assert.equal(stock(60, 100).adjustment40, 45);
  // L1 = 70, L2B = 60 x 50% = 30 (other): Adj15 = max(30 - 15/85 x 70, 30 - 15/60 x 70, 0) = max(17.647, 12.5) = 17.647
  const h = stock(70, 0, 0, 60);
  near(h.adjustment15, 17.647, 0.6); // exact integer arithmetic rounds each step half-even
  near(h.stock, 82.35, 0.6);
  near(Number(h.level2b) - Number(h.adjustment15), 0.15 * Number(h.stock), 0.6); // L2B ends at exactly 15% of the stock
  // when the 40% cap binds first: L1 = 40, L2A = 0, L2B = 50 x 0.5 = 25 -> Adj15 = max(25 - 15/85 x 40 = 17.94, 25 - 10 = 15) = 17.94
  near(stock(40, 0, 0, 50).adjustment15, 17.94, 0.6);
  assert.equal(stock(100, 0).stock, 100);
  assert.equal(stock(0, 100).stock, 0); // Level 2 without Level 1 counts for nothing
});

test("property (seeded): the stock never exceeds the haircut sum, Level 2 <= 40% and Level 2B <= 15% of the stock, monotone in Level 1", () => {
  const rng = createRng(2026);
  for (let i = 0; i < 400; i++) {
    const a = [rng.int(1000000), rng.int(1000000), rng.int(1000000), rng.int(1000000)];
    const h = lcr({ hqla: [{ class: "level1", amount: a[0] }, { class: "level2a", amount: a[1] }, { class: "level2b-rmbs", amount: a[2] }, { class: "level2b-other", amount: a[3] }], outflows: out1 }).hqla;
    const L1 = B(h.level1), L2A = B(h.level2a), L2B = B(h.level2b), S = B(h.stock), a15 = B(h.adjustment15);
    assert.ok(S <= L1 + L2A + L2B && S >= L1 - 0n);
    assert.ok(B(100) * (L2A + L2B - a15 - B(h.adjustment40)) <= B(40) * S + 100n, `L2 share ${JSON.stringify(h)}`);
    assert.ok((L2B - a15) * 100n <= S * 15n + 200n, "L2B share");
    const more = lcr({ hqla: [{ class: "level1", amount: a[0] + 5000 }, { class: "level2a", amount: a[1] }, { class: "level2b-rmbs", amount: a[2] }, { class: "level2b-other", amount: a[3] }], outflows: out1 }).hqla;
    assert.ok(B(more.stock) >= S);
  }
});

test("outflows, inflows and the 75% inflow cap (LCR40.77), exact basis-point weights", () => {
  const r = lcr({
    hqla: [{ class: "level1", amount: 1000 }],
    outflows: [{ category: "retail-stable", amount: 1000000 }, { category: "operational-deposits", amount: 400000 }, { category: "facility-credit-corporate", amount: 200000 }],
    inflows: [{ category: "retail-small-business-performing", amount: 3000000 }, { category: "wholesale-financial-performing", amount: 100000 }],
  });
  assert.equal(r.outflows.total, 50000 + 100000 + 20000); // 5%, 25%, 10%
  assert.equal(r.inflows.total, 1500000 + 100000);
  assert.equal(r.inflows.cap, 127500); // 75% of 170,000
  assert.equal(r.inflows.counted, 127500);
  assert.equal(r.netOutflows, 170000 - 127500);
  const noCap = lcr({ hqla: [{ class: "level1", amount: 1000 }], outflows: [{ category: "other-legal-entities", amount: 1000 }], inflows: [{ category: "reverse-repo-level2a", amount: 100 }] });
  assert.equal(noCap.inflows.counted, 15); // inflow equals the haircut of the Level 2A collateral (LCR40.78)
  assert.equal(noCap.netOutflows, 985);
  assert.equal(noCap.ratioBp, Number((1000n * 10000n + 492n) / 985n));
  assert.equal(noCap.meetsMinimum, true);
  assert.equal(lcr({ hqla: [{ class: "level1", amount: 10 }], outflows: [{ category: "other-legal-entities", amount: 100 }] }).meetsMinimum, false);
  assert.equal(lcr({ hqla: [{ class: "level1", amount: 100 }], outflows: [{ category: "other-legal-entities", amount: 100 }] }).meetsMinimum, true); // exactly 100% meets the minimum
});

test("weights are exact beyond 2^53 and round half to even", () => {
  const big = "9007199254740993";
  const r = lcr({ hqla: [{ class: "level1", amount: big }], outflows: [{ category: "other-legal-entities", amount: big }] });
  assert.equal(r.outflows.total, big);
  assert.equal(r.hqla.stock, big);
  assert.equal(r.ratioBp, 10000);
  const half = lcr({ hqla: [{ class: "level1", amount: 100 }], outflows: [{ category: "retail-stable", amount: 10 }, { category: "retail-stable", amount: 30 }] });
  assert.equal(half.outflows.items.map((x) => x.weighted).join(), "0,2"); // 0.5 -> 0, 1.5 -> 2
});

test("NSFR: ASF and RSF weights, ratio, minimum (NSF20.2)", () => {
  const r = runNsfr(TB, { minorExponent: 0, asf: [{ category: "capital-and-long-term", amount: 400 }, { category: "stable-retail", amount: 1000 }, { category: "wholesale-corporate-operational", amount: 600 }, { category: "all-other-liabilities", amount: 5000 }], rsf: [{ category: "rsf-5", amount: 1000 }, { category: "rsf-65", amount: 1000 }, { category: "rsf-85", amount: 400 }, { category: "rsf-100", amount: 100 }] });
  assert.equal(r.availableStableFunding, 400 + 950 + 300);
  assert.equal(r.requiredStableFunding, 50 + 650 + 340 + 100);
  assert.equal(r.ratioBp, Math.round((1650 / 1140) * 10000));
  assert.equal(r.meetsMinimum, true);
  assert.equal(runNsfr(TB, { minorExponent: 0, asf: [{ category: "less-stable-retail", amount: 100 }], rsf: [{ category: "rsf-100", amount: 100 }] }).meetsMinimum, false);
  assert.equal(runNsfr(TB, { minorExponent: 0, asf: [], rsf: [{ category: "rsf-0", amount: 1 }, { category: "rsf-100", amount: 1 }] }).availableStableFunding, 0);
});

test("refusals: unknown or misplaced categories, negative amounts, no net outflows, no required funding", () => {
  assert.throws(() => lcr({ hqla: [], outflows: [{ category: "retail-stable-ish", amount: 1 }] }), /not a factor/);
  assert.throws(() => lcr({ hqla: [], outflows: out1, inflows: [{ category: "inflow-cap", amount: 1 }] }), /not a factor/);
  assert.throws(() => lcr({ hqla: [{ class: "level3", amount: 1 }], outflows: out1 }), /HQLA class/);
  assert.throws(() => lcr({ hqla: [{ class: "level1", amount: -1 }], outflows: out1 }), /not negative/);
  assert.throws(() => lcr({ hqla: [{ class: "level1", amount: 1 }], outflows: [] }), /undefined/);
  assert.throws(() => lcr({ hqla: [{ class: "level1", amount: 1 }], outflows: [{ category: "retail-stable", amount: 1.5 }] }), SimError);
  assert.throws(() => runNsfr(TB, { minorExponent: 0, asf: [{ category: "stable-retail", amount: 1 }], rsf: [] }), /undefined/);
  assert.throws(() => runNsfr(TB, { minorExponent: 0, asf: [{ category: "rsf-5", amount: 1 }], rsf: [{ category: "rsf-5", amount: 1 }] }), /not a factor/);
  assert.throws(() => runNsfr(TB, { minorExponent: 0, asf: [], rsf: [{ category: "minimum-ratio", amount: 1 }] }), /not a factor/);
});

const profile = (overrides) => ({ $schema: "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/sim-profile.schema.json", schema: "kit.sim-profile.v1", id: "test-profile", label: "A test profile (fixture, not a jurisdiction)", extends: null, overrides: overrides.map((o) => ({ ref: "LCR40.11", reason: "test", ...o })) });
const withProfile = (overrides) => loadTables("test-profile", { tables: TABLES, profiles: { "test-profile": profile(overrides) } });

test("jurisdiction profile: a national option inside the standard's bounds is applied without code changes (LCR40.11: 3% stable retail run-off); outside the bounds, or on a fixed row, it is refused", () => {
  const T = withProfile([{ table: "lcr-outflows", factor: "retail-stable", value: 300 }]);
  assert.equal(T.applied.length, 1);
  assert.equal(T.value("lcr-outflows", "retail-stable"), 300);
  const r = lcr({ hqla: [{ class: "level1", amount: 1000 }], outflows: [{ category: "retail-stable", amount: 100000 }] }, T);
  assert.equal(r.outflows.total, 3000);
  assert.equal(lcr({ hqla: [{ class: "level1", amount: 1000 }], outflows: [{ category: "retail-stable", amount: 100000 }] }).outflows.total, 5000); // the baseline is untouched
  assert.equal(withProfile([{ table: "lcr-outflows", factor: "retail-less-stable", value: 2000 }]).value("lcr-outflows", "retail-less-stable"), 2000); // stricter than the 10% floor
  assert.throws(() => withProfile([{ table: "lcr-outflows", factor: "retail-stable", value: 200 }]), /outside the standard's bounds/); // below the 3% minimum
  assert.throws(() => withProfile([{ table: "lcr-outflows", factor: "retail-less-stable", value: 500 }]), /outside the standard's bounds/); // below the 10% floor
  assert.throws(() => withProfile([{ table: "lcr-hqla", factor: "level2-cap", value: 5000 }]), /outside the standard's bounds/); // a cap cannot be raised
  assert.throws(() => withProfile([{ table: "saccr-supervisory", factor: "alpha", value: 10000 }]), /outside the standard's bounds/);
  assert.throws(() => withProfile([{ table: "lcr-outflows", factor: "no-such-row", value: 1 }]), /not in the tables/);
  assert.throws(() => loadTables("nowhere"), /no profile/);
  const bad = { $schema: "x", schema: "kit.sim-profile.v1", id: "x", label: "x", extends: null, overrides: [{ table: "a" }] };
  assert.throws(() => loadTables("x", { tables: TABLES, profiles: { x: bad } }), /off its schema/);
});

test("a table that fails its schema is refused, not used", () => {
  const broken = structuredClone(TABLES);
  broken["lcr-outflows"].factors[0].value = -5;
  assert.throws(() => loadTables("baseline", { tables: broken, profiles: PROFILES }), /off its schema/);
  const dup = structuredClone(TABLES);
  dup["lcr-outflows"].factors.push({ ...dup["lcr-outflows"].factors[0] });
  assert.throws(() => loadTables("baseline", { tables: dup, profiles: PROFILES }), /repeats factor/);
});

test("determinism: golden hash of a seeded random balance sheet's LCR output", () => {
  const rng = createRng(99);
  const cats = Object.keys(TABLES["lcr-outflows"].factors.reduce((o, f) => ({ ...o, [f.id]: 1 }), {}));
  const outflows = Array.from({ length: 20 }, () => ({ category: cats[rng.int(cats.length)], amount: rng.int(1e9) }));
  const r = lcr({ hqla: [{ class: "level1", amount: rng.int(4e9) }, { class: "level2a", amount: rng.int(1e9) }, { class: "level2b-other", amount: rng.int(1e9) }], outflows });
  assert.equal(hashOf(r), GOLDEN);
});

test("mutation: a changed factor moves the hand-computed examples", () => {
  const mutated = (t, id, v) => { const reg = { tables: structuredClone(TABLES), profiles: PROFILES }; const row = reg.tables[t].factors.find((f) => f.id === id); row.value = v; delete row.min; delete row.max; return loadTables("baseline", reg); };
  const ex = (T) => lcr({ hqla: [{ class: "level1", amount: 70 }, { class: "level2a", amount: 100 }, { class: "level2b-other", amount: 60 }], outflows: [{ category: "retail-stable", amount: 1000 }, { category: "other-legal-entities", amount: 100 }], inflows: [{ category: "reverse-repo-other", amount: 1000 }] }, T);
  const base = ex(TB);
  for (const [t, id, v] of [["lcr-hqla", "level2b-other-haircut", 4000], ["lcr-hqla", "level2b-cap", 2000], ["lcr-hqla", "level2-cap", 5000], ["lcr-outflows", "retail-stable", 400], ["lcr-outflows", "other-legal-entities", 9000], ["lcr-inflows", "inflow-cap", 5000], ["lcr-inflows", "reverse-repo-other", 9000]]) assert.notEqual(hashOf(ex(mutated(t, id, v))), hashOf(base), `${t}/${id}`);
});

const GOLDEN = "152595a5d5251bf6801179c9b2dc0db14278574f8d53f95e630c6825d151f6e3";
