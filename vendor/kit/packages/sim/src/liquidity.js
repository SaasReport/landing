/**
 * LCR and NSFR from the Basel Framework tables (data/lcr-*.json, data/nsfr-*.json: every factor with its paragraph).
 *
 * LCR (LCR20, LCR30, LCR40; BCBS d238 2013, revised by d295 context): LCR = stock of HQLA / total net cash outflows over 30 days.
 *   stock = L1 + L2A + L2B - Adjustment15 - Adjustment40 (haircuts first)                                         LCR30.38
 *   Adjustment15 = max(L2B - 15/85 (L1 + L2A), L2B - 15/60 L1, 0)                                                 LCR30.39, 30.36
 *   Adjustment40 = max(L2A + L2B - Adjustment15 - 2/3 L1, 0)                                                      LCR30.39, 30.35
 *   (15/85, 15/60 and 2/3 are derived from the caps in the table: c2B / (1 - c2B), c2B / (1 - c2), c2 / (1 - c2))
 *   net outflows = outflows - min(inflows, 75% outflows)                                                          LCR40.77
 * NSFR (NSF20, NSF30; BCBS d295, October 2014): NSFR = available stable funding / required stable funding, ASF and RSF the
 *   balance-sheet items weighted by the ASF and RSF factors (NSF30.10 to NSF30.14, NSF30.25 to NSF30.32).
 * Amounts are integer minor units; weights are basis points applied exactly (half-even). The caller classifies each item with
 * the table's category id (the engine does not decide whether a deposit is stable or a counterparty operational): a category
 * that is not in the table is refused. Not modelled (listed in every run): unwinding of short-term secured transactions in the
 * HQLA adjustments (LCR30.37: the inputs must already be adjusted), the NSFR derivative add-on of 5 to 20% of gross derivative
 * liabilities and the encumbrance and residual-maturity rules (the caller assigns the RSF category), national-discretion items
 * (foreign currency retail run-off, other contingent obligations: a profile or the caller supplies a category and rate), and
 * currency-by-currency reporting.
 */
import { need } from "./errors.js";
import { toMinor, mulBp, divRound, fromMinor, sum, max0, BP, BPN } from "./money.js";

export const HQLA_CLASSES = { level1: "level1-haircut", level2a: "level2a-haircut", "level2b-rmbs": "level2b-rmbs-haircut", "level2b-other": "level2b-other-haircut" };

function items(list, path, table, TB, exclude = []) {
  need(Array.isArray(list), "bad-input", `${path} is a list`, path);
  return list.map((it, i) => {
    const p = `${path}/${i}`;
    need(it && typeof it.category === "string", "bad-input", "an item names its category", `${p}/category`);
    need(!exclude.includes(it.category) && TB.has(table, it.category), "unknown-category", `category "${it.category}" is not a factor of ${table}`, `${p}/category`);
    const a = toMinor(it.amount, `${p}/amount`);
    need(a >= 0n, "bad-input", "an amount is not negative", `${p}/amount`);
    const f = TB.get(table, it.category);
    return { id: it.id ?? `${path}-${i + 1}`, category: it.category, amount: a, factor: f.value, ref: f.ref, weighted: mulBp(a, f.value) };
  });
}

export function runLcr(TB, input) {
  const e = input.minorExponent;
  need(Number.isInteger(e) && e >= 0 && e <= 6, "bad-input", "minorExponent is an integer 0..6", "minorExponent");
  const H = "lcr-hqla";
  need(Array.isArray(input.hqla), "bad-input", "hqla is a list", "hqla");
  const hq = input.hqla.map((h, i) => {
    const hid = typeof h?.class === "string" && Object.hasOwn(HQLA_CLASSES, h.class) ? HQLA_CLASSES[h.class] : undefined;
    need(hid, "unknown-category", `HQLA class is one of ${Object.keys(HQLA_CLASSES).join(", ")}`, `hqla/${i}/class`);
    const a = toMinor(h.amount, `hqla/${i}/amount`);
    need(a >= 0n, "bad-input", "an amount is not negative", `hqla/${i}/amount`);
    const hc = TB.value(H, hid);
    return { id: h.id ?? `hqla-${i + 1}`, class: h.class, amount: a, haircut: hc, value: mulBp(a, BP - hc) };
  });
  const cls = (c) => sum(hq.filter((h) => h.class === c).map((h) => h.value));
  const L1 = cls("level1"), L2A = cls("level2a"), L2B = cls("level2b-rmbs") + cls("level2b-other");
  const c2 = TB.value(H, "level2-cap"), c2b = TB.value(H, "level2b-cap");
  const r = (x, num, den) => divRound(x * BigInt(num), BigInt(den));
  const a1 = max0((() => { const x = L2B - r(L1 + L2A, c2b, BP - c2b), y = L2B - r(L1, c2b, BP - c2); return x > y ? x : y; })());
  const a2 = max0(L2A + L2B - a1 - r(L1, c2, BP - c2));
  const stock = L1 + L2A + L2B - a1 - a2;
  const out = items(input.outflows ?? [], "outflows", "lcr-outflows", TB);
  const inn = items(input.inflows ?? [], "inflows", "lcr-inflows", TB, ["inflow-cap"]);
  const outTotal = sum(out.map((x) => x.weighted)), inTotal = sum(inn.map((x) => x.weighted));
  const cap = mulBp(outTotal, TB.value("lcr-inflows", "inflow-cap"));
  const inCounted = inTotal < cap ? inTotal : cap;
  const net = outTotal - inCounted;
  need(net > 0n, "no-net-outflows", "total net cash outflows are zero: the ratio is undefined", "outflows");
  const min = BigInt(TB.value(H, "minimum-ratio"));
  return {
    minorExponent: e,
    hqla: { level1: fromMinor(L1), level2a: fromMinor(L2A), level2b: fromMinor(L2B), adjustment15: fromMinor(a1), adjustment40: fromMinor(a2), stock: fromMinor(stock), items: hq.map((h) => ({ id: h.id, class: h.class, amount: fromMinor(h.amount), haircutBp: h.haircut, value: fromMinor(h.value) })) },
    outflows: { total: fromMinor(outTotal), items: out.map((x) => ({ id: x.id, category: x.category, amount: fromMinor(x.amount), factorBp: x.factor, ref: x.ref, weighted: fromMinor(x.weighted) })) },
    inflows: { total: fromMinor(inTotal), cap: fromMinor(cap), counted: fromMinor(inCounted), items: inn.map((x) => ({ id: x.id, category: x.category, amount: fromMinor(x.amount), factorBp: x.factor, ref: x.ref, weighted: fromMinor(x.weighted) })) },
    netOutflows: fromMinor(net),
    ratioBp: fromMinor(divRound(stock * BPN, net)),
    meetsMinimum: stock * BPN >= min * net,
    minimumBp: Number(min),
  };
}

export function runNsfr(TB, input) {
  const e = input.minorExponent;
  need(Number.isInteger(e) && e >= 0 && e <= 6, "bad-input", "minorExponent is an integer 0..6", "minorExponent");
  const asf = items(input.asf ?? [], "asf", "nsfr-asf", TB);
  const rsf = items(input.rsf ?? [], "rsf", "nsfr-rsf", TB, ["minimum-ratio"]);
  const A = sum(asf.map((x) => x.weighted)), R = sum(rsf.map((x) => x.weighted));
  need(R > 0n, "no-required-funding", "required stable funding is zero: the ratio is undefined", "rsf");
  const min = BigInt(TB.value("nsfr-rsf", "minimum-ratio"));
  const row = (x) => ({ id: x.id, category: x.category, amount: fromMinor(x.amount), factorBp: x.factor, ref: x.ref, weighted: fromMinor(x.weighted) });
  return { minorExponent: e, availableStableFunding: fromMinor(A), requiredStableFunding: fromMinor(R), ratioBp: fromMinor(divRound(A * BPN, R)), meetsMinimum: A * BPN >= min * R, minimumBp: Number(min), asf: asf.map(row), rsf: rsf.map(row) };
}
