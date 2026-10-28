// MRR movements between two snapshot sets, per currency and per customer. Pure and deterministic:
// the same inputs give the same integers, in any order of the input arrays.
import { subscriptionMrr, assertSnapshot } from "./snapshot.js";

function mrrByCustomer(subs, label) {
  const out = new Map();
  const seen = new Set();
  for (const s of subs) {
    assertSnapshot(s, label);
    if (seen.has(s.id)) throw new TypeError(`${label}: duplicate subscription id ${s.id}`);
    seen.add(s.id);
    const key = `${s.currency}\u0000${s.customer}`;
    out.set(key, (out.get(key) ?? 0) + subscriptionMrr(s));
  }
  return out;
}

/**
 * @param {{start: object[], end: object[], history?: string[]}} ctx
 *   start, end: subscription snapshots at the period start and end.
 *   history: customer ids with recurring revenue before the period start, so a returning customer is a
 *   reactivation and not "new". Customers in neither set are new.
 * @returns {Record<string, object>} one entry per currency, keys sorted
 */
export function movementsByCurrency({ start, end, history = [] }) {
  const a = mrrByCustomer(start, "start");
  const b = mrrByCustomer(end, "end");
  const before = new Set(history);
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  const out = {};
  for (const key of keys) {
    const [currency, customer] = key.split("\u0000");
    const m = (out[currency] ??= { start_mrr: 0, end_mrr: 0, new_mrr: 0, reactivation_mrr: 0, expansion_mrr: 0, contraction_mrr: 0, churned_mrr: 0, customers_start: 0, customers_end: 0, churned_customers: 0, new_customers: 0 });
    const x = a.get(key) ?? 0, y = b.get(key) ?? 0;
    m.start_mrr += x; m.end_mrr += y;
    if (x > 0) m.customers_start += 1;
    if (y > 0) m.customers_end += 1;
    if (x === 0 && y > 0) { m[before.has(customer) ? "reactivation_mrr" : "new_mrr"] += y; if (!before.has(customer)) m.new_customers += 1; }
    else if (x > 0 && y === 0) { m.churned_mrr += x; m.churned_customers += 1; }
    else if (x > 0 && y > x) m.expansion_mrr += y - x;
    else if (x > 0 && y < x) m.contraction_mrr += x - y;
  }
  return Object.fromEntries(Object.keys(out).sort().map((c) => [c, out[c]]));
}
