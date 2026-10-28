/**
 * kit claude sync [--check]    write .claude/settings.json cost keys and the standard agents from the policy
 *                              (--check: write nothing, exit 1 on drift)
 * kit claude policy [--json]   the effective policy (kit defaults + claude.policy.json overrides)
 * kit claude budget [--json]   the loop budget as shell variables: eval "$(kit claude budget)"
 * kit claude managed           the JSON to paste into the claude.ai admin console (owner only)
 * kit claude check             the same as kit check claude
 */
import { CliError } from "../args.js";
import { bundled, loadCanon } from "../canon/index.js";
import { checkClaude, kitCommand, loadPolicy, loopBudget, managedSettings, syncClaude, POLICY_FILE, SETTINGS_FILE } from "../claude.js";

export async function claude(io, { _: [sub] = [], flags }) {
  const kit = bundled();
  const { canon } = loadCanon(io.cwd, kit);
  const { policy, problems } = loadPolicy(io.cwd, kit, canon?.claude?.policy || POLICY_FILE);
  if (!policy) { for (const p of problems) io.err(`  - ${p.file}: ${p.problem}`); throw new CliError(`kit claude: the policy is invalid (${problems.length} problem${problems.length === 1 ? "" : "s"})`, 1); }
  if (sub === "sync") {
    const r = syncClaude(io.cwd, policy, { check: Boolean(flags.check) });
    for (const p of r.problems) io.err(`  - ${p.file}: ${p.problem}`);
    if (r.problems.length) { io.err("kit claude sync: nothing written (a conflict blocks the whole sync)"); return 1; }
    if (flags.check) {
      for (const f of r.changed) io.err(`  - ${f}: drifts from the policy`);
      if (r.changed.length) { io.err(`kit claude sync --check: stale (run ${kitCommand(io.cwd, canon)} claude sync)`); return 1; }
      io.out("ok claude: settings and agents match the policy");
      return 0;
    }
    for (const o of r.overwritten) io.out(`kit claude sync: ${SETTINGS_FILE} ${o.key} was ${JSON.stringify(o.from)}, now ${JSON.stringify(o.to)}: the policy owns this key (override it in ${canon?.claude?.policy || POLICY_FILE}, inside its bounds)`);
    io.out(r.changed.length ? `kit claude sync: wrote ${r.changed.join(", ")}` : "kit claude sync: already current");
    return 0;
  }
  if (sub === "check") {
    const r = checkClaude(io.cwd, canon, kit);
    for (const p of r.problems) io.err(`  - ${p.file}: ${p.problem}`);
    io[r.ok ? "out" : "err"](`${r.ok ? "ok" : "FAIL"} claude: ${r.summary}`);
    return r.ok ? 0 : 1;
  }
  if (sub === "policy") { io.out(JSON.stringify(policy, null, 2)); return 0; }
  if (sub === "budget") {
    const b = loopBudget(policy);
    io.out(flags.json ? JSON.stringify(b) : Object.entries(b).map(([k, v]) => `${k}=${v}`).join("\n"));
    return 0;
  }
  if (sub === "managed") { io.out(JSON.stringify(managedSettings(policy), null, 2)); return 0; }
  throw new CliError(`unknown claude command "${sub ?? ""}" (sync, check, policy, budget, managed)`, 2);
}
