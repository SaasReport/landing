// Every metric of registry/metrics.json is one pure function here, named by its `computation` field.
// Each takes {start, end, history, window, charges, refunds, disputes, application_fees} and returns {[currency]: integer | null}. null means undefined (zero denominator).
import { movementsByCurrency } from "./movements.js";
import { roundDiv, ratioBp, mulDiv } from "../money.js";
import { paymentsByCurrency, rates } from "./payments.js";

const per = (ctx, fn) => Object.fromEntries(Object.entries(movementsByCurrency(ctx)).map(([c, m]) => [c, fn(m)]));
const field = (name) => (ctx) => per(ctx, (m) => m[name]);
const pay = (ctx, fn) => Object.fromEntries(Object.entries(paymentsByCurrency(ctx)).map(([c, s]) => [c, fn(s)]));
const payField = (name) => (ctx) => pay(ctx, (s) => s[name]);
const reason = (r) => (ctx) => pay(ctx, (s) => s.refund_reasons[r]);

export const COMPUTATIONS = Object.freeze({
  mrr: field("end_mrr"),
  arr: (ctx) => per(ctx, (m) => mulDiv([m.end_mrr, 12])),
  new_mrr: field("new_mrr"),
  reactivation_mrr: field("reactivation_mrr"),
  expansion_mrr: field("expansion_mrr"),
  contraction_mrr: field("contraction_mrr"),
  churned_mrr: field("churned_mrr"),
  net_new_mrr: (ctx) => per(ctx, (m) => m.new_mrr + m.reactivation_mrr + m.expansion_mrr - m.contraction_mrr - m.churned_mrr),
  nrr: (ctx) => per(ctx, (m) => ratioBp(m.start_mrr + m.expansion_mrr - m.contraction_mrr - m.churned_mrr, m.start_mrr)),
  grr: (ctx) => per(ctx, (m) => ratioBp(m.start_mrr - m.contraction_mrr - m.churned_mrr, m.start_mrr)),
  logo_churn_rate: (ctx) => per(ctx, (m) => ratioBp(m.churned_customers, m.customers_start)),
  new_customers: field("new_customers"),
  gross_volume: payField("gross_volume"),
  successful_payments: payField("successful_payments"),
  failed_payments: payField("failed_payments"),
  payment_failure_rate_bp: (ctx) => pay(ctx, rates.failure),
  average_order_value: (ctx) => pay(ctx, rates.aov),
  refund_amount: payField("refund_amount"),
  refund_count: payField("refund_count"),
  refund_rate_bp: (ctx) => pay(ctx, rates.refund),
  refund_count_requested_by_customer: reason("requested_by_customer"),
  refund_count_duplicate: reason("duplicate"),
  refund_count_fraudulent: reason("fraudulent"),
  net_volume: (ctx) => pay(ctx, (s) => s.gross_volume - s.refund_amount),
  dispute_count: payField("dispute_count"),
  dispute_amount: payField("dispute_amount"),
  dispute_rate_bp: (ctx) => pay(ctx, rates.dispute),
  platform_fees: payField("platform_fees"),
  take_rate_bp: (ctx) => pay(ctx, rates.take),
  arpa: (ctx) => per(ctx, (m) => (m.customers_end === 0 ? null : roundDiv(m.end_mrr, m.customers_end))),
});
