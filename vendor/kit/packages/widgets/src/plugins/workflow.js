/** The `workflow` archetype as a plugin (kit.widgets-plugin.v1): moved from the engine core with no change of output. */
import { expected, stepBase } from "../scenario-kit.js";
import { esc, arrow, toneAttr, p, fields, expectedBox, decision, fillIn } from "../html-kit.js";

export default {
  schema: "kit.widgets-plugin.v1", contract: 1, id: "workflow", version: "1.0.0",
  describes: "a step-by-step runner: the visitor advances through the steps and sees each input and outcome",
  reads: ["actors","steps","outcomes"],
  capabilities: { rtl: true, reducedMotion: true, needsCanvas: false },
  runtime: "../../assets/widgets/plugins/workflow.js",
  needs: () => null,
  derive: (sc) => ({ steps: sc.steps.map((s) => stepBase(sc, s)), expected: expected(sc) }),
  render(w, c, f, locale, h) {
    const n = w.data.steps.length;
    return `<ol class="kw-wf" data-kw-steps>${w.data.steps.map((s, i) => `<li class="kw-wf__step"${toneAttr(s.tone)} data-kw-step>
<p class="kw-wf__n">${esc(fillIn(c.stepOf, { n: f.num(i + 1), total: f.num(n) }))}</p><p class="kw-wf__who"><b>${esc(s.actor)}</b>${s.to ? ` <span aria-hidden="true">${arrow(locale)}</span> ${esc(s.to)}` : ""}${decision(c, s.decision)}</p>
<p class="kw-wf__what">${esc(s.action)}</p>${p("kw-wf__detail", s.detail)}${fields(c, f, s.fields)}${p("kw-wf__out", s.outcome)}</li>`).join("")}</ol>
<div class="kw__bar kw__bar--end"><button type="button" class="kw-btn kw-btn--ghost" data-kw-back>${esc(c.back)}</button><button type="button" class="kw-btn" data-kw-next>${esc(c.next)}</button><button type="button" class="kw-btn kw-btn--ghost" data-kw-reset>${esc(c.reset)}</button><span class="kw-status" data-kw-status aria-live="polite"></span></div>${expectedBox(c, w.data.expected)}`;
  },
  check: () => [],
};
