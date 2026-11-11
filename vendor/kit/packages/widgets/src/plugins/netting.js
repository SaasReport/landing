/**
 * The `netting` archetype: the participants' gross positions collapse into net settlement positions. A ring of participants is joined
 * by one gross link for every pair; running it fades the mesh and draws each participant's single net link to the settlement point
 * while the gross figure counts down to the net one. The picture uses only what the spec states: the participants, and the gross and
 * net totals (the ratio sets how far the mesh recedes). Static HTML shows the settled state. No content of its own.
 */
import { pick } from "../scenario-kit.js";
import { numberIn } from "./split.js";

export const SCHEMA = {
  description: "The participants, and the gross and net totals they collapse between.",
  type: "object",
  additionalProperties: false,
  required: ["participants", "gross", "net"],
  properties: {
    participants: { type: "array", minItems: 2, maxItems: 16, items: { $ref: "#/$defs/participant" } },
    gross: { $ref: "#/$defs/line" },
    net: { $ref: "#/$defs/line" },
    count: { description: "The participant count as the project states it (shown beside the totals).", $ref: "#/$defs/line" },
    status: { $ref: "#/$defs/line" },
    cta: { $ref: "#/$defs/text" },
  },
  $defs: {
    participant: { type: "object", additionalProperties: false, required: ["id", "label"], properties: { id: { $ref: "#/$defs/id" }, label: { $ref: "#/$defs/text" } } },
    line: { type: "object", additionalProperties: false, required: ["label", "value"], properties: { label: { $ref: "#/$defs/text" }, value: { $ref: "#/$defs/value" } } },
  },
};


const GEOM = { w: 360, h: 300, cx: 180, cy: 150, r: 112 };
export const place = (i, n) => { const a = -Math.PI / 2 + (i / n) * Math.PI * 2; return [Math.round((GEOM.cx + Math.cos(a) * GEOM.r) * 10) / 10, Math.round((GEOM.cy + Math.sin(a) * GEOM.r) * 10) / 10]; };

export default {
  schema: "kit.widgets-plugin.v1", contract: 1, id: "netting", version: "1.0.0",
  describes: "participants' gross positions collapsing into net settlement positions: a mesh of gross links fades while each participant's net link to settlement is drawn, and the gross figure counts down to the net one",
  reads: [],
  spec: { key: "netting", schema: SCHEMA },
  capabilities: { rtl: true, reducedMotion: true, needsCanvas: false },
  runtime: "../../assets/widgets/plugins/netting.js",
  styles: "../../theme/plugins/netting.css",
  chromeKeys: ["run", "flowStatus"],
  textKeys: ["label", "value", "cta"],
  needs: (sc) => (sc.netting ? null : "needs \"netting\" (participants, gross and net)"),
  derive: (sc) => {
    const n = sc.netting, g = numberIn(n.gross.value), t = numberIn(n.net.value);
    return { ...pick(n, ["participants", "gross", "net", "count", "status", "cta"]), ratio: Number.isFinite(g) && Number.isFinite(t) && g > 0 ? Math.round(Math.min(1, t / g) * 1000) / 1000 : 0.5 };
  },
  render(w, c, f, locale, h) {
    const { esc, val } = h, d = w.data, n = d.participants.length;
    const pts = d.participants.map((_, i) => place(i, n));
    const mesh = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) mesh.push(`<line class="kw-net-mesh" x1="${pts[i][0]}" y1="${pts[i][1]}" x2="${pts[j][0]}" y2="${pts[j][1]}"/>`);
    const spokes = pts.map(([x, y], i) => `<line class="kw-net-spoke" data-i="${i}" x1="${x}" y1="${y}" x2="${GEOM.cx}" y2="${GEOM.cy}"/>`);
    const dots = pts.map(([x, y], i) => `<g class="kw-net-dot" data-i="${i}" transform="translate(${x} ${y})"><circle r="13"/><text text-anchor="middle" dy=".35em">${esc(f.num(i + 1))}</text></g>`);
    const line = (k, l) => `<div data-total="${k}"><dt>${esc(l.label)}</dt><dd><span data-kw-count>${val(c, f, l.value)}</span></dd></div>`;
    return `<div class="kw-netting" data-kw-netting data-ratio="${d.ratio}" data-numerals="${esc(f.numerals)}">
<div class="kw__bar"><button type="button" class="kw-btn" data-kw-netting-run>${esc(d.cta || c.run)}</button></div>
<div class="kw-netting__fig"><svg viewBox="0 0 ${GEOM.w} ${GEOM.h}" class="kw-netting__svg" role="img" aria-label="${esc(d.gross.label)}: ${esc(d.net.label)}">${mesh.join("")}${spokes.join("")}<g class="kw-net-hub" transform="translate(${GEOM.cx} ${GEOM.cy})"><circle r="9"/></g>${dots.join("")}</svg>
<div class="kw-netting__side"><dl class="kw-netting__totals">${line("gross", d.gross)}${line("net", d.net)}${d.count ? line("count", d.count) : ""}${d.status ? line("status", d.status) : ""}</dl>
<ol class="kw-netting__who">${d.participants.map((p, i) => `<li data-i="${i}"><span class="kw-netting__n" aria-hidden="true">${esc(f.num(i + 1))}</span>${esc(p.label)}</li>`).join("")}</ol></div></div>
</div>`;
  },
  check(w) { return w.data.participants.length > 16 ? ["more than 16 participants"] : []; },
};
