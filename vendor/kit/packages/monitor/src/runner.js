/**
 * MonitorRunner: a Durable Object that owns the Browser Rendering session (kept alive between runs) and acts
 * as a lock, so a manual run and the cron never overlap. Fetch-based (no `cloudflare:workers` import), so the
 * module also loads in Node for tests.
 */
import { alertMessage } from "@saasreport/channels";
import DELIVERY from "../contracts/delivery.schema.json" with { type: "json" };
import { journeys as deriveJourneys, journeyContext } from "./journeys.js";
import { runJourney, summarize } from "./policy.js";
import { readiness, monitorDb, guardSettings, staleness, pingDeadMan, routes as resolveRoutes, routeSpec } from "./guard.js";

/** The delivery kinds, from their one source, the contract (contracts/delivery.schema.json). */
export const DELIVERY_KINDS = Object.freeze([...DELIVERY.properties.kind.enum]);

export const KEEP_ALIVE_MS = 10 * 60 * 1000;
const LOCK_TTL_MS = 15 * 60 * 1000;

const trimSlash = (s) => String(s || "").replace(/\/+$/, "");
export const siteOf = (config, env = {}) => trimSlash(env.SITE || config.monitor?.site || config.site?.url);

/** Alert text for a failed run (pure). */
export function alertFor(config, site, sum, results, started) {
  const name = config.site?.name || site.replace(/^https?:\/\//, "");
  const failed = results.filter((r) => !r.ok);
  return {
    subject: `${name}: ${failed.length} of ${sum.total} monitor journeys failed`,
    lines: failed.map((r) => `${r.name}: ${r.error}`),
    url: `${site}/api/status`,
    reference: started,
    idempotencyKey: `monitor:${started}`,
  };
}

/** Alert text when the previous run is older than staleAfterMin (scheduled runs were missed). */
export function staleAlert(config, site, lastStartedAt, ageMin, started, allowedMin) {
  const name = config.site?.name || site.replace(/^https?:\/\//, "");
  return {
    subject: `${name}: the monitor missed its schedule (last run ${Math.round(ageMin / 60)} h ago)`,
    lines: [`previous run started ${lastStartedAt}; allowed gap ${allowedMin} min`],
    url: `${site}/api/status`, reference: started, idempotencyKey: `monitor-stale:${started}`,
  };
}

/** The alert drill's message: sent through every route on a drill run (POST /run?mode=drill), whatever the health and whatever today's canary
 *  did, so the drill proves each route delivers NOW. Marked so no reader takes it for an incident; recorded with kind 'drill'. */
export function drillFor(config, site, started) {
  const name = config.site?.name || site.replace(/^https?:\/\//, "");
  return { subject: `${name}: ALERT DRILL — not an incident`, lines: ["This is an alert drill. It proves this alert route delivers. Nothing failed."], url: `${site}/api/status`, reference: started, idempotencyKey: `monitor-drill:${started}` };
}

/** The daily canary: proves every route delivers, every day, not only on the day something breaks. Once per route per UTC day. */
export function canaryFor(config, site, started) {
  const name = config.site?.name || site.replace(/^https?:\/\//, "");
  return { subject: `${name}: monitor canary (every route, every day)`, lines: ["This message proves this alert route delivers. Nothing failed."], url: `${site}/api/status`, reference: started, idempotencyKey: `monitor-canary:${String(started).slice(0, 10)}` };
}

/**
 * Build the DO class for a config. deps: { puppeteer, channels, fetch, now } (all optional; injected in tests).
 */
export function createRunnerClass(config, deps = {}) {
  const m = config.monitor || {};
  const retries = m.retries ?? 1;
  const keepAlive = m.keepAliveMs ?? KEEP_ALIVE_MS;
  const timeout = m.timeoutMs ?? 30000;
  const viewport = m.viewport || { width: 1280, height: 900 };
  const list = deriveJourneys(config);

  const routeSpecOf = (env) => routeSpec(env, config);
  return class MonitorRunner {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; this.running = false; }

    async puppeteer() {
      return deps.puppeteer || (await import("@cloudflare/puppeteer")).default;
    }

    /** Reconnect to the kept-alive browser session, or launch a new one. */
    async browser() {
      const puppeteer = await this.puppeteer();
      const storage = this.ctx?.storage;
      const id = await storage?.get("session");
      if (id) { try { return await puppeteer.connect(this.env.BROWSER, id); } catch (e) { console.warn("monitor: the browser session is gone, opening a new one", e?.message); } }
      const b = await puppeteer.launch(this.env.BROWSER, { keep_alive: keepAlive });
      await storage?.put("session", b.sessionId());
      return b;
    }

    async lock() {
      if (this.running) return false;
      const storage = this.ctx?.storage;
      const held = await storage?.get("lock");
      if (held && Date.now() - held < LOCK_TTL_MS) return false;
      this.running = true;
      await storage?.put("lock", Date.now());
      return true;
    }

    async unlock() { this.running = false; await this.ctx?.storage?.delete("lock"); }

    /** One row in the MONITOR's own database (never the watched one): the verdict, how the alerts went. */
    async record(started, trigger, ok, results, extra = {}) {
      await monitorDb(this.env, config).prepare("INSERT INTO monitor_runs (started_at, finished_at, trigger, ok, results_json, alert_status, alert_error, deadman_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(started, new Date().toISOString(), trigger, ok ? 1 : 0, JSON.stringify(results), extra.alertStatus ?? "none", extra.alertError ?? null, extra.deadmanStatus ?? null).run();
    }

    /** One row per route and message: what was attempted and whether the route accepted it. */
    async recordDelivery(started, route, kind, ok, error) {
      if (!DELIVERY_KINDS.includes(kind)) throw new Error(`delivery kind "${kind}" is not in contracts/delivery.schema.json`);
      await monitorDb(this.env, config).prepare("INSERT INTO monitor_deliveries (run_started_at, route, kind, ok, error, at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(started, route, kind, ok ? 1 : 0, error ?? null, new Date().toISOString()).run();
    }

    /** Start time of the previous run, or null (no run yet). A read that fails is an error, not "no run". */
    async lastRun() {
      const row = await monitorDb(this.env, config).prepare("SELECT started_at FROM monitor_runs ORDER BY started_at DESC LIMIT 1").first();
      return row?.started_at ?? null;
    }

    async ping(outcome) { return pingDeadMan(this.env, config, outcome, deps.fetch ? { fetch: deps.fetch } : {}); }

    async run(trigger = "manual") {
      const problems = readiness(this.env, config);
      if (problems.length) {   // t=0: a monitor that cannot tell anyone, or watches its own database, does not run
        console.error("[monitor] refuses to run:", problems.join("; "));
        await this.ping("fail");
        return { ok: false, error: "monitor_not_ready", problems };
      }
      if (!(await this.lock())) return { ok: false, error: "already_running" };
      const started = new Date().toISOString();
      const site = siteOf(config, this.env);
      const f = deps.fetch || globalThis.fetch;
      let browser;
      let results = [];
      let broken = null;
      const alerts = [];
      try {
        let prior = null;
        try { prior = await this.lastRun(); } catch (e) { broken = `cannot read the previous run: ${String(e?.message || e).slice(0, 200)}`; }
        if (!site) throw new Error("no site url (config.site.url or env SITE)");
        const pages = [];
        const page = async (pathOrUrl) => {
          browser ||= await this.browser();
          const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${site}${pathOrUrl}`;
          const p = await browser.newPage(); pages.push(p);
          const errors = [];
          p.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text().slice(0, 200)); });
          p.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
          await p.setViewport(viewport);
          const r = await p.goto(`${url}${url.includes("?") ? "&" : "?"}monitor=${Date.now()}`, { waitUntil: "networkidle0", timeout });
          if (!r || r.status() >= 400) throw new Error(`${url} → ${r?.status()}`);
          return { p, errors };
        };
        const get = (path, init) => f(/^https?:\/\//.test(path) ? path : `${site}${path}`, { ...init, headers: { "cache-control": "no-cache", ...(init?.headers || {}) } });
        const closePages = () => Promise.all(pages.splice(0).map((p) => p.close().catch(() => {})));   // closing a page that already crashed: the run's result is already recorded
        const ctx = journeyContext(config, { page, get, site, now: deps.now ? deps.now() : new Date(), trigger, env: this.env });
        for (const j of list) {
          results.push(await runJourney(j.name, () => j.run(ctx), { retries, onRetry: closePages }));
          await closePages();
        }
        const sum = summarize(results);
        // stale-run detection: this run found the previous one older than staleAfterMin, i.e. scheduled runs were missed
        const age = prior ? staleness(prior, deps.now ? deps.now() : Date.now(), guardSettings(config, this.env).staleAfterMin) : null;
        if (!sum.ok) alerts.push(alertFor(config, site, sum, results, started));
        if (age?.stale) alerts.push(staleAlert(config, site, prior, age.ageMin ?? 0, started, guardSettings(config, this.env).staleAfterMin));
      } catch (e) {
        results = [{ name: "runner", ok: false, ms: 0, attempts: 1, error: String(e?.message || e).slice(0, 500) }];
        alerts.push(alertFor(config, site, summarize(results), results, started));
        broken = `runner: ${results[0].error}`;
      } finally {
        if (browser) await browser.disconnect().catch(() => {}); // keep the session alive for the next run
      }
      try { return await this.finish({ trigger, started, site, results, alerts, broken }); } finally { await this.unlock(); }
    }

    /**
     * Every route gets every alert AND the daily canary (once per route per UTC day: a route that already delivered today's canary is
     * not sent another; a read that fails sends it again rather than skip it); each send is recorded per route. A route that refused is itself alerted
     * through the routes that work, and the run fails. Then the row, then the dead-man ping, whose result is stored in the row; a
     * failed ping fails the run too. Nothing here is swallowed.
     */
    async finish({ trigger, started, site, results, alerts, broken }) {
      const failures = broken ? [broken] : [];
      const messages = alerts.map((a) => ({ kind: "alert", alert: a }));
      const canary = { kind: "canary", alert: canaryFor(config, site, started) };
      const canaryDone = async (ch) => {
        try {
          return Boolean(await monitorDb(this.env, config).prepare("SELECT 1 AS done FROM monitor_deliveries WHERE route = ? AND kind = 'canary' AND ok = 1 AND at >= ? LIMIT 1")
            .bind(ch, `${String(started).slice(0, 10)}T00:00:00.000Z`).first());
        } catch { /* failure here means no value; the caller holds on the empty answer */ return false; }
      };
      const delivered = new Map();   // channel -> { ok, error }: every message of the run on that route, ANDed (the run's verdict)
      const drilled = new Map();     // channel -> { ok, error }: the drill message's own outcome on that route (a drill run only)
      let recordErr = null;
      const note = async (...a) => { try { await this.recordDelivery(...a); } catch (e) { recordErr ||= String(e?.message || e).slice(0, 300); } };
      const send = async (route, m) => {
        const r = await this.sendRoute(route, m.alert);
        await note(started, route.channel, m.kind, r.ok, r.error);
        const prev = delivered.get(route.channel);
        delivered.set(route.channel, { ok: (prev?.ok ?? true) && r.ok, error: prev?.error || r.error || null });
        return { ok: r.ok, error: r.error || null };
      };
      const rs = resolveRoutes(this.env, config, deps.fetch ? { fetch: deps.fetch } : {});
      for (const route of rs) {
        if (!route.adapter) { delivered.set(route.channel, { ok: false, error: route.problem }); if (trigger === "drill") drilled.set(route.channel, { ok: false, error: route.problem }); await note(started, route.channel, "canary", false, route.problem); continue; }
        for (const m of messages) await send(route, m);
        if (!(await canaryDone(route.channel))) await send(route, canary);
        // a drill proves every route delivers now: the daily canary may already have gone, so the drill sends its own marked message
        // its own result is reported separately: an earlier alert or canary that failed must not hide that the drill message delivered
        if (trigger === "drill") drilled.set(route.channel, await send(route, { kind: "drill", alert: drillFor(config, site, started) }));
      }
      const bad = [...delivered].filter(([, d]) => !d.ok);
      for (const [ch, d] of bad) { results.push({ name: `route:${ch}`, ok: false, ms: 0, attempts: 1, error: String(d.error).slice(0, 500) }); failures.push(`route ${ch}: ${d.error}`); }
      if (bad.length) {   // tell someone through the routes that work
        const warn = { subject: `${config.site?.name || site}: alert route ${bad.map(([c]) => c).join(", ")} did not deliver`, lines: bad.map(([c, d]) => `${c}: ${d.error}`), url: `${site}/api/status`, reference: started, idempotencyKey: `monitor-route:${started}` };
        for (const route of rs.filter((r) => r.adapter && delivered.get(r.channel)?.ok)) await send(route, { kind: "route-failure", alert: warn });
      }
      if (recordErr) failures.push(`delivery record failed: ${recordErr}`);
      const alertStatus = bad.length ? "failed" : alerts.length ? "sent" : "none";
      const alertError = bad.length ? bad.map(([c, d]) => `${c}: ${d.error}`).join("; ").slice(0, 1000) : null;
      const sum = summarize(results);
      let ok = sum.ok && !failures.length;
      let recordError = null;
      // the row is written NOT passing and "pending" (ok = 0 until the dead-man result is known); ONLY the update after the ping sets ok = 1, and only when the
      // ping was sent or skipped: a failed write at any point leaves a row that is not passing, never a passing one (/api/health and the watcher read it)
      try { await this.record(started, trigger, false, results, { alertStatus, alertError, deadmanStatus: "pending" }); }
      catch (e) { recordError = String(e?.message || e).slice(0, 300); failures.push(`record failed: ${recordError}`); ok = false; console.error("[monitor] cannot record the run", recordError); }
      const deadman = await this.ping(failures.length ? "fail" : "ok");
      const deadmanFailed = !deadman.sent && !deadman.skipped;
      if (deadmanFailed) {
        failures.push(`dead-man ping: ${deadman.error}`); ok = false;
        const warn = { subject: `${config.site?.name || site}: the monitor's dead-man ping failed`, lines: [String(deadman.error)], url: `${site}/api/status`, reference: started, idempotencyKey: `monitor-deadman:${started}` };
        for (const route of rs.filter((r) => r.adapter && delivered.get(r.channel)?.ok)) await send(route, { kind: "deadman-failure", alert: warn });
      }
      if (!recordError) {
        try {
          await monitorDb(this.env, config).prepare("UPDATE monitor_runs SET deadman_status = ?, ok = ? WHERE started_at = ?")
            .bind(deadman.sent ? "sent" : deadman.skipped ? "watcher" : `failed: ${deadman.error}`.slice(0, 300), ok ? 1 : 0, started).run();
        } catch (e) { failures.push(`record of the dead-man result failed: ${String(e?.message || e).slice(0, 200)}`); ok = false; console.error("[monitor] cannot record the dead-man result", String(e?.message || e)); }
      }
      if (!deadman.sent && !deadman.skipped) console.error("[monitor] dead-man ping failed", deadman.error);
      return { ...sum, ok, started, finished: new Date().toISOString(), results, routes: Object.fromEntries(delivered), ...(trigger === "drill" ? { drill: Object.fromEntries(drilled) } : {}), alert: { status: alertStatus, error: alertError }, deadman, ...(failures.length ? { monitor_failures: failures } : {}) };
    }

    /** One message through one resolved route → { ok, error? }. */
    async sendRoute(route, alert) {
      try {
        const message = alertMessage(config, alert, routeSpecOf(this.env));
        // a service binding ignores an abort signal, so the deadline is also a race: the run must not wait for a hung route
        const ms = guardSettings(config, this.env).fetchTimeoutMs; let timer;
        if (!Number.isInteger(ms)) throw new Error("MONITOR_FETCH_TIMEOUT_MS is not set: no call goes out without a deadline");
        const hang = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`route ${route.channel} timed out after ${ms} ms`)), ms); });
        const ref = await Promise.race([route.adapter.send(message), hang]).finally(() => clearTimeout(timer));
        return { ok: true, ref };
      } catch (e) {
        console.error("[monitor] route failed", route.channel, String(e?.message || e));
        return { ok: false, error: String(e?.message || e).slice(0, 300) };
      }
    }

    async fetch(request) {
      const asked = new URL(request.url).searchParams.get("trigger");
      const trigger = asked === "cron" || asked === "drill" ? asked : "manual";
      const out = await this.run(trigger);
      return Response.json(out, { status: out.error === "monitor_not_ready" ? 503 : 200 });
    }
  };
}
