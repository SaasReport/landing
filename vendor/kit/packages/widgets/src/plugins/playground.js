/** The `playground` archetype as a plugin (kit.widgets-plugin.v1): moved from the engine core with no change of output. */
import { stepBase } from "../scenario-kit.js";
import { esc, p, json } from "../html-kit.js";

export default {
  schema: "kit.widgets-plugin.v1", contract: 1, id: "playground", version: "1.0.0",
  describes: "an API explorer: the operations the scenario's steps call, with their request and response from the contract",
  reads: ["steps"],
  capabilities: { rtl: true, reducedMotion: true, needsCanvas: false },
  runtime: "../../assets/widgets/plugins/playground.js",
  needs: (sc) => (sc.steps.some((s) => s.op) ? null : "needs steps with \"operation\" (<openapi source>#<operationId>)"),
  derive: (sc) => ({ calls: sc.steps.filter((s) => s.op).map((s) => ({ ...stepBase(sc, s), ...s.op })) }),
  render(w, c, f, locale, h) {
    const id = (i) => `${w.id}-${w.locale}-call-${i}`;
    return `<div class="kw-tabs" role="tablist" aria-label="${esc(w.title)}">${w.data.calls.map((k, i) => `<button type="button" role="tab" id="${id(i)}-tab" aria-controls="${id(i)}" aria-selected="${i === 0}" data-kw-tab><code dir="ltr">${esc(k.method)}</code> ${esc(k.chip || k.action)}</button>`).join("")}</div>
${w.data.calls.map((k, i) => `<div class="kw-pg" role="tabpanel" id="${id(i)}" aria-labelledby="${id(i)}-tab" data-kw-panel${i ? " hidden" : ""}>
<p class="kw-pg__who"><b>${esc(k.actor)}</b> · ${esc(k.action)}</p>
<h5>${esc(c.request)}</h5><pre dir="ltr" class="kw-code"><b>${esc(k.method)}</b> ${esc(k.path)}${k.body !== undefined ? `\n\n${json(k.body)}` : ""}</pre>
<button type="button" class="kw-btn" data-kw-send>${esc(c.send)}</button>
<div data-kw-response><h5>${esc(c.response)} <code dir="ltr">${esc(k.status)}</code></h5><pre dir="ltr" class="kw-code">${json(k.response)}</pre></div></div>`).join("")}`;
  },
  check: () => [],
};
