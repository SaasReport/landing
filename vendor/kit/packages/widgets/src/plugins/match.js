/**
 * The `match` archetype: reconciliation. Expected records and external records slide together and lock as matched; the ones that do
 * not match turn to the project's attention colour and open an investigation card. The records themselves are not content (the spec
 * states how many there are and how many are exceptions); the picture shows a sample of them. Static HTML shows the reconciled state.
 */
import { pick } from "../scenario-kit.js";
import { numberIn } from "./split.js";

export const SCHEMA = {
  description: "The two sides, their counts, and what to show when an exception is opened.",
  type: "object",
  additionalProperties: false,
  required: ["expected", "external", "records", "matched", "exceptions"],
  properties: {
    expected: { $ref: "#/$defs/text" },
    external: { $ref: "#/$defs/text" },
    records: { $ref: "#/$defs/line" },
    matched: { $ref: "#/$defs/line" },
    exceptions: { $ref: "#/$defs/line" },
    sample: { description: "How many records each side shows (default 8).", type: "integer", minimum: 4, maximum: 16 },
    investigation: { $ref: "#/$defs/investigation" },
    cta: { $ref: "#/$defs/text" },
  },
  $defs: {
    line: { type: "object", additionalProperties: false, required: ["label", "value"], properties: { label: { $ref: "#/$defs/text" }, value: { $ref: "#/$defs/value" } } },
    investigation: {
      type: "object", additionalProperties: false, required: ["title"],
      properties: { title: { $ref: "#/$defs/text" }, text: { $ref: "#/$defs/text" }, fields: { type: "array", items: { $ref: "#/$defs/line" } } },
    },
  },
};

export default {
  schema: "kit.widgets-plugin.v1", contract: 1, id: "match", version: "1.0.0",
  describes: "reconciliation: expected and external records slide together and lock as matched; unmatched ones turn to the attention colour and open an investigation card",
  reads: [],
  spec: { key: "match", schema: SCHEMA },
  capabilities: { rtl: true, reducedMotion: true, needsCanvas: false },
  runtime: "../../assets/widgets/plugins/match.js",
  styles: "../../theme/plugins/match.css",
  chromeKeys: ["run", "close", "matchExpected", "matchExternal", "matchInvestigate"],
  textKeys: ["label", "value", "text", "title", "expected", "external", "cta"],
  needs: (sc) => (sc.match ? null : "needs \"match\" (the two sides, records, matched, exceptions)"),
  derive: (sc) => {
    const m = sc.match, sample = m.sample || 8, ex = numberIn(m.exceptions.value);
    // exception chips: as many as the exceptions the spec states, at most a third of the sample (and at least one when there are any)
    const flagged = Number.isFinite(ex) && ex > 0 ? Math.max(1, Math.min(ex, Math.floor(sample / 3))) : 0;
    return { ...pick(m, ["expected", "external", "records", "matched", "exceptions", "investigation", "cta"]), sample, flagged };
  },
  render(w, c, f, locale, h) {
    const { esc, val, p } = h, d = w.data;
    const flagged = new Set(Array.from({ length: d.flagged }, (_, k) => Math.floor(((k + 1) * d.sample) / (d.flagged + 1))));
    const chip = (side, i) => `<li class="kw-match__rec" data-i="${i}" data-side="${side}"${flagged.has(i) && side === "ext" ? " data-flag" : ""}${flagged.has(i) ? ` data-state="exception"` : ` data-state="matched"`}><i aria-hidden="true"></i></li>`;
    const line = (k, l) => `<div data-total="${k}"><dt>${esc(l.label)}</dt><dd><span data-kw-count>${val(c, f, l.value)}</span></dd></div>`;
    const inv = d.investigation;
    return `<div class="kw-match" data-kw-match data-numerals="${esc(f.numerals)}">
<div class="kw__bar"><button type="button" class="kw-btn" data-kw-match-run>${esc(d.cta || c.run)}</button></div>
<div class="kw-match__grid"><div class="kw-match__col"><h5>${esc(d.expected)}</h5><ol class="kw-match__recs" data-col="exp" aria-hidden="true">${Array.from({ length: d.sample }, (_, i) => chip("exp", i)).join("")}</ol></div>
<div class="kw-match__col"><h5>${esc(d.external)}</h5><ol class="kw-match__recs" data-col="ext" aria-hidden="true">${Array.from({ length: d.sample }, (_, i) => chip("ext", i)).join("")}</ol></div></div>
<dl class="kw-match__totals">${line("records", d.records)}${line("matched", d.matched)}${line("exceptions", d.exceptions)}</dl>
${inv ? `<div class="kw-match__card" data-kw-match-card role="region" aria-label="${esc(c.matchInvestigate)}" tabindex="-1"><button type="button" class="kw-match__x" data-kw-match-close aria-label="${esc(c.close)}">×</button><h5>${esc(inv.title)}</h5>${p("kw-match__text", inv.text)}${inv.fields?.length ? `<dl class="kw-kv">${inv.fields.map((l) => `<div><dt>${esc(l.label)}</dt><dd>${val(c, f, l.value)}</dd></div>`).join("")}</dl>` : ""}</div>` : ""}
<button type="button" class="kw-btn kw-btn--ghost kw-match__open" data-kw-match-open ${inv ? "" : "hidden"}>${esc(inv ? inv.title : "")}</button>
</div>`;
  },
  check: (w) => (w.data.flagged > Math.floor(w.data.sample / 2) ? ["more exceptions flagged than half the sample"] : []),
};
