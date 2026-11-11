// The pipeline end to end on in-memory R2 buckets: quarantine first, content-addressed keys, release only on an allowing
// verdict, one Evidence record per upload that validates against the contract, retention and deletion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TransitionError, AuthError } from "../src/index.js";
import { createUploads, loadUploadsConfig, ConfigError, memoryBucket, memoryRecords, validateRecord, VERDICTS, IntegrityError, UnknownFormError, sha256Hex, quarantineKey, releasedKey, UPLOAD_COPY, publicOutcome } from "../src/index.js";
import { cat, enc, pdf, png, ooxml, zip, pdfWithObjStm, eicarLike } from "./fixtures.mjs";
import { people, decide } from "./helpers/people.mjs";
import { evidenceOf } from "./helpers/evidence.mjs";

const registry = JSON.parse(readFileSync(new URL("../../core/registry/projects.json", import.meta.url), "utf8"));
const PDF_TYPE = "application/pdf";
const rawConfig = (over = {}) => ({
  schema: "kit.uploads-config.v1", project: "saasreport",
  storage: { quarantine: { binding: "UPLOADS_QUARANTINE", bucket: "saasreport-uploads-quarantine" }, released: { binding: "UPLOADS_RELEASED", bucket: "saasreport-uploads" } },
  forms: {
    partner: { id: "partner-attachment", file_fields: [{ name: "attachment" }], allowed_types: [PDF_TYPE, "image/png", "text/plain", "application/zip"], max_bytes: 5 * 1024 * 1024, retention_days: 30, blocked_retention_days: 7, on_needs_sandbox: "hold", scanner: "fake-av" },
    "no-scan": { id: "noscan-attachment", file_fields: [{ name: "attachment" }], allowed_types: [PDF_TYPE, "text/plain"], max_bytes: 1024 * 1024, retention_days: 30, on_needs_sandbox: "release_download_only" },
    "hold-form": { id: "hold-attachment", file_fields: [{ name: "attachment" }], allowed_types: [PDF_TYPE], max_bytes: 1024 * 1024, retention_days: 30, on_needs_sandbox: "hold" },
  },
  ...over,
});
const fakeAv = (verdictFor = () => "allow") => ({ name: "fake-av", version: "9.1", scan: async ({ bytes }) => ({ verdict: verdictFor(bytes), signature_db_version: "db-1" }) });
const eicar = () => enc(eicarLike());

function setup({ scanners = { "fake-av": fakeAv() }, cfg = rawConfig(), clock } = {}) {
  const env = { UPLOADS_QUARANTINE: memoryBucket(), UPLOADS_RELEASED: memoryBucket() };
  const records = memoryRecords();
  let t = clock ?? Date.parse("2026-10-07T12:00:00Z");
  const now = () => new Date(t);
  const P = people(now);
  const config = loadUploadsConfig(cfg, { registry, scanners });
  const uploads = createUploads({ config, env, scanners, records, now, authority: P.authority });
  const sign = (record, action, note) => P.sign(record, action, note, { decided_at: now().toISOString() });
  return { ...decide(uploads, records, sign), sign, env, records, uploads, config, tick: (ms) => { t += ms; }, q: env.UPLOADS_QUARANTINE, r: env.UPLOADS_RELEASED };
}

test("config: valid, project prefix enforced, buckets must differ, scanner must be wired, nothing legacy", () => {
  const scanners = { "fake-av": fakeAv() };
  assert.doesNotThrow(() => loadUploadsConfig(rawConfig(), { registry, scanners }));
  const bad = (over, re) => assert.throws(() => loadUploadsConfig(rawConfig(over), { registry, scanners }), (e) => e instanceof ConfigError && re.test(e.message), JSON.stringify(over).slice(0, 80));
  bad({ storage: { quarantine: { binding: "QUAR", bucket: "other-uploads-quarantine" }, released: { binding: "REL", bucket: "saasreport-uploads" } } }, /quarantine bucket other-uploads-quarantine must start with saasreport-/);
  const retired = { ...registry, legacy: [{ prefix: "old-", belongsTo: "saasreport", action: "archive, then delete" }] };
  assert.throws(() => loadUploadsConfig(rawConfig({ storage: { quarantine: { binding: "QUAR", bucket: "old-uploads-quarantine" }, released: { binding: "REL", bucket: "saasreport-uploads" } } }), { registry: retired, scanners }), /legacy prefix/);
  bad({ storage: { quarantine: { binding: "Q1", bucket: "saasreport-uploads" }, released: { binding: "R1", bucket: "saasreport-uploads" } } }, /different buckets/);
  bad({ storage: { quarantine: { binding: "Q1", bucket: "saasreport-uploads-q" }, released: { binding: "Q1", bucket: "saasreport-uploads" } } }, /different bindings/);
  bad({ project: "nonesuch" }, /not in the project registry/);
  assert.throws(() => loadUploadsConfig(rawConfig(), { registry, scanners: {} }), /scanner "fake-av" is not wired/);
  assert.throws(() => loadUploadsConfig({ ...rawConfig(), schema: "x" }, { registry, scanners }), ConfigError);
  const dup = rawConfig(); dup.forms["no-scan"].id = dup.forms.partner.id;
  assert.throws(() => loadUploadsConfig(dup, { registry, scanners }), /used by two forms/);
  const lim = rawConfig(); lim.forms.partner.limits = { max_ratio: 5000 };
  assert.throws(() => loadUploadsConfig(lim, { registry, scanners }), ConfigError);
  // another registered project's own prefix works for its own config
  const two = { ...registry, projects: [...registry.projects, { key: "acme", name: "Acme", domain: "acme.example", prefix: "acme-", short: null }] };
  const acme = rawConfig({ project: "acme", storage: { quarantine: { binding: "QUAR", bucket: "acme-uploads-quarantine" }, released: { binding: "REL", bucket: "acme-uploads" } } });
  assert.doesNotThrow(() => loadUploadsConfig(acme, { registry: two, scanners }));
});

test("createUploads fails closed: a missing quarantine binding means no accepted upload", () => {
  const config = loadUploadsConfig(rawConfig(), { registry, scanners: { "fake-av": fakeAv() } });
  assert.throws(() => createUploads({ config, env: { UPLOADS_RELEASED: memoryBucket() }, records: memoryRecords() }), /UPLOADS_QUARANTINE/);
  assert.throws(() => createUploads({ config, env: { UPLOADS_QUARANTINE: memoryBucket(), UPLOADS_RELEASED: memoryBucket() } }), /records sink/);
  assert.throws(() => createUploads({ config: rawConfig(), env: {}, records: memoryRecords() }), /loadUploadsConfig/);
});

test("a benign PDF with a scanner that allows: quarantined first, then released; record valid; allow_with_limits, download only", async () => {
  const { uploads, q, r, records } = setup();
  const bytes = pdf();
  const { record, outcome } = await uploads.intake({ form: "partner", bytes, filename: "..\\Profile.PDF", contentType: PDF_TYPE, subject: "lead-1" });
  assert.deepEqual(validateRecord(record), []);
  assert.deepEqual([record.verdict, record.stage, record.reason_code], ["allow_with_limits", "released", "none"]);
  assert.deepEqual(record.limits, ["download_only", "open_only_in_sandbox"]);
  assert.equal(record.sha256, await sha256Hex(bytes));
  assert.equal(record.declared.filename, "..\\Profile.PDF"); assert.equal(record.declared.filename_normalised, "Profile.pdf");
  assert.equal(record.storage.key, quarantineKey("partner", record.sha256, record.upload_id)); assert.equal(record.storage.released_key, releasedKey("partner", record.sha256, record.upload_id));
  assert.ok(!record.storage.key.includes("Profile") && !record.storage.key.includes("pdf"), "the filename is never part of a key");
  assert.equal(record.storage.public_read, false);
  assert.equal(record.scan.scanner, "fake-av"); assert.equal(record.scan.scanner_version, "9.1"); assert.equal(record.scan.signature_db_version, "db-1");
  assert.equal(record.policy_id, "partner-attachment"); assert.equal(record.project, "saasreport");
  assert.equal(record.triage.statement, "no known active-content markers found; opening still needs a sandbox");
  assert.deepEqual([outcome.accepted, outcome.status, outcome.reference], [true, "accepted", record.upload_id]);
  assert.ok(q.objects.has(record.storage.key) && r.objects.has(record.storage.released_key));
  assert.deepEqual(await records.get(record.upload_id), record);
  assert.equal(record.retention.retain_until, "2026-11-06T12:00:00.000Z");
});

test("no scanner configured: needs_sandbox; the form either holds the file in quarantine or releases it for download only", async () => {
  const s = setup();
  const held = await s.uploads.intake({ form: "hold-form", bytes: pdf(), filename: "a.pdf", contentType: PDF_TYPE });
  assert.deepEqual([held.record.verdict, held.record.stage, held.record.reason_code, held.record.scan.scanner, held.record.scan.status], ["needs_sandbox", "held", "scanner_not_configured", "none", "not_run"]);
  assert.equal(held.record.storage.released_key, null); assert.equal(s.r.objects.size, 0);
  assert.equal(held.outcome.status, "under_review");
  const rel = await s.uploads.intake({ form: "no-scan", bytes: pdf(), filename: "a.pdf", contentType: PDF_TYPE });
  assert.deepEqual([rel.record.verdict, rel.record.stage, rel.record.limits], ["needs_sandbox", "released", ["download_only", "open_only_in_sandbox"]]);
  assert.ok(s.r.objects.has(rel.record.storage.released_key));
  assert.equal(rel.outcome.status, "accepted");
  assert.deepEqual(validateRecord(held.record), []); assert.deepEqual(validateRecord(rel.record), []);
});

test("a PE file named x.pdf with media type application/pdf is refused at the edge and nothing is stored", async () => {
  const s = setup();
  const pe = new Uint8Array(0x100); pe.set(enc("MZ")); pe[0x3c] = 0x80; pe.set(enc("PE\0\0"), 0x80);
  const { record, outcome } = await s.uploads.intake({ form: "partner", bytes: pe, filename: "x.pdf", contentType: PDF_TYPE });
  assert.deepEqual([record.verdict, record.reason_code, record.stage, record.storage.stored], ["block", "type_not_allowed", "rejected", false]);
  assert.deepEqual([outcome.accepted, outcome.status, outcome.code], [false, "blocked", "type_not_allowed"]);
  assert.equal(s.q.objects.size, 0); assert.equal(s.r.objects.size, 0);
  assert.deepEqual(validateRecord(record), []);
});

test("an over-size file is refused at the edge; a PDF with JavaScript is blocked and kept in quarantine only", async () => {
  const s = setup();
  const big = await s.uploads.intake({ form: "no-scan", bytes: new Uint8Array(2 * 1024 * 1024).fill(65), filename: "a.txt", contentType: "text/plain" });
  assert.deepEqual([big.record.reason_code, big.record.stage], ["too_large", "rejected"]);
  const js = await s.uploads.intake({ form: "partner", bytes: pdf(["<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>"]), filename: "a.pdf", contentType: PDF_TYPE });
  assert.deepEqual([js.record.verdict, js.record.reason_code, js.record.stage], ["block", "active_content_found", "blocked"]);
  assert.ok(s.q.objects.has(js.record.storage.key)); assert.equal(s.r.objects.size, 0);
  assert.ok(js.record.triage.markers.some((m) => m.name === "JavaScript"));
  assert.equal(js.record.scan.status, "not_run");   // a certain block does not spend a scan
  assert.equal(js.record.retention.retain_until, "2026-10-14T12:00:00.000Z");
  const hidden = await s.uploads.intake({ form: "partner", bytes: pdfWithObjStm("<< /J#53 1 0 R /Launch 1 0 R >>"), filename: "a.pdf", contentType: PDF_TYPE });
  assert.equal(hidden.record.verdict, "block");
});

test("type mismatch, a polyglot, a zip bomb and a nested archive are blocked with their reasons", async () => {
  const s = setup();
  const mismatch = await s.uploads.intake({ form: "partner", bytes: png(), filename: "report.pdf", contentType: PDF_TYPE });
  assert.equal(mismatch.record.reason_code, "type_mismatch");
  const poly = await s.uploads.intake({ form: "partner", bytes: cat(png(), enc("<script>alert(1)</script>")), filename: "a.png", contentType: "image/png" });
  assert.equal(poly.record.reason_code, "polyglot_suspect");
  const bomb = await s.uploads.intake({ form: "partner", bytes: zip([{ name: "z.bin", data: new Uint8Array(20 * 1024 * 1024) }]), filename: "a.zip", contentType: "application/zip" });
  assert.deepEqual([bomb.record.verdict, bomb.record.reason_code], ["block", "archive_bomb"]);
  const nested = await s.uploads.intake({ form: "partner", bytes: zip([{ name: "i.zip", data: zip([{ name: "a", data: "x" }]), method: 0 }]), filename: "a.zip", contentType: "application/zip" });
  assert.equal(nested.record.reason_code, "archive_not_allowed");
  assert.equal(s.r.objects.size, 0);
});

test("EICAR-style content reaches a pluggable scanner: its block becomes malware_detected and nothing is released", async () => {
  const s = setup({ scanners: { "fake-av": fakeAv((b) => (new TextDecoder().decode(b).includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE") ? "block" : "allow")) } });
  const hit = await s.uploads.intake({ form: "partner", bytes: eicar(), filename: "note.txt", contentType: "text/plain" });
  assert.deepEqual([hit.record.verdict, hit.record.reason_code, hit.record.scan.status, hit.record.stage], ["block", "malware_detected", "detected", "blocked"]);
  assert.equal(s.r.objects.size, 0);
  const fine = await s.uploads.intake({ form: "partner", bytes: enc("hello"), filename: "note.txt", contentType: "text/plain" });
  assert.deepEqual([fine.record.verdict, fine.record.stage], ["allow", "released"]);
});

test("a scanner that fails or answers 'clean' leaves the file held as scan_failed, never released", async () => {
  for (const scan of [async () => ({ verdict: "clean" }), async () => { throw new Error("down"); }, async () => ({})]) {
    const s = setup({ scanners: { "fake-av": { name: "fake-av", version: "1", scan } } });
    const { record, outcome } = await s.uploads.intake({ form: "partner", bytes: pdf(), filename: "a.pdf", contentType: PDF_TYPE });
    assert.deepEqual([record.verdict, record.stage, record.reason_code], ["scan_failed", "quarantined", "could_not_check"]);
    assert.equal(s.r.objects.size, 0); assert.equal(outcome.status, "could_not_check");
  }
});

test("keys belong to the upload: the same file twice is two objects and two records; a name that looks like a key changes nothing", async () => {
  const s = setup();
  const a = await s.uploads.intake({ form: "partner", bytes: pdf(), filename: "one.pdf", contentType: PDF_TYPE, subject: "A" });
  const b = await s.uploads.intake({ form: "partner", bytes: pdf(), filename: "two.pdf", contentType: PDF_TYPE, subject: "B" });
  assert.notEqual(a.record.upload_id, b.record.upload_id); assert.notEqual(a.record.storage.key, b.record.storage.key);
  assert.equal(a.record.sha256, b.record.sha256);
  assert.ok(a.record.storage.key.includes(a.record.sha256) && a.record.storage.key.startsWith(`q/${a.record.upload_id}/partner/`));
  assert.equal(s.q.objects.size, 2);
  const c = await s.uploads.intake({ form: "partner", bytes: pdf(["<< /Type /Catalog /Pages 2 0 R /Other 1 >>", "<< /Type /Pages /Kids [] /Count 0 >>"]), filename: "one.pdf", contentType: PDF_TYPE });
  assert.notEqual(c.record.storage.key, a.record.storage.key); assert.equal(s.q.objects.size, 3);
  const d = await s.uploads.intake({ form: "partner", bytes: pdf(), filename: `q/${a.record.upload_id}/partner/${a.record.sha256}`, contentType: PDF_TYPE });
  assert.notEqual(d.record.storage.key, a.record.storage.key); assert.equal(s.q.objects.size, 4);
  assert.throws(() => quarantineKey("partner", a.record.sha256, "../x"), /upload id/);
  assert.throws(() => releasedKey("partner", a.record.sha256), /upload id/);
});

test("a person releases a held file by a signed decision; the decision is in the record; a blocked one is not releasable; unsigned or forged decisions are refused", async () => {
  const s = setup();
  const held = (await s.uploads.intake({ form: "hold-form", bytes: pdf(), filename: "a.pdf", contentType: PDF_TYPE })).record;
  const out = await s.release(held.upload_id, "opened in the sandbox");
  assert.deepEqual([out.stage, out.verdict, out.limits], ["released", "needs_sandbox", ["download_only", "open_only_in_sandbox"]]);
  assert.equal(out.decisions[0].action, "release"); assert.deepEqual(validateRecord(out), []);
  assert.ok(s.r.objects.has(out.storage.released_key));
  const blocked = (await s.uploads.intake({ form: "partner", bytes: pdf(["<< /Launch 1 0 R >>"]), filename: "b.pdf", contentType: PDF_TYPE })).record;
  await assert.rejects(s.release(blocked.upload_id), TransitionError);
  await s.uploads.assertConsistent();
  const other = (await s.uploads.intake({ form: "hold-form", bytes: pdf(["<< /X 1 >>"]), filename: "c.pdf", contentType: PDF_TYPE })).record;
  await assert.rejects(s.uploads.release(other.upload_id, {}), AuthError);
  await assert.rejects(s.release("upl_" + "0".repeat(32)), /unknown upload/);
});
test("release verifies the quarantined object again: a tampered or missing object is an IntegrityError", async () => {
  const s = setup();
  const held = (await s.uploads.intake({ form: "hold-form", bytes: pdf(), filename: "a.pdf", contentType: PDF_TYPE })).record;
  s.q.objects.get(held.storage.key).bytes[10] ^= 0xff;
  await assert.rejects(s.release(held.upload_id), IntegrityError);
  s.q.objects.delete(held.storage.key);
  await assert.rejects(s.release(held.upload_id), /missing from quarantine/);
});

test("rescan: a quarantined scan_failed file is re-evaluated; a good answer is recorded but NOT applied (a rescan only tightens); a person's release() releases it", async () => {
  let mode = "down";
  const av = { name: "fake-av", version: "2", scan: async () => { if (mode === "down") throw new Error("down"); return { verdict: mode }; } };
  const s = setup({ scanners: { "fake-av": av } });
  const rec = (await s.uploads.intake({ form: "partner", bytes: pdf(), filename: "a.pdf", contentType: PDF_TYPE })).record;
  assert.equal(rec.verdict, "scan_failed");
  mode = "allow";
  const ok = await s.uploads.rescan(rec.upload_id);
  assert.deepEqual([ok.verdict, ok.stage], ["scan_failed", "quarantined"]); assert.equal(s.r.objects.size, 0); assert.match((await evidenceOf(s.q, rec.upload_id)).at(-1).note, /only tighten/, "the note is in the evidence log"); assert.equal(ok.decisions?.length ?? 0, 0, "and the record has no system decision");
  const out = await s.release(rec.upload_id, "scanner back, clean");
  assert.equal(out.stage, "released"); assert.ok(s.r.objects.has(out.storage.released_key));
  mode = "block";
  const rec2 = (await s.uploads.intake({ form: "partner", bytes: pdf(["<< /Type /Catalog /Pages 2 0 R /Z 1 >>", "<< /Type /Pages /Kids [] /Count 0 >>"]), filename: "b.pdf", contentType: PDF_TYPE })).record;
  assert.equal(rec2.verdict, "block");
});

test("retention: a sweep deletes expired uploads, keeps a tombstone, honours a hold, and leaves the other upload of the same bytes alone", async () => {
  const s = setup();
  const a = (await s.uploads.intake({ form: "partner", bytes: pdf(), filename: "a.pdf", contentType: PDF_TYPE })).record;
  s.tick(10 * 86_400_000);
  const b = (await s.uploads.intake({ form: "partner", bytes: pdf(), filename: "a.pdf", contentType: PDF_TYPE })).record;   // same bytes, its own objects, newer record
  assert.notEqual(a.storage.key, b.storage.key);
  s.tick(25 * 86_400_000);   // a is past 30 days, b is not
  assert.equal((await s.uploads.sweep()).deleted, 1);
  const aDeleted = await s.records.get(a.upload_id);
  assert.deepEqual([aDeleted.stage, typeof aDeleted.retention.deleted_at, aDeleted.sha256], ["deleted", "string", a.sha256]);
  assert.equal(s.q.objects.has(a.storage.key), false); assert.equal(s.r.objects.has(a.storage.released_key), false);
  assert.ok(s.q.objects.has(b.storage.key) && s.r.objects.has(b.storage.released_key), "b keeps its own objects");
  assert.equal((await s.records.get(b.upload_id)).stage, "released");
  s.tick(10 * 86_400_000);
  await s.hold(b.upload_id, true);
  assert.equal((await s.uploads.sweep()).deleted, 0);
  await s.hold(b.upload_id, false);
  assert.equal((await s.uploads.sweep()).deleted, 1);
  assert.equal(s.q.objects.size, 0); assert.equal(s.r.objects.size, 0);
  assert.deepEqual(validateRecord(await s.records.get(b.upload_id)), []);
  assert.equal((await s.uploads.sweep()).deleted, 0);
});

test("delete versus an upload of the same bytes: there is no window, each upload keeps its own object whatever the interleaving", async () => {
  const s = setup();
  const a = (await s.uploads.intake({ form: "partner", bytes: pdf(), filename: "a.pdf", contentType: PDF_TYPE })).record;
  // the old race: remove() decides nobody else needs the object, a concurrent intake of identical bytes lands, remove() deletes
  let injected;
  const realDelete = s.q.delete.bind(s.q);
  s.q.delete = async (key) => { injected ??= await s.uploads.intake({ form: "partner", bytes: pdf(), filename: "b.pdf", contentType: PDF_TYPE }); return realDelete(key); };
  await s.del(a.upload_id);
  const b = injected.record;
  assert.equal(s.q.objects.has(a.storage.key), false);
  assert.ok(s.q.objects.has(b.storage.key) && s.r.objects.has(b.storage.released_key), "the concurrent upload still has its bytes");
  assert.equal((await s.uploads.rescan(b.upload_id)).stage, "released");   // loads and verifies the object: no IntegrityError
});

test("a record whose keys are not derived from it (an imported record that shares another record's keys) is re-keyed before any object is deleted: the other record keeps its objects", async () => {
  const s = setup();
  const a = (await s.uploads.intake({ form: "partner", bytes: pdf(), filename: "a.pdf", contentType: PDF_TYPE })).record;
  const { version: _v, ...copy } = structuredClone(a);
  const cloneId = `upl_${"a".repeat(32)}`;
  await s.records.put({ ...copy, upload_id: cloneId });   // a second record that points at the same keys
  assert.equal((await s.uploads.reconcile()).ok, false);
  const gone = await s.del(cloneId);
  assert.equal(gone.stage, "deleted");
  assert.ok(s.q.objects.has(a.storage.key) && s.r.objects.has(a.storage.released_key), "a's objects were never touched");
  assert.equal((await s.uploads.reconcile()).ok, true);
});
test("blocked objects are deleted after blocked_retention_days (7 by default)", async () => {
  const s = setup();
  const blocked = (await s.uploads.intake({ form: "partner", bytes: pdf(["<< /Launch 1 0 R >>"]), filename: "a.pdf", contentType: PDF_TYPE })).record;
  s.tick(6 * 86_400_000); assert.equal((await s.uploads.sweep()).deleted, 0);
  s.tick(2 * 86_400_000); assert.equal((await s.uploads.sweep()).deleted, 1);
  assert.equal(s.q.objects.has(blocked.storage.key), false);
});

test("customer-initiated deletion (DSAR erase) uses the same path and is idempotent", async () => {
  const s = setup();
  const a = (await s.uploads.intake({ form: "partner", bytes: pdf(), filename: "a.pdf", contentType: PDF_TYPE })).record;
  const del = await s.del(a.upload_id, "erasure request");
  assert.equal(del.stage, "deleted"); assert.equal(s.q.objects.size, 0); assert.equal(s.r.objects.size, 0);
  assert.equal((await s.del(a.upload_id)).stage, "deleted");
});

test("an unknown form is an error, not a default policy", async () => {
  const s = setup();
  await assert.rejects(s.uploads.intake({ form: "nope", bytes: pdf() }), UnknownFormError);
  await assert.rejects(s.uploads.intake({ form: "partner", bytes: "text" }), TypeError);
});

test("a record write failure removes the object it just wrote and accepts nothing", async () => {
  const s = setup();
  const failing = { ...s.records, put: async () => { throw new Error("D1 down"); } };
  const uploads = createUploads({ config: s.config, env: s.env, scanners: { "fake-av": fakeAv() }, records: failing });
  await assert.rejects(uploads.intake({ form: "partner", bytes: pdf(), filename: "a.pdf", contentType: PDF_TYPE }), /D1 down/);
  assert.equal(s.q.objects.size, 0);
});

test("NO code path emits safe or clean: every verdict and reason of every upload above and the contract itself", async () => {
  const s = setup();
  const kinds = [pdf(), pdf(["<< /Launch 1 0 R >>"]), png(), enc("hello"), ooxml("docx"), zip([{ name: "a", data: "b" }]), cat(png(), enc("<script>1</script>")), new Uint8Array(0)];
  const seen = new Set();
  for (const form of ["partner", "no-scan", "hold-form"]) for (const bytes of kinds) {
    const { record, outcome } = await s.uploads.intake({ form, bytes, filename: "a.bin", contentType: null });
    assert.ok(VERDICTS.includes(record.verdict)); seen.add(record.verdict);
    assert.ok(!/\b(clean|safe)\b/i.test(JSON.stringify({ ...record, declared: undefined })), JSON.stringify(record).slice(0, 200));
    assert.ok(!/\b(clean|safe)\b/i.test(outcome.message));
  }
  assert.ok(seen.size >= 3, [...seen].join());
  for (const text of JSON.stringify(UPLOAD_COPY)) void text;
  assert.ok(!/\b(clean|safe)\b/i.test(JSON.stringify(UPLOAD_COPY)));
  assert.equal(publicOutcome({ verdict: "block", stage: "rejected", reason_code: "polyglot_suspect", upload_id: "upl_" + "a".repeat(32) }).code, "polyglot_suspect");
});
