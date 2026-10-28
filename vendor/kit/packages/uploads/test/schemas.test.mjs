// The contracts: registered in the kit's registry, internally consistent with the code, and no 'safe' or 'clean' anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SCHEMAS, validateRecord, validatePolicy, validateConfig, validateError, ALLOWABLE_TYPES, VERDICTS, TRIAGE_CEILING, UPLOAD_COPY, d1Records, memoryRecords, MIGRATION_FILES, RecordError, ConflictError } from "../src/index.js";
import { validate } from "@saasreport/core/schema";
import COPY_PACK from "@saasreport/core/schemas/copy-pack.schema.json" with { type: "json" };

const here = (p) => new URL(p, import.meta.url);
const index = JSON.parse(readFileSync(here("../../core/schemas/index.json"), "utf8"));

test("the upload contracts are registered in the schema registry", () => {
  for (const name of ["upload-record", "upload-policy", "uploads-config", "upload-error", "upload-evidence", "upload-serve"]) {
    const e = index.schemas.find((x) => x.name === name);
    assert.ok(e, name); assert.equal(JSON.parse(readFileSync(here(`../../core/schemas/${e.file}`), "utf8")).title, `kit.${name}.v1`);
  }
  assert.deepEqual(Object.values(SCHEMAS).map((s) => s.title).sort(), ["kit.upload-error.v1", "kit.upload-evidence.v1", "kit.upload-serve.v1", "kit.upload-policy.v1", "kit.uploads-config.v1", "kit.upload-record.v1"].sort());
});

test("policy schema: allowed_types is exactly the sniffer's allowable list; triage limit ceilings equal the engine's", () => {
  assert.deepEqual([...SCHEMAS.policy.properties.allowed_types.items.enum].sort(), [...ALLOWABLE_TYPES].sort());
  for (const [k, v] of Object.entries(TRIAGE_CEILING)) assert.equal(SCHEMAS.policy.properties.limits.properties[k].maximum, v, k);
  assert.deepEqual(Object.keys(SCHEMAS.policy.properties.limits.properties).sort(), Object.keys(TRIAGE_CEILING).sort());
});

test("record schema: the verdict enum is the scan interface's list, and no enum anywhere says safe or clean", () => {
  assert.deepEqual([...SCHEMAS.record.properties.verdict.enum], [...VERDICTS]);
  const enums = []; (function walk(n) { if (n && typeof n === "object") { if (Array.isArray(n.enum)) enums.push(...n.enum); if ("const" in n) enums.push(n.const); Object.values(n).forEach(walk); } })(SCHEMAS.record);
  assert.ok(enums.length > 20);
  for (const v of enums) assert.ok(!/^(safe|clean|ok|pass|passed|harmless)$/i.test(String(v)), `enum value ${v}`);
  for (const [k, p] of Object.entries(SCHEMAS.record.properties)) assert.ok(!/^(safe|clean)$/i.test(k), k);
});

const record = () => ({
  schema: "kit.upload-record.v1", upload_id: "upl_" + "a".repeat(32), project: "saasreport", form: "partner", policy_id: "partner-attachment", subject_ref: null,
  received_at: "2026-10-07T12:00:00.000Z", decided_at: "2026-10-07T12:00:01.000Z", size_bytes: 10, sha256: "b".repeat(64),
  declared: { content_type: "application/pdf", filename: "a.pdf", filename_normalised: "a.pdf" }, sniffed: { type: "application/pdf", family: "document", matches_declared: true },
  stage: "held", verdict: "needs_sandbox", reason_code: "scanner_not_configured", limits: [],
  triage: { engine: "kit-static-triage", engine_version: "1", complete: true, markers: [], statement: "no known active-content markers found; opening still needs a sandbox" },
  scan: { status: "not_run", scanner: "none", scanner_version: "0", signature_db_version: null, scanned_at: null },
  storage: { bucket: "saasreport-uploads-quarantine", key: "q/partner/" + "b".repeat(64), public_read: false },
  retention: { retain_until: "2026-10-14T12:00:00.000Z" },
});
test("record contract: a valid record passes; the schema rejects safe/clean verdicts, a public bucket, a stray property, and 'allow' without a scanner", () => {
  assert.deepEqual(validateRecord(record()), []);
  const bad = (mut, re) => { const r = record(); mut(r); const p = validateRecord(r); assert.ok(p.some((x) => re.test(x)), `${re}: ${p.join(" | ")}`); };
  bad((r) => { r.verdict = "clean"; }, /verdict/); bad((r) => { r.verdict = "safe"; }, /verdict/); bad((r) => { r.scan.status = "clean"; }, /status/);
  bad((r) => { r.storage.public_read = true; }, /public_read/); bad((r) => { r.extra = 1; }, /extra/); bad((r) => { r.sha256 = "xyz"; }, /sha256/);
  bad((r) => { r.upload_id = "id-1"; }, /upload_id/); bad((r) => { r.stage = "scanning"; }, /stage/); bad((r) => { r.project = "SaasReport"; }, /project/);
  bad((r) => { r.verdict = "allow"; r.reason_code = "none"; }, /verdict/);   // scanner none + allow
  bad((r) => { r.verdict = "allow_with_limits"; r.reason_code = "none"; }, /verdict/);
  const ok = record(); ok.scan = { ...ok.scan, scanner: "clamav-container", status: "no_detection", scanned_at: "2026-10-07T12:00:00Z" }; ok.verdict = "allow_with_limits"; ok.reason_code = "none";
  assert.deepEqual(validateRecord(ok), []);
  const tp = record(); tp.scan = { status: "no_detection", scanner: "vendor-api", scanner_version: "1", scanned_at: "2026-10-07T12:00:00Z", third_party_consent_ref: "DPA-1" }; tp.verdict = "allow_with_limits"; tp.reason_code = "none";
  assert.deepEqual(validateRecord(tp), []);
});

test("policy and config contracts", () => {
  const policy = { id: "partner-attachment", file_fields: [{ name: "attachment" }], allowed_types: ["application/pdf"], max_bytes: 1000, retention_days: 30, on_needs_sandbox: "hold" };
  assert.deepEqual(validatePolicy(policy), []);
  const bad = (mut, re) => { const p = structuredClone(policy); mut(p); assert.ok(validatePolicy(p).some((x) => re.test(x)), re); };
  bad((p) => { p.allowed_types = ["text/html"]; }, /allowed_types/); bad((p) => { p.allowed_types = ["application/x-msdownload"]; }, /allowed_types/);
  bad((p) => { p.on_needs_sandbox = "release"; }, /on_needs_sandbox/); bad((p) => { delete p.on_needs_sandbox; }, /on_needs_sandbox/);
  bad((p) => { p.max_bytes = 70 * 1024 * 1024; }, /max_bytes/); bad((p) => { p.file_fields = []; }, /file_fields/); bad((p) => { p.serve = { origin: "http://files.example.test" }; }, /origin/);
  bad((p) => { p.limits = { max_ratio: 5000 }; }, /max_ratio/); bad((p) => { p.nope = 1; }, /nope/);
  const cfg = { schema: "kit.uploads-config.v1", project: "saasreport", storage: { quarantine: { binding: "UPLOADS_QUARANTINE", bucket: "saasreport-uploads-quarantine" }, released: { binding: "UPLOADS_RELEASED", bucket: "saasreport-uploads" } }, forms: { partner: policy } };
  assert.deepEqual(validateConfig(cfg), []);
  assert.ok(validateConfig({ ...cfg, forms: { Partner: policy } }).length > 0);
  assert.ok(validateConfig({ ...cfg, storage: { ...cfg.storage, released: { binding: "x", bucket: "Bad_Bucket" } } }).length > 0);
});

test("error contract", () => {
  assert.deepEqual(validateError({ ok: false, error: "too_large" }), []);
  assert.deepEqual(validateError({ ok: false, error: "type_mismatch", field: "attachment", reference: "upl_" + "a".repeat(32) }), []);
  assert.ok(validateError({ ok: true, error: "too_large" }).length); assert.ok(validateError({ ok: false, error: "stack trace: ..." }).length);
});

test("the English copy is a valid copy pack and every public reason has a sentence", () => {
  assert.deepEqual(validate(UPLOAD_COPY, COPY_PACK), []);
  const reasons = SCHEMAS.error.properties.error.enum.filter((c) => !["length_required", "bad_content_length", "length_mismatch", "read_failed", "invalid_json", "bad_content_type", "file_parts_not_accepted", "file_field_not_accepted", "file_required", "too_many_files", "invalid_multipart", "too_large"].includes(c));
  for (const c of [...reasons, "too_large"]) assert.ok(UPLOAD_COPY.en.reasons[c], c);
  for (const s of ["accepted", "under_review", "blocked", "could_not_check"]) assert.ok(UPLOAD_COPY.en.status[s], s);
});

/** A D1-shaped fake that understands the statements d1Records issues, including the compare-and-set UPDATE and its `changes` count. */
function fakeD1() {
  const rows = new Map();
  return { rows, prepare(sql) { return { bind: (...a) => ({
    run: async () => {
      if (/^INSERT INTO/.test(sql)) { if (rows.has(a[0])) throw new Error("UNIQUE constraint failed"); rows.set(a[0], { upload_id: a[0], version: 1, project: a[1], form: a[2], sha256: a[3], stage: a[4], verdict: a[5], bucket: a[6], key: a[7], released_bucket: a[8], released_key: a[9], retain_until: a[10], hold: a[11], received_at: a[12], op_started: a[13], record_json: a[14] }); return { meta: { changes: 1 } }; }
      if (/^UPDATE/.test(sql)) {
        const id = a[11], ver = a[12], row = rows.get(id);
        if (!row || row.version !== ver || row.stage === "deleted") return { meta: { changes: 0 } };
        Object.assign(row, { version: a[0], stage: a[1], verdict: a[2], bucket: a[3], key: a[4], released_bucket: a[5], released_key: a[6], retain_until: a[7], hold: a[8], op_started: a[9], record_json: a[10] });
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    },
    first: async () => (/SELECT record_json/.test(sql) ? rows.get(a[0]) ?? null : null),
    all: async () => {
      const sorted = [...rows.values()].sort((x, y) => (x.upload_id < y.upload_id ? -1 : 1));
      if (/op_started IS NOT NULL/.test(sql)) return { results: sorted.filter((r) => r.op_started !== null && r.stage !== "deleted" && r.op_started <= a[0] && r.upload_id > a[1]).slice(0, a[2]) };
      if (/retain_until <= \?/.test(sql)) return { results: sorted.filter((r) => r.stage !== "deleted" && r.stage !== "pending" && r.op_started === null && r.hold === 0 && r.retain_until <= a[0] && r.upload_id > a[1]).slice(0, a[2]) };
      return { results: sorted.filter((r) => r.upload_id > a[0]).slice(0, a[1]) };
    },
  }) }; } };
}

for (const [label, make] of [["memory", () => memoryRecords()], ["D1", () => d1Records(fakeD1())]]) {
  test(`records sink (${label}): put creates at version 1 and updates only by compare-and-set; a deleted tombstone is final; lists are ordered and paged`, async () => {
    const sink = make();
    const r = record();
    const a = await sink.put(r);
    assert.equal(a.version, 1); assert.deepEqual(await sink.get(r.upload_id), a);
    await assert.rejects(sink.put(r), ConflictError, "a second create of the same id");
    const b = await sink.put({ ...a, retention: { ...a.retention, hold: true } });
    assert.equal(b.version, 2);
    await assert.rejects(sink.put({ ...a, retention: { ...a.retention, hold: false } }), ConflictError, "a write from a stale read (version 1)");
    assert.equal((await sink.get(r.upload_id)).retention.hold, true, "the stale write changed nothing");
    const c = await sink.put({ ...b, stage: "deleted", retention: { ...b.retention, deleted_at: "2026-10-07T12:00:00.000Z" } });
    assert.equal(c.stage, "deleted");
    await assert.rejects(sink.put({ ...c, stage: "released" }), ConflictError, "a tombstone is final, even from the current version");
    await assert.rejects(sink.put({ ...c, version: c.version }), ConflictError);
    assert.equal((await sink.get(r.upload_id)).stage, "deleted");
    // ordered, paged
    for (const n of ["3", "1", "2"]) await sink.put({ ...record(), upload_id: `upl_${n.repeat(32)}` });
    assert.deepEqual((await sink.list({ limit: 2 })).map((x) => x.upload_id.slice(4, 5)), ["1", "2"]);
    assert.deepEqual((await sink.list({ after: `upl_${"2".repeat(32)}`, limit: 5 })).map((x) => x.upload_id.slice(4, 5)), ["3", r.upload_id.slice(4, 5)].sort());
    await assert.rejects(sink.put({ ...record(), upload_id: `upl_${"7".repeat(32)}`, verdict: "clean" }), RecordError);
  });
}

test("D1 sink: the migration file equals the generated SQL, the table name is validated, in-flight and expired queries are ORDER BY with paging", async () => {
  for (const [file, gen] of Object.entries(MIGRATION_FILES)) assert.equal(readFileSync(here(`../migrations/${file}`), "utf8").replace(/^--.*\n--.*\n/, ""), gen("upload_records"), file);
  assert.throws(() => d1Records(fakeD1(), { table: "x; DROP TABLE y" }), /table name/);
  const sink = d1Records(fakeD1());
  const mk = (n, over = {}) => ({ ...record(), upload_id: `upl_${n.repeat(32)}`, ...over });
  const dueRec = async (n) => sink.put(mk(n, { retention: { retain_until: "2026-10-01T00:00:00Z", hold: false, deleted_at: null } }));
  await dueRec("2"); await dueRec("1"); await dueRec("3");
  const page1 = await sink.listExpired("2026-12-01T00:00:00Z", { limit: 2 });
  assert.deepEqual(page1.map((x) => x.upload_id.slice(4, 5)), ["1", "2"]);
  assert.deepEqual((await sink.listExpired("2026-12-01T00:00:00Z", { limit: 2, after: page1.at(-1).upload_id })).map((x) => x.upload_id.slice(4, 5)), ["3"]);
  const withOp = await sink.put({ ...mk("4"), op: { action: "delete", from: "released", to: "deleted", actor: "human", started_at: "2026-10-07T11:00:00.000Z" } });
  assert.deepEqual((await sink.listInFlight("2026-10-07T12:00:00.000Z", {})).map((x) => x.upload_id), [withOp.upload_id]);
  assert.deepEqual(await sink.listInFlight("2026-10-07T10:00:00.000Z", {}), []);
  assert.ok(!(await sink.listExpired("2027-01-01T00:00:00Z", { limit: 10 })).some((x) => x.upload_id === withOp.upload_id), "a record with an operation is not swept");
});