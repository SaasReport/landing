// The lifecycle is ONE declared state machine (lifecycle.json). This file enumerates every pair of states against an independent
// oracle, then drives the engine through the operations and checks that it refuses what the table does not list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STATES, ACTORS, TABLE, LIFECYCLE, canTransition, assertTransition, TransitionError, tightness, createUploads, loadUploadsConfig, memoryBucket, memoryRecords, validateRecord } from "../src/index.js";
import { OPERATIONS, moved } from "../src/lifecycle.js";
import { Principal, SYSTEM } from "../src/principal.js";
import { cat, pdf, png } from "./fixtures.mjs";
import { people, decide } from "./helpers/people.mjs";

/** The oracle: every allowed (from, to, via, actor), written out by hand. The table in lifecycle.json must equal this exactly. */
const ALLOWED = [
  ...[["pending"], ["rejected"]].map(([to]) => [null, to, "intake", "system"]),
  ...["quarantined", "held", "released", "blocked"].map((to) => ["pending", to, "intake", "system"]),
  ["pending", "deleted", "rollback", "system"],
  ...["system"].flatMap((a) => [
    ["released", "released", "rescan", a], ["released", "quarantined", "rescan", a], ["released", "held", "rescan", a], ["released", "blocked", "rescan", a],
    ["quarantined", "quarantined", "rescan", a], ["quarantined", "held", "rescan", a], ["quarantined", "blocked", "rescan", a],
    ["held", "held", "rescan", a], ["held", "blocked", "rescan", a],
    ["blocked", "blocked", "rescan", a],
  ]),
  ...["quarantined", "held"].map((from) => [from, "released", "release", "human"]),
  ...["quarantined", "held", "released", "blocked", "rejected"].flatMap((from) => [[from, "deleted", "delete", "human"], [from, "deleted", "delete", "retention"], [from, "deleted", "delete", "system"]]),
  ...["quarantined", "held", "released", "blocked"].flatMap((from) => [[from, from, "hold", "human"], [from, from, "migrate", "system"]]),
];

test("every (from, to, operation, actor) combination agrees with the hand-written oracle: the engine allows exactly the table, nothing else", () => {
  const key = (t) => t.join("|");
  const allowed = new Set(ALLOWED.map(key));
  const universe = [null, ...STATES];
  let checked = 0, yes = 0;
  for (const from of universe) for (const to of STATES) for (const via of OPERATIONS) for (const actor of ACTORS) {
    const want = allowed.has(key([from, to, via, actor]));
    assert.equal(canTransition(from, to, { actor, via }), want, `${from} → ${to} via ${via} by ${actor}`);
    checked++; yes += want ? 1 : 0;
    if (!want) assert.throws(() => assertTransition(from, to, { actor, via }), TransitionError);
  }
  assert.equal(yes, ALLOWED.length, "every oracle entry exists in the table");
  assert.equal(checked, universe.length * STATES.length * OPERATIONS.length * ACTORS.length);
});

test("the table's own claims: only deleted is terminal, blocked leaves only by deletion (releasing a block is refused), a rescan never loosens", () => {
  for (const [state, def] of Object.entries(LIFECYCLE.states)) {
    if (!def.terminal) continue;
    for (const to of STATES) for (const via of OPERATIONS) for (const actor of ACTORS) assert.equal(canTransition(state, to, { actor, via }), false, `${state} is terminal: ${to} via ${via} by ${actor}`);
  }
  assert.deepEqual(STATES.filter((s) => LIFECYCLE.states[s].terminal), ["deleted"]);
  const outOfBlocked = [...TABLE.entries()].filter(([k]) => k.startsWith("blocked>") && !k.startsWith("blocked>blocked")).flatMap(([k, rows]) => rows.map((r) => [k, r.via, r.actors.join()]));
  assert.deepEqual(outOfBlocked, [["blocked>deleted", "delete", "human,retention,system"]]);
  for (const from of ["released", "quarantined", "held", "blocked"]) for (const to of ["released", "quarantined", "held", "blocked"]) {
    assert.equal(canTransition(from, to, { actor: "system", via: "rescan" }), tightness(to) >= tightness(from), `rescan ${from} → ${to}`);
    for (const actor of ["human", "retention"]) assert.equal(canTransition(from, to, { actor, via: "rescan" }), false, "a rescan is the pipeline's, never a person's or the sweep's");
  }
  for (const actor of ACTORS) assert.equal(canTransition("blocked", "released", { actor, via: "release" }), false, `no actor releases a block (${actor})`);
  assert.equal(canTransition("held", "released", { actor: "system", via: "release" }), false, "a person, not the pipeline");
  assert.equal(canTransition("held", "released", { actor: "retention", via: "release" }), false);
  assert.equal(canTransition("held", "released", { actor: "human", via: "rescan" }), false, "a rescan never releases");
});

test("the engine takes the actor from a principal it made, never from a parameter: a string or a forged object is refused", () => {
  const forged = { type: "human", id: "human:alice" };
  assert.throws(() => assertTransition("held", "released", forged, "release"), TransitionError);
  assert.throws(() => assertTransition("held", "released", "human", "release"), TransitionError);
  assert.throws(() => new Principal(Symbol("x"), "human", "human:alice"), /made by the engine/);
  assert.doesNotThrow(() => assertTransition("pending", "released", SYSTEM.intake, "intake"));
  assert.throws(() => assertTransition("held", "released", SYSTEM.rescan, "release"), TransitionError, "a system principal cannot release");
  assert.throws(() => assertTransition("held", "deleted", SYSTEM.rescan, "rescan"), TransitionError);
});

test("moved() is the only way a record changes stage: it checks the table with the principal, clears the operation and scrubs a tombstone", () => {
  const r = { stage: "pending", op: { action: "intake", to: "held" }, upload_id: "x" };
  assert.deepEqual(moved(r, "held", SYSTEM.intake, "intake"), { stage: "held", upload_id: "x" });
  assert.throws(() => moved(r, "released", SYSTEM.rescan, "release"), TransitionError);
  assert.throws(() => moved({ stage: "deleted" }, "released", SYSTEM.rescan, "rescan"), TransitionError);
});

/* ---------- through the engine ---------- */
const registry = JSON.parse(readFileSync(new URL("../../core/registry/projects.json", import.meta.url), "utf8"));
const PDF = "application/pdf";
function setup(verdict = { v: "allow" }, form = {}) {
  const cfg = { schema: "kit.uploads-config.v1", project: "saasreport", storage: { quarantine: { binding: "QUAR", bucket: "saasreport-uploads-quarantine" }, released: { binding: "REL", bucket: "saasreport-uploads" } },
    forms: { partner: { id: "partner-attachment", file_fields: [{ name: "attachment" }], allowed_types: [PDF, "image/png"], max_bytes: 1048576, retention_days: 30, blocked_retention_days: 7, on_needs_sandbox: "hold", scanner: "fake-av", ...form } } };
  const scanners = { "fake-av": { name: "fake-av", version: "1", scan: async () => ({ verdict: verdict.v }) } };
  const env = { QUAR: memoryBucket(), REL: memoryBucket() };
  const records = memoryRecords();
  let t = Date.parse("2026-10-07T12:00:00Z");
  const now = () => new Date(t);
  const P = people(now);
  const uploads = createUploads({ config: loadUploadsConfig(cfg, { registry, scanners }), env, scanners, records, now, authority: P.authority });
  const sign = (record, action, note) => P.sign(record, action, note, { decided_at: now().toISOString() });
  return { ...decide(uploads, records, sign), sign, uploads, records, q: env.QUAR, r: env.REL, verdict, tick: (ms) => { t += ms; } };
}
const upload = (s, n = 0) => s.uploads.intake({ form: "partner", bytes: pdf([`<< /Type /Catalog /Pages 2 0 R /N ${n} >>`, "<< /Type /Pages /Kids [] /Count 0 >>"]), filename: "a.pdf", contentType: PDF });

test("each verdict lands in its own stage: released, held, quarantined (scan failed), blocked, rejected", async () => {
  const s = setup();
  assert.equal((await upload(s, 1)).record.stage, "released");
  s.verdict.v = "needs_sandbox"; assert.equal((await upload(s, 2)).record.stage, "held");
  s.verdict.v = "scan_failed"; assert.equal((await upload(s, 3)).record.stage, "quarantined");
  s.verdict.v = "block"; assert.equal((await upload(s, 4)).record.stage, "blocked");
  const big = await s.uploads.intake({ form: "partner", bytes: cat(pdf(), new Uint8Array(2 * 1048576)), filename: "a.pdf", contentType: PDF });
  assert.deepEqual([big.record.stage, big.record.storage.stored], ["rejected", false]);
  for (const r of await s.records.list()) assert.deepEqual(validateRecord(r), [], r.stage);
  assert.equal((await s.uploads.reconcile()).ok, true);
});

test("the engine refuses transitions the table does not list: release of a deleted or rejected upload, delete twice is idempotent, hold on a tombstone, rescan of a tombstone", async () => {
  const s = setup();
  const a = (await upload(s, 1)).record;
  await s.del(a.upload_id);
  await assert.rejects(s.release(a.upload_id, "n"), TransitionError);
  await assert.rejects(s.hold(a.upload_id, true), TransitionError);
  await assert.rejects(s.uploads.rescan(a.upload_id), /no stored object/);
  assert.equal((await s.del(a.upload_id)).stage, "deleted");
  const big = (await s.uploads.intake({ form: "partner", bytes: cat(pdf(), new Uint8Array(2 * 1048576)), filename: "a.pdf", contentType: PDF })).record;
  await assert.rejects(s.release(big.upload_id, "n"), TransitionError);
  const gone = await s.del(big.upload_id);
  assert.deepEqual([gone.stage, gone.subject_ref, gone.declared.filename], ["deleted", null, null], "a rejected record becomes a scrubbed tombstone after retention or on request");
  await assert.rejects(s.release(a.upload_id, "n"), TransitionError);
});

test("a blocked upload cannot be released by anyone, signed or not, and a rescan never lifts it; it leaves only by deletion", async () => {
  const s = setup({ v: "block" });
  const b = (await upload(s, 1)).record;
  assert.equal(b.stage, "blocked");
  s.verdict.v = "allow";
  assert.equal((await s.uploads.rescan(b.upload_id)).stage, "blocked");
  await assert.rejects(s.release(b.upload_id, "false positive, opened in the sandbox"), TransitionError);
  await assert.rejects(s.uploads.release(b.upload_id, { decision: await s.sign(b, "release", "n") }), TransitionError);
  await assert.rejects(s.uploads.release(b.upload_id, {}), TransitionError, "fails closed before any decision is looked at");
  assert.equal((await s.records.get(b.upload_id)).stage, "blocked");
  assert.equal(s.r.objects.size, 0);
  assert.equal((await s.del(b.upload_id)).stage, "deleted");
  assert.equal((await s.uploads.reconcile()).ok, true);
});

test("a held upload is released by a signed decision whose actor is the verified key; the decision is on the record", async () => {
  const s = setup({ v: "needs_sandbox" });
  const h = (await upload(s, 1)).record;
  assert.equal(h.stage, "held");
  const out = await s.release(h.upload_id, "opened in the sandbox: fine");
  const d = out.decisions.at(-1);
  assert.deepEqual([out.stage, d.action, d.by, d.note], ["released", "release", "human:Dr Reviewer", undefined], "the note lives in the ledger, not in the record");
  assert.deepEqual(Object.keys(d.ref).sort(), ["entry_hash", "ledger", "seq"]);
  assert.equal((await s.uploads.reconcile()).ok, true);
});

test("a png named .png.php is blocked and no operation but a person's release() can change that", async () => {
  const s = setup();
  const b = (await s.uploads.intake({ form: "partner", bytes: png(), filename: `${"x".repeat(300)}.png.php`, contentType: "image/png" })).record;
  assert.equal(b.stage, "blocked"); assert.match(b.declared.filename_full, /\.png\.php$/);
  assert.equal(b.declared.filename.length, 300); assert.ok(b.declared.filename_full.length > 300, "the full normalised name is stored, not the 300-character clip");
  assert.equal((await s.uploads.rescan(b.upload_id)).stage, "blocked");
});

test("normalised once: the stored full name is NFKC, free of zero-width and bidi characters, and its parts decide the extension rules", async () => {
  const s = setup();
  const b = (await s.uploads.intake({ form: "partner", bytes: png(), filename: "a.p​hp‮.png", contentType: "image/png" })).record;
  assert.equal(b.declared.filename_full, "a.php.png"); assert.equal(b.stage, "blocked");
  const full = (await s.uploads.intake({ form: "partner", bytes: png(), filename: "ｐｈｏｔｏ．ｐｎｇ", contentType: "image/png" })).record;
  assert.equal(full.declared.filename_full, "photo.png", "fullwidth letters and dot are the ASCII ones");
});

test("hold is a record change with no stage change; retention honours it; sweep deletes through an intent and then proves the invariant", async () => {
  const s = setup();
  const a = (await upload(s, 1)).record;
  const held = await s.hold(a.upload_id, true);
  assert.deepEqual([held.stage, held.retention.hold], ["released", true]);
  s.tick(40 * 86_400_000);
  assert.equal((await s.uploads.sweep()).deleted, 0);
  await s.hold(a.upload_id, false);
  assert.equal((await s.uploads.sweep()).deleted, 1);
  const gone = await s.records.get(a.upload_id);
  assert.deepEqual([gone.stage, gone.op, typeof gone.retention.deleted_at], ["deleted", undefined, "string"]);
  assert.equal(s.q.objects.size + s.r.objects.size, 0);
});
