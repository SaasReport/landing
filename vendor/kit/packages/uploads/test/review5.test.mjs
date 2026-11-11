// The fifth review of the upload engine (kit #112 at 1557a10: N1-N4b, M-1..M-4, L-1..L-6), each reproduced as a test that fails on that commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthError, appendEntry, cursorOf, validateRecord, validateEvidence } from "../src/index.js";
import { putOnce } from "../src/store.js";
import { memoryBucket } from "../src/index.js";
import { triageSvg } from "../src/triage/svg.js";
import { resolveLimits } from "../src/limits.js";
import { findings } from "./helpers/js-ast.mjs";
import { world } from "./helpers/world.mjs";
import { evidenceOf } from "./helpers/evidence.mjs";
import { nextEntry } from "@saasreport/core/ledger";

const L = resolveLimits();
const enc = (s) => new TextEncoder().encode(s);

/* ---------- M-1: bookkeeping can never freeze a tightening ---------- */

test("M-1 (N4): 25 rescans add nothing to the record's decisions; a later block-verdict rescan withdraws the release", async () => {
  const w = world({ verdict: "allow" });
  const { record } = await w.intake(1);
  assert.equal(record.stage, "released");
  for (let i = 0; i < 25; i++) await w.uploads.rescan(record.upload_id);
  const mid = await w.records.get(record.upload_id);
  assert.ok((mid.decisions?.length ?? 0) === 0, "the record gets no system decision, however many rescans run");
  assert.deepEqual(validateRecord(mid), []);
  assert.equal((await evidenceOf(w.q, record.upload_id)).length, 25, "the evidence log has them");
  w.state.verdict = "block";
  const out = await w.uploads.rescan(record.upload_id);
  assert.equal(out.stage, "blocked");
  assert.equal(w.r.objects.size, 0, "the released object is gone");
});

test("M-1 (N4b): 25 hold cycles leave the newest 20 decisions, a valid record, and hold, rescan-to-block and delete still work", async () => {
  const w = world({ verdict: "allow" });
  const { record } = await w.intake(1);
  for (let i = 0; i < 25; i++) {
    await w.uploads.hold(record.upload_id, true, await w.decide(record.upload_id, "hold_on", "x"));
    await w.uploads.hold(record.upload_id, false, await w.decide(record.upload_id, "hold_off", "x"));
  }
  const rec = await w.records.get(record.upload_id);
  assert.equal(rec.decisions.length, 20, "the record keeps the newest 20; the ledger is the history");
  assert.deepEqual(validateRecord(rec), []);
  assert.equal(cursorOf(rec), rec.last_ref_seq);
  w.state.verdict = "block";
  assert.equal((await w.uploads.rescan(record.upload_id)).stage, "blocked");
  assert.equal((await w.uploads.delete(record.upload_id, await w.decide(record.upload_id, "delete", "x"))).stage, "deleted");
  assert.deepEqual(validateRecord(await w.records.get(record.upload_id)), []);
  assert.deepEqual((await evidenceOf(w.q, record.upload_id)).length, 0, "a deleted upload's evidence goes with its objects");
});

test("M-1: the evidence log is a contract (kit.upload-evidence.v1)", async () => {
  const w = world({ verdict: "allow" });
  const { record } = await w.intake(1);
  await w.uploads.rescan(record.upload_id);
  const [e] = await evidenceOf(w.q, record.upload_id);
  assert.deepEqual(validateEvidence(e), []);
  assert.notDeepEqual(validateEvidence({ ...e, action: "approved" }), []);
});

/* ---------- M-2: only the latest ledger entry for an upload applies ---------- */

test("M-2 (N3): a release that a later ledger entry for the same upload overrides is refused", async () => {
  const w = world();
  const { record } = await w.intake(1);
  const rel = await w.P.sign(record, "release", "oops");
  await w.P.sign(record, "delete", "revoke: wrong file");
  await assert.rejects(w.uploads.release(record.upload_id, { decision: rel }), (x) => x instanceof AuthError && x.reason === "superseded");
  assert.equal((await w.records.get(record.upload_id)).stage, "held");
});

test("M-2: the cursor refuses any seq at or below the highest used, even a newer-looking entry for an older decision", async () => {
  const w = world();
  const { record } = await w.intake(1);
  const on = await w.P.sign(record, "hold_on", "x");
  await w.uploads.hold(record.upload_id, true, { decision: on });
  const off = await w.P.sign(record, "hold_off", "x");
  await w.uploads.hold(record.upload_id, false, { decision: off });
  await assert.rejects(w.uploads.hold(record.upload_id, true, { decision: on }), (x) => ["replayed", "superseded"].includes(x.reason));
  await assert.rejects(w.uploads.hold(record.upload_id, false, { decision: off }), (x) => x.reason === "replayed");
});

/* ---------- M-3: one bad entry does not block every decision; one append path ---------- */

test("M-3 (N2): an invalid entry at the tail leaves the verified prefix answering, and the tampering is reported", async () => {
  const w = world();
  const { record } = await w.intake(1);
  const good = await w.P.sign(record, "hold_on", "x");
  const bad = nextEntry(w.P.ledger, { id: record.upload_id, sha256: record.sha256, status: "release", by: "Mallory", at: w.now().toISOString() });
  bad.sig = "AAAA"; w.P.ledger.entries.push(bad);   // anyone with write access to the store
  const held = await w.uploads.hold(record.upload_id, true, { decision: good });
  assert.equal(held.retention.hold, true, "the decision before the bad entry still applies");
  assert.ok(w.P.tampered.length > 0, "and the tail is reported through onTamper");
  const forged = { ledger: good.ledger, seq: bad.seq, entry_hash: "0".repeat(64) };
  await assert.rejects(w.uploads.release(record.upload_id, { decision: forged }), (x) => x.reason === "ledger_invalid", "the bad entry itself never decides");
});

test("M-3 (N2b): an out-of-scope entry cannot be written through the append path, and one written around it does not block the earlier decisions", async () => {
  const w = world({ actions: ["hold", "unhold"] });
  const { record } = await w.intake(1);
  const good = await w.P.sign(record, "hold_on", "x");
  await assert.rejects(w.P.sign(record, "release", "x"), (x) => x instanceof AuthError && x.reason === "append_refused" && /not permitted/.test(x.message));
  assert.equal(w.P.ledger.entries.length, 1, "nothing was stored");
  await w.P.sign(record, "release", "x", { force: true });   // written around the append path
  assert.equal((await w.uploads.hold(record.upload_id, true, { decision: good })).retention.hold, true);
});

test("M-3: the append path takes the store's compare-and-set: a writer that read an older head is refused", async () => {
  const w = world();
  const { record } = await w.intake(1);
  const a = await w.P.sign(record, "hold_on", "x");
  const stale = await w.P.authority.loadLedger();
  await w.P.sign(record, "hold_off", "x");   // another writer got in first
  const e = nextEntry(stale, { id: record.upload_id, sha256: record.sha256, status: "hold", by: "Dr Reviewer", at: w.now().toISOString() });
  const { sign: edSign } = await import("node:crypto");
  const { signedBody } = await import("@saasreport/core/ledger");
  e.sig = edSign(null, Buffer.from(signedBody(stale, e)), w.P.approver.privateKey).toString("base64");
  await assert.rejects(appendEntry({ ...w.P.authority, loadLedger: async () => stale }, e, { now: w.now }), /head moved/);
  assert.equal(a.seq, 1);
});

/* ---------- M-4: CSS escapes in presentation attributes ---------- */

test("M-4: escapes and comments in ANY attribute value are decoded before the URL classifier reads it", async () => {
  for (const a of ['fill="\\75rl(http://evil/x)"', 'fill="u\\72l(http://evil/x)"', 'fill="ur&#108;(http://evil/x)"', 'filter="u/**/rl(http://evil/x)"', 'mask="URL( \'//evil/m\' )"', 'stroke="\\75 rl(ftp://evil/x)"']) {
    const r = await triageSvg(enc(`<svg xmlns="http://www.w3.org/2000/svg"><rect ${a}/></svg>`), L);
    assert.ok(r.markers.some((m) => m.name === "external_reference"), a);
  }
  for (const ok of ['fill="\\75rl(#g)"', 'fill="url(#g)"', 'fill="red"', 'opacity="0.5"']) {
    const r = await triageSvg(enc(`<svg xmlns="http://www.w3.org/2000/svg"><rect ${ok}/></svg>`), L);
    assert.equal(r.markers.length, 0, `${ok}: the absent twin`);
  }
});

/* ---------- L-2: a late write after rollback is cleaned; putOnce checks the hash ---------- */

test("L-2: an object written AFTER its intake was rolled back is removed, and the store is consistent", async () => {
  const w = world({ verdict: "allow" });
  let release, reached;
  const gate = new Promise((r) => { release = r; }), atGate = new Promise((r) => { reached = r; });
  const realPut = w.q.put.bind(w.q);
  w.q.put = async (k, ...rest) => { if (k.startsWith("q/")) { reached(); await gate; } return realPut(k, ...rest); };   // a slow worker: its write lands late
  const slow = w.uploads.intake({ form: "partner", bytes: w.body(1), filename: "a.pdf", contentType: "application/pdf" });
  const settled = slow.catch((e) => e);
  await atGate;
  w.tick(20 * 60 * 1000);
  const [pending] = await w.records.list();
  await w.uploads.settle(pending.upload_id);   // the reconciler rolls the intake back while the worker is still writing
  assert.equal((await w.records.get(pending.upload_id)).stage, "deleted");
  release();
  const out = await settled;
  assert.ok(out instanceof Error, "the intake fails: its commit was refused");
  assert.equal(w.q.objects.size + w.r.objects.size, 0, "the late write was cleaned up (its fence is the rolled-back operation's)");
  assert.equal((await w.uploads.reconcile()).ok, true);
});

test("L-2: putOnce on an existing key verifies the sha256, not only the size", async () => {
  const bucket = memoryBucket();
  const a = enc("AAAA"), b = enc("BBBB");
  const hex = async (x) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", x))].map((v) => v.toString(16).padStart(2, "0")).join("");
  await putOnce(bucket, "k", a, { sha256: await hex(a) });
  assert.deepEqual(await putOnce(bucket, "k", a, { sha256: await hex(a) }), { written: false }, "the same bytes again: fine");
  await assert.rejects(putOnce(bucket, "k", b, { sha256: await hex(b) }), /different content/, "same size, other bytes: refused");
  // an object written before the hash was stored in its metadata is hashed
  await bucket.put("old", a);
  await assert.rejects(putOnce(bucket, "old", b, { sha256: await hex(b) }), /different content/);
  assert.deepEqual(await putOnce(bucket, "old", a, { sha256: await hex(a) }), { written: false });
});

/* ---------- L-3: the capability is bound to stage and version, and expires ---------- */

test("L-3: a withdrawal token stops working when the record changes or the time passes", async () => {
  const w = world({ verdict: "allow" });
  const a = await w.intake(1);
  assert.equal((await w.uploads.withdraw(a.record.upload_id, a.withdrawToken)).stage, "deleted", "the token of the record as intake saw it works");
  const b = await w.intake(2);
  w.state.verdict = "block";
  await w.uploads.rescan(b.record.upload_id);   // a real change: stage and version move
  await assert.rejects(w.uploads.withdraw(b.record.upload_id, b.withdrawToken), (x) => x.reason === "no_capability", "bound to the stage and version intake saw");
  assert.equal((await w.records.get(b.record.upload_id)).stage, "blocked");
  const c = await w.intake(3);
  w.tick(6 * 60 * 1000);
  await assert.rejects(w.uploads.withdraw(c.record.upload_id, c.withdrawToken), (x) => x.reason === "no_capability", "expired");
});

/* ---------- L-4: the gate's eyes know which function a finding is in ---------- */

test("L-4: a registry entry can be narrowed to one function: the same regex elsewhere in the file is not covered", () => {
  const f = findings("function check(v){ return new RegExp(v); }\nfunction other(v){ return new RegExp(v); }");
  assert.deepEqual(f.filter((x) => x.kind === "regexp-reference").map((x) => x.fn), ["check", "other"]);
});
