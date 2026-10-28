/** The `pipeline` archetype as a plugin (kit.widgets-plugin.v1): moved from the engine core with no change of output. */
import { expected, stepBase } from "../scenario-kit.js";
import { esc, toneAttr, p, expectedBox, fillIn } from "../html-kit.js";

export default {
  schema: "kit.widgets-plugin.v1", contract: 1, id: "pipeline", version: "1.0.0",
  describes: "stages a case flows through, run end to end",
  reads: ["actors","steps","outcomes"],
  capabilities: { rtl: true, reducedMotion: true, needsCanvas: false },
  runtime: "../../assets/widgets/plugins/pipeline.js",
  needs: (sc) => (sc.steps.length < 2 ? "needs at least two steps (stages)" : null),
  derive: (sc) => ({ stages: sc.steps.map((s) => stepBase(sc, s)), expected: expected(sc) }),
  render(w, c, f, locale, h) {
    const n = w.data.stages.length;
    return `<div class="kw__bar"><button type="button" class="kw-btn" data-kw-run>${esc(c.run)}</button><span class="kw-status" data-kw-status aria-live="polite"></span></div>
<ol class="kw-pipe" data-kw-items>${w.data.stages.map((s, i) => `<li class="kw-pipe__stage"${toneAttr(s.tone)} data-label="${esc(fillIn(c.stageOf, { n: f.num(i + 1), total: f.num(n), label: s.action }))}">
<span class="kw-pipe__dot" aria-hidden="true"></span><p class="kw-pipe__what">${esc(s.action)}</p><p class="kw-pipe__who">${esc(s.actor)}</p>${p("kw-pipe__out", s.outcome || s.detail)}</li>`).join("")}</ol>${expectedBox(c, w.data.expected)}`;
  },
  check: () => [],
};
