// Pieces the handlers share: the bounded JSON body, idempotency, the keyset page of a SQL query.
import { readJsonBody } from "@saasreport/cloudflare/body";
import { config } from "../config.js";
import { fail, json, isJson, sha256Hex, unavailable } from "../http.js";
import { auditDb, findIdempotent, idempotencyStatement } from "../db.js";
import { problems, describe } from "../contract.js";

/** The request body, bounded while it streams, as JSON, validated against the contract's component schema `name`. → { value } or { response }. */
export async function body(ctx, name) {
  if (!isJson(ctx.request)) return { response: fail(415, "bad_content_type", "the body must be application/json") };
  const read = await readJsonBody(ctx.request, { maxBytes: config.limits.bodyMaxBytes, fallback: null });
  if (read.response) return { response: read.response };
  if (read.invalid || read.value === null || typeof read.value !== "object" || Array.isArray(read.value)) return { response: fail(400, "invalid_json") };
  const bad = problems(name, read.value);
  if (bad.length) return { response: fail(400, "invalid_request", describe(bad)) };
  return { value: read.value };
}

const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v));
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Run a mutation under the request's Idempotency-Key (none: just run it). The same key and the same request replay the first answer
 * (header idempotent-replayed: true) and write nothing; the same key with another request is a 409. Only a successful answer is kept, so a
 * failed attempt can be retried under the same key. `run(key)` gets the key (or null) to put in its audit rows.
 */
export async function idempotent(ctx, action, payload, run, { required = false } = {}) {
  const key = ctx.request.headers.get("idempotency-key");
  if (key === null) return required ? fail(400, "idempotency_key_required", "send an Idempotency-Key header (1 to 64 characters)") : run(null);
  if (!IDEMPOTENCY_KEY.test(key)) return fail(400, "invalid_idempotency_key");
  const db = auditDb(ctx.env);
  if (!db) return unavailable();
  const requestHash = await sha256Hex(stable([ctx.request.method, ctx.url.pathname, payload]));
  const prior = await findIdempotent(db, key, action);
  if (prior) {
    if (prior.request_hash !== requestHash) return fail(409, "idempotency_key_reused", "this key was used for another request");
    return json(JSON.parse(prior.response_json), prior.status, { "idempotent-replayed": "true" });
  }
  const res = await run(key);
  if (res.status >= 200 && res.status < 300) await idempotencyStatement(db, { key, action, requestHash, status: res.status, body: await res.clone().json() }).run();
  return res;
}

/** A SQL fragment and its binds for a keyset page ordered by (col DESC, tie DESC): rows strictly after the cursor. */
export function after(cursor, col, tie) {
  return cursor ? { sql: `(${col} < ? OR (${col} = ? AND ${tie} < ?))`, binds: [cursor.t, cursor.t, cursor.i] } : { sql: "", binds: [] };
}
export const where = (parts) => (parts.length ? ` WHERE ${parts.join(" AND ")}` : "");
export const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
