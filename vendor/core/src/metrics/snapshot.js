// The input contract of the metric engine: a subscription snapshot (schemas/subscription-snapshot.schema.json).
// Ingestion turns Stripe objects into snapshots; the engine never sees a raw Stripe payload.
import { mulDiv } from "../money.js";

export const STATUSES = ["active", "past_due", "trialing", "paused", "incomplete", "incomplete_expired", "unpaid", "canceled"];
/** Statuses that count as recurring revenue (registry/metrics.json, rule of `mrr`). */
export const COUNTED_STATUSES = new Set(["active", "past_due"]);
export const INTERVALS = ["day", "week", "month", "year"];
// months per interval as a fraction: month 1/1, year 1/12, week 12/52 months => per-month factor is mult/den
const PER_MONTH = { month: [1, 1], year: [1, 12], week: [52, 12], day: [365, 12] };

const isCount = (x) => Number.isSafeInteger(x) && x >= 0;

export function assertSnapshot(s, where = "snapshot") {
  const bad = (m) => { throw new TypeError(`${where}: ${m}`); };
  if (!s || typeof s !== "object") bad("not an object");
  if (typeof s.id !== "string" || !s.id) bad("id must be a non-empty string");
  if (typeof s.customer !== "string" || !s.customer) bad("customer must be a non-empty string");
  if (typeof s.currency !== "string" || !/^[a-z]{3}$/.test(s.currency)) bad("currency must be a lower-case ISO 4217 code");
  if (!STATUSES.includes(s.status)) bad(`status ${JSON.stringify(s.status)} is not a Stripe subscription status`);
  if (!Array.isArray(s.items)) bad("items must be an array");
  for (const [i, it] of s.items.entries()) {
    if (!it || !isCount(it.unit_amount)) bad(`items[${i}].unit_amount must be a non-negative integer (minor units)`);
    if (!isCount(it.quantity)) bad(`items[${i}].quantity must be a non-negative integer`);
    if (!INTERVALS.includes(it.interval)) bad(`items[${i}].interval must be one of ${INTERVALS.join(", ")}`);
    if (!Number.isSafeInteger(it.interval_count) || it.interval_count < 1) bad(`items[${i}].interval_count must be an integer >= 1`);
  }
}

/** One item as whole minor units per month, rounded half-up. */
export function itemMonthly(it) {
  const [mult, den] = PER_MONTH[it.interval];
  return mulDiv([it.unit_amount, it.quantity, mult], [den, it.interval_count]);
}

/** MRR of one subscription in minor units: zero unless its status counts. */
export function subscriptionMrr(s) {
  assertSnapshot(s);
  if (!COUNTED_STATUSES.has(s.status)) return 0;
  return s.items.reduce((sum, it) => sum + itemMonthly(it), 0);
}
