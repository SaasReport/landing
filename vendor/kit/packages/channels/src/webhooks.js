/**
 * Signed webhooks, two layers (after the "double webhook" pattern): a project relays an upstream provider's event as it
 * arrived AND emits its own normalised event, both in one envelope shape, both signed the same way.
 *
 * Envelope (kit.webhook-event.v1):
 *   { schema, id, type, occurred_at, source, data, upstream, caused_by }
 *   - a normalised event: `data` is the project's own model; `upstream` (optional) names the provider event it came from
 *     ({ provider, event_type, event_id }), without the raw payload;
 *   - a relayed event: `type` is "upstream.<provider>.<event_type>", `data` is null and `upstream` carries the provider's
 *     payload exactly as received, with `verified` (did its own signature check pass) and `received_at`.
 *
 * Signature (sent with every delivery; Standard-Webhooks-style, plus a key id for rotation):
 *   webhook-id: <envelope id>        webhook-timestamp: <unix seconds>
 *   webhook-signature: v1,<key id>,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">   (space-separated, one per active key)
 * Rotation: sign with every active key (the new one and the old one while receivers move over); a receiver accepts a
 * delivery when any signature verifies with a key it knows by id. Replay: the timestamp must be within the tolerance
 * (default 300 s) and a receiver may reject an id it has seen (`seen`).
 *
 * WebCrypto only (Workers and Node ≥ 20). No project names: header names and the event source come from the caller.
 */
import { safeFetch, assertSafeUrl, SafeFetchError } from "@saasreport/core/safe-fetch";

export const WEBHOOK_SCHEMA = "kit.webhook-event.v1";
export const DEFAULT_HEADERS = { id: "webhook-id", timestamp: "webhook-timestamp", signature: "webhook-signature" };
export const DEFAULT_TOLERANCE_S = 300;
const KID = /^[A-Za-z0-9._-]{1,64}$/;
const enc = new TextEncoder();

const b64 = (buf) => { let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s) => { try { const bin = atob(s); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); } catch { return null; /* not base64: no bytes (null), so the signature check fails */ } };

/** HMAC-SHA256 of a string with a secret (a string, or "base64:<…>" / "whsec_<base64>" for random bytes) → raw bytes. */
async function hmac(secret, message) {
  const raw = typeof secret === "string" && /^(base64:|whsec_)/.test(secret) ? unb64(secret.replace(/^(base64:|whsec_)/, "")) : enc.encode(String(secret));
  if (!raw || !raw.length) throw new Error("webhook secret is empty or not valid base64");
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, enc.encode(message));
}

/** Constant-time comparison of two byte arrays. */
function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** Normalise keys: [{ id, secret }] | { [id]: secret } → [{ id, secret }] (ids checked). */
export function normaliseKeys(keys) {
  const list = Array.isArray(keys) ? keys : Object.entries(keys || {}).map(([id, secret]) => ({ id, secret }));
  for (const k of list) {
    if (!KID.test(String(k.id || ""))) throw new Error(`webhook key id "${k.id}" must be 1-64 characters of A-Z a-z 0-9 . _ -`);
    if (!k.secret) throw new Error(`webhook key "${k.id}" has no secret`);
  }
  return list;
}

/**
 * Sign a body → the headers to send. keys: the active signing keys ([{ id, secret }], newest first); id: the envelope id;
 * timestamp: unix seconds (default now).
 */
export async function signWebhook({ body, id, keys, timestamp = Math.floor(Date.now() / 1000), headers: names = DEFAULT_HEADERS }) {
  const list = normaliseKeys(keys).filter((k) => k.active !== false);
  if (!list.length) throw new Error("signWebhook: no active key");
  if (!id) throw new Error("signWebhook: id is required");
  const ts = String(Math.floor(Number(timestamp)));
  const payload = `${id}.${ts}.${typeof body === "string" ? body : JSON.stringify(body)}`;
  const sigs = await Promise.all(list.map(async (k) => `v1,${k.id},${b64(await hmac(k.secret, payload))}`));
  return { [names.id]: String(id), [names.timestamp]: ts, [names.signature]: sigs.join(" ") };
}

/** Parse a signature header → [{ version, kid, sig }]. */
export function parseSignatures(header) {
  return String(header || "").trim().split(/\s+/).filter(Boolean).map((part) => {
    const [version, kid, sig] = part.split(",");
    return { version, kid, sig };
  }).filter((x) => x.version && x.kid && x.sig);
}

const header = (h, name) => (typeof h?.get === "function" ? h.get(name) : h?.[name] ?? h?.[name.toLowerCase()]);

/**
 * Verify a delivery: { headers (Headers or a plain object), body (the raw string) } against the receiver's keys
 * ({ [kid]: secret } or [{ id, secret }]). → { ok: true, id, timestamp, keyId } | { ok: false, reason }.
 * reasons: missing_headers, bad_timestamp, too_old, too_new, unknown_key, bad_signature, replayed.
 * `seen(id)` (optional, may be async) returns true for an id already processed (the replay store's job).
 */
export async function verifyWebhook({ headers, body }, { keys, tolerance = DEFAULT_TOLERANCE_S, now = Date.now(), seen, headers: names = DEFAULT_HEADERS } = {}) {
  const id = header(headers, names.id), ts = header(headers, names.timestamp), sh = header(headers, names.signature);
  if (!id || !ts || !sh) return { ok: false, reason: "missing_headers" };
  if (!/^\d{1,12}$/.test(String(ts))) return { ok: false, reason: "bad_timestamp" };
  const age = Math.floor(now / 1000) - Number(ts);
  if (age > tolerance) return { ok: false, reason: "too_old" };
  if (age < -tolerance) return { ok: false, reason: "too_new" };
  const known = new Map(normaliseKeys(keys).map((k) => [k.id, k.secret]));
  const sigs = parseSignatures(sh).filter((s) => s.version === "v1");
  const usable = sigs.filter((s) => known.has(s.kid));
  if (!usable.length) return { ok: false, reason: "unknown_key" };
  const payload = `${id}.${ts}.${typeof body === "string" ? body : JSON.stringify(body)}`;
  let keyId = null;
  for (const s of usable) {
    const want = new Uint8Array(await hmac(known.get(s.kid), payload));
    if (sameBytes(want, unb64(s.sig))) { keyId = s.kid; break; }
  }
  if (!keyId) return { ok: false, reason: "bad_signature" };
  if (seen && (await seen(id))) return { ok: false, reason: "replayed" };
  return { ok: true, id, timestamp: Number(ts), keyId };
}

const newId = (prefix = "evt") => `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;

/** A normalised event: the project's own model in `data`; `upstream` names the provider event it came from (no payload). */
export function webhookEvent({ type, source, data = null, id = newId(), occurredAt = new Date().toISOString(), upstream = null, causedBy = null, subject } = {}) {
  if (!type || !/^[a-z0-9][a-z0-9._-]*$/i.test(type)) throw new Error(`webhook event type "${type}" must be dotted words`);
  if (!source) throw new Error("webhook event: source is required (the emitting system, e.g. the site URL)");
  return {
    schema: WEBHOOK_SCHEMA, id, type, occurred_at: occurredAt, source, ...(subject ? { subject } : {}), data,
    upstream: upstream ? { provider: upstream.provider, event_type: upstream.event_type ?? upstream.eventType, event_id: upstream.event_id ?? upstream.eventId ?? null } : null,
    caused_by: causedBy,
  };
}

/**
 * Two layers from one upstream delivery: [relayed, normalised].
 *   upstream: { provider, eventType, eventId?, payload, verified, receivedAt? }   normalise(payload, upstream) → { type, data, subject? } | null
 * The relayed event carries the provider payload exactly as received; the normalised one carries the project's model and
 * points back at the relayed event (caused_by). normalise returning null means "nothing to normalise": only the relay.
 */
export function twoLayerEvents(upstream, { source, normalise, now = new Date().toISOString() } = {}) {
  const { provider, eventType, eventId = null, payload, verified = false, receivedAt = now } = upstream || {};
  if (!provider || !eventType) throw new Error("twoLayerEvents: upstream.provider and upstream.eventType are required");
  const relayed = {
    schema: WEBHOOK_SCHEMA, id: newId(), type: `upstream.${provider}.${eventType}`, occurred_at: receivedAt, source, data: null,
    upstream: { provider, event_type: eventType, event_id: eventId, received_at: receivedAt, verified: Boolean(verified), payload: payload ?? null },
    caused_by: null,
  };
  const n = normalise ? normalise(payload, upstream) : null;
  if (!n) return [relayed];
  return [relayed, webhookEvent({ type: n.type, source, data: n.data ?? null, subject: n.subject, occurredAt: now, upstream: { provider, event_type: eventType, event_id: eventId }, causedBy: relayed.id })];
}

/** Retry delay after a failed attempt (1-based): exponential from `base` ms, capped, with full jitter when `jitter`. */
export function backoffDelay(attempt, { base = 30_000, cap = 6 * 3600_000, jitter = false, random = Math.random } = {}) {
  const d = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return jitter ? Math.floor(random() * d) : d;
}

/** Is an HTTP status worth retrying? Network errors (status 0), 408, 409, 425, 429 and 5xx are; other 4xx are not. */
export const retryable = (status) => status === 0 || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;

/**
 * One signed delivery of an envelope to a subscriber { id, url, keys, headers? }. → { ok, status, retryable, error? }.
 * Never throws for HTTP or network failures (the caller decides to retry); throws for a bad subscriber.
 */
export async function deliverWebhook(event, sub, { fetch: f, resolve, now = Date.now(), timeoutMs = 15_000, userAgent = "kit-webhooks/1", allowHosts = null } = {}) {
  try { assertSafeUrl(sub.url, { allowHosts }); } catch (e) { throw new Error(`subscriber ${sub.id}: ${e instanceof SafeFetchError ? `${e.message} (https, a public host and port 443 are required)` : "url is not a URL"}`); }
  const body = JSON.stringify(event);
  const sig = await signWebhook({ body, id: event.id, keys: sub.keys, timestamp: Math.floor(now / 1000), headers: sub.headerNames || DEFAULT_HEADERS });
  let res;
  try {
    // safeFetch: the subscriber URL is a remote party's choice. Public addresses only (checked again on resolution), no redirects
    // followed (a 3xx is a failure), the response body is never read.
    res = await safeFetch(sub.url, { method: "POST", body, headers: { "content-type": "application/json", "user-agent": userAgent, ...(sub.headers || {}), ...sig } },
      { ...(f ? { fetch: f } : {}), ...(resolve ? { resolve } : {}), timeoutMs, discardBody: true, followRedirects: false, allowHosts });
  } catch (e) {
    const refused = e instanceof SafeFetchError && !["timeout", "dns_failed"].includes(e.code);   // an address we refuse will not become fine by retrying
    return { ok: false, status: 0, retryable: !refused, error: String(e?.message || e).slice(0, 300) };
  }
  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, retryable: false };
  return { ok: false, status: res.status, retryable: retryable(res.status), error: `HTTP ${res.status}` };
}
