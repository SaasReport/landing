/* The network archetype's runtime (a plugin module of @saasreport/widgets): progressive enhancement of the static topology.
   Structure is SVG (edges) and focusable buttons (nodes); the particles that carry the flows are drawn on one Canvas2D layer in a
   single batched pass per frame. The loop runs only while the widget is on screen and the tab is visible, and not at all under
   prefers-reduced-motion (the final states are shown statically). No content of its own: every word is in the page's data. */
import { layoutNetwork, edgesOf, gutterVia, routeOf, hopsOf, edgeKey, measure, along, physical, sizeOf, hubBox as hubRect, NARROW_MAX } from "../lib/netlayout.js";
import { reduced, onReducedChange, createLoop, easeInOut, countUp, whenSeen } from "../lib/motion.js";

const SVGNS = "http://www.w3.org/2000/svg";
const MORPH_MS = 640;
const SPEED = 92;                       // px per second along a route
const BUDGET = { wide: 72, narrow: 34 }; // particles on screen at most (frame time stays flat on a phone)

const el = (tag, cls, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (parent) parent.appendChild(e); return e; };
const sv = (tag, cls, parent) => { const e = document.createElementNS(SVGNS, tag); if (cls) e.setAttribute("class", cls); if (parent) parent.appendChild(e); return e; };
const fill = (t, vars) => String(t).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

export default function mount(w) {
  const root = w.querySelector("[data-kw-net]");
  if (root) mountNetwork(root);
}

/**
 * Wake one network. Returns a controller: { configuration(id, { animate }), setData(data, id), current(), destroy() }.
 * `data` is the page's JSON island; the builder passes live data of its own.
 */
export function mountNetwork(root, { data: given } = {}) {
  const island = JSON.parse(root.querySelector("[data-kw-net-data]").textContent);
  let data = given || island.data;
  const ui = island.ui;
  const stage = root.querySelector(".kw-net__stage");
  const rtl = getComputedStyle(root).direction === "rtl", sign = rtl ? -1 : 1;
  const numerals = root.dataset.numerals || "0123456789";
  const logEl = root.querySelector("[data-kw-net-log]");
  const flowsEl = root.querySelector(".kw-net__flows"), countersEl = root.querySelector(".kw-net__counters"), panel = root.querySelector("[data-kw-net-panel]");
  root.classList.add("is-live");

  // one live SVG for the edges (the static ones stay in the markup for no-script and are hidden once this exists)
  const svg = sv("svg", "kw-net__edges kw-net__edges--live", stage);
  svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
  const gEdges = sv("g", "", svg), gArrows = sv("g", "", svg);
  const canvas = el("canvas", "kw-net__fx", stage); canvas.setAttribute("aria-hidden", "true");
  const ctx = canvas.getContext("2d");
  const tagLayer = el("div", "kw-net__tags", stage);
  const hubEl = stage.querySelector(".kw-net__hub");
  for (const v of ["--x", "--y", "--nx", "--ny"]) hubEl.style.setProperty(v, "0px");

  /* ----- state ----- */
  const nodes = new Map();      // id -> { el, x, y (logical, current), w, h, cls, leaving }
  const edges = new Map();      // key -> { path, a, b }
  let cfg = null, geomT = {}, flows = [], mode = "wide", W = 0, H = 0, dpr = 1, focusId = null, selected = null, pulses = [], event = null, tweening = null, fade = 1;
  const nodeData = (id) => data.nodes.find((n) => n.id === id);
  const budget = () => (mode === "narrow" ? BUDGET.narrow : BUDGET.wide);
  const colors = {};
  const probe = el("span", "kw-net__probe", root); probe.setAttribute("aria-hidden", "true");
  const colorOf = (tone) => { if (!colors[tone]) { probe.dataset.tone = tone; colors[tone] = getComputedStyle(probe).color; } return colors[tone]; };
  const toneOf = (type) => data.flowTypes.find((t) => t.id === type)?.tone || "info";

  /* ----- node elements: the static spans become buttons ----- */
  const place = (e, x, y) => { e.style.transform = `translate3d(${x * sign}px,${y}px,0)`; };
  function adopt(id) {
    let n = nodes.get(id);
    if (n) return n;
    const d = nodeData(id);
    let old = stage.querySelector(`.kw-net__node[data-node="${CSS.escape(id)}"]`);
    const b = el("button", "kw-net__node");
    b.type = "button"; b.dataset.node = id; b.dataset.class = d.class; b.setAttribute("aria-pressed", "false");
    b.innerHTML = '<i class="kw-net__dot" aria-hidden="true"></i><span class="kw-net__label"></span>';
    b.querySelector(".kw-net__label").textContent = d.label;
    for (const v of ["--x", "--y", "--nx", "--ny"]) b.style.setProperty(v, "0px");
    if (old) { old.replaceWith(b); } else { b.classList.add("is-entering"); stage.insertBefore(b, tagLayer); }
    b.addEventListener("pointerenter", () => setFocus(id)); b.addEventListener("pointerleave", () => setFocus(selected));
    b.addEventListener("focus", () => setFocus(id)); b.addEventListener("blur", () => setFocus(selected));
    b.addEventListener("click", () => select(selected === id ? null : id));
    n = { el: b, x: 0, y: 0, w: 0, h: 34, cls: d.class, leaving: false };
    nodes.set(id, n);
    return n;
  }
  const hubBox = { x: 0, y: 0 };

  /* ----- layout ----- */
  const measureNode = (n) => { const b = n.el; n.w = b.offsetWidth || sizeOf(b.textContent).w; n.h = b.offsetHeight || 34; };
  function layoutFor(c) {
    const rect = stage.getBoundingClientRect();
    W = Math.round(rect.width); H = Math.round(rect.height);
    mode = W < NARROW_MAX ? "narrow" : "wide";
    const list = c.nodes.map((id) => ({ id, cls: nodeData(id).class }));
    const sizes = Object.fromEntries(c.nodes.map((id) => [id, { w: nodes.get(id)?.w || sizeOf(nodeData(id).label).w, h: nodes.get(id)?.h || 34 }]));
    return layoutNetwork({ nodes: list, sizes, layout: c.layout, mode, width: W, height: H, hubW: hubEl.offsetWidth });
  }
  const viaOf = (L) => (mode === "narrow" ? gutterVia({ hubId: data.hub, width: W, cols: L.cols }) : undefined);
  const boxesOf = (L, c) => {
    const b = { [data.hub]: hubRect(physical(L.hub.x, W, rtl), L.hub.y, hubEl.offsetWidth) };
    for (const id of c.nodes) { const n = nodes.get(id); b[id] = { x: physical(L.pos[id].x, W, rtl), y: L.pos[id].y, w: n.w, h: n.h }; }
    return b;
  };

  /* ----- edges and flows ----- */
  function syncEdges(c, geom, animate) {
    const want = new Set(Object.keys(geom));
    for (const [k, e] of edges) if (!want.has(k)) { e.path.classList.add("is-gone"); const p = e.path; setTimeout(() => p.remove(), animate ? 420 : 0); edges.delete(k); }
    for (const [k, g] of Object.entries(geom)) {
      let e = edges.get(k);
      if (!e) { const path = sv("path", "kw-net__edge", gEdges); path.dataset.edge = k; if (animate) path.classList.add("is-new"); e = { path }; edges.set(k, e); }
      e.path.setAttribute("d", g.d);
    }
  }
  function buildFlows(c, geom) {
    flows = [];
    gArrows.replaceChildren();
    let total = 0;
    const made = [];
    for (const fl of c.flows) {
      const m = faultFor(fl, geom);
      if (!m) continue;
      const route = routeOf(m.from, m.to, data.hub, geom);
      if (!route) continue;
      const mm = measure(route);
      made.push({ fl, from: m.from, to: m.to, m: mm, tone: toneOf(fl.type), n: Math.max(2, Math.min(4, Math.round(mm.total / 130))), live: m.live });
    }
    total = made.reduce((s, f) => s + f.n, 0);
    const scale = total > budget() ? budget() / total : 1;
    for (const f of made) {
      f.n = Math.max(1, Math.floor(f.n * scale));
      f.parts = Array.from({ length: f.n }, (_, i) => ({ phase: i / f.n + (hash(f.fl.id) % 100) / 1000, rev: f.fl.direction === "reverse" || (f.fl.direction === "both" && i % 2 === 1) }));
      flows.push(f);
    }
    // the edges that carry a flow take its colour
    for (const e of edges.values()) delete e.path.dataset.tone;
    for (const f of flows) { const hops = hopsOf(f.from, f.to, data.hub, geom); for (let i = 0; i + 1 < hops.length; i++) { const e = edges.get(edgeKey(hops[i], hops[i + 1])); if (e) e.path.dataset.tone = f.tone; } }
  }
  const hash = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };
  /** The ends a flow has right now: a failed provider is replaced by the one the event re-routed to. */
  const faultFor = (fl, geom) => {
    if (event?.done && cfg.event && cfg.event.flow === fl.id) {
      const e = cfg.event;
      const from = fl.from === e.fails ? e.reroute : fl.from, to = fl.to === e.fails ? e.reroute : fl.to;
      return geom[edgeKey(data.hub, e.reroute)] ? { from, to, live: true } : { from: fl.from, to: fl.to };
    }
    return { from: fl.from, to: fl.to };
  };

  /* ----- drawing ----- */
  function sizeCanvas() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(W * dpr)); canvas.height = Math.max(1, Math.round(H * dpr));
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
  }
  const lit = (f) => focusId == null || f.from === focusId || f.to === focusId || f.fl.from === focusId || f.fl.to === focusId || hopsOf(f.from, f.to, data.hub, geomT).includes(focusId);
  function draw(now, still) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (fade <= 0.01) return;
    const t = now / 1000;
    for (const f of flows) {
      const dim = lit(f) ? 1 : 0.14, col = colorOf(f.tone), len = f.m.total || 1;
      for (const p of f.parts) {
        let u = still ? 0.5 : (t * SPEED / len + p.phase) % 1;
        if (p.rev) u = 1 - u;
        if (!still) {
          // a failing provider slows and fades the particles heading for it
          if (event && !event.done && cfg.event?.flow === f.fl.id) u = p.rev ? u : Math.min(u, 0.94);
        }
        const s = along(f.m, u);
        const edgeFade = Math.min(1, u * 8, (1 - u) * 8);
        const a = dim * fade * (p.rev ? 1 - edgeFade * 0 : edgeFade);
        ctx.globalAlpha = a * 0.16; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(s.x, s.y, 7.5, 0, 6.2832); ctx.fill();
        // a short trail behind the head
        for (let k = 1; k <= 4; k++) {
          const tu = p.rev ? Math.min(1, u + k * 0.012) : Math.max(0, u - k * 0.012), q = along(f.m, tu);
          ctx.globalAlpha = a * (0.5 - k * 0.1); ctx.beginPath(); ctx.arc(q.x, q.y, 3 - k * 0.45, 0, 6.2832); ctx.fill();
        }
        ctx.globalAlpha = a; ctx.beginPath(); ctx.arc(s.x, s.y, 3.2, 0, 6.2832); ctx.fill();
        if (!still && ((p.rev && u < 0.02) || (!p.rev && u > 0.985)) && !p.fired) { p.fired = true; pulses.push({ x: s.x, y: s.y, t0: now, col, a: dim }); } else if (u > 0.1 && u < 0.9) p.fired = false;
      }
    }
    for (let i = pulses.length - 1; i >= 0; i--) {
      const q = pulses[i], k = (now - q.t0) / 520;
      if (k >= 1) { pulses.splice(i, 1); continue; }
      ctx.globalAlpha = (1 - k) * 0.5 * q.a * fade; ctx.strokeStyle = q.col; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(q.x, q.y, 6 + k * 16, 0, 6.2832); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  const loop = createLoop(stage, (now) => {
    if (tweening) stepTween(now);
    draw(now, false);
    return flows.length > 0 || !!tweening || pulses.length > 0;
  });
  const kick = () => { if (!reduced()) loop.kick(); };

  /* ----- morph (FLIP: the layout is computed once, the nodes glide from where they were) ----- */
  function stepTween(now) {
    const k = Math.min(1, (now - tweening.t0) / MORPH_MS), e = easeInOut(k);
    const boxes = {};
    for (const [id, n] of nodes) {
      const tgt = tweening.to[id];
      if (!tgt) continue;
      const x = tweening.from[id].x + (tgt.x - tweening.from[id].x) * e, y = tweening.from[id].y + (tgt.y - tweening.from[id].y) * e;
      n.x = x; n.y = y; place(n.el, x, y);
      boxes[id] = { x: physical(x, W, rtl), y, w: n.w, h: n.h };
    }
    const hx = tweening.hubFrom.x + (tweening.hub.x - tweening.hubFrom.x) * e, hy = tweening.hubFrom.y + (tweening.hub.y - tweening.hubFrom.y) * e;
    place(hubEl, hx, hy);
    boxes[data.hub] = hubRect(physical(hx, W, rtl), hy, hubEl.offsetWidth);
    const g = edgesOf(cfg.edges, boxes, { bows: tweening.bows, via: tweening.via });
    for (const [key, ge] of Object.entries(g)) edges.get(key)?.path.setAttribute("d", ge.d);
    fade = k < 0.5 ? 1 - k * 2 : (k - 0.5) * 2;   // particles dim while the layout moves, then return on the new routes
    if (k >= 0.5 && tweening.needRoutes) { tweening.needRoutes = false; buildFlows(cfg, tweening.finalGeom); geomT = tweening.finalGeom; }
    if (k >= 1) { fade = 1; const done = tweening.done; tweening = null; done?.(); }
  }

  /* ----- switching configuration ----- */
  function configuration(id, { animate = true, silent = false } = {}) {
    const next = data.configurations.find((c) => c.id === id) || data.configurations[0];
    const first = cfg === null;
    const prev = cfg;
    if (prev && prev.id === next.id && !first && !silent) return;
    cfg = next; event = null; root.dataset.cfg = next.id; root.dataset.layout = next.layout;
    // elements: persisting nodes stay, entering ones are created, leaving ones fade
    const keep = new Set(next.nodes);
    for (const [nid, n] of nodes) if (!keep.has(nid)) { n.leaving = true; n.el.classList.add("is-leaving"); n.el.tabIndex = -1; const e2 = n.el; nodes.delete(nid); setTimeout(() => e2.remove(), animate && !reduced() ? 460 : 0); }
    for (const nid of next.nodes) { const n = adopt(nid); n.leaving = false; n.el.classList.remove("is-leaving"); n.el.tabIndex = 0; }
    for (const nid of next.nodes) measureNode(nodes.get(nid));
    const L = layoutFor(next);
    sizeCanvas();
    const boxes = boxesOf(L, next);
    const finalGeom = edgesOf(next.edges, boxes, { via: viaOf(L) });
    const hubFrom = { x: hubBox.x, y: hubBox.y };
    const from = {}, to = {};
    for (const nid of next.nodes) {
      const n = nodes.get(nid), entering = n.el.classList.contains("is-entering");
      to[nid] = L.pos[nid];
      from[nid] = entering || first ? (first ? L.pos[nid] : { x: L.hub.x, y: L.hub.y }) : { x: n.x, y: n.y };
      if (entering) { n.x = from[nid].x; n.y = from[nid].y; place(n.el, n.x, n.y); requestAnimationFrame(() => n.el.classList.remove("is-entering")); }
    }
    hubBox.x = L.hub.x; hubBox.y = L.hub.y;
    if (first || !animate || reduced() || !prev) place(hubEl, L.hub.x, L.hub.y);
    syncEdges(next, finalGeom, animate && !first);
    const finish = () => {
      for (const nid of next.nodes) { const n = nodes.get(nid); n.x = to[nid].x; n.y = to[nid].y; place(n.el, n.x, n.y); }
      geomT = finalGeom; buildFlows(next, finalGeom); paintStatic(); kick();
      if (next.event && reduced()) runEvent(false);
    };
    renderSide(next, !first || !reduced());   // the text side changes at once (inside the visitor's own input), the picture then glides
    if (animate && !first && !reduced() && prev) {
      tweening = { t0: performance.now(), from, to, hub: L.hub, hubFrom, finalGeom, via: viaOf(L), needRoutes: true, done: finish, bows: Object.fromEntries(Object.entries(finalGeom).map(([k, g]) => [k, g.bow])) };
      kick();
    } else {
      tweening = null;
      for (const nid of next.nodes) { const n = nodes.get(nid); n.x = to[nid].x; n.y = to[nid].y; place(n.el, n.x, n.y); }
      for (const [key, ge] of Object.entries(finalGeom)) edges.get(key)?.path.setAttribute("d", ge.d);
      finish();
    }
    // the selector reflects the view
    root.querySelectorAll("[data-kw-net-view]").forEach((b) => { const on = b.dataset.kwNetView === next.id; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; });
    const sel = root.querySelector("[data-kw-net-select]"); if (sel) sel.value = next.id;
    if (selected && !keep.has(selected)) select(null);
    else select(selected);
    if (!first && logEl && !(next.event && reduced())) logEl.textContent = [next.label, next.summary].filter(Boolean).join(": ");
  }

  /** The text side of a view: the flow list, the counters, the details of its nodes, the event button. */
  function renderSide(c, count) {
    root.querySelectorAll(".kw-net__type").forEach((t) => { t.hidden = !c.flows.some((f) => f.type === t.dataset.type); });
    if (flowsEl) {
      flowsEl.replaceChildren(...c.flows.map((fl) => {
        const li = el("li", "kw-net__flow"), tone = toneOf(fl.type), a = nodeData(fl.from).label, b = nodeData(fl.to).label;
        li.dataset.flow = fl.id; li.dataset.type = fl.type; li.dataset.tone = tone;
        const sw = el("i", "kw-net__swatch", li); sw.setAttribute("aria-hidden", "true");
        const nm = el("span", "kw-net__flowname", li); el("b", "", nm).textContent = fl.label;
        if (fl.amount !== undefined) { nm.append(" "); const am = el("span", "kw-net__amount", nm); am.textContent = typeof fl.amount === "number" ? String(fl.amount).replace(/[0-9]/g, (d) => numerals[d]) : fl.amount; }
        el("small", "", li).textContent = fl.direction === "reverse" ? fill(ui.fromTo, { from: b, to: a }) : fl.direction === "both" ? fill(ui.both, { from: a, to: b }) : fill(ui.fromTo, { from: a, to: b });
        li.addEventListener("pointerenter", () => setFlowFocus(fl.id)); li.addEventListener("pointerleave", () => setFocus(selected));
        return li;
      }));
    }
    if (countersEl) {
      countersEl.hidden = !c.counters.length;
      countersEl.replaceChildren(...c.counters.map((k) => {
        const d = el("div"); d.dataset.counter = k.id;
        el("dt", "", d).textContent = k.label;
        const dd = el("dd", "", d), sp = el("span", "", dd); sp.dataset.kwCount = "";
        const txt = typeof k.value === "number" ? String(k.value).replace(/[0-9]/g, (x) => numerals[x]) : k.value;
        sp.textContent = txt; sp.dataset.kwFinal = txt;
        return d;
      }));
      if (count && !reduced()) countersEl.querySelectorAll("[data-kw-count]").forEach((s, i) => setTimeout(() => countUp(s, { numerals, ms: 900 }), 120 * i));
    }
    if (panel) {
      const ul = panel.querySelector(".kw-net__details");
      ul.replaceChildren(...c.nodes.map((nid) => detailItem(nodeData(nid))));
      panel.classList.toggle("has-sel", !!selected);
      ul.querySelectorAll(".kw-net__d").forEach((li) => { li.hidden = li.dataset.node !== selected; });
    }
    const btn = root.querySelector("[data-kw-net-event]");
    if (btn) { btn.hidden = !c.event; btn.textContent = ui.event; btn.onclick = () => runEvent(true); }
  }
  function detailItem(d) {
    const li = el("li", "kw-net__d"); li.dataset.node = d.id;
    el("b", "", li).textContent = d.label;
    if (d.role) { li.append(" "); el("span", "kw-net__role", li).textContent = d.role; }
    if (d.detail) el("p", "kw-net__detail", li).textContent = d.detail;
    if (d.capabilities?.length) { const ul = el("ul", "kw-net__caps", li); ul.setAttribute("aria-label", ui.capabilities); for (const x of d.capabilities) el("li", "", ul).textContent = x; }
    const mine = (cfg?.flows || []).filter((f) => f.from === d.id || f.to === d.id);
    if (mine.length) { const ul = el("ul", "kw-net__mine", li); ul.setAttribute("aria-label", fill(ui.flowsOf, { name: d.label })); for (const f of mine) { const x = el("li", "", ul); x.dataset.tone = toneOf(f.type); x.textContent = f.label; } }
    return li;
  }

  /* ----- focus, selection ----- */
  function setFocus(id) {
    focusId = id || null;
    stage.classList.toggle("is-focused", focusId != null);
    for (const [nid, n] of nodes) n.el.classList.toggle("is-lit", nid === focusId || (focusId != null && flows.some((f) => lit(f) && (f.fl.from === nid || f.fl.to === nid || f.from === nid || f.to === nid))));
    const litKeys = new Set();
    for (const f of flows) if (lit(f)) { const hops = hopsOf(f.from, f.to, data.hub, geomT); for (let i = 0; i + 1 < hops.length; i++) litKeys.add(edgeKey(hops[i], hops[i + 1])); }
    for (const [k, e] of edges) e.path.classList.toggle("is-lit", focusId != null && litKeys.has(k));
    flowsEl?.querySelectorAll(".kw-net__flow").forEach((li) => { const f = flows.find((x) => x.fl.id === li.dataset.flow); li.classList.toggle("is-lit", focusId != null && !!f && lit(f)); li.classList.toggle("is-dim", focusId != null && !(f && lit(f))); });
    tagLayer.replaceChildren();
    if (focusId != null) for (const f of flows) if (lit(f)) {
      const mid = along(f.m, hopsOf(f.from, f.to, data.hub, geomT).length > 2 ? 0.27 : 0.5), t = el("span", "kw-net__tag", tagLayer);
      t.dataset.tone = f.tone; t.textContent = f.fl.label; t.style.transform = `translate3d(${(rtl ? W - mid.x : mid.x) * sign}px,${mid.y}px,0)`;
    }
    kick();
    if (reduced()) draw(performance.now(), true);
  }
  function setFlowFocus(fid) {
    const f = flows.find((x) => x.fl.id === fid); if (!f) return;
    focusId = f.fl.from; setFocus(f.fl.from);
  }
  function select(id) {
    selected = id;
    for (const [nid, n] of nodes) n.el.setAttribute("aria-pressed", String(nid === id));
    if (panel) {
      panel.classList.toggle("has-sel", !!id);
      panel.querySelectorAll(".kw-net__d").forEach((li) => { li.hidden = li.dataset.node !== id; });
      if (id) { const d = panel.querySelector(`.kw-net__d[data-node="${CSS.escape(id)}"]`); if (d) { const mine = (cfg.flows || []).filter((f) => f.from === id || f.to === id); void mine; } }
    }
    setFocus(id);
  }
  stage.addEventListener("click", (e) => { if (e.target === stage || e.target.closest(".kw-net__edges, .kw-net__fx")) select(null); });
  root.addEventListener("keydown", (e) => { if (e.key === "Escape" && selected) { const id = selected; select(null); nodes.get(id)?.el.focus(); } });

  /* ----- failover ----- */
  function setEventUi(done, instant) {
    const e = cfg.event; if (!e) return;
    const fails = nodes.get(e.fails)?.el, reroute = nodes.get(e.reroute)?.el, edge = edges.get(edgeKey(data.hub, e.fails))?.path;
    fails?.classList.toggle("is-fault", !done); fails?.classList.toggle("is-down", done);
    edge?.classList.toggle("is-fault", !done && !!event); edge?.classList.toggle("is-down", done);
    reroute?.classList.toggle("is-takeover", done);
    if (logEl) logEl.textContent = done ? (e.done || e.label) : e.label;
    if (instant) { fails?.classList.remove("is-fault"); }
  }
  function runEvent(animated) {
    const e = cfg?.event; if (!e) return;
    // back to the start, then play
    event = null; setEventUi(false, true); fails0(e);
    buildFlows(cfg, geomT);
    if (!animated || reduced()) { event = { done: true }; buildFlows(cfg, geomT); setEventUi(true, true); setFocus(selected); if (reduced()) draw(performance.now(), true); return; }
    event = { done: false };
    setEventUi(false);
    kick();
    const token = event;
    setTimeout(() => { if (event !== token) return; token.done = true; buildFlows(cfg, geomT); setEventUi(true); setFocus(selected); kick(); }, 1900);
  }
  const fails0 = (e) => { for (const id of [e.fails, e.reroute]) nodes.get(id)?.el.classList.remove("is-fault", "is-down", "is-takeover"); edges.get(edgeKey(data.hub, e.fails))?.path.classList.remove("is-fault", "is-down"); };

  /* ----- the selector ----- */
  root.querySelector("[data-kw-net-select]")?.addEventListener("change", (e) => configuration(e.target.value));
  const tabs = [...root.querySelectorAll("[data-kw-net-view]")];
  tabs.forEach((b, i) => {
    b.addEventListener("click", () => configuration(b.dataset.kwNetView));
    b.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowRight" ? sign : e.key === "ArrowLeft" ? -sign : 0;
      if (step) { e.preventDefault(); const t = tabs[(i + step + tabs.length) % tabs.length]; t.focus(); configuration(t.dataset.kwNetView); }
      if (e.key === "Home") { e.preventDefault(); tabs[0].focus(); configuration(tabs[0].dataset.kwNetView); }
      if (e.key === "End") { e.preventDefault(); tabs.at(-1).focus(); configuration(tabs.at(-1).dataset.kwNetView); }
    });
  });

  /* ----- static painting for reduced motion (arrowheads stay in the SVG; particles are drawn once, at rest) ----- */
  function paintStatic() {
    gArrows.replaceChildren();
    for (const f of flows) {
      const a = sv("path", "kw-net__arrow", gArrows); a.dataset.type = f.fl.type; a.dataset.flow = f.fl.id;
      const s = along(f.m, 0.62), ang = f.fl.direction === "reverse" ? s.angle + Math.PI : s.angle, c = Math.cos(ang), sn = Math.sin(ang), r = 6;
      const pt = (px, py) => `${(s.x + px * c - py * sn).toFixed(1)} ${(s.y + px * sn + py * c).toFixed(1)}`;
      a.setAttribute("d", `M${pt(r, 0)}L${pt(-r * 0.7, r * 0.62)}L${pt(-r * 0.7, -r * 0.62)}Z`);
      if (f.fl.direction === "both") { const b = sv("path", "kw-net__arrow", gArrows); b.dataset.type = f.fl.type; const s2 = along(f.m, 0.38), c2 = Math.cos(s2.angle + Math.PI), n2 = Math.sin(s2.angle + Math.PI); const q = (px, py) => `${(s2.x + px * c2 - py * n2).toFixed(1)} ${(s2.y + px * n2 + py * c2).toFixed(1)}`; b.setAttribute("d", `M${q(r, 0)}L${q(-r * 0.7, r * 0.62)}L${q(-r * 0.7, -r * 0.62)}Z`); }
    }
    root.classList.toggle("is-still", reduced());
    if (reduced()) draw(performance.now(), true);
  }

  /* ----- size changes: the same configuration, laid out again for the new stage (no morph) ----- */
  let lastW = 0;
  function relayout() {
    const nw = Math.round(stage.getBoundingClientRect().width);
    if (!cfg || nw === 0 || tweening) return;
    lastW = nw;
    for (const id of cfg.nodes) measureNode(nodes.get(id));
    const L = layoutFor(cfg); sizeCanvas();
    const boxes = boxesOf(L, cfg), geom = edgesOf(cfg.edges, boxes, { via: viaOf(L) });
    for (const id of cfg.nodes) { const n = nodes.get(id); n.x = L.pos[id].x; n.y = L.pos[id].y; place(n.el, n.x, n.y); }
    hubBox.x = L.hub.x; hubBox.y = L.hub.y; place(hubEl, L.hub.x, L.hub.y);
    for (const [key, g] of Object.entries(geom)) edges.get(key)?.path.setAttribute("d", g.d);
    geomT = geom; buildFlows(cfg, geom); paintStatic(); setFocus(selected);
  }
  const ro = "ResizeObserver" in window ? new ResizeObserver(() => { if (Math.round(stage.getBoundingClientRect().width) !== lastW) relayout(); }) : null;
  ro?.observe(stage);
  onReducedChange(() => { paintStatic(); if (reduced()) { loop.stop(); if (cfg?.event) runEvent(false); } else kick(); });
  if (document.fonts?.ready) document.fonts.ready.then(relayout);

  /* ----- go ----- */
  const start = data.configurations.find((c) => c.id === (root.dataset.cfg || data.default)) || data.configurations[0];
  lastW = Math.round(stage.getBoundingClientRect().width);
  configuration(start.id, { animate: false });
  stage.classList.add("is-awake");
  if (cfg.event && !reduced()) whenSeen(root, () => { if (!event) runEvent(true); }, 0.5);
  else if (cfg.event && reduced()) runEvent(false);
  else whenSeen(root, () => root.querySelectorAll("[data-kw-count]").forEach((s, i) => setTimeout(() => countUp(s, { numerals }), 120 * i)), 0.3);

  return {
    configuration, current: () => cfg?.id, select,
    setData(next, id) { data = next; for (const [, n] of nodes) n.el.remove(); nodes.clear(); cfg = null; configuration(id || next.configurations[0].id, { animate: false }); },
    morphTo(next, id) { data = next; configuration(id, { animate: true, silent: true }); },
    runEvent, destroy() { loop.destroy(); ro?.disconnect(); },
  };
}
