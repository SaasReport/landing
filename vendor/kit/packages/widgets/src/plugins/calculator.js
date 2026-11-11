/** The `calculator` archetype as a plugin (kit.widgets-plugin.v1): moved from the engine core with no change of output. */
import { pick, expected } from "../scenario-kit.js";
import { esc, p, expectedBox } from "../html-kit.js";
import { parseExpr, evalExpr } from "../util.js";

export default {
  schema: "kit.widgets-plugin.v1", contract: 1, id: "calculator", version: "1.0.0",
  describes: "inputs and the outcomes computed from them (arithmetic the spec states)",
  reads: ["inputs","outcomes"],
  capabilities: { rtl: true, reducedMotion: true, needsCanvas: false },
  runtime: "../../assets/widgets/plugins/calculator.js",
  needs: (sc) => (!(sc.inputs || []).length ? "needs inputs" : !(sc.outcomes || []).some((o) => o.expr) ? "needs outcomes with expr" : null),
  derive: (sc) => {
    const names = new Set(sc.inputs.map((i) => i.id));
    for (const o of sc.outcomes) if (o.expr) parseExpr(o.expr, names);
    return {
      inputs: sc.inputs.map((i) => pick(i, ["id", "label", "type", "default", "min", "max", "step", "unit", "options"])),
      outputs: sc.outcomes.filter((o) => o.expr).map((o) => pick(o, ["id", "label", "expr", "unit", "decimals", "bands"])),
      expected: expected(sc),
    };
  },
  render(w, c, f, locale, h) {
    const vars = Object.fromEntries(w.data.inputs.map((i) => [i.id, i.default]));
    const names = new Set(w.data.inputs.map((i) => i.id));
    return `<form class="kw-calc" data-kw-calc data-numerals="${esc(f.numerals)}" data-group="${esc(f.sep.group)}" data-decimal="${esc(f.sep.decimal)}"><fieldset><legend>${esc(c.inputs)}</legend>${w.data.inputs.map((i) => `<label class="kw-calc__in"><span>${esc(i.label)}${i.unit ? ` <small>(${esc(i.unit)})</small>` : ""}</span>${i.type === "select"
      ? `<select name="${esc(i.id)}">${i.options.map((o) => `<option value="${o.value}"${o.value === i.default ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`
      : `<input type="number" inputmode="decimal" name="${esc(i.id)}" value="${esc(i.default)}"${i.min != null ? ` min="${i.min}"` : ""}${i.max != null ? ` max="${i.max}"` : ""}${i.step != null ? ` step="${i.step}"` : ""}>`}</label>`).join("")}</fieldset>
<div class="kw-calc__out" aria-live="polite"><h5>${esc(c.outputs)}</h5>${w.data.outputs.map((o) => `<p><span>${esc(o.label)}</span> <span class="kw-calc__val"><output data-expr="${esc(o.expr)}" data-decimals="${o.decimals ?? 0}">${esc(f.num(evalExpr(parseExpr(o.expr, names), vars), o.decimals ?? 0, true))}</output>${o.unit ? ` <small>${esc(o.unit)}</small>` : ""}</span></p>${o.bands?.length ? (() => { const v = evalExpr(parseExpr(o.expr, names), vars), b = [...o.bands].sort((x, y) => x.min - y.min), at = b.filter((x) => x.min <= v).pop() || b[0];
      return `<ol class="kw-calc__bands" data-kw-bands>${b.map((x) => `<li data-min="${x.min}"${x === at ? ' data-on="1"' : ""}><b>${esc(x.label)}</b>${p("", x.text)}</li>`).join("")}</ol>`; })() : ""}`).join("")}</div></form>${expectedBox(c, w.data.expected)}`;
  },
  check: () => [],
};
