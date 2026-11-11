/**
 * The `flow` archetype: money movement. A source, steps and a destination along one path; an amount travels along it, step by
 * step, while a status sequence advances (and, for an API call, the request goes out and the response comes back).
 * Covers a payment, the API "try request" and a use-case flow. The hops are the scenario's own steps; the plugin holds no content.
 * Static HTML shows the finished path (every step done, the last status, the response); the runtime replays it with motion.
 */
import { stepBase } from "../scenario-kit.js";

export const SCHEMA = {
  description: "What travels along the scenario's steps (its hops, in order): an amount, a status sequence, figures, and optionally the API request and response.",
  type: "object",
  additionalProperties: false,
  properties: {
    amount: { description: "The amount that travels (as the project writes it, currency included).", $ref: "#/$defs/value" },
    amountLabel: { $ref: "#/$defs/text" },
    metrics: { description: "Figures shown beside the path (counted up when it runs).", type: "array", items: { $ref: "#/$defs/metric" } },
    statuses: { description: "The status sequence; each status holds from its step until the next one's.", type: "array", minItems: 1, items: { $ref: "#/$defs/status" } },
    request: { $ref: "#/$defs/request" },
    cta: { description: "The label of the button that runs it (default: the interface word).", $ref: "#/$defs/text" },
  },
  $defs: {
    metric: { type: "object", additionalProperties: false, required: ["label", "value"], properties: { label: { $ref: "#/$defs/text" }, value: { $ref: "#/$defs/value" } } },
    status: { type: "object", additionalProperties: false, required: ["step", "label"], properties: { step: { description: "The id of the scenario step where this status begins.", $ref: "#/$defs/id" }, label: { $ref: "#/$defs/text" }, tone: { $ref: "#/$defs/tone" } } },
    request: {
      type: "object", additionalProperties: false, required: ["method", "path"],
      properties: { method: { $ref: "#/$defs/text" }, path: { $ref: "#/$defs/text" }, body: { $ref: "#/$defs/sourced" }, response: { $ref: "#/$defs/sourced" } },
    },
  },
};

const problem = (sc) => {
  if (sc.steps.length < 2) return "needs at least two steps (the hops)";
  const ids = new Set(sc.steps.map((s) => s.id));
  for (const st of sc.flow?.statuses || []) if (!ids.has(st.step)) return `status "${st.label}" begins at step "${st.step}", which is not a step`;
  return null;
};

export default {
  schema: "kit.widgets-plugin.v1", contract: 1, id: "flow", version: "1.0.0",
  describes: "money movement: a source, steps and a destination with an amount travelling along the path, a status sequence and, for an API call, the request and the response",
  reads: ["actors", "steps"],
  spec: { key: "flow", schema: SCHEMA },
  capabilities: { rtl: true, reducedMotion: true, needsCanvas: false },
  runtime: "../../assets/widgets/plugins/flow.js",
  styles: "../../theme/plugins/flow.css",
  chromeKeys: ["run", "flowPath", "flowStatus", "flowAmount", "request", "response", "play"],
  textKeys: ["label", "amount", "value", "method", "path", "action", "actor", "outcome", "cta"],
  needs: (sc) => (sc.flow ? problem(sc) : "needs \"flow\" (an amount, statuses, optionally a request)"),
  derive: (sc) => {
    const f = sc.flow;
    const hops = sc.steps.map((s) => stepBase(sc, s));
    // the status of each hop: the latest status that began at or before it
    const at = sc.steps.map((s) => s.id);
    const statuses = (f.statuses || []).map((s) => ({ step: s.step, label: s.label, tone: s.tone || "info", hop: at.indexOf(s.step) })).sort((a, b) => a.hop - b.hop);
    return {
      ...(f.amount !== undefined ? { amount: f.amount } : {}), ...(f.amountLabel ? { amountLabel: f.amountLabel } : {}),
      metrics: f.metrics || [], hops, statuses, ...(f.request ? { request: f.request } : {}), ...(f.cta ? { cta: f.cta } : {}),
    };
  },
  render(w, c, f, locale, h) {
    const { esc, p, val, arrow } = h, d = w.data;
    const last = d.statuses.at(-1);
    const hop = (s, i) => `<li class="kw-flow__hop" data-hop="${i}"${h.toneAttr(s.tone)} data-state="done"><span class="kw-flow__node" aria-hidden="true"><i></i></span><span class="kw-flow__what"><b>${esc(s.action)}</b><small>${esc(s.actor)}${s.to ? ` <span aria-hidden="true">${arrow(locale)}</span> ${esc(s.to)}` : ""}</small>${p("kw-flow__out", s.outcome)}</span></li>`;
    const json = (v) => esc(JSON.stringify(v, null, 2));
    return `<div class="kw-flow" data-kw-flow data-numerals="${esc(f.numerals)}">
<div class="kw__bar"><button type="button" class="kw-btn" data-kw-flow-run>${esc(d.cta || c.run)}</button><span class="kw-status" role="status" aria-live="polite" data-kw-flow-status>${last ? esc(last.label) : ""}</span></div>
${d.amount !== undefined ? `<p class="kw-flow__amount"><span>${esc(d.amountLabel || c.flowAmount)}</span> <b data-kw-count>${val(c, f, d.amount)}</b></p>` : ""}
<div class="kw-flow__stage"><ol class="kw-flow__track" style="--kw-hops:${d.hops.length}" aria-label="${esc(c.flowPath)}">${d.hops.map(hop).join("")}</ol><span class="kw-flow__token" aria-hidden="true" hidden></span></div>
<ol class="kw-flow__statuses" aria-label="${esc(c.flowStatus)}">${d.statuses.map((s, i) => `<li class="kw-flow__status"${h.toneAttr(s.tone)} data-hop="${s.hop}" data-state="done"${i === d.statuses.length - 1 ? ' aria-current="step"' : ""}>${esc(s.label)}</li>`).join("")}</ol>
${d.metrics.length ? `<dl class="kw-flow__metrics">${d.metrics.map((m) => `<div><dt>${esc(m.label)}</dt><dd><span data-kw-count>${val(c, f, m.value)}</span></dd></div>`).join("")}</dl>` : ""}
${d.request ? `<div class="kw-flow__call" dir="ltr"><div><h5>${esc(c.request)}</h5><pre class="kw-code"><b>${esc(d.request.method)}</b> ${esc(d.request.path)}${d.request.body !== undefined ? `\n\n${json(d.request.body)}` : ""}</pre></div>${d.request.response !== undefined ? `<div data-kw-flow-response><h5>${esc(c.response)}</h5><pre class="kw-code">${json(d.request.response)}</pre></div>` : ""}</div>` : ""}
</div>`;
  },
  check(w) {
    const p = [], d = w.data;
    if (d.statuses.length > d.hops.length) p.push(`${d.statuses.length} statuses for ${d.hops.length} steps: a status begins at a step`);
    return p;
  },
};
