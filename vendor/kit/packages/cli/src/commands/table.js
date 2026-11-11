/**
 * The command table: every `kit <command> [<subcommand>]` the CLI accepts, in one place. The dispatchers' accepted
 * branches are proven equal to it (test/command-table.test.mjs: read from the code, never from messages), main refuses
 * any subcommand it does not name before a dispatcher runs, HELP lists every entry, and the
 * workflow-command-exists contract (finding-classes.json, run by canon/engine.js) refuses a workflow or npm script that calls a command the repository's
 * kit does not have. An empty list means the command takes no subcommand (positional arguments are not subcommands);
 * `optional` marks commands that also run with no subcommand.
 */
import { CHECKS } from "../canon/index.js";

export const COMMAND_TABLE = {
  init: [],
  check: { subs: ["canon", ...CHECKS, "podcast", "concepts", "shariah-review", "lockfile", "fa-review", "staleness"], optional: true },
  plan: [],
  render: [],
  publish: [],
  status: [],
  migrate: [],
  deploy: [],
  purge: [],
  site: ["build", "check", "shell", "shell-qa", "contrast-qa", "visual-qa", "search-qa"],
  plugin: ["new", "check"],
  diagrams: ["theme", "derive", "themes", "render", "migrate", "check"],
  widgets: ["build", "check", "qa"],
  vendor: ["sync", "check", "publish-head"],
  source: ["init", "sync", "check", "record"],
  decide: { subs: ["eval"], optional: true },
  sdk: ["generate", "check"],
  podcast: ["migrate", "drill"],
  migrations: ["sync"],
  claude: ["sync", "check", "policy", "budget", "managed"],
  persian: ["fix", "review", "approve", "baseline", "migrate", "reject", "withdraw"],
  concepts: ["status", "schedule", "script", "verify"],
  shariah: ["init", "review", "approve", "reject", "withdraw"],
  ledger: ["keygen", "verify", "roster", "witness-sql", "witness-bootstrap"],
  trust: ["propose", "body", "attach", "verify", "signer-hash"],
  docs: ["export-view"],
  "agent-guard": ["sync", "check", "coverage", "managed", "github", "daemon", "evidence", "decide", "audit", "reconcile", "bench", "identity"],
  resilience: ["check", "record-drill", "watch", "keepalive", "secrets", "report", "canary"],
  release: ["check", "build", "ship", "verify", "drills", "workers", "head-check", "deployer-check", "review-marker", "records", "status-url"],
  comms: ["check", "secrets"],
  ci: ["unstarted", "hold"],
};

/** { subs, optional } for a command, or null when the CLI has no such command. */
export function commandEntry(name, table = COMMAND_TABLE) {
  const e = Object.hasOwn(table, name) ? table[name] : undefined;
  if (e === undefined) return null;
  return Array.isArray(e) ? { subs: e, optional: e.length === 0 } : { subs: e.subs, optional: Boolean(e.optional) };
}
