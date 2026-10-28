/**
 * A tiny argv parser: positionals, `--flag value`, `--flag=value`, boolean flags and short aliases.
 *   parseArgs(["plan", "--from", "2026-09-30", "--json"], { boolean: ["json"] })
 *   → { _: ["plan"], flags: { from: "2026-09-30", json: true } }
 * A flag listed in `boolean` never consumes the next argument; `--no-x` sets x to false.
 */
/** The CLI's boolean flags (every other flag takes a value): main() and the workflow-command-exists contract read argv the same way. */
export const CLI_BOOLEAN = ["force", "json", "link", "remote", "dry-run", "speakable", "help", "version", "check", "artifact", "all", "write", "history", "runway", "all-pending", "upstream", "yes", "kill", "require-value", "post-status", "alert"];

export function parseArgs(argv, { boolean = [], alias = {} } = {}) {
  const out = { _: [], flags: {} };
  const bools = new Set(boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out._.push(...argv.slice(i + 1)); break; }
    if (/^-[a-zA-Z]$/.test(a)) {
      const name = alias[a.slice(1)] || a.slice(1);
      if (bools.has(name)) out.flags[name] = true;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) out.flags[name] = argv[++i];
      else out.flags[name] = true;
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      let name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      name = alias[name] || name;
      if (eq > 0) { out.flags[name] = a.slice(eq + 1); continue; }
      if (name.startsWith("no-") && bools.has(name.slice(3))) { out.flags[name.slice(3)] = false; continue; }
      if (bools.has(name)) { out.flags[name] = true; continue; }
      const next = argv[i + 1];
      if (next != null && !(next.startsWith("--") || /^-[a-zA-Z]$/.test(next))) { out.flags[name] = next; i++; }
      else out.flags[name] = true;
      continue;
    }
    out._.push(a);
  }
  return out;
}

/** A user-facing error: printed without a stack trace, exit code 1 (or `code`). */
export class CliError extends Error {
  constructor(message, code = 1) { super(message); this.name = "CliError"; this.code = code; }
}

/** A command that knows its flags refuses any other (a flag that is accepted and ignored is a silent pass): throws CliError. */
export function onlyFlags(flags, allowed, command) {
  const unknown = Object.keys(flags).filter((f) => !allowed.includes(f) && !["help", "version"].includes(f));
  if (unknown.length) throw new CliError(`${command}: unknown flag${unknown.length === 1 ? "" : "s"} ${unknown.map((f) => `--${f}`).join(", ")} (accepted: ${allowed.filter((f) => !["cwd", "config"].includes(f)).map((f) => `--${f}`).join(", ") || "none"})`);
}
