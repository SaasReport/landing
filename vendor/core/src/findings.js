// Deterministic findings and recommendations. A finding is a published rule (registry/findings.json) applied to
// figures the engine computed; it shows the figures that triggered it. No AI, no benchmarks, no clock.
// Pure: registries and metric values are passed in.
import { COMPUTATIONS } from "./metrics/index.js";
import { changeBp, formatBp, formatValue } from "./format.js";

/** Compute the named metrics for one period context. Returns {metricId: {currency: value}}. */
export function computeMetrics(ctx, ids) {
  const out = {};
  for (const id of ids) {
    const fn = COMPUTATIONS[id];
    if (!fn) throw new RangeError(`unknown metric ${id}`);
    out[id] = fn(ctx);
  }
  return out;
}

const OPS = { lt: (a, b) => a < b, lte: (a, b) => a <= b, gt: (a, b) => a > b, gte: (a, b) => a >= b, eq: (a, b) => a === b };

function holds(cond, cur, prior, currency) {
  const a = cur[cond.metric]?.[currency];
  if (a === null || a === undefined) return false;
  if ("value" in cond) return OPS[cond.op](a, cond.value);
  if ("other" in cond) { const b = cur[cond.other]?.[currency]; return b !== null && b !== undefined && OPS[cond.op](a, b); }
  const c = prior ? changeBp(a, prior[cond.metric]?.[currency]) : null; // no prior, or a prior of zero: the rule cannot fire
  return c !== null && OPS[cond.change_op](c, cond.change_bp);
}

/**
 * @param {{findings: object, currencies: object, metrics: object, current: object, prior?: object|null, stakeholder?: string}} input
 * @returns {object[]} findings ordered by severity (act, watch, info), then rule order, then currency
 */
export function evaluateFindings({ findings, currencies, metrics, current, prior = null, stakeholder }) {
  const unitOf = new Map(metrics.metrics.map((m) => [m.id, m.unit]));
  const nameOf = new Map(metrics.metrics.map((m) => [m.id, m.name]));
  const recs = new Map(findings.recommendations.map((r) => [r.id, r]));
  const currenciesSeen = [...new Set(Object.values(current).flatMap((byCur) => Object.keys(byCur)))].sort();
  const rank = new Map(findings.severity_order.map((s, i) => [s, i]));
  const out = [];
  findings.rules.forEach((rule, order) => {
    if (stakeholder && !rule.stakeholders.includes(stakeholder)) return;
    for (const currency of currenciesSeen) {
      if (!rule.when.all.every((c) => holds(c, current, prior, currency))) continue;
      const fmt = (id, value) => formatValue({ currencies, unit: unitOf.get(id), currency, value });
      const evidence = rule.evidence.map((id) => {
        const cur = current[id]?.[currency] ?? null, pr = prior?.[id]?.[currency] ?? null, ch = changeBp(cur, pr);
        return { metric: id, name: nameOf.get(id), current: cur, prior: pr, change_bp: ch, text: { current: fmt(id, cur), prior: pr === null ? null : fmt(id, pr), change: ch === null ? null : formatBp(Math.abs(ch)) } };
      });
      const lead = evidence.find((e) => e.metric === rule.metric);
      const headline = rule.headline.replace(/\{(cur|prior|change)\}/g, (_, k) => lead.text[k === "cur" ? "current" : k]);
      const facts = evidence.flatMap((e) => [e.text.current, e.text.prior, e.text.change]).filter((t) => t !== null);
      out.push({ rule: rule.id, severity: rule.severity, currency, headline, evidence, recommendation: rule.recommendation ? recs.get(rule.recommendation) : null, facts, _o: [rank.get(rule.severity), order, currency] });
    }
  });
  out.sort((a, b) => a._o[0] - b._o[0] || a._o[1] - b._o[1] || (a._o[2] < b._o[2] ? -1 : a._o[2] > b._o[2] ? 1 : 0));
  return out.map(({ _o, ...f }) => f);
}
