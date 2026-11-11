/** The `runs` archetype as a plugin (kit.widgets-plugin.v1): moved from the engine core with no change of output. */
import { stepBase, pick } from "../scenario-kit.js";
import { esc, p, fields, decision, fillIn } from "../html-kit.js";

export default {
  schema: "kit.widgets-plugin.v1", contract: 1, id: "runs", version: "1.0.0",
  describes: "a case runner: pick a case, see its inputs, and watch it run through the same stages to its verdict (held or refused at the stage that stops it)",
  reads: ["steps","cases"],
  capabilities: { rtl: true, reducedMotion: true, needsCanvas: false },
  runtime: "../../assets/widgets/plugins/runs.js",
  spec: {
    key: "cases", shared: true,
    resolve: (raw, { T, list, lines }) => list(raw, async (k) => ({ id: k.id, label: await T(k.label), detail: await T(k.detail), stops: k.stops, decision: k.decision, outcome: await T(k.outcome), reason: await T(k.reason),
      inputs: k.inputs ? await lines(k.inputs) : undefined })),
  },
  needs: (sc) => {
    if (!(sc.cases || []).length) return "needs \"cases\"";
    if (sc.steps.length < 2) return "needs at least two steps (stages)";
    const bad = sc.cases.find((k) => k.stops && !sc.steps.some((s) => s.id === k.stops));
    return bad ? `case "${bad.id}" stops at "${bad.stops}", which is not a step` : null;
  },
  derive: (sc) => ({ stages: sc.steps.map((s) => stepBase(sc, s)), cases: sc.cases.map((k) => ({ ...pick(k, ["id", "label", "detail", "decision", "outcome", "reason", "inputs"]), stop: k.stops ? sc.steps.findIndex((s) => s.id === k.stops) : -1 })) }),
  render(w, c, f, locale, h) {
    const d = w.data, n = d.stages.length;
    const verdict = (k) => (k.stop >= 0 ? fillIn(c.stoppedAt, { stage: d.stages[k.stop].action }) : c.passedAll);
    return `<div class="kw-chips kw-runs__pick" role="group" aria-label="${esc(c.cases)}">${d.cases.map((k, i) => `<button type="button" class="kw-chip" aria-pressed="${i === 0}" data-kw-case="${i}" data-stop="${k.stop}" data-decision="${esc(k.decision)}">${esc(k.label)}</button>`).join("")}</div>
${d.cases.map((k, i) => `<div class="kw-runs__case" data-kw-casebox="${i}"${i ? " hidden" : ""}>${p("kw-runs__detail", k.detail)}${fields(c, f, k.inputs)}
<p class="kw-runs__verdict" data-kw-verdict>${decision(c, k.decision)} <b>${esc(verdict(k))}</b>${k.reason ? ` <code dir="ltr">${esc(k.reason)}</code>` : ""}</p>${p("kw-runs__out", k.outcome)}</div>`).join("")}
<div class="kw__bar"><button type="button" class="kw-btn" data-kw-run>${esc(c.run)}</button><span class="kw-status" data-kw-status aria-live="polite"></span></div>
<ol class="kw-pipe kw-runs__stages" data-kw-items>${d.stages.map((s, i) => `<li class="kw-pipe__stage" data-label="${esc(fillIn(c.stageOf, { n: f.num(i + 1), total: f.num(n), label: s.action }))}"><span class="kw-pipe__dot" aria-hidden="true"></span><p class="kw-pipe__what">${esc(s.action)}</p><p class="kw-pipe__who">${esc(s.actor)}</p>${p("kw-pipe__out", s.detail || s.outcome)}</li>`).join("")}</ol>`;
  },
  check: () => [],
};
