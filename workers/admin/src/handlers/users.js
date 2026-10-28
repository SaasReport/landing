// Users, roles and invitations. No password, no credential, no address stored: an identity is the SHA-256 of the lowercased Access email.
// The identities on the allowlist are owners by configuration; an invitation is a record that grants nothing by itself (access is the Access
// policy and the allowlist secret, which the lead changes), and the admin has no mail path, so it sends nothing.
import { config, text } from "../config.js";
import { fail, json, decodeCursor, encodeCursor, pageSize, isoNow, sha256Hex, unavailable } from "../http.js";
import { auditDb, auditStatement } from "../db.js";
import { body, idempotent, where } from "./shared.js";

const STATES = ["pending", "revoked", "accepted", "expired"];
const ID = /^inv_[0-9a-f-]{36}$/;

export const listRoles = () => json({ roles: config.roles.map((r) => ({ id: r.id, title: r.title, permissions: r.permissions, assignable: r.assignable })) });

export async function listUsers(ctx) {
  const db = auditDb(ctx.env);
  if (!db) return unavailable();
  const size = pageSize(ctx.url), cursor = decodeCursor(ctx.url.searchParams.get("cursor"));
  if (size === null) return fail(400, "invalid_limit");
  if (cursor === null || (cursor && typeof cursor.i !== "string")) return fail(400, "invalid_cursor");
  const owners = [];
  for (const e of text(ctx.env, config.secrets.allowlist).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)) owners.push(await sha256Hex(e));
  const rows = (await db.prepare(`SELECT id, role, status, created_at FROM admin_principals${cursor ? " WHERE id > ?" : ""} ORDER BY id LIMIT ${size + 1}`).bind(...(cursor ? [cursor.i] : [])).all()).results;
  const page = rows.slice(0, size), edge = rows.length > size ? page.at(-1) : null;
  const items = [...(cursor ? [] : [...new Set(owners)].sort().map((id) => ({ id, role: "owner", status: "active", source: "allowlist", created_at: null }))), ...page.map((r) => ({ id: r.id, role: r.role, status: r.status, source: "registry", created_at: r.created_at }))];
  return json({ items, next_cursor: edge ? encodeCursor({ i: edge.id }) : null, note: "Access is decided by the Cloudflare Access policy and the allowlist secret; a registry principal has no effect until the lead widens both." });
}

const view = (r) => ({ id: r.id, invitee_hash: r.invitee_hash, role: r.role, state: r.state === "pending" && r.expires_at < isoNow() ? "expired" : r.state, created_at: r.created_at, expires_at: r.expires_at, created_by: r.created_by });

export async function listInvitations(ctx) {
  const db = auditDb(ctx.env);
  if (!db) return unavailable();
  const state = ctx.url.searchParams.get("state");
  if (state !== null && !STATES.includes(state)) return fail(400, "invalid_state");
  const size = pageSize(ctx.url), cursor = decodeCursor(ctx.url.searchParams.get("cursor"));
  if (size === null) return fail(400, "invalid_limit");
  if (cursor === null || (cursor && (typeof cursor.t !== "string" || typeof cursor.i !== "string"))) return fail(400, "invalid_cursor");
  const rows = (await db.prepare(`SELECT * FROM admin_invitations${cursor ? " WHERE (created_at < ? OR (created_at = ? AND id < ?))" : ""} ORDER BY created_at DESC, id DESC LIMIT 500`).bind(...(cursor ? [cursor.t, cursor.t, cursor.i] : [])).all()).results.map(view);
  const hit = rows.filter((r) => !state || r.state === state);
  const page = hit.slice(0, size), edge = hit.length > size ? page.at(-1) : null;
  return json({ items: page, next_cursor: edge ? encodeCursor({ t: edge.created_at, i: edge.id }) : null });
}

export async function createInvitation(ctx) {
  const db = auditDb(ctx.env);
  if (!db) return unavailable();
  const b = await body(ctx, "InvitationCreate");
  if (b.response) return b.response;
  const role = config.roles.find((r) => r.id === b.value.role);
  if (!role || !role.assignable) return fail(400, "invalid_role", "the role does not exist or is held only through the Access allowlist");
  const hash = await sha256Hex(b.value.email.toLowerCase());
  return idempotent(ctx, "createInvitation", { hash, role: role.id, days: b.value.days ?? config.invitations.defaultDays }, async (key) => {
    const now = isoNow(), days = b.value.days ?? config.invitations.defaultDays;
    const id = `inv_${crypto.randomUUID()}`, expires = new Date(Date.parse(now) + days * 86_400_000).toISOString();
    const stale = await db.prepare("SELECT id FROM admin_invitations WHERE invitee_hash = ? AND state = 'pending' AND expires_at < ?").bind(hash, now).first();
    const entry = { actorHash: ctx.identity.actorHash, action: "createInvitation", targetKind: "invitation", targetId: id, requestId: ctx.requestId, idempotencyKey: key, outcome: "done", detail: { role: role.id, days } };
    try {
      await db.batch([
        ...(stale ? [db.prepare("UPDATE admin_invitations SET state = 'expired' WHERE id = ?").bind(stale.id)] : []),
        db.prepare("INSERT INTO admin_invitations (id, invitee_hash, role, state, created_at, expires_at, created_by) VALUES (?, ?, ?, 'pending', ?, ?, ?)").bind(id, hash, role.id, now, expires, ctx.identity.actorHash),
        auditStatement(db, entry),
      ]);
    } catch (e) {
      if (/UNIQUE/i.test(String(e?.message))) return fail(409, "invitation_pending", "this invitee already has a pending invitation");
      throw e;
    }
    return json(view({ id, invitee_hash: hash, role: role.id, state: "pending", created_at: now, expires_at: expires, created_by: ctx.identity.actorHash }));
  });
}

export async function revokeInvitation(ctx) {
  const db = auditDb(ctx.env);
  if (!db) return unavailable();
  const id = ctx.params.id;
  if (!ID.test(id)) return fail(400, "invalid_id");
  return idempotent(ctx, "revokeInvitation", { id }, async (key) => {
    const row = await db.prepare("SELECT * FROM admin_invitations WHERE id = ?").bind(id).first();
    if (!row) return fail(404, "not_found");
    const v = view(row);
    if (v.state !== "pending") return fail(409, "not_pending", `the invitation is ${v.state}`);
    const now = isoNow();
    await db.batch([
      db.prepare("UPDATE admin_invitations SET state = 'revoked', revoked_at = ? WHERE id = ?").bind(now, id),
      auditStatement(db, { actorHash: ctx.identity.actorHash, action: "revokeInvitation", targetKind: "invitation", targetId: id, requestId: ctx.requestId, idempotencyKey: key, outcome: "done", detail: { role: row.role } }),
    ]);
    return json({ ...v, state: "revoked" });
  });
}
