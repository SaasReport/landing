// Zero orphans: record first, objects second, commit third; every key derived from its record; an interrupted operation settled from
// its intent; and a reconciler that proves "every stored object has exactly one live record that expects it, and every live record
// has the objects its stage requires". A fault is injected at EVERY storage call of every operation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createUploads, loadUploadsConfig, memoryBucket, memoryRecords, quarantineKey, releasedKey } from "../src/index.js";
import { parseKey } from "../src/reconcile.js";
import { pdf } from "./fixtures.mjs";
import { people, decide as decideAs } from "./helpers/people.mjs";

const registry = JSON.parse(readFileSync(new URL("../../core/registry/projects.json", import.meta.url), "utf8"));
const PDF = "application/pdf";
const cfg = () => ({ schema: "kit.uploads-config.v1", project: "saasreport", storage: { quarantine: { binding: "QUAR", bucket: "saasreport-uploads-quarantine" }, released: { binding: "REL", bucket: "saasreport-uploads" } },
  forms: { partner: { id: "partner-attachment", file_fields: [{ name: "attachment" }], allowed_types: [PDF], max_bytes: 1048576, retention_days: 30, blocked_retention_days: 7, on_needs_sandbox: "hold", scanner: "fake-av" } } });

/** A world whose storage calls (records.put, both buckets' put and delete) can be made to fail: on the nth call, or on every call from the nth. */
function world() {
  const verdict = { v: "allow" };
  const scanners = { "fake-av": { name: "fake-av", version: "1", scan: async () => ({ verdict: verdict.v }) } };
  const q = memoryBucket(), r = memoryBucket(), real = memoryRecords();
  const fault = { n: 0, at: null, from: null, log: [] };
  const wrap = (label, obj, method) => {
    const f = obj[method].bind(obj);
    obj[method] = async (...a) => {
      const i = ++fault.n; fault.log.push(`${label}.${method}`);
      if (fault.at === i || (fault.from !== null && i >= fault.from)) throw new Error(`injected fault at call ${i} (${label}.${method})`);
      return f(...a);
    };
  };
  const records = { ...real, put: real.put.bind(real) };
  wrap("records", records, "put"); wrap("quarantine", q, "put"); wrap("quarantine", q, "delete"); wrap("released", r, "put"); wrap("released", r, "delete");
  let t = Date.parse("2026-10-07T12:00:00Z");
  const now = () => new Date(t);
  const P = people(now);
  const uploads = createUploads({ config: loadUploadsConfig(cfg(), { registry, scanners }), env: { QUAR: q, REL: r }, scanners, records, now, authority: P.authority });
  const sign = (record, action, note) => P.sign(record, action, note, { decided_at: now().toISOString() });
  return { ...decideAs(uploads, real, sign), uploads, records: real, q, r, verdict, fault, tick: (ms) => { t += ms; }, arm: (o) => { Object.assign(fault, { n: 0, at: null, from: null, log: [], ...o }); }, disarm: () => { fault.at = null; fault.from = null; } };
}
const body = (n) => pdf([`<< /Type /Catalog /Pages 2 0 R /N ${n} >>`, "<< /Type /Pages /Kids [] /Count 0 >>"]);
const intake = (w, n = 0) => w.uploads.intake({ form: "partner", bytes: body(n), filename: "a.pdf", contentType: PDF });

/** The operations under test, each preceded by the setup it needs; returns the promise of the operation itself. */
const OPERATIONS = {
  "intake (released)": { setup: async () => ({}), run: (w) => intake(w, 1) },
  "intake (held)": { setup: async (w) => { w.verdict.v = "needs_sandbox"; return {}; }, run: (w) => intake(w, 2) },
  "intake (blocked)": { setup: async (w) => { w.verdict.v = "block"; return {}; }, run: (w) => intake(w, 3) },
  "release (held to released)": { setup: async (w) => { w.verdict.v = "needs_sandbox"; return { rec: (await intake(w, 4)).record }; }, run: (w, { rec }) => w.release(rec.upload_id, "ok") },
  "rescan (released withdrawn to blocked)": { setup: async (w) => { const rec = (await intake(w, 5)).record; w.verdict.v = "block"; return { rec }; }, run: (w, { rec }) => w.uploads.rescan(rec.upload_id) },
  "rescan (held tightened to blocked)": { setup: async (w) => { w.verdict.v = "needs_sandbox"; const rec = (await intake(w, 6)).record; w.verdict.v = "block"; return { rec }; }, run: (w, { rec }) => w.uploads.rescan(rec.upload_id) },
  "delete (released)": { setup: async (w) => ({ rec: (await intake(w, 7)).record }), run: (w, { rec }) => w.del(rec.upload_id) },
  "sweep (retention)": { setup: async (w) => { await intake(w, 8); w.tick(40 * 86_400_000); return {}; }, run: (w) => w.uploads.sweep() },
};

for (const [name, op] of Object.entries(OPERATIONS)) {
  test(`${name}: a single fault at every storage call leaves no orphan and no missing object (settled in place), and the operation can be retried`, async () => {
    let calls = 0;
    for (let at = 1; ; at++) {
      const w = world();
      const ctx = await op.setup(w);
      w.arm({ at });
      let failed = false;
      try { await op.run(w, ctx); } catch { failed = true; /* the injected outage: recorded as failed and asserted below */ }
      calls = w.fault.n;
      w.disarm();
      const proof = await w.uploads.reconcile();
      assert.equal(proof.ok, true, `fault at call ${at} (${w.fault.log[at - 1]}): ${JSON.stringify(proof.violations)}`);
      for (const rec of await w.records.list()) assert.equal(rec.op, undefined, `fault at call ${at} (${w.fault.log[at - 1]}): ${rec.upload_id} still has ${rec.op?.action} in flight: the failure was not settled`);
      if (!failed) { assert.ok(at > 1, "the first run must have faulted"); break; }
      assert.ok(at <= 12, "the loop must end: an operation has a bounded number of storage calls");
    }
    assert.ok(calls >= 1);
  });

  test(`${name}: an outage (every storage call fails from the nth on) leaves only an operation intent that the reconciler repairs, never an orphan object`, async () => {
    for (let from = 1; from <= 8; from++) {
      const w = world();
      const ctx = await op.setup(w);
      w.arm({ from });
      try { await op.run(w, ctx); } catch { /* the injected outage: the test then reconciles and asserts the outcome */ }
      w.disarm();
      const during = await w.uploads.reconcile();
      assert.ok(!during.violations.some((v) => v.code === "object_without_record"), `outage from call ${from}: an object has no record: ${JSON.stringify(during.violations)}`);
      w.tick(60 * 60 * 1000);   // an hour later the intent is stale
      const stale = await w.uploads.reconcile();
      for (const v of stale.violations) assert.equal(v.code, "stale_operation", `outage from call ${from}: ${JSON.stringify(v)}`);
      const healed = await w.uploads.reconcile({ repair: true });
      assert.equal(healed.ok, true, `outage from call ${from} after repair: ${JSON.stringify(healed.violations)}`);
      assert.equal((await w.uploads.reconcile()).ok, true);
    }
  });
}

test("keys are derived from the record: q|r / form / sha256 / upload id, and a key that is not derived is not parsed", async () => {
  const w = world();
  const { record } = await intake(w, 1);
  assert.equal(record.storage.key, quarantineKey("partner", record.sha256, record.upload_id));
  assert.equal(record.storage.released_key, releasedKey("partner", record.sha256, record.upload_id));
  assert.deepEqual(parseKey(record.storage.key), { kind: "q", id: record.upload_id, form: "partner", sha256: record.sha256 });
  for (const bad of ["q/partner/abc", "x/upl_" + "a".repeat(32) + "/partner/a", "q/upl_" + "a".repeat(32) + "/partner/a/b", "q/upl_zz/partner/a", ""]) assert.equal(parseKey(bad), null, bad);
});

test("the record is written FIRST: at the moment the first object is written the record already exists (stage pending, with its intent)", async () => {
  const w = world();
  const realPut = w.q.put.bind(w.q);
  let seen;
  w.q.put = async (key, ...rest) => { seen = (await w.records.list()).map((r) => [r.stage, r.op?.action, r.storage.key]); return realPut(key, ...rest); };
  const { record } = await intake(w, 1);
  assert.deepEqual(seen, [["pending", "intake", record.storage.key]]);
  assert.equal((await w.records.get(record.upload_id)).stage, "released");
  assert.equal((await w.records.get(record.upload_id)).op, undefined);
});

test("the reconciler finds every kind of violation", async () => {
  const w = world();
  const a = (await intake(w, 1)).record;
  const h = (await (async () => { w.verdict.v = "needs_sandbox"; return intake(w, 2); })()).record;
  const codes = async () => (await w.uploads.reconcile()).violations.map((v) => v.code).sort();
  assert.deepEqual(await codes(), []);
  await w.q.put(`q/upl_${"9".repeat(32)}/partner/${"0".repeat(64)}`, new Uint8Array(3));                    // an object whose record does not exist
  assert.deepEqual(await codes(), ["object_without_record"]);
  await w.q.delete(`q/upl_${"9".repeat(32)}/partner/${"0".repeat(64)}`);
  await w.r.put(h.storage.key.replace("q/", "r/"), body(2));                                              // a released object for a held upload
  assert.ok((await codes()).includes("object_unexpected"));
  await w.r.delete(h.storage.key.replace("q/", "r/"));
  await w.r.delete(a.storage.released_key);                                                              // a released upload that lost its object
  assert.deepEqual(await codes(), ["object_missing"]);
  await w.r.put(a.storage.released_key, body(1)); assert.deepEqual(await codes(), []);
  await w.q.delete(h.storage.key); assert.deepEqual(await codes(), ["object_missing"]);
  await w.q.put(h.storage.key, new Uint8Array(1)); assert.deepEqual(await codes(), ["object_size_mismatch"]);
  await w.q.delete(h.storage.key); await w.q.put(h.storage.key, body(2));
  assert.deepEqual(await codes(), []);
  const { version: _v, ...copy } = structuredClone(h);
  await w.records.put({ ...copy, upload_id: `upl_${"8".repeat(32)}` });                    // an imported record whose keys are another record's
  assert.ok((await codes()).includes("key_mismatch"));
  await assert.rejects(w.uploads.assertConsistent(), /upload invariant violated/);
});

test("sweep proves the invariant after deleting: a violation fails the sweep, or goes to onViolation when one is wired", async () => {
  const w = world();
  await intake(w, 1);
  await w.r.put(`r/upl_${"7".repeat(32)}/partner/${"0".repeat(64)}`, new Uint8Array(2));
  await assert.rejects(w.uploads.sweep(), /object_without_record/);
  const seen = [];
  const uploads = createUploads({ config: loadUploadsConfig(cfg(), { registry, scanners: { "fake-av": { name: "fake-av", version: "1", scan: async () => ({ verdict: "allow" }) } } }), env: { QUAR: w.q, REL: w.r }, scanners: { "fake-av": { name: "fake-av", version: "1", scan: async () => ({ verdict: "allow" }) } }, records: w.records, onViolation: (v) => { seen.push(...v); } });
  assert.equal((await uploads.sweep()).deleted, 0);
  assert.deepEqual(seen.map((v) => v.code), ["object_without_record"]);
});

test("a stale operation is reported only after the threshold, and settle() finishes it from the intent: intake rolls back, delete rolls forward", async () => {
  const w = world();
  w.arm({ from: 3 });   // records.put(pending) ok, quarantine.put ok, then everything fails: commit never happens and the settle fails too
  await assert.rejects(intake(w, 1));
  w.disarm();
  const [pending] = await w.records.list();
  assert.deepEqual([pending.stage, pending.op.action], ["pending", "intake"]);
  assert.equal((await w.uploads.reconcile()).ok, true, "in flight and recent: tolerated");
  w.tick(20 * 60 * 1000);
  assert.deepEqual((await w.uploads.reconcile()).violations.map((v) => v.code), ["stale_operation"]);
  const settled = await w.uploads.settle(pending.upload_id);
  assert.deepEqual([settled.stage, settled.op], ["deleted", undefined]);
  assert.equal(w.q.objects.size, 0);
  assert.equal((await w.uploads.reconcile()).ok, true);
});
