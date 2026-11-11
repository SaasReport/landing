/**
 * GET /api/health of a kit site Worker, DERIVED from the site's own monitor, never a constant (contract: kit.health.v1,
 * packages/core/schemas/health.schema.json; docs/RELEASE.md). A health endpoint that answers {ok: true} whatever happens told nobody that
 * three sites' daily publishing had failed for a week (2026-10-13). The monitor's status document (kit.monitor-status.v1) is read over
 * the MONITOR service binding, bounded; `ok` is true only when it reads "passing": HTTP 200, otherwise 503 with the monitor's state
 * (failing, stale, unknown, unreachable, not-bound) and the journeys that failed.
 *
 * `readMonitorStatus` is the one reader, shared with GET /api/status (kit.js).
 */

export const HEALTH_PATH = "/api/health";
export const STATUS_TIMEOUT_MS = 5000;

/** → { ok: boolean, status: number, doc?: object, reason?: string } from the monitor Worker behind `binding` (GET /status). */
export async function readMonitorStatus(env = {}, { binding = "MONITOR", timeoutMs = STATUS_TIMEOUT_MS } = {}) {
  const svc = env[binding];
  if (!svc || typeof svc.fetch !== "function") return { ok: false, reason: "not-configured" };
  let timer, res;
  const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error("timeout"), { name: "TimeoutError" })), timeoutMs); });
  try { res = await Promise.race([svc.fetch("https://monitor/status", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) }), limit]); }
  catch (e) { return { ok: false, reason: e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : "unreachable" }; }
  finally { clearTimeout(timer); }
  if (!/application\/json/.test(res.headers.get("content-type") || "")) return { ok: false, reason: "failed" };
  const text = await res.text();
  let doc = null;
  try { doc = JSON.parse(text); } catch { return { ok: false, reason: "failed", text, status: res.status }; /* a monitor answering non-JSON is a failed read: reported, never healthy */ }
  return { ok: true, status: res.status, doc, text };
}

const STATES = new Set(["passing", "failing", "stale", "unknown"]);

/** The kit.health.v1 document for a monitor read (pure). */
export function healthOf(component, read, extra = {}) {
  let monitor;
  if (!read.ok) monitor = { status: read.reason === "not-configured" ? "not-bound" : "unreachable" };
  else {
    const s = read.doc?.status;
    const last = read.doc?.last ?? null;
    monitor = { status: STATES.has(s) ? s : "unknown", last: last?.started_at ?? null, failed: (last?.journeys || []).filter((j) => j && j.ok === false).map((j) => String(j.name)) };
  }
  // the site's own facts ride along but never decide ok: `ok`, `component` and `monitor` are the kit's
  const { ok: _o, component: _c, monitor: _m, ...rest } = extra || {};
  return { ...rest, ok: monitor.status === "passing", component, monitor };
}

/** GET /api/health → Response (200 when the monitor reads passing, else 503). `extra(env)` adds the site's own facts. */
export async function healthResponse(env, { component, binding, timeoutMs, extra } = {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(String(component || ""))) throw new Error("healthResponse: component (the Worker's name) is required");
  const body = healthOf(component, await readMonitorStatus(env, { binding, timeoutMs }), typeof extra === "function" ? await extra(env) : extra);
  return new Response(JSON.stringify(body), { status: body.ok ? 200 : 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
