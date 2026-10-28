/* Pure layout and geometry for the network archetype: where nodes sit (rings, sides, tiers, and a ladder on a phone),
   how curved edges run between their borders, and the routes flows travel. No DOM, no content: the build (node) uses it
   for the static HTML and the runtime (browser) uses the very same functions, so the page does not jump when it wakes up. */

export const NARROW_MAX = 520;                 // a stage narrower than this (px) uses the ladder
export const WIDE_REF = { w: 720, h: 460 };    // the stage the static HTML is laid out for (it scales: positions are fractions)
export const NARROW_REF = { w: 360 };
export const PILL_H = 34;
export const HUB = { w: 96, h: 104, r: 44, dy: 14 };   // the mark with its halo and the caption beneath it (w grows with the caption)
/** The hub's box for trimming edges and keeping pills away: the mark and its caption, centred on the mark's centre plus dy. */
export const hubBox = (x, y, labelW = 0) => ({ x, y: y + HUB.dy, w: Math.max(HUB.w, labelW), h: HUB.h });
export const LADDER = { hubY: 58, firstY: 168, row: 46, pad: 14 };
export const CLASSES = ["participant", "provider", "infrastructure"];

const q4 = (n) => Math.ceil(n / 4) * 4;
/** A conservative width for a node's pill from its label (px, 13 px type with padding); the runtime measures the real one. */
export const labelWidth = (label) => q4(Math.max(84, Array.from(String(label)).length * 7.4 + 48));
export const sizeOf = (label) => ({ w: labelWidth(label), h: PILL_H });

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

/** Nodes of a configuration in draw order: classes in CLASSES order, then the spec's own order within a class. */
export function ordered(nodes) {
  return CLASSES.flatMap((c) => nodes.filter((n) => n.cls === c)).concat(nodes.filter((n) => !CLASSES.includes(n.cls)));
}

const twoColumns = (nodes, sizes, width) => nodes.length > 1 && nodes.every((n) => (sizes[n.id]?.w ?? 120) <= width / 2 - 24);
function split2(nodes) {
  const side = (n) => (n.cls === "participant" ? 0 : 1);
  let left = nodes.filter((n) => side(n) === 0), right = nodes.filter((n) => side(n) === 1);
  if (!left.length || !right.length) { const all = ordered(nodes); left = all.filter((_, i) => i % 2 === 0); right = all.filter((_, i) => i % 2 === 1); }
  return { left, right };
}
/** Rows a phone ladder needs for these nodes (the stage reserves the tallest configuration's height). */
export function ladderRows(nodes, sizes, width) {
  const list = ordered(nodes);
  if (!twoColumns(list, sizes, width)) return list.length;
  const { left, right } = split2(list);
  return Math.max(left.length, right.length);
}
export const ladderHeight = (rows) => LADDER.firstY + (Math.max(rows, 1) - 1) * LADDER.row + PILL_H / 2 + LADDER.pad;

/**
 * Positions for one configuration.
 *   { nodes: [{id, cls}], sizes: {id: {w,h}}, layout: "rings"|"sides"|"tiers", mode: "wide"|"narrow", width, height?, rtl }
 *   → { width, height, hub: {x,y}, pos: {id: {x,y}} }   x is measured from the start edge (the page mirrors it in RTL, see `physical`)
 */
export function layoutNetwork({ nodes, sizes, layout = "rings", mode = "wide", width, height, hubW = 0 }) {
  const list = ordered(nodes);
  const size = (n) => sizes[n.id] || sizeOf(n.id);
  const pos = {};
  if (mode === "narrow") {
    const W = width, two = twoColumns(list, sizes, W);
    const hub = { x: W / 2, y: LADDER.hubY };
    let rows = list.length;
    if (two) {
      const { left, right } = split2(list), cl = 0.25, cr = 0.75;
      left.forEach((n, i) => { pos[n.id] = { x: W * cl, y: LADDER.firstY + i * LADDER.row }; });
      right.forEach((n, i) => { pos[n.id] = { x: W * cr, y: LADDER.firstY + i * LADDER.row }; });
      rows = Math.max(left.length, right.length);
    } else list.forEach((n, i) => { pos[n.id] = { x: W / 2, y: LADDER.firstY + i * LADDER.row }; });
    return { width: W, height: Math.max(height || 0, ladderHeight(rows)), hub, pos, cols: two ? 2 : 1 };
  }
  const W = width, H = height || Math.round((width * WIDE_REF.h) / WIDE_REF.w);
  const cx = W / 2, cy = H / 2 - 4;
  const maxW = Math.max(0, ...list.map((n) => size(n).w));
  const rxMax = Math.max(80, W / 2 - maxW / 2 - 12), ryMax = Math.max(70, H / 2 - PILL_H / 2 - 14);
  const place = (n, x, y) => { pos[n.id] = { x, y }; };
  const base = { width: W, height: H, pos, list, sizes, hubW };
  if (layout === "tiers") {
    const rows = CLASSES.map((c) => list.filter((n) => n.cls === c)).filter((r) => r.length);
    const top = 62, first = top + 124, last = H - 34, step = rows.length > 1 ? (last - first) / (rows.length - 1) : 0;
    rows.forEach((r, ri) => r.forEach((n, i) => place(n, ((i + 1) / (r.length + 1)) * W, rows.length > 1 ? first + ri * step : last - 20)));
    return resolve({ ...base, hub: { x: W / 2, y: top } });
  }
  if (layout === "sides") {
    const start = list.filter((n) => n.cls === "participant"), end = list.filter((n) => n.cls !== "participant");
    const arc = (group, sign) => group.forEach((n, i) => {
      const m = group.length, th = m === 1 ? 0 : (i / (m - 1) - 0.5) * 2 * (m > 6 ? 1.12 : 0.98);
      place(n, cx + sign * Math.cos(th) * rxMax * (m > 5 && i % 2 ? 0.8 : 1), cy + Math.sin(th) * ryMax);
    });
    arc(start, -1); arc(end, 1);
    return resolve({ ...base, hub: { x: cx, y: cy } });
  }
  // rings: one ellipse per class present, the inner ones smaller
  const rings = CLASSES.map((c) => list.filter((n) => n.cls === c)).filter((r) => r.length);
  rings.forEach((r, ri) => {
    const k = rings.length === 1 ? 1 : rings.length === 2 ? [0.56, 1][ri] : [0.44, 0.74, 1][ri];
    r.forEach((n, i) => {
      const a = -Math.PI / 2 + ri * ((Math.PI * 2) / 3) * (rings.length > 1 ? 1 : 0) + ((i + (r.length > 1 ? 0 : 0)) / r.length) * Math.PI * 2 + (r.length > 1 && ri % 2 ? Math.PI / r.length : 0);
      place(n, cx + Math.cos(a) * rxMax * k, cy + Math.sin(a) * ryMax * k);
    });
  });
  return resolve({ ...base, hub: { x: cx, y: cy } });
}

/** Push overlapping pills apart (the hub is fixed) and keep every pill inside the stage. Deterministic. */
function resolve({ width: W, height: H, hub, pos, list, sizes, hubW }) {
  const size = (n) => sizes[n.id] || sizeOf(n.id);
  const pad = 10, items = list.map((n) => ({ id: n.id, w: size(n).w, h: size(n).h, ...pos[n.id] }));
  const hb = hubBox(hub.x, hub.y, hubW); hb.w += 8;
  const clampAll = () => items.forEach((it) => { it.x = clamp(it.x, it.w / 2 + 4, W - it.w / 2 - 4); it.y = clamp(it.y, it.h / 2 + 4, H - it.h / 2 - 4); });
  for (let pass = 0; pass < 60; pass++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      const a = items[i];
      const dx = a.x - hb.x, dy = a.y - hb.y, ox = (a.w + hb.w) / 2 + pad - Math.abs(dx), oy = (a.h + hb.h) / 2 + pad - Math.abs(dy);
      if (ox > 0 && oy > 0) { if (ox < oy) a.x += (dx >= 0 ? 1 : -1) * ox; else a.y += (dy >= 0 ? 1 : -1) * oy; moved = true; }
      for (let j = i + 1; j < items.length; j++) {
        const b = items[j], ddx = b.x - a.x, ddy = b.y - a.y, px = (a.w + b.w) / 2 + pad - Math.abs(ddx), py = (a.h + b.h) / 2 + pad - Math.abs(ddy);
        if (px > 0 && py > 0) {
          if (py <= px) { const s = ddy >= 0 ? 1 : -1; a.y -= (s * py) / 2; b.y += (s * py) / 2; } else { const s = ddx >= 0 ? 1 : -1; a.x -= (s * px) / 2; b.x += (s * px) / 2; }
          moved = true;
        }
      }
    }
    clampAll();
    if (!moved) break;
  }
  const out = {};
  for (const it of items) out[it.id] = { x: Math.round(it.x * 10) / 10, y: Math.round(it.y * 10) / 10 };
  return { width: W, height: H, hub, pos: out };
}

/* ---------- curved edges ---------- */

const quad = (p0, c, p1, t) => { const u = 1 - t; return [u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]]; };
const inBox = (p, b) => Math.abs(p[0] - b.x) <= b.w / 2 + 3 && Math.abs(p[1] - b.y) <= b.h / 2 + 3;
const r1 = (n) => Math.round(n * 10) / 10;

/**
 * A curved edge between two boxes {x, y, w, h} (centre and size), trimmed to their borders; `bow` bends it (a signed
 * fraction of its length).  → { d: SVG path, pts: [[x,y] × 24] along the visible curve, len }
 */
export function edgeCurve(a, b, bow = 0.14, through = null) {
  const dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy) || 1;
  const p0 = [a.x, a.y], p1 = [b.x, b.y], c = through || [(a.x + b.x) / 2 - dy * bow, (a.y + b.y) / 2 + dx * bow];
  let t0 = 0, t1 = 1;
  for (let i = 0; i <= 60; i++) { const t = i / 60; if (!inBox(quad(p0, c, p1, t), a)) { t0 = t; break; } }
  for (let i = 60; i >= 0; i--) { const t = i / 60; if (!inBox(quad(p0, c, p1, t), b)) { t1 = t; break; } }
  if (t1 <= t0) { t0 = 0; t1 = 1; }
  // the sub-curve [t0, t1] of a quadratic: its control point is the start plus (t1 - t0) times the start tangent / 2
  const s = quad(p0, c, p1, t0), e = quad(p0, c, p1, t1);
  const k = t1 - t0, ctl = [s[0] + k * ((1 - t0) * (c[0] - p0[0]) + t0 * (p1[0] - c[0])), s[1] + k * ((1 - t0) * (c[1] - p0[1]) + t0 * (p1[1] - c[1]))];
  const pts = Array.from({ length: 24 }, (_, i) => quad(s, ctl, e, i / 23)).map(([x, y]) => [r1(x), r1(y)]);
  let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return { d: `M${r1(s[0])} ${r1(s[1])}Q${r1(ctl[0])} ${r1(ctl[1])} ${r1(e[0])} ${r1(e[1])}`, pts, len: Math.round(len), dist };
}

/**
 * An elbow edge for the phone ladder: out of `a` along `way` waypoints (each [x, y]) into `b`'s side, corners rounded by `r`.
 * Same result shape as edgeCurve. Never leaves the gutter, so it never crosses a pill.
 */
export function edgeElbow(a, b, way, r = 14) {
  const end = [b.x + (way.at(-1)[0] < b.x ? -1 : 1) * (b.w / 2 + 2), b.y];
  const start = [a.x, a.y + HUB.dy + HUB.h / 2 - 2];
  const P = [start, ...way, end];
  let d = `M${r1(P[0][0])} ${r1(P[0][1])}`;
  const pts = [P[0]];
  for (let i = 1; i < P.length - 1; i++) {
    const p = P[i - 1], c = P[i], n = P[i + 1];
    const l1 = Math.hypot(c[0] - p[0], c[1] - p[1]) || 1, l2 = Math.hypot(n[0] - c[0], n[1] - c[1]) || 1, k = Math.min(r, l1 / 2, l2 / 2);
    const a1 = [c[0] - ((c[0] - p[0]) / l1) * k, c[1] - ((c[1] - p[1]) / l1) * k], a2 = [c[0] + ((n[0] - c[0]) / l2) * k, c[1] + ((n[1] - c[1]) / l2) * k];
    d += `L${r1(a1[0])} ${r1(a1[1])}Q${r1(c[0])} ${r1(c[1])} ${r1(a2[0])} ${r1(a2[1])}`;
    pts.push(a1, quad(a1, c, a2, 0.5), a2);
  }
  d += `L${r1(end[0])} ${r1(end[1])}`; pts.push(end);
  let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  // resample to 24 evenly spaced points (flows and arrows read them)
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const out = Array.from({ length: 24 }, (_, k) => { const t = (cum.at(-1) * k) / 23; let i = 1; while (i < pts.length - 1 && cum[i] < t) i++; const f = (t - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1); return [r1(pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f), r1(pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f)]; });
  return { d, pts: out, len: Math.round(len), dist: len };
}

/** Edge key, undirected. */
export const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

const BOWS = [0.12, -0.12, 0.3, -0.3, 0.5, -0.5];
/** True when a polyline passes through a box other than the two it joins (a label is never crossed by an edge). */
const crosses = (pts, boxes, skip) => Object.entries(boxes).some(([id, b]) => !skip.includes(id) && pts.some((p) => Math.abs(p[0] - b.x) < b.w / 2 + 6 && Math.abs(p[1] - b.y) < b.h / 2 + 6));

/**
 * The geometry of a configuration's edges: [[a, b], …] and boxes id → {x, y, w, h} → { key: {a, b, d, pts, len, bow} }.
 * Each edge takes the gentlest bend that keeps it off every other label (the first of BOWS that does); `bows` (key → bow)
 * replays a choice, so a morph does not flip curves from frame to frame.
 */
export function edgesOf(edges, boxes, { bows, via } = {}) {
  const out = {};
  edges.forEach(([a, b]) => {
    if (!boxes[a] || !boxes[b]) return;
    const key = edgeKey(a, b), through = via?.(a, b, boxes) || null;
    let pick = through ? null : bows?.[key];
    if (pick === undefined) {
      pick = BOWS[0];
      for (const bow of BOWS) { if (!crosses(edgeCurve(boxes[a], boxes[b], bow).pts, boxes, [a, b])) { pick = bow; break; } }
    }
    const { dist, ...e } = through ? edgeElbow(boxes[through.hub], boxes[through.node], through.way) : edgeCurve(boxes[a], boxes[b], pick ?? 0);
    if (through && a !== through.hub) e.pts = [...e.pts].reverse();
    out[key] = { a, b, ...e, bow: pick };
  });
  return out;
}

/**
 * On a phone ladder every spoke runs down the gutter between the two columns (or the margin beside a single column) and turns
 * into its pill from the side, so no edge ever crosses a pill above its target. `via(a, b, boxes)` for edgesOf.
 */
export function gutterVia({ hubId, width, cols }) {
  return (a, b, boxes) => {
    if (a !== hubId && b !== hubId) return null;
    const n = boxes[a === hubId ? b : a];
    if (!n) return null;
    const gx = cols === 2 ? width / 2 : n.x > width / 2 ? width - 5 : 5, h = boxes[hubId];
    const way = gx === h.x ? [[gx, n.y]] : [[gx, h.y + HUB.dy + HUB.h / 2 + 6], [gx, n.y]];
    return { hub: hubId, node: a === hubId ? b : a, way };
  };
}

/** The polyline a flow travels (from → to) along edges; through the hub when the two are not joined directly, or through `via`. */
export function routeOf(from, to, hubId, geom, via = null) {
  const hops = hopsOf(from, to, hubId, geom, via);
  const pts = [];
  for (let i = 0; i + 1 < hops.length; i++) {
    const e = geom[edgeKey(hops[i], hops[i + 1])];
    if (!e) return null;
    const seg = e.a === hops[i] ? e.pts : [...e.pts].reverse();
    pts.push(...(pts.length ? seg.slice(1) : seg));
  }
  return pts;
}

/** Cumulative lengths of a polyline (computed once per route). */
export function measure(pts) {
  let total = 0; const cum = [0];
  for (let i = 1; i < pts.length; i++) { total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); cum.push(total); }
  return { pts, cum, total };
}

/** The point and heading at a fraction of a measured polyline. */
export function along(m, u) {
  const { pts, cum, total } = m;
  const target = clamp(u, 0, 1) * total;
  let i = 1; while (i < pts.length - 1 && cum[i] < target) i++;
  const span = cum[i] - cum[i - 1] || 1, f = (target - cum[i - 1]) / span;
  return { x: pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, y: pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f, angle: Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]) };
}

/** A small arrowhead (SVG path) at a fraction of a route, pointing the way the money moves. */
export function arrowPath(m, u = 0.62, size = 6, reverse = false) {
  const at = along(m, u), { x, y } = at, angle = reverse ? at.angle + Math.PI : at.angle, c = Math.cos(angle), s = Math.sin(angle);
  const pt = (px, py) => `${r1(x + px * c - py * s)} ${r1(y + px * s + py * c)}`;
  return `M${pt(size, 0)}L${pt(-size * 0.7, size * 0.62)}L${pt(-size * 0.7, -size * 0.62)}Z`;
}

/** The physical x of a logical one (measured from the start edge): mirrored in a right-to-left page. */
export const physical = (x, width, rtl) => (rtl ? width - x : x);

/** Hops (node ids) a flow travels: direct when the two are joined, else through the hub, or through `via`. */
export function hopsOf(from, to, hubId, geom, via = null) {
  return via ? [from, via, to] : geom[edgeKey(from, to)] ? [from, to] : [from, hubId, to];
}

/** Percentages for the static HTML: positions as fractions of the reference stage. */
export const pct = (v, total) => `${Math.round((v / total) * 10000) / 100}%`;
