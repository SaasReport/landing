/**
 * Outbound signed webhooks on Cloudflare: one Workflow instance per (event, subscriber), retried with exponential backoff
 * by the Workflow runtime (the same durable pattern as PodcastWorkflow), plus an intake helper for upstream deliveries.
 * The signing, verifying and envelopes are @saasreport/channels/webhooks (kit.webhook-event.v1).
 *
 *   subscribersFrom(env, config.webhooks)              → [{ id, url, keys, types }] (URLs and keys from vars/secrets)
 *   enqueueWebhooks(env, event, { subscribers })       → { queued, skipped }   (env.WEBHOOK_WF.create per subscriber)
 *   webhookWorkflowClass(Base, { subscribers })        → class WebhookWorkflow (Workers: createWebhookWorkflow, ./webhooks-workflow)
 *   intakeWebhook(request, env, { provider, verify, eventType, normalise, source, onEvents }) → Response
 *
 * Secrets never enter a Workflow's params (they are stored by the platform): the instance gets the event and the
 * subscriber id; the Workflow reads the subscriber's URL and keys from env when it runs. Nothing is sent unless a
 * subscriber is configured: a project without `webhooks.subscribers` (or without the vars) sends nothing.
 *
 * config.webhooks: { binding: "WEBHOOK_WF", subscribers: [{ id, urlEnv, keysEnv, types?: ["comms.*", "calendar.sync_completed"] }] }
 *   keysEnv names a secret holding the signing keys, newest first: "2026-10:<secret>,2026-07:<secret>" or a JSON object.
 */
import { deliverWebhook, verifyWebhook, twoLayerEvents, normaliseKeys } from "@saasreport/channels/webhooks";
import { assertSafeUrl } from "@saasreport/core/safe-fetch";
import { readBoundedText, BodyError } from "@saasreport/uploads/bounded";

export const DEFAULT_BINDING = "WEBHOOK_WF";
export const DEFAULT_RETRIES = { limit: 8, delay: "30 seconds", backoff: "exponential" };   // 30 s, 1, 2, 4 … 64 min

/** "kid:secret,kid2:secret" or '{"kid":"secret"}' → [{ id, secret }] (newest first, as written). */
export function parseKeys(raw) {
  const s = String(raw || "").trim();
  if (!s) return [];
  if (s.startsWith("{")) return normaliseKeys(JSON.parse(s));
  return normaliseKeys(s.split(",").map((p) => p.trim()).filter(Boolean).map((p) => { const i = p.indexOf(":"); return { id: p.slice(0, i), secret: p.slice(i + 1) }; }));
}

/** Does a subscriber want this event type? types: exact names or "prefix.*"; none means every type. */
export const wants = (sub, type) => !sub.types?.length || sub.types.some((t) => t === type || (t.endsWith(".*") && type.startsWith(t.slice(0, -1))));

/** The configured subscribers whose URL and keys are present in env (others are dormant and left out). */
export function subscribersFrom(env = {}, webhooks = {}) {
  const out = [];
  for (const s of webhooks.subscribers || []) {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(String(s.id || ""))) throw new Error(`webhooks: subscriber id "${s.id}" must be lowercase letters, digits and hyphens`);
    const url = s.url ?? env[s.urlEnv];
    const keys = s.keysEnv ? parseKeys(env[s.keysEnv]) : [];
    if (!url || !keys.length) continue;
    try { assertSafeUrl(url); } catch (e) { throw new Error(`webhooks: subscriber "${s.id}" url is refused (${e.message}); a subscriber URL must be https on a public host`); }
    out.push({ id: s.id, url, keys, types: s.types || [], ...(s.headers ? { headers: s.headers } : {}) });
  }
  return out;
}

/** Queue one Workflow instance per interested subscriber; an instance id already used counts as queued (idempotent). */
export async function enqueueWebhooks(env, event, { webhooks = {}, subscribers } = {}) {
  const binding = env[webhooks.binding || DEFAULT_BINDING];
  const subs = (subscribers || subscribersFrom(env, webhooks)).filter((s) => wants(s, event.type));
  if (!subs.length) return { queued: 0, skipped: "no_subscriber" };
  if (!binding?.create) return { queued: 0, skipped: "no_workflow_binding" };
  let queued = 0;
  for (const s of subs) {
    const id = `${event.id}--${s.id}`.slice(0, 100);
    try { await binding.create({ id, params: { event, subscriber: s.id } }); queued++; }
    catch (e) { if (/already exists|duplicate/i.test(String(e?.message || e))) queued++; else throw e; }
  }
  return { queued };
}

/**
 * The Workflow body for any base class (WorkflowEntrypoint in Workers; any class with this.env in tests).
 * One step per delivery: a retryable failure (network, 408, 425, 429, 5xx) throws, so the runtime retries it with
 * exponential backoff; any other 4xx ends the run as given up (no retry storm against a receiver that said no).
 */
export function webhookWorkflowClass(Base, { webhooks = {}, subscribers, retries = DEFAULT_RETRIES, timeout = "1 minute", fetch, resolve, onResult } = {}) {
  return class WebhookWorkflow extends Base {
    async run(instance, step) {
      const { event, subscriber } = instance.payload || {};
      const subs = typeof subscribers === "function" ? await subscribers(this.env) : subscribers || subscribersFrom(this.env, webhooks);
      const sub = subs.find((s) => s.id === subscriber);
      if (!sub || !event?.id) return { ok: false, skipped: sub ? "no_event" : "unknown_subscriber" };
      const result = await step.do(`deliver ${event.id} to ${sub.id}`, { retries, timeout }, async () => {
        const r = await deliverWebhook(event, sub, { ...(fetch ? { fetch } : {}), ...(resolve ? { resolve } : {}) });
        if (r.ok || !r.retryable) return { ...r, ...(r.ok ? {} : { gave_up: true }) };
        throw new Error(`webhook ${sub.id}: ${r.error}`);
      });
      if (onResult) await step.do("record result", async () => { await onResult(this.env, { event, subscriber: sub.id, result }); return true; });
      return result;
    }
  };
}

const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

/**
 * Receive an upstream delivery and turn it into two layers (relayed + normalised), then hand them to onEvents
 * (e.g. store, then enqueueWebhooks each). verify(request, body, env) → true | false checks the provider's own signature;
 * with `keys` instead, the delivery must carry this kit's signature scheme (verifyWebhook). Unverified → 401, nothing kept.
 */
export async function intakeWebhook(request, env, { provider, verify, keys, tolerance, seen, eventType, eventId, normalise, source, onEvents, maxBytes = 256 * 1024, contentLength = "required" }) {
  if (request.method !== "POST") return res(405, { ok: false, error: "method_not_allowed" });
  // the cap is enforced while the body streams in; a delivery without a Content-Length, or one that lies about it, is refused
  let body;
  try { ({ text: body } = await readBoundedText(request, { maxBytes, contentLength })); }
  catch (e) { if (e instanceof BodyError) return res(e.status, { ok: false, error: e.code }); throw e; }
  let ok = false;
  if (verify) ok = Boolean(await verify(request, body, env));
  else if (keys) ok = (await verifyWebhook({ headers: request.headers, body }, { keys: typeof keys === "function" ? await keys(env) : keys, tolerance, seen: seen && ((id) => seen(env, id)) })).ok;
  if (!ok) return res(401, { ok: false, error: "unverified" });
  let payload;
  try { payload = JSON.parse(body); } catch { return res(400, { ok: false, error: "invalid_json" }); }
  const events = twoLayerEvents({ provider, eventType: eventType(payload), eventId: eventId ? eventId(payload) : null, payload, verified: true }, { source, normalise });
  if (onEvents) await onEvents(env, events);
  return res(202, { ok: true, events: events.map((e) => ({ id: e.id, type: e.type })) });
}
