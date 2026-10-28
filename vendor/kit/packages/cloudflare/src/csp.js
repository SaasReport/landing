/**
 * Content-Security-Policy as data, with a fresh nonce on every HTML response.
 *
 *   import { defineCsp, withCsp, readCspReports } from "@saasreport/cloudflare/csp";
 *   import cspConfig from "./csp.json" with { type: "json" };     // validated against schema/csp.schema.json
 *   const csp = defineCsp(cspConfig);                              // throws on an invalid policy file
 *   return withCsp(await env.ASSETS.fetch(request), csp, "site");  // HTML: nonce on every <script>, one CSP header
 *
 * The policy file is the one place a project declares its CSP (schema: urn:kit:schema:csp:v1). For every HTML response
 * withCsp() draws a 128-bit nonce, puts 'nonce-…' into the directives the policy lists under `nonce`, sets it on every
 * <script> element (HTMLRewriter in Workers; a string rewrite elsewhere), replaces any CSP header the response already
 * had (two policies would both apply) and drops ETag/Last-Modified so a browser never pairs a cached body with a new
 * nonce. Edge features that inject scripts into HTML (for example Cloudflare's JavaScript detections) read the nonce
 * from the header and reuse it, so they run without 'unsafe-inline'.
 */
import SCHEMA from "../schema/csp.schema.json" with { type: "json" };
import { readBoundedText } from "@saasreport/uploads/bounded";

export const CSP_SCHEMA = SCHEMA;

/* ---------- schema validation (the JSON Schema subset csp.schema.json uses) ---------- */

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const typeOk = (v, t) => (t === "array" ? Array.isArray(v) : t === "object" ? isObj(v) : t === "integer" ? Number.isInteger(v) : typeof v === t);

function check(value, schema, path, root, out) {
  if (schema.$ref) return check(value, schema.$ref.slice(2).split("/").reduce((s, k) => s[k], root), path, root, out);
  const err = (message) => out.push({ path: path || "/", message });
  if (schema.type && !typeOk(value, schema.type)) return err(`must be ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value)) err(`must be one of ${schema.enum.join(", ")}`);
  if ("const" in schema && value !== schema.const) err(`must be ${JSON.stringify(schema.const)}`);
  if (schema.not) { const inner = []; check(value, schema.not, path, root, inner); if (!inner.length) err(`${JSON.stringify(value)} is not allowed here`); }
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern, "u").test(value)) err(`${JSON.stringify(value)} does not match ${schema.pattern}`);
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) err(`needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems != null && value.length > schema.maxItems) err(`allows at most ${schema.maxItems} item(s)`);
    if (schema.uniqueItems && new Set(value.map((x) => JSON.stringify(x))).size !== value.length) err("has duplicate items");
    if (schema.items) value.forEach((x, i) => check(x, schema.items, `${path}/${i}`, root, out));
  }
  if (isObj(value)) {
    const keys = Object.keys(value);
    for (const k of schema.required || []) if (!(k in value)) err(`missing "${k}"`);
    if (schema.minProperties != null && keys.length < schema.minProperties) err(`needs at least ${schema.minProperties} entr(ies)`);
    for (const k of keys) {
      const p = `${path}/${k}`;
      if (schema.propertyNames) check(k, schema.propertyNames, p, root, out);
      if (schema.properties && k in schema.properties) check(value[k], schema.properties[k], p, root, out);
      else if (schema.additionalProperties === false) out.push({ path: p, message: "is not a known property" });
      else if (isObj(schema.additionalProperties)) check(value[k], schema.additionalProperties, p, root, out);
    }
  }
}

/** Problems with a CSP configuration, [] when it is valid: [{ path: "/policies/site/directives/script-src/1", message }]. */
export function validateCsp(config) {
  const out = [];
  check(config, SCHEMA, "", SCHEMA, out);
  return out;
}

/** The validated configuration (frozen), or an Error that lists every problem. */
export function defineCsp(config) {
  const problems = validateCsp(config);
  if (problems.length) throw new Error(`invalid CSP configuration:\n${problems.map((p) => `  ${p.path}: ${p.message}`).join("\n")}`);
  return Object.freeze(structuredClone(config));
}

/* ---------- header ---------- */

/** A 128-bit nonce, base64 (RFC 4648), new for every call. */
export function createNonce() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b));
}

/** The header value for one policy: its directives in file order, 'nonce-…' added where the policy asks for it, and the
 *  report-uri / report-to pair when the configuration names a report endpoint. */
export function cspHeader(config, name, { nonce } = {}) {
  const policy = config.policies[name];
  if (!policy) throw new Error(`no CSP policy "${name}"`);
  const withNonce = new Set(nonce ? policy.nonce || [] : []);
  const parts = Object.entries(policy.directives).map(([d, sources]) => [d, ...sources, ...(withNonce.has(d) ? [`'nonce-${nonce}'`] : [])].join(" "));
  if (config.report) parts.push(`report-uri ${config.report.path}`, `report-to ${config.report.group}`);
  return parts.join("; ");
}

/* ---------- responses ---------- */

const isHtml = (res) => /^text\/html\b/i.test(res.headers.get("content-type") || "");

/** Sets nonce="…" on every <script> start tag of an HTML string (scripts that already carry one keep theirs). */
export function addNonce(html, nonce) {
  return html.replace(/<script\b([^>]*)>/gi, (tag, attrs) => (/\snonce\s*=/i.test(attrs) ? tag : `<script nonce="${nonce}"${attrs}>`));
}

/**
 * The response with this policy applied. HTML gets a fresh nonce on every <script> and in the header; other responses
 * only get the header (no nonce), so a stray SVG or error body is covered by the same rules.
 * @param {Response} res
 * @param {object} config        defineCsp() result
 * @param {string} name          policy name, e.g. "site"
 * @param {{ nonce?: string, reportOnly?: boolean }} [opts]
 */
export function withCsp(res, config, name, { nonce, reportOnly = false } = {}) {
  const html = isHtml(res) && res.body != null && res.status !== 304;
  const n = html ? nonce || createNonce() : undefined;
  const headers = new Headers(res.headers);
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.set(reportOnly ? "content-security-policy-report-only" : "content-security-policy", cspHeader(config, name, { nonce: n }));
  if (config.report) headers.set("reporting-endpoints", `${config.report.group}="${config.report.path}"`);
  if (!html) return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  headers.delete("etag");
  headers.delete("last-modified");
  headers.delete("content-length");
  const init = { status: res.status, statusText: res.statusText, headers };
  if (typeof HTMLRewriter === "function") {
    return new HTMLRewriter().on("script", { element: (el) => { if (!el.hasAttribute("nonce")) el.setAttribute("nonce", n); } }).transform(new Response(res.body, init));
  }
  return new Response(streamText(res, n), init);
}

function streamText(res, nonce) {
  const enc = new TextEncoder();
  return new ReadableStream({ async start(c) { c.enqueue(enc.encode(addNonce(await res.text(), nonce))); c.close(); } });
}

/** The nonce a response was given (read back from its CSP header), or null. */
export function nonceOf(res) {
  const m = /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(res.headers.get("content-security-policy") || res.headers.get("content-security-policy-report-only") || "");
  return m ? m[1] : null;
}

/* ---------- reports ---------- */

const clip = (v, n = 300) => (v == null ? null : String(v).slice(0, n));

/**
 * The violations in a report request, normalised: both the legacy `application/csp-report` body (report-uri) and the
 * Reporting API's `application/reports+json` array (report-to). Bodies over maxBytes and anything that is not a CSP
 * report are ignored; at most `max` reports are returned. Never throws.
 * @returns {Promise<Array<{ documentURL, blockedURL, directive, disposition, sourceFile, line, column, sample, statusCode }>>}
 */
export async function readCspReports(request, { maxBytes = 16384, max = 20 } = {}) {
  if (request.method !== "POST") return [];
  let text;
  try { ({ text } = await readBoundedText(request, { maxBytes })); } catch { return []; }   // over the cap, no or lying Content-Length: ignored, never buffered
  if (!text) return [];
  let body;
  try { body = JSON.parse(text); } catch { return []; /* a report body that is not JSON carries no reports */ }
  const raw = Array.isArray(body) ? body.filter((r) => r && r.type === "csp-violation").map((r) => ({ ...r.body, url: r.url })) : body && body["csp-report"] ? [body["csp-report"]] : [];
  return raw.slice(0, max).map((r) => ({
    documentURL: clip(r.documentURL ?? r["document-uri"] ?? r.url),
    blockedURL: clip(r.blockedURL ?? r["blocked-uri"]),
    directive: clip(r.effectiveDirective ?? r["effective-directive"] ?? r["violated-directive"], 60),
    disposition: clip(r.disposition ?? "enforce", 20),
    sourceFile: clip(r.sourceFile ?? r["source-file"]),
    line: Number(r.lineNumber ?? r["line-number"]) || null,
    column: Number(r.columnNumber ?? r["column-number"]) || null,
    sample: clip(r.sample ?? r["script-sample"], 120),
    statusCode: Number(r.statusCode ?? r["status-code"]) || null,
  }));
}
