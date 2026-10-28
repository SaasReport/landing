// The $engine adapter of widgets.spec.json: the vendored core metric engine run on the sample data files of data/sample.
// No name, number or sentence of its own: everything comes from the core registries, the sample data and the arguments.
import { readFileSync } from "node:fs";
import { computeMetrics, evaluateFindings, formatValue, periodWindow, civilFromDays, daysFromCivil, allowedReportTypes, planReport, verifyNarrative } from "../vendor/core/src/index.js";

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const reg = (name) => read(`../vendor/core/registry/${name}.json`);
const sample = (name) => read(`../data/sample/${name}.json`);
const pad = (n) => String(n).padStart(2, "0");
const iso = (epoch) => { const [y, m, d] = civilFromDays(Math.floor(epoch / 86400)); return `${y}-${pad(m)}-${pad(d)}`; };
const epochOf = (isoDate) => { const [y, m, d] = isoDate.split("-").map(Number); return daysFromCivil(y, m, d) * 86400; };

/** The registries, and the figures of the last complete month and the one before it, at asOf. */
function world(asOf) {
  const R = { stakeholders: reg("stakeholders"), metrics: reg("metrics"), reportTypes: reg("report-types"), cadences: reg("cadences"), roles: reg("roles"), findings: reg("findings"), currencies: reg("currencies") };
  const meta = sample("meta");
  const cur = periodWindow("month", epochOf(asOf));
  const prev = periodWindow("month", cur.from);
  const ctx = (w) => ({ start: sample(`subscriptions.${iso(w.from)}`), end: sample(`subscriptions.${iso(w.to)}`), history: meta.history, window: { from: w.from, to: w.to }, charges: sample("charges"), refunds: sample("refunds"), disputes: sample("disputes"), application_fees: sample("application-fees") });
  const ids = R.metrics.metrics.map((m) => m.id);
  const current = computeMetrics(ctx(cur), ids), prior = computeMetrics(ctx(prev), ids);
  return { R, meta, cur, prev, current, prior };
}

const nameOf = (R, id) => R.metrics.metrics.find((m) => m.id === id).name;
const value = (W, id, figures = W.current) => {
  const m = W.R.metrics.metrics.find((x) => x.id === id);
  return formatValue({ currencies: W.R.currencies, unit: m.unit, currency: W.meta.currency, value: figures[id]?.[W.meta.currency] ?? null });
};
const findingsFor = (W, stakeholder) => evaluateFindings({ findings: W.R.findings, currencies: W.R.currencies, metrics: W.R.metrics, current: W.current, prior: W.prior, stakeholder });
const evidenceLines = (f) => f.evidence.map((e) => `${e.name}: ${e.text.current}${e.text.prior === null ? "" : ` (before: ${e.text.prior})`}`);
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

export default {
  /** One stakeholder: questions, priority figures, reports with cadences, what Stripe cannot tell them, findings. */
  stakeholder({ id, templates }, { asOf }) {
    const fill = (t, o) => Object.entries(o).reduce((s, [k, v]) => s.replace(`{${k}}`, v), t);
    const W = world(asOf);
    const s = W.R.stakeholders.stakeholders.find((x) => x.id === id);
    const cadenceName = (c) => lowerFirst(W.R.cadences.cadences.find((x) => x.id === c).name);
    return {
      name: s.name,
      questions: s.decision_questions.join(" "),
      metrics: s.priority_metrics.map((m) => `${nameOf(W.R, m)}: ${value(W, m)}`),
      reports: W.R.reportTypes.report_types.filter((r) => r.stakeholders.includes(id)).map((r) => fill(templates.report, { report: r.name, cadences: r.cadences.map(cadenceName).join(", ") })),
      notInStripe: fill(templates.notInStripe, { items: s.not_in_stripe.join(", ") }),
      findings: findingsFor(W, id).map((f) => fill(templates.finding, { severity: f.severity, headline: f.headline })),
    };
  },
  /** Every finding that fires on the sample month, once per rule, for every stakeholder. */
  findings(_args, { asOf }) {
    const W = world(asOf);
    const seen = new Set();
    return findingsFor(W, undefined).filter((f) => !seen.has(f.rule) && seen.add(f.rule)).map((f) => ({ severity: f.severity, headline: f.headline, evidence: evidenceLines(f), recommendation: f.recommendation?.text ?? "" }));
  },
  /** One report type as one of its readers sees it: sections in the reader's order, each figure computed. */
  report({ type, stakeholder }, { asOf }) {
    const W = world(asOf);
    const plan = planReport(W.R.reportTypes, W.R.stakeholders, type, stakeholder);
    const who = W.R.stakeholders.stakeholders.find((x) => x.id === stakeholder).name;
    const rt = W.R.reportTypes.report_types.find((x) => x.id === type).name;
    return { title: `${rt}: ${who}`, lines: plan.sections.flatMap((s) => s.metrics.map((m) => ({ label: `${s.title}: ${nameOf(W.R, m)}`, value: value(W, m) }))) };
  },
  /** Stripe roles grouped by what they can see: the reports one role of the group may read, and those held back. */
  roleGroup({ index, more }, { asOf }) {
    const W = world(asOf);
    const groups = new Map();
    for (const r of W.R.roles.roles) { const k = [...r.sees].sort().join("|"); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    const members = [...groups.values()][index];
    const allowed = allowedReportTypes({ roles: W.R.roles, metrics: W.R.metrics, reportTypes: W.R.reportTypes }, [members[0].id]);
    const names = (ids) => ids.map((id) => W.R.reportTypes.report_types.find((r) => r.id === id).name);
    const held = W.R.reportTypes.report_types.map((r) => r.id).filter((id) => !allowed.includes(id));
    const shown = members.length > 3 ? more.replace("{first}", members.slice(0, 2).map((m) => m.name).join(", ")).replace("{count}", String(members.length - 2)) : members.map((m) => m.name).join(", ");
    return { label: shown, members: members.map((m) => m.name).join(", "), allowed: names(allowed), held: names(held) };
  },
  /** The role groups: how many there are. */
  roleGroups(_args, { asOf }) {
    const W = world(asOf);
    return { count: new Set(W.R.roles.roles.map((r) => [...r.sees].sort().join("|"))).size };
  },
  /** The period a cadence covers on the build date. */
  cadence({ id, line }, { asOf }) {
    const w = periodWindow(id, epochOf(asOf));
    const name = reg("cadences").cadences.find((c) => c.id === id).name;
    const last = iso(w.to - 86400);
    return { date: iso(w.to), line: line.replace("{cadence}", name).replace("{period}", w.label).replace("{from}", iso(w.from)).replace("{to}", last) };
  },
  /** The number guard on a drafted sentence: {nrr} is the engine's figure; any other number is not. */
  guard({ draft }, { asOf }) {
    const W = world(asOf);
    const text = draft.replace("{nrr}", value(W, "nrr"));
    const facts = findingsFor(W, undefined).flatMap((f) => f.facts).concat(value(W, "nrr"));
    const v = verifyNarrative(text, facts);
    return { text, ok: v.ok, reason: v.ok ? "every number was computed by the engine" : `not computed by the engine: ${v.unsupported.join(", ")}`, decision: v.ok ? "allow" : "deny" };
  },
};
