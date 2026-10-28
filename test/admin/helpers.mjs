// Shared fixtures of the admin tests: local RSA keys and Access tokens, a fake JWKS endpoint, D1 over node:sqlite with the real migrations,
// and the real comms engine behind a service binding. No network, no secret: every key is generated here and thrown away.
import { generateKeyPairSync, createSign, createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { withD1Limits } from "@saasreport/core/d1-limits";
import { migrationOrder } from "@saasreport/core/migration-order";
import { createWorker } from "../../workers/admin/src/index.js";

export const ROOT = new URL("../../", import.meta.url);
export const TEAM = "testteam.cloudflareaccess.com";
export const AUD = "a".repeat(64);
export const ORIGIN = "https://admin.test";
export const ALLOWED = "owner.test@example.test";

const b64u = (b) => Buffer.from(b).toString("base64url");
export function newKey(kid) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  return { kid, privateKey, jwk: { kty: "RSA", kid, n: jwk.n, e: jwk.e, alg: "RS256", use: "sig" } };
}
/** An Access-shaped token signed by `key`; every claim can be overridden (or removed with undefined). */
export function sign(key, claims = {}, { header = {}, now = Math.floor(Date.now() / 1000) } = {}) {
  const payload = { aud: [AUD], iss: `https://${TEAM}`, email: ALLOWED, iat: now, nbf: now - 5, exp: now + 600, sub: "user-1", type: "app", ...claims };
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  const h = b64u(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT", ...header })), p = b64u(JSON.stringify(payload));
  const s = createSign("RSA-SHA256").update(`${h}.${p}`).sign(key.privateKey);
  return `${h}.${p}.${b64u(s)}`;
}
export const hashOf = (email) => createHash("sha256").update(email).digest("hex");

/** A fetch that serves the team's key set (`keys` may change between calls) and counts the calls. Anything else is refused. */
export function jwksFetch(state) {
  const f = async (url) => {
    f.calls.push(String(url));
    if (String(url) !== `https://${TEAM}/cdn-cgi/access/certs`) return new Response("no", { status: 404 });
    if (state.fail) throw new Error("network down");
    return Response.json({ keys: state.keys.map((k) => k.jwk), public_cert: { kid: "x", cert: "x" } });
  };
  f.calls = [];
  return f;
}

/** D1 over node:sqlite (D1's limits, batch in one transaction). */
export function makeD1(migrationDirs = []) {
  const db = new DatabaseSync(":memory:");
  const rawExec = DatabaseSync.prototype.exec.bind(db);       // D1 runs a batch as one transaction itself; the local engine needs BEGIN, which the D1 limits refuse
  withD1Limits(db);
  for (const dir of migrationDirs) for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort(migrationOrder)) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const conv = (args) => args.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v));
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, conv(a)),
    first: async () => { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; },
    all: async () => ({ success: true, results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return {
    prepare: (sql) => stmt(sql), raw: db, exec: async (sql) => db.exec(sql),
    batch: async (list) => { rawExec("BEGIN"); try { const out = []; for (const s of list) out.push(await s.run()); rawExec("COMMIT"); return out; } catch (e) { rawExec("ROLLBACK"); throw e; } },
  };
}
const dir = (p) => new URL(p, ROOT);
export const adminDb = () => makeD1([dir("workers/admin/migrations/")]);
/** The engine's D1: the comms migrations, the kit's leads table and the inbound table the contract names (comms_inbound is the inbound handler's, not vendored yet). */
export function engineDb() {
  const d = makeD1([dir("vendor/kit/packages/comms/migrations/")]);
  d.raw.exec(readFileSync(dir("vendor/kit/packages/cloudflare/migrations/0005_leads.sql"), "utf8"));
  d.raw.exec(`CREATE TABLE comms_inbound (id TEXT PRIMARY KEY, received_at TEXT NOT NULL, sender_hash TEXT, recipient TEXT, status TEXT, forwards_json TEXT, autoreply_state TEXT, autoreply_reason TEXT)`);
  return d;
}

/** A request as the edge would pass it to the Worker. */
export function req(path, { method = "GET", token, body, headers = {}, origin = ORIGIN, json = true } = {}) {
  const h = new Headers(headers);
  if (token) h.set("cf-access-jwt-assertion", token);
  if (body !== undefined) { if (json) h.set("content-type", "application/json"); const b = typeof body === "string" ? body : JSON.stringify(body); h.set("content-length", String(new TextEncoder().encode(b).length)); body = b; }
  if (method !== "GET" && origin && !h.has("origin")) h.set("origin", origin);
  return new Request(`${ORIGIN}${path}`, { method, headers: h, body });
}

/** A whole admin: the Worker with its key cache over the fake JWKS, both databases, a comms service and assets. */
export function makeAdmin(o = {}) {
  const key = o.key || newKey("kid-1");
  const state = { keys: [key], fail: false };
  const fetchFn = o.fetch || jwksFetch(state);
  const env = {
    ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_ALLOWED_EMAILS: `${ALLOWED}, second.test@example.test`,
    DB: adminDb(), ENGINE_DB: engineDb(), ASSETS: { fetch: async (r) => new Response(`asset ${new URL(r.url).pathname}`, { headers: { "content-type": "text/html" } }) },
    BUILD_COMMIT: "a".repeat(40), ...(o.env || {}),
  };
  const now = o.now || (() => Date.now());
  const worker = createWorker({ fetch: fetchFn, now });
  const token = (claims, opts) => sign(key, claims, opts);
  const call = (path, opts = {}) => worker.fetch(req(path, { token: token(), ...opts }), env, {});
  return { env, state, key, token, call, worker, fetch: fetchFn };
}

// ---- the real comms engine behind the COMMS service binding ----
import { createCommsEngine } from "@saasreport/comms/engine";
import { buildSpecs } from "@saasreport/comms";
import commsConfig from "../../comms.config.js";
import { newReference } from "@saasreport/core/form-deliveries";

export { newReference, commsConfig };
export const OWNER_INBOX = "info@saasreport.ai";

/** The comms engine of this repository (its real config and templates) over `db`, with a mail sender that records every message and refuses `reject`. */
export function makeComms(db, { reject = [], owner = OWNER_INBOX } = {}) {
  const s = buildSpecs(commsConfig);
  const engine = createCommsEngine({ config: commsConfig, specs: { manifest: s["manifest.json"], blocks: s["blocks.json"], links: s["links.json"], providers: s["providers.json"] } });
  const sent = [], calls = [];
  const mail = { fetch: async (url, init) => {
    const b = JSON.parse(init.body);
    if (reject.includes(b.to)) return Response.json({ ok: false, error: "send_failed", detail: "destination address is not a verified address" }, { status: 502 });
    sent.push(b); return Response.json({ ok: true, message_id: `m${sent.length}` });
  } };
  const env = { DB: db, MAIL_SENDER: mail, OPS_NOTIFY_TO: owner };
  return { sent, calls, mail, reject, fetch: async (url, init) => { calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null }); return engine.fetch(new Request(url, init), env, {}); } };
}

/** A lead as the public form stores it (the kit's leads shape), its form-delivery row and the status the ledger holds. */
export async function seedLead(db, o = {}) {
  const id = o.id || newReference("E");
  const email = o.email || "sara.test@example.test";
  const created = o.created_at || new Date().toISOString();
  await db.prepare("INSERT INTO leads (id, form, ref, name, email, email_hash, company, fields_json, ip_hash, user_agent, created_at, comms_status, dispatch_id) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)")
    .bind(id, o.form || "early-access", o.name || "Sara Test", email, hashOf(email), o.company ?? "Test Company", JSON.stringify(o.fields || { name: o.name || "Sara Test", email, company: o.company ?? "Test Company", role: "CFO", reports: ["Recurring revenue health"], message: "Hello" }), created, o.comms_status ?? "sent").run();
  if (o.delivery !== false) await db.prepare("INSERT INTO comms_form_deliveries (reference, form_id, site, test, created_at, updated_at, receipt_status, owner_status, owner_error) VALUES (?, ?, 'https://saasreport.ai', 0, ?, ?, ?, ?, ?)")
    .bind(id, o.form || "early-access", created, created, o.receipt ?? "sent", o.owner ?? "sent", o.owner_error ?? null).run();
  return id;
}

// ---- the contract as the oracle of every answer ----
import { createValidator, formatProblems } from "@saasreport/core/schema";
import { CONTRACT, CONTRACT_ID, schemaDocument, localize } from "../../workers/admin/src/contract.js";
const kitSchema = (f) => JSON.parse(readFileSync(dir(`vendor/kit/packages/core/schemas/${f}`), "utf8"));
const V = createValidator([kitSchema("form-notification.schema.json"), kitSchema("build.schema.json"), schemaDocument(null)]);

/** Problems of `value` against what the contract says operation `operationId` answers with `status` (application/json). */
export function conformsTo(operationId, status, value) {
  for (const item of Object.values(CONTRACT.paths)) for (const op of Object.values(item)) if (op.operationId === operationId) {
    let r = op.responses[String(status)];
    if (r?.$ref) r = CONTRACT.components.responses[r.$ref.split("/").pop()];
    const schema = r?.content?.["application/json"]?.schema;
    if (!schema) return [`${operationId}: the contract declares no JSON ${status} answer`];
    return formatProblems(V.validate(value, localize(schema)));
  }
  return [`no operation ${operationId}`];
}
export const bodyOf = (schemaName, value) => formatProblems(V.validate(value, { $ref: `${CONTRACT_ID}#/$defs/${schemaName}` }));
/** Call, assert the status and that the JSON answer is what the contract declares for it. */
export async function expectJson(a, operationId, path, status, opts) {
  const r = await a.call(path, opts);
  const text = await r.text();
  assert_(r.status === status, `${operationId} ${path}: expected ${status}, got ${r.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  const bad = conformsTo(operationId, status, j);
  assert_(!bad.length, `${operationId} ${status} does not match the contract: ${bad.join("; ")}`);
  return j;
}
import assert from "node:assert/strict";
const assert_ = (c, m) => assert.ok(c, m);
