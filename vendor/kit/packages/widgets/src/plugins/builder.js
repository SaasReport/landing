/**
 * The `builder` archetype: step selections compose a live network preview. Each step offers options (participants, providers,
 * infrastructure); choosing them adds nodes around the hub, un-choosing removes them, and the counters follow the selection. The
 * preview is the `network` archetype (this plugin requires it): the same layout, the same morph. Static HTML shows the default
 * selection as a finished network, with every option listed. No content of its own.
 */
import network, { renderNetwork, deriveNetwork } from "./network.js";
void network;

export const SCHEMA = {
  description: "The hub, the steps with their options, and the figures that count the selection.",
  type: "object",
  additionalProperties: false,
  required: ["hub", "steps"],
  properties: {
    mark: { type: "string", minLength: 1 },
    hub: { $ref: "#/$defs/text" },
    steps: { type: "array", minItems: 1, maxItems: 6, items: { $ref: "#/$defs/step" } },
    output: { type: "array", items: { $ref: "#/$defs/figure" } },
    outputLabel: { $ref: "#/$defs/text" },
    cta: { $ref: "#/$defs/text" },
  },
  $defs: {
    step: {
      type: "object", additionalProperties: false, required: ["id", "title", "class", "options"],
      properties: {
        id: { $ref: "#/$defs/id" }, title: { $ref: "#/$defs/text" },
        class: { description: "The role the chosen options take in the preview.", enum: ["participant", "provider", "infrastructure"] },
        options: { type: "array", minItems: 1, maxItems: 14, items: { $ref: "#/$defs/option" } },
      },
    },
    option: { type: "object", additionalProperties: false, required: ["id", "label"], properties: { id: { $ref: "#/$defs/id" }, label: { $ref: "#/$defs/text" }, selected: { description: "Chosen at first.", type: "boolean" } } },
    figure: { type: "object", additionalProperties: false, required: ["id", "label"], properties: { id: { $ref: "#/$defs/id" }, label: { $ref: "#/$defs/text" }, step: { description: "Counts the options chosen in this step (default: in every step).", $ref: "#/$defs/id" } } },
  },
};

/** The network data a selection composes: the hub, every option as a node, one configuration holding the chosen ones. */
export function networkOf(b, selected) {
  const nodes = [{ id: "hub", label: b.hub, class: "hub" }];
  for (const s of b.steps) for (const o of s.options) nodes.push({ id: `${s.id}--${o.id}`, label: o.label, class: s.class });
  const chosen = (selected ?? b.steps.flatMap((s) => s.options.filter((o) => o.selected).map((o) => `${s.id}--${o.id}`)));
  return deriveNetwork({ ...(b.mark ? { mark: b.mark } : {}), hub: "hub", nodes, configurations: [{ id: "preview", label: b.hub, layout: "rings", nodes: chosen.length ? chosen : [nodes[1].id] }] });
}

export default {
  schema: "kit.widgets-plugin.v1", contract: 1, id: "builder", version: "1.0.0",
  describes: "step selections that compose a live network preview: choosing participants, providers and infrastructure adds them around the hub, with counters that follow; the preview is the network archetype",
  reads: [],
  requires: ["network"],
  spec: { key: "builder", schema: SCHEMA },
  capabilities: { rtl: true, reducedMotion: true, needsCanvas: true },
  runtime: "../../assets/widgets/plugins/builder.js",
  styles: "../../theme/plugins/builder.css",
  chromeKeys: ["builderSelected", "builderPreview", "netFlows", "netFromTo", "netBoth", "netFlowsOf", "netCapabilities", "netDetailHint", "netEvent", "close", "legend", "play", "netViews", "netFigures"],
  textKeys: ["label", "title", "cta", "hub"],
  needs: (sc) => {
    if (!sc.builder) return "needs \"builder\" (a hub and steps with options)";
    const ids = sc.builder.steps.flatMap((s) => s.options.map((o) => `${s.id}--${o.id}`));
    if (new Set(ids).size !== ids.length) return "has two options with the same id in one step";
    const steps = new Set(sc.builder.steps.map((s) => s.id));
    const bad = (sc.builder.output || []).find((o) => o.step && !steps.has(o.step));
    return bad ? `figure "${bad.id}" counts step "${bad.step}", which is not a step` : null;
  },
  derive: (sc) => {
    const b = sc.builder;
    return {
      ...(b.mark ? { mark: b.mark } : {}), hub: b.hub, steps: b.steps, output: b.output || [], ...(b.outputLabel ? { outputLabel: b.outputLabel } : {}), ...(b.cta ? { cta: b.cta } : {}),
      preview: networkOf(b),
    };
  },
  render(w, c, f, locale, h) {
    const { esc } = h, d = w.data, pid = `${w.id}-${w.locale}`;
    const count = (o, sel) => d.steps.filter((s) => !o.step || s.id === o.step).reduce((n, s) => n + s.options.filter((x) => sel(s, x)).length, 0);
    const steps = d.steps.map((s) => `<fieldset class="kw-bld__step" data-step="${esc(s.id)}" data-class="${esc(s.class)}"><legend>${esc(s.title)}</legend><ul class="kw-bld__opts">${s.options.map((o) => `<li><label class="kw-bld__opt"><input type="checkbox" name="${esc(`${s.id}--${o.id}`)}" value="${esc(`${s.id}--${o.id}`)}"${o.selected ? " checked" : ""}><span>${esc(o.label)}</span></label></li>`).join("")}</ul></fieldset>`).join("");
    const out = d.output.length ? `<dl class="kw-bld__out" aria-label="${esc(d.outputLabel || c.builderPreview)}">${d.output.map((o) => `<div data-fig="${esc(o.id)}"${o.step ? ` data-step="${esc(o.step)}"` : ""}><dt>${esc(o.label)}</dt><dd data-kw-count>${esc(f.num(count(o, (s, x) => x.selected)))}</dd></div>`).join("")}</dl>` : "";
    return `<div class="kw-bld" data-kw-builder><div class="kw-bld__grid">
<form class="kw-bld__form" data-kw-bld-form onsubmit="return false" aria-label="${esc(w.title)}">${steps}</form>
<div class="kw-bld__preview">${renderNetwork({ ...w, id: pid }, c, f, locale, h, { id: pid, data: d.preview, selectable: false })}${out}</div>
</div></div>`;
  },
  check(w) { return w.data.preview.configurations[0].nodes.length < 1 ? ["the default selection is empty"] : []; },
};
