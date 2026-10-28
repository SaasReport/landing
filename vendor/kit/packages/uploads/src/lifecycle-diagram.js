/**
 * The lifecycle state diagrams, GENERATED from lifecycle.json (the one source), in three views so each stays readable on a phone:
 *   "intake"   the operations that create or undo a record (rows that start from no record or from pending: intake, rollback)
 *   "disposal" the operations that only end a record (every row goes to deleted: delete)
 *   "review"   the rest: release, rescan, and the operations that keep the stage (hold, migrate, a rescan with no change)
 * together they are the whole table (a test fails if an operation is in neither). An edge is a (from, to) pair labelled with its operations and
 * actors; operations that leave the stage unchanged are one self-loop per state. `packages/uploads/scripts/lifecycle-diagram.mjs` writes the
 * bodies into docs/diagrams/upload-lifecycle*.mmd and docs/UPLOADS.md; a test fails when any of them differs from this output.
 */
import { SPEC, TABLE } from "./lifecycle.js";

export const VIEWS = Object.freeze(["intake", "review", "disposal"]);
const rows = (via) => SPEC.transitions.filter((t) => t.via === via);
/** The view an operation belongs to, from the shape of its table rows: it creates or undoes a record, it only ends one, or it is a review of a stored upload. */
const viewOf = (via) => (rows(via).every((t) => t.from.every((f) => f === null || f === "pending")) ? "intake" : rows(via).every((t) => t.to.every((x) => x === "deleted")) ? "disposal" : "review");

export function lifecycleMermaid(view) {
  if (!VIEWS.includes(view)) throw new Error(`unknown lifecycle view ${view}`);
  const lines = ["stateDiagram-v2", "  direction TB"];
  const edges = new Map(), loops = new Map();
  for (const [key, rows] of TABLE) {
    const [from, to] = key.split(">");
    const own = rows.filter((r) => viewOf(r.via) === view);
    if (!own.length) continue;
    const label = view === "disposal" ? own.map((r) => r.via).join(", ") : own.map((r) => `${r.via} (${r.actors.join("/")})`).join(", ");   // the disposal view says who in one note, so its five edges stay narrow
    if (from === to) loops.set(from, own.map((r) => r.via).join(", ")); else edges.set(key, label);
  }
  const order = (s) => (s === "null" ? -1 : Object.keys(SPEC.states).indexOf(s));
  for (const [key, label] of [...edges].sort(([a], [b]) => { const [af, at] = a.split(">"), [bf, bt] = b.split(">"); return order(af) - order(bf) || order(at) - order(bt); })) {
    const [from, to] = key.split(">");
    lines.push(`  ${from === "null" ? "[*]" : from} --> ${to}: ${label}`);
  }
  for (const [state, label] of [...loops].sort(([a], [b]) => order(a) - order(b))) lines.push(`  ${state} --> ${state}: ${label}: same stage`);
  if (view === "disposal") {
    const who = [...new Set(SPEC.transitions.filter((t) => viewOf(t.via) === "disposal").flatMap((t) => t.actors))];
    lines.push(`  note right of deleted: delete by ${who.join(", ")}`);
  }
  if (view === "disposal") for (const [name, def] of Object.entries(SPEC.states)) if (def.terminal) lines.push(`  ${name} --> [*]`);
  lines.push(`  class ${view === "intake" ? "pending" : view === "disposal" ? "deleted" : "released"} accent`);   // the view's key state; the render adds the theme's accent definition
  return lines.join("\n");
}
