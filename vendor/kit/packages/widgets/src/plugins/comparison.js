/** The `comparison` archetype as a plugin (kit.widgets-plugin.v1): moved from the engine core with no change of output. */
import { esc, val } from "../html-kit.js";

export default {
  schema: "kit.widgets-plugin.v1", contract: 1, id: "comparison", version: "1.0.0",
  describes: "options side by side (columns) on the criteria the spec lists (rows)",
  reads: ["compare"],
  capabilities: { rtl: true, reducedMotion: true, needsCanvas: false },
  runtime: "../../assets/widgets/plugins/comparison.js",
  needs: (sc) => (sc.compare ? null : "needs \"compare\" (columns and rows)"),
  derive: (sc) => ({ columns: sc.compare.columns, rows: sc.compare.rows }),
  render(w, c, f, locale, h) {
    return `<div class="kw-scroll" tabindex="0" role="region" aria-label="${esc(w.title)}"><table class="kw-cmp"><thead><tr><td></td>${w.data.columns.map((col) => `<th scope="col"><button type="button" class="kw-cmp__pick" data-kw-col="${esc(col.id)}" aria-pressed="false">${esc(col.label)}</button></th>`).join("")}</tr></thead>
<tbody>${w.data.rows.map((r) => `<tr><th scope="row">${esc(r.label)}</th>${w.data.columns.map((col) => `<td data-col="${esc(col.id)}">${val(c, f, r.cells[col.id] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  },
  check: () => [],
};
