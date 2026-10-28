// Leads: list/filter/get, set the status and a note, export. The lead rows belong to the table the public form writes (the kit's leads shape);
// the admin never alters it: the status and the note live in the admin's own table admin_lead_state.
import { config } from "../config.js";
import { SECURITY_HEADERS, fail, json, decodeCursor, encodeCursor, pageSize, isoNow, isMissingTable, unavailable } from "../http.js";
import { auditDb, engineDb, auditStatement } from "../db.js";
import { body, idempotent, after, where, likeEscape } from "./shared.js";

const TABLE = config.tables.leads;               // a identifier checked by the config schema (^[a-z_]+$), so it is safe to put in SQL
const STATUSES = ["new", "contacted", "qualified", "won", "lost"];
const LEAD_ID = /^[A-Za-z0-9._-]{1,64}$/;
const FORM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const parseFields = (s) => { try { const o = JSON.parse(s); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch { /* the form wrote this column as JSON; an unreadable one shows as no fields */ return {}; } };
const stateOf = (map, id) => map.get(id) || { status: "new", note: "", updated_at: null };

async function states(db, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const { results = [] } = await db.prepare("SELECT lead_id, status, note, updated_at FROM admin_lead_state WHERE lead_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).all();
  for (const r of results) map.set(r.lead_id, r);
  return map;
}
const summary = (r, st) => ({ id: r.id, form: r.form, name: r.name, company: r.company ?? null, email_hash: r.email_hash, created_at: r.created_at, comms_status: r.comms_status ?? null, status: st.status, state_updated_at: st.updated_at });
const detail = (r, st) => ({ id: r.id, form: r.form, name: r.name, email: r.email, company: r.company ?? null, fields: parseFields(r.fields_json), created_at: r.created_at, comms_status: r.comms_status ?? null, dispatch_id: r.dispatch_id ?? null, status: st.status, note: st.note, state_updated_at: st.updated_at });

/** The filters of listLeads/exportLeads, validated: { status, form, q } or { response }. */
function filters(url) {
  const status = url.searchParams.get("status"), form = url.searchParams.get("form"), q = url.searchParams.get("q");
  if (status !== null && !STATUSES.includes(status)) return { response: fail(400, "invalid_status") };
  if (form !== null && !FORM_ID.test(form)) return { response: fail(400, "invalid_form") };
  if (q !== null && (q.length < 1 || q.length > 32 || new TextEncoder().encode(q).length > 44)) return { response: fail(400, "invalid_q", "1 to 32 characters") };
  return { status, form, q };
}
const baseWhere = ({ form, q }) => {
  const parts = [], binds = [];
  if (form) { parts.push("form = ?"); binds.push(form); }
  if (q) { parts.push("(name LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\')"); binds.push(`%${likeEscape(q)}%`, `%${likeEscape(q)}%`); }
  return { parts, binds };
};
const COLS = "id, form, name, email_hash, company, created_at, comms_status";

/** One window of leads in (created_at, id) order after the cursor, newest first. */
async function window(edb, f, cursor, size) {
  const { parts, binds } = baseWhere(f);
  const a = after(cursor, "created_at", "id");
  if (a.sql) { parts.push(a.sql); binds.push(...a.binds); }
  const { results = [] } = await edb.prepare(`SELECT ${COLS} FROM ${TABLE}${where(parts)} ORDER BY created_at DESC, id DESC LIMIT ${size}`).bind(...binds).all();
  return results;
}

export async function listLeads(ctx) {
  const edb = engineDb(ctx.env), adb = auditDb(ctx.env);
  if (!edb || !adb) return unavailable();
  const f = filters(ctx.url);
  if (f.response) return f.response;
  const size = pageSize(ctx.url), cursor = decodeCursor(ctx.url.searchParams.get("cursor"));
  if (size === null) return fail(400, "invalid_limit");
  if (cursor === null || (cursor && (typeof cursor.t !== "string" || typeof cursor.i !== "string"))) return fail(400, "invalid_cursor");
  const scan = f.status ? config.limits.leadScanWindow : size + 1;
  let rows;
  try { rows = await window(edb, f, cursor, scan); }
  catch (e) { if (isMissingTable(e)) return json({ items: [], next_cursor: null, available: false }); throw e; }
  const st = await states(adb, rows.map((r) => r.id));
  const items = [];
  let last = null;                                                 // the row after which the next page starts
  for (let i = 0; i < rows.length && items.length < size; i++) {
    last = i;
    const s = stateOf(st, rows[i].id);
    if (!f.status || s.status === f.status) items.push(summary(rows[i], s));
  }
  // more may follow when the window was full (a short window is the end of the table) or the page filled before the window ended
  const more = last !== null && (items.length === size ? last < rows.length - 1 || rows.length === scan : rows.length === scan);
  const edge = more ? rows[last] : null;
  return json({ items, next_cursor: edge ? encodeCursor({ t: edge.created_at, i: edge.id }) : null, available: true });
}

async function oneLead(ctx, id) {
  const edb = engineDb(ctx.env);
  try { return await edb.prepare(`SELECT id, form, name, email, email_hash, company, fields_json, created_at, comms_status, dispatch_id FROM ${TABLE} WHERE id = ?`).bind(id).first(); }
  catch (e) { if (isMissingTable(e)) return null; throw e; }
}

export async function getLead(ctx) {
  const edb = engineDb(ctx.env), adb = auditDb(ctx.env);
  if (!edb || !adb) return unavailable();
  const id = ctx.params.id;
  if (!LEAD_ID.test(id)) return fail(400, "invalid_id");
  const row = await oneLead(ctx, id);
  if (!row) return fail(404, "not_found");
  return json(detail(row, stateOf(await states(adb, [id]), id)));
}

export async function updateLead(ctx) {
  const edb = engineDb(ctx.env), adb = auditDb(ctx.env);
  if (!edb || !adb) return unavailable();
  const id = ctx.params.id;
  if (!LEAD_ID.test(id)) return fail(400, "invalid_id");
  const b = await body(ctx, "LeadUpdate");
  if (b.response) return b.response;
  if (b.value.note !== undefined && b.value.note.length > config.limits.noteMax) return fail(400, "invalid_request", "note is too long");
  return idempotent(ctx, "updateLead", { id, body: b.value }, async (key) => {
    const row = await oneLead(ctx, id);
    if (!row) return fail(404, "not_found");
    const before = stateOf(await states(adb, [id]), id);
    const next = { status: b.value.status ?? before.status, note: b.value.note ?? before.note };
    const now = isoNow();
    // the state and its audit row are ONE atomic batch: a change that is not in the log did not happen
    await adb.batch([
      adb.prepare("INSERT INTO admin_lead_state (lead_id, status, note, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(lead_id) DO UPDATE SET status = excluded.status, note = excluded.note, updated_at = excluded.updated_at, updated_by = excluded.updated_by")
        .bind(id, next.status, next.note, now, ctx.identity.actorHash),
      auditStatement(adb, { actorHash: ctx.identity.actorHash, action: "updateLead", outcome: "done", targetKind: "lead", targetId: id, requestId: ctx.requestId, idempotencyKey: key,
        detail: { from: before.status, to: next.status, status_changed: before.status !== next.status, note_changed: before.note !== next.note, note_length: next.note.length } }),
    ]);
    return json(detail(row, { ...next, updated_at: now }));
  });
}

const csvCell = (v) => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;                                     // a spreadsheet would run it as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function exportLeads(ctx) {
  const edb = engineDb(ctx.env), adb = auditDb(ctx.env);
  if (!edb || !adb) return unavailable();
  const f = filters(ctx.url);
  if (f.response) return f.response;
  const cap = config.limits.exportMaxRows, out = [];
  let cursor;
  try {
    while (out.length < cap) {
      const { parts, binds } = baseWhere(f);
      const a = after(cursor, "created_at", "id");
      if (a.sql) { parts.push(a.sql); binds.push(...a.binds); }
      const { results = [] } = await edb.prepare(`SELECT id, form, name, email, company, created_at, comms_status FROM ${TABLE}${where(parts)} ORDER BY created_at DESC, id DESC LIMIT 500`).bind(...binds).all();
      if (!results.length) break;
      const st = await states(adb, results.map((r) => r.id));
      for (const r of results) { const s = stateOf(st, r.id); if (!f.status || s.status === f.status) out.push({ ...r, ...s }); if (out.length >= cap) break; }
      cursor = { t: results.at(-1).created_at, i: results.at(-1).id };
      if (results.length < 500) break;
    }
  } catch (e) { if (!isMissingTable(e)) throw e; }
  // the export is audited BEFORE any row leaves: no log row, no data
  await auditStatement(adb, { actorHash: ctx.identity.actorHash, action: "exportLeads", outcome: "done", targetKind: "leads", targetId: "export", requestId: ctx.requestId, detail: { rows: out.length, status: f.status, form: f.form } }).run();
  const head = ["id", "form", "name", "email", "company", "created_at", "comms_status", "status", "note"];
  const csv = [head.join(","), ...out.map((r) => head.map((k) => csvCell(r[k])).join(","))].join("\r\n") + "\r\n";
  return new Response(csv, { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="leads.csv"', ...SECURITY_HEADERS } });
}
