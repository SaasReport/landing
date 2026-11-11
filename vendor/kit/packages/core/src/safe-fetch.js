/**
 * safeFetch: the one way kit code fetches a URL that a customer, a tenant or a remote party chose (a webhook endpoint, a
 * connector manifest, an ingest URL). https only, no credentials in the URL, port 443 unless allowed, no private, loopback,
 * link-local, metadata, CGNAT, multicast or reserved address (IPv4 in every spelling, IPv6 including IPv4-mapped, NAT64 and 6to4),
 * no internal host names, hostnames resolved and every answer checked, redirects followed by hand with the full check on every
 * hop and a cap, a total time limit, a response size cap enforced while streaming, and a content-type allowlist.
 *
 *   safeFetch(url, init?, { fetch, resolve, maxRedirects = 3, timeoutMs = 10000, maxBytes = 1048576,
 *                           allowedContentTypes, discardBody, followRedirects = true, ports = [443], allowHosts }) → Response (capped body)
 *   assertSafeUrl(url, { ports, allowHosts }) → URL        sync: scheme, credentials, port, literal and internal names (registration time)
 *   classifyIp(text) → null | string                        why an IP is not public, or null when it is
 *   dohResolver({ endpoint, fetch }) → async (host) => [ip] resolver over DNS-over-HTTPS (application/dns-json)
 *
 * Limits, stated plainly. Workers cannot pin the address a connection uses, so the DNS answer checked here and the one fetch()
 * connects to are two lookups: a rebinding attacker with a short TTL can still win that race. What this closes: literal and
 * encoded internal addresses, names that resolve to internal addresses at check time, redirects into either, and unbounded
 * responses. Where the receiver set is known in advance, pass `allowHosts` (exact names or ".suffix"): that removes the race.
 * Whether Workers fetch() can reach private ranges at all is a platform property this code does not assume.
 */

export class SafeFetchError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.name = "SafeFetchError"; this.code = code; }
}

export const DEFAULT_DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

/* ---------- addresses ---------- */
function parseV4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}
const V4_BLOCKS = [
  [[0, 0, 0, 0], 8, "this-network"], [[10, 0, 0, 0], 8, "private"], [[100, 64, 0, 0], 10, "carrier-grade NAT"], [[127, 0, 0, 0], 8, "loopback"], [[169, 254, 0, 0], 16, "link-local / metadata"],
  [[172, 16, 0, 0], 12, "private"], [[192, 0, 0, 0], 24, "IETF protocol"], [[192, 0, 2, 0], 24, "documentation"], [[192, 88, 99, 0], 24, "6to4 relay"], [[192, 168, 0, 0], 16, "private"],
  [[198, 18, 0, 0], 15, "benchmarking"], [[198, 51, 100, 0], 24, "documentation"], [[203, 0, 113, 0], 24, "documentation"], [[224, 0, 0, 0], 4, "multicast"], [[240, 0, 0, 0], 4, "reserved / broadcast"],
];
const v4int = (o) => ((o[0] * 256 + o[1]) * 256 + o[2]) * 256 + o[3];
function classifyV4(o) {
  const n = v4int(o);
  for (const [base, bits, why] of V4_BLOCKS) { const size = 2 ** (32 - bits); const b = v4int(base); if (n >= b && n < b + size) return why; }
  return null;
}
/** An IPv6 literal (no brackets) → 8 groups, or null. Handles "::", and a trailing dotted IPv4. */
function parseV6(s) {
  s = s.toLowerCase();
  if (s.includes("%") || !/^[0-9a-f:.]+$/.test(s)) return null;
  let tail = [];
  const dot = s.lastIndexOf(":");
  if (s.includes(".")) { const v4 = parseV4(s.slice(dot + 1)); if (!v4) return null; tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]]; s = s.slice(0, dot + 1) + "0:0"; }
  const parts = s.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const rest = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  if (parts.length === 1 && head.length !== 8) return null;
  const fill = parts.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (parts.length === 2 && fill < 1)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...rest].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  if (groups.length !== 8 || groups.some(Number.isNaN)) return null;
  if (tail.length) { groups[6] = tail[0]; groups[7] = tail[1]; }
  return groups;
}
const embeddedV4 = (g, i) => [g[i] >> 8, g[i] & 255, g[i + 1] >> 8, g[i + 1] & 255];

function classifyV6(g) {
  const all0 = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (all0(0, 8)) return "unspecified";
  if (all0(0, 7) && g[7] === 1) return "loopback";
  if (all0(0, 5) && g[5] === 0xffff) return `IPv4-mapped ${classifyV4(embeddedV4(g, 6)) || "address (use the IPv4 form)"}`;
  if (all0(0, 4) && g[4] === 0xffff && g[5] === 0) return `IPv4-translated ${classifyV4(embeddedV4(g, 6)) || "address (use the IPv4 form)"}`;   // ::ffff:0:a.b.c.d (RFC 2765), not the mapped ::ffff:a.b.c.d
  if (all0(0, 6)) return "IPv4-compatible address";
  if (g[0] === 0x64 && g[1] === 0xff9b && all0(2, 6)) return `NAT64 ${classifyV4(embeddedV4(g, 6)) || "address (use the IPv4 form)"}`;
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return "local-use NAT64 (64:ff9b:1::/48)";
  if (g[0] === 0x2002) return "6to4";
  if (g[0] === 0x2001 && g[1] === 0) return "Teredo";
  if (g[0] === 0x2001 && g[1] === 0x0db8) return "documentation";
  if (g[0] === 0x0100 && all0(1, 4)) return "discard-only";
  if ((g[0] & 0xfe00) === 0xfc00) return "unique local";
  if ((g[0] & 0xffc0) === 0xfe80) return "link-local";
  if ((g[0] & 0xffc0) === 0xfec0) return "site-local";
  if ((g[0] & 0xff00) === 0xff00) return "multicast";
  return null;
}

/** Why a textual IP (v4 or v6, brackets allowed) is not a public unicast address; null when it is public; "not an IP" for other text. */
export function classifyIp(text) {
  const s = String(text).replace(/^\[|\]$/g, "");
  const v4 = parseV4(s);
  if (v4) return classifyV4(v4);
  const v6 = parseV6(s);
  if (v6) return classifyV6(v6);
  return "not an IP";
}

const INTERNAL_NAMES = [/^localhost$/, /\.localhost$/, /\.local$/, /\.internal$/, /\.localdomain$/, /\.lan$/, /\.intranet$/, /\.corp$/, /\.home$/, /\.home\.arpa$/, /\.in-addr\.arpa$/, /\.ip6\.arpa$/];
const METADATA_NAMES = new Set(["metadata", "metadata.google.internal", "instance-data", "instance-data.ec2.internal", "kubernetes.default", "kubernetes.default.svc"]);

/** Sync checks on a URL: https, no credentials, allowed port, no IP literal that is not public, no internal or single-label name. Returns the parsed URL. */
export function assertSafeUrl(input, { ports = [443], allowHosts = null } = {}) {
  const text = String(input);
  if (text.length > 2048) throw new SafeFetchError("bad_url", "longer than 2048 characters");
  if (/[\u0000- \u007f]/.test(text.trim())) throw new SafeFetchError("bad_url", "control or space characters");
  let u;
  try { u = new URL(text); } catch { throw new SafeFetchError("bad_url"); }
  if (u.protocol !== "https:") throw new SafeFetchError("scheme_not_https", u.protocol);
  if (u.username || u.password) throw new SafeFetchError("credentials_in_url");
  const port = u.port ? Number(u.port) : 443;
  if (!ports.includes(port)) throw new SafeFetchError("port_not_allowed", String(port));
  const host = u.hostname.replace(/\.$/, "").toLowerCase();
  if (!host) throw new SafeFetchError("bad_url", "no host");
  const ipLike = host.startsWith("[") || /^[0-9.]+$/.test(host);
  if (ipLike) {
    const why = classifyIp(host);
    if (why) throw new SafeFetchError("blocked_address", `${host}: ${why}`);
  } else {
    if (!host.includes(".")) throw new SafeFetchError("blocked_host", `${host}: single-label name`);
    if (METADATA_NAMES.has(host) || INTERNAL_NAMES.some((re) => re.test(host))) throw new SafeFetchError("blocked_host", host);
    if (/^[0-9a-fx.]+$/.test(host)) throw new SafeFetchError("blocked_host", `${host}: numeric host`);
  }
  if (allowHosts && !allowHosts.some((a) => (a.startsWith(".") ? host.endsWith(a) : host === a))) throw new SafeFetchError("host_not_allowed", host);
  return u;
}

/** A resolver over DNS-over-HTTPS (RFC 8484 JSON): A and AAAA answers as text IPs. */
export function dohResolver({ endpoint = DEFAULT_DOH_ENDPOINT, fetch: f = (...a) => globalThis.fetch(...a), timeoutMs = 3000 } = {}) {
  return async (host) => {
    const out = [];
    for (const type of ["A", "AAAA"]) {
      const res = await f(`${endpoint}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new SafeFetchError("dns_failed", `${type} ${res.status}`);
      const j = await res.json();
      for (const a of j.Answer || []) if ((a.type === 1 || a.type === 28) && typeof a.data === "string") out.push(a.data);
    }
    return out;
  };
}

/** assertSafeUrl plus resolution: every address the host resolves to must be public. `resolve` null checks literals only. */
export async function validateUrl(input, { resolve = dohResolver(), ...opts } = {}) {
  const u = assertSafeUrl(input, opts);
  const host = u.hostname.replace(/\.$/, "").toLowerCase();
  const literal = host.startsWith("[") || /^[0-9.]+$/.test(host);
  if (!literal && resolve) {
    let ips;
    try { ips = await resolve(host); } catch (e) { throw e instanceof SafeFetchError ? e : new SafeFetchError("dns_failed", String(e?.message || e).slice(0, 100)); }
    if (!ips?.length) throw new SafeFetchError("dns_failed", `${host}: no address`);
    for (const ip of ips) { const why = classifyIp(ip); if (why) throw new SafeFetchError("blocked_address", `${host} resolves to ${ip}: ${why}`); }
  }
  return u;
}

/**
 * What a request may carry to ANOTHER origin after a redirect: an allowlist, because credentials come in too many names
 * (authorization, cookie, x-api-key, proxy-authorization, x-auth-token, a vendor's own header) to list the ones to drop.
 */
export const CROSS_ORIGIN_HEADERS = Object.freeze(["accept", "accept-language", "accept-encoding", "user-agent", "content-type", "content-length", "if-none-match", "if-modified-since", "range"]);
function crossOriginHeaders(headers) {
  const out = new Headers();
  for (const name of CROSS_ORIGIN_HEADERS) { const v = headers.get(name); if (v !== null) out.set(name, v); }
  return out;
}

const typeAllowed = (ct, list) => { const base = String(ct || "").split(";")[0].trim().toLowerCase(); return list.some((a) => (a.endsWith("/*") ? base.startsWith(a.slice(0, -1)) : base === a.toLowerCase())); };

function capBody(body, maxBytes, onDone) {
  let n = 0;
  return body.pipeThrough(new TransformStream({
    transform(chunk, ctl) { n += chunk.byteLength; if (n > maxBytes) { ctl.error(new SafeFetchError("too_large", `more than ${maxBytes} bytes`)); return; } ctl.enqueue(chunk); },
    flush() { onDone?.(); },
  }));
}

export async function safeFetch(input, init = {}, opts = {}) {
  const { fetch: f = (...a) => globalThis.fetch(...a), resolve = dohResolver(), maxRedirects = 3, timeoutMs = 10_000, maxBytes = 1_048_576, allowedContentTypes = null, discardBody = false, followRedirects = true, ports = [443], allowHosts = null } = opts;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new SafeFetchError("timeout")), timeoutMs);
  if (init.signal) { if (init.signal.aborted) ctl.abort(init.signal.reason); else init.signal.addEventListener("abort", () => ctl.abort(init.signal.reason), { once: true }); }
  let streaming = false;
  try {
    let url = await validateUrl(input, { resolve, ports, allowHosts });
    let method = (init.method || "GET").toUpperCase(), body = init.body, headers = new Headers(init.headers || {});
    for (let hop = 0; ; hop++) {
      let res;
      try { res = await f(url.href, { ...init, method, body, headers, redirect: "manual", signal: ctl.signal }); }
      catch (e) { if (ctl.signal.aborted) throw ctl.signal.reason instanceof SafeFetchError ? ctl.signal.reason : new SafeFetchError("timeout"); throw e; }
      if (followRedirects && res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        try { await res.body?.cancel(); } catch { /* the stream is already closed or errored: nothing is left to release */ }
        if (hop >= maxRedirects) throw new SafeFetchError("too_many_redirects", `more than ${maxRedirects}`);
        let next;
        try { next = new URL(res.headers.get("location"), url); } catch { throw new SafeFetchError("redirect_invalid"); }
        next = await validateUrl(next.href, { resolve, ports, allowHosts });   // every hop gets the whole check
        if (next.origin !== url.origin) headers = crossOriginHeaders(headers);
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")) { method = "GET"; body = undefined; headers.delete("content-type"); headers.delete("content-length"); }
        else if (body && typeof body !== "string" && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer)) throw new SafeFetchError("redirect_invalid", "a streamed body cannot follow a redirect");
        url = next;
        continue;
      }
      if (discardBody) { try { await res.body?.cancel(); } catch { /* the stream is already closed or errored: nothing is left to release */ } return new Response(null, { status: res.status, headers: res.headers }); }
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && res.headers.has("content-length") && declared > maxBytes) { try { await res.body?.cancel(); } catch { /* the stream is already closed or errored: nothing is left to release */ } throw new SafeFetchError("too_large", `declared ${declared}`); }
      if (allowedContentTypes && !typeAllowed(res.headers.get("content-type"), allowedContentTypes)) { try { await res.body?.cancel(); } catch { /* the stream is already closed or errored: nothing is left to release */ } throw new SafeFetchError("content_type_not_allowed", String(res.headers.get("content-type"))); }
      streaming = Boolean(res.body);
      const out = new Response(res.body ? capBody(res.body, maxBytes, () => clearTimeout(timer)) : null, { status: res.status, statusText: res.statusText, headers: res.headers });
      return out;
    }
  } finally { if (!streaming) clearTimeout(timer); }
}

/** safeFetch and read the capped body as text / JSON. */
export async function safeFetchText(input, init, opts) { return (await safeFetch(input, init, { allowedContentTypes: ["text/*", "application/json"], ...opts })).text(); }
export async function safeFetchJson(input, init, opts) { return JSON.parse(await (await safeFetch(input, init, { allowedContentTypes: ["application/json", "application/*+json"], ...opts })).text()); }
