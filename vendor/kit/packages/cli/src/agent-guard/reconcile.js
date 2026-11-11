/**
 * Reconcilers (docs/AGENT-GUARD.md, rule class `orphans`): each compares what EXISTS with what is RECORDED and reports the difference as a problem.
 * Pure functions over listings, so each has must-fail fixtures; the collectors (/proc, git, the GitHub API) are separate and injectable.
 *
 *   process    a decision daemon that outlived its limits, has no state file, or whose state file points at a dead process; a stale socket
 *   git        a worktree whose directory is gone, a local branch already merged into the default branch, a stale branch with no upstream
 *   pr         an open pull request with no activity for staleDays, a remote branch of an agent (claude/**) with no open pull request
 *   object     a stored object with no record, a record with no stored object
 *   generated  (delegated to the canon checks diagrams, vendor, sdk, claude, freshness: a generated artefact with no source fails there)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { globRe } from "../canon/files.js";
import { gitEnv } from "../git.js";

const GIT_KIND = "git";    // the reconciler's class of orphan; a label, not a git call
export const RECONCILERS = ["process", "git", "pr", "object", "generated"];
const P = (kind, subject, problem) => ({ kind, subject, problem });

/** An agent run that is not a decision daemon: `claude -p`, `claude --print`, `codex exec`. */
const AGENT_BIN = /^(?:.*\/)?(claude|codex)$/;
export const AGENT_RUN = { test(cmd) { const w = String(cmd).trim().split(/\s+/); const i = AGENT_BIN.test(w[0]) ? 0 : (/^(?:.*\/)?(node|npx|bunx)$/.test(w[0]) && AGENT_BIN.test(w[1] || "") ? 1 : -1); return i >= 0 && w.slice(i + 1).some((x) => x === "-p" || x === "--print" || x === "exec"); } };
const TICK_TOLERANCE_MS = 5000;

/**
 * procs: [{ pid, ppid?, cmd, ageMs, startMs? }]; states: [{ pid, started?, root }] read from state files; sockets: [{ path, alive, pid? }] (pid: who answered /health).
 * A state file whose pid now belongs to ANOTHER process (start time differs: the pid was reused) is stale, never trusted; an address file answered by a process that is not
 * the one the state names is a fake or foreign listener; an orphaned `claude -p` (reparented to init, or older than the limit) is reported with its pid.
 */
export function reconcileProcesses({ procs, states, sockets = [], markers, maxAgeMs }) {
  const out = [];
  const reused = (st, p) => p && st.started != null && p.startMs != null && Math.abs(p.startMs - st.started) > TICK_TOLERANCE_MS;
  const daemons = procs.filter((p) => markers.some((m) => p.cmd.includes(m)) && /\bserve\b/.test(p.cmd));
  for (const p of daemons) {
    const st = states.find((s) => s.pid === p.pid && !reused(s, p));
    if (!st) out.push(P("process", `pid ${p.pid}`, "a decision daemon with no state file: nothing records it, so nothing will stop it"));
    else if (p.ageMs > maxAgeMs) out.push(P("process", `pid ${p.pid}`, `a decision daemon ${Math.round(p.ageMs / 60000)} minutes old, past its ${Math.round(maxAgeMs / 60000)}-minute limit`));
  }
  for (const s of states) {
    const p = procs.find((x) => x.pid === s.pid);
    if (!p) out.push(P("process", `state of pid ${s.pid}`, "a state file whose process is gone (a stale record)"));
    else if (reused(s, p)) out.push(P("process", `state of pid ${s.pid}`, "a state file whose pid now belongs to another process (the pid was reused): a stale record, the process is not killed on its account"));
  }
  for (const k of sockets) {
    if (!k.alive) out.push(P("process", k.path, "an address file nobody answers on (a stale daemon address)"));
    else if (k.pid != null && !states.some((s) => s.pid === k.pid)) out.push(P("process", k.path, `pid ${k.pid} answers on the daemon address but no state file names it: a fake or foreign listener`));
  }
  for (const p of procs) if (AGENT_RUN.test(p.cmd) && !markers.some((m) => p.cmd.includes(m)) && (p.ppid === 1 || p.ageMs > maxAgeMs)) out.push(P("process", `pid ${p.pid}`, `an orphaned agent run (${p.ppid === 1 ? "its parent is gone" : `${Math.round(p.ageMs / 60000)} minutes old`}): ${p.cmd.slice(0, 60)}`));
  return out;
}

/** worktrees: [{ path, exists, prunable }]; branches: [{ name, merged, upstream, ageDays, checkedOut }]. */
export function reconcileGit({ worktrees, branches, defaultBranch, staleDays, patterns = ["**"] }) {
  const out = [];
  for (const w of worktrees) if (!w.exists || w.prunable) out.push(P(GIT_KIND, w.path, "a worktree whose directory is gone: `git worktree prune`"));
  const re = patterns.map(globRe);
  for (const b of branches) {
    if (b.name === defaultBranch || b.checkedOut) continue;
    if (b.merged) out.push(P(GIT_KIND, b.name, `a branch already merged into ${defaultBranch}: delete it`));
    else if (b.squashMerged) out.push(P(GIT_KIND, b.name, `a branch whose changes are already in ${defaultBranch} (squash-merged): delete it`));
    else if (re.some((r) => r.test(b.name)) && !b.upstream && b.ageDays > staleDays) out.push(P(GIT_KIND, b.name, `an agent branch with no upstream and no commit for ${Math.round(b.ageDays)} days: push it or delete it`));
  }
  return out;
}

/** prs: [{ number, headRef, ageDays }] open; branches: [name] on the remote. */
export function reconcilePrs({ prs, branches, staleDays, patterns = ["**"], defaultBranch = "main" }) {
  const out = [];
  const re = patterns.map(globRe);
  for (const p of prs) if (p.ageDays > staleDays) out.push(P("pr", `#${p.number}`, `an open pull request with no activity for ${Math.round(p.ageDays)} days`));
  for (const b of branches) if (b !== defaultBranch && re.some((r) => r.test(b)) && !prs.some((p) => p.headRef === b)) out.push(P("pr", b, "an agent branch on the remote with no open pull request"));
  return out;
}

/** objects: [key] stored; records: [{ key }] recorded. */
export function reconcileObjects({ objects, records }) {
  const out = [];
  const rec = new Set(records.map((r) => r.key)), obj = new Set(objects);
  for (const o of objects) if (!rec.has(o)) out.push(P("object", o, "a stored object with no record (quarantined, sniffed and recorded by nothing)"));
  for (const r of rec) if (!obj.has(r)) out.push(P("object", r, "a record whose object is gone"));
  return out;
}

// ------------------------------------------------------------------------------------------------------------------ collectors
/**
 * ONE ownership rule for every process the reconciler judges (a decision daemon or an agent run): it is this repository's when its working
 * directory or its `--root` is root or under it. The process table is the whole machine's; a process that is another session's, or whose owner
 * cannot be read, is neither reported nor killed.
 */
export function ownedProcesses(procs, root) {
  const base = resolve(root);
  const under = (d) => typeof d === "string" && d !== "" && (resolve(d) === base || resolve(d).startsWith(base + sep));
  // a relative --root belongs to the process's own working directory (Codex on #148: resolved against the reconciler's cwd, another
  // repository's `daemon.mjs serve --root .` read as this one's and could be killed); with no readable cwd a relative root decides nothing
  const rootOf = (p) => { const r = /--root (\S+)/.exec(p.cmd)?.[1]; if (!r) return undefined; if (isAbsolute(r)) return r; return typeof p.cwd === "string" && p.cwd ? resolve(p.cwd, r) : undefined; };
  return procs.filter((p) => under(p.cwd) || under(rootOf(p)));
}

/** Linux /proc: [{ pid, ppid, cmd, ageMs, startMs, cwd }] (cwd undefined when /proc/<pid>/cwd cannot be read). */
export function listProcesses(now = Date.now()) {
  const out = [];
  let boot = 0, hz = 100;
  try { boot = Number(/btime (\d+)/.exec(readFileSync("/proc/stat", "utf8"))[1]) * 1000; } catch { /* an unreadable or missing file reads as absent; the caller holds on that */ return out; }
  try { hz = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()) || 100; } catch { /* the tool is unavailable or found nothing: the caller handles the empty answer */ }
  for (const d of readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
    try {
      const cmd = readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      const stat = readFileSync(`/proc/${d}/stat`, "utf8"); const start = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
      const startMs = boot + (start / hz) * 1000; let cwd; try { cwd = readlinkSync(`/proc/${d}/cwd`); } catch { /* another user's process or one that exited: no cwd, so it is nobody's here */ }
      out.push({ pid: Number(d), ppid: Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]), cmd, ageMs: now - startMs, startMs, cwd });
    } catch { /* failure here means no value; the caller holds on the empty answer */ }
  }
  return out;
}

export function gitFacts(root, defaultBranch, now = Date.now()) {
  const g = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitEnv() });
  const worktrees = []; let cur = null;
  for (const l of g("worktree", "list", "--porcelain").split("\n")) {
    if (l.startsWith("worktree ")) { cur = { path: l.slice(9), prunable: false }; worktrees.push(cur); }
    else if (l.startsWith("prunable") && cur) cur.prunable = true;
  }
  for (const w of worktrees) w.exists = existsSync(w.path);
  const merged = new Set(g("branch", "--merged", defaultBranch, "--format=%(refname:short)").split("\n").filter(Boolean));
  const checked = new Set(worktrees.map((w) => { try { return execFileSync("git", ["-C", w.path, "symbolic-ref", "--short", "-q", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitEnv() }).trim(); } catch { /* the tool is unavailable or found nothing: the caller handles the empty answer */ return ""; } }));
  // a squash-merged branch is not an ancestor: merging it into the default branch would change nothing (the merge tree equals the default branch's tree)
  const defTree = (() => { try { return g("rev-parse", `${defaultBranch}^{tree}`).trim(); } catch { /* failure here means no value; the caller holds on the empty answer */ return null; } })();
  const squashed = (name) => { try { return defTree != null && g("merge-tree", "--write-tree", defaultBranch, name).split("\n")[0].trim() === defTree; } catch { /* failure here means no value; the caller holds on the empty answer */ return false; } };
  const branches = g("for-each-ref", "refs/heads", "--format=%(refname:short)\t%(upstream:short)\t%(committerdate:unix)").split("\n").filter(Boolean).map((l) => { const [name, upstream, ts] = l.split("\t"); return { name, upstream: upstream || null, ageDays: (now / 1000 - Number(ts)) / 86400, merged: merged.has(name), squashMerged: !merged.has(name) && name !== defaultBranch && squashed(name), checkedOut: checked.has(name) }; });
  return { worktrees: worktrees.map((w) => ({ path: w.path, exists: w.exists, prunable: w.prunable })), branches };
}

export const pathJoin = join;
