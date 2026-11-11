/**
 * kit resilience check [--today YYYY-MM-DD] [--json]     the canon check `resilience` alone
 * kit resilience record-drill --kind alert|restore|… --subject <id> --result pass|fail --proof <file> --date YYYY-MM-DD
 *                                                        append a drill (with the sha256 of its proof file) to resilience.json
 * kit resilience watch --monitor <id>                    the scheduled watcher: the monitor's status (worker) or health URL (watcher), the URL
 *                                                        from the repository variable resilience.json names, the limit from resilience.json;
 *                                                        exit 1 when it is down, stale, in the future, off its contract, or a route did not deliver
 * kit resilience keepalive --monitor <id>                keep GitHub from disabling the watcher's schedule (GITHUB_TOKEN with actions: write)
 * kit resilience canary --monitor <id>                  the watcher's daily canary: one message through every route the runner can reach
 *                                                        (not github, not email); exit 1 when any is not delivered
 * kit resilience secrets --monitor <id>                  the deploy gate: every secret NAME the monitor needs exists on its Worker
 *                                                        (`wrangler secret list`; names only, never values)
 * kit resilience report                                  rules, required secret names, drills and accepted risks
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../args.js";
import { loadCanon, bundled } from "../canon/index.js";
import { recordDrill, MAX_AGE_DAYS } from "../resilience/drills.js";
import { watchStatus, watchHealth, keepalive } from "../resilience/watch.js";
import { checkResilience, loadRules, requiredSecrets, activeChannels, isDeferred, monitorConfig, RESILIENCE_FILE } from "../resilience/check.js";
import { readWranglerConfig } from "../wrangler-config.js";
import { loadRelease, monitorStatusUrl } from "../release/config.js";

/** release.json when the canon declares it and it is valid, else null (the watcher then reads the repository variable). */
function canonRelease(cwd) {
  const kit = bundled();
  const { canon } = loadCanon(cwd, kit);
  if (!canon?.release) return null;
  return loadRelease(cwd, kit, canon.release.file || "release.json").doc;
}
import { formatProblems } from "@saasreport/core/schema";

const exec = (cmd, args) => new Promise((res) => execFile(cmd, args, { maxBuffer: 4 << 20 }, (e, stdout, stderr) => res({ code: e ? (e.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })));

function loadDoc(io) {
  const { canon } = loadCanon(io.cwd);
  const file = canon?.resilience?.file || RESILIENCE_FILE;
  const doc = JSON.parse(readFileSync(join(io.cwd, file), "utf8"));
  // the ONE loader of every resilience subcommand: the document is held to its schema first (a malformed `deferred` must never switch a route off)
  const kit = bundled();
  const problems = formatProblems(kit.validator.validate(doc, kit.byName("resilience")));
  if (problems.length) throw new CliError(`${file} does not satisfy kit.resilience.v1: ${problems.slice(0, 5).join("; ")}`);
  return { file, doc };
}
function monitorOf(doc, id) {
  const m = doc.monitors.find((x) => x.id === id);
  if (!m) throw new CliError(`no monitor "${id}" in resilience.json (${doc.monitors.map((x) => x.id).join(", ")})`);
  return m;
}

export async function resilience(io, { _: [sub] = [], flags }) {
  if (sub === "check") {
    const kit = bundled();
    const { canon, problems } = loadCanon(io.cwd, kit);
    if (!canon) { for (const p of problems) io.err(`  - ${p.file}: ${p.problem}`); return 1; }
    const r = await checkResilience(io.cwd, canon, kit, flags.today ? { today: String(flags.today) } : {});
    if (flags.json) { io.out(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1; }
    io[r.ok ? "out" : "err"](`${r.ok ? "ok" : "FAIL"} resilience: ${r.summary}`);
    for (const p of r.problems) io.err(`  - ${p.file}: ${p.problem}`);
    return r.ok ? 0 : 1;
  }
  if (sub === "record-drill") {
    const { file } = loadDoc(io);
    const d = recordDrill(io.cwd, file, { kind: flags.kind, subject: flags.subject, date: flags.date, result: flags.result, proof: flags.proof });
    io.out(`recorded ${d.kind} drill for ${d.subject} (${d.result}) in ${file}; proof sha256 ${d.proof_sha256.slice(0, 12)}…`);
    return 0;
  }
  if (sub === "watch" || sub === "keepalive" || sub === "secrets" || sub === "canary") {
    if (!flags.monitor) throw new CliError(`kit resilience ${sub} needs --monitor <id>`);
    const { doc } = loadDoc(io);
    const m = monitorOf(doc, String(flags.monitor));
    const config = await monitorConfig(io.cwd, m);
    const channels = activeChannels(doc, m);
    const deferred = m.routes.map((id) => doc.routes.find((r) => r.id === id)).filter((r) => isDeferred(r) && r.channel !== "email").map((r) => r.channel);
    // the routes this runner can reach (a webhook or a chat; email needs the comms Worker and is not tried here), with the project's overrides
    const reachable = channels.filter((c) => c !== "email");
    const send = async (alert) => {
      const { sendAlert } = await import("@saasreport/channels");
      return sendAlert(io.env, config, alert, { alerts: Object.fromEntries(reachable.map((c) => [c, config.monitor?.alerts?.[c] ?? true])), fetch: io.fetch });
    };
    if (sub === "canary") {
      if (!reachable.length && deferred.length) { io.out(`ok canary: no active route this runner can reach; ${deferred.join(", ")} deferred by the owner (resilience.json), so there is nothing to prove yet`); return 0; }
      if (!reachable.length) { io.err(`kit resilience canary: monitor ${m.id} has no route this runner can reach (telegram, bale or webhook)`); return 1; }
      const day = new Date().toISOString().slice(0, 10);
      const r = await send({ subject: `monitor ${m.id}: daily canary from the scheduled watcher`, lines: ["This message proves the route still delivers. No action needed."], reference: day, idempotencyKey: `canary:${m.id}:${day}` });
      const missing = reachable.filter((c) => !r.refs?.[c]);
      if (!r.configured || missing.length) { io.err(`kit resilience canary: not delivered through ${(r.configured ? missing : reachable).join(", ")} (${Object.keys(r.errors || {}).join(", ") || "route not configured: its secrets are missing"})`); return 1; }
      io.out(`ok canary: delivered through ${reachable.join(", ")}`);
      return 0;
    }
    if (sub === "keepalive") {
      const r = await keepalive({ token: io.env.GITHUB_TOKEN, repository: io.env.GITHUB_REPOSITORY, workflow: m.watcher.workflow, fetch: io.fetch });
      if (r.ok) { io.out(`ok keepalive: ${m.watcher.workflow} stays enabled`); return 0; }
      io.err(`kit resilience keepalive: ${r.error}`); return 1;
    }
    if (sub === "secrets") {
      if (m.kind !== "worker") { io.out(`ok secrets: monitor ${m.id} is a watcher; it runs no Worker`); return 0; }
      const c = readWranglerConfig(io.cwd, m.worker.wrangler);
      const env = m.worker.env || "";
      const run = io.exec || exec;
      const r = await run("npx", ["wrangler", "secret", "list", ...(env ? ["--env", env] : []), "--config", m.worker.wrangler]);
      if (r.code !== 0) { io.err(`kit resilience secrets: wrangler secret list failed (${r.code}): ${String(r.stderr).slice(0, 300)}`); return 1; }
      let have;
      try { have = new Set(JSON.parse(r.stdout).map((s) => s.name)); } catch { io.err("kit resilience secrets: wrangler did not answer a JSON list of names"); return 1; }
      const missing = requiredSecrets(doc, m, config).filter((n) => !have.has(n));
      if (missing.length) { io.err(`kit resilience secrets: ${c.envs[env]?.name || c.name} lacks ${missing.join(", ")} (wrangler secret put <NAME>; the owner sets the values)`); return 1; }
      io.out(`ok secrets: ${requiredSecrets(doc, m, config).length} required secret name(s) exist on ${c.envs[env]?.name || c.name}`);
      return 0;
    }
    // one source (docs/RELEASE.md): a worker monitor's status URL is derived from release.json workers_dev and the monitor Worker's name;
    // a repository variable may only repeat it, never point elsewhere
    const rel = canonRelease(io.cwd);
    const derived = m.kind === "worker" && rel ? monitorStatusUrl(io.cwd, rel, m.worker.wrangler, m.worker.env || "") : null;
    const given = io.env[m.watcher.url_env];
    if (derived && given && given !== derived) { io.err(`kit resilience watch: ${m.watcher.url_env} is ${given}, but release.json derives ${derived}: one source per fact`); return 1; }
    const url = derived || given;
    if (!url) { io.err(`kit resilience watch: ${m.watcher.url_env} is not set and release.json declares no workers_dev to derive it from`); return 1; }
    // a worker monitor is watched at its OWN GET /status, never through the site's /api/status proxy: the watcher must not depend on
    // the Worker it is there to watch
    if (m.kind === "worker") {
      let path = null;
      try { path = new URL(String(url)).pathname; } catch { /* an invalid value is reported as not matching, never accepted */ path = null; }
      if (path !== "/status") { io.err(`kit resilience watch: ${m.watcher.url_env} must be the monitor Worker's own https://<monitor>/status (got path ${path ?? "not a URL"}), not the site's /api/status`); return 1; }
    }
    const r = m.kind === "worker"
      ? await watchStatus(String(url), { staleAfterMin: m.stale_after_min, routes: channels, fetch: io.fetch })
      : await watchHealth(String(url), { fetch: io.fetch });
    if (r.ok) { io.out(`ok watch: monitor ${m.id} alive${r.status ? ` (status ${r.status})` : ""}`); return 0; }
    for (const p of r.problems) io.err(`  - ${p}`);
    // the second path: the routes this runner can reach
    if (reachable.length) {
      const sent = await send({ subject: `monitor ${m.id}: the scheduled watcher found it not alive`, lines: r.problems, reference: new Date().toISOString() });
      io.err(`  alert through ${reachable.join(", ")}: ${Object.keys(sent.refs || {}).length ? "sent" : `not sent (${JSON.stringify(sent.errors || {})})`}`);
    }
    io.err(`kit resilience watch: monitor ${m.id} is not alive (this failed run is the independent report)`);
    return 1;
  }
  if (sub === "report") {
    const { rules } = loadRules(bundled());
    io.out("rules (constitution registry, class resilience):");
    for (const r of rules) io.out(`  ${r.id.padEnd(30)} ${r.title}`);
    io.out(`drill freshness (days): ${Object.entries(MAX_AGE_DAYS).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    const { canon } = loadCanon(io.cwd);
    if (canon?.resilience) {
      const { doc } = loadDoc(io);
      for (const m of doc.monitors) io.out(`  monitor ${m.id} (${m.kind}): secrets ${m.kind === "worker" ? requiredSecrets(doc, m, await monitorConfig(io.cwd, m)).join(", ") : "none"}`);
      for (const d of doc.drills || []) io.out(`  drill ${d.kind} ${d.subject} ${d.date} ${d.result}`);
      for (const r of doc.routes.filter(isDeferred)) io.out(`  deferred route ${r.id} (${r.channel}; ${r.deferred.decided_on}, by ${r.deferred.decided_by}): ${r.deferred.reason}`);
      for (const a of doc.accepted_risks || []) io.out(`  accepted risk ${a.id} (${a.date}, by ${a.accepted_by}): ${a.text}`);
    }
    return 0;
  }
  throw new CliError("usage: kit resilience check|record-drill|watch|keepalive|canary|secrets|report");
}
