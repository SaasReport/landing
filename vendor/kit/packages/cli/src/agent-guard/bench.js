/**
 * The budget at every boundary (docs/AGENT-GUARD.md): `kit agent-guard bench [--check]` measures p50 and p99 at EACH boundary an agent's action
 * passes and compares the p99 with the registry's `budgets`. A boundary over its budget is a failing check, not a footnote.
 *
 *   decision        the rules, in process (the hot path every boundary shares; the advisor target is p99 under 1 ms)
 *   egress          the same rules over a network call (the gateway boundary)
 *   audit-per-file  CI: the rules over one changed file
 *   daemon-call     a call to the resident daemon over loopback TCP (what an `http` hook or a gateway pays)
 *   command-hook    the real installed hook command, as Claude Code or Codex runs it: sh, bash builtins, the daemon
 *   git-hook        the real .githooks/pre-commit: bash builtins and the daemon (which runs git itself)
 *   managed-launcher  the owner-only managed-policy launcher: bash, one git call, the repository hook client
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { ask, ensure, readState, stop, verifiedDaemonPid } from "./daemon.mjs";
export { verifiedDaemonPid };
import { addrPath } from "./daemon.mjs";
import { hookCommand } from "./guard-hooks.js";
import { decide, decideEgress, decideGit } from "./rules.js";
import { gitEnv } from "../git.js";

export const PROCESS_BOUNDARIES = ["daemon-call", "command-hook", "git-hook", "managed-launcher"];   // starting a process or crossing a socket on a loaded host measures the scheduler
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
// Every payload carries the outcome it MUST get: a hook that is broken answers fast, and a fast wrong answer is not a pass.
const PAYLOADS = (root) => [
  { expect: "allow", p: { hook_event_name: "PreToolUse", cwd: root, tool_name: "Bash", tool_input: { command: "git status && npm test 2>&1 | tail -5" } } },
  { expect: "allow", p: { hook_event_name: "PreToolUse", cwd: root, tool_name: "Write", tool_input: { file_path: join(root, "src/a.js"), content: "export const a = 1;\n".repeat(40) } } },
  { expect: "allow", p: { hook_event_name: "PreToolUse", cwd: root, tool_name: "Read", tool_input: { file_path: join(root, "README.md") } } },
  { expect: "deny", p: { hook_event_name: "PreToolUse", cwd: root, tool_name: "Bash", tool_input: { command: "git push --force origin b" } } },
  { expect: "allow", p: { hook_event_name: "UserPromptSubmit", cwd: root, prompt: "please fix the failing test" } },
];
/** Why a decision is not the one the payload must get (`expect`: allow | deny), or null. */
export const outcomeProblem = (expect, action, i) => ((expect === "deny" ? action === "deny" : action != null && action !== "deny") ? null : `payload ${i}: ${action ?? "no answer"}, expected ${expect}`);
export const PAYLOAD_EXPECTATIONS = (root) => PAYLOADS(root).map((x) => x.expect);
/** "deny" or "allow" from a decision in the engine's own form ({ action }) or the hook protocol's ({ hookSpecificOutput.permissionDecision }, `{}` = allow); null when it is no decision. */
export const actionOf = (r) => {
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const d = r.action ?? r.hookSpecificOutput?.permissionDecision ?? r.permissionDecision ?? (r.decision === "block" ? "deny" : r.decision);
  return d === "deny" ? "deny" : d == null || d === "allow" || d === "context" ? "allow" : d;
};

/** Why one spawned process did not do what it must (an error, a timeout, a signal, the wrong exit code), or null. */
export function spawnFailure(r, expected, timeoutMs) {
  if (r.error) return r.error.code === "ETIMEDOUT" ? `timed out after ${timeoutMs} ms` : `could not run: ${r.error.message}`;
  if (r.signal) return `killed by ${r.signal}`;
  if (r.status !== expected) { const e = String(r.stderr || "").trim().split("\n")[0].slice(0, 200); return `exited ${r.status}, expected ${expected}${e ? ` (${e})` : ""}`; }
  return null;
}

/**
 * Why a hook run did not do what it must, or null. The hook's contract (hook.sh): it answers on stdout with a JSON object (`{}` allows, a
 * permissionDecision of deny holds) and exits 0; exit 2 HOLDS the action (fail closed). So a run is read by what it SAID, not by a code alone.
 */
export function hookFailure(r, expect, timeoutMs, i = 0) {
  // a hook that answers and exits before reading all of its input makes the write fail with EPIPE: its ANSWER is what is judged, not its manners
  if ((r.error && r.error.code !== "EPIPE") || r.signal) return spawnFailure(r, 0, timeoutMs);
  let action;
  if (r.status === 2) action = "deny";
  else if (r.status === 0) { try { action = actionOf(JSON.parse(String(r.stdout || "").trim())); } catch { /* unparseable input counts as absent, never as a valid value */ return "answered 0 with no JSON object on stdout"; } }
  else return spawnFailure(r, 0, timeoutMs);
  return outcomeProblem(expect, action, i);
}

/** Measure `n` runs after `warm` untimed ones; fn(i) returns a failure text or nothing. → { xs, failures, first }. */
function time(n, warm, fn) {
  let failures = 0, first = null; const reasons = {};
  const note = (i, f) => { if (f) { failures++; first ??= `run ${i}: ${f}`; reasons[f] = (reasons[f] || 0) + 1; } };
  for (let i = 0; i < warm; i++) note(i, fn(i));
  const xs = [];
  for (let i = 0; i < n; i++) { const t = process.hrtime.bigint(); const f = fn(i); xs.push(ms(t)); note(i, f); }
  return { xs, failures, first, reasons, runs: warm + n };
}
async function timeAsync(n, warm, fn) {
  let failures = 0, first = null; const reasons = {};
  const note = (i, f) => { if (f) { failures++; first ??= `run ${i}: ${f}`; reasons[f] = (reasons[f] || 0) + 1; } };
  for (let i = 0; i < warm; i++) note(i, await fn(i));
  const xs = [];
  for (let i = 0; i < n; i++) { const t = process.hrtime.bigint(); const f = await fn(i); xs.push(ms(t)); note(i, f); }
  return { xs, failures, first, reasons, runs: warm + n };
}

/** Cumulative CPU time of this host: { busy, total } in ms, from the kernel's per-CPU counters (an injectable list for tests). */
export function cpuTimes(list = cpus()) {
  let busy = 0, total = 0;
  for (const { times: t } of list) { const all = t.user + t.nice + t.sys + t.idle + t.irq; total += all; busy += all - t.idle; }
  return { busy, total };
}

/**
 * Host CPU from /proc/stat's aggregate line, in ms (needs the clock ticks per second): busy is everything but idle and iowait, STEAL INCLUDED (CPU time a noisy
 * neighbour took from this VM is load, not quiet). null when /proc/stat cannot be read or parsed, or the ticks are unknown. Guest time is already in user.
 */
export function procCpuTimes(read = () => readFileSync("/proc/stat", "utf8"), hz = null) {
  if (!hz) return null;
  try {
    const m = /^cpu\s+(.*)$/m.exec(read()); if (!m) return null;
    const f = m[1].trim().split(/\s+/).map(Number);
    if (f.length < 4 || !f.every(Number.isFinite)) return null;
    const [user, nice, sys, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = f;
    const total = user + nice + sys + idle + iowait + irq + softirq + steal, ms = 1000 / hz;
    return { busy: (total - idle - iowait) * ms, total: total * ms };
  } catch { /* failure here means no value; the caller holds on the empty answer */ return null; }
}

/** Clock ticks per second as the system says (getconf CLK_TCK), or null when it cannot say: then children's CPU is not subtracted (the host looks busier, never idler). */
export function readClockTicks(exec = execFileSync, timeoutMs) {
  try { const n = Number(exec("getconf", ["CLK_TCK"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs })); return Number.isFinite(n) && n > 0 ? n : null; } catch { /* the tool is unavailable or found nothing: the caller handles the empty answer */ return null; }
}
/** Fields of /proc/<pid>/stat from `state` on (utime 11, stime 12, cutime 13, cstime 14), or null when /proc has no such process. */
export function procStat(pid, read = (p) => readFileSync(p, "utf8")) {
  try { const t = read(`/proc/${pid}/stat`); const f = t.slice(t.lastIndexOf(")") + 2).split(" ").map(Number); return f.length > 14 && f.slice(11, 15).every(Number.isFinite) ? f : null; } catch { /* an unreadable or missing file reads as absent; the caller holds on that */ return null; }
}

/** CPU ms used so far by the bench itself: this process, the children it has waited for, and the given pids (the decision daemon it started). Every source is injectable. */
export function ownCpuMs(pids = [], { usage = () => process.cpuUsage(), stat = procStat, hz = null } = {}) {
  const u = usage();
  let total = (u.user + u.system) / 1000;
  if (hz) {
    const self = stat("self"); if (self) total += (self[13] + self[14]) * 1000 / hz;
    for (const pid of pids) { const p = stat(pid); if (p) total += (p[11] + p[12]) * 1000 / hz; }
  }
  return total;
}

/**
 * The CPU time of processes other than the bench between two samples, with the raw numbers: { share, busyMs, totalMs, ownMs, why }. `share` is null
 * (and `why` says what) when it cannot be known: no CPU time passed (the kernel's counters tick in 10 ms steps, so a window shorter than a tick reads
 * zero), a NaN, or the bench's own CPU exceeding the host's busy delta by more than `tolerance` of the window's total CPU time (the two accountings
 * disagree, so neither is believed).
 */
export function foreignDetail(a, b, ownA = 0, ownB = 0, tolerance = 0) {
  // a counter can step back (iowait is folded out of busy but into total, and a source can reset): a negative delta is clamped to no busy time, never read as negative load
  const totalMs = b.total - a.total, busyMs = Math.max(0, b.busy - a.busy), ownMs = ownB - ownA;
  const d = { share: null, busyMs, totalMs, ownMs };
  if (!(totalMs > 0)) return { ...d, why: `no host CPU time passed between the two samples (${totalMs} ms): the counters tick in steps, a window shorter than a tick reads zero` };
  if (!Number.isFinite(busyMs) || !Number.isFinite(ownMs)) return { ...d, why: `a CPU counter is not a number (host busy ${busyMs}, own ${ownMs})` };
  if (ownMs > 0 && busyMs <= 0) return { ...d, why: `the host's busy time did not move (${busyMs} ms) while the bench used ${ownMs.toFixed(0)} ms of CPU: the host counters cannot see this window` };   // never covered by the tolerance
  if (ownMs > busyMs + tolerance * totalMs) return { ...d, why: `the bench's own CPU (${ownMs.toFixed(0)} ms) exceeds the host's busy time (${busyMs.toFixed(0)} ms) by more than ${(tolerance * 100).toFixed(0)}% of ${totalMs.toFixed(0)} ms: the two accountings disagree` };
  const share = (busyMs - ownMs) / totalMs;
  return Number.isFinite(share) ? { ...d, share: Math.min(Math.max(share, 0), 1) } : { ...d, why: "the CPU share is not a number" };
}
export const foreignShare = (a, b, ownA = 0, ownB = 0, tolerance = 0) => foreignDetail(a, b, ownA, ownB, tolerance).share;
/** One line of raw numbers for a CI log or an annotation: one window's. */
export const describeLoad = (x) => (x == null ? "not sampled" : x.skipped ? `skipped (${x.skipped})` : `host busy ${Number(x.busyMs).toFixed(0)} ms of ${Number(x.totalMs).toFixed(0)} ms, own ${Number(x.ownMs).toFixed(0)} ms${x.share == null ? ` -> UNMEASURABLE: ${x.why}` : ` -> others ${(x.share * 100).toFixed(1)}%`}`);
/** The whole row's host numbers: the source of the host CPU, whether children's CPU could be subtracted, the settle window and the run's. */
export const describeHost = (l) => (l ? `source ${l.source}${l.sourceChanged ? " (CHANGED mid-run: /proc/stat became unreadable)" : ""}${l.hz ? "" : " (clock ticks unknown: the children's and the daemon's CPU are not subtracted, so the host may read busier)"}; settle: ${describeLoad(l.settle)}; run: ${describeLoad(l.run)}` : "");

const measurementOf = (registry) => {
  const m = registry.budgets?.measurement;
  for (const k of ["loadLimit", "windowMs", "maxWaitMs", "maxTotalWaitMs", "spawnTimeoutMs", "ownCpuTolerance"]) if (!Number.isFinite(m?.[k])) throw new Error(`the registry has no budgets.measurement.${k}: the bench has no threshold to judge a host by (schema constitution-rules)`);
  return m;
};

/**
 * How busy the host is NOW, after giving it the chance to settle. The 1-minute load average is not that: it is an exponential tail of
 * the last minutes, so the step that ran just before the bench (the parallel `npm test` in CI) left it far above the limit on an idle
 * host and the gate failed with exit 3 depending only on what ran before it. The share of CPU time busy over a short window is the
 * present. A busy host is waited for (bounded, counted in windows, no wall clock); one still busy at the end is genuinely loaded and the
 * budgets are NOT evaluated. A host whose CPU time cannot be read (no time passed, no CPUs, NaN) is NOT idle: `measurable: false`.
 * `sample` and `sleep` are injectable so the test needs neither time nor a loaded host. Thresholds are the registry's (budgets.measurement).
 */
export async function settledLoad({ sample = cpuTimes, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), loadLimit, windowMs, maxWaitMs }) {
  const windows = Math.max(1, Math.ceil(maxWaitMs / windowMs));
  let prev = sample(), load = null, detail = null;
  for (let i = 1; i <= windows; i++) {
    await sleep(windowMs);
    const cur = sample();
    detail = foreignDetail(prev, cur); load = detail.share; prev = cur;
    if (load === null) return { load: null, waited: i, measurable: false, detail };
    if (load <= loadLimit) return { load, waited: i, measurable: true, detail };
  }
  return { load, waited: windows, measurable: true, detail };
}

const NOT_MEASURED = (id, b, note) => ({ id, n: 0, p50: null, tail: null, tailPercentile: b?.p95Ms != null ? 95 : 99, budget: b?.p95Ms ?? b?.p99Ms ?? null, budgetP50: b?.p50Ms ?? null, tailEvaluated: false, p50Evaluated: false, failures: 0, status: "not-measured", ok: false, note });

/**
 * → one row per boundary asked for (every boundary of the registry, or each `only` id; an unknown id throws): { id, n, p50, tail, tailPercentile, budget, ok, status, failures, note? }.
 * A boundary that cannot be measured here is a row of status `not-measured` with its reason, never a missing row. A run that did not do what it must
 * (a hook that exits with the wrong code, errors, is killed or times out) is a FAILURE of the row, however fast it was.
 * `host`: { sample, sleep, own } of the CPU accounting (injectable); `own` is the bench's own CPU in ms, subtracted from the busy share.
 * `scale`: a fraction of the registry's sample counts (tests only; a percentile of too few runs is then NOT EVALUATED, never passed).
 */
export async function bench(root, registry, ctx, opts = {}) {
  const state = { started: false, pid: undefined };
  try { return await runBench(root, registry, ctx, opts, state); }
  finally { if (state.started) await stop(root, { expectPid: state.pid }).catch(() => {}); }      // never leave behind the daemon this run started (it idles for up to an hour); a daemon that was already running is not ours to stop
}

async function runBench(root, registry, ctx, { only = null, scale = 1, daemonRel, host = {} } = {}, state) {
  const M = measurementOf(registry);
  const bounds = registry.budgets.boundaries || [];
  const declared = bounds.map((b) => b.id);
  for (const id of only || []) if (!declared.includes(id)) throw new Error(`unknown boundary "${id}" (the registry declares ${declared.join(", ")})`);
  const rows = [];
  const want = (id) => !only || only.includes(id);
  const spec = (id) => { const b = bounds.find((x) => x.id === id); return { b, n: Math.max(1, Math.round(b.samples * scale)), warm: b.warmup }; };
  // host load is host-wide: /proc/stat (steal counted as busy), os.cpus() only when that cannot be read; a cgroup's usage would hide a loaded sibling cgroup
  const tickHz = host.hz ?? (host.sample ? null : readClockTicks(execFileSync, M.spawnTimeoutMs));
  const procSource = !host.sample && procCpuTimes(host.readProc, tickHz) !== null;
  const sourceName = host.sample ? "injected" : procSource ? "proc-stat" : "os.cpus (no steal time)";
  let fallbacks = 0;      // samples that had to come from os.cpus() because /proc/stat stopped answering mid-run: never silently mixed into one delta
  const sample = host.sample || (procSource ? () => { const p = procCpuTimes(host.readProc, tickHz); if (p) return p; fallbacks++; return cpuTimes(); } : cpuTimes), sleep = host.sleep, clock = host.clock || (() => Number(process.hrtime.bigint()) / 1e6);
  let daemonPid = null;
  const hz = host.own ? null : tickHz ?? readClockTicks(execFileSync, M.spawnTimeoutMs);
  const own = host.own || (() => ownCpuMs(daemonPid ? [daemonPid] : [], { hz }));
  let waitLeft = M.maxTotalWaitMs;     // the wait over every boundary of the run is bounded too
  const add = (id, t, why, load, unknown = false) => {
    const { b } = spec(id), xs = t.xs, proc = PROCESS_BOUNDARIES.includes(id);      // starting a process on a loaded host measures the scheduler, not the boundary
    const pc = b.p95Ms != null ? 95 : 99, budget = b.p95Ms ?? b.p99Ms, need = Math.ceil(100 / (100 - pc));   // a percentile of fewer runs than 1/(1-p) is the maximum
    const p50 = q(xs, 0.5), tail = q(xs, pc / 100);
    const loaded = why !== null, p50Ev = !unknown && !(loaded && proc), enough = xs.length >= need, tailEv = !loaded && enough;
    const over = (p50Ev && p50 > b.p50Ms) || (tailEv && tail > budget);
    const status = t.failures || over ? "fail" : (p50Ev && tailEv ? "pass" : "not-evaluated");     // a loaded host never reports ok: it measured the neighbours
    const note = loaded ? `${proc ? "p50 and p" + pc : "p" + pc} not evaluated: ${why}` : !enough ? `p${pc} not evaluated: ${xs.length} runs are too few for a p${pc} (needs ${need})` : null;
    rows.push({ id, n: xs.length, p50, tail, tailPercentile: pc, budget, budgetP50: b.p50Ms, tailEvaluated: tailEv, p50Evaluated: p50Ev, failures: t.failures, runs: t.runs, ...(t.failures ? { reasons: t.reasons } : {}), ...(t.first ? { failure: t.first } : {}), status, ok: status === "pass", ...(note ? { note } : {}), ...(load ? { load } : {}) });
  };
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  // settle, measure, and look at the host again: a burst that came after the first look must not be measured, and the bench's own CPU is not a neighbour
  const boundary = async (id, run) => {
    const fb0 = fallbacks;
    const quiet = await settledLoad({ sample, ...(sleep ? { sleep } : {}), ...M, maxWaitMs: Math.min(M.maxWaitMs, waitLeft) });
    waitLeft = Math.max(0, waitLeft - quiet.waited * M.windowMs);
    const h0 = sample(), o0 = own(), t0 = clock();
    const t = await run();
    const elapsed = clock() - t0;
    // The kernel's counters tick in 10 ms steps: a run shorter than a window cannot be seen in them at all (CI: an in-process boundary of a few ms read
    // "no CPU time passed"). Such a run is judged by the quiet window right before it; a longer one is sampled again, minus the bench's own CPU.
    const during = elapsed >= M.windowMs ? foreignDetail(h0, sample(), o0, own(), M.ownCpuTolerance) : { skipped: `the run took ${elapsed.toFixed(0)} ms, less than the ${M.windowMs} ms window: judged by the quiet window before it` };
    const changed = fallbacks > fb0;      // /proc/stat stopped answering and os.cpus() took over: two sources are not one delta
    const unknown = changed || !quiet.measurable || (!during.skipped && during.share === null);     // no verdict at all, an in-process p50 included
    const why = changed ? "the host CPU source changed during the measurement (/proc/stat became unreadable, os.cpus() took over): the numbers are not comparable" : unknown ? "the host's CPU time cannot be measured, so its load is unknown"
      : quiet.load > M.loadLimit ? `${pct(quiet.load)} of CPU busy`
      : !during.skipped && during.share > M.loadLimit ? `${pct(during.share)} of CPU busy by other processes during the measurement` : null;
    add(id, t, why, { source: sourceName, sourceChanged: changed, hz, settle: quiet.detail, run: during }, unknown);
  };
  const skip = (id, note) => rows.push(NOT_MEASURED(id, bounds.find((x) => x.id === id), note));
  const pl = PAYLOADS(root);
  const dctx = { ...ctx, readFile: () => null, branch: () => "feature" };
  // in process: the outcome of every payload is checked once, outside the timing (the timed loop would otherwise pay for the check)
  const outcomeOf = (fn) => pl.flatMap((x, i) => outcomeProblem(x.expect, actionOf(fn(x)), i) ?? []);
  const inProc = (id, mk, check) => async () => { const bad = check(); const t = time(spec(id).n, spec(id).warm, mk); return bad.length ? { ...t, failures: t.failures + bad.length, runs: t.runs + bad.length, first: t.first ?? bad[0] } : t; };
  if (want("decision")) await boundary("decision", inProc("decision", (i) => { decide(pl[i % pl.length].p, dctx); }, () => outcomeOf((x) => decide(x.p, dctx))));
  const egress = (i) => ({ hook_event_name: "Egress", method: i % 2 ? "GET" : "POST", url: "https://api.github.com/repos/o/r/issues", body: "{}" });
  if (want("egress")) await boundary("egress", inProc("egress", (i) => { decideEgress(egress(i), dctx); }, () => [0, 1].flatMap((i) => (actionOf(decideEgress(egress(i), dctx)) === "allow" ? [] : [`egress ${i}: not allowed`]))));
  const commit = (i) => ({ hook_event_name: "GitCommit", branch: null, files: [{ path: `src/f${i}.js`, before: "a\n", after: "export const x = 1;\n".repeat(60) }] });
  if (want("audit-per-file")) await boundary("audit-per-file", inProc("audit-per-file", (i) => { decideGit(commit(i), dctx); }, () => (actionOf(decideGit(commit(0), dctx)) === "allow" ? [] : ["the commit of one clean file was not allowed"])));
  let addr = null;
  if (want("daemon-call") || (daemonRel && PROCESS_BOUNDARIES.some(want))) {
    const e = await ensure(root); addr = e.addr; state.started = Boolean(e.started); state.pid = e.pid; if (!e.ok) throw new Error(e.error);      // the finally stops what was spawned
    daemonPid = verifiedDaemonPid(e.pid ?? readState(root, registry)?.pid, root, registry);
  }
  if (want("daemon-call")) await boundary("daemon-call", () => timeAsync(spec("daemon-call").n, spec("daemon-call").warm, async (i) => { const x = pl[i % pl.length]; const a = actionOf(await ask(addr, x.p)); return outcomeProblem(x.expect, a, i % pl.length); }));
  const NO_HOOK = "no hook path to measure the installed hook from";
  const hookRun = (cmd, args, opts, x, i) => hookFailure(spawnSync(cmd, args, { ...opts, encoding: "utf8", timeout: M.spawnTimeoutMs }), x.expect, M.spawnTimeoutMs, i % pl.length);
  if (want("command-hook")) {
    if (!daemonRel) skip("command-hook", NO_HOOK);
    else { const cmd = hookCommand(daemonRel); await boundary("command-hook", () => time(spec("command-hook").n, spec("command-hook").warm, (i) => { const x = pl[i % pl.length]; return hookRun("sh", ["-c", cmd], { input: JSON.stringify(x.p), env: { ...process.env, CLAUDE_PROJECT_DIR: root } }, x, i); })); }
  }
  if (want("git-hook")) {
    if (!daemonRel) skip("git-hook", NO_HOOK);
    else if (!existsSync(join(root, ".git"))) skip("git-hook", "not a git repository");
    else if (!existsSync(join(root, ".githooks/pre-commit"))) skip("git-hook", "no .githooks/pre-commit");
    else {
      // against a clean index (HEAD's tree), so what the working tree has staged does not decide the number: nothing staged, so the hook
      // passes (exit 0), except on a protected branch, where the guard holds every commit (exit 1): each is the outcome it must give
      let branch = null;
      try { branch = execFileSync("git", ["-C", root, "symbolic-ref", "--short", "-q", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: M.spawnTimeoutMs, env: gitEnv() }).trim() || null; } catch { /* detached HEAD: no branch */ }
      const gitExit = branch && registry.git?.protectedBranches?.includes(branch) ? 1 : 0;
      const idx = join(tmpdir(), `kit-bench-index-${process.pid}`);
      let readTree = true;
      try { execFileSync("git", ["-C", root, "read-tree", `--index-output=${idx}`, "HEAD"], { env: gitEnv(), stdio: "ignore", timeout: M.spawnTimeoutMs }); }
      catch (e) { readTree = false; skip("git-hook", `git read-tree HEAD failed: ${String(e.message).split("\n")[0]}`); }
      if (readTree) {
        try { await boundary("git-hook", () => time(spec("git-hook").n, spec("git-hook").warm, () => spawnFailure(spawnSync("bash", [join(root, ".githooks/pre-commit")], { cwd: root, encoding: "utf8", timeout: M.spawnTimeoutMs, env: { ...gitEnv(), GIT_INDEX_FILE: idx } }), gitExit, M.spawnTimeoutMs))); }
        finally { try { unlinkSync(idx); } catch { /* a file that is already gone is the state wanted */ } }
      }
    }
  }
  if (want("managed-launcher")) {
    const launcher = daemonRel ? join(root, daemonRel, "../launcher.sh") : null;
    if (!daemonRel) skip("managed-launcher", "no hook path to find the launcher from");
    else if (!existsSync(launcher)) skip("managed-launcher", `no launcher at ${launcher}`);
    else await boundary("managed-launcher", () => time(spec("managed-launcher").n, spec("managed-launcher").warm, (i) => { const x = pl[i % pl.length]; return hookRun("bash", [launcher], { input: JSON.stringify(x.p), cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: "" } }, x, i); }));
  }
  return rows;
}
export const benchProblems = (rows) => rows.flatMap((r) => {
  if (r.status === "not-measured") return [{ file: `boundary ${r.id}`, problem: `not measured: ${r.note}` }];
  const out = [];
  if (r.failures) out.push({ file: `boundary ${r.id}`, problem: `${r.failures} of ${r.runs} run(s) (warm-up included) did not do what they must (${r.failure}; ${Object.entries(r.reasons || {}).map(([k, v]) => `${v}x ${k}`).join(", ")}): a fast wrong answer is not a pass` });
  if (r.status === "fail" && !r.failures) out.push({ file: `boundary ${r.id}`, problem: r.budget == null ? "no budget declared in the registry (budgets.boundaries)" : r.p50Evaluated && r.p50 > r.budgetP50 ? `p50 ${r.p50.toFixed(3)} ms is over the budget of ${r.budgetP50} ms (n=${r.n})` : `p${r.tailPercentile} ${r.tail.toFixed(3)} ms is over the budget of ${r.budget} ms (p50 ${r.p50.toFixed(3)} ms, n=${r.n})` });
  return out;
});
