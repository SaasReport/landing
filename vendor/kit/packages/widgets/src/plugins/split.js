/**
 * The `split` archetype: one amount divides into N allocations, each with its own animated stream. The stream's width follows the
 * allocation's weight (stated in the spec, or read from the digits of its value). Static HTML shows the divided state; the runtime
 * draws the streams, runs a dash along each at its own pace and counts the values up. No content of its own.
 */
import { pick } from "../scenario-kit.js";

export const SCHEMA = {
  description: "One amount and the allocations it divides into.",
  type: "object",
  additionalProperties: false,
  required: ["amount", "allocations"],
  properties: {
    amount: { $ref: "#/$defs/line" },
    allocations: { type: "array", minItems: 2, maxItems: 12, items: { $ref: "#/$defs/allocation" } },
    cta: { $ref: "#/$defs/text" },
  },
  $defs: {
    line: { type: "object", additionalProperties: false, required: ["label", "value"], properties: { label: { $ref: "#/$defs/text" }, value: { $ref: "#/$defs/value" } } },
    allocation: {
      type: "object", additionalProperties: false, required: ["id", "label", "value"],
      properties: { id: { $ref: "#/$defs/id" }, label: { $ref: "#/$defs/text" }, value: { $ref: "#/$defs/value" }, weight: { description: "Its share of the amount (any positive number); default: the number in its value.", type: "number", exclusiveMinimum: 0 } },
    },
  },
};

/** The first number written in a value ("£1,234.50" → 1234.5), or NaN. */
export const numberIn = (v) => {
  if (typeof v === "number") return v;
  const m = /[\d٠-٩۰-۹][\d,.٬٫٠-٩۰-۹]*/.exec(String(v));
  if (!m) return NaN;
  const d = m[0].replace(/[٠-٩]/g, (c) => c.charCodeAt(0) - 0x660).replace(/[۰-۹]/g, (c) => c.charCodeAt(0) - 0x6f0).replace(/٬/g, ",").replace(/٫/g, ".");
  const n = Number(d.replace(/,(?=\d{3}\b)/g, "").replace(/,/g, "."));
  return Number.isFinite(n) ? n : NaN;
};

export default {
  schema: "kit.widgets-plugin.v1", contract: 1, id: "split", version: "1.0.0",
  describes: "one amount dividing into allocations, each with its own animated stream whose width follows its share",
  reads: [],
  spec: { key: "split", schema: SCHEMA },
  capabilities: { rtl: true, reducedMotion: true, needsCanvas: false },
  runtime: "../../assets/widgets/plugins/split.js",
  styles: "../../theme/plugins/split.css",
  chromeKeys: ["run", "splitAllocations"],
  textKeys: ["label", "value", "cta"],
  needs: (sc) => {
    if (!sc.split) return "needs \"split\" (an amount and its allocations)";
    const ids = new Set(sc.split.allocations.map((a) => a.id));
    return ids.size === sc.split.allocations.length ? null : "has two allocations with the same id";
  },
  derive: (sc) => {
    const s = sc.split;
    const raw = s.allocations.map((a) => a.weight ?? numberIn(a.value));
    const ok = raw.every((n) => Number.isFinite(n) && n > 0);
    const total = ok ? raw.reduce((x, y) => x + y, 0) : s.allocations.length;
    return {
      amount: s.amount, ...(s.cta ? { cta: s.cta } : {}),
      allocations: s.allocations.map((a, i) => ({ ...pick(a, ["id", "label", "value"]), share: Math.round(((ok ? raw[i] : 1) / total) * 1000) / 1000 })),
    };
  },
  render(w, c, f, locale, h) {
    const { esc, val } = h, d = w.data, n = d.allocations.length, ROW = 52, H = n * ROW;
    const max = Math.max(...d.allocations.map((a) => a.share));
    const band = (a, i) => {
      const y = ROW * i + ROW / 2, sw = Math.max(3, Math.round(4 + (a.share / max) * 18));
      const d = `M0 ${H / 2}C150 ${H / 2} 150 ${y} 300 ${y}`;
      return `<path class="kw-split__band" data-alloc="${esc(a.id)}" style="--sw:${sw};--i:${i}" d="${d}"/><path class="kw-split__streak" data-alloc="${esc(a.id)}" style="--sw:${sw};--i:${i}" d="${d}"/>`;
    };
    return `<div class="kw-split" data-kw-split data-numerals="${esc(f.numerals)}">
<div class="kw__bar"><button type="button" class="kw-btn" data-kw-split-run>${esc(d.cta || c.run)}</button></div>
<div class="kw-split__fig" style="--n:${n}">
<div class="kw-split__src"><span>${esc(d.amount.label)}</span><b data-kw-count>${val(c, f, d.amount.value)}</b></div>
<svg class="kw-split__bands" viewBox="0 0 300 ${H}" preserveAspectRatio="none" aria-hidden="true" focusable="false">${d.allocations.map(band).join("")}</svg>
<ul class="kw-split__to" aria-label="${esc(c.splitAllocations)}">${d.allocations.map((a) => `<li data-alloc="${esc(a.id)}"><span>${esc(a.label)}</span><b data-kw-count>${val(c, f, a.value)}</b><i class="kw-split__bar" style="--share:${a.share}" aria-hidden="true"></i></li>`).join("")}</ul>
</div>
</div>`;
  },
  check(w) {
    const p = [], s = w.data.allocations.reduce((x, a) => x + a.share, 0);
    if (Math.abs(s - 1) > 0.02) p.push(`the shares add up to ${s.toFixed(3)}, not 1`);
    return p;
  },
};
