// Inbound messages and autoreply statistics from comms_inbound (the inbound handler's table). The columns read are named in the contract
// (components.schemas.InboundMessage); only what the table stores is shown, and a sender is shown as the hash the table holds.
import { config } from "../config.js";
import { fail, json, decodeCursor, encodeCursor, pageSize, isoNow, isMissingTable, unavailable } from "../http.js";
import { engineDb } from "../db.js";
import { after, where } from "./shared.js";

const TABLE = config.tables.inbound;
const STATUSES = ["received", "forwarded", "partial", "failed", "rejected", "dropped"];
const FORWARD_STATUS = ["sent", "failed", "skipped", "pending"];
const AUTOREPLY = ["sent", "suppressed", "skipped", "failed", "not_applicable"];

function forwards(text) {
  let list;
  try { list = JSON.parse(text ?? "[]"); } catch { /* forwards_json is the handler's column; unreadable shows as no forwards, never as a made-up one */ list = []; }
  return (Array.isArray(list) ? list : []).slice(0, 20).map((f) => ({ destination: String(f?.destination ?? "").slice(0, 120), status: FORWARD_STATUS.includes(f?.status) ? f.status : "pending", error: f?.error ? String(f.error).slice(0, 300) : null }));
}
const message = (r) => ({
  id: String(r.id), received_at: r.received_at, sender_hash: String(r.sender_hash ?? ""), recipient: String(r.recipient ?? ""), status: STATUSES.includes(r.status) ? r.status : "received",
  forwards: forwards(r.forwards_json), autoreply: { state: AUTOREPLY.includes(r.autoreply_state) ? r.autoreply_state : "not_applicable", reason: r.autoreply_reason ? String(r.autoreply_reason).slice(0, 200) : null },
});

export async function listInbound(ctx) {
  const edb = engineDb(ctx.env);
  if (!edb) return unavailable();
  const status = ctx.url.searchParams.get("status");
  if (status !== null && !STATUSES.includes(status)) return fail(400, "invalid_status");
  const size = pageSize(ctx.url), cursor = decodeCursor(ctx.url.searchParams.get("cursor"));
  if (size === null) return fail(400, "invalid_limit");
  if (cursor === null || (cursor && (typeof cursor.t !== "string" || typeof cursor.i !== "string"))) return fail(400, "invalid_cursor");
  const parts = [], binds = [];
  if (status) { parts.push("status = ?"); binds.push(status); }
  const a = after(cursor, "received_at", "id");
  if (a.sql) { parts.push(a.sql); binds.push(...a.binds); }
  let rows;
  try { ({ results: rows = [] } = await edb.prepare(`SELECT id, received_at, sender_hash, recipient, status, forwards_json, autoreply_state, autoreply_reason FROM ${TABLE}${where(parts)} ORDER BY received_at DESC, id DESC LIMIT ${size + 1}`).bind(...binds).all()); }
  catch (e) { if (isMissingTable(e)) return json({ items: [], next_cursor: null, available: false }); throw e; }
  const page = rows.slice(0, size), edge = rows.length > size ? page.at(-1) : null;
  return json({ items: page.map(message), next_cursor: edge ? encodeCursor({ t: edge.received_at, i: String(edge.id) }) : null, available: true });
}

const tally = (rows, key) => Object.fromEntries(rows.map((r) => [String(r[key] ?? "unknown"), Number(r.n)]));

export async function getAutoreplyStats(ctx) {
  const edb = engineDb(ctx.env);
  if (!edb) return unavailable();
  const raw = ctx.url.searchParams.get("window_hours");
  const hours = raw === null ? 24 : /^\d{1,3}$/.test(raw) ? Number(raw) : 0;
  if (hours < 1 || hours > 720) return fail(400, "invalid_window");
  const since = new Date(Date.parse(isoNow()) - hours * 3_600_000).toISOString();
  let inbound = { available: false, total: 0, by_state: {} };
  try {
    const { results = [] } = await edb.prepare(`SELECT autoreply_state AS k, COUNT(*) AS n FROM ${TABLE} WHERE received_at >= ? GROUP BY autoreply_state`).bind(since).all();
    inbound = { available: true, total: results.reduce((s, r) => s + Number(r.n), 0), by_state: tally(results, "k") };
  } catch (e) { if (!isMissingTable(e)) throw e; }
  let receipts = { total: 0, by_status: {} };
  try {
    const { results = [] } = await edb.prepare("SELECT receipt_status AS k, COUNT(*) AS n FROM comms_form_deliveries WHERE created_at >= ? GROUP BY receipt_status").bind(since).all();
    receipts = { total: results.reduce((s, r) => s + Number(r.n), 0), by_status: tally(results, "k") };
  } catch (e) { if (!isMissingTable(e)) throw e; }
  return json({ window_hours: hours, inbound, form_receipts: receipts });
}
