// Review of #110, second round. Each finding is a test that failed before its fix. EXPECT is a second, independently typed copy of the
// standards' tables (values only), kept in this file: a change to a table row needs a deliberate edit in two places.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as S from "../src/index.js";

const {
  loadTables, TABLES, PROFILES, buildTables, runSaccr, runSma, runLcr, runNsfr, runScenario, validateRun, SCHEMAS, createRng, SimError, SACCR_LIMITS,
} = S;

const EXPECT = {
 "lcr-hqla": {
  "level1-haircut": 0,
  "level2a-haircut": 1500,
  "level2b-rmbs-haircut": 2500,
  "level2b-other-haircut": 5000,
  "level2-cap": 4000,
  "level2b-cap": 1500,
  "minimum-ratio": 10000
 },
 "lcr-inflows": {
  "reverse-repo-level1": 0,
  "reverse-repo-level2a": 1500,
  "reverse-repo-level2b-rmbs": 2500,
  "reverse-repo-level2b-other": 5000,
  "margin-lending-other-collateral": 5000,
  "secured-lending-covering-short-positions": 0,
  "reverse-repo-other": 10000,
  "retail-small-business-performing": 5000,
  "wholesale-non-financial-performing": 5000,
  "wholesale-financial-performing": 10000,
  "securities-maturing-non-hqla": 10000,
  "operational-deposits-held": 0,
  "derivatives-net-inflows": 10000,
  "undrawn-facilities-held": 0,
  "inflow-cap": 7500
 },
 "lcr-outflows": {
  "retail-stable": 500,
  "retail-less-stable": 1000,
  "retail-term-over-30d": 0,
  "small-business-stable": 500,
  "small-business-less-stable": 1000,
  "operational-deposits": 2500,
  "cooperative-network-deposits": 2500,
  "corporate-sovereign-general": 4000,
  "corporate-sovereign-insured": 2000,
  "other-legal-entities": 10000,
  "secured-level1-or-central-bank": 0,
  "secured-level2a": 1500,
  "secured-domestic-public-sector": 2500,
  "secured-level2b-rmbs": 2500,
  "secured-level2b-other": 5000,
  "secured-other": 10000,
  "derivatives-net-outflows": 10000,
  "downgrade-triggers": 10000,
  "collateral-valuation-change": 2000,
  "excess-collateral-callable": 10000,
  "collateral-due-not-demanded": 10000,
  "collateral-substitution": 10000,
  "structured-financing-maturing": 10000,
  "facility-retail-small-business": 500,
  "facility-credit-corporate": 1000,
  "facility-liquidity-corporate": 3000,
  "facility-bank": 4000,
  "facility-credit-financial": 4000,
  "facility-liquidity-financial": 10000,
  "facility-other-legal-entities": 10000,
  "contractual-lending-financial": 10000,
  "other-contractual-outflows": 10000
 },
 "nsfr-asf": {
  "capital-and-long-term": 10000,
  "stable-retail": 9500,
  "less-stable-retail": 9000,
  "wholesale-corporate-operational": 5000,
  "other-six-to-twelve-months": 5000,
  "all-other-liabilities": 0
 },
 "nsfr-rsf": {
  "rsf-0": 0,
  "rsf-5": 500,
  "rsf-10": 1000,
  "rsf-15": 1500,
  "rsf-50": 5000,
  "rsf-65": 6500,
  "rsf-85": 8500,
  "rsf-100": 10000,
  "minimum-ratio": 10000
 },
 "saccr-supervisory": {
  "alpha": 14000,
  "multiplier-floor": 500,
  "sd-rate": 500,
  "business-days-per-year": 250,
  "floor-days": 10,
  "mpor-daily-bilateral": 10,
  "mpor-cleared": 5,
  "mpor-base-nondaily": 9,
  "ir-bucket-corr-adjacent": 7000,
  "ir-bucket-corr-far": 3000,
  "margined-mf-multiplier": 15000,
  "max-trades-single-mpor": 5000,
  "basis-multiplier": 5000,
  "volatility-multiplier": 50000,
  "sf-ir": 50,
  "sf-fx": 400,
  "sf-credit-aaa": 38,
  "sf-credit-aa": 38,
  "sf-credit-a": 42,
  "sf-credit-bbb": 54,
  "sf-credit-bb": 106,
  "sf-credit-b": 160,
  "sf-credit-ccc": 600,
  "sf-credit-index-ig": 38,
  "sf-credit-index-sg": 106,
  "sf-equity-single": 3200,
  "sf-equity-index": 2000,
  "sf-commodity-electricity": 4000,
  "sf-commodity-other": 1800,
  "corr-credit-single": 5000,
  "corr-credit-index": 8000,
  "corr-equity-single": 5000,
  "corr-equity-index": 8000,
  "corr-commodity": 4000,
  "vol-ir": 5000,
  "vol-fx": 1500,
  "vol-credit-single": 10000,
  "vol-credit-index": 8000,
  "vol-equity-single": 12000,
  "vol-equity-index": 7500,
  "vol-commodity-electricity": 15000,
  "vol-commodity-other": 7000
 },
 "sma": {
  "bucket1-coefficient": 1200,
  "bucket2-coefficient": 1500,
  "bucket3-coefficient": 1800,
  "threshold1": 1000000000,
  "threshold2": 30000000000,
  "ildc-cap": 225,
  "loss-component-multiplier": 15,
  "ilm-exponent": 8000,
  "loss-years-full": 10,
  "loss-years-min": 5,
  "loss-threshold": 20000,
  "rwa-multiplier": 125000
 }
};

const clone = (x) => structuredClone(x);
const profile = (overrides, over = {}) => ({ $schema: "x", schema: "kit.sim-profile.v1", id: "prof", label: "p", extends: null, overrides: overrides.map((o) => ({ ref: "r", reason: "test", ...o })), ...over });
const withProfile = (overrides, over) => buildTables("prof", { tables: TABLES, profiles: { prof: profile(overrides, over) } });
const registry = (mut) => { const tables = clone(TABLES); mut?.(tables); return { tables, profiles: { baseline: PROFILES.baseline } }; };
const TB = loadTables();

test("tables equal the independent copy: same tables, same rows, same values", () => {
  assert.deepEqual(Object.keys(TABLES).sort(), Object.keys(EXPECT).sort());
  for (const [t, rows] of Object.entries(EXPECT)) {
    assert.deepEqual(TABLES[t].factors.map((f) => f.id).sort(), Object.keys(rows).sort(), t);
    for (const f of TABLES[t].factors) assert.equal(f.value, rows[f.id], `${t}/${f.id}`);
  }
});

// 1
test("1: a profile can never loosen any row of any table: refusals generated from the tables, in the conservative direction of each row", () => {
  let checked = 0;
  for (const [tid, t] of Object.entries(TABLES)) {
    for (const f of t.factors) {
      const hasMin = f.min !== undefined, hasMax = f.max !== undefined;
      if (tid === "lcr-inflows") assert.ok(hasMax && (!hasMin || f.min === f.max), `${tid}/${f.id}: an inflow row is bounded above only`);
      if (tid === "lcr-outflows") assert.ok(hasMin && (!hasMax || f.min === f.max), `${tid}/${f.id}: an outflow row is bounded below only`);
      const refuse = (v) => assert.throws(() => withProfile([{ table: tid, factor: f.id, value: v }]), SimError, `${tid}/${f.id} = ${v}`);
      const accept = (v) => assert.equal(withProfile([{ table: tid, factor: f.id, value: v }]).value(tid, f.id), v, `${tid}/${f.id} = ${v}`);
      if (!hasMin && !hasMax) { refuse(f.value + 1); if (f.value > 0) refuse(f.value - 1); }
      if (hasMax) refuse(f.max + 1);
      if (hasMin && f.min > 0) refuse(f.min - 1);
      if (hasMax && !hasMin && f.value > 0) accept(f.value - 1);
      if (hasMin && !hasMax) accept(f.value + 1);
      if (hasMin || hasMax) accept(f.value);
      checked++;
    }
  }
  assert.ok(checked > 100);
  assert.throws(() => withProfile([{ table: "lcr-inflows", factor: "reverse-repo-level1", value: 10000 }]), /outside the standard's bounds/);
});

// 2
test("2: buildTables checks the tables and the profile themselves", () => {
  const bad = (mut, re) => assert.throws(() => buildTables("baseline", registry(mut)), re);
  bad((t) => { t["lcr-outflows"].factors[0].value = 100; t["lcr-outflows"].factors[0].min = 500; }, /outside its own bounds/);
  bad((t) => { t["lcr-hqla"].factors[0].min = 10; t["lcr-hqla"].factors[0].max = 5; }, /min .* above max/);
  bad((t) => { t["lcr-hqla"].profile = "elsewhere"; }, /baseline/);
  assert.throws(() => withProfile([{ table: "lcr-outflows", factor: "retail-stable", value: 400 }, { table: "lcr-outflows", factor: "retail-stable", value: 450 }]), /twice/);
  assert.throws(() => buildTables("prof", { tables: TABLES, profiles: { prof: profile([], { id: "other" }) } }), /id/);
  assert.throws(() => withProfile([], { extends: "something-else" }), /extends/);
  assert.doesNotThrow(() => withProfile([], { extends: "baseline" }));
  assert.doesNotThrow(() => withProfile([{ table: "lcr-outflows", factor: "retail-stable", value: 300 }]));
});

// 3
const ir = (o = {}) => ({ assetClass: "ir", currency: "USD", notional: 1000, position: "long", startYears: 0, endYears: 5, maturityYears: 5, mtm: 0, ...o });
const run = (trades, extra = {}, T = TB) => runSaccr(T, { minorExponent: 0, trades, ...extra });
test("3: doubled-MPOR situations have an input path and are refused explicitly; 5001 unmargined trades are fine, 5001 margined are refused", () => {
  const m = { threshold: 0, mta: 0, nica: 0 };
  for (const flag of ["illiquidCollateral", "hardToReplaceTrades", "recentDisputes"]) assert.throws(() => run([ir()], { margin: { ...m, [flag]: true } }), /doubled/, flag);
  assert.doesNotThrow(() => run([ir()], { margin: { ...m, illiquidCollateral: false, hardToReplaceTrades: false, recentDisputes: false } }));
  const many = Array.from({ length: 5001 }, (_, i) => ir({ id: `t${i}`, notional: 10 + (i % 7) }));
  assert.doesNotThrow(() => run(many));
  assert.throws(() => run(many, { margin: m }), /doubled/);
  assert.doesNotThrow(() => run(many.slice(0, 5000), { margin: m }));
});

// 4
test("4: an option trade has one direction source: the option; a position beside it is a refusal", () => {
  const opt = { kind: "put", position: "bought", underlying: 0.06, strike: 0.05, expiryYears: 1 };
  const t = ir({ option: opt });
  delete t.position;
  assert.doesNotThrow(() => run([t]));
  assert.throws(() => run([{ ...t, position: "long" }]), /one source/);
  assert.throws(() => run([{ ...t, position: "short" }]), /one source/);
  const lin = ir(); delete lin.position;
  assert.throws(() => run([lin]), /position/);
});

// 5
const MUT = (v) => (v === 0 ? 100 : Math.round(v * 1.5) + 1);
function saccrBattery(T) {
  const out = [];
  const go = (trades, extra = {}) => { try { const r = run(trades, extra, T); out.push(JSON.stringify([r.ead, r.pfe, r.addOn, r.multiplier, r.trades.map((x) => x.effectiveNotional), r.eadMargined, r.cappedAtUnmargined])); } catch (e) { out.push(`E:${e.code}`); } };
  go([ir({ endYears: 0.5, maturityYears: 0.5 }), ir({ endYears: 3, maturityYears: 3, position: "short" }), ir({ endYears: 12, maturityYears: 12, notional: 700 })]);
  go([ir({ endYears: 0.5, maturityYears: 0.5 }), ir({ endYears: 12, maturityYears: 12, position: "short" })]);
  go([ir({ endYears: 3, maturityYears: 3 }), ir({ endYears: 12, maturityYears: 12, position: "short" })]);
  go([ir({ basis: true }), ir({ volatility: true, currency: "EUR" })]);
  go([{ assetClass: "fx", currencyPair: "EURUSD", notional: 1000, position: "long", maturityYears: 2 }, { assetClass: "fx", currencyPair: "EURUSD", notional: 300, position: "short", maturityYears: 2 }, { assetClass: "fx", currencyPair: "GBPUSD", notional: 500, position: "long", maturityYears: 2, basis: true }, { assetClass: "fx", currencyPair: "JPYUSD", notional: 500, position: "long", maturityYears: 2, volatility: true }]);
  const cr = (id, sub, pos = "long", n = 1000) => ({ assetClass: "credit", subclass: sub, referenceId: id, notional: n, position: pos, startYears: 0, endYears: 5, maturityYears: 5 });
  go(["AAA", "AA", "A", "BBB", "BB", "B", "CCC"].map((r, i) => cr(`n${i}`, r, i % 2 ? "short" : "long", 1000 + i * 100)).concat([cr("ig", "index-IG"), cr("sg", "index-SG", "short")]));
  go([{ assetClass: "equity", subclass: "single", referenceId: "a", notional: 1000, position: "long", maturityYears: 2 }, { assetClass: "equity", subclass: "single", referenceId: "b", notional: 400, position: "short", maturityYears: 2 }, { assetClass: "equity", subclass: "index", referenceId: "c", notional: 800, position: "long", maturityYears: 2 }, { assetClass: "equity", subclass: "index", referenceId: "d", notional: 300, position: "long", maturityYears: 2 }]);
  const cm = (set, id, n, o = {}) => ({ assetClass: "commodity", hedgingSet: set, referenceId: id, notional: n, position: "long", maturityYears: 3, ...o });
  go([cm("energy", "power", 1000, { subclass: "electricity" }), cm("energy", "crude", 800), cm("energy", "gas", 500, { position: "short" }), cm("metals", "gold", 700), cm("metals", "silver", 400), cm("agricultural", "wheat", 600), cm("other", "x", 300)]);
  const op = (assetClass, extra, o = {}) => { const t = { assetClass, notional: 1000, maturityYears: 2, option: { kind: "call", position: "bought", underlying: 100, strike: 90, expiryYears: 1.5, ...o }, ...extra }; return t; };
  go([op("ir", { currency: "USD", startYears: 0, endYears: 5 }), op("fx", { currencyPair: "EURUSD" }), op("credit", { subclass: "AA", referenceId: "a", startYears: 0, endYears: 5 }), op("credit", { subclass: "index-IG", referenceId: "i", startYears: 0, endYears: 5 }), op("equity", { subclass: "single", referenceId: "e" }), op("equity", { subclass: "index", referenceId: "f" }), op("commodity", { hedgingSet: "energy", referenceId: "p", subclass: "electricity" }), op("commodity", { hedgingSet: "metals", referenceId: "m" })]);
  go([ir({ maturityYears: 0.01, endYears: 0.02, mtm: 5 }), ir({ maturityYears: 0.5, endYears: 0.5, position: "short", mtm: -5 })]);
  go([ir({ mtm: 20 }), ir({ endYears: 2, maturityYears: 2, position: "short", mtm: -20 })], { collateral: 5 });
  go([ir({ mtm: 0 })], { collateral: 100000 });
  go([ir({ mtm: 0 })], { collateral: 50 });
  const mg = (m) => go([ir({ endYears: 3, maturityYears: 3, notional: 5000, mtm: 10 }), ir({ endYears: 9, maturityYears: 9, notional: 3000, position: "short", mtm: -4 })], { collateral: 1, margin: { threshold: 2, mta: 1, nica: 0, ...m } });
  mg({}); mg({ remarginingDays: 5 }); mg({ cleared: true }); mg({ remarginingDays: 20 }); mg({ threshold: 100000 }); mg({ nica: 500 });
  const many = Array.from({ length: 5001 }, (_, i) => ir({ id: `t${i}`, notional: 10 + (i % 3) }));
  go(many); go(many, { margin: { threshold: 0, mta: 0, nica: 0 } });
  return out;
}
function smaBattery(T) {
  const out = [];
  const y = (o = {}) => ({ interestIncome: 0, interestExpense: 0, interestEarningAssets: 0, dividendIncome: 0, otherOperatingIncome: 0, otherOperatingExpense: 0, feeIncome: 0, feeExpense: 0, tradingBookPnl: 0, bankingBookPnl: 0, ...o });
  const BN = 100000000000n;
  const bank = (bn, o = {}) => [0, 1, 2].map(() => y({ feeIncome: String(BigInt(Math.round(bn * 100)) * BN / 100n), ...o }));
  const go = (years, extra = {}, cur = "EUR") => { try { out.push(JSON.stringify(runSma(T, { currency: cur, minorExponent: 2, years, ...extra }))); } catch (e) { out.push(`E:${e.code}`); } };
  const loss = (n, amount, years = 10) => ({ lossHistory: { years, events: Array.from({ length: n }, (_, i) => ({ yearIndex: i % years, amount: String(amount) })) } });
  go(bank(0.5)); go(bank(1)); go(bank(1.5)); go(bank(30)); go(bank(35)); go(bank(40));
  go(bank(2), loss(10, 1800000000)); go(bank(2), loss(10, 5000000000)); go(bank(2), loss(10, 200000000)); go(bank(2), loss(5, 5000000000, 5)); go(bank(2), loss(4, 5000000000, 4)); go(bank(2), loss(11, 5000000000, 11));
  go(bank(2), { lossHistory: { years: 10, events: [{ yearIndex: 0, amount: "2500000" }, { yearIndex: 1, amount: "1999999" }, { yearIndex: 2, amount: "9000000" }] } });
  go(bank(2), { lossHistory: { years: 10, events: [{ yearIndex: 0, amount: "1500000" }, { yearIndex: 1, amount: "2000000" }, { yearIndex: 2, amount: "5000000" }] } });
  go(bank(2), { lossHistory: { years: 10, events: [{ yearIndex: 0, amount: "9999999" }] } });
  go([0, 1, 2].map(() => y({ interestIncome: 100000000000, interestEarningAssets: 1000000000000 })));
  go([0, 1, 2].map(() => y({ interestIncome: 100000, interestExpense: 40000, interestEarningAssets: 10000000, dividendIncome: 7 })));
  go(bank(2), {}, "USD");
  return out;
}
function lcrBattery(T) {
  const out = [];
  const go = (x) => { try { out.push(JSON.stringify(runLcr(T, { minorExponent: 0, inflows: [], outflows: [], ...x }))); } catch (e) { out.push(`E:${e.code}`); } };
  const hq = (a) => ["level1", "level2a", "level2b-rmbs", "level2b-other"].map((c, i) => ({ class: c, amount: a[i] })).filter((h) => h.amount);
  const outs = TABLES["lcr-outflows"].factors.map((f, i) => ({ id: f.id, category: f.id, amount: 1000003 + i * 7919 }));
  const ins = TABLES["lcr-inflows"].factors.filter((f) => f.id !== "inflow-cap").map((f, i) => ({ id: f.id, category: f.id, amount: 100003 + i * 313 }));
  go({ hqla: hq([5000000, 0, 0, 0]), outflows: outs, inflows: [] });
  go({ hqla: hq([5000000, 0, 0, 0]), outflows: outs, inflows: ins });
  go({ hqla: hq([5000000, 0, 0, 0]), outflows: [{ category: "other-legal-entities", amount: 1000000 }], inflows: [{ category: "retail-small-business-performing", amount: 9000000 }] });
  go({ hqla: hq([70, 100, 0, 60]), outflows: [{ category: "other-legal-entities", amount: 100 }] });
  go({ hqla: hq([70000, 100000, 20000, 60000]), outflows: [{ category: "other-legal-entities", amount: 100 }] });
  go({ hqla: hq([40000, 0, 30000, 50000]), outflows: [{ category: "other-legal-entities", amount: 100 }] });
  go({ hqla: hq([100000, 80000, 0, 0]), outflows: [{ category: "other-legal-entities", amount: 100 }] });
  go({ hqla: hq([1200, 0, 0, 0]), outflows: [{ category: "other-legal-entities", amount: 1000 }] });
  go({ hqla: hq([1200, 0, 0, 0]), outflows: [{ category: "other-legal-entities", amount: 1000 }], inflows: [{ category: "reverse-repo-other", amount: 100 }] });
  return out;
}
function nsfrBattery(T) {
  const out = [];
  const go = (x) => { try { out.push(JSON.stringify(runNsfr(T, { minorExponent: 0, ...x }))); } catch (e) { out.push(`E:${e.code}`); } };
  const a = TABLES["nsfr-asf"].factors.map((f, i) => ({ category: f.id, amount: 100003 + i * 911 }));
  const r = TABLES["nsfr-rsf"].factors.filter((f) => f.id !== "minimum-ratio").map((f, i) => ({ category: f.id, amount: 90001 + i * 701 }));
  go({ asf: a, rsf: r });
  go({ asf: [{ category: "capital-and-long-term", amount: 1200 }], rsf: [{ category: "rsf-100", amount: 1000 }] });
  return out;
}
const BATTERY = { "saccr-supervisory": saccrBattery, sma: smaBattery, "lcr-hqla": lcrBattery, "lcr-outflows": lcrBattery, "lcr-inflows": lcrBattery, "nsfr-asf": nsfrBattery, "nsfr-rsf": nsfrBattery };
test("5: every row of every table is pinned: mutating any single row changes the output of its battery (generated from the tables)", () => {
  const survivors = [];
  const base = {};
  for (const tid of Object.keys(TABLES)) base[tid] = BATTERY[tid](TB);
  for (const [tid, t] of Object.entries(TABLES)) {
    for (const f of t.factors) {
      const reg = { tables: clone(TABLES), profiles: { baseline: PROFILES.baseline } };
      const row = reg.tables[tid].factors.find((x) => x.id === f.id);
      row.value = MUT(f.value); delete row.min; delete row.max;
      const got = BATTERY[tid](buildTables("baseline", reg));
      if (JSON.stringify(got) === JSON.stringify(base[tid])) survivors.push(`${tid}/${f.id}`);
    }
  }
  assert.deepEqual(survivors, [], `unpinned rows:\n${survivors.join("\n")}`);
});

// 6
test("6: one source for the enumerations and limits: code, schema and tables agree", () => {
  const trade = SCHEMAS.scenario.$defs.saccrInputs.properties.trades;
  assert.equal(trade.maxItems, SACCR_LIMITS.maxTrades);
  assert.deepEqual([...trade.items.properties.assetClass.enum], [...S.SACCR_CLASSES]);
  assert.deepEqual([...trade.items.properties.hedgingSet.enum], [...S.COMMODITY_SETS]);
  const ratings = TABLES["saccr-supervisory"].factors.filter((f) => /^sf-credit-(aaa|aa|a|bbb|bb|b|ccc)$/.test(f.id)).map((f) => f.id.slice(10).toUpperCase());
  assert.deepEqual([...S.CREDIT_RATINGS].sort(), ratings.sort());
  const cond = JSON.stringify(trade.items.allOf);
  for (const r of S.CREDIT_RATINGS) assert.ok(cond.includes(`"${r}"`), r);
  assert.deepEqual(Object.keys(S.HQLA_CLASSES).sort(), [...SCHEMAS.scenario.$defs.lcrInputs.properties.hqla.items.properties.class.enum].sort());
  for (const [cls, rowId] of Object.entries(S.HQLA_CLASSES)) assert.ok(TB.has("lcr-hqla", rowId), `${cls} -> ${rowId}`);
  const sma = SCHEMAS.scenario.$defs.smaInputs.properties;
  assert.equal(sma.years.minItems, S.SMA_YEARS);
  assert.equal(sma.years.maxItems, S.SMA_YEARS);
  assert.equal(sma.lossHistory.properties.years.maximum, TB.value("sma", "loss-years-full"));
  assert.equal(sma.lossHistory.properties.events.items.properties.yearIndex.maximum, TB.value("sma", "loss-years-full") - 1);
  assert.deepEqual([...Object.keys(sma.years.items.properties)].sort(), [...S.SMA_ITEMS].sort());
});
test("6: no bare basis-point scaling or margined maturity factor literal outside money.js and the tables", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  for (const f of readdirSync(new URL("../src/", import.meta.url)).filter((x) => x.endsWith(".js") && x !== "money.js")) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(src, /\b10000n?\b|\b1e4\b|\b1\.5 \*/, f);
  }
  assert.equal(TB.value("saccr-supervisory", "margined-mf-multiplier"), 15000);
});

// 7
test("7: the output of every engine is enforced against its own schema at emit", () => {
  const zero = { kind: "zero", compounding: "continuous", tenors: [0.5, 1, 2, 5, 10, 20, 30], rates: [0.03, 0.032, 0.035, 0.04, 0.043, 0.046, 0.047] };
  const scen = (engine, inputs) => ({ schema: "kit.sim-scenario.v1", id: `o.${engine}`, engine, seed: 1, asOf: "2026-10-07T00:00:00Z", source: { kind: "sandbox-mock" }, inputs });
  const y = { interestIncome: 0, interestExpense: 0, interestEarningAssets: 0, dividendIncome: 0, otherOperatingIncome: 0, otherOperatingExpense: 0, feeIncome: "3500000000000", feeExpense: 0, tradingBookPnl: 0, bankingBookPnl: 0 };
  const bond = { id: "b", type: "fixed", notional: 100, rate: 0.04, dayCount: "30/360", startDate: "2025-01-15", maturityDate: "2030-01-15", valuationDate: "2025-01-15", frequency: 2 };
  const cases = [
    scen("curve", { curve: zero, fitNss: true }), scen("price-risk", { curve: zero, instruments: [bond], keyTenors: [1, 5] }),
    scen("irrbb", { currency: "USD", curve: zero, tier1: 100000, generate: { minorExponent: 0, assets: { count: 3, total: 1000000, maxRepricingYears: 10 }, liabilities: { count: 3, total: 900000, maxRepricingYears: 2 } } }),
    scen("saccr", { minorExponent: 0, collateral: 5, margin: { threshold: 0, mta: 1, nica: 0 }, trades: [{ assetClass: "ir", currency: "USD", notional: 1000, position: "long", startYears: 0, endYears: 5, maturityYears: 5, mtm: 3 }] }),
    scen("sma", { currency: "EUR", minorExponent: 2, years: [y, y, y], lossHistory: { years: 10, events: [{ yearIndex: 0, amount: 5000000 }] } }),
    scen("lcr", { minorExponent: 0, hqla: [{ class: "level1", amount: 100 }, { class: "level2a", amount: 50 }], outflows: [{ category: "retail-stable", amount: 100 }], inflows: [{ category: "reverse-repo-other", amount: 10 }] }),
    scen("nsfr", { minorExponent: 0, asf: [{ category: "stable-retail", amount: 1000 }], rsf: [{ category: "rsf-65", amount: 1000 }] }),
  ];
  for (const s of cases) {
    const r = runScenario(s);
    assert.equal(r.validation.status, "validated", `${s.engine}: ${JSON.stringify(r.validation.problems)}`);
    assert.deepEqual(validateRun(r), [], s.engine);
    const first = Object.keys(r.outputs)[0];
    assert.ok(validateRun({ ...r, outputs: { ...r.outputs, extraneous: 1 } }).length > 0, `${s.engine}: extra property`);
    const rest = Object.fromEntries(Object.entries(r.outputs).filter(([k]) => k !== first));
    assert.ok(validateRun({ ...r, outputs: rest }).length > 0, `${s.engine}: missing ${first}`);
    assert.ok(validateRun({ ...r, outputs: { ...r.outputs, [first]: { not: "the shape" } } }).length > 0, `${s.engine}: wrong type of ${first}`);
  }
});

// 8
test("8: LCR40.78 and LCR40.79: the margin-lending row (50%), the short-position row (0%) and the cites", () => {
  const r = (id) => TABLES["lcr-inflows"].factors.find((f) => f.id === id);
  assert.equal(r("margin-lending-other-collateral").value, 5000);
  assert.equal(r("secured-lending-covering-short-positions").value, 0);
  assert.equal(r("reverse-repo-other").value, 10000);
  for (const id of ["reverse-repo-level1", "reverse-repo-level2a", "reverse-repo-level2b-rmbs", "reverse-repo-level2b-other", "margin-lending-other-collateral", "reverse-repo-other"]) assert.match(r(id).ref, /LCR40\.78, LCR40\.79 table/, id);
});

// 9
test("9: SA-CCR output does not depend on the order of the trades; SMA exact beyond 2^53", () => {
  const trades = [
    ir({ id: "a", endYears: 0.5, maturityYears: 0.5, notional: 1234567 }), ir({ id: "b", endYears: 3, maturityYears: 3, notional: 7654321, position: "short" }), ir({ id: "c", endYears: 12, maturityYears: 12, notional: 333333 }),
    { id: "d", assetClass: "credit", subclass: "BBB", referenceId: "x", notional: 98765, position: "long", startYears: 0, endYears: 4, maturityYears: 4 },
    { id: "e", assetClass: "credit", subclass: "AA", referenceId: "y", notional: 45678, position: "short", startYears: 0, endYears: 7, maturityYears: 7 },
    { id: "f", assetClass: "fx", currencyPair: "EURUSD", notional: 100003, position: "long", maturityYears: 1 }, { id: "g", assetClass: "fx", currencyPair: "EURUSD", notional: 30007, position: "short", maturityYears: 1 },
    { id: "h", assetClass: "commodity", hedgingSet: "energy", referenceId: "oil", notional: 55555, position: "long", maturityYears: 2 }, { id: "i", assetClass: "commodity", hedgingSet: "energy", referenceId: "gas", notional: 44444, position: "short", maturityYears: 2 },
  ];
  const base = JSON.stringify(run(trades));
  const rng = createRng(77);
  for (let k = 0; k < 20; k++) {
    const t = clone(trades);
    for (let i = t.length - 1; i > 0; i--) { const j = rng.int(i + 1); [t[i], t[j]] = [t[j], t[i]]; }
    assert.equal(JSON.stringify(run(t)), base, `permutation ${k}`);
  }
  const big = (x) => String(BigInt(x) * 10n ** 12n);
  const yv = () => ({ interestIncome: 0, interestExpense: 0, interestEarningAssets: 0, dividendIncome: 0, otherOperatingIncome: 0, otherOperatingExpense: 0, feeIncome: big(35000000), feeExpense: 0, tradingBookPnl: 0, bankingBookPnl: 0 });
  const r1 = runSma(TB, { currency: "EUR", minorExponent: 2, years: [yv(), yv(), yv()], lossHistory: { years: 10, events: Array.from({ length: 10 }, (_, i) => ({ yearIndex: i, amount: big(30000000) })) } });
  const BI = BigInt(big(35000000)), bn = 100000000000n;
  const bic = (12n * bn) / 100n + (29n * 15n * bn) / 100n + ((BI - 30n * bn) * 18n) / 100n;
  assert.equal(BigInt(r1.bic), bic);
  assert.equal(BigInt(r1.bi), BI);
  const lc = 15n * BigInt(big(30000000));
  const ilm = Math.log(Math.E - 1 + (Number((lc * 10n ** 18n) / bic) / 1e18) ** 0.8);
  const orc = (bic * BigInt(Math.round(ilm * 1e12)) + 500000000000n) / 1000000000000n;
  assert.equal(typeof r1.orc, "string", "beyond 2^53 the amount is a digit string");
  assert.ok(BigInt(r1.orc) - orc <= 1n && orc - BigInt(r1.orc) <= 1n, `${r1.orc} vs ${orc}`);
});

// 10
test("10: SMA thresholds are fixed rows (no profile can move them) and the docs say national discretion is not modelled", async () => {
  for (const id of ["threshold1", "threshold2"]) {
    const f = TABLES.sma.factors.find((x) => x.id === id);
    assert.equal(f.min, f.value); assert.equal(f.max, f.value);
    assert.throws(() => withProfile([{ table: "sma", factor: id, value: f.value + 1 }]), /outside/);
  }
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(new URL("../../../docs/SIM.md", import.meta.url), "utf8"), /National discretion.*not modelled/i);
});

test("5: the batteries themselves exercise the engines: the only refusals in a baseline battery are the ones built to refuse", () => {
  const errs = (b) => b.filter((x) => x.startsWith("E:")).map((x) => x);
  assert.deepEqual(errs(BATTERY["saccr-supervisory"](TB)), ["E:unsupported"]); // 5001 trades margined
  assert.deepEqual(errs(BATTERY.sma(TB)), ["E:bad-input", "E:currency-mismatch"]); // 11 years of losses, USD
  for (const t of ["lcr-hqla", "nsfr-asf"]) assert.deepEqual(errs(BATTERY[t](TB)), [], t);
});
