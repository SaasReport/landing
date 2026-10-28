/**
 * @saasreport/monitor — daily synthetic journeys in a headless browser (Cloudflare Browser Rendering).
 *
 *   import config from "./kit.config.js";
 *   import { createMonitor } from "@saasreport/monitor";
 *   const monitor = createMonitor(config);
 *   export default monitor.worker;
 *   export const MonitorRunner = monitor.MonitorRunner;
 *
 * The worker runs every journey on its cron trigger, or on POST /run with `Authorization: Bearer <MONITOR_TOKEN>`; POST /run?mode=drill is
 * an alert drill: the same run, plus a message marked "ALERT DRILL — not an incident" through every route (kind 'drill'), whatever the health.
 * GET /status returns the recent runs (same document as the site's GET /api/status via statusHandler).
 * The monitor REFUSES TO RUN (a failed cron, a 503) when a declared alert route would not deliver, when its database is one it watches
 * (by id), or when the dead-man is not set up (guard.js). Every run sends the canary through every route; a route that fails is alerted
 * through the others and fails the run.
 */
import { createRunnerClass, siteOf } from "./runner.js";
import { journeyList } from "./journeys.js";
import { statusHandler } from "./status.js";
import { readiness, assertReady, pingDeadMan, MonitorNotReady } from "./guard.js";

export { runJourney, summarize, expect } from "./policy.js";
export { journeys, journeyList, journeyContext, BUILTINS, DEFAULT_SELECTORS, DEFAULT_PATHS, podcastSeries, hasStarted, localParts, isDueToday, seriesDueToday, monitorSettings } from "./journeys.js";
export { statusHandler, statusDocument, routeFreshness, reasonCode, REASON_CODES } from "./status.js";
export { readiness, assertReady, routes, routeSpec, monitorDb, staleness, pingDeadMan, deadManUrlProblem, guardSettings, MonitorNotReady, DEAD_MAN_PROVIDERS, DEFAULTS as GUARD_DEFAULTS } from "./guard.js";
export { createRunnerClass, alertFor, staleAlert, canaryFor, drillFor, DELIVERY_KINDS, KEEP_ALIVE_MS } from "./runner.js";

/** Constant-time string comparison. */
function safeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * createMonitor(config, deps?) → { worker: { scheduled, fetch }, default (same as worker), MonitorRunner, statusHandler, journeys }.
 * env bindings: RUNNER (DO namespace of MonitorRunner), BROWSER, MONITOR_DB (the monitor's own D1); secret MONITOR_TOKEN; optional var SITE;
 * vars MONITOR_ROUTES, MONITOR_DB_ID, MONITOR_WATCHED_DB_IDS, MONITOR_DEADMAN_PROVIDER, MONITOR_STALE_AFTER_MIN (written and verified by
 * `kit check resilience`); secrets per route (channels alertVariables) and MONITOR_DEADMAN_URL for a ping provider.
 */
export function createMonitor(config = {}, deps = {}) {
  const MonitorRunner = createRunnerClass(config, deps);
  const binding = config.monitor?.binding || "RUNNER";
  const runner = (env) => {
    const ns = env[binding];
    if (!ns) throw new Error(`monitor: Durable Object binding ${binding} is missing`);
    const name = config.monitor?.runnerName || siteOf(config, env).replace(/^https?:\/\//, "") || "monitor";
    return ns.get(ns.idFromName(name));
  };

  const worker = {
    async scheduled(event, env, ctx) {
      if (config.features?.monitor === false) return; // feature switched off: the cron is a no-op
      // t=0: not ready is a FAILED cron invocation (visible in the Cloudflare cron log), and the dead-man switch hears "fail".
      const problems = readiness(env, config);
      if (problems.length) {
        const sent = await pingDeadMan(env, config, "fail", deps.fetch ? { fetch: deps.fetch } : {});
        throw new MonitorNotReady(sent.sent || sent.skipped ? problems : [...problems, `dead-man ping not sent: ${sent.error}`]);
      }
      const p = runner(env).fetch("https://monitor/run?trigger=cron")
        .then(async (r) => { const out = await r.json(); if (!r.ok) throw new Error(`run answered ${r.status}: ${out.error || ""}`); return out; })
        .then((r) => {
          console.log("[monitor]", JSON.stringify({ ok: r.ok, failed: r.failed, flaky: r.flaky }));
          // the monitor itself broke (a route did not deliver, the record or the dead-man ping failed): the cron invocation fails too
          if (r.monitor_failures?.length) throw new Error(`monitor run failed: ${r.monitor_failures.join("; ")}`);
        });
      // not caught here: a run that throws fails the cron invocation instead of vanishing into console.error
      if (ctx?.waitUntil) ctx.waitUntil(p); else await p;
    },
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === "/status" && request.method === "GET") return statusHandler(env, { config });
      if (url.pathname !== "/run") return new Response("not found", { status: 404 });
      if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
      const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (!env.MONITOR_TOKEN || !token || !safeEqual(token, env.MONITOR_TOKEN)) return new Response("unauthorized", { status: 401 });
      // ?mode=drill: an alert drill (a marked message through every route, whatever the health); any other mode is refused, never guessed
      const mode = url.searchParams.get("mode");
      if (mode !== null && mode !== "drill") return new Response("unknown mode", { status: 400 });
      return runner(env).fetch(`https://monitor/run?trigger=${mode === "drill" ? "drill" : "manual"}`);
    },
  };

  return { worker, default: worker, MonitorRunner, statusHandler, journeys: journeyList(config) };
}
