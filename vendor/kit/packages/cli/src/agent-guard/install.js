/**
 * The enforcement foundation's installer and checker (docs/AGENT-GUARD.md). One registry in, every layer out:
 *
 *   syncGuard(root, canon)        writes what the registry implies: the guard hooks in .claude/settings.json, the generated rules block in
 *                                 CLAUDE.md, and the default-branch ruleset file .github/rulesets/default-branch.json
 *   checkEnforcement(root, …)     `kit check canon` (enforcement, never waivable): proves every layer a rule claims exists in THIS repository
 *   coverage(registry, checks)    which rules have which layers, and which are instruction only (listed, never claimed)
 *   managedSettings()             the JSON an Owner pastes into the claude.ai admin console so the guard runs in every session
 *   verifyGithub(…)               ONLINE: the live ruleset and environments against the generated ones (needs admin; the 403 for a plan that
 *                                 cannot enforce rulesets is reported as the finding it is)
 */
import { claudeSettings } from "./managed.js";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { formatProblems } from "@saasreport/core/schema";
import { expand, matchesAny, readText, walk } from "../canon/files.js";
import { matrixValues, parseJobs } from "./workflow-jobs.js";
import { jobConditionProblem } from "./job-condition.js";
import { findWranglerConfigs, readWranglerConfig } from "../wrangler-config.js";
import { codeownersCover } from "../canon/persian.js";
import { parseYaml } from "../yaml-lite.js";
import { bashAvailable, bashLoadError, benchCheckProblem as benchCheckProblem_, mentionsBenchCheck } from "./bash-ast.js";
import { codeOf, parseAgent, runsClaude } from "../claude.js";
import { ENGINE_RULES } from "./rules.js";
import { GENERATED_LINE, PROJECT_PRE_PUSH_GATE, gitHookFiles } from "./githooks.js";
import { RECONCILERS } from "./reconcile.js";
import { hooksIntact, mergeHooks } from "./guard-hooks.js";
import { PROJECT_FILE, loadEffective, mergeRegistry } from "./registry.js";
import { stripKitCheckout } from "../source.js";
import { DEFAULT_VENDOR_PATH, isSourceMode, kitLocation, snapshotRoots, vendorRoots } from "../vendor-path.js";
import { gitEnv } from "../git.js";
import { bundled } from "../bundled.js";

/** The directory of the guard this code belongs to (packages/cli/src/agent-guard). */
const HERE = dirname(fileURLToPath(import.meta.url));
export const KIT_REGISTRY_FILE = fileURLToPath(new URL("../../../core/registry/constitution.rules.json", import.meta.url));
export const SETTINGS = ".claude/settings.json";
export const RULESET_FILE = ".github/rulesets/default-branch.json";
/** The one declared source of the ruleset's review requirements (kit.governance.v1); absent, the registry's defaults hold. */
export const GOVERNANCE_FILE = "governance.json";
/** The required status check a declared independent_review_marker adds to the ruleset, and the workflow that provides it (templates/ci/independent-review.yml). */
export const REVIEW_CHECK = "independent-review";
export const REVIEW_WORKFLOW = ".github/workflows/independent-review.yml";
const REVIEW_TEMPLATE = fileURLToPath(new URL("../../../../templates/ci/independent-review.yml", import.meta.url));

/** { text } | { problem }: the kit's template as this repository holds it (the vendored snapshot's path in place of vendor/kit). */
export function reviewWorkflowText(root, canon) {
  if (!existsSync(REVIEW_TEMPLATE)) return { problem: "templates/ci/independent-review.yml is not in this kit snapshot: re-vendor a kit that has it (governance.json declares independent_review_marker)" };
  let snapshot = DEFAULT_VENDOR_PATH;
  try { snapshot = vendorRoots(canon?.vendor).snapshot; } catch { /* a malformed vendor config: the default path; kit check vendor reports the config */ }
  const text = readFileSync(REVIEW_TEMPLATE, "utf8");
  // the CLI resolves as the guard's does: a site runs the kit through its bootstrap (scripts/kit.mjs, the kit at its head: docs/FRESHNESS.md),
  // the kit itself (project kit, no snapshot manifest) runs packages/cli from its own root and checks out no kit
  const own = canon?.project === KIT_PROJECT && !(() => { try { return snapshotRoots(canon?.vendor).some((x) => existsSync(join(root, x.manifest))); } catch { return true; /* a malformed vendor config: not the kit */ } })();
  void snapshot;
  return { text: own ? stripKitCheckout(text).split("node scripts/kit.mjs").join("node packages/cli/bin/kit.js") : text };
}

/**
 * { approvals: { required, code_owner_review, last_push_approval, independent_review_marker }, declared, problems }: governance.json,
 * schema-validated, or the defaults of the registry (separation.requiredApprovals, code-owner review, last-push approval). Invalid: problems.
 */
export function loadGovernance(root, registry) {
  const defaults = { required: registry.separation.requiredApprovals, code_owner_review: true, last_push_approval: true, independent_review_marker: false };
  const file = join(root, GOVERNANCE_FILE);
  if (!existsSync(file)) return { approvals: defaults, declared: false, problems: [] };
  let doc;
  try { doc = JSON.parse(readFileSync(file, "utf8")); } catch (e) { return { approvals: defaults, declared: true, problems: [P(GOVERNANCE_FILE, `not JSON: ${e.message}`)] }; }
  const kit = bundled();
  const bad = formatProblems(kit.validator.validate(doc, kit.byName("governance")));
  if (bad.length) return { approvals: defaults, declared: true, problems: bad.map((m) => P(GOVERNANCE_FILE, `kit.governance.v1: ${m}`)) };
  return { approvals: doc.approvals, declared: true, problems: [] };
}
export const BLOCK_BEGIN = "<!-- kit:constitution begin (generated by `kit agent-guard sync` from constitution.rules.json: never edit by hand) -->";
export const BLOCK_END = "<!-- kit:constitution end -->";
const P = (file, problem) => ({ file, problem });

/** Where the guard script is in THIS repository: the kit itself, or its vendored snapshot. null when neither exists. */
export function guardRel(root, canon) {
  const tail = "packages/cli/src/agent-guard/daemon.mjs";
  // only the kit itself runs its guard from the repository root; every other repository runs the vendored snapshot, found through
  // vendor-path.js and never at the root, where an agent could plant a guard of its own
  // (kit.canon.json#/project is a guard path, and a repository that carries a vendored snapshot manifest is never the kit)
  if (canon?.project === KIT_PROJECT) {
    const vendored = (() => { try { return snapshotRoots(canon?.vendor).some((r) => existsSync(join(root, r.manifest))); } catch { return true; /* a malformed vendor config: not the kit, so no root guard */ } })();
    return !vendored && existsSync(join(root, tail)) ? tail : null;
  }
  let snapshot;
  try { snapshot = vendorRoots(canon?.vendor).snapshot; } catch { return null; /* a malformed vendor config names no guard pack: every write is refused (fail closed) */ }
  const v = `${snapshot}/${tail}`;
  return existsSync(join(root, v)) ? v : null;
}

/** The effective registry of this repository: kit rules (the repo's own copy of them) + the project's file. */
export function effective(root, canon) {
  const rel = guardRel(root, canon);
  const file = rel ? join(root, rel, "../../../../core/registry/constitution.rules.json") : KIT_REGISTRY_FILE;
  return loadEffective(root, existsSync(file) ? file : KIT_REGISTRY_FILE);
}

/** The generated block of CLAUDE.md. */
export function claudeBlock(registry) {
  const lines = ["## Constitution (one registry: `constitution.rules.json`; every rule below is also enforced by hooks, `kit check canon` and CI)", ""];
  for (const r of registry.rules) lines.push(`- **${r.title}.** ${r.text}${r.instructionOnly ? (Object.keys(r.enforce).length ? " *(only part of this can be forced)*" : " *(instruction only: nothing can force it)*") : ""}`);
  return `${BLOCK_BEGIN}\n${lines.join("\n")}\n${BLOCK_END}`;
}
export function withBlock(text, block) {
  const a = text.indexOf(BLOCK_BEGIN), b = text.indexOf(BLOCK_END);
  if (a >= 0 && b > a) return text.slice(0, a) + block + text.slice(b + BLOCK_END.length);
  return `${text.replace(/\s*$/, "")}\n\n${block}\n`;
}

/** True when a workflow runs on a branch's changes: a pull_request trigger, or a push trigger that covers every branch (no branch filter, or `**`). Read from the parsed YAML. */
export function runsOnBranchChanges(text) {
  let on; try { on = parseYaml(text)?.on; } catch { /* failure here means no value; the caller holds on the empty answer */ return false; }
  if (on === "push" || on === "pull_request") return true;
  if (Array.isArray(on)) return on.includes("push") || on.includes("pull_request");
  if (!on || typeof on !== "object") return false;
  if ("pull_request" in on) return true;
  if ("push" in on) { const b = on.push?.branches; return b === undefined || b === null || (Array.isArray(b) && b.includes("**")) || b === "**"; }
  return false;
}

/** The status-check names a pull request must pass: the test workflow's non-canary legs. */
export function requiredContexts(root, canon) {
  const dir = join(root, ".github/workflows");
  const out = [];
  if (!existsSync(dir)) return out;
  const canary = canon?.workflows?.canary?.runner;
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    const text = readFileSync(join(dir, f), "utf8");
    if (!runsOnBranchChanges(text)) continue;
    for (const job of parseJobs(text)) {
      if (!/\b(npm (run )?test|check canon)\b/.test(job.body.join("\n"))) continue;
      if (canary && Array.isArray(job.runsOn) && job.runsOn.includes(canary)) continue;      // the canary image never blocks: its job is no required check
      const nm = job.body.map((l) => /^\s{2,6}name:\s*(.+)$/.exec(l)).find(Boolean)?.[1]?.trim().replace(/^["']|["']$/g, "") || job.id;
      if (/\$\{\{\s*matrix\.runner\s*\}\}/.test(nm)) for (const r of matrixValues(job, "runner").filter((x, i, a) => a.indexOf(x) === i && x !== canary)) out.push(nm.replace(/\$\{\{\s*matrix\.runner\s*\}\}/, r));
      else out.push(nm);
    }
  }
  return [...new Set(out)];
}

/** The default-branch ruleset (GitHub's ruleset JSON): no deletion, no force-push, a reviewed pull request, the CI checks required, no bypass. */
export function desiredRuleset(root, canon, registry) {
  const contexts = requiredContexts(root, canon);
  const g = loadGovernance(root, registry);
  if (g.problems.length) throw new Error(g.problems.map((x) => `${x.file}: ${x.problem}`).join("; "));
  const gov = g.approvals;
  // a declared independent-review marker is enforced, not just declared: the check that reads it is required (and the workflow providing it is written by sync)
  if (gov.independent_review_marker && !contexts.includes(REVIEW_CHECK)) contexts.push(REVIEW_CHECK);
  return {
    name: `${canon?.project || "project"} default branch: reviewed, tested, never forced`,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    bypass_actors: [],
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "pull_request", parameters: { required_approving_review_count: gov.required, dismiss_stale_reviews_on_push: true, require_code_owner_review: gov.code_owner_review, require_last_push_approval: gov.last_push_approval, required_review_thread_resolution: true, allowed_merge_methods: ["squash", "merge"] } },
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: contexts.map((context) => ({ context })) } },
    ],
  };
}
const ruleText = (r) => `${JSON.stringify(r, null, 2)}\n`;

/**
 * The one hook client the managed launcher runs (launcher.sh): written by sync with the guard's path resolved once, here, from kit.canon.json
 * through vendor-path.js (guardRel). It lives under .claude/hooks/ (protected, a guard path), so nothing reads an agent-writable file at run
 * time to find enforcement (kit #139 review: a launcher that parsed kit.canon.json ran a planted hook).
 */
export const LAUNCH_SHIM = ".claude/hooks/agent-guard.sh";
export const shimText = (rel) => `#!/bin/bash
# generated by \`kit agent-guard sync\` from kit.canon.json (vendor.path, through packages/cli/src/vendor-path.js): never edit by hand.
# This repository's hook client for the managed launcher; the path below was resolved when the guard was synced.
# A missing or unreadable hook client refuses every action (exit 2): the guard fails closed.
t="\${0%/*}/../../${dirname(rel)}/hook.sh"
[ -f "$t" ] && [ -r "$t" ] || { echo "agent-guard: the hook client $t is missing or unreadable, so every action is refused. Run kit agent-guard sync." >&2; exit 2; }
exec bash "$t"
`;

/**
 * Why sync must not run from `selfDaemon` (the guard its own code belongs to), or null: a CLI inside this repository that is not the guard
 * guardRel resolves would point the hooks at itself (a copy planted at the root and run as \`node <copy>/bin/kit.js agent-guard sync\`).
 * A CLI outside the repository (an installed or another checkout's kit) only ever writes the guard guardRel resolves.
 */
export function retargetProblem(root, rel, selfDaemon) {
  const self = relative(root, selfDaemon).split("\\").join("/");
  return !self.startsWith("..") && !isAbsolute(self) && self !== rel ? `this sync runs from ${self}, not from the repository's guard ${rel}: run the guard's own CLI` : null;
}

/** The kit's own project name in kit.canon.json: the one repository whose guard is not a vendored snapshot. */
export const KIT_PROJECT = "kit";

/** All writes `sync` makes: [{ file, text }]. */
export function plannedWrites(root, canon, registry) {
  const rel = guardRel(root, canon);
  const out = [];
  if (rel) {
    let cur = null; try { cur = existsSync(join(root, SETTINGS)) ? JSON.parse(readFileSync(join(root, SETTINGS), "utf8")) : {}; } catch { /* unparseable input counts as absent, never as a valid value */ cur = undefined; }
    if (cur !== undefined) out.push({ file: SETTINGS, text: `${JSON.stringify(mergeHooks(cur, rel), null, 2)}\n` });
  }
  const md = join(root, "CLAUDE.md");
  out.push({ file: "CLAUDE.md", text: withBlock(existsSync(md) ? readFileSync(md, "utf8") : "# Working on this repository\n", claudeBlock(registry)) });
  out.push({ file: RULESET_FILE, text: ruleText(desiredRuleset(root, canon, registry)) });
  if (loadGovernance(root, registry).approvals.independent_review_marker) { const w = reviewWorkflowText(root, canon); if (w.text) out.push({ file: REVIEW_WORKFLOW, text: w.text }); }
  if (rel) for (const [file, text] of Object.entries(gitHookFiles(rel, { prePushGate: existsSync(join(root, PROJECT_PRE_PUSH_GATE)) }))) out.push({ file, text, exec: true });
  if (rel) out.push({ file: LAUNCH_SHIM, text: shimText(rel), exec: true });
  const gi = join(root, ".gitignore");
  const lines = [registry.daemon.addr, registry.daemon.state, registry.daemon.evidence];
  const have = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  out.push({ file: ".gitignore", text: lines.every((l) => have.split("\n").includes(l)) ? have : `${have.replace(/\s*$/, "")}${have ? "\n" : ""}# the decision daemon's runtime files (kit agent-guard)\n${lines.filter((l) => !have.split("\n").includes(l)).join("\n")}\n` });
  return out;
}

export function syncGuard(root, canon, { check = false } = {}) {
  const { registry, problems } = effective(root, canon);
  const changed = [];
  if (problems.length) return { changed, problems: problems.map((p) => P(PROJECT_FILE, p)) };
  { const g = loadGovernance(root, registry); if (g.problems.length) return { changed, problems: g.problems }; if (g.approvals.independent_review_marker) { const w = reviewWorkflowText(root, canon); if (w.problem) return { changed, problems: [P(REVIEW_WORKFLOW, w.problem)] }; } }
  if (!guardRel(root, canon)) return { changed, problems: [P((() => { try { return vendorRoots(canon?.vendor).snapshot; } catch (e) { return `kit.canon.json vendor (${e.message})`; } })(), "no guard pack in this repository: run `kit vendor sync` (the guard is part of the vendored kit) or work in the kit itself")] };
  // sync never retargets the guard to anything but the one guardRel resolves; and a CLI run from inside this repository must BE that guard
  // (a planted copy run as \`node <copy>/bin/kit.js agent-guard sync\` refuses instead of pointing the hooks at itself)
  { const bad = retargetProblem(root, guardRel(root, canon), join(HERE, "daemon.mjs")); if (bad) return { changed, problems: [P(guardRel(root, canon), bad)] }; }
  for (const w of plannedWrites(root, canon, registry)) {
    const cur = existsSync(join(root, w.file)) ? readFileSync(join(root, w.file), "utf8") : null;
    if (cur === w.text) continue;
    changed.push(w.file);
    if (!check) { mkdirSync(dirname(join(root, w.file)), { recursive: true }); writeFileSync(join(root, w.file), w.text); if (w.exec) chmodSync(join(root, w.file), 0o755); }
  }
  if (!check && existsSync(join(root, ".git"))) { try { execFileSync("git", ["-C", root, "config", "--local", "core.hooksPath", ".githooks"], { stdio: "ignore", env: gitEnv() }); } catch { /* an unreadable or missing file reads as absent; the caller holds on that */ } }
  return { changed, problems: [] };
}

/** package.json scripts: { name: body }, and the expansion of `npm run x` references (depth 4). */
function scriptsOf(root) {
  try { return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts || {}; } catch { /* unparseable input counts as absent, never as a valid value */ return {}; }
}
function expandScript(scripts, body, depth = 0) {
  if (depth > 4) return body;
  return body.replace(/npm run ([A-Za-z0-9:_-]+)/g, (m, n) => (scripts[n] ? `${m} ${expandScript(scripts, scripts[n], depth + 1)}` : m));
}
const words = (s) => s.toLowerCase();

/** `npm test` runs the canon first: its first `&&` part says so, or it is the test-run wrapper whose first step (STEPS) is `kit check canon`. */
function testRunsCanonFirst(root, testScript) {
  if (/check canon/.test(testScript.split("&&")[0])) return true;
  const m = /(?:^|\s)(?:node\s+)?(\S*scripts\/test-run\.mjs)\b/.exec(testScript);
  if (!m || !existsSync(join(root, m[1]))) return false;
  const text = readFileSync(join(root, m[1]), "utf8");
  const first = /export const STEPS = \[\s*\[\s*process\.execPath,\s*\[([^\]]*)\]/.exec(text)?.[1] ?? "";
  return /"check",\s*"canon"/.test(first);
}

/** kit check canon: enforcement. → { ok, configured, checked, summary, problems } */
export function checkEnforcement(root, canon, kit, checks = []) {
  const problems = [];
  let checked = 0;
  const { registry, problems: mergeProblems, kit: kitReg, own } = effective(root, canon);
  const schema = kit.byName("constitution-rules");
  const val = (v, label) => { for (const m of formatProblems(kit.validator.validate(v, schema))) problems.push(P(label, m)); };
  // 1. the registry: valid, and every claim a rule makes exists
  val(kitReg, "constitution.rules.json (kit)");
  if (own) val(own, PROJECT_FILE);
  for (const m of mergeProblems) problems.push(P(PROJECT_FILE, m));
  for (const a of registry.actions || []) for (const rr of a.rules) if (!ENGINE_RULES.includes(rr)) problems.push(P(`action ${a.id}`, `names rule "${rr}", which the guard engine does not implement`));
  const claimed = new Set();
  for (const r of registry.rules) {
    checked++;
    for (const h of r.enforce.hook || []) { claimed.add(h); if (!ENGINE_RULES.includes(h)) problems.push(P(`rule ${r.id}`, `claims hook "${h}", which the guard engine does not implement (${ENGINE_RULES.join(", ")})`)); }
    for (const c of r.enforce.canon || []) if (checks.length && !checks.includes(c)) problems.push(P(`rule ${r.id}`, `claims canon check "${c}", which \`kit check canon\` does not have (${checks.join(", ")})`));
    for (const c of r.enforce.reconcile || []) if (!RECONCILERS.includes(c)) problems.push(P(`rule ${r.id}`, `claims reconciler "${c}", which \`kit agent-guard reconcile\` does not have (${RECONCILERS.join(", ")})`));
  }
  for (const h of ENGINE_RULES) if (!claimed.has(h)) problems.push(P("constitution.rules.json", `the engine implements hook "${h}" but no rule claims it: register it under the rule it enforces`));
  // 2. the hooks are installed and intact
  const rel = guardRel(root, canon);
  if (!rel) problems.push(P(SETTINGS, "no guard pack in this repository (neither packages/cli/src/agent-guard nor a vendored copy): run `kit vendor sync`, then `kit agent-guard sync`, and commit the result"));
  let settings = null;
  try { settings = existsSync(join(root, SETTINGS)) ? JSON.parse(readFileSync(join(root, SETTINGS), "utf8")) : null; } catch (e) { problems.push(P(SETTINGS, `not JSON: ${e.message}`)); }
  if (rel) {
    checked++;
    if (!settings) problems.push(P(SETTINGS, `missing: run \`kit agent-guard sync\` (installs the guard hooks that run at SessionStart, SubagentStart, PreToolUse and ConfigChange)`));
    else if (!hooksIntact(settings, rel)) problems.push(P(SETTINGS, "the guard hooks are missing, edited or switched off: run `kit agent-guard sync` and commit the result (never hand-edit them)"));
  }
  for (const f of [".claude/settings.json", ".claude/settings.local.json"]) {
    try { const j = JSON.parse(readFileSync(join(root, f), "utf8")); if (j.disableAllHooks === true) problems.push(P(f, "disableAllHooks is true: every hook, the guard included, is off")); if (j.allowManagedHooksOnly === true) problems.push(P(f, "allowManagedHooksOnly in a project file stops the project's hooks")); } catch { /* absent or reported above */ }
  }
  // 3. agent definitions declare a scope
  const agentsDir = join(root, ".claude/agents");
  if (existsSync(agentsDir)) for (const f of readdirSync(agentsDir).filter((x) => x.endsWith(".md"))) {
    checked++;
    const { fm } = parseAgent(readFileSync(join(agentsDir, f), "utf8"));
    const name = fm?.name || f.replace(/\.md$/, "");
    if (!registry.scopes.agents[name]) problems.push(P(`.claude/agents/${f}`, `agent "${name}" has no declared write scope: add scopes.agents.${name}.write ([] for read-only) to ${PROJECT_FILE}; an agent without one may not write`));
  }
  // 4. loops, scripts and workflows never switch the guard off
  const bypass = [...registry.protected.bypassFlags, ...registry.protected.bypassEnv];
  const hasBypass = (code) => bypass.filter((b) => new RegExp(`(^|[\\s"'=])${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\s"'=]|$)`).test(code));
  for (const f of expand(root, ["scripts", "bin", ".claude", ".github/workflows"]).filter((x) => /\.(sh|bash|zsh|mjs|cjs|js|ts|py|ya?ml)$/.test(x) && !matchesAny(x, [".claude/worktrees/**", ".claude/agents/**"]))) {
    const src = readText(root, f);
    const yml = /\.ya?ml$/.test(f);
    const code = yml ? src.replace(/^\s*#.*$/gm, "") : codeOf(src, f);
    if (!(yml ? /\bclaude\b/.test(code) : runsClaude(code, f))) continue;
    checked++;
    if (!yml && runsClaude(code, f) && !/\btimeout\b|--max-turns/.test(code)) problems.push(P(f, "starts `claude -p` with no `timeout` and no --max-turns: an agent loop must be bounded so it cannot become an orphan"));
    for (const b of hasBypass(code)) problems.push(P(f, `runs \`claude\` with ${b}, which switches the project's hooks off; the guard must run in every loop and workflow`));
  }
  // 5. CI: canon first in npm test, and a workflow runs it on every pull request
  const scripts = scriptsOf(root);
  checked++;
  if (!scripts.test) problems.push(P("package.json", "no `test` script: npm test must run `kit check canon` first"));
  else if (!testRunsCanonFirst(root, scripts.test)) problems.push(P("package.json", "`npm test` must run `kit check canon` as its first step (the constitution's checks before anything else)"));
  const wfDir = join(root, ".github/workflows");
  const wfs = existsSync(wfDir) ? readdirSync(wfDir).filter((x) => /\.ya?ml$/.test(x)) : [];
  const contexts = requiredContexts(root, canon);
  if (!wfs.length) problems.push(P(".github/workflows", "no workflow: nothing runs `npm test` (and so `kit check canon`) on a pull request, so nothing the agent skipped locally is caught"));
  else if (!contexts.length) problems.push(P(".github/workflows", "no workflow runs `npm test` on pull_request (or on a push to every branch); the CI layer of every rule needs one"));
  // 5b. the CI boundary runs the same rules over the pull request, and the budgets at every boundary; no CI job is unbounded
  const wfText = wfs.map((f) => readFileSync(join(wfDir, f), "utf8")).join("\n");
  if (wfs.length && contexts.length) {
    const baseWhy = wfs.map((f) => baseAuditProblems(readFileSync(join(wfDir, f), "utf8")));      // one workflow file at a time: a job lives in one file
    if (!baseWhy.some((w) => !w.length)) for (const m of baseWhy[0] || []) problems.push(P(".github/workflows", m));
    if (!/agent-guard audit/.test(wfText)) problems.push(P(".github/workflows", "no workflow step runs `kit agent-guard audit --base <the pull request's base>`: the rules must also run over what a pull request changes, so a violation made with the hooks off still fails"));
    const benchWhy = wfs.map((f) => benchCheckProblem(readFileSync(join(wfDir, f), "utf8")));
    if (!benchWhy.some((w) => w === null)) problems.push(P(".github/workflows", `no workflow step runs \`kit agent-guard bench --check\` so that its failure fails the job: a boundary over its latency budget must fail a check (${benchWhy.find((w) => !/^no job has a step/.test(w)) || benchWhy[0]})`));
  }
  for (const f of wfs) for (const job of parseJobs(readFileSync(join(wfDir, f), "utf8"))) { checked++; if (!/^\s{2,6}timeout-minutes:\s*\S/m.test(job.body.join("\n"))) problems.push(P(`.github/workflows/${f}`, `job "${job.id}" has no timeout-minutes: an unbounded CI process is an orphan waiting to happen`)); }
  // 6. deploys: scripts run the tests first; workflow jobs that deploy are gated and use an environment
  const sep = registry.separation;
  for (const [name, body] of Object.entries(scripts)) {
    const flat = words(expandScript(scripts, body));
    if (!sep.deployCommands.some((c) => flat.includes(c))) continue;
    checked++;
    if (!/^deploy/.test(name)) continue;
    const pre = words(body);
    if (!sep.gates.some((g) => pre.includes(g)) && !/npm run (deploy|test)/.test(pre)) problems.push(P("package.json", `script "${name}" deploys but does not run the tests first (${sep.gates.join(" or ")} before the deploy command)`));
  }
  for (const f of wfs) {
    const text = readFileSync(join(wfDir, f), "utf8");
    for (const job of parseJobs(text)) {
      const body = job.body.join("\n");
      if (!sep.ciEnvironmentFor.some((c) => body.includes(c))) continue;
      checked++;
      if (!/^\s{2,6}environment:\s*\S/m.test(body)) problems.push(P(`.github/workflows/${f}`, `job "${job.id}" deploys but declares no \`environment:\`: put it in a GitHub environment so required reviewers and a role-scoped token gate the deploy`));
      if (!sep.gates.some((g) => body.includes(g))) problems.push(P(`.github/workflows/${f}`, `job "${job.id}" deploys without running the tests (${sep.gates.join(" or ")}) in the same job`));
    }
  }
  // 7. alerts have recipients, and recipients are never committed: a recipient variable in any wrangler config's [vars] (any env,
  //    empty or not) fails; recipients are Worker secrets (`kit resilience secrets` verifies them at deploy). One reader: wrangler-config.js
  for (const f of findWranglerConfigs(root).filter((x) => !x.startsWith("vendor/") && !x.startsWith(".kit/") && !x.startsWith("findings/"))) {
    checked++;
    let c; try { c = readWranglerConfig(root, f); } catch (e) { problems.push(P(f, `cannot read: ${e.message}`)); continue; }
    for (const [env, facts] of Object.entries(c.envs)) for (const v of sep.recipientVars) if (v in facts.vars) {
      problems.push(P(f, `${env ? `[env.${env}.vars] ` : ""}${v} is ${String(facts.vars[v]).trim() ? "committed" : "empty"}: a recipient is a Worker secret the owner sets (wrangler secret put ${v}), never a value in git, and never empty`));
    }
  }
  // 8. generated artefacts of the registry are current; the owner reviews them
  if (rel && !mergeProblems.length) {
    for (const w of plannedWrites(root, canon, registry)) {
      checked++;
      const cur = existsSync(join(root, w.file)) ? readFileSync(join(root, w.file), "utf8") : null;
      if (cur !== w.text && w.file !== SETTINGS) problems.push(P(w.file, "does not match what the registry generates: run `kit agent-guard sync` and commit it (never hand-edit)"));
    }
  }
  // 8b. a hook that names a missing file holds every tool call; and every guard path is owned
  for (const [ev, groups] of Object.entries(settings?.hooks || {})) for (const g of groups || []) for (const h of g.hooks || []) for (const m of String(h.command || "").matchAll(/\$CLAUDE_PROJECT_DIR\/([^\s"']+)/g)) { checked++; if (!existsSync(join(root, m[1]))) problems.push(P(SETTINGS, `the ${ev} hook runs ${m[1]}, which does not exist: every tool call would be held`)); }
  const sourceCheckout = (() => { try { return isSourceMode(canon?.vendor) ? kitLocation(canon.vendor).path : null; } catch { return null; /* a malformed vendor config: reported by kit check vendor; no exemption here */ } })();
  for (const g of [...(registry.guardPaths || []), ...(rel ? [`${dirname(rel)}/`] : [])]) {
    checked++;
    const f = g.split("#")[0];      // a pointer guard path (kit.canon.json#/vendor) is owned through its file
    // the kit at t=0 (docs/FRESHNESS.md): the guard pack inside the source checkout is never committed (the checkout is ignored), so no CODEOWNERS
    // line can own it; its integrity is the kit's own main, owner-reviewed there, and verified against the published head before every use
    if (sourceCheckout && (f === sourceCheckout || f.startsWith(`${sourceCheckout}/`))) continue;
    const c = codeownersCover(root, f.endsWith("/") ? `${f}_probe` : f);
    if (!c) problems.push(P(g, `guard path not covered by CODEOWNERS: add "/${f} @<owner>" so the rules, engine, hooks and workflows cannot change without the owner's review`));
    else if (c.owners.some((o) => /^@(OWNER|YOUR-HANDLE)$/.test(o))) problems.push(P(c.file, `${g} is owned by a placeholder`));
  }
  for (const f of [PROJECT_FILE, SETTINGS, RULESET_FILE, "CLAUDE.md"].filter((x) => existsSync(join(root, x)) || x === RULESET_FILE)) {
    const c = codeownersCover(root, f);
    if (!c) problems.push(P(f, `not covered by CODEOWNERS: add "/${f} @<owner>" so enforcement cannot change without the owner's review`));
    else if (c.owners.some((o) => /^@(OWNER|YOUR-HANDLE)$/.test(o))) problems.push(P(c.file, `${f} is owned by a placeholder`));
  }
  const s = `${registry.rules.length} rules (${registry.rules.filter((r) => r.instructionOnly && !Object.keys(r.enforce).length).length} instruction only), ${ENGINE_RULES.length} hook rules, guard ${rel ? "installed" : "MISSING"}`;
  return { ok: !problems.length, configured: true, checked, summary: s, problems };
}

/** The layers of every rule, for `kit agent-guard coverage`. */
export function coverage(registry, checks) {
  return registry.rules.map((r) => ({
    id: r.id, class: r.class, title: r.title,
    layers: ["context", ...Object.keys(r.enforce).filter((k) => (Array.isArray(r.enforce[k]) ? r.enforce[k].length : r.enforce[k]))],
    mechanical: Object.keys(r.enforce).some((k) => (Array.isArray(r.enforce[k]) ? r.enforce[k].length : r.enforce[k])),
    hooks: r.enforce.hook || [], canon: (r.enforce.canon || []).filter((c) => checks.includes(c)),
    instructionOnly: r.instructionOnly || null,
  }));
}

/** The managed-settings JSON (Team or Enterprise, Owner role); every other delivery format is in managed.js. */
export function managedSettings() { return claudeSettings(); }

/** The steps of a workflow job, read structurally (not by text match): [{ uses, run, withs: {key: value}, ifc }]. */
export function jobSteps(job) {
  const lines = job.body, ind = (l) => l.length - l.trimStart().length;
  const at = lines.findIndex((l) => /^\s*steps:\s*(#.*)?$/.test(l)); if (at < 0) return [];
  const steps = []; let cur = null, stepInd = null, block = null;
  for (const l of lines.slice(at + 1)) {
    if (!l.trim() || /^\s*#/.test(l)) { if (block) block.lines.push(l); continue; }
    const dash = /^(\s*)-\s+(.*)$/.exec(l);
    if (dash && (stepInd === null || dash[1].length === stepInd)) { stepInd = dash[1].length; cur = { uses: null, run: "", withs: {}, ifc: "" }; steps.push(cur); block = null; handle(cur, dash[2], stepInd + 2); continue; }
    if (!cur) continue;
    if (ind(l) <= (stepInd ?? 0) && !dash) break;
    if (block && ind(l) > block.ind) { block.lines.push(l.trim()); cur.run += `\n${l.trim()}`; continue; }
    block = null; handle(cur, l.trim(), ind(l));
  }
  return steps;
  function handle(step, text, indent) {
    let m;
    if ((m = /^uses:\s*(\S+)/.exec(text))) step.uses = m[1];
    else if ((m = /^run:\s*[|>][-+]?\s*$/.exec(text))) { step.run = ""; block = { ind: indent, lines: [] }; }
    else if ((m = /^run:\s*(.*)$/.exec(text))) step.run = m[1];
    else if ((m = /^if:\s*(.*)$/.exec(text))) step.ifc = m[1];
    else if ((m = /^([A-Za-z_-]+):\s*(.+?)\s*(#.*)?$/.exec(text)) && indent > stepInd + 2) step.withs[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const truthy = (v) => v === true || v === "true";
const falsy = (v) => v === undefined || v === false || v === "false";
/** Why this workflow cannot be relied on to fail when the bench fails, or null when one step provably can: see `runsBenchCheck`. */
export function benchCheckProblem(text) {
  if (!bashAvailable()) return `the workflow's bash cannot be read: ${bashLoadError()} (the kit needs web-tree-sitter and @vscode/tree-sitter-wasm)`;
  let doc; try { doc = parseYaml(text); } catch (e) { return `the workflow does not parse as YAML (${e.message})`; }
  // the bench gates pull requests, so the workflow must fire on them; push is evaluated only when the workflow fires on it
  const on = doc?.on; const fires = typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on || {});
  if (!fires.includes("pull_request")) return `the workflow does not run on pull_request (it runs on ${fires.join(", ") || "nothing"}), so its bench gates no pull request`;
  const events = ["pull_request", ...(fires.includes("push") ? ["push"] : [])];
  // a job runs only when every job it needs runs too (GitHub skips it otherwise): prove the chain, refusing a cycle or a missing job
  const jobs = doc?.jobs || {};
  const chainProblem = (id, seen = new Set()) => {
    if (seen.has(id)) return `needs job "${id}" in a cycle`;
    const j = jobs[id]; if (!j) return `needs job "${id}", which does not exist`;
    const own = jobConditionProblem(j.if, events); if (own !== null) return `needs job "${id}", which runs only under \`if: ${j.if}\`: ${own}`;
    for (const n of [].concat(j.needs ?? [])) { const p = chainProblem(String(n), new Set([...seen, id])); if (p) return p; }
    return null;
  };
  let why = "no job has a step that runs `kit agent-guard bench --check`";
  for (const [id, job] of Object.entries(jobs)) {
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    const bench = steps.filter((st) => typeof st?.run === "string" && mentionsBenchCheck(st.run));
    if (!bench.length) continue;
    // a job that never runs, or whose failure is allowed, proves nothing
    // the job must provably run on a push and on a non-draft pull request (the ci-run-budget draft guard does; `&& false` after it does not)
    if (jobConditionProblem(job.if, events) !== null) { why = `job "${id}" runs the bench only under \`if: ${job.if}\`: ${jobConditionProblem(job.if, events)}`; continue; }
    const needsProblem = [].concat(job.needs ?? []).map((n) => chainProblem(String(n), new Set([id]))).find(Boolean);
    if (needsProblem) { why = `job "${id}" runs the bench but ${needsProblem}`; continue; }
    const coe = job["continue-on-error"];
    if (!falsy(coe)) {
      // an expression of the job's own matrix is fine when at least one matrix leg sets it false (the canary leg may fail; the required one may not)
      const key = /^\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}$/.exec(String(coe))?.[1];
      const legs = Array.isArray(job.strategy?.matrix?.include) ? job.strategy.matrix.include : [];
      if (!(key && legs.some((l) => l && l[key] === false))) { why = `job "${id}" has continue-on-error: ${JSON.stringify(coe)}, so a failing bench never fails the job (only a matrix key that some leg sets false is accepted)`; continue; }
    }
    for (const st of bench) {
      if (!(st.if === undefined || truthy(st.if))) { why = `the bench step of job "${id}" runs only under \`if: ${st.if}\``; continue; }
      if (!falsy(st["continue-on-error"])) { why = `the bench step of job "${id}" has continue-on-error: ${JSON.stringify(st["continue-on-error"])}`; continue; }
      if (st.shell !== undefined && !/^(bash|sh)\b/.test(String(st.shell))) { why = `the bench step of job "${id}" runs under shell ${JSON.stringify(st.shell)}, not bash`; continue; }
      const p = benchCheckProblem_(st.run);
      if (p === null) return null;
      why = `job "${id}": ${p}`;
    }
  }
  return why;
}
/** True when a workflow has a step that RUNS `kit agent-guard bench ... --check` (read from the parsed YAML and the script from the bash grammar: a comment, an echo, \`|| true\`, a pipe, an if or a loop does not count) and that step can fail the job. */
export const runsBenchCheck = (text) => benchCheckProblem(text) === null;
const BASE_REF = /github\.base_ref|pull_request\.base\.(sha|ref)|github\.event\.repository\.default_branch/;
/** → problems of the CI audit job: it must check out the BASE branch into its own path and run that copy's audit and bench (never the pull request's own code). */
export function baseAuditProblems(text) {
  for (const job of parseJobs(text)) {
    const steps = jobSteps(job);
    const co = steps.filter((x) => /^actions\/checkout@/.test(x.uses || "") && BASE_REF.test(x.withs.ref || "") && x.withs.path);
    for (const c of co) {
      const dir = c.withs.path.replace(/\/$/, "");
      const after = steps.slice(steps.indexOf(c) + 1);
      // that copy's kit: its vendored kit.js, or its bootstrap scripts/kit.mjs (the kit at its head, docs/FRESHNESS.md: the base's own copy of the bootstrap, never the pull request's)
      const audit = after.find((x) => new RegExp(`${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\S*kit\\.m?js\\s+agent-guard\\s+audit`).test(x.run));
      if (audit) return [];
    }
  }
  return ["no job checks out the BASE branch (actions/checkout with ref: github.base_ref, or github.event.repository.default_branch for a push, and a path) and runs `<path>/…/kit.js agent-guard audit` (or `<path>/scripts/kit.mjs agent-guard audit`, the bootstrap) from that copy: an audit run from the PR's own code can be edited by the PR to pass"];
}

const essentials = (rs) => ({
  bypass: (rs.bypass_actors || []).length,
  types: (rs.rules || []).map((r) => r.type).sort(),
  approvals: rs.rules?.find((r) => r.type === "pull_request")?.parameters?.required_approving_review_count ?? 0,
  codeOwner: Boolean(rs.rules?.find((r) => r.type === "pull_request")?.parameters?.require_code_owner_review),
  lastPush: Boolean(rs.rules?.find((r) => r.type === "pull_request")?.parameters?.require_last_push_approval),
  contexts: (rs.rules?.find((r) => r.type === "required_status_checks")?.parameters?.required_status_checks || []).map((c) => c.context).sort(),
});

/** ONLINE: the live default-branch rulesets (and the environments that deploy) against the generated ones. fetch is injected (tests, the CLI). */
export async function verifyGithub({ repo, token, fetch, desired, environments = [] }) {
  const problems = [];
  const call = async (path) => { const r = await fetch(`https://api.github.com/repos/${repo}/${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "kit-agent-guard" } }); let body = null; try { body = await r.json(); } catch { /* the tool is unavailable or found nothing: the caller handles the empty answer */ } return { status: r.status, body }; };
  const list = await call("rulesets?includes_parents=true");
  if (list.status === 403 && /upgrade to github|make this repository public/i.test(String(list.body?.message))) problems.push(P(repo, "UNAVAILABLE: this repository's plan cannot enforce rulesets (GitHub: \"Upgrade to GitHub Pro or make this repository public\"). Nothing server-side stops a push to the default branch or a red merge: the plan, or the repository's visibility, is the owner's."));
  else if (list.status !== 200) problems.push(P(repo, `rulesets unreadable (HTTP ${list.status}): ${String(list.body?.message || "").slice(0, 120)}`));
  else {
    const live = [];
    for (const rs of list.body) { const d = await call(`rulesets/${rs.id}`); if (d.status === 200) live.push({ ...d.body, _src: rs.source_type }); }
    if (!live.length) problems.push(P(repo, "no ruleset on the default branch: a direct push, a force-push and a red merge are all possible"));
    const want = essentials(desired);
    const best = live.find((l) => l.enforcement === "active" && want.types.every((t) => (l.rules || []).some((r) => r.type === t)));
    if (live.length && !best) problems.push(P(repo, `no active ruleset has all of: ${want.types.join(", ")}`));
    for (const l of live.filter((x) => x.enforcement === "active")) {
      const e = essentials(l);
      if (!e.types.includes("required_status_checks")) problems.push(P(repo, `ruleset "${l.name}" requires no status checks: a pull request with a failing \`npm test\` can merge`));
      else for (const c of want.contexts) if (!e.contexts.includes(c)) problems.push(P(repo, `ruleset "${l.name}" does not require the check "${c}"`));
      if (e.approvals < want.approvals) problems.push(P(repo, `ruleset "${l.name}" requires ${e.approvals} approving reviews (governance requires ${want.approvals}): the author can merge their own change`));
      if (want.codeOwner && !e.codeOwner) problems.push(P(repo, `ruleset "${l.name}" does not require code-owner review`));
      if (want.lastPush && !e.lastPush) problems.push(P(repo, `ruleset "${l.name}" does not require last-push approval`));
      if (e.bypass) problems.push(P(repo, `ruleset "${l.name}" has ${e.bypass} bypass actors`));
    }
  }
  for (const env of environments) {
    const e = await call(`environments/${encodeURIComponent(env)}`);
    if (e.status !== 200) { problems.push(P(`${repo} environment ${env}`, `not readable or absent (HTTP ${e.status})`)); continue; }
    const rev = (e.body.protection_rules || []).find((r) => r.type === "required_reviewers");
    if (!rev || !(rev.reviewers || []).length) problems.push(P(`${repo} environment ${env}`, "has no required reviewers: a deploy job runs without a second person"));
    else if (e.body.can_admins_bypass !== false) problems.push(P(`${repo} environment ${env}`, "administrators can bypass the reviewers"));
  }
  return problems;
}
