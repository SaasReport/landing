/**
 * canon check `resilience` (docs/RESILIENCE.md): resilience.json (kit.resilience.v1) against what the repository deploys, read by the kit's
 * one reader (../wrangler-config.js, every config and every [env.*]), and against its watcher workflows, parsed as YAML and held to the
 * exact kit invocation (../yaml-lite.js). Every problem names the constitution-registry rule (class resilience) it proves.
 * Deterministic: `today` is injected.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { formatProblems } from "@saasreport/core/schema";
import { alertVariables, CHANNEL_ROOTS } from "@saasreport/channels";
// the sibling package by path (present wherever the CLI is): the monitor's own reading of its settings
import { guardSettings } from "../../../monitor/src/guard.js";
import { journeyList } from "../../../monitor/src/journeys.js";
import { readWranglerConfig, d1Index, d1Id } from "../wrangler-config.js";
import { deployScan } from "../canon/facts.js";
import { DEFAULT_VENDOR_PATH, vendorRoots } from "../vendor-path.js";
import { maxGapMin } from "../cron.js";
import { parseYaml } from "../yaml-lite.js";
import { freshDrill } from "./drills.js";
import { bootstrapOwesDrills } from "../release/check.js";
import { publishDrillNeeds } from "../podcast-drill.js";

export const RESILIENCE_FILE = "resilience.json";
const utcToday = () => new Date().toISOString().slice(0, 10);
const list = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const dups = (a) => a.filter((x, i) => a.indexOf(x) !== i);

/** The kit registry's class-resilience rules (one registry; no second rules file). */
export function loadRules(kit) {
  const reg = JSON.parse(readFileSync(join(kit.dir, "..", "registry", "constitution.rules.json"), "utf8"));
  return { rules: reg.rules.filter((r) => r.class === "resilience"), recipientVars: reg.separation?.recipientVars || [] };
}

/** The project's monitor config (monitor.config.module), or {} when none is declared. */
export async function monitorConfig(root, m) {
  if (!m.config) return {};
  const mod = await import(pathToFileURL(resolve(root, m.config.module)).href);
  return mod[m.config.export || "default"] ?? {};
}

/** A route the owner has not switched on yet (resilience.json `deferred`): declared in the design, active nowhere. */
export const isDeferred = (route) => {
  const d = route?.deferred;
  // only a complete deferral (the schema's shape) deactivates a route: anything else leaves it ACTIVE, so a malformed or truncated entry fails closed (its secrets stay required) in every command, whether or not the schema was checked first
  return Boolean(d && typeof d === "object" && !Array.isArray(d) && typeof d.reason === "string" && d.reason.length >= 20
    && typeof d.decided_by === "string" && d.decided_by.length > 0 && typeof d.decided_on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.decided_on));
};

/** The routes a monitor ACTIVELY alerts through, in its own order: its declared routes minus the deferred ones. The one source of "which channels". */
export function activeRoutes(doc, monitor) {
  const byId = new Map(doc.routes.map((r) => [r.id, r]));
  return monitor.routes.map((id) => byId.get(id)).filter((r) => r && !isDeferred(r));
}

/** The channels the monitor's own sending reaches (MONITOR_ROUTES, the alert drill, the watcher): active and not the watcher's github route. */
export const activeChannels = (doc, monitor) => activeRoutes(doc, monitor).filter((r) => r.channel !== "github").map((r) => r.channel);

/** The secret NAMES a monitor needs, derived from its ACTIVE routes, its dead-man provider and the project's config overrides. A deferred route needs none. */
export function requiredSecrets(doc, monitor, config = {}) {
  const names = new Set(monitor.kind === "worker" ? ["MONITOR_TOKEN"] : []);
  for (const r of activeRoutes(doc, monitor)) if (r.channel !== "github") for (const n of alertVariables(r.channel, config).secrets) names.add(n);
  if (monitor.kind === "worker" && monitor.dead_man.provider !== "github-actions") names.add(guardSettings(config, {}).deadManEnv);
  if (monitor.kind === "worker" && config.monitor?.drill?.form) names.add("FORMS_DRILL_KEY");   // signs the form drill's test submission (docs/FORMS.md)
  return [...names].sort();
}

/** The one shape of a kit invocation a watcher step may run: the whole step, nothing around it. */
/** The one kit invocation a watcher step may run: the kit's own CLI, the vendored snapshot's (at kit.canon.json vendor.path), or npx. */
// the kit at t=0 (docs/FRESHNESS.md): a site runs the kit through its bootstrap, `node scripts/kit.mjs`; the snapshot and root forms stay for the kit itself and for snapshot mode
const kitRun = (snapshot) => new RegExp(`^(?:node scripts/kit\\.mjs|node (?:${snapshot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/)?packages/cli/bin/kit\\.js|npx --no-install kit) resilience (watch|keepalive|canary) --monitor ([a-z][a-z0-9-]*)$`);
const SCHEDULE_IF = /^\s*(?:\$\{\{\s*)?github\.event\.schedule\s*==\s*'([^']+)'(?:\s*\}\})?\s*$/;

/**
 * What a watcher workflow DOES, parsed and held to the exact invocation (review M5): a step counts only when it runs exactly one kit
 * command, after `npm ci` in the same job, in a job and a step with no `if`, no `continue-on-error` and no `shell`. A canary step may
 * carry `if: github.event.schedule == '<one of the schedule crons>'` (to run once a day). → { crons, watch, keepalive, canary, problems }
 */
export function watcherFacts(text, snapshot = DEFAULT_VENDOR_PATH) {
  const KIT_RUN = kitRun(snapshot);
  const out = { crons: [], watch: {}, keepalive: new Set(), canary: {}, problems: [] };
  let y;
  try { y = parseYaml(text); } catch (e) { out.problems.push(`not readable YAML: ${e.message}`); return out; }
  const on = y?.on;
  out.crons = (on && typeof on === "object" && Array.isArray(on.schedule) ? on.schedule : []).map((s) => s?.cron).filter((c) => typeof c === "string");
  const writes = (p) => p === "write-all" || (p && typeof p === "object" && p.actions === "write");
  for (const [jid, job] of Object.entries(y?.jobs && typeof y.jobs === "object" ? y.jobs : {})) {
    if (!job || typeof job !== "object") continue;
    const jobBad = job.if !== undefined ? `job "${jid}" has an \`if\` (a watcher job must run on every schedule)` : job["continue-on-error"] ? `job "${jid}" has continue-on-error` : null;
    let installed = false;
    for (const [n, step] of (Array.isArray(job.steps) ? job.steps : []).entries()) {
      const run = typeof step?.run === "string" ? step.run.trim() : null;
      if (run === "npm ci") { installed = true; continue; }
      const loose = run && /\bresilience\s+(watch|keepalive|canary)\b/.test(run);
      const m = run && KIT_RUN.exec(run);
      if (!m) { if (loose) out.problems.push(`job "${jid}" step ${n + 1} runs "${run.slice(0, 80)}": a watcher step runs exactly \`node scripts/kit.mjs resilience <watch|keepalive|canary> --monitor <id>\` and nothing else`); continue; }
      const [, cmd, id] = m;
      const why = jobBad
        || (step["continue-on-error"] ? `step ${n + 1} has continue-on-error` : null)
        || (step.shell ? `step ${n + 1} sets a shell` : null)
        || (!installed ? `step ${n + 1} runs before \`npm ci\` in its job (the CLI's dependencies would be missing)` : null)
        || (step.if !== undefined && !(cmd === "canary" && SCHEDULE_IF.test(String(step.if)) && out.crons.includes(SCHEDULE_IF.exec(String(step.if))[1])) ? `step ${n + 1} has an \`if\` that is not one of the workflow's schedules` : null)
        || (cmd === "keepalive" && !writes(job.permissions) && !writes(y.permissions) ? `job "${jid}" runs keepalive without permissions actions: write` : null);
      if (why) { out.problems.push(`${cmd} --monitor ${id}: ${why}`); continue; }
      if (cmd === "watch") out.watch[id] = step.env && typeof step.env === "object" ? step.env : {};
      else if (cmd === "keepalive") out.keepalive.add(id);
      else out.canary[id] = { env: step.env && typeof step.env === "object" ? step.env : {}, cron: step.if !== undefined ? SCHEDULE_IF.exec(String(step.if))[1] : null };
    }
  }
  return out;
}

export async function checkResilience(root, canon, kit, { today = utcToday() } = {}) {
  const ref = canon.resilience;
  const snapshot = vendorRoots(canon.vendor).snapshot;
  if (!ref) return { ok: false, configured: false, checked: 0, summary: "NOT CONFIGURED", problems: [] };      // never a pass: a repository that does not apply it declares notApplicable with a predicate that holds
  const file = ref.file || RESILIENCE_FILE;
  const P = (rule, where, problem) => ({ file: where, problem: `${rule}: ${problem}` });
  if (!existsSync(join(root, file))) return { ok: false, configured: true, checked: 0, summary: file, problems: [{ file, problem: "missing" }] };
  let doc;
  try { doc = JSON.parse(readFileSync(join(root, file), "utf8")); } catch (e) { return { ok: false, configured: true, checked: 0, summary: file, problems: [{ file, problem: `not JSON: ${e.message}` }] }; }
  const sp = formatProblems(kit.validator.validate(doc, kit.byName("resilience")));
  if (sp.length) return { ok: false, configured: true, checked: 0, summary: file, problems: sp.map((m) => ({ file, problem: `kit.resilience.v1: ${m}` })) };

  const { recipientVars } = loadRules(kit);
  const problems = [];
  let checked = 0;
  // bootstrap (release.json state, docs/RELEASE.md): before the first deploy no drill can exist; a VALID bootstrap owes them to its first
  // production run, which performs every one in the same job. READY (or no valid bootstrap) keeps the drill rule strict.
  const publish = await publishDrillNeeds(root);   // the podcast series this repository publishes: each owes a publish drill (kit podcast drill)
  const owed = bootstrapOwesDrills(root, canon, kit, doc, publish.ids);
  const drillProblems = [];
  for (const id of dups(doc.routes.map((r) => r.id))) problems.push(P("alert-routes-proven", file, `route id "${id}" is declared twice`));
  for (const id of dups(doc.monitors.map((m) => m.id))) problems.push(P("every-worker-watched", file, `monitor id "${id}" is declared twice`));

  const deployed = deployScan(root, canon).deployed;
  const configs = new Map();
  for (const f of new Set([...deployed, ...doc.monitors.flatMap((m) => [...m.watches.map((w) => w.wrangler), ...(m.worker ? [m.worker.wrangler] : [])])])) {
    try { configs.set(f, readWranglerConfig(root, f)); } catch (e) { problems.push({ file: f, problem: `cannot read wrangler config: ${e.message}` }); }
  }
  const index = d1Index([...configs.values()]);
  const facts = (t, where) => {
    const c = configs.get(t.wrangler);
    if (!c) { problems.push({ file: where, problem: `${t.wrangler} is not a wrangler config (by content)` }); return null; }
    const f = c.envs[t.env || ""];
    if (!f) problems.push({ file: t.wrangler, problem: `has no [env.${t.env}] section` });
    return f || null;
  };
  const key = (f, env = "") => `${f}\u0000${env}`;
  const routesById = new Map(doc.routes.map((r) => [r.id, r]));
  const cfgs = new Map();
  for (const m of doc.monitors) {
    try { cfgs.set(m.id, await monitorConfig(root, m)); } catch (e) { cfgs.set(m.id, {}); problems.push(P("alerts-have-recipients", m.config?.module || file, `monitor ${m.id}: its config module cannot be loaded: ${e.message}`)); }
  }

  // every-worker-watched, per (file, env): every deployed env of every deployed config, D1 and R2 from all of them
  const covered = new Set(doc.monitors.flatMap((m) => [...m.watches.map((w) => key(w.wrangler, w.env)), ...(m.worker ? [key(m.worker.wrangler, m.worker.env)] : [])]));
  const notDeployed = new Map((doc.not_deployed || []).map((x) => [key(x.wrangler, x.env), x]));
  const monitorWorkers = new Set(doc.monitors.filter((m) => m.worker).map((m) => key(m.worker.wrangler, m.worker.env)));
  const used = new Set();
  const pairs = [];
  for (const f of deployed) {
    const c = configs.get(f);
    if (!c) continue;
    for (const env of Object.keys(c.envs)) {
      const k = key(f, env);
      if (notDeployed.has(k)) { used.add(k); continue; }
      pairs.push([f, env]);
      if (!covered.has(k)) problems.push(P("every-worker-watched", f, `${env ? `[env.${env}] of ` : ""}this config is deployed by this repository but no monitor in resilience.json watches it: add it to a monitor's watches (kind "worker" for a site with a monitor Worker of its own, or kind "watcher": a scheduled GitHub workflow that checks the Worker's health URL), or declare it in not_deployed with the reason`));
    }
  }
  for (const [k, x] of notDeployed) if (!used.has(k)) problems.push(P("every-worker-watched", file, `not_deployed names ${x.wrangler} [env.${x.env}], which is not a deployed config section (stale)`));

  // recipients and secrets are never committed: every deployed config, every env, the monitors' own configs too
  const secretNames = new Set([...recipientVars, ...doc.monitors.flatMap((m) => requiredSecrets(doc, m, cfgs.get(m.id))), ...doc.monitors.flatMap((m) => m.routes.map((id) => routesById.get(id)).filter((r) => r && r.channel !== "github").flatMap((r) => alertVariables(r.channel, cfgs.get(m.id)).secrets))]);   // a deferred route's secrets (with the project's overrides) are never in git either
  for (const c of configs.values()) for (const [env, f] of Object.entries(c.envs)) for (const n of secretNames) {
    if (n in f.vars) problems.push(P("alerts-have-recipients", c.file, `${env ? `[env.${env}.vars] ` : "[vars] "}${n} is a recipient or a secret: a Worker secret (wrangler secret put ${n}), never a value in git`));
  }

  const allD1 = new Map(), allR2 = new Set();
  for (const [f, env] of pairs) {
    if (monitorWorkers.has(key(f, env))) continue;
    for (const d of configs.get(f).envs[env].d1) { const id = d1Id(d, index); if (id) allD1.set(id, d.name || id); }
    for (const b of configs.get(f).envs[env].r2) if (b.bucket) allR2.add(b.bucket);
  }

  for (const m of doc.monitors) {
    checked++;
    const where = `${file} (monitor ${m.id})`;
    const cfg = cfgs.get(m.id);
    // routes: declared, distinct channels, two failure domains derived from the channels (never a label)
    const known = m.routes.map((id) => routesById.get(id)).filter(Boolean);
    m.routes.forEach((id) => { if (!routesById.has(id)) problems.push(P("alert-routes-proven", where, `route "${id}" is not declared in routes[]`)); });
    const channels = known.map((r) => r.channel);
    for (const r of known.filter(isDeferred)) if (r.channel === "github") problems.push(P("alert-routes-proven", where, `route "${r.id}" is the watcher's own failed run (channel github) and cannot be deferred`));
    if (!activeRoutes(doc, m).length) problems.push(P("alert-routes-proven", where, "every route is deferred: nobody would be told (a monitor keeps at least one active route)"));
    for (const c of dups(channels)) problems.push(P("alert-routes-proven", where, `channel ${c} is used by two routes: a second route must be a different channel`));
    if (new Set(channels.map((c) => CHANNEL_ROOTS[c])).size < 2) problems.push(P("alert-routes-proven", where, `its routes (${channels.join(", ")}) depend on fewer than two failure domains (${[...new Set(channels.map((c) => CHANNEL_ROOTS[c]))].join(", ")})`));
    if (m.kind === "worker" && channels.includes("github")) problems.push(P("alert-routes-proven", where, "a worker monitor sends through its channels; the github route belongs to a watcher monitor"));
    if (m.kind === "watcher" && !channels.includes("github")) problems.push(P("alert-routes-proven", where, "a watcher monitor's first route is its own failed run (channel github)"));
    if (m.kind === "watcher" && channels.includes("email")) problems.push(P("alert-routes-proven", where, "a watcher runs on GitHub and cannot reach the comms Worker: use telegram, bale or webhook as its second route"));

    // the watcher workflow
    let wgap = null;
    const wfFile = join(root, m.watcher.workflow);
    if (!existsSync(wfFile)) problems.push(P("monitor-dead-man", m.watcher.workflow, "the scheduled watcher workflow does not exist"));
    else {
      const w = watcherFacts(readFileSync(wfFile, "utf8"), snapshot);
      for (const x of w.problems) problems.push(P("monitor-dead-man", m.watcher.workflow, x));
      if (!w.crons.length) problems.push(P("monitor-dead-man", m.watcher.workflow, "has no on.schedule cron: nothing runs it"));
      try { wgap = w.crons.length ? maxGapMin(w.crons) : null; } catch (e) { problems.push(P("monitor-dead-man", m.watcher.workflow, e.message)); }
      if (w.crons.length && wgap == null) problems.push(P("monitor-dead-man", m.watcher.workflow, `its schedule (${w.crons.join(", ")}) never fires`));
      if (wgap != null && wgap > m.stale_after_min) problems.push(P("monitor-dead-man", m.watcher.workflow, `runs every ${wgap} min at worst, longer than stale_after_min ${m.stale_after_min}: the absence would be reported late`));
      if (!w.watch[m.id]) problems.push(P("monitor-dead-man", m.watcher.workflow, `no step runs exactly \`node scripts/kit.mjs resilience watch --monitor ${m.id}\` (after npm ci, no if, no continue-on-error)`));
      else if (!(m.watcher.url_env in w.watch[m.id])) problems.push(P("monitor-dead-man", m.watcher.workflow, `the watch step does not pass ${m.watcher.url_env} in its env`));
      if (!w.keepalive.has(m.id)) problems.push(P("monitor-dead-man", m.watcher.workflow, `no step runs exactly \`... resilience keepalive --monitor ${m.id}\` with actions: write: GitHub may disable the schedule and nothing would notice`));
      const second = activeRoutes(doc, m).filter((r) => r.channel !== "github" && r.channel !== "email");   // a deferred second route is not proven until it is active
      if (m.kind === "watcher" && second.length) {
        const c = w.canary[m.id];
        if (!c) problems.push(P("alert-routes-proven", m.watcher.workflow, `no step runs \`... resilience canary --monitor ${m.id}\`: the watcher's second route is never proven`));
        else {
          let cgap = null;
          try { cgap = maxGapMin(c.cron ? [c.cron] : w.crons); } catch { /* failure here means no value; the caller holds on the empty answer */ cgap = null; }
          if (cgap == null || cgap > 1440) problems.push(P("alert-routes-proven", m.watcher.workflow, "the canary step does not run at least once a day"));
          for (const r of second) for (const n of alertVariables(r.channel, cfg).secrets) if (!(n in c.env)) problems.push(P("alert-routes-proven", m.watcher.workflow, `the canary step does not pass ${n} (read by the ${r.channel} route) in its env`));
        }
      }
    }

    // a project that publishes a podcast is watched by the journeys that notice it stopped: `publishing` (today's episode is out) and `feeds`
    // (the feeds carry items). They alert through this monitor's routes like every journey (the runner sends every failure to every route), so they
    // must RUN: a monitor config that lists other builtins, skips them or has no series to derive them from watches nothing (2026-10-03..13)
    if (m.kind === "worker" && publish.ids.length) {
      let running = [];
      try { running = journeyList(cfg || {}); } catch (e) { problems.push(P("alert-routes-proven", where, `monitor ${m.id}: its journeys cannot be derived from its config (${e.message})`)); running = null; }
      if (running) for (const j of ["publishing", "feeds"]) if (!running.includes(j)) problems.push(P("alert-routes-proven", where, `monitor ${m.id} does not run the ${j} journey although this repository publishes a podcast (${publish.ids.join(", ")}): its failure would alert nobody. Remove it from monitor.skip and list it in monitor.journeys (or list none), and give the monitor config the series`));
    }

    // watched Workers: their databases
    const watched = m.watches.map((t) => facts(t, where)).filter(Boolean);
    const watchedIds = new Set();
    for (const f of watched) for (const d of f.d1) {
      const id = d1Id(d, index);
      if (!id) problems.push(P("monitor-own-database", where, `watched D1 binding ${d.binding} (${d.name ?? "no name"}) has no database_id the configs can resolve: the monitor cannot prove it does not write there`));
      else watchedIds.add(id);
    }

    if (m.kind === "worker") {
      const mw = facts(m.worker, where);
      if (mw) {
        const own = mw.d1.find((d) => d.binding === m.database_binding);
        const ownId = own ? d1Id(own, index) : null;
        if (!own) problems.push(P("monitor-own-database", m.worker.wrangler, `no D1 binding ${m.database_binding}: the monitor needs a database of its own`));
        else if (!ownId) problems.push(P("monitor-own-database", m.worker.wrangler, `${m.database_binding} has no resolvable database_id`));
        else if (watchedIds.has(ownId)) problems.push(P("monitor-own-database", m.worker.wrangler, `${m.database_binding} is database ${ownId}, which a watched Worker binds: the monitor writes into what it watches (and the watched Worker could write the monitor's rows)`));
        const v = mw.vars;
        const expect = { MONITOR_DB_ID: ownId, MONITOR_WATCHED_DB_IDS: [...watchedIds], MONITOR_ROUTES: activeChannels(doc, m), MONITOR_DEADMAN_PROVIDER: m.dead_man.provider, MONITOR_STALE_AFTER_MIN: String(m.stale_after_min), MONITOR_FETCH_TIMEOUT_MS: m.fetch_timeout_ms == null ? null : String(m.fetch_timeout_ms) };
        if (m.fetch_timeout_ms == null) problems.push(P("alert-routes-proven", where, `monitor ${m.id} declares no fetch_timeout_ms: every outbound call of a worker monitor needs a declared deadline`));
        for (const [k, want] of Object.entries(expect)) {
          if (want === null) continue;     // reported above: nothing declared to compare with
          const have = v[k];
          const ok = Array.isArray(want) ? (want.length > 0 && !dups(list(have)).length && list(have).length === want.length && list(have).every((x) => want.includes(x))) : have != null && String(have) === String(want ?? "");
          if (!ok) problems.push(P(k === "MONITOR_ROUTES" ? "alert-routes-proven" : k === "MONITOR_FETCH_TIMEOUT_MS" ? "alert-routes-proven" : k === "MONITOR_STALE_AFTER_MIN" ? "monitor-stale-window" : k === "MONITOR_DEADMAN_PROVIDER" ? "monitor-dead-man" : "monitor-own-database",
            m.worker.wrangler, `[vars] ${k} is ${have == null ? "missing" : JSON.stringify(have)}; it must be ${JSON.stringify(Array.isArray(want) ? want.join(",") : want)} (from ${Array.isArray(want) || k.endsWith("_ID") ? "the wrangler configs" : "resilience.json"})`));
        }
        let gap = null;
        try { gap = mw.crons.length ? maxGapMin(mw.crons, { dialect: "cloudflare" }) : null; } catch (e) { problems.push(P("monitor-stale-window", m.worker.wrangler, e.message)); }
        if (!mw.crons.length) problems.push(P("monitor-stale-window", m.worker.wrangler, "no cron trigger: the monitor never runs by itself"));
        else if (gap == null) problems.push(P("monitor-stale-window", m.worker.wrangler, `its cron (${mw.crons.join(", ")}) never fires`));
        if (gap != null) {
          if (m.stale_after_min < gap) problems.push(P("monitor-stale-window", where, `stale_after_min ${m.stale_after_min} is shorter than the longest gap between runs (${gap} min)`));
          if (m.stale_after_min > gap * 3) problems.push(P("monitor-stale-window", where, `stale_after_min ${m.stale_after_min} is more than three gaps (${gap * 3} min)`));
          if (m.dead_man.interval_min < gap) problems.push(P("monitor-dead-man", where, `dead_man.interval_min ${m.dead_man.interval_min} is shorter than the longest gap between runs (${gap} min)`));
          if (m.dead_man.interval_min + m.dead_man.grace_min > m.stale_after_min * 2) problems.push(P("monitor-dead-man", where, "dead_man interval + grace is more than twice stale_after_min: the absence is reported too late"));
        }
        // a watched Worker that serves the monitor's status reaches it over a service binding: it must point at THIS monitor
        const sb = cfg?.monitor?.statusBinding || "MONITOR";
        for (const t of m.watches) {
          const f = configs.get(t.wrangler)?.envs[t.env || ""];
          for (const svc of (f?.services || []).filter((x) => x.binding === sb)) if (svc.service !== mw.name) problems.push(P("monitor-dead-man", t.wrangler, `service binding ${sb} targets "${svc.service}", not the monitor Worker "${mw.name}": /api/status would show another Worker's status`));
        }
        if (m.dead_man.root === m.root) problems.push(P("monitor-dead-man", where, `the dead-man root "${m.dead_man.root}" is the monitor's own root`));
      }
    }
    const d = freshDrill(root, doc.drills, "alert", m.id, today);
    if (d.problem) drillProblems.push(P("resilience-proven-by-drills", file, d.problem));
  }

  const backupOf = (kind, idOrName) => (doc.backups || []).find((b) => b.source.kind === kind && (kind === "d1" ? (b.source.name === idOrName || index.get(b.source.name) === idOrName) : b.source.name === idOrName));
  for (const [id, label] of allD1) if (!backupOf("d1", id)) problems.push(P("backup-separate-resource", file, `D1 ${label} (${id}) has no backup entry`));
  for (const b of allR2) if (!backupOf("r2", b)) problems.push(P("backup-separate-resource", file, `R2 ${b} has no backup entry`));
  for (const b of doc.backups || []) {
    checked++;
    if (b.destination.kind === b.source.kind && b.destination.name === b.source.name) problems.push(P("backup-separate-resource", file, `backup ${b.id}: the destination is the source itself`));
    if (!existsSync(join(root, b.config))) problems.push(P("backup-separate-resource", b.config, `backup ${b.id}: the backup config does not exist`));
    const d = freshDrill(root, doc.drills, "restore", b.id, today);
    if (d.problem) drillProblems.push(P("resilience-proven-by-drills", file, d.problem));
  }
  if (publish.problem) problems.push(P("resilience-proven-by-drills", file, publish.problem));
  for (const id of publish.ids) {
    checked++;
    const d = freshDrill(root, doc.drills, "publish", id, today, { kit });
    if (d.problem) drillProblems.push(P("resilience-proven-by-drills", file, d.problem));
  }
  if (!owed) problems.push(...drillProblems);
  return { ok: !problems.length, configured: true, checked, summary: `${owed && drillProblems.length ? `bootstrap: ${drillProblems.length} drill(s) owed by the first production run; ` : ""}${doc.monitors.length} monitor(s) over ${pairs.length} deployed Worker config section(s), ${(doc.backups || []).length} backup(s), ${(doc.accepted_risks || []).length} accepted risk(s)`, problems };
}
