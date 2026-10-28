// Payment-side figures for one period window, per currency: gross volume, failures, refunds, disputes.
// Records are filtered by `created` in [from, to). Pure and deterministic, like the subscription movements.
import { ratioBp, roundDiv } from "../money.js";

const REFUND_REASONS = ["requested_by_customer", "duplicate", "fraudulent"];
const isCount = (x) => Number.isSafeInteger(x) && x >= 0;

function check(list, label, statuses, extra) {
  if (!Array.isArray(list)) throw new TypeError(`${label}: must be an array`);
  const seen = new Set();
  for (const [i, r] of list.entries()) {
    const bad = (m) => { throw new TypeError(`${label}[${i}]: ${m}`); };
    if (!r || typeof r.id !== "string" || !r.id) bad("id must be a non-empty string");
    if (seen.has(r.id)) bad(`duplicate id ${r.id}`);
    seen.add(r.id);
    if (typeof r.currency !== "string" || !/^[a-z]{3}$/.test(r.currency)) bad("currency must be a lower-case ISO 4217 code");
    if (!isCount(r.amount)) bad("amount must be a non-negative integer (minor units)");
    if (!isCount(r.created)) bad("created must be integer epoch seconds");
    if (!statuses.includes(r.status)) bad(`status ${JSON.stringify(r.status)} is not valid`);
    if (extra) extra(r, bad);
  }
}

export function assertPaymentInputs({ window, charges = [], refunds = [], disputes = [], application_fees = [] }) {
  if (!window || !Number.isSafeInteger(window.from) || !Number.isSafeInteger(window.to) || window.to <= window.from) throw new TypeError("window must be {from, to} integer epoch seconds with to > from");
  check(charges, "charges", ["succeeded", "failed", "pending"]);
  check(refunds, "refunds", ["succeeded", "failed", "pending", "canceled"], (r, bad) => { if (r.reason != null && !REFUND_REASONS.includes(r.reason)) bad(`reason ${JSON.stringify(r.reason)} is not a Stripe refund reason`); });
  if (!Array.isArray(application_fees)) throw new TypeError("application_fees: must be an array");
  const seen = new Set();
  for (const [i, f] of application_fees.entries()) {
    const bad = (m) => { throw new TypeError(`application_fees[${i}]: ${m}`); };
    if (!f || typeof f.id !== "string" || !f.id) bad("id must be a non-empty string");
    if (seen.has(f.id)) bad(`duplicate id ${f.id}`);
    seen.add(f.id);
    if (typeof f.currency !== "string" || !/^[a-z]{3}$/.test(f.currency)) bad("currency must be a lower-case ISO 4217 code");
    if (!isCount(f.amount)) bad("amount must be a non-negative integer (minor units)");
    if (f.amount_refunded != null && (!isCount(f.amount_refunded) || f.amount_refunded > f.amount)) bad("amount_refunded must be an integer from 0 to amount");
    if (!isCount(f.created)) bad("created must be integer epoch seconds");
  }
  check(disputes, "disputes", ["warning_needs_response", "warning_under_review", "warning_closed", "needs_response", "under_review", "won", "lost"]);
}

export function paymentsByCurrency(input) {
  assertPaymentInputs(input);
  const { window, charges = [], refunds = [], disputes = [], application_fees = [] } = input;
  const inWindow = (r) => r.created >= window.from && r.created < window.to;
  const out = {};
  const slot = (c) => (out[c] ??= { gross_volume: 0, successful_payments: 0, failed_payments: 0, refund_amount: 0, refund_count: 0, refund_reasons: { requested_by_customer: 0, duplicate: 0, fraudulent: 0 }, dispute_count: 0, dispute_amount: 0, platform_fees: 0 });
  for (const c of charges.filter(inWindow)) {
    if (c.status === "succeeded") { slot(c.currency).gross_volume += c.amount; slot(c.currency).successful_payments += 1; }
    else if (c.status === "failed") slot(c.currency).failed_payments += 1;
  }
  for (const r of refunds.filter(inWindow)) {
    if (r.status !== "succeeded") continue;
    const s = slot(r.currency);
    s.refund_amount += r.amount; s.refund_count += 1;
    if (r.reason in s.refund_reasons) s.refund_reasons[r.reason] += 1;
  }
  for (const d of disputes.filter(inWindow)) { const s = slot(d.currency); s.dispute_count += 1; s.dispute_amount += d.amount; }
  for (const f of application_fees.filter(inWindow)) slot(f.currency).platform_fees += f.amount - (f.amount_refunded ?? 0);
  return Object.fromEntries(Object.keys(out).sort().map((c) => [c, out[c]]));
}

export const rates = {
  failure: (s) => ratioBp(s.failed_payments, s.failed_payments + s.successful_payments),
  refund: (s) => ratioBp(s.refund_amount, s.gross_volume),
  dispute: (s) => ratioBp(s.dispute_count, s.successful_payments),
  take: (s) => ratioBp(s.platform_fees, s.gross_volume),
  aov: (s) => (s.successful_payments === 0 ? null : roundDiv(s.gross_volume, s.successful_payments)),
};
