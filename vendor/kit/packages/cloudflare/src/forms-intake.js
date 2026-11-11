/**
 * The shared form intake: what a form handler calls instead of `request.json()`.
 *
 *   const r = await readFormRequest(request, { form, policy, uploads, subject, accept });
 *   if (!r.ok) return r.response;            // a kit.upload-error.v1 JSON response
 *   r.fields                                 // the text fields (an object; a repeated name is an array)
 *   r.files                                  // [{ field, record, outcome, withdrawToken }] one per accepted file (policy forms only)
 *   r.leftBehind                             // on a refusal: the earlier files whose withdrawal FAILED ([{ upload_id, reason }]); also handed to `onLeftBehind`
 *
 * - The body is read through the bounded reader: the cap is enforced while it streams, Content-Length is required, a lying one is
 *   refused. Nothing is buffered before the cap.
 * - A form WITHOUT a policy takes no files. A multipart request to it is refused up front (415 file_parts_not_accepted) and its body
 *   is never read; JSON stays exactly as before (415 bad_content_type for anything else, 400 invalid_json).
 * - A form WITH an UploadPolicy (kit.upload-policy.v1, from uploads.config.json) takes multipart: file parts only under the
 *   policy's file_fields (422 file_field_not_accepted otherwise), at most max_files each, each through uploads.intake (size, sniff,
 *   triage, scan, quarantine, Evidence). A refused file answers 422 with the reason code and the upload reference, and the files
 *   accepted before it in the same request are deleted again. An intake that throws (an Evidence record that does not validate, a
 *   storage error) deletes them again too; a RecordError answers 503 could_not_check.
 * - `accept` lists the encodings the form takes besides multipart: "json" (default) and "urlencoded".
 */
import { readBounded, readBoundedJson, BodyError, bodyErrorResponse, publicOutcome, refusalBody, RecordError } from "@saasreport/uploads";

const MiB = 1024 * 1024;
const fail = (error, status, extra = {}) => ({ ok: false, response: new Response(JSON.stringify({ ok: false, error, ...extra }), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }) });
const baseType = (request) => (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();

const addField = (fields, name, value) => { if (name in fields) fields[name] = [].concat(fields[name], value); else fields[name] = value; };

export async function readFormRequest(request, { form, policy = null, uploads = null, subject = null, accept = ["json"], maxJsonBytes = 64 * 1024, onLeftBehind = null } = {}) {
  const type = baseType(request);
  if (type === "multipart/form-data") {
    if (!policy || !uploads) { try { await request.body?.cancel(); } catch { /* the stream is already closed or errored: nothing is left to release */ } return fail("file_parts_not_accepted", 415); }
    return multipart(request, { form, policy, uploads, subject, onLeftBehind });
  }
  try {
    if (type === "application/json" || type.endsWith("+json")) {
      if (!accept.includes("json")) return fail("bad_content_type", 415);
      const { value } = await readBoundedJson(request, { maxBytes: maxJsonBytes });
      if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid_json", 400);
      return { ok: true, fields: value, files: [] };
    }
    if (type === "application/x-www-form-urlencoded" && accept.includes("urlencoded")) {
      const { bytes } = await readBounded(request, { maxBytes: maxJsonBytes });
      const fields = {};
      for (const [k, v] of new URLSearchParams(new TextDecoder().decode(bytes))) addField(fields, k, v);
      return { ok: true, fields, files: [] };
    }
  } catch (e) { if (e instanceof BodyError) return { ok: false, response: bodyErrorResponse(e) }; throw e; }
  return fail("bad_content_type", 415);
}

async function multipart(request, { form, policy, uploads, subject, onLeftBehind }) {
  const maxFiles = policy.file_fields.reduce((n, f) => n + (f.max_files ?? 1), 0);
  const maxRequest = policy.max_request_bytes ?? policy.max_bytes * maxFiles + MiB;
  const maxField = policy.max_field_bytes ?? 64 * 1024;
  let bytes;
  try { ({ bytes } = await readBounded(request, { maxBytes: maxRequest })); }
  catch (e) { if (e instanceof BodyError) return { ok: false, response: bodyErrorResponse(e) }; throw e; }
  let data;
  try { data = await new Response(bytes, { headers: { "content-type": request.headers.get("content-type") } }).formData(); }
  catch { return fail("invalid_multipart", 400); }

  const fields = {}, incoming = new Map();
  for (const [name, value] of data.entries()) {
    if (typeof value === "string") {
      if (new TextEncoder().encode(value).length > maxField) return fail("too_large", 413, { field: name.slice(0, 80) });
      addField(fields, name, value);
      continue;
    }
    if (value.size === 0 && !value.name) continue;   // a file input left empty
    const def = policy.file_fields.find((f) => f.name === name);
    if (!def) return fail("file_field_not_accepted", 422, { field: name.slice(0, 80) });
    const list = incoming.get(name) || [];
    list.push(value);
    if (list.length > (def.max_files ?? 1)) return fail("too_many_files", 422, { field: name });
    incoming.set(name, list);
  }
  for (const f of policy.file_fields) if (f.required && !incoming.has(f.name)) return fail("file_required", 422, { field: f.name });

  const files = [];
  for (const [field, list] of incoming) {
    for (const file of list) {
      if (file.size > policy.max_bytes) return { ...fail("too_large", 413, { field }), leftBehind: await undo(uploads, files, onLeftBehind) };
      let record, outcome, withdrawToken;
      try { ({ record, outcome, withdrawToken } = await uploads.intake({ form, bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name, contentType: file.type || null, subject })); }
      catch (e) {
        // fail closed and leave nothing behind: the files accepted before this one go too. An Evidence record that does not validate is
        // "could not check" (503), not a crash; any other error still surfaces after the rollback.
        const leftBehind = await undo(uploads, files, onLeftBehind);
        if (e instanceof RecordError) return { ...fail("could_not_check", 503, { field }), leftBehind };
        if (e && typeof e === "object") e.leftBehind = leftBehind;
        throw e;
      }
      if (!outcome.accepted) { const leftBehind = await undo(uploads, files, onLeftBehind); const b = refusalBody(outcome, field); return { ok: false, leftBehind, response: new Response(JSON.stringify(b), { status: 422, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }) }; }
      files.push({ field, record, outcome, withdrawToken });
    }
  }
  return { ok: true, fields, files };
}

/**
 * Withdraw the files this request accepted before it failed, with the capability intake returned for each (nothing else can withdraw an
 * upload). A withdrawal that fails is NOT silent: it is returned as `leftBehind` ([{ upload_id, reason }]) on the failed result (or on the
 * error thrown) and handed to `onLeftBehind`, so the operator knows which uploads are still in quarantine until the retention sweep.
 */
async function undo(uploads, files, onLeftBehind) {
  const left = [];
  for (const f of files) {
    try { await uploads.withdraw(f.record.upload_id, f.withdrawToken); }
    catch (e) { left.push({ upload_id: f.record.upload_id, reason: String(e?.reason ?? e?.name ?? "error").slice(0, 60) }); }
  }
  if (left.length && typeof onLeftBehind === "function") { try { await onLeftBehind(left); } catch { /* a failing signal must not hide the refusal */ } }
  return left;
}

export { publicOutcome };
