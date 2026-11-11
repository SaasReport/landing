/**
 * The CI boundary (docs/AGENT-GUARD.md): `kit agent-guard audit --base <ref>` runs the SAME rules over what a pull request changes, so a violation an agent
 * made with its hooks off still fails the required check. It runs from the BASE branch's code and policy (the workflow checks the base out and runs its CLI
 * against the PR tree): a pull request cannot weaken the audit that judges it. Three things are judged:
 *   content   the invariants of the RESULT (a secret literal, a Mermaid block without its header, the guard hooks intact); who wrote a file (a generator, the
 *             owner) is decided by the freshness checks and review, so a generated file is not refused here
 *   guard     a change to the guard's own paths needs an owner-signed approval of exactly that change (approvals-gate.js), keys from the BASE table
 *   commits   a commit that carries an agent trailer, or the attribution trailers the registry names, must verify against the BASE agent-identities table
 */
import { execFileSync } from "node:child_process";
import { decideGit } from "./rules.js";
import { digestOf, guardChanges, LEDGER, verifyApprovals } from "./approvals-gate.js";
import { verifyCommit } from "./identity.js";
import { gitEnv } from "../git.js";

const git = (root, ...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: gitEnv() });
const opt = (root, ...a) => { try { return git(root, ...a); } catch { /* the tool is unavailable or found nothing: the caller handles the empty answer */ return null; } };

/** → { files, commits, problems: [{ file, rule, reason }], guard: { changes, digest } }. `baseTable`/`ledgerText` default to the base's and the head's files. */
export function auditDiff(root, registry, { base, head = "HEAD", hookRel = null, owners = null, baseTable = null, ledgerText = null } = {}) {
  const mb = git(root, "merge-base", base, head).trim();
  const out = git(root, "diff", "--name-status", "--no-renames", "-z", mb, head).split("\0");
  const entries = []; for (let i = 0; i + 1 < out.length; i += 2) if (out[i]) entries.push([out[i], out[i + 1]]);
  const problems = [];
  const ctx = { root, registry, hookRel, readFile: () => null, branch: () => null };
  for (const [st, path] of entries) {
    const f = { path, before: st === "A" ? null : opt(root, "show", `${mb}:${path}`), after: st === "D" ? null : opt(root, "show", `${head}:${path}`) };
    const d = decideGit({ hook_event_name: "GitCommit", branch: null, files: [f] }, ctx);
    if (d.action === "deny") problems.push({ file: path, rule: d.rule, reason: d.reason });
  }
  // the guard's own paths: owner-signed approval of exactly this change, owner keys from the BASE table
  const table = baseTable ?? JSON.parse(opt(root, "show", `${mb}:agent-identities.json`) || '{"rows":[]}');
  const changes = guardChanges(root, registry.guardPaths || [], { base, head });
  const digest = digestOf(changes);
  // BOOTSTRAP: when the base branch has no guard pack at all, no owner key or approvals ledger can exist there to verify against. The pull request that introduces the guard
  // is then held by the owner's CODEOWNERS review and merge instead, once; the moment the base has the guard this branch is never taken (a later change needs the signed approval).
  const bootstrap = opt(root, "show", `${mb}:${hookRel}`) == null;
  if (changes.length && !bootstrap) {
    const v = verifyApprovals({ ledgerText: ledgerText ?? (opt(root, "show", `${head}:${LEDGER}`) || ""), owners: owners ?? table.owners ?? [], digest });
    if (!v.ok) problems.push({ file: changes.map((c) => c.path).slice(0, 4).join(", ") + (changes.length > 4 ? ` and ${changes.length - 4} more` : ""), rule: "guard-approval", reason: `${changes.length} guard path(s) changed: ${v.reason}` });
  }
  // commits: agent attribution must verify against the BASE table
  const req = registry.identity?.requireTrailerOn || [];
  const log = git(root, "log", "--format=%H%x1f%T%x1f%P%x1f%B%x1e", `${mb}..${head}`).split("\x1e").map((x) => x.replace(/^\n/, "")).filter(Boolean);
  let commits = 0;
  for (const c of log) {
    const [sha, tree, parents, ...rest] = c.split("\x1f"); const message = rest.join("\x1f");
    commits++;
    const claims = /^Agent-Id:/m.test(message) || req.some((t) => new RegExp(`^${t}:`, "m").test(message));
    if (!claims) continue;
    const v = verifyCommit(table, { tree, parents: parents.split(" ").filter(Boolean), message });
    if (!v.ok) problems.push({ file: `commit ${sha.slice(0, 8)}`, rule: "agent-identity", reason: v.reason });
  }
  return { files: entries.length, commits, problems, bootstrap, guard: { changes, digest } };
}
