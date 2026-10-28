/**
 * kit agent-guard sync [--check]                 write the layers the constitution registry implies: .claude/settings.json guard hooks,
 *                                                the generated rules block in CLAUDE.md, .github/rulesets/default-branch.json
 * kit agent-guard check                          the same as kit check enforcement
 * kit agent-guard coverage [--json]              every rule, its layers, and the rules that are instruction only
 * kit agent-guard managed [--out dir|--verify]  every managed-policy format (Linux, macOS, Windows, server, Codex) and its check; bare: the server JSON for claude.ai > Admin > Claude Code > Managed settings (Owner; Team or Enterprise)
 * kit agent-guard github verify --repo o/r [--env name]   ONLINE: live ruleset and environments against the generated ones (GITHUB_TOKEN, admin)
 * kit agent-guard github apply --repo o/r --yes           ONLINE: create or update the default-branch ruleset (GITHUB_TOKEN, admin; never printed)
 * kit agent-guard identity issue|revoke|list|verify   kit agent ids and their own signing keys (issue and revoke are the owner's)
 * kit agent-guard daemon ensure|stop|status          the resident decision daemon every boundary asks (unix socket in the project; bounded)
 * kit agent-guard evidence verify [--witness [file]]|show             the hash-chained record of every refused action (kit.guard-evidence.v1)
 * kit agent-guard decide                         one decision in process: a hook payload on stdin, the hook output on stdout
 * kit agent-guard audit --base <ref>             CI: the same rules over what a pull request changes
 * kit agent-guard reconcile [--kill] [--objects f --records f] [--repo o/r]   orphan processes, worktrees, branches, pull requests, objects
 * kit agent-guard bench [--check] [--json] [--only id,id]     p50/p99 at every boundary against the registry budgets
 * docs/AGENT-GUARD.md
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBundle, writeBundle } from "../agent-guard/managed.js";
import { CliError } from "../args.js";
import { CHECKS, bundled, loadCanon } from "../canon/index.js";
import { RULESET_FILE, checkEnforcement, coverage, desiredRuleset, effective, guardRel, managedSettings, syncGuard, verifyGithub } from "../agent-guard/install.js";
import { createGuard, ensure, health, readState, stop } from "../agent-guard/daemon.mjs";
import { agentId, issueKey, keyDir, parseId, rowFor, tableProblems } from "../agent-guard/identity.js";
import { formatProblems } from "@saasreport/core/schema";
import { auditDiff } from "../agent-guard/audit.js";
import { witnessPath } from "../agent-guard/identity-daemon.js";
import { verifyEvidence } from "../agent-guard/evidence.js";
import { bench, benchProblems, describeHost } from "../agent-guard/bench.js";
import { TEST } from "../test-seam.js";
import { gitFacts, listProcesses, ownedProcesses, reconcileGit, reconcileObjects, reconcilePrs, reconcileProcesses } from "../agent-guard/reconcile.js";
import { execFileSync } from "node:child_process";
import { gitEnv } from "../git.js";

export async function agentGuard(io, { _: [sub, sub2] = [], flags }) {
  const kit = bundled();
  const { canon } = loadCanon(io.cwd, kit);
  if (sub === "sync") {
    const r = syncGuard(io.cwd, canon || {}, { check: Boolean(flags.check) });
    for (const p of r.problems) io.err(`  - ${p.file}: ${p.problem}`);
    if (r.problems.length) return 1;
    if (flags.check) { for (const f of r.changed) io.err(`  - ${f}: drifts from the registry`); if (r.changed.length) { io.err("kit agent-guard sync --check: stale (run kit agent-guard sync)"); return 1; } io.out("ok agent-guard: generated files match the registry"); return 0; }
    io.out(r.changed.length ? `kit agent-guard sync: wrote ${r.changed.join(", ")}` : "kit agent-guard sync: already current");
    return 0;
  }
  if (sub === "check") {
    const r = checkEnforcement(io.cwd, canon || {}, kit, CHECKS);
    for (const p of r.problems) io.err(`  - ${p.file}: ${p.problem}`);
    io[r.ok ? "out" : "err"](`${r.ok ? "ok" : "FAIL"} enforcement: ${r.summary}`);
    return r.ok ? 0 : 1;
  }
  if (sub === "coverage") {
    const { registry } = effective(io.cwd, canon || {});
    const rows = coverage(registry, CHECKS);
    if (flags.json) { io.out(JSON.stringify(rows, null, 2)); return 0; }
    for (const r of rows) io.out(`${r.mechanical ? "forced " : "TEXT   "} ${r.class.padEnd(12)} ${r.id.padEnd(40)} ${r.layers.join(",")}${r.instructionOnly ? `\n         not forced: ${r.instructionOnly}` : ""}`);
    io.out(`${rows.filter((r) => r.mechanical).length} of ${rows.length} rules have a mechanical layer; ${rows.filter((r) => r.instructionOnly).length} carry a part nothing can force.`);
    return 0;
  }
  if (sub === "managed") {
    if (flags.verify) {
      const problems = verifyBundle(join(dirname(fileURLToPath(import.meta.url)), "../../../.."));
      for (const p of problems) io.err(`  - ${p}`);
      io[problems.length ? "err" : "out"](`${problems.length ? "FAIL" : "ok"} managed: ${problems.length ? `${problems.length} problem(s)` : "every format is well formed and the launcher holds and denies as designed"}`);
      return problems.length ? 1 : 0;
    }
    if (flags.out) { const files = writeBundle(String(flags.out)); io.out(`wrote ${files.length} file(s) under ${flags.out}; see ACTIVATE.md`); return 0; }
    io.out(JSON.stringify(managedSettings(), null, 2)); return 0;
  }
  if (sub === "github" && (sub2 === "verify" || sub2 === "apply")) {
    const repo = flags.repo && String(flags.repo);
    const token = io.env.GITHUB_TOKEN || io.env.GH_TOKEN;
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new CliError("--repo owner/name is required", 2);
    if (!token) throw new CliError("GITHUB_TOKEN (admin on the repository) is not set; it is read from the environment and never printed", 2);
    const { registry } = effective(io.cwd, canon || {});
    const desired = desiredRuleset(io.cwd, canon || {}, registry);
    if (sub2 === "apply") {
      if (!flags.yes) throw new CliError("apply changes the repository's rules: pass --yes (the owner's act)", 2);
      const h = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "kit-agent-guard" };
      const list = await (await io.fetch(`https://api.github.com/repos/${repo}/rulesets`, { headers: h })).json();
      if (!Array.isArray(list)) { io.err(`kit agent-guard: cannot list rulesets: ${String(list?.message || "").slice(0, 160)}`); return 1; }
      const have = list.find((x) => x.name === desired.name);
      const res = await io.fetch(`https://api.github.com/repos/${repo}/rulesets${have ? `/${have.id}` : ""}`, { method: have ? "PUT" : "POST", headers: h, body: JSON.stringify(desired) });
      io.out(res.ok ? `kit agent-guard: ruleset ${have ? "updated" : "created"} on ${repo}` : `kit agent-guard: HTTP ${res.status}`);
      return res.ok ? 0 : 1;
    }
    const envs = flags.env ? [].concat(flags.env).map(String) : [];
    const problems = await verifyGithub({ repo, token, fetch: io.fetch, desired, environments: envs });
    for (const p of problems) io.err(`  - ${p.file}: ${p.problem}`);
    io[problems.length ? "err" : "out"](`${problems.length ? "FAIL" : "ok"} github ${repo}: ${problems.length ? `${problems.length} problem(s)` : "ruleset and environments match the registry"}`);
    return problems.length ? 1 : 0;
  }
  if (sub === "identity") {
    const file = join(io.cwd, "agent-identities.json"), dir = keyDir(io.env || process.env);
    const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { $schema: "kit.agent-identities.v1", owners: [], rows: [] });
    if (sub2 === "issue") {
      // the owner's act: an agent never runs it (the hook refuses it); the private key stays in the 0700 key directory, the public half goes into the table
      const id = agentId({ domain: String(flags.domain || canon?.project || ""), kind: String(flags.kind || ""), local: String(flags.local || "") });
      const t = load(); if (t.rows.some((r) => r.id === id && !r.revokedAt)) throw new CliError(`${id} already has a live key; revoke it first`, 1);
      const k = issueKey(dir, id);
      t.rows.push(rowFor(k, { kind: parseId(id).kind, evidence: flags.evidence ? String(flags.evidence) : undefined }));
      writeFileSync(file, `${JSON.stringify(t, null, 2)}\n`);
      io.out(`issued ${id} (key ${k.fingerprint}); the private key is in ${dir} (0700), never in the repository`); return 0;
    }
    if (sub2 === "revoke") {
      const id = String(flags.id || ""), t = load(), row = t.rows.find((r) => r.id === id && !r.revokedAt);
      if (!row) throw new CliError(`${id || "(--id)"} has no live key`, 1);
      row.revokedAt = new Date().toISOString().slice(0, 10); writeFileSync(file, `${JSON.stringify(t, null, 2)}\n`); io.out(`revoked ${id}`); return 0;
    }
    if (sub2 === "list") { for (const r of load().rows) io.out(`${r.id}  ${r.fingerprint}  ${r.revokedAt ? `revoked ${r.revokedAt}` : `expires ${r.expiresAt}`}`); return 0; }
    if (sub2 === "verify") {
      const t = load(), problems = [...formatProblems(kit.validator.validate(t, kit.byName("agent-identities"))), ...tableProblems(t)];
      for (const p of problems) io.err(`  - ${p}`);
      io[problems.length ? "err" : "out"](`${problems.length ? "FAIL" : "ok"} identities: ${t.rows.length} agent key(s)${problems.length ? `, ${problems.length} problem(s)` : ""}`); return problems.length ? 1 : 0;
    }
    throw new CliError("kit agent-guard identity issue|revoke|list|verify", 2);
  }
  if (sub === "daemon") {
    if (sub2 === "ensure" || sub2 === "start") { const r = await ensure(io.cwd); if (!r.ok) { io.err(`kit agent-guard: ${r.error} (pid ${r.pid} was spawned: stop it with kit agent-guard daemon stop)`); return 2; } io.out(`kit agent-guard: daemon ${r.started ? "started" : "already running"} (${r.addr})`); return 0; }
    if (sub2 === "stop") { const r = await stop(io.cwd); io.out(`kit agent-guard: ${r.stopped ? `stopped pid ${r.pid}` : "no daemon running"}`); return 0; }
    if (sub2 === "status") { const { registry } = effective(io.cwd, canon || {}); const h = await health(join(io.cwd, registry.daemon.addr)); io.out(h ? `ok daemon pid ${h.pid}, ${h.served} decisions served` : "no daemon answering"); return h ? 0 : 1; }
    throw new CliError("daemon: ensure | stop | status", 2);
  }
  if (sub === "evidence") {
    const { registry } = effective(io.cwd, canon || {});
    const file = join(io.cwd, registry.daemon.evidence);
    if (sub2 === "show") { io.out(existsSync(file) ? readFileSync(file, "utf8").trimEnd() : "(no record)"); return 0; }
    const r = verifyEvidence(file, { witness: flags.witness ? (flags.witness === true ? witnessPath(io.cwd, io.env || process.env) : String(flags.witness)) : null });
    for (const p of r.problems) io.err(`  - ${p}`);
    io[r.ok ? "out" : "err"](`${r.ok ? "ok" : "FAIL"} evidence: ${r.records} record(s), chain ${r.ok ? "intact" : "BROKEN"}`);
    return r.ok ? 0 : 1;
  }
  if (sub === "decide") { const out = await createGuard(io.cwd).respond(JSON.parse(readFileSync(0, "utf8") || "{}")); io.out(JSON.stringify(out)); return 0; }
  if (sub === "audit") {
    if (!flags.base) throw new CliError("--base <ref> (the pull request's base) is required", 2);
    const { registry } = effective(io.cwd, canon || {});
    const r = auditDiff(io.cwd, registry, { base: String(flags.base), hookRel: guardRel(io.cwd, canon || {}) });
    for (const p of r.problems) io.err(`  - ${p.file}: [${p.rule}] ${p.reason}`);
    if (r.bootstrap) io.out("notice: the base branch has no guard pack, so guard-path approvals cannot be checked against it (bootstrap): this pull request is held by the owner's CODEOWNERS review, once");
    io[r.problems.length ? "err" : "out"](`${r.problems.length ? "FAIL" : "ok"} audit: ${r.files} changed file(s) against the constitution rules${r.problems.length ? `, ${r.problems.length} problem(s)` : ""}`);
    return r.problems.length ? 1 : 0;
  }
  if (sub === "reconcile") {
    const { registry } = effective(io.cwd, canon || {});
    const o = registry.orphans, now = Date.now();
    // --kill signals processes, so it runs only from a repository root (a .git entry here): from a parent of several worktrees it would end every session beneath it
    if (flags.kill && !existsSync(join(io.cwd, ".git"))) throw new CliError(`kit agent-guard reconcile --kill: ${io.cwd} is not a repository root (no .git entry): run it from the repository whose processes it may end`, 2);
    // one ownership rule (reconcile.js ownedProcesses): only processes whose cwd or --root is under this repository are judged, reported or killed
    const isMarked = (p) => o.processMarkers.some((m) => p.cmd.includes(m));
    const procs = ownedProcesses(io[TEST]?.procs ?? listProcesses(now), io.cwd);
    const kill = io[TEST]?.kill ?? process.kill;
    const marked = procs.filter(isMarked);
    const states = marked.map((p) => { const r = /--root (\S+)/.exec(p.cmd)?.[1]; return r ? readState(r, registry) : null; }).filter(Boolean);
    const sock = join(io.cwd, registry.daemon.addr);
    const problems = reconcileProcesses({ procs, states: [...states, ...(readState(io.cwd, registry) ? [readState(io.cwd, registry)] : [])], sockets: existsSync(sock) ? [await (async () => { const h = await health(sock); return { path: sock, alive: Boolean(h), pid: h?.pid }; })()] : [], markers: o.processMarkers, maxAgeMs: registry.daemon.maxAgeMinutes * 60000 });
    let def = "main"; try { def = execFileSync("git", ["-C", io.cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitEnv() }).trim().replace(/^origin\//, ""); } catch { /* the tool is unavailable or found nothing: the caller handles the empty answer */ }
    if (existsSync(join(io.cwd, ".git"))) { try { problems.push(...reconcileGit({ ...gitFacts(io.cwd, def, now), defaultBranch: def, staleDays: o.staleDays, patterns: o.branchPatterns })); } catch (e) { problems.push({ kind: "git", subject: "git", problem: `cannot list: ${e.message.split("\n")[0]}` }); } }
    if (flags.objects && flags.records) problems.push(...reconcileObjects({ objects: JSON.parse(readFileSync(String(flags.objects), "utf8")), records: JSON.parse(readFileSync(String(flags.records), "utf8")) }));
    if (flags.repo) {
      const token = io.env.GITHUB_TOKEN || io.env.GH_TOKEN;
      if (!token) throw new CliError("GITHUB_TOKEN is not set (read from the environment, never printed)", 2);
      const h = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "kit-agent-guard" };
      const j = async (p) => (await io.fetch(`https://api.github.com/repos/${flags.repo}/${p}`, { headers: h })).json();
      const paged = async (p) => { const all = []; for (let page = 1; page <= 50; page++) { const r = await j(`${p}${p.includes("?") ? "&" : "?"}per_page=100&page=${page}`); if (!Array.isArray(r)) return r; all.push(...r); if (r.length < 100) break; } return all; };   // every page, never the first hundred
      const prs = await paged("pulls?state=open"), brs = await paged("branches");
      if (!Array.isArray(prs) || !Array.isArray(brs)) { problems.push({ kind: "pr", subject: String(flags.repo), problem: "the pull requests or branches could not be listed" }); }
      else problems.push(...reconcilePrs({ prs: prs.map((p) => ({ number: p.number, headRef: p.head.ref, ageDays: (now - Date.parse(p.updated_at)) / 86400000 })), branches: brs.map((b) => b.name), staleDays: o.staleDays, patterns: o.branchPatterns, defaultBranch: def }));
    }
    if (flags.kill) for (const p of problems.filter((x) => x.kind === "process" && /^pid \d+$/.test(x.subject))) { try { kill(Number(p.subject.slice(4)), "SIGTERM"); io.out(`kit agent-guard: terminated ${p.subject}`); } catch { /* the process already exited: there is nothing left to signal */ } }
    if (flags.kill) for (const p of problems.filter((x) => x.kind === "process" && x.subject === sock)) { try { unlinkSync(sock); } catch { /* a file that is already gone is the state wanted */ } }
    for (const p of problems) io.err(`  - [${p.kind}] ${p.subject}: ${p.problem}`);
    io[problems.length ? "err" : "out"](`${problems.length ? "FAIL" : "ok"} reconcile: ${problems.length ? `${problems.length} orphan(s)` : "no orphan process, worktree, branch or object"}`);
    return problems.length ? 1 : 0;
  }
  if (sub === "bench") {
    const { registry } = effective(io.cwd, canon || {});
    const rel = guardRel(io.cwd, canon || {});
    const ctx = { root: io.cwd, registry, hookRel: rel, readFile: () => null, branch: () => "feature" };
    let rows;
    try { rows = await bench(io.cwd, registry, ctx, { only: flags.only ? String(flags.only).split(",") : null, daemonRel: rel }); } catch (e) { throw new CliError(`agent-guard bench: ${e.message}`, 2); }
    if (flags.json) io.out(JSON.stringify(rows, null, 2));
    else for (const r of rows) io.out(r.status === "not-measured" ? `NONE ${r.id.padEnd(17)} NOT MEASURED: ${r.note}` : `${{ pass: "ok  ", fail: "OVER", "not-evaluated": "N/E " }[r.status]} ${r.id.padEnd(17)} p50 ${r.p50.toFixed(3).padStart(8)} ms (budget ${r.budgetP50}${r.p50Evaluated === false ? ", NOT EVALUATED" : ""})   p${r.tailPercentile} ${r.tail.toFixed(3).padStart(8)} ms (budget ${r.budget}${r.tailEvaluated ? "" : ", NOT EVALUATED"})   n=${r.n}${r.failures ? `   ${r.failures} WRONG OUTCOME(S): ${r.failure}` : ""}${r.note ? `   (${r.note})` : ""}`);
    const loadLine = (r) => describeHost(r.load);
    if (!flags.json) for (const r of rows) if (r.status !== "pass" && r.load) io.out(`       host numbers: ${loadLine(r)}`);
    // CI: a row that is not a pass is an annotation of the check run, with the reason and the raw numbers (the log host is not always reachable)
    if (flags.check && io.env.GITHUB_ACTIONS === "true") for (const r of rows) if (r.status !== "pass") io.out(`::error title=agent-guard bench ${r.id} (${r.status})::${String([r.note, r.failure, loadLine(r)].filter(Boolean).join(" | ")).replace(/[\r\n%]/g, " ")}`);
    const bad = benchProblems(rows);
    for (const p of bad) io.err(`  - ${p.file}: ${p.problem}`);
    if (flags.check && bad.length) return 1;
    if (flags.check && rows.some((r) => r.status === "not-evaluated")) { io.err("agent-guard bench --check: the host was loaded or its load could not be measured, so the budgets were NOT evaluated; this is not a pass (exit 3). Run it on a quiet runner."); return 3; }
    return 0;
  }
  throw new CliError(`unknown agent-guard command "${[sub, sub2].filter(Boolean).join(" ")}" (sync, check, coverage, managed, github verify|apply)`, 2);
}
