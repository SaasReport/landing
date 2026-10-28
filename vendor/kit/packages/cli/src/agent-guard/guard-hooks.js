/**
 * The hooks the guard installs into .claude/settings.json, as pure data (docs/AGENT-GUARD.md). One definition: `kit agent-guard sync` writes
 * it, `kit check canon` (enforcement) compares against it, and the engine's guard-tamper rule refuses an edit that removes it. Zero dependencies.
 *
 * Every hook is `bash hook.sh || exit 2`: bash builtins talk to the resident decision daemon over loopback TCP, so no process is started per call
 * beyond bash itself. It FAILS CLOSED: any failure to get a 200 from the daemon (and one restart attempt) exits 2, the only code that blocks.
 * (A Claude Code `http` hook would avoid even bash but FAILS OPEN on a refused connection and on a 500: tested 2026-10-07.)
 */
export const HOOK_TIMEOUT_S = 10;
export const ADDR_FILE = ".claude/guard.addr";
const OWNED = /agent-guard\//;   // every generation of the guard's own path (hook.mjs, daemon.mjs, hook.sh, launcher.*): a stale entry that points at a deleted file would hold every tool call
export const isOwned = (entry) => (entry?.hooks || []).some((h) => OWNED.test(h?.command || ""));

/** The command for the guard pack whose daemon.mjs is at `rel` (relative to the project directory). `start`: bring the daemon up first (SessionStart). */
export const hookCommand = (rel, { start = false } = {}) => `bash "$CLAUDE_PROJECT_DIR/${rel.replace(/\/[^/]+$/, "")}/hook.sh"${start ? " start" : ""} || exit 2`;

/** { event: [entry…] } for the daemon script at `rel`. Every boundary an agent's action passes inside Claude Code. */
export function desiredHooks(rel) {
  const entry = (matcher, opts) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: hookCommand(rel, opts), timeout: HOOK_TIMEOUT_S }] });
  return {
    SessionStart: [entry("startup|resume|clear|compact", { start: true })],
    UserPromptSubmit: [entry()],
    PreToolUse: [entry("*")],      // EVERY tool: the engine holds any tool outside its declared classes
    SubagentStart: [entry()],
    SubagentStop: [entry()],
    ConfigChange: [entry("project_settings|local_settings|user_settings")],
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** settings with the guard's entries replaced by the desired ones; every other hook kept, in place. */
export function mergeHooks(settings, rel) {
  const out = { ...(settings && typeof settings === "object" ? settings : {}) };
  const hooks = {};
  for (const [ev, list] of Object.entries(out.hooks || {})) { const keep = (list || []).filter((e) => !isOwned(e)); if (keep.length) hooks[ev] = keep; }
  for (const [ev, list] of Object.entries(desiredHooks(rel))) hooks[ev] = [...(hooks[ev] || []), ...list];
  out.hooks = hooks;
  return out;
}

/** Are all guard hooks present exactly as desired (and hooks not switched off)? */
export function hooksIntact(settings, rel) {
  if (!settings || settings.disableAllHooks === true) return false;
  for (const [ev, want] of Object.entries(desiredHooks(rel))) {
    const have = (settings.hooks?.[ev] || []).filter(isOwned);
    if (have.length !== want.length || !want.every((w, i) => same(w, have[i]))) return false;
  }
  return true;
}
