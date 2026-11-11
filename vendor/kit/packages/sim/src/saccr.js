/**
 * SA-CCR: exposure at default of one netting set. Standard: Basel Framework CRE52 (BCBS 279, "The standardised approach for
 * measuring counterparty credit risk exposures", March 2014, rev. April 2014); worked examples CRE99 (BCBS 279 Annex 4).
 *
 *   EAD = alpha (RC + PFE), alpha = 1.4                                                                       CRE52.1
 *   RC  = max(V - C, 0) unmargined; max(V - C, TH + MTA - NICA, 0) margined                                   CRE52.10, 52.18
 *   PFE = multiplier x AddOn(aggregate);  multiplier = min(1, F + (1 - F) exp((V - C) / (2 (1 - F) AddOn))), F = 5%   CRE52.20, 52.23
 *   AddOn(aggregate) = sum over asset classes                                                                 CRE52.25
 *   trade effective notional D = d x MF x delta                                                               CRE52.30
 *     d: IR and credit notional x SD, SD = (e^(-0.05 S) - e^(-0.05 E)) / 0.05 floored at 10 business days      CRE52.34
 *        FX foreign leg notional; equity and commodity price x units                                         CRE52.35, 52.36
 *     MF unmargined sqrt(min(M, 1 year)), M floored at 10 business days; margined 3/2 sqrt(MPOR / 1 year)        CRE52.48, 52.52
 *     delta +1 long, -1 short; options: Black-Scholes delta with supervisory volatility, no rate                CRE52.39, 52.40
 *   asset-class add-ons: IR buckets (<1y, 1-5y, >5y) with 1.4 / 0.6 cross terms; FX |sum D| x SF; credit, equity entity
 *   add-ons with single systematic factor; commodity hedging sets with 40% correlation                        CRE52.57 to 52.70
 *   a margined netting set's EAD is capped at the EAD of the same set calculated unmargined                   CRE52.2
 * All parameters are data (data/saccr-supervisory.json) with their paragraphs. Unsupported (REFUSED, never approximated):
 * CDO tranches (CRE52.41), a doubled MPOR for disputes or large sets (CRE52.50), multiple margin agreements in a netting set
 * (CRE52.74), basis and volatility hedging sets outside interest rate and FX, and the alternative IR formula without
 * offsets between maturity buckets (CRE52.57 step 5, second formula).
 */
import { SimError, need, isNum } from "./errors.js";
import { toMinor, roundMinor, fromMinor, sum, max0, BP } from "./money.js";
import { canonicalJson } from "./util.js";
import { normalCdf } from "./normal.js";

const T = "saccr-supervisory";
export const SACCR_CLASSES = Object.freeze(["ir", "fx", "credit", "equity", "commodity"]);
export const CREDIT_RATINGS = Object.freeze(["AAA", "AA", "A", "BBB", "BB", "B", "CCC"]);
export const COMMODITY_SETS = Object.freeze(["energy", "metals", "agricultural", "other"]);
export const SACCR_LIMITS = Object.freeze({ maxTrades: 100000, maxYears: 100 });

/** Supervisory delta of a trade (CRE52.39 and CRE52.40). */
export function supervisoryDelta(trade, vol, path) {
  if (!trade.option) {
    need(trade.position === "long" || trade.position === "short", "bad-trade", "position is long or short in the primary risk factor", `${path}/position`);
    return trade.position === "long" ? 1 : -1;
  }
  need(trade.position === undefined, "conflicting-direction", "an option trade has one source of direction, option.kind and option.position (bought or sold call or put); a position beside it is refused (CRE52.40)", `${path}/position`);
  const o = trade.option;
  need(["call", "put"].includes(o.kind) && ["bought", "sold"].includes(o.position), "bad-trade", "option.kind is call or put, option.position bought or sold", `${path}/option`);
  need(isNum(o.expiryYears) && o.expiryYears > 0 && o.expiryYears <= SACCR_LIMITS.maxYears, "bad-trade", "option.expiryYears is in (0, 100]", `${path}/option/expiryYears`);
  const shift = o.shift ?? 0;
  need(isNum(shift) && shift >= 0, "bad-trade", "option.shift (lambda for negative rates) is >= 0", `${path}/option/shift`);
  const P = o.underlying + shift, K = o.strike + shift;
  need(isNum(P) && isNum(K) && P > 0 && K > 0, "option-needs-shift", "the underlying and strike must be positive after the shift lambda (CRE52.40 FAQ2); supply option.shift for negative rates", `${path}/option`);
  const d1 = (Math.log(P / K) + 0.5 * vol * vol * o.expiryYears) / (vol * Math.sqrt(o.expiryYears));
  const call = o.kind === "call";
  const base = call ? normalCdf(d1) : normalCdf(-d1);
  const bought = o.position === "bought";
  return call ? (bought ? base : -base) : (bought ? -base : base);
}

function checkTrade(t, i) {
  const p = `trades/${i}`;
  need(t && typeof t === "object", "bad-trade", "a trade is an object", p);
  need(SACCR_CLASSES.includes(t.assetClass), "bad-trade", `assetClass is one of ${SACCR_CLASSES.join(", ")}`, `${p}/assetClass`);
  need(isNum(t.maturityYears) && t.maturityYears >= 0 && t.maturityYears <= SACCR_LIMITS.maxYears, "bad-trade", "maturityYears is in [0, 100]", `${p}/maturityYears`);
  need(!(t.basis && t.volatility), "bad-trade", "a trade cannot be both a basis and a volatility transaction", p);
  if (t.basis || t.volatility) need(["ir", "fx"].includes(t.assetClass), "unsupported", "basis and volatility hedging sets are supported for interest rate and FX only", p);
  if (t.assetClass === "ir" || t.assetClass === "credit") {
    need(isNum(t.startYears) && t.startYears >= 0 && isNum(t.endYears) && t.endYears > t.startYears && t.endYears <= SACCR_LIMITS.maxYears, "bad-trade", "startYears >= 0 and endYears > startYears (<= 100); an ongoing trade has startYears 0", p);
  }
  need(!t.cdoTranche, "unsupported", "CDO tranches are not supported (CRE52.41); refused", p);
  return t;
}

/**
 * @param {object} TB tables (tables.js buildTables)
 * @param {object} input see the sim-scenario schema, saccr inputs
 */
export function runSaccr(TB, input) {
  const v = (id) => TB.value(T, id);
  const e = input.minorExponent;
  need(Number.isInteger(e) && e >= 0 && e <= 6, "bad-input", "minorExponent is an integer 0..6", "minorExponent");
  need(Array.isArray(input.trades) && input.trades.length >= 1 && input.trades.length <= SACCR_LIMITS.maxTrades, "bad-input", `a netting set has 1 to ${SACCR_LIMITS.maxTrades} trades`, "trades");
  const scale = 10 ** e;
  const maxSingle = BigInt(Number.MAX_SAFE_INTEGER);
  const bdy = v("business-days-per-year"), floorY = v("floor-days") / bdy;
  // canonical order: the same set of trades gives the same floating-point sums and the same output whatever order it arrives in
  const trades = input.trades.map(checkTrade).sort((a, b) => { const x = canonicalJson(a), y = canonicalJson(b); return x < y ? -1 : x > y ? 1 : 0; });
  const Vm = sum(trades.map((t, i) => toMinor(t.mtm ?? 0, `trades/${i}/mtm`)));
  const Cm = toMinor(input.collateral ?? 0, "collateral");
  const margin = input.margin;
  let mpor = null, mu = null;
  if (margin) {
    for (const flag of ["illiquidCollateral", "hardToReplaceTrades", "recentDisputes"]) need(!margin[flag], "unsupported", `the margin period of risk is doubled when ${flag} (CRE52.50); doubling is not implemented and a number would be wrong, so the run is refused (doubled MPOR)`, `margin/${flag}`);
    need(trades.length <= v("max-trades-single-mpor"), "unsupported", `a margined netting set of more than ${v("max-trades-single-mpor")} trades has a doubled margin period of risk (CRE52.50); doubling is not implemented (doubled MPOR)`, "trades");
    mu = { th: toMinor(margin.threshold ?? 0, "margin/threshold"), mta: toMinor(margin.mta ?? 0, "margin/mta"), nica: toMinor(margin.nica ?? 0, "margin/nica") };
    need(mu.th >= 0n && mu.mta >= 0n, "bad-input", "threshold and minimum transfer amount are not negative", "margin");
    const N = margin.remarginingDays ?? 1;
    need(Number.isInteger(N) && N >= 1 && N <= 20, "bad-input", "remarginingDays is an integer 1..20", "margin/remarginingDays");
    if (margin.cleared) {
      need(N === 1, "unsupported", "a centrally cleared netting set must re-margin daily (the standard's MPOR for other cases is not implemented)", "margin/remarginingDays");
      mpor = v("mpor-cleared");
    } else mpor = N === 1 ? v("mpor-daily-bilateral") : v("mpor-base-nondaily") + N;
  }
  const mfOf = (M, marg) => (marg ? (v("margined-mf-multiplier") / BP) * Math.sqrt(mpor / bdy) : Math.sqrt(Math.min(Math.max(M, floorY), 1)));
  const sdRate = v("sd-rate") / BP;

  const compute = (marg) => {
    const rows = trades.map((t, i) => {
      const p = `trades/${i}`;
      const nm = toMinor(t.notional, `${p}/notional`);
      need(nm <= maxSingle, "too-large", "a trade notional above 2^53 minor units cannot be held exactly in the floating-point maths of the add-ons; refused", `${p}/notional`);
      const notional = Number(nm) / scale;
      need(notional >= 0, "bad-trade", "notional is not negative (the position carries the sign)", `${p}/notional`);
      let vol, sf = null;
      if (t.assetClass === "ir") vol = v("vol-ir") / BP;
      else if (t.assetClass === "fx") vol = v("vol-fx") / BP;
      else if (t.assetClass === "credit") {
        const idx = t.subclass === "index-IG" || t.subclass === "index-SG";
        need(idx || CREDIT_RATINGS.includes(t.subclass), "bad-trade", `credit subclass is a rating (${CREDIT_RATINGS.join(", ")}) or index-IG / index-SG`, `${p}/subclass`);
        vol = v(idx ? "vol-credit-index" : "vol-credit-single") / BP;
        sf = v(idx ? `sf-credit-${t.subclass.toLowerCase()}` : `sf-credit-${t.subclass.toLowerCase()}`) / BP;
      } else if (t.assetClass === "equity") {
        need(["single", "index"].includes(t.subclass), "bad-trade", "equity subclass is single or index", `${p}/subclass`);
        vol = v(`vol-equity-${t.subclass}`) / BP;
        sf = v(`sf-equity-${t.subclass}`) / BP;
      } else {
        need(COMMODITY_SETS.includes(t.hedgingSet), "bad-trade", `commodity hedgingSet is one of ${COMMODITY_SETS.join(", ")}`, `${p}/hedgingSet`);
        const el = t.subclass === "electricity";
        vol = v(el ? "vol-commodity-electricity" : "vol-commodity-other") / BP;
        sf = v(el ? "sf-commodity-electricity" : "sf-commodity-other") / BP;
      }
      let d = notional;
      if (t.assetClass === "ir" || t.assetClass === "credit") {
        const sd = Math.max((Math.exp(-sdRate * t.startYears) - Math.exp(-sdRate * t.endYears)) / sdRate, floorY);
        d = notional * sd;
      }
      const delta = supervisoryDelta(t, vol, p);
      const mf = mfOf(t.maturityYears, marg);
      return { t, i, d, mf, delta, D: d * mf * delta, sf };
    });
    const by = (f) => rows.filter((r) => f(r.t));
    const need2 = (k, msg, path) => need(k, "bad-trade", msg, path);
    // interest rate
    const irSets = new Map();
    for (const r of by((t) => t.assetClass === "ir")) {
      need2(typeof r.t.currency === "string" && r.t.currency, "ir trades name their currency (the hedging set)", `trades/${r.i}/currency`);
      const key = `${r.t.currency}${r.t.basis ? ":basis" : ""}${r.t.volatility ? ":volatility" : ""}`;
      const s = irSets.get(key) ?? { D: [0, 0, 0], mult: r.t.basis ? v("basis-multiplier") / BP : r.t.volatility ? v("volatility-multiplier") / BP : 1 };
      const b = r.t.endYears < 1 ? 0 : r.t.endYears <= 5 ? 1 : 2;
      s.D[b] += r.D;
      irSets.set(key, s);
    }
    const c12 = 2 * v("ir-bucket-corr-adjacent") / BP, c13 = 2 * v("ir-bucket-corr-far") / BP;
    const ir = [...irSets.entries()].map(([key, s]) => {
      const [a, b, c] = s.D;
      const en = Math.sqrt(Math.max(a * a + b * b + c * c + c12 * a * b + c12 * b * c + c13 * a * c, 0));
      return { hedgingSet: key, buckets: s.D, effectiveNotional: en, addOn: (v("sf-ir") / BP) * s.mult * en };
    });
    // foreign exchange
    const fxSets = new Map();
    for (const r of by((t) => t.assetClass === "fx")) {
      need2(typeof r.t.currencyPair === "string" && r.t.currencyPair, "fx trades name their currency pair (the hedging set)", `trades/${r.i}/currencyPair`);
      const key = `${r.t.currencyPair}${r.t.basis ? ":basis" : ""}${r.t.volatility ? ":volatility" : ""}`;
      const s = fxSets.get(key) ?? { D: 0, mult: r.t.basis ? v("basis-multiplier") / BP : r.t.volatility ? v("volatility-multiplier") / BP : 1 };
      s.D += r.D;
      fxSets.set(key, s);
    }
    const fx = [...fxSets.entries()].map(([key, s]) => ({ hedgingSet: key, effectiveNotional: s.D, addOn: (v("sf-fx") / BP) * s.mult * Math.abs(s.D) }));
    // credit and equity: entity add-ons, one systematic factor
    const entityAddOn = (cls, corrOf) => {
      const ents = new Map();
      for (const r of by((t) => t.assetClass === cls)) {
        need2(typeof r.t.referenceId === "string" && r.t.referenceId, `${cls} trades name their reference entity`, `trades/${r.i}/referenceId`);
        const e2 = ents.get(r.t.referenceId) ?? { D: 0, sf: r.sf, rho: corrOf(r.t) };
        need2(e2.sf === r.sf, `reference entity ${r.t.referenceId} appears with different supervisory factors`, `trades/${r.i}`);
        e2.D += r.D;
        ents.set(r.t.referenceId, e2);
      }
      const list = [...ents.entries()].map(([id, x]) => ({ entity: id, effectiveNotional: x.D, addOn: x.sf * x.D, rho: x.rho }));
      const sys = list.reduce((s, x) => s + x.rho * x.addOn, 0), idio = list.reduce((s, x) => s + (1 - x.rho * x.rho) * x.addOn * x.addOn, 0);
      return { entities: list, addOn: list.length ? Math.sqrt(sys * sys + idio) : 0, systematic: sys * sys, idiosyncratic: idio };
    };
    const credit = entityAddOn("credit", (t) => v(t.subclass.startsWith("index") ? "corr-credit-index" : "corr-credit-single") / BP);
    const equity = entityAddOn("equity", (t) => v(`corr-equity-${t.subclass}`) / BP);
    // commodity: hedging sets of commodity types
    const hs = new Map();
    for (const r of by((t) => t.assetClass === "commodity")) {
      need2(typeof r.t.referenceId === "string" && r.t.referenceId, "commodity trades name their commodity type", `trades/${r.i}/referenceId`);
      const set = hs.get(r.t.hedgingSet) ?? new Map();
      const ct = set.get(r.t.referenceId) ?? { D: 0, sf: r.sf };
      ct.D += r.D;
      set.set(r.t.referenceId, ct);
      hs.set(r.t.hedgingSet, set);
    }
    const rho = v("corr-commodity") / BP;
    const commodity = [...hs.entries()].map(([name, set]) => {
      const a = [...set.values()].map((x) => x.sf * x.D);
      const s = a.reduce((x, y) => x + y, 0), q = a.reduce((x, y) => x + y * y, 0);
      return { hedgingSet: name, types: [...set.keys()], addOn: Math.sqrt(rho * rho * s * s + (1 - rho * rho) * q) };
    });
    const addOn = { ir: ir.reduce((s, x) => s + x.addOn, 0), fx: fx.reduce((s, x) => s + x.addOn, 0), credit: credit.addOn, equity: equity.addOn, commodity: commodity.reduce((s, x) => s + x.addOn, 0) };
    addOn.aggregate = addOn.ir + addOn.fx + addOn.credit + addOn.equity + addOn.commodity;
    return { rows, ir, fx, credit, equity, commodity, addOn };
  };

  const alpha = v("alpha") / BP, floor = v("multiplier-floor") / BP;
  const finish = (marg) => {
    const c = compute(marg);
    const VC = Vm - Cm;
    let rc = max0(VC);
    if (marg) { const alt = mu.th + mu.mta - mu.nica; if (alt > rc) rc = alt; }
    const addOnMinor = c.addOn.aggregate * scale;
    const vc = Number(VC) / scale;
    const multiplier = c.addOn.aggregate === 0 || vc >= 0 ? 1 : Math.min(1, floor + (1 - floor) * Math.exp(vc / (2 * (1 - floor) * c.addOn.aggregate)));
    const pfe = multiplier * addOnMinor;
    const ead = alpha * (Number(rc) + pfe);
    return { c, rc, multiplier, pfe, ead, addOnMinor };
  };
  const main = finish(!!margin);
  let eadOut = main.ead, capped = false, unmargEad = null;
  if (margin) {
    const u = finish(false);
    unmargEad = u.ead;
    if (u.ead < main.ead) { eadOut = u.ead; capped = true; }
  }
  const mo = (x) => fromMinor(roundMinor(x));
  const c = main.c;
  return {
    minorExponent: e, margined: !!margin, mporDays: mpor,
    v: fromMinor(Vm), c: fromMinor(Cm),
    replacementCost: fromMinor(main.rc), multiplier: main.multiplier,
    addOn: { ir: mo(c.addOn.ir * scale), fx: mo(c.addOn.fx * scale), credit: mo(c.addOn.credit * scale), equity: mo(c.addOn.equity * scale), commodity: mo(c.addOn.commodity * scale), aggregate: mo(main.addOnMinor) },
    pfe: mo(main.pfe), alpha, ead: mo(eadOut),
    ...(margin ? { eadMargined: mo(main.ead), eadUnmargined: mo(unmargEad), cappedAtUnmargined: capped } : {}),
    trades: c.rows.map((r) => ({ id: r.t.id ?? `trade-${r.i + 1}`, assetClass: r.t.assetClass, adjustedNotional: r.d, maturityFactor: r.mf, delta: r.delta, effectiveNotional: r.D })),
    hedgingSets: { ir: c.ir, fx: c.fx, commodity: c.commodity },
    entities: { credit: c.credit.entities, equity: c.equity.entities },
    components: { creditSystematic: c.credit.systematic, creditIdiosyncratic: c.credit.idiosyncratic },
  };
}
export { SimError };
