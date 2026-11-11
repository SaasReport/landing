/**
 * Safe serving (the contract is kit.upload-serve.v1, packages/core/schemas/upload-serve.schema.json; the tests validate every response against it).
 * A released file is only ever served with the content type of its SNIFFED kind (application/octet-stream for anything that could run in a
 * browser: HTML, SVG, XML, script) and X-Content-Type-Options: nosniff, plus a no-cache, same-site resource policy. It is an attachment (with a
 * sandboxing CSP) unless the form's policy declares the kind inline-safe (policy.serve.inline_types, raster images only): then it is inline under
 * the restrictive image CSP. Serve it from a separate cookieless origin (policy.serve.origin) through a short-lived signed URL
 * bound to the upload id and, when given, the subject, so a link never works for another person or another file.
 *
 * A consumer that serves released objects WITHOUT downloadResponse (its own Worker route) must set exactly serveHeaders(...)'s headers.
 *
 *   serveHeaders({ filename, type, size, inline? }) → Headers          inline is honoured only for INLINE_TYPES; anything else is an attachment
 *   signDownload({ secret, uploadId, subject?, ttlSeconds, now }) → token       verifyDownload({ secret, token, now }) → { ok, uploadId, subject } | { ok: false, reason }
 *   downloadResponse({ record, bucket, policy? }) → Response          policy: the form's UploadPolicy (uploads.policy(record.form)); without it every download is an attachment.
 *     The body must match the record (size and sha256, both required; the size is checked before the read and capped by policy.max_bytes) or the response is a 500; inline needs a clean, complete triage (inlineAllowed).
 */
import { toHex, sha256Hex } from "./bytes.js";
import { tick } from "./work.js";

const INERT_LIST = Object.freeze(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "application/json", "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"]);
const INERT = new Set(INERT_LIST);
/** The content types served as they are sniffed; everything else is application/octet-stream. The serve schema's content-type enum is this list plus application/octet-stream (a test keeps the two equal). */
export const INERT_TYPES = INERT_LIST;

export const SERVE_CSP = "sandbox; default-src 'none'; frame-ancestors 'none'";
/** The CSP of an inline image: nothing loads, nothing runs, no styles, sandboxed. */
export const INLINE_IMAGE_CSP = "default-src 'none'; img-src 'self'; style-src 'none'; sandbox";
/** The kinds a policy may declare inline-safe (the schema's enum): raster images, never SVG. */
export const INLINE_TYPES = Object.freeze(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** An RFC 6266 attachment header value: an ASCII fallback and the UTF-8 name (filename*), both free of quotes and separators. */
export function contentDisposition(filename) {
  let name = "", ascii = "", utf8 = "";
  const text = String(filename || "download");
  tick(2 * text.length);   // the character loop and the percent-encoding pass
  for (const ch of text) {
    const c = ch.codePointAt(0);
    const bad = c <= 0x1f || c === 0x7f || c === 34 || c === 92 || c === 47;
    const kept = bad ? "_" : ch;
    name += kept;
    ascii += c >= 0x20 && c <= 0x7e && !bad && c !== 37 ? ch : "_";
  }
  for (const ch of encodeURIComponent(name)) utf8 += ch === "'" || ch === "(" || ch === ")" || ch === "*" ? `%${ch.charCodeAt(0).toString(16).toUpperCase()}` : ch;
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export function serveHeaders({ filename, type, size, inline = false }) {
  const h = new Headers();
  const asImage = inline === true && INLINE_TYPES.includes(type);
  h.set("content-type", INERT.has(type) ? type : "application/octet-stream");
  h.set("content-disposition", asImage ? "inline" : contentDisposition(filename));
  h.set("x-content-type-options", "nosniff");
  h.set("content-security-policy", asImage ? INLINE_IMAGE_CSP : SERVE_CSP);
  h.set("cache-control", "private, no-store");
  h.set("cross-origin-resource-policy", "same-site");
  h.set("referrer-policy", "no-referrer");
  if (Number.isInteger(size)) h.set("content-length", String(size));
  return h;
}

/* ---------- signed download tokens: base64url(payload) . base64url(HMAC-SHA-256) ---------- */
const enc = new TextEncoder();
const b64u = (bytes) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); let t = btoa(s).replaceAll("+", "-").replaceAll("/", "_"); let end = t.length; while (end > 0 && t[end - 1] === "=") end--; return t.slice(0, end); };
const unb64u = (s) => { const t = s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4); const r = atob(t); return Uint8Array.from(r, (c) => c.charCodeAt(0)); };
const hmacKey = (secret, usage) => crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);

export async function signDownload({ secret, uploadId, subject = null, ttlSeconds = 300, now = () => new Date() }) {
  if (!secret || String(secret).length < 16) throw new Error("signDownload: secret must be at least 16 characters");
  const payload = b64u(enc.encode(JSON.stringify({ u: uploadId, s: subject, e: Math.floor(now().getTime() / 1000) + ttlSeconds })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), enc.encode(payload)));
  return `${payload}.${b64u(sig)}`;
}

export async function verifyDownload({ secret, token, subject = null, now = () => new Date() }) {
  const [payload, sig, extra] = String(token || "").split(".");
  if (!payload || !sig || extra !== undefined) return { ok: false, reason: "malformed" };
  let ok = false;
  try { ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), unb64u(sig), enc.encode(payload)); } catch { return { ok: false, reason: "malformed" }; /* a key or signature that cannot be read is a malformed token, refused */ }
  if (!ok) return { ok: false, reason: "bad_signature" };
  let p; try { p = JSON.parse(new TextDecoder().decode(unb64u(payload))); } catch { return { ok: false, reason: "malformed" }; /* a payload that is not JSON is a malformed token, refused */ }
  if (!(p.e > Math.floor(now().getTime() / 1000))) return { ok: false, reason: "expired" };
  if ((p.s ?? null) !== (subject ?? null)) return { ok: false, reason: "wrong_subject" };
  return { ok: true, uploadId: p.u, subject: p.s ?? null };
}

/** The download Response for a released record, or a 404 (a file that is not released does not exist for the outside). */
export async function downloadResponse({ record, bucket, policy = null }) {
  // the stage is the authority (only intake and a person's release() reach "released"); a record with an operation in flight serves nothing
  const releasedAndServable = record && record.stage === "released" && !record.op && record.storage.released_key;
  if (!releasedAndServable) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  const obj = await bucket.get(record.storage.released_key);
  if (!obj) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  // the body is checked against the record before a byte is served (as release() does through loadVerified). A record from intake always carries size and
  // sha256, so a record without either is not served. The object's own size is compared (and capped by the policy's max_bytes) BEFORE the body is read.
  const refuse = () => new Response("integrity check failed", { status: 500, headers: { "cache-control": "no-store" } });
  if (!Number.isInteger(record.size_bytes) || typeof record.sha256 !== "string" || !record.sha256) return refuse();
  if (obj.size !== record.size_bytes || (Number.isInteger(policy?.max_bytes) && record.size_bytes > policy.max_bytes)) return refuse();
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if (bytes.length !== record.size_bytes || (await sha256Hex(bytes)) !== record.sha256) return refuse();
  return new Response(bytes, { status: 200, headers: serveHeaders({ filename: record.declared.filename_normalised || "download", type: record.sniffed.type, size: record.size_bytes, inline: inlineAllowed(record, policy) }) });
}

/**
 * Inline only when the policy declares the kind inline-safe AND the record's triage is complete and found nothing at all: any marker (metadata_present
 * EXIF or text chunks, huge_dimensions, trailing_data, malformed...) means the image needs a re-encode before it is shown inline, and a record with no
 * triage block says nothing, so it is an attachment.
 */
export function inlineAllowed(record, policy) {
  if (!policy?.serve?.inline_types?.includes(record.sniffed?.type)) return false;
  const t = record.triage;
  return Boolean(t && t.complete === true && Array.isArray(t.markers) && t.markers.length === 0);
}

export { toHex };
