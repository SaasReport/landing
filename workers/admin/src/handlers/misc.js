// Session, audit log and contract.
import { CONTRACT } from "../contract.js";
import { fail, json, decodeCursor, encodeCursor, pageSize, unavailable } from "../http.js";
import { auditDb, auditRow } from "../db.js";
import { after, where } from "./shared.js";

export const getSession = (ctx) => json({ ok: true, actor_hash: ctx.identity.actorHash, authorised: true });
export const getContract = () => json(CONTRACT);

export async function listAudit(ctx) {
  const db = auditDb(ctx.env);
  if (!db) return unavailable();
  const action = ctx.url.searchParams.get("action"), target = ctx.url.searchParams.get("target_id");
  if (action !== null && !/^[A-Za-z]{1,64}$/.test(action)) return fail(400, "invalid_action");
  if (target !== null && (target.length < 1 || target.length > 200)) return fail(400, "invalid_target");
  const size = pageSize(ctx.url), cursor = decodeCursor(ctx.url.searchParams.get("cursor"));
  if (size === null) return fail(400, "invalid_limit");
  if (cursor === null || (cursor && typeof cursor.i !== "number" && typeof cursor.i !== "string")) return fail(400, "invalid_cursor");
  const parts = [], binds = [];
  if (action) { parts.push("action = ?"); binds.push(action); }
  if (target) { parts.push("target_id = ?"); binds.push(target); }
  if (cursor) { parts.push("seq < ?"); binds.push(Number(cursor.i)); }
  const { results = [] } = await db.prepare(`SELECT seq, id, at, actor_hash, action, outcome, target_kind, target_id, detail_json, request_id, idempotency_key FROM admin_audit${where(parts)} ORDER BY seq DESC LIMIT ${size + 1}`).bind(...binds).all();
  const page = results.slice(0, size), edge = results.length > size ? page.at(-1) : null;
  return json({ items: page.map(auditRow), next_cursor: edge ? encodeCursor({ i: edge.seq }) : null });
}
