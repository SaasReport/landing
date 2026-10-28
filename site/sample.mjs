// A made-up account for the landing page widgets. Deterministic, integer-only, validated by the engine's own input checks.
// None of it is real; the page labels it as sample data everywhere it is shown.
import { daysFromCivil, assertSnapshot, assertPaymentInputs } from "../vendor/core/src/index.js";

const DAY = 86400;
const at = (y, m, d) => daysFromCivil(y, m, d) * DAY;
const PRICES = [2900, 9900, 29900, 99900];
const sub = (i, price, currency) => ({ id: `s${i}`, customer: `c${i}`, currency, status: "active", items: [{ unit_amount: price, quantity: 1, interval: "month", interval_count: 1 }] });
const cur = (i) => (i > 34 ? "eur" : "usd");

// Customers 1-30 exist at the start of the earlier month; the rest of each list follows from the rules below.
const tier = (i) => PRICES[i % 4];
const A = Array.from({ length: 30 }, (_, k) => sub(k + 1, tier(k + 1), cur(k + 1)));
const B = [...A.filter((s) => Number(s.customer.slice(1)) % 10 !== 0).map((s) => { const i = Number(s.customer.slice(1)); return i % 7 === 0 ? sub(i, PRICES[Math.min(3, (i + 1) % 4 + 1)], cur(i)) : s; }),
  ...Array.from({ length: 6 }, (_, k) => sub(31 + k, tier(31 + k), cur(31 + k)))];
const C = [...B.filter((s) => Number(s.customer.slice(1)) % 6 !== 0).map((s) => { const i = Number(s.customer.slice(1)); const p = s.items[0].unit_amount; return i % 11 === 0 ? sub(i, Math.max(2900, p - 7000), cur(i)) : i % 13 === 0 ? sub(i, p + 20000, cur(i)) : s; }),
  ...Array.from({ length: 3 }, (_, k) => sub(37 + k, tier(37 + k + 1), cur(37 + k)))];

function payments(subs, window, failEvery, refundEvery, feePct) {
  const charges = [], refunds = [], disputes = [], application_fees = [];
  subs.forEach((s, k) => {
    const id = s.id, amount = s.items[0].unit_amount, created = window.from + (k + 1) * 3600;
    const failed = (k + 1) % failEvery === 0;
    charges.push({ id: `ch_${id}`, customer: s.customer, currency: s.currency, amount, status: failed ? "failed" : "succeeded", created, failure_code: failed ? "card_declined" : null });
    if (failed) return;
    application_fees.push({ id: `fee_${id}`, currency: s.currency, amount: Math.trunc((amount * feePct) / 100), created });
    if ((k + 1) % refundEvery === 0) refunds.push({ id: `re_${id}`, charge: `ch_${id}`, currency: s.currency, amount, status: "succeeded", reason: ["requested_by_customer", "duplicate", "fraudulent"][(k + 1) % 3], created: created + 7200 });
    if ((k + 1) % 15 === 0) disputes.push({ id: `dp_${id}`, charge: `ch_${id}`, currency: s.currency, amount, reason: "fraudulent", status: "needs_response", created: created + 14400 });
  });
  return { charges, refunds, disputes, application_fees };
}

const earlier = { from: at(2026, 8, 1), to: at(2026, 9, 1) }, later = { from: at(2026, 9, 1), to: at(2026, 10, 1) };
export const sample = {
  note: "Made-up data for illustration. Not a customer, not a benchmark.",
  history: ["c61", "c62"],
  periods: {
    earlier: { start: A, end: B, history: ["c61", "c62"], window: earlier, ...payments(B, earlier, 17, 8, 10) },
    later: { start: B, end: C, history: ["c61", "c62"], window: later, ...payments(C, later, 9, 6, 8) }
  },
  labels: { earlier: "the earlier sample month", later: "the sample month" }
};
for (const p of Object.values(sample.periods)) { for (const s of [...p.start, ...p.end]) assertSnapshot(s); assertPaymentInputs(p); }
