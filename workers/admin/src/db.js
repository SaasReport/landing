// The admin's own D1: the append-only audit log (migration 0001) and the idempotency records.
import { config, hasDb } from "./config.js";
import { isoNow } from "./http.js";

export const auditDb = (env) => (hasDb(env, config.bindings.audit) ? env[config.bindings.audit] : null);
export const engineDb = (env) => (hasDb(env, config.bindings.engineDb) ? env[config.bindings.engineDb] : null);

const clip = (o) => { const s = JSON.stringify(o ?? {}); return s.length > 2000 ? JSON.stringify({ truncated: true }) : s; };

/** The prepared INSERT of one audit row (use in a batch, or run it). `entry`: { actorHash, action, outcome, targetKind, targetId, detail, requestId, idempotencyKey }. */
export function auditStatement(db, entry) {
  return db.prepare("INSERT INTO admin_audit (id, at, actor_hash, action, outcome, target_kind, target_id, detail_json, request_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(`aud_${crypto.randomUUID()}`, isoNow(), entry.actorHash, entry.action, entry.outcome, entry.targetKind, String(entry.targetId).slice(0, 200), clip(entry.detail), entry.requestId ?? null, entry.idempotencyKey ?? null);
}
/** Append one audit row. Throws when it cannot be written: an action that cannot be audited is not carried out. */
export async function audit(db, entry) { await auditStatement(db, entry).run(); }

export const auditRow = (r) => ({
  seq: Number(r.seq), id: r.id, at: r.at, actor_hash: r.actor_hash, action: r.action, outcome: r.outcome, target_kind: r.target_kind, target_id: r.target_id,
  detail: (() => { try { return JSON.parse(r.detail_json); } catch { /* the column is written by this Worker as JSON; an unreadable one shows as empty, the row itself is still listed */ return {}; } })(), request_id: r.request_id ?? null, idempotency_key: r.idempotency_key ?? null,
});

export async function findIdempotent(db, key, action) {
  return db.prepare("SELECT request_hash, status, response_json FROM admin_idempotency WHERE idempotency_key = ? AND action = ?").bind(key, action).first();
}
export function idempotencyStatement(db, { key, action, requestHash, status, body }) {
  return db.prepare("INSERT INTO admin_idempotency (idempotency_key, action, request_hash, status, response_json, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(idempotency_key, action) DO NOTHING")
    .bind(key, action, requestHash, status, JSON.stringify(body), isoNow());
}
