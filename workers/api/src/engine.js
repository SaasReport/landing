// The core metric engine on the core SAMPLE dataset, for a Worker: pure functions of the bundled registries and sample
// files (no file system, no clock, no Node API). It mirrors vendor/core/adapters/widgets-engine.mjs `world()`, which reads
// files and is build-time only; the proposed kit/core change is to split that adapter into this pure part and its loader.
import { computeMetrics, evaluateFindings, formatValue, periodWindow, civilFromDays, daysFromCivil, planReport } from "../../../vendor/core/src/index.js";
import { registries, samples } from "./data.generated.js";

const pad = (n) => String(n).padStart(2, "0");
const iso = (epoch) => { const [y, m, d] = civilFromDays(Math.floor(epoch / 86400)); return `${y}-${pad(m)}-${pad(d)}`; };
const epochOf = (day) => { const [y, m, d] = day.split("-").map(Number); return daysFromCivil(y, m, d) * 86400; };

let memo = null;
/** The registries and the figures of the last complete month and the one before it, at the sample's own reference date. */
export function world() {
  if (memo) return memo;
  const R = { stakeholders: registries.stakeholders, metrics: registries.metrics, reportTypes: registries["report-types"], cadences: registries.cadences, findings: registries.findings, currencies: registries.currencies };
  const meta = samples.meta;
  const cur = periodWindow("month", epochOf(meta.reference_date));
  const prev = periodWindow("month", cur.from);
  const ctx = (w) => ({ start: samples[`subscriptions.${iso(w.from)}`], end: samples[`subscriptions.${iso(w.to)}`], history: meta.history, window: { from: w.from, to: w.to }, charges: samples.charges, refunds: samples.refunds, disputes: samples.disputes, application_fees: samples["application-fees"] });
  const ids = R.metrics.metrics.map((m) => m.id);
  memo = { R, meta, current: computeMetrics(ctx(cur), ids), prior: computeMetrics(ctx(prev), ids) };
  return memo;
}

/** What the sample dataset says it is (its meta file), carried by every sample response. */
export const sampleLabel = () => { const { label, description, currency, reference_date } = world().meta; return { label, description, currency, reference_date }; };

const metricOf = (W, id) => W.R.metrics.metrics.find((m) => m.id === id);
function figure(W, id) {
  const m = metricOf(W, id);
  const value = W.current[id]?.[W.meta.currency] ?? null;
  return { metric: id, name: m.name, unit: m.unit, value, display: formatValue({ currencies: W.R.currencies, unit: m.unit, currency: W.meta.currency, value }) };
}
function findingsFor(W, stakeholder) {
  return evaluateFindings({ findings: W.R.findings, currencies: W.R.currencies, metrics: W.R.metrics, current: W.current, prior: W.prior, stakeholder }).map((f) => ({
    rule: f.rule, severity: f.severity, headline: f.headline,
    evidence: f.evidence.map((e) => ({ metric: e.metric, name: e.name, current: e.text.current, prior: e.text.prior })),
    recommendation: f.recommendation?.text ?? null,
  }));
}

export const stakeholderIds = () => world().R.stakeholders.stakeholders.map((s) => s.id);

/** One stakeholder, or null when the registry has none. */
export function sampleStakeholder(id) {
  const W = world();
  const s = W.R.stakeholders.stakeholders.find((x) => x.id === id);
  if (!s) return null;
  return {
    sample: true, meta: sampleLabel(), stakeholder: s,
    figures: s.priority_metrics.map((m) => figure(W, m)),
    reports: W.R.reportTypes.report_types.filter((r) => r.stakeholders.includes(id)).map((r) => ({ id: r.id, name: r.name, cadences: r.cadences })),
    findings: findingsFor(W, id),
  };
}

/** Every finding that fires on the sample month, once per rule. */
export function sampleFindings() {
  const W = world();
  const seen = new Set();
  return { sample: true, meta: sampleLabel(), findings: findingsFor(W).filter((f) => !seen.has(f.rule) && seen.add(f.rule)) };
}

/** { report } or { missing: "type" | "stakeholder" } or { notOffered: true }. */
export function sampleReport(type, stakeholder) {
  const W = world();
  const rt = W.R.reportTypes.report_types.find((r) => r.id === type);
  if (!rt) return { missing: "type" };
  const who = W.R.stakeholders.stakeholders.find((s) => s.id === stakeholder);
  if (!who) return { missing: "stakeholder" };
  if (!rt.stakeholders.includes(stakeholder)) return { notOffered: true };
  const plan = planReport(W.R.reportTypes, W.R.stakeholders, type, stakeholder);
  return { report: {
    sample: true, meta: sampleLabel(),
    report_type: { id: rt.id, name: rt.name }, stakeholder: { id: who.id, name: who.name },
    title: `${rt.name}: ${who.name}`,
    sections: plan.sections.map((s) => ({ id: s.id, title: s.title, figures: s.metrics.map((m) => figure(W, m)) })),
  } };
}
