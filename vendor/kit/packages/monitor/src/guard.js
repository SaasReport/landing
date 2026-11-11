/**
 * The monitor's t=0 guards (docs/RESILIENCE.md). A monitor that cannot tell anyone, cannot be told apart from a dead one, or writes its
 * verdicts into the database it watches is not a monitor: it REFUSES TO RUN (a failed cron, a 503), it does not warn.
 *
 *   routeSpec(env, config)          the channels this monitor alerts through: env MONITOR_ROUTES ("email,telegram"; verified against
 *                                   resilience.json by `kit check resilience`), else config.monitor.alerts, else { email: true }
 *   routes(env, config, deps)       [{ channel, adapter?, problem? }] built by channels' resolveChannels: the SAME function that sends,
 *                                   so a missing COMMS binding, template, token or a malformed destination is "not ready"
 *   readiness(env, config)          problems[] (empty = ready); assertReady throws MonitorNotReady
 *   monitorDb(env, config)          the D1 the monitor writes to (MONITOR_DB)
 *   staleness(startedAt, now, min)  { stale, ageMin, future } (exact: a run 60 min 59 s old is stale at a 60 min limit)
 *   pingDeadMan(env, config, outcome, { fetch })  the dead-man contract (below); → { sent, status?, error?, provider }
 *
 * Database identity (never object identity): the monitor Worker carries MONITOR_DB_ID and MONITOR_WATCHED_DB_IDS as [vars], written
 * from the wrangler configs and verified by `kit check resilience`; the monitor refuses when its database is one it watches.
 *
 * Dead-man (MONITOR_DEADMAN_PROVIDER, the provider resilience.json declares): healthchecks.io or other: GET MONITOR_DEADMAN_URL after every
 * run (`/fail` when the monitor itself is broken); the service alarms on a MISSING ping. github-actions: no ping; the scheduled watcher
 * (`kit resilience watch`) is the dead-man.
 */
import { alertConfig, resolveChannels } from "@saasreport/channels";

// Names only. Every NUMBER (the stale window, the call deadline) is declared in resilience.json and delivered as a wrangler var that `kit resilience check`
// proves equal to it: a default in code could silently differ from the declaration, so there is none, and an unset value refuses the run.
export const DEFAULTS = Object.freeze({ dbBinding: "MONITOR_DB", deadManEnv: "MONITOR_DEADMAN_URL" });
export const DEAD_MAN_PROVIDERS = Object.freeze(["healthchecks.io", "github-actions", "other"]);
const SKEW_MS = 5 * 60 * 1000;

export class MonitorNotReady extends Error {
  constructor(problems) { super(`monitor refuses to run: ${problems.join("; ")}`); this.name = "MonitorNotReady"; this.problems = problems; }
}

const list = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]{2,}$/;
const CHAT = /^(-?\d{3,}|@[A-Za-z][A-Za-z0-9_]{4,})$/;
const isHttps = (u) => { try { const x = new URL(u); return x.protocol === "https:" && Boolean(x.hostname) && u === u.trim(); } catch { /* an invalid value is reported as not matching, never accepted */ return false; } };

/** A setting that is a positive whole number; NaN (not configured, refused) when unset or anything else: there is no default. */
const positiveInt = (raw) => { const n = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : raw; return Number.isInteger(n) && n > 0 ? n : NaN; };

/** Settings of config.monitor and the environment. The numbers have NO default: NaN means not configured (the status says so, readiness refuses). */
export function guardSettings(config = {}, env = {}) {
  const m = config.monitor || {};
  return {
    fetchTimeoutMs: positiveInt(env.MONITOR_FETCH_TIMEOUT_MS ?? m.fetchTimeoutMs),
    staleAfterMin: positiveInt(env.MONITOR_STALE_AFTER_MIN ?? m.staleAfterMin),
    dbBinding: m.dbBinding || DEFAULTS.dbBinding,
    deadManEnv: m.deadMan?.urlEnv || DEFAULTS.deadManEnv,
  };
}

/** fetch with a deadline on every call (AbortSignal.timeout), unless the caller brought its own signal: a hung URL must not hold the run (and its lock). */
export const timedFetch = (f, ms) => (url, init = {}) => (Number.isInteger(ms) && ms > 0
  ? (f || globalThis.fetch)(url, { ...init, signal: init.signal ?? AbortSignal.timeout(ms) })
  : Promise.reject(new Error("MONITOR_FETCH_TIMEOUT_MS is not set: no call goes out without a deadline")));

/** The channels this monitor alerts through ({ email: true, telegram: true, ... }). */
export function routeSpec(env = {}, config = {}) {
  if (env.MONITOR_ROUTES != null) return Object.fromEntries(list(env.MONITOR_ROUTES).map((c) => [c, config.monitor?.alerts?.[c] ?? true]));
  return config.monitor?.alerts ?? { email: true };
}

/** Why one channel's destination is malformed, or null. */
function destinationProblem(channel, c, env) {
  if (channel === "email") {
    const to = c.to ?? env[c.toEnv];
    const bad = list(to).filter((a) => !EMAIL.test(a));
    if (!list(to).length) return `${c.toEnv} is empty`;
    if (/[;\n]/.test(String(to))) return `${c.toEnv} separates addresses with something other than a comma`;
    if (bad.length) return `${c.toEnv} holds ${bad.length} value(s) that are not an email address`;
  } else if (channel === "webhook") {
    const u = c.url ?? env[c.urlEnv];
    if (!u) return `${c.urlEnv} is empty`;
    if (!isHttps(u)) return `${c.urlEnv} is not an https URL`;
  } else {
    const chat = String(c.chatId ?? env[c.chatIdEnv] ?? "");
    const token = env[c.tokenEnv || `${channel.toUpperCase()}_BOT_TOKEN`];
    if (!chat) return `${c.chatIdEnv} is empty`;
    if (!CHAT.test(chat)) return `${c.chatIdEnv} is not a chat id`;
    if (!token || /\s/.test(String(token)) || !String(token).trim()) return `${c.tokenEnv || `${channel.toUpperCase()}_BOT_TOKEN`} is empty or malformed`;
  }
  return null;
}

/** [{ channel, adapter?, problem? }]: the adapters that WILL send (resolveChannels), and why a declared channel will not. */
export function routes(env = {}, config = {}, { fetch } = {}) {
  const spec = routeSpec(env, config);
  const cfg = alertConfig(config, spec);
  const out = [];
  for (const channel of Object.keys(spec).filter((c) => spec[c])) {
    const c = cfg[channel];
    if (!c) { out.push({ channel, problem: `unknown alert channel "${channel}"` }); continue; }
    const bad = destinationProblem(channel, c, env);
    if (bad) { out.push({ channel, problem: bad }); continue; }
    const [adapter] = resolveChannels(env, { [channel]: c }, { fetch: timedFetch(fetch, guardSettings(config, env).fetchTimeoutMs) });
    if (!adapter) {
      const why = channel === "email" ? (!env[c.serviceBinding || "COMMS"] ? `service binding ${c.serviceBinding || "COMMS"} is missing` : "no email template for alerts (channels.email.templates.alert or monitor.alerts.email.template)") : "the channel did not resolve";
      out.push({ channel, problem: why });
    } else out.push({ channel, adapter });
  }
  return out;
}

export const monitorDb = (env = {}, config = {}) => env[guardSettings(config, env).dbBinding];

/** Every reason this monitor must not run. */
export function readiness(env = {}, config = {}) {
  const g = guardSettings(config, env);
  const problems = [];
  const rs = routes(env, config);
  if (!rs.length) problems.push("no alert route is declared: nobody would be told (MONITOR_ROUTES or config.monitor.alerts)");
  for (const r of rs) if (r.problem) problems.push(`route ${r.channel}: ${r.problem}`);
  if (!Number.isFinite(g.staleAfterMin)) problems.push("MONITOR_STALE_AFTER_MIN (or monitor.staleAfterMin) is not set to a positive whole number of minutes (resilience.json declares it; the wrangler var carries it)");
  if (!Number.isFinite(g.fetchTimeoutMs)) problems.push("MONITOR_FETCH_TIMEOUT_MS (or monitor.fetchTimeoutMs) is not set to a positive whole number of milliseconds (resilience.json declares it; the wrangler var carries it)");
  const db = monitorDb(env, config);
  if (!db || typeof db.prepare !== "function") problems.push(`binding ${g.dbBinding} is missing: the monitor writes its runs to a database of its own, never to the one it watches`);
  const own = String(env.MONITOR_DB_ID ?? "").trim();
  const watched = list(env.MONITOR_WATCHED_DB_IDS);
  if (!own) problems.push("MONITOR_DB_ID is not set: the monitor cannot prove its database is not one it watches");
  if (!watched.length) problems.push("MONITOR_WATCHED_DB_IDS is not set: the databases this monitor watches are not declared");
  if (own && watched.includes(own)) problems.push(`${g.dbBinding} (${own}) is a database this monitor watches: it must not write into what it watches`);
  const provider = String(env.MONITOR_DEADMAN_PROVIDER ?? "").trim();
  if (!DEAD_MAN_PROVIDERS.includes(provider)) problems.push(`MONITOR_DEADMAN_PROVIDER must be one of ${DEAD_MAN_PROVIDERS.join(", ")} (the provider resilience.json declares)`);
  else if (provider !== "github-actions") {
    const p = deadManUrlProblem(provider, env[g.deadManEnv]);
    if (p) problems.push(`${g.deadManEnv}: ${p}`);
  }
  return problems;
}

/** The dead-man URL's shape per provider, or null when it is valid. */
export function deadManUrlProblem(provider, url) {
  const u = String(url ?? "");
  if (!u) return "is empty: the dead-man switch URL must be set";
  if (!isHttps(u)) return "is not an https URL (no spaces, a host)";
  if (provider === "healthchecks.io" && !/^https:\/\/hc-ping\.com\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{22}\/[a-z0-9-]+)$/.test(u)) return "is not a healthchecks.io ping URL (https://hc-ping.com/<uuid> or /<ping-key>/<slug>)";
  return null;
}

export function assertReady(env, config) {
  const problems = readiness(env, config);
  if (problems.length) throw new MonitorNotReady(problems);
}

/** { stale, ageMin, future }: no run, or one older than afterMin minutes (exactly), or one dated more than 5 min ahead, is stale. */
export function staleness(lastStartedAt, now = Date.now(), afterMin) {
  const t = lastStartedAt ? Date.parse(lastStartedAt) : NaN;
  if (!Number.isFinite(t)) return { stale: true, ageMin: null, future: false };
  const ageMs = new Date(now).getTime() - t;
  if (ageMs < -SKEW_MS) return { stale: true, ageMin: Math.round(ageMs / 60000), future: true };
  return { stale: !(ageMs <= afterMin * 60000), ageMin: Math.floor(ageMs / 60000), future: false };
}

/** The dead-man ping. outcome: "ok" | "fail" | "start". github-actions: nothing to send (the watcher is the dead-man). */
export async function pingDeadMan(env = {}, config = {}, outcome = "ok", { fetch: f = globalThis.fetch } = {}) {
  const provider = String(env.MONITOR_DEADMAN_PROVIDER ?? "").trim();
  if (provider === "github-actions") return { sent: false, provider, skipped: "the scheduled watcher is the dead-man" };
  const g = guardSettings(config, env);
  const url = String(env[g.deadManEnv] || "");
  const bad = deadManUrlProblem(provider, url);
  if (bad) return { sent: false, provider, error: `dead-man URL ${bad}` };
  const target = outcome === "ok" ? url : `${url.replace(/\/+$/, "")}/${outcome === "fail" ? "fail" : "start"}`;
  try {
    const res = await timedFetch(f, g.fetchTimeoutMs)(target, { method: "GET", headers: { "user-agent": "kit-monitor" } });
    if (!res.ok) return { sent: false, provider, status: res.status, error: `dead-man ping answered ${res.status}` };
    return { sent: true, provider, status: res.status };
  } catch (e) {
    return { sent: false, provider, error: String(e?.message || e).slice(0, 200) };
  }
}
