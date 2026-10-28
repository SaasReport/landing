/**
 * The result of a static triage is evidence, never an authority and never "safe": markers found, or "no known
 * active-content markers found; opening still needs a sandbox". A limit hit or a parse failure makes the analysis
 * incomplete, and an incomplete analysis is at best needs_sandbox.
 */
export const ENGINE = "kit-static-triage";
export const ENGINE_VERSION = "1";

export const STATEMENTS = Object.freeze({
  found: "markers found",
  none: "no known active-content markers found; opening still needs a sandbox",
  incomplete: "analysis incomplete; opening needs a sandbox",
  none_text: "no known active-content markers found",
});

/** The record schema caps these (triage.markers[].first_ref 80, incomplete_because[] 120). What goes in can be attacker text (an entry name, an attribute name), so it is cleaned and clipped here, where it enters. */
export const REF_MAX = 80;
export const WHY_MAX = 120;
const unprintable = (c) => c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x61c || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2060 && c <= 0x2069) || c === 0xfeff || (c >= 0xd800 && c <= 0xdfff);
export function clipText(v, max) {
  let t = "";
  for (const ch of String(v).slice(0, max * 3 + 3)) t += unprintable(ch.codePointAt(0)) ? "?" : ch;
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
}

const RANK = { block: 2, needs_sandbox: 1, info: 0 };
/** Marker reasons, most specific first when several blocks apply. */
const REASON_ORDER = ["archive_bomb", "polyglot_suspect", "archive_not_allowed", "active_content_found"];

export function collector() {
  const markers = new Map();
  const why = [];
  return {
    /** Record a marker (name, severity, reason code for a block/needs_sandbox, a reference such as "obj 12"). */
    add(name, severity, reason = "active_content_found", ref = null) {
      const m = markers.get(name);
      if (m) m.count++;
      else markers.set(name, { name, severity, reason, count: 1, first_ref: ref == null ? null : clipText(ref, REF_MAX) });
    },
    has: (name) => markers.has(name),
    /** A block marker is already the verdict: callers stop spending CPU on further analysis. */
    get blocked() { for (const m of markers.values()) if (m.severity === "block") return true; return false; },
    incomplete(reason) { const r = clipText(reason, WHY_MAX); if (!why.includes(r)) why.push(r); },
    get isComplete() { return why.length === 0; },
    why: () => why.slice(),
    /** { engine, engine_version, complete, markers, statement, verdict, reason_code } */
    finish() {
      const list = [...markers.values()].sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.name.localeCompare(b.name));
      const blocks = list.filter((m) => m.severity === "block");
      const sandbox = list.filter((m) => m.severity === "needs_sandbox");
      const complete = why.length === 0;
      let verdict, reason_code;
      if (blocks.length) { verdict = "block"; reason_code = REASON_ORDER.find((r) => blocks.some((m) => m.reason === r)) || "active_content_found"; }
      else if (sandbox.length || !complete) { verdict = "needs_sandbox"; reason_code = sandbox.length ? "needs_sandbox_review" : "could_not_check"; }
      else { verdict = "allow_with_limits"; reason_code = "none"; }
      const hasFinding = list.some((m) => m.severity !== "info");
      return {
        engine: ENGINE, engine_version: ENGINE_VERSION, complete,
        markers: list.map((m) => ({ name: m.name, severity: m.severity, count: m.count, first_ref: m.first_ref })),
        statement: hasFinding ? STATEMENTS.found : complete ? STATEMENTS.none : STATEMENTS.incomplete,
        verdict, reason_code,
        ...(why.length ? { incomplete_because: why.slice() } : {}),
      };
    },
  };
}
