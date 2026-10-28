#!/usr/bin/env node
/**
 * The resident decision daemon (docs/AGENT-GUARD.md): ONE decision path for every boundary an agent action passes. Zero npm dependencies.
 *
 *   POST /decide  a Claude Code or Codex hook payload (PreToolUse, UserPromptSubmit, SessionStart, SubagentStart, SubagentStop, ConfigChange) or a
 *                 kit event (GitCommit, GitCommitMsg, GitPush, Egress) → the rules (rules.js) first, then the advisors (advise.js, tighten-only),
 *                 a hash-chained evidence record for every refusal, the answer in the format the caller reads
 *   POST /action   an action broker's question (action class + agent id → a signed decision, recorded)
 *   GET  /health
 * listens on loopback TCP (127.0.0.1, an OS-assigned port) and requires the per-daemon key in `x-guard-key`; the port and key are written to
 * `.claude/guard.addr` (mode 0600). A hook is `bash hook.sh`: builtins only, no process per call beyond bash, and it FAILS CLOSED (exit 2) when
 * the daemon cannot answer. For git the daemon runs git itself (a warm `git cat-file --batch`, verdicts cached by blob hash), so a git hook starts
 * no node and no git. Every process here is bounded: the daemon exits when idle, when old, when its state file or project disappears and on
 * SIGTERM, and its git helper dies with it. `reconcile` finds anything that outlived that.
 *
 *   node daemon.mjs serve | ensure | stop | status | decide      (--root dir; default CLAUDE_PROJECT_DIR or cwd)
 */
import http from "node:http";
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { advise } from "./advise.js";
import { EvidenceLog } from "./evidence.js";
import { parseId } from "./identity.js";
import { decide, decideEgress, decideGit } from "./rules.js";
import { CANON_FILE, loadEffective, PROJECT_FILE } from "./registry.js";
import { gitEnv } from "../git.js";

const SELF = fileURLToPath(import.meta.url);
const KIT_REGISTRY = join(dirname(SELF), "../../../core/registry/constitution.rules.json");
const ADVISED = new Set(["PreToolUse", "UserPromptSubmit", "SubagentStart", "GitCommit", "GitPush", "Egress"]);
const MAX_TEXT = 262144;
const ZERO = /^0+$/;
const mtime = (f) => { try { return statSync(f).mtimeMs; } catch { /* an unreadable or missing file reads as absent; the caller holds on that */ return 0; } };

// ------------------------------------------------------------------------------------------------------------------ git, server side
const gitRun = (cwd, args, env) => new Promise((res, rej) => execFile("git", args, { cwd, env: gitEnv({ ...process.env, GIT_INDEX_FILE: env.GIT_INDEX_FILE }, { keep: ["GIT_INDEX_FILE"] }), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (e, out) => (e ? rej(e) : res(out))));

/** A warm `git cat-file --batch` per working directory: blob contents by hash, one request at a time. */
function catFile(cwd, env) {
  const child = spawn("git", ["cat-file", "--batch"], { cwd, env: gitEnv({ ...process.env, GIT_INDEX_FILE: env.GIT_INDEX_FILE }, { keep: ["GIT_INDEX_FILE"] }), stdio: ["pipe", "pipe", "ignore"] });
  let buf = Buffer.alloc(0); const queue = [];
  child.stdout.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const nl = buf.indexOf(10); if (nl < 0 || !queue.length) return;
      const head = buf.subarray(0, nl).toString(); const m = /^(\S+) (\S+)(?: (\d+))?$/.exec(head);
      if (!m) { queue.shift().resolve(null); buf = buf.subarray(nl + 1); continue; }
      if (m[2] === "missing") { queue.shift().resolve(null); buf = buf.subarray(nl + 1); continue; }
      const size = Number(m[3]); if (buf.length < nl + 1 + size + 1) return;
      const body = buf.subarray(nl + 1, nl + 1 + size); buf = buf.subarray(nl + 1 + size + 1);
      queue.shift().resolve(body.includes(0) ? "" : body.subarray(0, MAX_TEXT).toString("utf8"));   // binary: judged by path only; very large text: its first part
    }
  });
  child.on("error", () => { for (const q of queue.splice(0)) q.resolve(null); });
  child.on("close", () => { for (const q of queue.splice(0)) q.resolve(null); });
  return { blob: (sha) => new Promise((resolve) => { queue.push({ resolve }); child.stdin.write(`${sha}\n`); }), kill: () => child.kill() };
}

/** The staged changes of a working directory, as { path, before, after, key } (key: path and the two blob hashes). */
async function stagedFiles(cwd, index, helpers) {
  const env = index ? { GIT_INDEX_FILE: index } : {};
  const out = await gitRun(cwd, ["-c", "core.quotepath=off", "diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev"], env);
  const parts = out.split("\0"); const files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:\d+ \d+ (\w+) (\w+) (\w+)$/.exec(parts[i]); if (!m) continue;
    files.push({ path: parts[i + 1], oldsha: ZERO.test(m[1]) ? null : m[1], newsha: ZERO.test(m[2]) ? null : m[2], key: `${parts[i + 1]}\0${m[1]}\0${m[2]}` });
  }
  const cat = helpers.catFor(cwd, env);
  for (const f of files) { f.before = f.oldsha ? await cat.blob(f.oldsha) : null; f.after = f.newsha ? await cat.blob(f.newsha) : null; }
  return files;
}

/** The guard for one project: registry cached by file times, `respond(payload)` → the JSON a hook prints. */
export function createGuard(root, kitRegistryFile = KIT_REGISTRY, extra = {}) {
  let cache = null;
  const verdicts = new Map();       // `${path}\0${oldsha}\0${newsha}` → decision: a blob that was judged once is not judged again
  const cats = new Map();
  let log = null, logFile = null;
  const evidenceLog = (reg) => { const f = join(root, reg.daemon.evidence); if (!log || logFile !== f) { log = new EvidenceLog(f, { witness: extra.witness }); logFile = f; } return log; };
  const catFor = (cwd, env) => { const k = `${cwd}\0${env.GIT_INDEX_FILE || ""}`; if (!cats.has(k)) cats.set(k, catFile(cwd, env)); return cats.get(k); };
  const registry = () => {
    const k = `${mtime(kitRegistryFile)}:${mtime(join(root, PROJECT_FILE))}:${mtime(join(root, CANON_FILE))}`;
    if (!cache || cache.k !== k) { const e = loadEffective(root, kitRegistryFile); if (e.problems.length) throw new Error(`constitution registry: ${e.problems[0]}`); cache = { k, registry: e.registry }; verdicts.clear(); }
    return cache.registry;
  };
  const ctxOf = (reg) => ({
    root, registry: reg, hookRel: relative(root, SELF).split("\\").join("/"),
    readFile: (p) => { try { return readFileSync(p, "utf8"); } catch { /* an unreadable or missing file reads as absent; the caller holds on that */ return null; } },
    branch: () => { try { let g = join(root, ".git"); const f = readFileSync(g, "utf8"); if (f.startsWith("gitdir:")) g = join(root, f.slice(7).trim()); const h = readFileSync(join(g, "HEAD"), "utf8").trim(); return h.startsWith("ref: refs/heads/") ? h.slice(16) : null; } catch { /* an unreadable or missing file reads as absent; the caller holds on that */ try { const h = readFileSync(join(root, ".git/HEAD"), "utf8").trim(); return h.startsWith("ref: refs/heads/") ? h.slice(16) : null; } catch { return null; /* no readable HEAD: no branch is known, so no branch rule applies */ } } },
  });
  /** A GitCommit that names a working directory instead of listing files: the daemon reads the staged changes itself. */
  async function gitCommit(payload, reg, ctx) {
    const cwd = payload.cwd;
    if (!cwd || !(cwd === root || cwd.startsWith(`${root}/`))) return { action: "deny", rule: "git-protected-branch-push", reason: `the git hook ran in ${cwd || "an unknown directory"}, outside this project: the decision is held` };
    let branch = null; try { branch = (await gitRun(cwd, ["symbolic-ref", "--short", "-q", "HEAD"], {})).trim() || null; } catch { /* the tool is unavailable or found nothing: the caller handles the empty answer */ }
    if (branch && reg.git.protectedBranches.includes(branch)) return decideGit({ hook_event_name: "GitCommit", branch, files: [] }, ctx);
    const files = await stagedFiles(cwd, payload.index || null, { catFor });
    for (const f of files) {
      if (verdicts.has(f.key)) { const v = verdicts.get(f.key); if (v) return v; continue; }
      const d = decideGit({ hook_event_name: "GitCommit", branch: null, files: [{ path: f.path, before: f.before, after: f.after }] }, ctx);
      verdicts.set(f.key, d.action === "deny" ? d : null);
      if (d.action === "deny") return d;
    }
    return { action: "allow" };
  }
  /** → { d: decision, ev }. */
  async function judge(payload) {
    const reg = registry(), ctx = ctxOf(reg), ev = payload.hook_event_name || "";
    let d;
    if (ev === "GitCommit") d = payload.files ? decideGit(payload, ctx) : await gitCommit(payload, reg, ctx);
    else if (ev === "GitCommitMsg") d = extra.commitMsg ? await extra.commitMsg(payload, reg) : { action: "allow" };
    else if (ev === "GitPush") d = decideGit(payload, ctx);
    else if (ev === "Egress") d = decideEgress(payload, ctx);
    else d = decide(payload, ctx);
    if (d.action === "allow" && ADVISED.has(ev)) { const a = await advise(reg, payload); if (a) d = { action: "deny", ...a }; }
    // EVERY decision leaves a record (allow and deny). If it cannot be written the decision is not returned: the daemon answers 500 and the hook holds.
    if (d.action !== "context") evidenceLog(reg).append({ payload, decision: d, registry: reg, principal: extra.principalOf?.(payload) });
    return { d, ev };
  }
  /**
   * The interface an action broker (a separate component, owned elsewhere) calls BEFORE it performs a consequential action for an agent:
   * { action_class, agent_id, subject?, params? } → a decision, recorded as evidence (allow AND deny), signed by the guard's own key when it has one.
   * Deterministic: the class must be declared in the registry, the agent id must be a kit agent id, a subject (what the action is about) must be named.
   */
  function decideAction(req) {
    const reg = registry(), id = String(req?.agent_id || ""), cls = String(req?.action_class || "");
    let d = { action: "allow" };
    if (!(reg.actions || []).some((a) => a.id === cls)) d = { action: "deny", rule: "undeclared-action", reason: `${cls || "(none)"} is not a declared action class; the owner declares it in the registry first` };
    else if (!parseId(id)) d = { action: "deny", rule: "agent-identity", reason: `${id || "(none)"} is not a kit agent id (kit:agent:<trust-domain>:<kind>:<local>)` };
    else if (!req.subject || typeof req.subject !== "string") d = { action: "deny", rule: "undeclared-action", reason: "the action names no subject (what it acts on)" };
    const payload = { hook_event_name: "Action", tool_name: `action:${cls}`, tool_input: { subject: req?.subject, params: req?.params }, agent_id: id };
    const rec = evidenceLog(reg).append({ payload, decision: d, registry: reg, actionClass: cls || null });
    const out = { schema: "kit.guard-decision.v1", decision: d.action, rule: d.rule ?? null, reason: d.reason ?? null, action_class: cls, agent_id: id, evidence: { seq: rec.seq, hash: rec.hash }, at: rec.at };
    if (extra.signDecision) { try { out.sig = extra.signDecision(JSON.stringify(out)); } catch { /* no usable key: the record stays unsigned and verifies as unsigned */ } }
    return out;
  }
  async function respond(payload) { const { d, ev } = await judge(payload); return format(ev, d, payload, extra); }
  const close = () => { for (const c of cats.values()) c.kill(); };
  return { respond, judge, decideAction, registry, close };
}

/** A decision as the JSON the caller reads: Claude Code and Codex hook output, or the kit's own shape. */
export function format(ev, d, payload = {}, extra = {}) {
  const why = d.action === "deny" ? `agent-guard [${d.rule}]: ${d.reason}` : "";
  if (d.action === "context") return { hookSpecificOutput: { hookEventName: ev, additionalContext: d.text + (extra.contextSuffix?.(payload) || "") } };
  if (ev === "PreToolUse") {
    if (d.action === "deny") return { hookSpecificOutput: { hookEventName: ev, permissionDecision: "deny", permissionDecisionReason: why } };
    const upd = extra.updatedInput?.(payload);
    return upd ? { hookSpecificOutput: { hookEventName: ev, permissionDecision: "allow", updatedInput: upd } } : {};
  }
  if (["UserPromptSubmit", "ConfigChange", "Stop", "SubagentStop"].includes(ev)) return d.action === "deny" ? { decision: "block", reason: why } : {};
  return { decision: d.action === "deny" ? "deny" : "allow", rule: d.rule, reason: d.reason, ...(d.trailer_text ? { trailer_text: d.trailer_text } : {}) };
}

// ------------------------------------------------------------------------------------------------------------------ client side
export const addrPath = (root, reg) => join(root, reg.daemon.addr);
export function readAddr(file) { try { const [port, key] = readFileSync(file, "utf8").trim().split(" "); return port && key ? { port: Number(port), key } : null; } catch { /* an unreadable or missing file reads as absent; the caller holds on that */ return null; } }
const request = (addr, method, path, body, timeoutMs = 2000) => new Promise((res, rej) => {
  const r = http.request({ host: "127.0.0.1", port: addr.port, method, path, headers: { "x-guard-key": addr.key, ...(body ? { "content-type": "application/json" } : {}) }, timeout: timeoutMs, agent: false }, (rsp) => { let b = ""; rsp.on("data", (c) => (b += c)); rsp.on("end", () => (rsp.statusCode === 200 ? res(b ? JSON.parse(b) : {}) : rej(new Error(`HTTP ${rsp.statusCode}`)))); });
  r.on("timeout", () => r.destroy(new Error("timeout"))); r.on("error", rej);
  r.end(body ? JSON.stringify(body) : undefined);
});
export const health = (addrFile) => { const a = readAddr(addrFile); return a ? request(a, "GET", "/health", null, 500).catch(() => /* an unreachable peer reads as no answer */ null) : Promise.resolve(null); };
export const ask = (addrFile, payload, timeoutMs = 2000) => { const a = readAddr(addrFile); return a ? request(a, "POST", "/decide", payload, timeoutMs) : Promise.reject(new Error("no daemon address")); };

/**
 * Start the daemon unless it already answers. Detached (its own process group), stdio ignored, bounded by its own idle and age limits.
 * → { started, addr, pid?, ok }. A daemon that was spawned but did not answer in time is NOT thrown away: it comes back as { started: true, pid, ok: false, error },
 * so the caller that spawned it can stop it (a git hook's trap, the bench's finally) instead of leaving an unreachable process behind.
 * `opts.argv` and `opts.attempts` exist for tests (a process that never serves, a short wait).
 */
export async function ensure(root, kitRegistryFile = KIT_REGISTRY, { argv, attempts = 60 } = {}) {
  const reg = loadEffective(root, kitRegistryFile).registry;
  const file = addrPath(root, reg);
  if (await health(file)) return { started: false, addr: file, ok: true };
  try { unlinkSync(file); } catch { /* a file that is already gone is the state wanted */ }
  const child = spawn(process.execPath, argv || [SELF, "serve", "--root", root], { detached: true, stdio: "ignore", env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  child.unref();
  for (let i = 0; i < attempts; i++) { await new Promise((r) => setTimeout(r, 50)); if (await health(file)) return { started: true, addr: file, pid: child.pid, ok: true }; }
  return { started: true, addr: file, pid: child.pid, ok: false, error: `the decision daemon did not come up within ${(attempts * 50) / 1000} s` };
}

export function readState(root, reg) { try { return JSON.parse(readFileSync(join(root, reg.daemon.state), "utf8")); } catch { /* unparseable input counts as absent, never as a valid value */ return null; } }
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { /* the process already exited: there is nothing left to signal */ return false; } };

/** The command line of a process: /proc's NUL-separated argv, or `ps -o command=` where there is no /proc (macOS): a string, or null when neither can say. */
export function processCommand(pid, { readProc = (p) => readFileSync(`/proc/${p}/cmdline`, "utf8"), ps = (p) => execFileSync("ps", ["-o", "command=", "-p", String(p)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }) } = {}) {
  try { const c = readProc(pid); if (c) return c; } catch { /* no /proc entry: try ps */ }
  try { return ps(pid).trim() || null; } catch { return null; /* neither source can say: the pid is not verified */ }
}

/**
 * The daemon's pid if it IS the decision daemon of this root: its command line carries a registry process marker and `--root <root>` EXACTLY (a root path may contain
 * spaces: from /proc the argument is compared whole, from ps the command must end with it), else null: a reused pid is not ours to signal.
 */
export function verifiedDaemonPid(pid, root, registry, readCmd = processCommand) {
  if (!Number.isInteger(pid)) return null;
  let cmd; try { cmd = readCmd(pid); } catch { return null; /* the command line cannot be read: not verified */ }
  if (typeof cmd !== "string" || !cmd) return null;
  const markers = registry.orphans?.processMarkers || [];
  if (!markers.some((m) => cmd.includes(m))) return null;
  if (cmd.includes("\0")) { const argv = cmd.split("\0"); const i = argv.indexOf("--root"); return i >= 0 && argv[i + 1] === root ? pid : null; }
  return cmd.endsWith(` --root ${root}`) ? pid : null;
}

/**
 * Stop the daemon of `root`. With `expectPid` (a caller that STARTED a daemon and must stop only that one) the stop is refused unless the state file names
 * exactly that pid AND that pid's command line is this root's decision daemon: a stale state file plus a reused pid never sends a signal to a stranger.
 * stop(root), stop(root, kitRegistryFile) and stop(root, { expectPid }) are all accepted.
 */
export async function stop(root, fileOrOpts = KIT_REGISTRY, opts = {}) {
  const [kitRegistryFile, { expectPid } = {}] = typeof fileOrOpts === "object" && fileOrOpts !== null ? [KIT_REGISTRY, fileOrOpts] : [fileOrOpts, opts];
  const reg = loadEffective(root, kitRegistryFile).registry;
  const st = readState(root, reg);
  if (expectPid !== undefined) {
    if (!st || st.pid !== expectPid) return { stopped: false, refused: st ? `the state file names pid ${st.pid}, not the expected pid ${expectPid}` : `there is no state file for the expected pid ${expectPid}` };
    if (verifiedDaemonPid(expectPid, root, reg) === null) return { stopped: false, refused: `pid ${expectPid} is not the decision daemon of this root` };
  }
  if (!st || !alive(st.pid)) { for (const f of [addrPath(root, reg), join(root, reg.daemon.state)]) { try { unlinkSync(f); } catch { /* a file that is already gone is the state wanted */ } } return { stopped: false }; }
  process.kill(st.pid, "SIGTERM");
  for (let i = 0; i < 40 && alive(st.pid); i++) await new Promise((r) => setTimeout(r, 50));
  return { stopped: !alive(st.pid), pid: st.pid };
}

// ------------------------------------------------------------------------------------------------------------------ server side
export function serve(root, kitRegistryFile = KIT_REGISTRY, extra = {}) {
  const guard = createGuard(root, kitRegistryFile, extra);
  const reg = guard.registry();
  const addrFile = addrPath(root, reg), statePath = join(root, reg.daemon.state);
  const key = randomBytes(16).toString("hex"), keyBuf = Buffer.from(key);
  const started = Date.now();
  let last = started, served = 0;
  const server = http.createServer((req, rsp) => {
    last = Date.now();
    if (req.method === "GET" && req.url === "/health") { rsp.setHeader("content-type", "application/json"); rsp.end(JSON.stringify({ ok: true, pid: process.pid, started, served })); return; }
    const given = Buffer.from(String(req.headers["x-guard-key"] || ""));
    if (given.length !== keyBuf.length || !timingSafeEqual(given, keyBuf)) { rsp.statusCode = 403; rsp.end(); req.resume(); return; }
    if (req.method !== "POST" || (req.url !== "/decide" && req.url !== "/action")) { rsp.statusCode = 404; rsp.end(); req.resume(); return; }
    let size = 0, tooBig = false; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > reg.daemon.maxBodyBytes) { tooBig = true; chunks.length = 0; } else if (!tooBig) chunks.push(c); });   // never buffer past the cap
    req.on("end", async () => {
      if (rsp.writableEnded) return;
      if (tooBig) { rsp.statusCode = 413; rsp.end(); return; }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const out = req.url === "/action" ? guard.decideAction(body) : await guard.respond(body);
        served++;
        rsp.setHeader("content-type", "application/json"); rsp.setHeader("x-guard-proof", key); rsp.end(JSON.stringify(out));      // the proof: the hook knows the key, a fake daemon does not unless it can read the address file
      } catch (e) { rsp.statusCode = 500; rsp.end(String(e?.message || e).slice(0, 200)); }   // a 500 is not a 200: the hook fails closed
    });
  });
  server.requestTimeout = reg.daemon.requestTimeoutMs; server.headersTimeout = reg.daemon.requestTimeoutMs;
  // on shutdown remove each file ONLY if it is still this process's: the state file when it names this pid, the address file when it still holds the port and key this
  // process wrote. A successor (started after this one lost its files, or while this one was shutting down) wrote its own, and a dying daemon never deletes them.
  let wrote = null;
  const ownsState = () => { try { return JSON.parse(readFileSync(statePath, "utf8")).pid === process.pid; } catch { return false; /* no readable state names us: nothing here is ours to remove */ } };
  const ownsAddr = () => { try { return wrote !== null && readFileSync(addrFile, "utf8") === wrote; } catch { return false; /* no readable address file: nothing here is ours to remove */ } };
  const cleanup = () => { guard.close(); for (const [f, ours] of [[addrFile, ownsAddr], [statePath, ownsState]]) if (ours()) { try { unlinkSync(f); } catch { /* a file that is already gone is the state wanted */ } } };
  const bye = () => { cleanup(); process.exit(0); };
  process.on("SIGTERM", bye); process.on("SIGINT", bye); process.on("exit", cleanup);
  mkdirSync(dirname(addrFile), { recursive: true });
  try { unlinkSync(addrFile); } catch { /* a file that is already gone is the state wanted */ }
  server.listen(0, "127.0.0.1", () => {
    wrote = `${server.address().port} ${key}\n`;
    writeFileSync(addrFile, wrote, { mode: 0o600 });
    writeFileSync(statePath, JSON.stringify({ pid: process.pid, started, root, port: server.address().port, maxAgeMinutes: reg.daemon.maxAgeMinutes, idleMinutes: reg.daemon.idleMinutes }));
    const tick = setInterval(() => {
      const now = Date.now();
      if (now - last > reg.daemon.idleMinutes * 60000 || now - started > reg.daemon.maxAgeMinutes * 60000 || !existsSync(statePath) || !existsSync(root)) bye();
    }, Number(process.env.KIT_GUARD_TICK_MS) || Math.min(30000, Math.max(200, reg.daemon.idleMinutes * 1000)));
    tick.unref?.();
  });
  return server;
}

// run directly (node daemon.mjs ...), also through a symlink: compare real paths; argv[1] naming no file (node -e) is not run directly
const isMain = (() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; /* argv[1] names no file (node -e): not run directly */ } })();
if (isMain) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--root");
  const root = i >= 0 ? argv.splice(i, 2)[1] : process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const [cmd] = argv;
  try {
    if (cmd === "serve") { const { identityExtras } = await import("./identity-daemon.js"); serve(root, KIT_REGISTRY, identityExtras(root, KIT_REGISTRY)); }
    else if (cmd === "ensure") { const r = await ensure(root); process.stdout.write(`${JSON.stringify(r)}\n`); process.exit(r.ok ? 0 : 2); }      // the JSON names the pid even when it did not come up, so the caller can stop it
    else if (cmd === "stop") { const e = argv.indexOf("--expect-pid"); const expectPid = e >= 0 ? Number(argv[e + 1]) : undefined; process.stdout.write(`${JSON.stringify(await stop(root, { expectPid }))}\n`); process.exit(0); }
    else if (cmd === "status") { const reg = loadEffective(root, KIT_REGISTRY).registry; const h = await health(addrPath(root, reg)); process.stdout.write(`${JSON.stringify(h || { ok: false })}\n`); process.exit(h ? 0 : 1); }
    else if (cmd === "decide") { const g = createGuard(root); const p = JSON.parse(readFileSync(0, "utf8") || "{}"); process.stdout.write(JSON.stringify(await g.respond(p))); g.close(); process.exit(0); }
    else { process.stderr.write("usage: daemon.mjs serve|ensure|stop|status|decide [--root dir]\n"); process.exit(2); }
  } catch (e) { process.stderr.write(`agent-guard: ${String(e?.message || e).split("\n")[0]}\n`); process.exit(2); }
}
