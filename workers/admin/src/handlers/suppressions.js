// The suppression list (comms_suppression): hashes only. Adding goes through the comms engine (it hashes the address itself and writes
// its own audit chain); removing deletes one row of the engine's table, except a dsar-erasure, which is permanent.
import { config, snapshot, hasService } from "../config.js";
import { fail, json, decodeCursor, encodeCursor, pageSize, isMissingTable, sha256Hex, unavailable } from "../http.js";
import { auditDb, engineDb, auditStatement } from "../db.js";
import { body, idempotent, after, where } from "./shared.js";

const REASONS = ["hard-bounce", "complaint", "unsubscribe.marketing", "unsubscribe.operational", "dsar-erasure"];
const HASH = /^[0-9a-f]{64}$/;

export async function listSuppressions(ctx) {
  const edb = engineDb(ctx.env);
  if (!edb) return unavailable();
  const reason = ctx.url.searchParams.get("reason");
  if (reason !== null && !REASONS.includes(reason)) return fail(400, "invalid_reason");
  const size = pageSize(ctx.url), cursor = decodeCursor(ctx.url.searchParams.get("cursor"));
  if (size === null) return fail(400, "invalid_limit");
  if (cursor === null || (cursor && (typeof cursor.t !== "string" || typeof cursor.i !== "string"))) return fail(400, "invalid_cursor");
  const parts = [], binds = [];
  if (reason) { parts.push("reason = ?"); binds.push(reason); }
  const a = after(cursor, "created_at", "recipient_hash || reason");
  if (a.sql) { parts.push(a.sql); binds.push(...a.binds); }
  let rows;
  try { ({ results: rows = [] } = await edb.prepare(`SELECT recipient_hash, reason, scope, actor_id, created_at FROM comms_suppression${where(parts)} ORDER BY created_at DESC, recipient_hash || reason DESC LIMIT ${size + 1}`).bind(...binds).all()); }
  catch (e) { if (isMissingTable(e)) return json({ items: [], next_cursor: null }); throw e; }
  const page = rows.slice(0, size), edge = rows.length > size ? page.at(-1) : null;
  return json({ items: page.map((r) => ({ recipient_hash: r.recipient_hash, reason: r.reason, scope: r.scope, actor_id: r.actor_id ?? null, created_at: r.created_at })), next_cursor: edge ? encodeCursor({ t: edge.created_at, i: edge.recipient_hash + edge.reason }) : null });
}

export async function addSuppression(ctx) {
  const adb = auditDb(ctx.env);
  if (!adb || !hasService(ctx.env, config.bindings.comms)) return unavailable();
  const b = await body(ctx, "SuppressionAdd");
  if (b.response) return b.response;
  const { reason, scope = "global" } = b.value;
  const target = b.value.recipient_hash ?? "by-address";
  // the address, when given, is handed to the engine and is not kept: the audit row and the idempotency record see only its presence
  return idempotent(ctx, "addSuppression", { reason, scope, by: b.value.recipient ? "address" : "hash", who: b.value.recipient_hash ?? (await sha256Hex(b.value.recipient.toLowerCase())) }, async (key) => {
    const entry = { actorHash: ctx.identity.actorHash, action: "addSuppression", targetKind: "suppression", targetId: target, requestId: ctx.requestId, idempotencyKey: key };
    await auditStatement(adb, { ...entry, outcome: "attempted", detail: { reason, scope } }).run();
    let res, out = null;
    try {
      res = await ctx.env[config.bindings.comms].fetch("https://comms/v1/comms/suppress", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...(b.value.recipient ? { recipient: b.value.recipient } : { recipient_hash: b.value.recipient_hash }), reason, scope, actor_id: `${snapshot.project}:admin:${ctx.identity.actorHash.slice(0, 16)}` }) });
      out = await res.json();
    } catch (e) { console.error("[admin] the comms engine did not answer the suppression", String(e?.message || e).slice(0, 120)); out = null; }
    if (!out?.ok || !HASH.test(out.recipient_hash ?? "")) {
      await auditStatement(adb, { ...entry, outcome: "failed", detail: { reason, scope, status: res?.status ?? null } }).run();
      return fail(502, "comms_unavailable", out?.error);
    }
    await auditStatement(adb, { ...entry, targetId: out.recipient_hash, outcome: "done", detail: { reason, scope } }).run();
    return json({ ok: true, recipient_hash: out.recipient_hash, reason });
  });
}

export async function removeSuppression(ctx) {
  const edb = engineDb(ctx.env), adb = auditDb(ctx.env);
  if (!edb || !adb) return unavailable();
  const { recipient_hash: hash, reason } = ctx.params;
  if (!HASH.test(hash) || !REASONS.includes(reason)) return fail(400, "invalid_request");
  return idempotent(ctx, "removeSuppression", { hash, reason }, async (key) => {
    const entry = { actorHash: ctx.identity.actorHash, action: "removeSuppression", targetKind: "suppression", targetId: hash, requestId: ctx.requestId, idempotencyKey: key };
    if (reason === "dsar-erasure") {
      await auditStatement(adb, { ...entry, outcome: "denied", detail: { reason } }).run();
      return fail(409, "erasure_is_permanent", "a dsar-erasure suppression cannot be removed");
    }
    const exists = await edb.prepare("SELECT 1 AS x FROM comms_suppression WHERE recipient_hash = ? AND reason = ?").bind(hash, reason).first().catch((e) => { if (isMissingTable(e)) return null; throw e; });
    if (!exists) return fail(404, "not_found");
    await auditStatement(adb, { ...entry, outcome: "attempted", detail: { reason } }).run();
    try { await edb.prepare("DELETE FROM comms_suppression WHERE recipient_hash = ? AND reason = ?").bind(hash, reason).run(); }
    catch (e) {
      await auditStatement(adb, { ...entry, outcome: "failed", detail: { reason } }).run();
      throw e;
    }
    await auditStatement(adb, { ...entry, outcome: "done", detail: { reason } }).run();
    return json({ ok: true, recipient_hash: hash, reason });
  });
}
