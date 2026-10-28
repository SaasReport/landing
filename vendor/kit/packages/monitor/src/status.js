/**
 * GET /api/status: the latest synthetic journey runs and every alert route's freshness, from the MONITOR's own database (MONITOR_DB).
 * The document's contract is contracts/status.schema.json (kit.monitor-status.v1); `kit resilience watch` validates it.
 * A status older than staleAfterMin, or dated in the future, is "stale": "passing" from a monitor that stopped running is a lie.
 */
import { staleness, guardSettings, monitorDb, routeSpec } from "./guard.js";

/**
 * The public status document carries REASON CODES, never the error text (review L12): an error from a provider can carry a chat id, a
 * URL or an address. The text stays in the monitor's own D1 (monitor_runs.alert_error, monitor_deliveries.error) for the owner.
 */
export const REASON_CODES = Object.freeze(["not-configured", "timeout", "rejected", "provider-error", "unreachable", "failed", "never-attempted"]);
export function reasonCode(text) {
  if (text == null || text === "") return null;
  const t = String(text);
  if (/\b(not set|not bound|not configured|missing|must be)\b/i.test(t)) return "not-configured";
  if (/time(d)? ?out|aborted/i.test(t)) return "timeout";
  if (/\b5\d\d\b/.test(t)) return "provider-error";
  if (/\b4\d\d\b|unauthori[sz]ed|forbidden|not found|refused|rejected/i.test(t)) return "rejected";
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|network|unreachable|offline/i.test(t)) return "unreachable";
  return "failed";
}
const deadmanCode = (s) => (s == null ? null : s === "sent" || s === "watcher" ? s : "failed");

const run = (r) => {
  let journeys = [], readable = true;
  try { journeys = JSON.parse(r.results_json || "[]"); } catch (e) { readable = false; journeys = [{ name: "results", ok: false, error: `results_json is not JSON: ${e.message}` }]; }
  // a run whose results cannot be read proves nothing: it is failing, whatever its stored ok
  return {
    started_at: r.started_at, finished_at: r.finished_at ?? null, trigger: ["cron", "drill"].includes(r.trigger) ? r.trigger : "manual", ok: readable && Boolean(r.ok), journeys,
    ...(r.alert_status ? { alert_status: r.alert_status } : {}), ...(r.alert_error ? { alert_reason: reasonCode(r.alert_error) } : {}), ...(r.deadman_status ? { deadman_status: deadmanCode(r.deadman_status) } : {}),
  };
};

/**
 * Per route: the last attempt, the last success, and how many deliveries failed SINCE that success (with the newest one's reason code); rows newest first.
 * A route in `declared` with no delivery at all appears as `never-attempted`: a route nobody has ever tried is not a route that works.
 */
export function routeFreshness(deliveries = [], declared = []) {
  const by = new Map();
  for (const d of deliveries) {
    const r = by.get(d.route) || { route: d.route, last_attempt_at: d.at, last_ok_at: null, last_reason: null, failed: 0 };
    if (d.ok && !r.last_ok_at) r.last_ok_at = d.at;
    // only failures SINCE the last delivery count (rows are newest first): one transient failure that a later delivery cleared does
    // not keep the route red for the whole window
    if (!d.ok && !r.last_ok_at) { r.failed++; if (!r.last_reason) r.last_reason = reasonCode(d.error) ?? "failed"; }
    by.set(d.route, r);
  }
  for (const route of declared) if (!by.has(route)) by.set(route, { route, last_attempt_at: null, last_ok_at: null, last_reason: "never-attempted", failed: 0 });
  return [...by.values()];
}

/** Pure: rows and deliveries (newest first) → the status document. With `now`, a stale or future last run makes the status "stale". */
export function statusDocument(rows = [], { now = null, staleAfterMin, deliveries = [], declared = [] } = {}) {
  const runs = rows.map(run);
  const doc = { ok: true, status: runs[0] ? (runs[0].ok ? "passing" : "failing") : "unknown", last: runs[0] || null, recent: runs, routes: routeFreshness(deliveries, declared) };
  if (now != null && !(Number.isInteger(staleAfterMin) && staleAfterMin > 0)) { doc.status = "unknown"; doc.reason = "not-configured"; }   // no limit to judge staleness by: say so, invent none
  else if (now != null) {
    const s = staleness(runs[0]?.started_at, now, staleAfterMin);
    doc.stale = s.stale; doc.age_min = s.ageMin; doc.future = s.future; doc.stale_after_min = staleAfterMin;
    if (runs[0] && s.stale) doc.status = "stale";
  }
  return doc;
}

/** The most delivery rows one route contributes to the status (a route that never succeeds would otherwise read its whole history). */
export const DELIVERY_ROWS_PER_ROUTE = 200;

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };

/**
 * statusHandler(env, { limit = 7, db, config, now }) → Response. The database is the monitor's own (MONITOR_DB, or `db`): there is no
 * fallback to the site's DB; an unbound monitor database answers 503.
 */
export async function statusHandler(env, { limit = 7, db, config = {}, now = Date.now() } = {}) {
  const DB = db || monitorDb(env, config);
  const g = guardSettings(config, env);
  if (!DB) return new Response(JSON.stringify({ ok: false, status: "unknown", reason: "not-configured" }), { status: 503, headers: HEADERS });   // a reason code, like every public answer
  let rows = [], deliveries = [];
  const declared = Object.entries(routeSpec(env, config)).filter(([, v]) => v).map(([c]) => c);
  try {
    rows = (await DB.prepare("SELECT started_at, finished_at, trigger, ok, results_json, alert_status, alert_error, deadman_status FROM monitor_runs ORDER BY started_at DESC LIMIT ?").bind(limit).all()).results || [];
    // per declared route, never one global window: a chatty route must not push another route's last delivery out of the rows read. Each route
    // reads its newest deliveries back to its last success (inclusive), which is all routeFreshness needs.
    for (const route of declared) {
      deliveries.push(...((await DB.prepare("SELECT route, kind, ok, error, at FROM monitor_deliveries WHERE route = ? AND at >= COALESCE((SELECT MAX(at) FROM monitor_deliveries WHERE route = ? AND ok = 1), '') ORDER BY at DESC LIMIT ?").bind(route, route, DELIVERY_ROWS_PER_ROUTE).all()).results || []));
    }
  } catch (e) {
    if (!/no such table|no such column/i.test(String(e?.message || e))) throw e; // migrations not applied yet → "unknown"
  }
  return new Response(JSON.stringify(statusDocument(rows, { now, staleAfterMin: g.staleAfterMin, deliveries, declared })), { headers: HEADERS });
}
