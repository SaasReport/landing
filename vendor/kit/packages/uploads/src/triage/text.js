/** Plain text and JSON triage: nothing active to find, but a CSV cell that starts like a formula is noted (an export to a spreadsheet would run it). */
import { latin1 } from "../bytes.js";
import { collector, STATEMENTS } from "./collector.js";
import { skipSpace, isAlpha } from "../lex.js";
import { tick } from "../work.js";

export const TEXT_MARKERS = Object.freeze({ formula_like_cells: "info" });

/** A cell that starts like a formula: =, @, or + / - followed by a letter or "(" (after spaces and one quote). */
function formulaLike(cell) {
  let i = skipSpace(cell, 0);
  if (cell[i] === '"' || cell[i] === "'") i++;
  const c = cell[i];
  if (c === "=" || c === "@") return true;
  return (c === "+" || c === "-") && (isAlpha(cell.charCodeAt(i + 1)) || cell[i + 1] === "(");
}

export function triageText(bytes) {
  const c = collector();
  const t = latin1(bytes, 0, Math.min(bytes.length, 1024 * 1024));
  tick(t.length);
  for (const line of t.split("\n", 5000)) {   // a trailing \r stays on the last cell, which no rule reads
    let from = 0;
    for (let i = 0; i <= line.length; i++) {
      if (i < line.length && line[i] !== "," && line[i] !== ";" && line[i] !== "\t") continue;
      if (formulaLike(line.slice(from, i))) { c.add("formula_like_cells", "info", "none"); break; }
      from = i + 1;
    }
  }
  if (bytes.length > 1024 * 1024) c.incomplete("text over the inspection cap");
  const r = c.finish();
  // text and JSON hold no active content of their own: with the analysis complete the triage allows it (the scanner still decides)
  return r.verdict === "allow_with_limits" ? { ...r, verdict: "allow", statement: r.statement === STATEMENTS.none ? STATEMENTS.none_text : r.statement } : r;
}
