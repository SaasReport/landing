// Cloudflare Access verification, done again by the Worker on EVERY request (the edge has already checked; this does not trust it).
//   RS256 signature against the team's JWKS (https://<team domain>/cdn-cgi/access/certs), aud, iss, exp/nbf with a small skew, and the email
//   claim in an allowlist. The team domain, the AUD tag and the allowlist are Worker secrets read by the NAMES in admin.config.json.
//   Fail closed: any missing or invalid configuration, any JWKS failure, any claim that does not hold refuses the request.
//
//   const access = createAccess({ fetch, now });             // each has its own key cache (the Worker makes one per isolate)
//   const r = await access.verify(request, env);
//     r.ok            { ok: true, email, actorHash }
//     r.status        503 (configuration or key set unavailable: no detail), 401 (no token or a token that does not hold), 403 (not allowed)
import { config, text } from "./config.js";
import { sha256Hex } from "./http.js";

const A = config.access;
const TEAM = new RegExp(A.teamDomainPattern);
const MAX_TOKEN = 8192;
const MAX_JWKS_BYTES = 64 * 1024;

function b64uBytes(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const jsonPart = (s) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b64uBytes(s)));

/** The configuration or null: team domain (a Cloudflare Access host only), AUD tag, the lowercase allowlist. */
export function accessConfig(env) {
  const team = text(env, config.secrets.teamDomain).toLowerCase();
  const aud = text(env, config.secrets.aud);
  const allow = new Set(text(env, config.secrets.allowlist).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));
  if (!TEAM.test(team) || !aud || !allow.size) return null;
  return { team, aud, allow };
}

export function createAccess({ fetch: fetchFn = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  /** team -> { keys: Map(kid -> CryptoKey), at: ms of the last successful fetch, tried: ms of the last attempt } */
  const cache = new Map();

  async function fetchKeys(team) {
    const entry = cache.get(team) || { keys: new Map(), at: 0, tried: 0 };
    entry.tried = now();
    cache.set(team, entry);
    let body;
    try {
      const res = await fetchFn(`https://${team}/cdn-cgi/access/certs`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(config.limits.fetchTimeoutMs) });
      if (!res.ok) throw new Error(`jwks status ${res.status}`);
      const raw = await res.text();
      if (raw.length > MAX_JWKS_BYTES) throw new Error("jwks too large");
      body = JSON.parse(raw);
    } catch (e) { console.error("[admin] access: the key set could not be fetched", String(e?.message || e).slice(0, 120)); return false; }
    const keys = new Map();
    for (const k of Array.isArray(body?.keys) ? body.keys : []) {
      if (!k || k.kty !== "RSA" || typeof k.kid !== "string" || typeof k.n !== "string" || typeof k.e !== "string") continue;
      try { keys.set(k.kid, await crypto.subtle.importKey("jwk", { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"])); }
      catch { /* a key that does not import is not a key */ }
    }
    if (!keys.size) { console.error("[admin] access: the key set holds no usable key"); return false; }
    entry.keys = keys; entry.at = now();
    return true;
  }

  /** The verification key of `kid`, or { unavailable } when the key set cannot be had, or null when the kid is unknown even after one refetch. */
  async function keyFor(team, kid) {
    const ttl = A.jwksTtlSeconds * 1000, minGap = A.refetchMinIntervalSeconds * 1000;
    let entry = cache.get(team);
    if (!entry || now() - entry.at >= ttl) {                                   // no key set, or an expired one: fetch, and fail closed when it cannot be had
      if (!(await fetchKeys(team))) return { unavailable: true };
      entry = cache.get(team);
    }
    let key = entry.keys.get(kid);
    if (!key && now() - entry.tried >= minGap) {                               // a kid the cache does not know: ONE refetch (a rotation), not more often than the gap
      if (await fetchKeys(team)) key = cache.get(team).keys.get(kid);
    }
    return key || null;
  }

  async function verify(request, env) {
    const cfg = accessConfig(env);
    if (!cfg) return { ok: false, status: 503, reason: "not_configured" };
    const token = request.headers.get(A.header);
    if (!token || token.length > MAX_TOKEN) return { ok: false, status: 401, reason: "missing_token" };
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, status: 401, reason: "malformed" };
    let header, claims, signature;
    try { header = jsonPart(parts[0]); claims = jsonPart(parts[1]); signature = b64uBytes(parts[2]); } catch { /* a token that does not decode is simply not a token: refused as 401 below */ return { ok: false, status: 401, reason: "malformed" }; }
    if (!header || header.alg !== "RS256" || typeof header.kid !== "string" || !claims || typeof claims !== "object") return { ok: false, status: 401, reason: "algorithm" };
    const key = await keyFor(cfg.team, header.kid);
    if (key?.unavailable) return { ok: false, status: 503, reason: "keys_unavailable" };
    if (!key) return { ok: false, status: 401, reason: "unknown_key" };
    let good = false;
    try { good = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`)); } catch { /* a key or signature the platform rejects as malformed is a signature that does not hold */ good = false; }
    if (!good) return { ok: false, status: 401, reason: "signature" };
    const t = Math.floor(now() / 1000), skew = A.skewSeconds;
    if (claims.iss !== `https://${cfg.team}`) return { ok: false, status: 401, reason: "issuer" };
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(cfg.aud)) return { ok: false, status: 401, reason: "audience" };
    if (typeof claims.exp !== "number" || claims.exp + skew < t) return { ok: false, status: 401, reason: "expired" };
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - skew > t)) return { ok: false, status: 401, reason: "not_yet_valid" };
    if (claims.iat !== undefined && (typeof claims.iat !== "number" || claims.iat - skew > t)) return { ok: false, status: 401, reason: "not_yet_valid" };
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    const actorHash = email ? await sha256Hex(email) : null;
    if (!email || !cfg.allow.has(email)) return { ok: false, status: 403, reason: "not_allowed", actorHash };
    return { ok: true, email, actorHash };
  }
  return { verify };
}
