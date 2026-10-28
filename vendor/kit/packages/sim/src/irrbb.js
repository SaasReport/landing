/**
 * IRRBB: the six prescribed EVE shocks, delta EVE and a delta NII on a banking-book repricing ladder.
 * Standard: Basel Framework SRP31 (BCBS d368, "Interest rate risk in the banking book", April 2016; consolidated
 * text of 2019-12-15). Parameters are DATA (data/irrbb-basel-baseline.json, kit.sim-irrbb-params.v1), each with its
 * paragraph; nothing numeric about the standard lives in this file except the six scenario formulas of SRP31.91.
 *
 *   short scalar S(t) = e^(-t/x), x = 4 (SRP31.91(2), fn 8); long scalar = 1 - S(t) (SRP31.91(3))
 *   parallel up/down : +/- R_parallel                         short up/down : +/- R_short * S(t)
 *   steepener        : -0.65 |R_short| S(t) + 0.9 |R_long| (1 - S(t))
 *   flattener        : +0.8  |R_short| S(t) - 0.6 |R_long| (1 - S(t))                            (SRP31.91(4), SRP31.92)
 *   EVE(shock) = sum_k CF_k * exp(-(z(t_k) + shock(t_k)) t_k) over the net notional repricing cash flows slotted into
 *   the 19 buckets of Table 3 (SRP31.96); delta EVE = EVE(shock) - EVE(base); the risk measure is the largest loss over
 *   the six scenarios; the outlier test compares it with 15% of Tier 1 (SRP31.82).
 *
 * Simplifications (listed in every run): notional repricing cash flows are given, not derived; no non-maturity-deposit
 * behavioural model, no prepayment or early-redemption scalars (SRP31.119, 31.125), no automatic-option add-on (SRP31.127);
 * discounting at the risk-free zero curve supplied (no commercial margin); one currency per run; NII is a 12-month,
 * constant-balance-sheet repricing-gap estimate (parallel up/down only).
 */
import { SimError, need, isNum } from "./errors.js";
import { toMinor, roundMinor, fromMinor, sum, BP, BPN } from "./money.js";
import { zeroRate } from "./curve.js";
import { LIMITS } from "./limits.js";

export const EVE_SCENARIOS = Object.freeze(["parallel-up", "parallel-down", "steepener", "flattener", "short-up", "short-down"]);

/** Shock (decimal) at maturity t for a scenario and currency under parameters P (kit.sim-irrbb-params.v1). */
export function shockAt(P, currency, scenario, t) {
  const c = Object.hasOwn(P.shocksBp.currencies, currency) ? P.shocksBp.currencies[currency] : undefined;
  if (!c) throw new SimError("unknown-currency", `no prescribed shock sizes for ${currency} in ${P.id}`, "currency");
  const S = Math.exp(-t / P.shapingDecayYears.value);
  const bp = (x) => x / BP;
  switch (scenario) {
    case "parallel-up": return bp(c.parallel);
    case "parallel-down": return -bp(c.parallel);
    case "short-up": return bp(c.short) * S;
    case "short-down": return -bp(c.short) * S;
    case "steepener": return P.rotation.steepener.shortCoefficient * bp(Math.abs(c.short)) * S + P.rotation.steepener.longCoefficient * bp(Math.abs(c.long)) * (1 - S);
    case "flattener": return P.rotation.flattener.shortCoefficient * bp(Math.abs(c.short)) * S + P.rotation.flattener.longCoefficient * bp(Math.abs(c.long)) * (1 - S);
    default: throw new SimError("unknown-scenario", `scenario is one of ${EVE_SCENARIOS.join(", ")}`, "scenario");
  }
}

/** Optional post-shock floor (SRP31.93: not greater than zero): min(0, start + perYear * t), in bp. */
function floorAt(floor, t) {
  return floor ? Math.min(0, (floor.startBp + floor.perYearBp * t) / BP) : -Infinity;
}

/**
 * The post-shock rate under an optional floor. SRP31.93 lets a supervisor floor the post-shock rates; a floor limits how far a
 * shock can push a rate down, it does not lift a rate that was already below the floor before the shock (that would turn a
 * down shock into a rise). So the floor that applies at a maturity is min(z, floor(t)).
 */
function shocked(z, shock, floor, t) {
  return Math.max(z + shock, Math.min(z, floorAt(floor, t)));
}

export function checkFloor(floor) {
  if (floor === undefined || floor === null) return null;
  need(isNum(floor.startBp) && floor.startBp <= 0 && floor.startBp >= -1000, "floor-out-of-range", "floor.startBp must be in [-1000, 0] (SRP31.93: a floor may not be greater than zero)", "floor/startBp");
  need(isNum(floor.perYearBp) && floor.perYearBp >= 0 && floor.perYearBp <= 100, "floor-out-of-range", "floor.perYearBp must be in [0, 100]", "floor/perYearBp");
  return floor;
}

export function bucketIndex(P, years) {
  const items = P.buckets.items;
  for (let i = 0; i < items.length; i++) if (items[i].upperYears === null || years <= items[i].upperYears + 1e-12) return i;
  return items.length - 1;
}

export function checkLadder(ladder, path = "ladder") {
  need(ladder && Array.isArray(ladder.items) && ladder.items.length >= 1 && ladder.items.length <= LIMITS.maxLadderItems, "bad-ladder", `a ladder has 1 to ${LIMITS.maxLadderItems} items`, path);
  need(Number.isInteger(ladder.minorExponent) && ladder.minorExponent >= 0 && ladder.minorExponent <= 6, "bad-ladder", "minorExponent is an integer 0..6", `${path}/minorExponent`);
  return ladder.items.map((it, i) => {
    need(["asset", "liability"].includes(it.kind), "bad-ladder", "kind is asset or liability", `${path}/items/${i}/kind`);
    need(isNum(it.repricingYears) && it.repricingYears >= 0 && it.repricingYears <= 100, "bad-ladder", "repricingYears is a number in [0, 100]", `${path}/items/${i}/repricingYears`);
    const amt = toMinor(it.amount, `${path}/items/${i}/amount`);
    need(amt >= 0n, "bad-ladder", "an amount is not negative (the kind carries the sign)", `${path}/items/${i}/amount`);
    return { ...it, signed: it.kind === "asset" ? amt : -amt };
  });
}

/**
 * @param {object} P irrbb parameters
 * @param {{currency:string, curve:object, ladder:object, floor?:object, tier1?:string|number}} a curve = built zero curve (curve.js)
 */
export function runIrrbb(P, { currency, curve, ladder, floor, tier1 }) {
  const items = checkLadder(ladder);
  const fl = checkFloor(floor);
  const e = ladder.minorExponent;
  const net = new Array(P.buckets.items.length).fill(0n);
  items.forEach((it) => { net[bucketIndex(P, it.repricingYears)] += it.signed; });
  const slots = P.buckets.items.map((b, k) => ({ k, id: b.id, t: b.midpointYears, net: net[k] })).filter((s) => s.net !== 0n);
  const pv = (scenario) => slots.reduce((acc, s) => {
    const z = zeroRate(curve, s.t);
    const sh = scenario ? shocked(z, shockAt(P, currency, scenario, s.t), fl, s.t) - z : 0;
    return acc + (Number(s.net) / 10 ** e) * Math.exp(-(z + sh) * s.t);
  }, 0);
  const base = pv(null);
  const scenarios = EVE_SCENARIOS.map((id) => {
    const eve = pv(id);
    const delta = roundMinor((eve - base) * 10 ** e);
    return { id, eve: fromMinor(roundMinor(eve * 10 ** e)), deltaEve: fromMinor(delta), loss: fromMinor(delta < 0n ? -delta : 0n) };
  });
  const losses = scenarios.map((s) => BigInt(s.loss));
  const maxLoss = losses.reduce((a, b) => (b > a ? b : a), 0n);
  const worst = maxLoss > 0n ? scenarios[losses.indexOf(maxLoss)].id : null;
  const out = { currency, minorExponent: e, baseEve: fromMinor(roundMinor(base * 10 ** e)), scenarios, maxLoss: fromMinor(maxLoss), worstScenario: worst, slots: slots.map((s) => ({ bucket: s.id, midpointYears: s.t, net: fromMinor(s.net) })) };
  if (tier1 !== undefined) {
    const t1 = toMinor(tier1, "tier1");
    need(t1 > 0n, "bad-tier1", "tier1 must be a positive amount", "tier1");
    const thr = P.outlier.tier1ShareBp;
    out.outlierTest = { ref: P.outlier.ref, tier1: fromMinor(t1), thresholdBp: thr, maxLossBpOfTier1: Number((maxLoss * BPN * 1000n) / t1) / 1000, outlier: maxLoss * BPN > t1 * BigInt(thr) };
  }
  // NII: repricing-gap estimate over the horizon, constant balance sheet, parallel up/down only
  const h = P.nii.horizonYears;
  out.nii = P.nii.scenarios.map((id) => {
    let d = 0;
    for (const it of items) {
      if (it.repricingYears >= h) continue;
      const z = zeroRate(curve, it.repricingYears);
      const sh = shocked(z, shockAt(P, currency, id, it.repricingYears), fl, it.repricingYears) - z;
      d += (Number(it.signed) / 10 ** e) * sh * (h - it.repricingYears);
    }
    return { id, deltaNii: fromMinor(roundMinor(d * 10 ** e)) };
  });
  out.assetTotal = fromMinor(sum(items.filter((i) => i.kind === "asset").map((i) => i.signed)));
  out.liabilityTotal = fromMinor(-sum(items.filter((i) => i.kind === "liability").map((i) => i.signed)));
  return out;
}

/**
 * A synthetic banking-book repricing ladder from a seeded generator (SYNTHETIC; no real data). Every size and range is a
 * parameter, nothing is a default: items per side, total per side, longest repricing per side. Totals are exact
 * (largest-remainder allocation of integer minor units).
 */
export function generateLadder(rng, P, { minorExponent, assets, liabilities }) {
  need(Number.isInteger(minorExponent) && minorExponent >= 0 && minorExponent <= 6, "bad-ladder", "minorExponent is an integer 0..6", "minorExponent");
  const side = (kind, spec) => {
    need(spec && Number.isInteger(spec.count) && spec.count >= 1 && spec.count <= 500, "bad-generator", "count is an integer 1..500", `${kind}/count`);
    const total = toMinor(spec.total, `${kind}/total`);
    need(total > 0n, "bad-generator", "total must be > 0", `${kind}/total`);
    need(isNum(spec.maxRepricingYears) && spec.maxRepricingYears > 0 && spec.maxRepricingYears <= 100, "bad-generator", "maxRepricingYears is in (0, 100]", `${kind}/maxRepricingYears`);
    const allowed = P.buckets.items.filter((b) => b.midpointYears <= spec.maxRepricingYears || b === P.buckets.items[0]);
    // integer weights and BigInt arithmetic: the total is exact at any size; the remainder goes to the heaviest items first
    const w = Array.from({ length: spec.count }, () => BigInt(1000000 + rng.int(1000000)));
    const ws = sum(w);
    const base = w.map((x) => (total * x) / ws);
    let rem = total - sum(base);
    const order = w.map((x, i) => i).sort((a, b) => (w[b] > w[a] ? 1 : w[b] < w[a] ? -1 : a - b));
    for (let i = 0; rem > 0n; i = (i + 1) % order.length) { base[order[i]] += 1n; rem -= 1n; }
    return base.map((amt, i) => ({ id: `${kind}-${i + 1}`, kind, amount: fromMinor(amt), repricingYears: allowed[rng.int(allowed.length)].midpointYears }));
  };
  return { schema: "kit.cashflow-ladder.v1", minorExponent, items: [...side("asset", assets), ...side("liability", liabilities)] };
}
