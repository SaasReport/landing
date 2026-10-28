// The shared form intake: bounded bodies, JSON unchanged, multipart refused for forms without a policy, files through the pipeline for forms with one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFormRequest } from "../src/forms-intake.js";
import { createUploads, loadUploadsConfig, memoryBucket, memoryRecords, validateError, RecordError } from "@saasreport/uploads";
import { wire } from "./helpers.mjs";
import { makeKit } from "./helpers.mjs";

const registry = JSON.parse(readFileSync(new URL("../../core/registry/projects.json", import.meta.url), "utf8"));
const enc = (s) => new TextEncoder().encode(s);
const pdfBytes = () => enc("%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n9\n%%EOF\n");

const POLICY = { id: "partner-attachment", file_fields: [{ name: "attachment", max_files: 1 }, { name: "deck", required: false, max_files: 2 }], allowed_types: ["application/pdf", "text/plain"], max_bytes: 100_000, retention_days: 30, on_needs_sandbox: "release_download_only" };
const setup = (policy = POLICY, scanner = null) => {
  const raw = { schema: "kit.uploads-config.v1", project: "saasreport", storage: { quarantine: { binding: "UPLOADS_QUARANTINE", bucket: "saasreport-uploads-quarantine" }, released: { binding: "UPLOADS_RELEASED", bucket: "saasreport-uploads" } }, forms: { partner: { ...policy, ...(scanner ? { scanner: scanner.name } : {}) } } };
  const scanners = scanner ? { [scanner.name]: scanner } : {};
  const env = { UPLOADS_QUARANTINE: memoryBucket(), UPLOADS_RELEASED: memoryBucket() };
  const uploads = createUploads({ config: loadUploadsConfig(raw, { registry, scanners }), env, scanners, records: memoryRecords() });
  return { uploads, env, policy: raw.forms.partner };
};
const post = (body, headers = {}) => new Request("https://x.example/api/forms/partner", { method: "POST", ...wire({ body, headers }) });
const multipart = (parts) => { const fd = new FormData(); for (const [k, v, name, type] of parts) fd.append(k, name ? new File([v], name, { type }) : v); const r = new Request("https://x.example/f", { method: "POST", body: fd }); return r.arrayBuffer().then((buf) => new Request("https://x.example/f", { method: "POST", headers: { "content-type": r.headers.get("content-type"), "content-length": String(buf.byteLength) }, body: buf })); };
const errorOf = async (res) => { const j = await res.json(); assert.deepEqual(validateError(j), [], JSON.stringify(j)); return j; };

test("JSON forms keep working unchanged: the object comes back as the fields", async () => {
  const r = await readFormRequest(post(JSON.stringify({ name: "A", consent: true }), { "content-type": "application/json" }), { form: "partner" });
  assert.equal(r.ok, true); assert.deepEqual(r.fields, { name: "A", consent: true }); assert.deepEqual(r.files, []);
  for (const [ct, body, status, error] of [["text/plain", "x", 415, "bad_content_type"], [undefined, "x", 415, "bad_content_type"], ["application/json", "{nope", 400, "invalid_json"], ["application/json", "[1]", 400, "invalid_json"], ["application/json", "null", 400, "invalid_json"], ["application/x-www-form-urlencoded", "a=1", 415, "bad_content_type"]]) {
    const res = await readFormRequest(post(body, ct ? { "content-type": ct } : {}), { form: "partner" });
    assert.equal(res.ok, false); assert.equal(res.response.status, status, `${ct} ${body}`); assert.equal((await errorOf(res.response)).error, error);
  }
});

test("a JSON body is capped while streaming, needs a Content-Length, and a lying one is refused", async () => {
  const big = JSON.stringify({ notes: "x".repeat(70_000) });
  const over = await readFormRequest(post(big, { "content-type": "application/json" }), { form: "partner" });
  assert.equal(over.response.status, 413); assert.equal((await errorOf(over.response)).error, "too_large");
  let pulled = 0;
  const endless = new Request("https://x.example/f", { method: "POST", headers: { "content-type": "application/json", "content-length": "20" }, body: new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(32768)); } }), duplex: "half" });
  const lying = await readFormRequest(endless, { form: "partner" });
  assert.equal(lying.response.status, 400); assert.ok(pulled < 5, `pulled ${pulled}`);
  const noLen = new Request("https://x.example/f", { method: "POST", headers: { "content-type": "application/json" }, body: new ReadableStream({ start(c) { c.enqueue(enc("{}")); c.close(); } }), duplex: "half" });
  assert.equal((await readFormRequest(noLen, { form: "partner" })).response.status, 411);
});

test("a form without a policy REJECTS multipart file parts explicitly and never reads the body", async () => {
  const fd = new FormData(); fd.append("name", "A"); fd.append("attachment", new File([pdfBytes()], "a.pdf", { type: "application/pdf" }));
  const raw = new Request("https://x.example/f", { method: "POST", body: fd });
  const buf = await raw.arrayBuffer();
  let read = 0;
  const body = new ReadableStream({ pull(c) { read++; c.enqueue(new Uint8Array(buf)); c.close(); } });
  const res = await readFormRequest(new Request("https://x.example/f", { method: "POST", headers: { "content-type": raw.headers.get("content-type"), "content-length": String(buf.byteLength) }, body, duplex: "half" }), { form: "partner" });
  assert.equal(res.ok, false); assert.equal(res.response.status, 415); assert.equal((await errorOf(res.response)).error, "file_parts_not_accepted");
  assert.equal(read, 0, "the body was not read");
  // multipart with text parts only is refused the same way: this form takes JSON
  assert.equal((await readFormRequest(await multipart([["name", "A"]]), { form: "partner" })).response.status, 415);
  // a policy without an uploads pipeline is still "no files"
  assert.equal((await readFormRequest(await multipart([["a", pdfBytes(), "a.pdf", "application/pdf"]]), { form: "partner", policy: POLICY })).response.status, 415);
});

test("a form with a policy takes multipart: fields, and the file through the pipeline (quarantine, sniff, triage, Evidence)", async () => {
  const s = setup();
  const res = await readFormRequest(await multipart([["name", "Parto"], ["consent", "true"], ["attachment", pdfBytes(), "..\\Profile.PDF", "application/pdf"]]), { form: "partner", policy: s.policy, uploads: s.uploads, subject: "lead-9" });
  assert.equal(res.ok, true, res.response && await res.response.text());
  assert.deepEqual(res.fields, { name: "Parto", consent: "true" });
  assert.equal(res.files.length, 1);
  const { record, outcome } = res.files[0];
  assert.deepEqual([res.files[0].field, record.verdict, record.stage, record.declared.filename_normalised, record.subject_ref, outcome.status], ["attachment", "needs_sandbox", "released", "Profile.pdf", "lead-9", "accepted"]);
  assert.equal(record.scan.scanner, "none");
  assert.equal(s.env.UPLOADS_QUARANTINE.objects.size, 1);
});

test("file parts under any other field name, too many files, a missing required file and an oversized file are refused with reason codes", async () => {
  const s = setup({ ...POLICY, file_fields: [{ name: "attachment", required: true, max_files: 1 }] });
  const run = async (parts) => { const r = await readFormRequest(await multipart(parts), { form: "partner", policy: s.policy, uploads: s.uploads }); return [r.response?.status, r.response ? await errorOf(r.response) : r]; };
  let [status, body] = await run([["other", pdfBytes(), "a.pdf", "application/pdf"]]);
  assert.deepEqual([status, body.error, body.field], [422, "file_field_not_accepted", "other"]);
  [status, body] = await run([["attachment", pdfBytes(), "a.pdf", "application/pdf"], ["attachment", pdfBytes(), "b.pdf", "application/pdf"]]);
  assert.deepEqual([status, body.error], [422, "too_many_files"]);
  [status, body] = await run([["name", "A"]]);
  assert.deepEqual([status, body.error, body.field], [422, "file_required", "attachment"]);
  [status, body] = await run([["attachment", new Uint8Array(100_001).fill(65), "big.txt", "text/plain"]]);
  assert.deepEqual([status, body.error], [413, "too_large"]);
  assert.equal(s.env.UPLOADS_QUARANTINE.objects.size, 0);
  // an empty file input (no name, no bytes) is "no file", not a refusal, when the field is optional
  const optional = setup();
  const empty = await readFormRequest(await multipart([["name", "A"], ["attachment", "", "", ""]]), { form: "partner", policy: optional.policy, uploads: optional.uploads });
  assert.equal(empty.ok, true); assert.deepEqual(empty.files, []);
});

test("a refused file answers 422 with its reason code and reference; files accepted earlier in the same request are deleted again", async () => {
  const s = setup();
  const exe = new Uint8Array(0x100); exe.set(enc("MZ")); exe[0x3c] = 0x80; exe.set(enc("PE\0\0"), 0x80);
  const res = await readFormRequest(await multipart([["attachment", pdfBytes(), "ok.pdf", "application/pdf"], ["deck", exe, "deck.pdf", "application/pdf"]]), { form: "partner", policy: s.policy, uploads: s.uploads });
  assert.equal(res.ok, false); assert.equal(res.response.status, 422);
  const body = await errorOf(res.response);
  assert.deepEqual([body.error, body.field], ["type_not_allowed", "deck"]); assert.match(body.reference, /^upl_[0-9a-f]{32}$/);
  assert.equal(s.env.UPLOADS_QUARANTINE.objects.size, 0, "the accepted file of the same request was removed");
  assert.equal(s.env.UPLOADS_RELEASED.objects.size, 0);
  const js = await readFormRequest(await multipart([["attachment", enc("%PDF-1.7\n1 0 obj\n<< /OpenAction << /S /JavaScript /JS (x) >> >>\nendobj\ntrailer\n<< >>\nstartxref\n9\n%%EOF\n"), "j.pdf", "application/pdf"]]), { form: "partner", policy: s.policy, uploads: s.uploads });
  assert.equal((await errorOf(js.response)).error, "active_content_found");
  assert.ok(!JSON.stringify(await readFormRequest(await multipart([["attachment", exe, "x.pdf", "application/pdf"]]), { form: "partner", policy: s.policy, uploads: s.uploads }).then((r) => r.response.json())).match(/JavaScript|signature|stack/i));
});

test("multipart limits: the whole request is capped while reading; a text field over the field cap; garbage multipart", async () => {
  const s = setup({ ...POLICY, max_request_bytes: 150_000, max_field_bytes: 1000 });
  const huge = await readFormRequest(await multipart([["attachment", new Uint8Array(160_000).fill(65), "a.txt", "text/plain"]]), { form: "partner", policy: s.policy, uploads: s.uploads });
  assert.equal(huge.response.status, 413);
  const field = await readFormRequest(await multipart([["notes", "x".repeat(2000)]]), { form: "partner", policy: { ...s.policy, file_fields: [{ name: "attachment" }] }, uploads: s.uploads });
  assert.deepEqual([field.response.status, (await field.response.json()).field], [413, "notes"]);
  const garbage = new Request("https://x.example/f", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=zzz", "content-length": "9" }, body: "not parts" });
  const g = await readFormRequest(garbage, { form: "partner", policy: s.policy, uploads: s.uploads });
  assert.deepEqual([g.response.status, (await g.response.json()).error], [400, "invalid_multipart"]);
});

test("the kit's own JSON handlers refuse an oversized or length-less body before parsing it (reactions, event RSVP, podcasts admin, calendar API, MCP)", async () => {
  const { get } = makeKit("fa");
  const big = JSON.stringify({ x: "y".repeat(70_000) });
  for (const [path, headers] of [["/api/reactions", { "content-type": "application/json" }], ["/api/calendar/schedule", { "content-type": "application/json" }], ["/mcp", { "content-type": "application/json" }]]) {
    const r = await get(path, { method: "POST", headers: { ...headers, "content-length": String(big.length) }, body: big });
    assert.equal(r.status, 413, path); assert.equal((await errorOf(r)).error, "too_large");
  }
  const noLen = await get("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: new ReadableStream({ start(c) { c.enqueue(enc("{}")); c.close(); } }), duplex: "half" });
  assert.equal(noLen.status, 411);
});

test("an Evidence record that does not validate answers 503 could_not_check and rolls back the files already accepted in the request (it used to be an uncaught 500 that left them)", async () => {
  const s = setup();
  const real = s.uploads.intake;
  let n = 0;
  const uploads = { ...s.uploads, intake: async (a) => { if (++n === 2) throw new RecordError(["/triage/markers/0/first_ref: must have at most 80 characters"]); return real(a); }, delete: s.uploads.delete };
  const res = await readFormRequest(await multipart([["attachment", pdfBytes(), "ok.pdf", "application/pdf"], ["deck", pdfBytes(), "deck.pdf", "application/pdf"]]), { form: "partner", policy: s.policy, uploads });
  assert.equal(res.ok, false); assert.equal(res.response.status, 503);
  const body = await errorOf(res.response);
  assert.deepEqual([body.error, body.field], ["could_not_check", "deck"]);
  assert.equal(s.env.UPLOADS_QUARANTINE.objects.size, 0, "the first file was removed again"); assert.equal(s.env.UPLOADS_RELEASED.objects.size, 0);
  // any other error is not swallowed, but the rollback happened first
  n = 0;
  const boom = { ...s.uploads, intake: async (a) => { if (++n === 2) throw new Error("storage down"); return real(a); }, delete: s.uploads.delete };
  await assert.rejects(readFormRequest(await multipart([["attachment", pdfBytes(), "ok.pdf", "application/pdf"], ["deck", pdfBytes(), "deck.pdf", "application/pdf"]]), { form: "partner", policy: s.policy, uploads: boom }), /storage down/);
  assert.equal(s.env.UPLOADS_QUARANTINE.objects.size, 0);
});

test("a zip with a 60000-character entry name is refused with its reason code and has an Evidence record; no 500", async () => {
  const policy = { ...POLICY, allowed_types: ["application/pdf", "application/zip"], max_bytes: 400_000 };
  const s = setup(policy);
  const { zip } = await import("../../uploads/test/fixtures.mjs");
  const res = await readFormRequest(await multipart([["attachment", pdfBytes(), "ok.pdf", "application/pdf"], ["deck", zip([{ name: `${"a".repeat(60000)}.exe`, data: "x" }]), "d.zip", "application/zip"]]), { form: "partner", policy: s.policy, uploads: s.uploads });
  assert.equal(res.ok, false); assert.equal(res.response.status, 422);
  const body = await errorOf(res.response);
  assert.equal(body.error, "active_content_found"); assert.match(body.reference, /^upl_/);
  assert.equal(s.env.UPLOADS_QUARANTINE.objects.size > 0, true, "the blocked upload is kept as evidence (its first file was undone)");
});

test("L1: a withdrawal that fails during the rollback is signalled (leftBehind and onLeftBehind), never swallowed; the refusal is still returned", async () => {
  const s = setup();
  const real = s.uploads.intake;
  let n = 0;
  const failing = { ...s.uploads, intake: async (a) => { if (++n === 2) throw new RecordError(["/x: bad"]); return real(a); }, withdraw: async () => { throw Object.assign(new Error("storage down"), { reason: "storage_down" }); } };
  const seen = [];
  const res = await readFormRequest(await multipart([["attachment", pdfBytes(), "ok.pdf", "application/pdf"], ["deck", pdfBytes(), "deck.pdf", "application/pdf"]]), { form: "partner", policy: s.policy, uploads: failing, onLeftBehind: (l) => seen.push(...l) });
  assert.equal(res.response.status, 503);
  assert.equal(res.leftBehind.length, 1);
  assert.match(res.leftBehind[0].upload_id, /^upl_[0-9a-f]{32}$/);
  assert.equal(res.leftBehind[0].reason, "storage_down");
  assert.deepEqual(seen, res.leftBehind);
  // and the rollback uses the capability intake returned: withdrawing with the real engine needs it
  n = 0;
  const ok = await readFormRequest(await multipart([["attachment", pdfBytes(), "ok.pdf", "application/pdf"], ["deck", pdfBytes(), "deck.pdf", "application/pdf"]]), { form: "partner", policy: s.policy, uploads: { ...s.uploads, intake: async (a) => { if (++n === 2) throw new RecordError(["/x: bad"]); return real(a); } } });
  assert.deepEqual(ok.leftBehind, []);
});
