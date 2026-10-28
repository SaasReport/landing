// Small HTTP helpers shared by the routes: JSON answers, the error shape of the contract (components.schemas.Error), the same-origin check
// of every mutation, cursors and the page size.
import { config } from "./config.js";

export const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...headers } });
export const fail = (status, error, detail, headers = {}) => json({ ok: false, error, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) }, status, headers);
/** 503 with no detail at all: the answer to every request while the configuration is missing or invalid. */
export const unavailable = () => fail(503, "unavailable");

/**
 * The CSRF guard of a mutation (Access authenticates, this keeps another site from riding the browser's Access session). A browser that
 * sends Origin must send ours; one that sends only Sec-Fetch-Site must say same-origin; a client that sends neither is not a browser
 * (a cross-site request from a browser always carries one of the two). The body must be application/json, which a cross-site page cannot
 * send without a preflight the Worker never answers. The Worker sets no CORS header and no cookie.
 */
export function originProblem(request) {
  const origin = request.headers.get("origin");
  const mine = new URL(request.url).origin;
  if (origin !== null) return origin === mine ? null : "origin_mismatch";
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return "cross_site";
  return null;
}
export const isJson = (request) => /^application\/json(\s*;|$)/i.test(request.headers.get("content-type") || "");

export const b64uEncode = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function b64uDecodeText(s) {
  const bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(s).length / 4) * 4, "="));
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
/** An opaque cursor: base64url of a small JSON object. Anything that does not decode to an object of strings is null (a 400 for the caller). */
export const encodeCursor = (o) => b64uEncode(JSON.stringify(o));
export function decodeCursor(s) {
  if (s == null || s === "") return undefined;
  try {
    const o = JSON.parse(b64uDecodeText(s));
    return o && typeof o === "object" && !Array.isArray(o) && Object.values(o).every((v) => typeof v === "string" || typeof v === "number") ? o : null;
  } catch { /* not base64url JSON: the cursor is refused as a 400 by the caller (null) */ return null; }
}

/** The page size from ?limit=: an integer in 1..pageMax (default pageDefault), or null when it is not. */
export function pageSize(url) {
  const raw = url.searchParams.get("limit");
  if (raw === null) return config.limits.pageDefault;
  if (!/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= config.limits.pageMax ? n : null;
}
export const isoNow = () => new Date().toISOString();

/** SHA-256 of a string as lowercase hex (Web Crypto: the Worker's own, no dependency). */
export async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const isMissingTable = (e) => /no such table|no such column/i.test(String(e?.message || e));
