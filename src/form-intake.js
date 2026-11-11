// The intake of the landing's declared forms on Cloudflare Pages: POST /api/forms/<id> (contracts/forms.openapi.json).
// Interim store until the comms engine is deployed (docs/FORMS.md): one row per request in D1, no email is sent.
// Pure and Workers-safe: no Node API, the declaration (FORMS) and the database (env.FORMS_DB) are passed in.

export const MAX_BODY_BYTES = 16384;
export const MAX_PER_HOUR = 120;
export const TABLE = "landing_form_requests";
/** The one path of the contract (contracts/forms.openapi.json): a request to any other path is not this endpoint's. */
export const ROUTE = "/api/forms/{id}";

const DDL = [
  `CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, form_id TEXT NOT NULL, created_at TEXT NOT NULL, email TEXT NOT NULL, fields TEXT NOT NULL, consent INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ${TABLE}_created_at ON ${TABLE} (created_at)`,
];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": status < 400 ? "application/json; charset=utf-8" : "application/problem+json; charset=utf-8", "cache-control": "no-store", ...headers } });
const problem = (status, code, title, extra = {}, headers = {}) => json(status, { type: "about:blank", title, status, code, ...extra }, headers);

/** Reads at most `max` bytes of the body; null when the body is larger (never request.text() or json() before the cap). */
async function boundedText(request, max) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}

/** The submitted values as a Map of key -> string | string[] | boolean, or null when the body is not a flat object. */
function parseBody(text, type, form) {
  const out = new Map();
  if (type === "application/json") {
    let v;
    try { v = JSON.parse(text); } catch { return null; } // a body that is not JSON is answered 400 by the caller: null is that answer, not a lost error
    if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
    for (const k of Object.keys(v)) out.set(k, v[k]);
    return out;
  }
  const multiple = new Set(form.fields.filter((f) => f.multiple).map((f) => f.key));
  const p = new URLSearchParams(text);
  for (const k of new Set(p.keys())) out.set(k, multiple.has(k) ? p.getAll(k) : p.get(k));
  return out;
}

/** { values, errors }: the cleaned values of a declared form, or every field error ({ field, code }). */
export function validate(form, body) {
  const errors = [];
  const values = {};
  const declared = new Map(form.fields.map((f) => [f.key, f]));
  for (const k of body.keys()) if (k !== "consent" && !declared.has(k)) errors.push({ field: k, code: "unknown_field" });
  for (const f of form.fields) {
    const raw = body.get(f.key);
    if (f.multiple) {
      const list = raw === undefined || raw === null || raw === "" ? [] : Array.isArray(raw) ? raw : [raw];
      if (!list.every((x) => typeof x === "string")) { errors.push({ field: f.key, code: "invalid_type" }); continue; }
      if (new Set(list).size !== list.length) { errors.push({ field: f.key, code: "duplicate_option" }); continue; }
      if (f.options && !list.every((x) => f.options.includes(x))) { errors.push({ field: f.key, code: "unknown_option" }); continue; }
      if (f.required && !list.length) { errors.push({ field: f.key, code: "required" }); continue; }
      values[f.key] = list;
      continue;
    }
    if (raw !== undefined && raw !== null && typeof raw !== "string") { errors.push({ field: f.key, code: "invalid_type" }); continue; }
    const s = (raw ?? "").trim();
    if (!s) { if (f.required) errors.push({ field: f.key, code: "required" }); else values[f.key] = ""; continue; }
    if (f.max && s.length > f.max) { errors.push({ field: f.key, code: "too_long" }); continue; }
    if (f.key === "email" && !EMAIL.test(s)) { errors.push({ field: f.key, code: "invalid_email" }); continue; }
    values[f.key] = s;
  }
  const consent = body.get("consent");
  if (!(consent === true || consent === "on" || consent === "true")) errors.push({ field: "consent", code: "required" });
  return { values, errors };
}

/** SR-YYYYMMDD-XXXXXXXX: the reference a visitor is shown; the id is the row's key. */
export function reference(id, at) { return `SR-${at.slice(0, 10).replace(/-/g, "")}-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`; }

/**
 * Answers one request to /api/forms/<id>.
 * @param {Request} request
 * @param {{ FORMS_DB?: any }} env
 * @param {string} id the form id of the path
 * @param {Record<string, { fields: any[] }>} forms the declared forms (src/forms.js)
 * @param {{ now?: () => Date, uuid?: () => string }} [deps]
 */
export async function intake(request, env, id, forms, deps = {}) {
  const now = deps.now || (() => new Date());
  const uuid = deps.uuid || (() => crypto.randomUUID());
  if (!own(forms, id)) return problem(404, "unknown_form", "No such form");
  if (new URL(request.url).pathname !== ROUTE.replace("{id}", encodeURIComponent(id))) return problem(404, "unknown_form", "No such form");
  if (request.method !== "POST") return problem(405, "method_not_allowed", "Only POST is allowed", {}, { allow: "POST" });
  const form = forms[id];
  const origin = request.headers.get("origin");
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch { /* a malformed Origin is not this site */ }
    if (host !== new URL(request.url).host) return problem(403, "foreign_origin", "The form must be sent from this site");
  }
  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json" && type !== "application/x-www-form-urlencoded") return problem(415, "unsupported_media_type", "Send JSON or a form");
  const text = await boundedText(request, MAX_BODY_BYTES);
  if (text === null) return problem(413, "too_large", "The request is too large");
  const body = parseBody(text, type, form);
  if (!body) return problem(400, "malformed", "The request could not be read");
  const { values, errors } = validate(form, body);
  if (errors.length) return problem(422, "invalid", "Some answers are missing or not valid", { errors });
  const db = env && env.FORMS_DB;
  if (!db) return problem(503, "not_configured", "The form is not available here");
  const at = now().toISOString();
  const rowId = uuid();
  const ref = reference(rowId, at);
  try {
    await db.batch(DDL.map((sql) => db.prepare(sql)));
    const hourAgo = new Date(now().getTime() - 3600000).toISOString();
    const recent = await db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE created_at > ?`).bind(hourAgo).first();
    if (recent && recent.n >= MAX_PER_HOUR) return problem(429, "too_many", "Too many requests, try again later", {}, { "retry-after": "3600" });
    await db.prepare(`INSERT INTO ${TABLE} (id, reference, form_id, created_at, email, fields, consent) VALUES (?, ?, ?, ?, ?, ?, 1)`)
      .bind(rowId, ref, id, at, values.email, JSON.stringify(values)).run();
  } catch {
    // The values are never logged: the reference of a failed write does not exist, so there is nothing to report but the failure.
    return problem(503, "store_failed", "The request could not be saved");
  }
  if (type === "application/json") return json(201, { ok: true, reference: ref });
  return new Response(null, { status: 303, headers: { location: `/?request=${encodeURIComponent(ref)}`, "cache-control": "no-store" } });
}
