/**
 * The form-delivery ledger, read-only apart from the lookup counter (docs/FORMS.md, kit.form-notification.v1): what the comms engine recorded for each submission's
 * two deliveries, the submitter's receipt and the owner's notification. Statuses only, never an address or a submitted value.
 *
 *   GET /api/forms/deliveries               the summary over the window ($defs.summary): 200 when every owner delivery went, 503 when
 *                                           one failed or is pending past the window, so the monitor's form-deliveries journey fails,
 *                                           alerts through its routes and shows on /api/status
 *   GET /api/forms/deliveries/<reference>   one record (the link in the owner's notification); the reference is 80 bits and the lookup
 *                                           is limited per client (429 rate_limited)
 *
 * The table lives in the site's D1 (the comms engine binds the same database, @saasreport/comms migration 0003). A missing table or a
 * failed read is a 503, never an empty "ok".
 */
import { readDelivery, deliverySummary, lookupAllowed, LOOKUP_LIMIT, REFERENCE_RE, SUMMARY_DEFAULTS } from "@saasreport/core/form-deliveries";
import { json, sha256 } from "../util.js";

const NO_STORE = { "cache-control": "no-store" };

export function createFormDeliveries(k) {
  const site = k.config.site.origin;
  const opts = SUMMARY_DEFAULTS;   // 24 h window, 15 min before a pending owner delivery counts as failed (one source: @saasreport/core)

  async function handle(request, env, url) {
    const m = url.pathname.match(/^\/api\/forms\/deliveries(?:\/([^/]+))?\/?$/);
    if (!m) return null;
    if (request.method !== "GET" && request.method !== "HEAD") return json({ ok: false, error: "method_not_allowed" }, 405);
    if (!env.DB) return json({ ok: false, error: "no_ledger" }, 503, NO_STORE);
    try {
      if (m[1] !== undefined) {
        const ref = decodeURIComponent(m[1]);
        if (!REFERENCE_RE.test(ref)) return json({ ok: false, error: "invalid_reference" }, 400, NO_STORE);
        // a reference is a bearer capability to one status record: lookups are limited per client, so it cannot be searched for
        const ipHash = await sha256(`${request.headers.get("cf-connecting-ip") || "0.0.0.0"}|${env.IP_SALT || k.config.site.id}`);
        if (!(await lookupAllowed(env.DB, ipHash, k.now()))) return json({ ok: false, error: "rate_limited" }, 429, { ...NO_STORE, "retry-after": String(LOOKUP_LIMIT.windowMinutes * 60) });
        const rec = await readDelivery(env.DB, ref, site);
        return rec ? json(rec, 200, NO_STORE) : json({ ok: false, error: "not_found" }, 404, NO_STORE);
      }
      const s = await deliverySummary(env.DB, { now: k.now(), windowHours: opts.windowHours, pendingAfterMin: opts.pendingAfterMin });
      return json(s, s.ok ? 200 : 503, NO_STORE);
    } catch (e) {
      console.error("[kit] form deliveries: the ledger could not be read", String(e?.message || e));
      return json({ ok: false, error: "ledger_unreadable" }, 503, NO_STORE);
    }
  }
  return { handle };
}
