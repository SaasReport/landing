// The form delivery ledger (comms_form_deliveries, kit.form-notification.v1), the owner-alert failures and the retry through the comms engine.
import { recordOf, readDelivery, submitForm, REFERENCE_RE, SUMMARY_DEFAULTS, deliverySummary } from "@saasreport/core/form-deliveries";
import { fieldsHtml, fieldsText } from "@saasreport/comms/html";
import { config, snapshot, hasService } from "../config.js";
import { fail, json, decodeCursor, encodeCursor, pageSize, isoNow, isMissingTable, unavailable } from "../http.js";
import { auditDb, engineDb, auditStatement } from "../db.js";
import { idempotent, after, where } from "./shared.js";

const FORM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** submitForm's errors that mean the engine did not handle the submission (not a delivery that went wrong): the binding, an unreadable answer, a refusal. */
const TRANSPORT = /^(comms_binding_|comms_unreadable_|invalid_submission|ledger_not_recorded|no_ledger|reference_conflict|undeclared_form|site_required|reference_invalid)/;

function failedClause(now) {
  const stale = new Date(Date.parse(now) - SUMMARY_DEFAULTS.pendingAfterMin * 60_000).toISOString();
  return { sql: "(owner_status = 'failed' OR receipt_status = 'failed' OR (owner_status = 'pending' AND created_at < ?))", binds: [stale] };
}

export async function listDeliveries(ctx) {
  const edb = engineDb(ctx.env);
  if (!edb) return unavailable();
  const state = ctx.url.searchParams.get("state") ?? "all", form = ctx.url.searchParams.get("form_id");
  if (!["all", "failed", "pending"].includes(state)) return fail(400, "invalid_state");
  if (form !== null && !FORM_ID.test(form)) return fail(400, "invalid_form");
  const size = pageSize(ctx.url), cursor = decodeCursor(ctx.url.searchParams.get("cursor"));
  if (size === null) return fail(400, "invalid_limit");
  if (cursor === null || (cursor && (typeof cursor.t !== "string" || typeof cursor.i !== "string"))) return fail(400, "invalid_cursor");
  const parts = [], binds = [];
  if (form) { parts.push("form_id = ?"); binds.push(form); }
  if (state === "failed") { const c = failedClause(isoNow()); parts.push(c.sql); binds.push(...c.binds); }
  if (state === "pending") parts.push("(owner_status = 'pending' OR receipt_status = 'pending')");
  const a = after(cursor, "created_at", "reference");
  if (a.sql) { parts.push(a.sql); binds.push(...a.binds); }
  let rows;
  try { ({ results: rows = [] } = await edb.prepare(`SELECT * FROM comms_form_deliveries${where(parts)} ORDER BY created_at DESC, reference DESC LIMIT ${size + 1}`).bind(...binds).all()); }
  catch (e) { if (isMissingTable(e)) return json({ items: [], next_cursor: null }); throw e; }
  const page = rows.slice(0, size);
  const edge = rows.length > size ? page.at(-1) : null;
  return json({ items: page.map((r) => recordOf(r)), next_cursor: edge ? encodeCursor({ t: edge.created_at, i: edge.reference }) : null });
}

export async function getDelivery(ctx) {
  const edb = engineDb(ctx.env);
  if (!edb) return unavailable();
  if (!REFERENCE_RE.test(ctx.params.reference)) return fail(400, "invalid_reference");
  const rec = await readDelivery(edb, ctx.params.reference).catch((e) => { if (isMissingTable(e)) return null; throw e; });
  return rec ? json(rec) : fail(404, "not_found");
}

export async function listOwnerAlertFailures(ctx) {
  const edb = engineDb(ctx.env);
  if (!edb) return unavailable();
  const raw = ctx.url.searchParams.get("window_hours");
  const hours = raw === null ? 168 : /^\d{1,3}$/.test(raw) ? Number(raw) : 0;
  if (hours < 1 || hours > 720) return fail(400, "invalid_window");
  const size = pageSize(ctx.url);
  if (size === null) return fail(400, "invalid_limit");
  const now = isoNow(), since = new Date(Date.parse(now) - hours * 3_600_000).toISOString();
  const failures = [];
  const c = failedClause(now);
  try {
    const { results: forms = [] } = await edb.prepare(`SELECT reference, form_id, created_at, owner_status, owner_error FROM comms_form_deliveries WHERE created_at >= ? AND (owner_status = 'failed' OR (owner_status = 'pending' AND created_at < ?)) ORDER BY created_at DESC LIMIT ${size}`).bind(since, c.binds[0]).all();
    for (const r of forms) failures.push({ kind: "form_owner_notification", id: r.reference, form_id: r.form_id, at: r.created_at, status: r.owner_status, error: r.owner_error ?? null });
    const { results: ops = [] } = await edb.prepare(`SELECT dispatch_id, template_id, requested_at, send_status, send_error FROM comms_dispatch WHERE requested_at >= ? AND send_status = 'failed' AND template_id LIKE '%.ops.%' ORDER BY requested_at DESC LIMIT ${size}`).bind(since).all();
    for (const r of ops) failures.push({ kind: "ops_dispatch", id: r.dispatch_id, form_id: null, at: r.requested_at, status: r.send_status, error: r.send_error ? String(r.send_error).slice(0, 300) : null });
  } catch (e) { if (!isMissingTable(e)) throw e; }
  failures.sort((a, b) => (a.at < b.at ? 1 : -1));
  const summary = await deliverySummary(edb, { windowHours: hours }).catch((e) => { console.error("[admin] the deliveries summary could not be read", String(e?.message || e).slice(0, 120)); return { ok: true, window_hours: hours, pending_after_min: SUMMARY_DEFAULTS.pendingAfterMin, submissions: 0, owner_sent: 0, owner_failed: 0, owner_pending_stale: 0, receipt_failed: 0, last_owner_failure_at: null, last_test_at: null }; });
  return json({ window_hours: hours, failures: failures.slice(0, size), summary });
}

/** The stored submission of a reference, rebuilt as the engine's $defs.submission (the engine picks the templates and the recipients). */
function submissionOf(lead, row) {
  const form = snapshot.forms[lead.form];
  const fields = (() => { try { return JSON.parse(lead.fields_json); } catch { /* a lead whose stored fields are unreadable is retried with the fields it has: none */ return {}; } })();
  const rows = form.fields.map((f) => [f.label, Array.isArray(fields[f.key]) ? fields[f.key].join(", ") : String(fields[f.key] ?? "")]).filter(([, v]) => v !== "");
  return {
    form_id: lead.form, reference: row.reference, form_label: form.label, submitter: { email: lead.email }, test: Boolean(row.test),
    params: { name: lead.name, reference: row.reference, submitted_at: lead.created_at, fields_html: fieldsHtml(rows, { dir: "ltr" }), fields_text: fieldsText(rows) },
  };
}

export async function retryDelivery(ctx) {
  const edb = engineDb(ctx.env), adb = auditDb(ctx.env);
  if (!edb || !adb) return unavailable();
  const reference = ctx.params.reference;
  if (!REFERENCE_RE.test(reference)) return fail(400, "invalid_reference");
  if (!hasService(ctx.env, config.bindings.comms)) return unavailable();
  return idempotent(ctx, "retryDelivery", { reference }, async (key) => {
    const row = await edb.prepare("SELECT * FROM comms_form_deliveries WHERE reference = ?").bind(reference).first().catch((e) => { if (isMissingTable(e)) return null; throw e; });
    if (!row) return fail(404, "not_found");
    const attempted = [...(["sent", "suppressed"].includes(row.receipt_status) ? [] : ["receipt"]), ...(row.owner_status === "sent" ? [] : ["owner"])];
    if (!attempted.length) return fail(409, "nothing_to_retry", "both deliveries have gone");
    const lead = await edb.prepare(`SELECT id, form, name, email, fields_json, created_at FROM ${config.tables.leads} WHERE id = ?`).bind(reference).first().catch((e) => { if (isMissingTable(e)) return null; throw e; });
    if (!lead) return fail(422, "no_stored_submission", "the submission is not stored, so it cannot be handed to the engine again");
    if (lead.form !== row.form_id || !snapshot.forms[lead.form]) return fail(422, "form_mismatch", "the stored submission is not of this delivery's declared form");
    const entry = { actorHash: ctx.identity.actorHash, action: "retryDelivery", targetKind: "delivery", targetId: reference, requestId: ctx.requestId, idempotencyKey: key };
    await auditStatement(adb, { ...entry, outcome: "attempted", detail: { attempted } }).run();     // the intent is on record before the engine is called
    const out = await submitForm({ [config.bindings.comms]: ctx.env[config.bindings.comms], DB: edb }, submissionOf(lead, row), { site: row.site });
    const record = await readDelivery(edb, reference, row.site);
    await auditStatement(adb, { ...entry, outcome: out.recorded === false || TRANSPORT.test(String(out.error ?? "")) ? "failed" : "done", detail: { attempted, receipt: out.receipt, owner: out.owner, ...(out.error ? { error: String(out.error).slice(0, 120) } : {}) } }).run();
    if (out.recorded === false || !record || TRANSPORT.test(String(out.error ?? ""))) return fail(502, "comms_unavailable", out.error);
    return json({ ok: Boolean(out.ok), reference, attempted, record, ...(out.ok ? {} : { error: String(out.error || "delivery_failed").slice(0, 300) }) });
  }, { required: true });
}
