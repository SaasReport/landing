/**
 * The `network` archetype: an interactive, animated topology of a financial network.
 *
 * Nodes sit in rings, on two sides or in tiers around a hub (the project's mark) and carry a role: participant, provider or
 * infrastructure. Edges are curved; flows (labelled, typed, with an amount and a direction) travel along them as particles in the
 * direction of the money. Hover or focus lights a node's flows; a click opens its detail panel; switching the configuration
 * morphs the layout (persisting nodes move, entering ones grow in, leaving ones fade); live counters count up to the spec's own
 * values; a provider failover fades one edge and re-routes a flow to another provider.
 *
 * Rendering: the static HTML is complete without scripts (stage, edges, arrows, a node list with roles, the flows, the counters,
 * every view as text). The runtime adds the motion: SVG for structure (crisp, focusable, themeable by CSS tokens) and one
 * Canvas2D layer for the particles (a batched draw per frame instead of dozens of animated DOM nodes), driven by
 * requestAnimationFrame, paused off screen and in a hidden tab, still under prefers-reduced-motion.
 * The plugin holds no content: every text is the spec's.
 */
import { layoutNetwork, edgesOf, gutterVia, routeOf, hopsOf, edgeKey, measure, arrowPath, physical, ladderRows, ladderHeight, sizeOf, labelWidth, hubBox, pct, WIDE_REF, NARROW_REF, NARROW_MAX } from "../../assets/widgets/lib/netlayout.js";

const TONES = ["ok", "warn", "err", "info", "brand", "pending"];

export const SCHEMA = {
  description: "A network: nodes with roles around a hub, configurations (the views the visitor switches between) with their edges, typed flows, live counters and an optional provider-failover event.",
  type: "object",
  additionalProperties: false,
  required: ["hub", "nodes", "configurations"],
  properties: {
    mark: { description: "URL of the hub's image (the project's mark).", type: "string", minLength: 1 },
    hub: { description: "The node id of the hub (a node of class hub).", $ref: "#/$defs/id" },
    nodes: { type: "array", minItems: 2, items: { $ref: "#/$defs/node" } },
    flowTypes: { type: "array", items: { $ref: "#/$defs/flowType" } },
    configurations: { type: "array", minItems: 1, items: { $ref: "#/$defs/configuration" } },
    default: { description: "The configuration shown first (default: the first).", $ref: "#/$defs/id" },
    selector: { description: "How the visitor switches configuration: tabs or a select (default: tabs up to six, else a select).", enum: ["tabs", "select"] },
    selectorLabel: { $ref: "#/$defs/text" },
  },
  $defs: {
    node: {
      type: "object", additionalProperties: false, required: ["id", "label", "class"],
      properties: {
        id: { $ref: "#/$defs/id" }, label: { $ref: "#/$defs/text" },
        class: { description: "Its role in the topology; the stylesheet colours it from the project's tokens.", enum: ["hub", "participant", "provider", "infrastructure"] },
        role: { $ref: "#/$defs/text" }, detail: { $ref: "#/$defs/text" },
        capabilities: { type: "array", items: { $ref: "#/$defs/text" } },
      },
    },
    flowType: { type: "object", additionalProperties: false, required: ["id", "label", "tone"], properties: { id: { $ref: "#/$defs/id" }, label: { $ref: "#/$defs/text" }, tone: { $ref: "#/$defs/tone" } } },
    flow: {
      type: "object", additionalProperties: false, required: ["id", "type", "from", "to", "label"],
      properties: {
        id: { $ref: "#/$defs/id" }, type: { $ref: "#/$defs/id" }, from: { $ref: "#/$defs/id" }, to: { $ref: "#/$defs/id" },
        label: { $ref: "#/$defs/text" }, amount: { $ref: "#/$defs/value" },
        direction: { description: "forward: from to to (default); reverse: to to from; both: both ways.", enum: ["forward", "reverse", "both"] },
      },
    },
    counter: { type: "object", additionalProperties: false, required: ["id", "label", "value"], properties: { id: { $ref: "#/$defs/id" }, label: { $ref: "#/$defs/text" }, value: { $ref: "#/$defs/value" } } },
    event: {
      type: "object", additionalProperties: false, required: ["id", "kind", "label", "flow", "fails", "reroute"],
      properties: {
        id: { $ref: "#/$defs/id" }, kind: { const: "failover" }, label: { $ref: "#/$defs/text" }, done: { $ref: "#/$defs/text" },
        flow: { description: "The flow that is re-routed.", $ref: "#/$defs/id" },
        fails: { description: "The provider whose edge fades.", $ref: "#/$defs/id" },
        reroute: { description: "The provider the flow continues through.", $ref: "#/$defs/id" },
      },
    },
    configuration: {
      type: "object", additionalProperties: false, required: ["id", "label", "nodes"],
      properties: {
        id: { $ref: "#/$defs/id" }, label: { $ref: "#/$defs/text" }, summary: { $ref: "#/$defs/text" },
        layout: { enum: ["rings", "sides", "tiers"] },
        nodes: { description: "The nodes of this view (not the hub).", type: "array", minItems: 1, items: { $ref: "#/$defs/id" } },
        edges: { description: "Explicit edges as [from, to] node ids; default: every node to the hub.", type: "array", items: { type: "array", minItems: 2, maxItems: 2, items: { $ref: "#/$defs/id" } } },
        flows: { type: "array", items: { $ref: "#/$defs/flow" } },
        counters: { type: "array", items: { $ref: "#/$defs/counter" } },
        event: { $ref: "#/$defs/event" },
      },
    },
  },
};

/** The performance budget the check enforces (declared once; the runtime caps particles on its own too). */
export const BUDGET = { nodes: 24, flows: 40, configurations: 24 };

const problem = (n) => {
  const ids = new Set(n.nodes.map((x) => x.id));
  if (ids.size !== n.nodes.length) return "has two nodes with the same id";
  const hub = n.nodes.find((x) => x.id === n.hub);
  if (!hub) return `hub "${n.hub}" is not one of its nodes`;
  if (hub.class !== "hub") return `hub "${n.hub}" must be a node of class hub`;
  const stray = n.nodes.find((x) => x.class === "hub" && x.id !== n.hub);
  if (stray) return `node "${stray.id}" is of class hub, but the hub is "${n.hub}"`;
  const types = new Set((n.flowTypes || []).map((t) => t.id));
  const seen = new Set();
  for (const c of n.configurations) {
    if (seen.has(c.id)) return `two configurations share the id "${c.id}"`;
    seen.add(c.id);
    const inCfg = new Set([n.hub, ...c.nodes]);
    for (const id of c.nodes) { if (!ids.has(id)) return `configuration "${c.id}": node "${id}" is not defined`; if (id === n.hub) return `configuration "${c.id}": the hub is implied, do not list it`; }
    for (const [a, b] of c.edges || []) if (!inCfg.has(a) || !inCfg.has(b)) return `configuration "${c.id}": edge ${a} - ${b} joins a node that is not in the view`;
    const fl = new Set();
    for (const f of c.flows || []) {
      if (fl.has(f.id)) return `configuration "${c.id}": two flows share the id "${f.id}"`;
      fl.add(f.id);
      if (!inCfg.has(f.from) || !inCfg.has(f.to)) return `configuration "${c.id}": flow "${f.id}" runs between nodes that are not in the view`;
      if (f.from === f.to) return `configuration "${c.id}": flow "${f.id}" starts and ends at the same node`;
      if (c.edges) { const has = (a, b) => c.edges.some(([x, y]) => edgeKey(x, y) === edgeKey(a, b)); if (!(has(f.from, f.to) || (f.from !== n.hub && f.to !== n.hub && has(n.hub, f.from) && has(n.hub, f.to)))) return `configuration "${c.id}": flow "${f.id}" has no route: the view's edges neither join ${f.from} and ${f.to} directly nor both to the hub "${n.hub}"`; }
      if (!types.has(f.type)) return `configuration "${c.id}": flow "${f.id}" has the type "${f.type}", which flowTypes does not declare`;
    }
    const e = c.event;
    if (e) {
      const f = (c.flows || []).find((x) => x.id === e.flow);
      if (!f) return `configuration "${c.id}": the event re-routes flow "${e.flow}", which is not in the view`;
      if (![f.from, f.to].includes(e.fails)) return `configuration "${c.id}": the event fails "${e.fails}", which is not an end of flow "${e.flow}"`;
      if (!inCfg.has(e.reroute) || e.reroute === e.fails) return `configuration "${c.id}": the event re-routes to "${e.reroute}", which must be another node of the view`;
      if (!(c.edges ? c.edges.some(([a, b]) => edgeKey(a, b) === edgeKey(n.hub, e.reroute)) : true)) return `configuration "${c.id}": there is no edge to the provider "${e.reroute}" to re-route through`;
    }
  }
  if (n.default && !seen.has(n.default)) return `default "${n.default}" is not a configuration`;
  return null;
};

/* ---------- derived data ---------- */
export function deriveNetwork(n) {
  return {
    ...(n.mark ? { mark: n.mark } : {}),
    hub: n.hub,
    nodes: n.nodes.map((x) => ({ id: x.id, label: x.label, class: x.class, ...(x.role ? { role: x.role } : {}), ...(x.detail ? { detail: x.detail } : {}), ...(x.capabilities?.length ? { capabilities: x.capabilities } : {}) })),
    flowTypes: n.flowTypes || [],
    configurations: n.configurations.map((c) => ({
      id: c.id, label: c.label, ...(c.summary ? { summary: c.summary } : {}), layout: c.layout || "rings",
      nodes: c.nodes, edges: c.edges || c.nodes.map((id) => [n.hub, id]),
      flows: (c.flows || []).map((f) => ({ id: f.id, type: f.type, from: f.from, to: f.to, label: f.label, ...(f.amount !== undefined ? { amount: f.amount } : {}), direction: f.direction || "forward" })),
      counters: c.counters || [],
      ...(c.event ? { event: c.event } : {}),
    })),
    default: n.default || n.configurations[0].id,
    selector: n.selector || (n.configurations.length > 6 ? "select" : "tabs"),
    ...(n.selectorLabel ? { selectorLabel: n.selectorLabel } : {}),
  };
}

/* ---------- static HTML ---------- */

/** Boxes (centre and size) of a configuration's nodes laid out for a stage, in physical coordinates. */
export function stageFor(data, cfg, mode, rtl) {
  const byId = new Map(data.nodes.map((x) => [x.id, x]));
  const nodes = cfg.nodes.map((id) => ({ id, cls: byId.get(id).class }));
  const sizes = Object.fromEntries(cfg.nodes.map((id) => [id, sizeOf(byId.get(id).label)]));
  const ref = mode === "wide" ? WIDE_REF : NARROW_REF;
  const hubW = labelWidth(byId.get(data.hub).label) - 20;
  const L = layoutNetwork({ nodes, sizes, layout: cfg.layout, mode, width: ref.w, height: mode === "wide" ? ref.h : undefined, hubW });
  const boxes = { [data.hub]: hubBox(physical(L.hub.x, L.width, rtl), L.hub.y, hubW) };
  for (const id of cfg.nodes) boxes[id] = { x: physical(L.pos[id].x, L.width, rtl), y: L.pos[id].y, ...sizes[id] };
  const geom = edgesOf(cfg.edges, boxes, { via: mode === "narrow" ? gutterVia({ hubId: data.hub, width: L.width, cols: L.cols }) : undefined });
  return { L, boxes, geom, sizes };
}

const chain = (data, cfg, f, geom) => cfg.flows.map((fl) => ({ fl, hops: hopsOf(fl.from, fl.to, data.hub, geom), route: routeOf(fl.from, fl.to, data.hub, geom) })).filter((r) => r.route);

export function renderNetwork(w, c, f, locale, h, { id = `${w.id}-${w.locale}`, data = w.data, selectable = true } = {}) {
  const { esc, p, val, fillIn } = h;
  const rtl = locale?.dir === "rtl";
  const def = data.configurations.find((x) => x.id === data.default) || data.configurations[0];
  const byId = new Map(data.nodes.map((x) => [x.id, x]));
  const hubNode = byId.get(data.hub);
  const typeOf = new Map(data.flowTypes.map((t) => [t.id, t]));
  const wide = stageFor(data, def, "wide", rtl), narrow = stageFor(data, def, "narrow", rtl);
  const rows = Math.max(...data.configurations.map((cfg) => ladderRows(cfg.nodes.map((nid) => ({ id: nid, cls: byId.get(nid).class })), Object.fromEntries(cfg.nodes.map((nid) => [nid, sizeOf(byId.get(nid).label)])), NARROW_REF.w)));
  const narrowH = Math.max(narrow.L.height, ladderHeight(rows));
  const svg = (st, mode, vbH) => {
    const used = chain(data, def, f, st.geom);
    const lit = new Map();
    for (const u of used) for (let i = 0; i + 1 < u.hops.length; i++) lit.set(edgeKey(u.hops[i], u.hops[i + 1]), u.fl.type);
    return `<svg class="kw-net__edges kw-net__edges--${mode}" viewBox="0 0 ${mode === "wide" ? WIDE_REF.w : NARROW_REF.w} ${vbH}" aria-hidden="true" focusable="false">${Object.entries(st.geom).map(([k, e]) => `<path class="kw-net__edge" data-edge="${esc(k)}"${lit.has(k) ? ` data-tone="${esc(typeOf.get(lit.get(k))?.tone || "info")}"` : ""} d="${e.d}"/>`).join("")}${used.map((u) => `<path class="kw-net__arrow" data-flow="${esc(u.fl.id)}" data-type="${esc(u.fl.type)}" d="${arrowPath(measure(u.route), 0.62, 6, u.fl.direction === "reverse")}"/>`).join("")}</svg>`;
  };
  const pos = (nid) => {
    const a = wide.L.pos[nid], b = narrow.L.pos[nid];
    return `--x:${pct(a.x, WIDE_REF.w)};--y:${pct(a.y, WIDE_REF.h)};--nx:${pct(b.x, NARROW_REF.w)};--ny:${b.y}px`;
  };
  const hubPos = `--x:${pct(wide.L.hub.x, WIDE_REF.w)};--y:${pct(wide.L.hub.y, WIDE_REF.h)};--nx:50%;--ny:${narrow.L.hub.y}px`;
  const dir = (fl) => (fl.direction === "reverse" ? fillIn(c.netFromTo, { from: byId.get(fl.to).label, to: byId.get(fl.from).label }) : fl.direction === "both" ? fillIn(c.netBoth, { from: byId.get(fl.from).label, to: byId.get(fl.to).label }) : fillIn(c.netFromTo, { from: byId.get(fl.from).label, to: byId.get(fl.to).label }));
  const flowItem = (fl) => {
    const t = typeOf.get(fl.type);
    return `<li class="kw-net__flow" data-flow="${esc(fl.id)}" data-type="${esc(fl.type)}"${t ? ` data-tone="${esc(t.tone)}"` : ""}><i class="kw-net__swatch" aria-hidden="true"></i><span class="kw-net__flowname"><b>${esc(fl.label)}</b>${fl.amount !== undefined ? ` <span class="kw-net__amount">${val(c, f, fl.amount)}</span>` : ""}</span><small>${esc(dir(fl))}</small></li>`;
  };
  const counters = (list) => (list.length ? `<dl class="kw-net__counters" aria-label="${esc(c.netFigures)}">${list.map((k) => `<div data-counter="${esc(k.id)}"><dt>${esc(k.label)}</dt><dd><span data-kw-count>${val(c, f, k.value)}</span></dd></div>`).join("")}</dl>` : `<dl class="kw-net__counters" aria-label="${esc(c.netFigures)}" hidden></dl>`);
  const nodeDetail = (n) => `<li class="kw-net__d" data-node="${esc(n.id)}"><b>${esc(n.label)}</b>${n.role ? ` <span class="kw-net__role">${esc(n.role)}</span>` : ""}${p("kw-net__detail", n.detail)}${n.capabilities?.length ? `<ul class="kw-net__caps" aria-label="${esc(c.netCapabilities)}">${n.capabilities.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}</li>`;
  const selector = data.configurations.length > 1 ? (data.selector === "select"
    ? `<label class="kw-net__pick kw-net__pick--select"><span>${esc(data.selectorLabel || c.netViews)}</span><select data-kw-net-select>${data.configurations.map((x) => `<option value="${esc(x.id)}"${x.id === def.id ? " selected" : ""}>${esc(x.label)}</option>`).join("")}</select></label>`
    : `<div class="kw-net__pick kw-net__pick--tabs" role="tablist" aria-label="${esc(data.selectorLabel || c.netViews)}">${data.configurations.map((x) => `<button type="button" role="tab" class="kw-chip" aria-selected="${x.id === def.id}" data-kw-net-view="${esc(x.id)}">${esc(x.label)}</button>`).join("")}</div>`) : "";
  const event = data.configurations.some((x) => x.event) ? `<div class="kw-net__event"><button type="button" class="kw-btn kw-btn--ghost" data-kw-net-event hidden>${esc(c.netEvent)}</button><p class="kw-net__eventlog kw-status" role="status" aria-live="polite" data-kw-net-log></p></div>` : "";
  const island = { data, ui: { flowsOf: c.netFlowsOf, fromTo: c.netFromTo, both: c.netBoth, close: c.close, play: c.play, event: c.netEvent, capabilities: c.netCapabilities, hint: c.netDetailHint }, rtl, narrowMax: NARROW_MAX };
  return `<div class="kw-net" data-kw-net data-numerals="${esc(f.numerals)}" data-layout="${esc(def.layout)}" data-cfg="${esc(def.id)}" style="--kw-net-rows-h:${narrowH}px">
${selector}
<div class="kw-net__body">
<div class="kw-net__stage" role="group" aria-label="${esc(w.title)}">
${svg(wide, "wide", WIDE_REF.h)}${svg(narrow, "narrow", narrowH)}
<div class="kw-net__hub" data-node="${esc(data.hub)}" style="${hubPos}">${data.mark ? `<img class="kw-net__mark" src="${esc(data.mark)}" alt="" width="52" height="52">` : `<span class="kw-net__mark kw-net__mark--none" aria-hidden="true"></span>`}<span class="kw-net__hubname">${esc(hubNode.label)}</span></div>
${def.nodes.map((nid) => { const n = byId.get(nid); return `<span class="kw-net__node" data-node="${esc(nid)}" data-class="${esc(n.class)}" style="${pos(nid)}"><i class="kw-net__dot" aria-hidden="true"></i><span class="kw-net__label">${esc(n.label)}</span></span>`; }).join("")}
</div>
<div class="kw-net__side">
${data.flowTypes.length ? `<p class="kw-net__legend" aria-label="${esc(c.legend)}">` : "<span hidden>"}${data.flowTypes.map((t) => `<span class="kw-net__type" data-tone="${esc(t.tone)}" data-type="${esc(t.id)}"><i class="kw-net__swatch" aria-hidden="true"></i>${esc(t.label)}</span>`).join("")}${data.flowTypes.length ? "</p>" : "</span>"}
<ul class="kw-net__flows" aria-label="${esc(c.netFlows)}"${def.flows.length || data.flowTypes.length ? "" : " hidden"}>${def.flows.map(flowItem).join("")}</ul>
${counters(def.counters)}
${event}
${selectable ? `<div class="kw-net__panel" data-kw-net-panel aria-live="polite"><p class="kw-net__hint">${esc(c.netDetailHint)}</p><ul class="kw-net__details">${def.nodes.map((nid) => nodeDetail(byId.get(nid))).join("")}</ul></div>` : ""}
</div>
</div>
${data.configurations.length > 1 ? `<details class="kw-net__all"><summary>${esc(data.selectorLabel || c.netViews)} (${esc(f.num(data.configurations.length))})</summary><ul>${data.configurations.map((x) => `<li data-cfg="${esc(x.id)}"><b>${esc(x.label)}</b>${x.summary ? `: ${esc(x.summary)}` : ""}<br><span class="kw-net__nodes">${x.nodes.map((nid) => esc(byId.get(nid).label)).join(", ")}</span>${x.flows.length ? `<br><span class="kw-net__flowlist">${x.flows.map((fl) => esc(fl.label)).join(", ")}</span>` : ""}</li>`).join("")}</ul></details>` : ""}
<script type="application/json" data-kw-net-data>${JSON.stringify(island).replace(/</g, "\\u003c")}</script>
</div>`;
}

export default {
  schema: "kit.widgets-plugin.v1", contract: 1, id: "network", version: "1.0.0",
  describes: "an interactive, animated network topology: nodes in rings, sides or tiers around a hub with roles, curved edges, typed and labelled flows travelling in the direction of the money, hover and detail panels, morphing configurations, live counters and a provider failover",
  reads: [],
  spec: { key: "network", schema: SCHEMA },
  capabilities: { rtl: true, reducedMotion: true, needsCanvas: true },
  runtime: "../../assets/widgets/plugins/network.js",
  styles: "../../theme/plugins/network.css",
  chromeKeys: ["netViews", "netFlows", "netFigures", "netCapabilities", "netFlowsOf", "netFromTo", "netBoth", "netDetailHint", "netEvent", "close", "legend", "play"],
  textKeys: ["label", "summary", "role", "detail", "capabilities", "amount", "value", "done"],
  needs: (sc) => (sc.network ? problem(sc.network) : "needs \"network\" (hub, nodes, configurations)"),
  derive: (sc) => deriveNetwork(sc.network),
  render: (w, c, f, locale, h) => renderNetwork(w, c, f, locale, h),
  check(w) {
    const p = [], d = w.data;
    if (d.configurations.length > BUDGET.configurations) p.push(`${d.configurations.length} configurations; the budget is ${BUDGET.configurations}`);
    for (const cfg of d.configurations) {
      if (cfg.nodes.length > BUDGET.nodes) p.push(`configuration ${cfg.id}: ${cfg.nodes.length} nodes; the budget is ${BUDGET.nodes} (it must hold 60 fps on a mid-range phone)`);
      if (cfg.flows.length > BUDGET.flows) p.push(`configuration ${cfg.id}: ${cfg.flows.length} flows; the budget is ${BUDGET.flows}`);
      for (const fl of cfg.flows) if (!TONES.includes(d.flowTypes.find((t) => t.id === fl.type)?.tone)) p.push(`configuration ${cfg.id}: flow ${fl.id} has no tone`);
    }
    return p;
  },
};
