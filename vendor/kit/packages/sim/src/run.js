/**
 * runScenario: a SimScenario in, a SimRun out. Pure: the only inputs are the scenario and the engine's own data; the
 * clock is never read, the PRNG is seeded from the scenario, and the same scenario gives the same run on every engine
 * version of this package (outputs are rounded to 10 decimals so the last bit of a libm differs nowhere). A scenario
 * off its schema, or an input outside a validated range, is a refusal: validation.status "refused", outputs null.
 */
import { SimError } from "./errors.js";
import { hashOf, roundTo, sha256Hex } from "./util.js";
import { createRng } from "./prng.js";
import { curveFromInput, zeroRate, discountFactor, forwardRate, fromContinuous } from "./curve.js";
import { fitNss } from "./nss.js";
import { generateCashflows, priceInstrument } from "./cashflows.js";
import { riskMeasures } from "./risk.js";
import { LIMITS } from "./limits.js";
import { runIrrbb, generateLadder } from "./irrbb.js";
import { irrbbParams, loadTables } from "./data.js";
import { runSaccr } from "./saccr.js";
import { runSma } from "./sma.js";
import { runLcr, runNsfr } from "./liquidity.js";
import { validateScenario, validateLadder, validateRun } from "./schemas.js";
import PKG from "../package.json" with { type: "json" };

export const ENGINE_VERSION = PKG.version;

const COMMON_ASSUMPTIONS = [
  "Pure functions: no clock, no network, no global random state; the PRNG is seeded from the scenario.",
  "Time is in years on ACT/365F from the valuation date; schedules use calendar dates (no business-day calendar).",
  "Floating-point maths in IEEE 754 double precision; money is held in integer minor units and floats are rounded back once at the edge.",
  "Outputs are rounded to 10 decimals so that the last bit of a math library cannot change a replayed run.",
];

const deep = (x) => {
  if (typeof x === "number") return roundTo(x, 10);
  if (Array.isArray(x)) return x.map(deep);
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, deep(v)]));
  return x;
};

function engineCurve(inputs) {
  const curve = curveFromInput(inputs.curve, "inputs/curve");
  const tenors = inputs.forwardTenors ?? curve.tenors;
  if (!tenors) throw new SimError("tenors-required", "a curve given by NSS parameters needs forwardTenors to report on", "inputs/forwardTenors");
  const zeroRates = tenors.map((t) => {
    const z = zeroRate(curve, t);
    return { tenor: t, zero: z, zeroAnnual: fromContinuous(z, "annual"), discountFactor: discountFactor(curve, t), forward1y: t + 1 <= curve.max + 1e-9 ? forwardRate(curve, t, t + 1) : null };
  });
  const out = { curveSource: curve.source, lastTenor: curve.max, zeroRates };
  const assumptions = ["Zero rates are interpolated linearly in the continuously compounded rate, flat before the first tenor; maturities beyond the last are refused, never extrapolated."];
  if (inputs.curve.kind === "par") assumptions.push("Par yields are bootstrapped to zero rates on the coupon grid (linear interpolation of the par yield between pillars); a par curve is never read as a zero curve.");
  if (inputs.fitNss) {
    if (!curve.tenors) throw new SimError("bad-input", "fitNss needs a curve with pillars (zero or par)", "inputs/fitNss");
    const f = fitNss(curve.tenors.map((t, i) => ({ t, rate: curve.zeros[i] })));
    out.nssFit = { params: f.params, rmse: f.rmse, maxError: f.maxError, iterations: f.iterations, starts: f.starts };
    assumptions.push("NSS is fitted to the zero rates by variable-projection least squares with a deterministic multi-start Nelder-Mead on (tau1, tau2) inside documented bounds.");
  }
  return { out, assumptions, checks: ["curve built", "no extrapolation"] };
}

function enginePriceRisk(inputs) {
  const curve = curveFromInput(inputs.curve, "inputs/curve");
  const instruments = inputs.instruments.map((x, i) => {
    try {
      const priced = priceInstrument(x, curve);
      const risk = riskMeasures((c) => priceInstrument(x, c).dirty, curve, { bump: inputs.bump ?? LIMITS.defaultBump, keyTenors: inputs.keyTenors ?? [] });
      return {
        id: x.id, type: x.type, dirty: priced.dirty, accrued: priced.accrued, clean: priced.clean, periods: priced.periods,
        effectiveDuration: risk.effectiveDuration, convexity: risk.convexity, dv01: risk.dv01, keyRates: risk.keyRates ?? [],
        cashflows: priced.cashflows.map((c) => ({ date: c.date, interest: c.interest, principal: c.principal, amount: c.amount })),
      };
    } catch (e) {
      if (e instanceof SimError) throw new SimError(e.code, e.message, `inputs/instruments/${i}${e.path ? `/${e.path}` : ""}`);
      throw e;
    }
  });
  const assumptions = [
    "Prices are full revaluation (bump and reprice) off one curve; floating coupons are projected single-curve from the same curve.",
    "Duration and convexity are central differences on a parallel shift of the continuously compounded zero curve (default 1 bp); DV01 is the price change for 1 bp.",
    "Accrued interest is the pro-rata share of the current period's interest in the instrument's day count; a period that has started is paid in full.",
    "profit-rate instruments are a pricing analogue: a fixed contractual schedule (murabaha-style instalments, ijara-style rentals plus a residual) valued off the benchmark profit-rate curve supplied; no statement about Shariah compliance.",
  ];
  return { out: { instruments }, assumptions, checks: ["instruments within validated ranges", "no extrapolation"] };
}

function engineIrrbb(scenario) {
  const inputs = scenario.inputs;
  const P = irrbbParams(scenario.profile ?? "baseline");
  const curve = curveFromInput(inputs.curve, "inputs/curve");
  let ladder = inputs.ladder, generated = false;
  if (!ladder) { ladder = generateLadder(createRng(scenario.seed), P, inputs.generate); generated = true; }
  const problems = validateLadder(ladder);
  if (problems.length) throw new SimError("bad-ladder", problems.join("; "), "inputs/ladder");
  const out = runIrrbb(P, { currency: inputs.currency, curve, ladder, floor: inputs.floor, tier1: inputs.tier1 });
  if (generated) out.ladder = ladder;
  const assumptions = [
    `Parameters: ${P.id} (${P.standard.title}), version ${P.version}; shock sizes, buckets and coefficients are data with their paragraphs.`,
    "Notional repricing cash flows are given (or generated); no non-maturity-deposit behavioural model, no prepayment or early-redemption scalars, no automatic interest rate option add-on.",
    "Discounting at the supplied risk-free zero curve at the bucket midpoints; one currency per run; no commercial margin in the discount rate.",
    "NII is a repricing-gap estimate over the horizon on a constant balance sheet for the two parallel scenarios.",
    P.floor.ref,
  ];
  return { out, assumptions, checks: ["currency has prescribed shock sizes", "ladder valid", "curve covers every used bucket midpoint"] };
}

function tablesAssumption(TB) {
  const t = Object.values(TB.tables);
  return `Tables: profile ${TB.profile}; ${t.map((x) => `${x.id} (${x.standard.title}, text of ${x.standard.versionPublished})`).join("; ")}.${TB.applied.length ? ` Profile overrides applied: ${TB.applied.map((o) => `${o.table}/${o.factor} ${o.from} to ${o.to} (${o.ref})`).join("; ")}.` : " No profile override applied."}`;
}
const only = (TB, ids) => ({ ...TB, tables: Object.fromEntries(ids.map((i) => [i, TB.tables[i]])) });

function engineSaccr(s) {
  const TB = loadTables(s.profile ?? "baseline");
  const out = runSaccr(TB, s.inputs);
  return { out, assumptions: [tablesAssumption(only(TB, ["saccr-supervisory"])),
    "Netting set level only: one netting set, collateral and margin terms given as haircut-adjusted amounts; no multiple margin agreements, no CDO tranches, no doubled MPOR, no alternative IR aggregation without bucket offsets.",
    "Supervisory duration is floored at 10 business days; maturity factors use 250 business days a year; EAD of a margined set is capped at its unmargined EAD."], checks: ["parameters from data with paragraphs", "unsupported features refused"] };
}
function engineSma(s) {
  const TB = loadTables(s.profile ?? "baseline");
  return { out: runSma(TB, s.inputs), assumptions: [tablesAssumption(only(TB, ["sma"])),
    "Final SMA (OPE25: 12%, 15%, 18%), not the 2016 consultative calibration. Amounts in the table's currency only; no conversion. The loss threshold filter applies to events given; recoveries and exclusions are the caller's."], checks: ["currency matches the thresholds", "three financial years"] };
}
function engineLcr(s) {
  const TB = loadTables(s.profile ?? "baseline");
  return { out: runLcr(TB, s.inputs), assumptions: [tablesAssumption(only(TB, ["lcr-hqla", "lcr-outflows", "lcr-inflows"])),
    "The caller classifies each balance-sheet item into a table category; the engine applies the factors, the Level 2 caps and the inflow cap. HQLA inputs must already be adjusted for the unwinding of short-term secured transactions (LCR30.37); national-discretion items are supplied by category or profile."], checks: ["every category is in the table", "net outflows positive"] };
}
function engineNsfr(s) {
  const TB = loadTables(s.profile ?? "baseline");
  return { out: runNsfr(TB, s.inputs), assumptions: [tablesAssumption(only(TB, ["nsfr-asf", "nsfr-rsf"])),
    "The caller assigns each item its ASF or RSF category (residual maturity, encumbrance, counterparty); the derivative add-on of 5 to 20% of gross derivative liabilities is the caller's to include as an item."], checks: ["every category is in the table", "required stable funding positive"] };
}

const ENGINES = {
  saccr: engineSaccr, sma: engineSma, lcr: engineLcr, nsfr: engineNsfr,
  curve: (s) => engineCurve(s.inputs),
  "price-risk": (s) => enginePriceRisk(s.inputs),
  irrbb: engineIrrbb,
};

/** Values a JSON document cannot hold (NaN, Infinity, BigInt, functions, symbols, undefined in an array, cycles): the scenario is refused, never hashed. */
function nonJson(v, path = "", depth = 0, out = []) {
  if (depth > 64) { out.push({ path, message: "nested deeper than 64 levels (or a cycle)" }); return out; }
  const t = typeof v;
  if (v === null || t === "string" || t === "boolean") return out;
  if (t === "number") { if (!Number.isFinite(v)) out.push({ path, message: `${v} is not a JSON number` }); return out; }
  if (Array.isArray(v)) { v.forEach((x, i) => (x === undefined ? out.push({ path: `${path}/${i}`, message: "undefined in an array is not JSON" }) : nonJson(x, `${path}/${i}`, depth + 1, out))); return out; }
  if (t === "object") { for (const [k, x] of Object.entries(v)) if (x !== undefined) nonJson(x, `${path}/${k}`, depth + 1, out); return out; }
  out.push({ path, message: `a ${t} is not JSON` });
  return out;
}

export function runScenario(scenario) {
  const bad = nonJson(scenario);
  const base = {
    schema: "kit.sim-run.v1",
    scenarioId: typeof scenario?.id === "string" && scenario.id ? scenario.id : "unknown",
    engine: typeof scenario?.engine === "string" && scenario.engine ? scenario.engine : "unknown",
    engineVersion: ENGINE_VERSION,
    inputsHash: bad.length ? sha256Hex("unhashable-scenario") : hashOf(scenario ?? null),
    seed: Number.isInteger(scenario?.seed) && scenario.seed >= 0 && scenario.seed <= 0xffffffff ? scenario.seed : 0,
    asOf: typeof scenario?.asOf === "string" && !Number.isNaN(Date.parse(scenario.asOf)) ? scenario.asOf : "1970-01-01T00:00:00Z",
  };
  const refuse = (problems) => ({ ...base, outputs: null, assumptions: COMMON_ASSUMPTIONS, validation: { status: "refused", checks: [], problems } });
  const emit = (run) => {
    const problems = validateRun(run);
    if (!problems.length) return run;
    const refused = refuse([{ code: "output-contract", message: `the run does not match kit.sim-run.v1: ${problems.join("; ")}` }]);
    const again = validateRun(refused);
    if (again.length) throw new Error(`internal: a refused run is off its contract: ${again.join("; ")}`);
    return refused;
  };
  if (bad.length) return emit(refuse(bad.map((p) => ({ code: "not-json", path: p.path, message: p.message }))));
  const problems = validateScenario(scenario);
  if (problems.length) return emit(refuse(problems.map((p) => { const i = p.indexOf(": "); return { code: "invalid-scenario", path: i > 0 ? p.slice(0, i) : "", message: i > 0 ? p.slice(i + 2) : p }; })));
  try {
    const r = ENGINES[scenario.engine](scenario);
    return emit({ ...base, outputs: deep(r.out), assumptions: [...COMMON_ASSUMPTIONS, ...r.assumptions], validation: { status: "validated", checks: ["scenario matches kit.sim-scenario.v1", ...r.checks], problems: [] } });
  } catch (e) {
    if (e instanceof SimError) return emit(refuse([{ code: e.code, path: e.path, message: e.message }]));
    throw e;
  }
}
