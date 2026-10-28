// T4/F2/F3/F8/H3/L4/L5/M6: the monotonic witness. The store is append-only by trigger and keyed by EPOCH; the ONLY writer verifies what it is given first (no poison) and inserts
// atomically; a missing witness fails closed whenever the owner-signed record sets witnessFrom; the trust record is a witnessed, chained sequence with a floor; the insert-only
// endpoint exposes nothing else. (Credential separation for the store itself needs #117.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { WITNESS_SQL, bootstrapSql, recordWitness, checkWitness, witnessEndpoint, witnessViaEndpoint, witnessedHead, serverNow, recordTrustWitness, checkTrustWitness, readBodyBounded } from "../src/witness.js";
import { ledgerHead, witnessKey, genesisFor } from "../src/ledger.js";
import { recordHash } from "../src/trust.js";
import { keys, ledger, approve, rosterOf, expectOf, NOW } from "./fixtures/ledger.mjs";
import { newOwnerKey } from "./fixtures/ssh.mjs";
import { makeRecord, chain } from "./fixtures/trustrec.mjs";
import { d1 } from "./fixtures/d1.mjs";

const H = (c) => c.repeat(64), C = (x) => JSON.parse(JSON.stringify(x));
const A = keys("Dr A"), R = rosterOf(A);
const mk = (n = 2) => { const l = ledger(); for (let i = 0; i < n; i++) approve(l, A, `c-${i}`, H(String(i + 1))); return l; };
const ctx = (l, over = {}) => ({ expect: { ...expectOf(l), ...over }, bootstrap: R, now: NOW });

test("the store: no UPDATE, no DELETE, only strictly ahead, keys of one shape (epoch-keyed)", async () => {
  const db = d1().raw, k = `p:shariah@${H("a")}`;
  const ins = (id, seq) => { try { db.prepare("INSERT INTO approval_witness VALUES (?,?,?,?)").run(id, seq, H("a"), "t"); return "ok"; } catch (e) { return e.message; } };
  assert.equal(ins(k, 5), "ok");
  assert.match(ins(k, 3), /only moves forward/);
  assert.match(String(ins(k + " ", 1)), /CHECK|constraint/i, "a trailing-space key is refused");
  assert.match(String(ins("P:Shariah", 1)), /CHECK|constraint/i);
  assert.equal(ins("p:trust", 1), "ok");
  assert.throws(() => db.exec("DELETE FROM approval_witness"), /append-only/);
  assert.throws(() => db.exec("UPDATE approval_witness SET seq = 0"), /append-only/);
});

test("T4 / H3: only a VERIFIED ledger is recorded, under its EPOCH key; a junk head, a forged entry or the wrong identity can never poison the witness", async () => {
  const db = d1(), l = mk(2);
  assert.equal((await recordWitness(db, l, ctx(l))).ok, true);
  assert.equal(witnessKey(l), `testproject:shariah@${genesisFor("a".repeat(40))}`);
  assert.deepEqual(await witnessedHead(db, witnessKey(l)), ledgerHead(l));
  const forged = C(l); forged.entries.push({ seq: 3, id: "z", sha256: H("9"), status: "approved", by: "Dr A", at: "2026-10-07T10:00:59.000Z", prev: ledgerHead(l).hash, sig: l.entries[0].sig });
  const r = await recordWitness(db, forged, ctx(forged));
  assert.equal(r.ok, false); assert.match(r.problems.join(), /does not verify, so it is not recorded/); assert.equal(r.reason, "unverifiable");
  const junk = C(l); junk.entries = junk.entries.map((e) => ({ ...e, seq: e.seq + 999999 }));
  assert.equal((await recordWitness(db, junk, ctx(junk))).ok, false);
  assert.match((await recordWitness(db, { ...C(l), id: "x" }, ctx(l))).problems.join(), /not a ledger id/);
  assert.match((await recordWitness(db, { ...C(l), id: "other:shariah" }, ctx(l))).problems.join(), /does not verify|registry says/);
  assert.deepEqual(await witnessedHead(db, witnessKey(l)), ledgerHead(l), "nothing but the verified head is in the store");
});

test("T4 / L5: behind or forked ledgers are refused with a TYPED reason; a longer one is recorded; the same head twice is fine; the insert is one atomic statement", async () => {
  const db = d1(), l = mk(2);
  await recordWitness(db, l, ctx(l));
  const longer = C(l); approve(longer, A, "c-2", H("3"));
  assert.equal((await recordWitness(db, longer, ctx(longer))).ok, true);
  assert.equal((await recordWitness(db, longer, ctx(longer))).ok, true, "idempotent");
  const behind = await recordWitness(db, l, ctx(l));
  assert.match(behind.problems.join(), /behind the witnessed head/); assert.equal(behind.reason, "behind");
  const fork = mk(2); approve(fork, A, "other", H("9"));
  const f = await recordWitness(db, fork, ctx(fork));
  assert.match(f.problems.join(), /forked or rewritten/); assert.equal(f.reason, "fork");
  const db2 = d1(), same = mk(3);
  const rs = await Promise.all([recordWitness(db2, same, ctx(same)), recordWitness(db2, same, ctx(same)), recordWitness(db2, same, ctx(same))]);
  assert.ok(rs.every((r) => r.ok));
  assert.equal(db2.raw.prepare("SELECT count(*) n FROM approval_witness").get().n, 1);
});

test("M6 / F3: a witness is REQUIRED whenever the owner-signed record sets witnessFrom, judged from the record alone, never from the submitted ledger's head", async () => {
  const db = d1(), l = mk(2), cut = mk(1), exp = (w) => ({ expect: { ...expectOf(l), witnessFrom: w } });
  assert.equal((await checkWitness(db, l, { expect: expectOf(l) })).ok, true, "no witnessFrom: not required");
  // nothing recorded, and the ledger's own head is BELOW witnessFrom: still required (the old head-derived rule let a truncated ledger through)
  const r = await checkWitness(db, cut, exp(5));
  assert.equal(r.ok, false); assert.match(r.problems.join(), /requires one.*refused/); assert.equal(r.reason, "missing");
  assert.equal((await checkWitness(db, l, exp(0))).ok, false);
  assert.match((await checkWitness(null, cut, exp(5))).problems.join(), /no witness store is reachable/);
  await recordWitness(db, l, ctx(l, { witnessFrom: 0 }));
  assert.equal((await checkWitness(db, l, exp(0))).ok, true);
  const rolled = await checkWitness(db, cut, exp(5));
  assert.equal(rolled.ok, false); assert.equal(rolled.reason, "behind");
});

test("H3: recovery works end to end: a ledger under a NEW owner-signed anchor is a new epoch (the old rows stay), and the old epoch's ledger is refused by the new anchor", async () => {
  const db = d1(), old = mk(3);
  assert.equal((await recordWitness(db, old, ctx(old))).ok, true);
  const fresh = ledger(); const c = "b".repeat(40); fresh.anchor = { commit: c, genesis: genesisFor(c), baselineThrough: 0 }; approve(fresh, A, "f0", H("9"));
  const w = await recordWitness(db, fresh, ctx(fresh, { anchor: c }));
  assert.equal(w.ok, true, w.problems.join());
  assert.notEqual(witnessKey(fresh), witnessKey(old));
  assert.equal((await witnessedHead(db, witnessKey(old))).seq, 3, "the old epoch stays recorded");
  assert.match((await recordWitness(db, old, ctx(old, { anchor: c }))).problems.join(), /anchor/);
});

test("H3: the owner's checkpoint is a floor: an empty or replaced database cannot accept an older ledger, and bootstrapSql starts a database AT the checkpoint", async () => {
  const db = d1(), l = mk(3), floor = { seq: 3, hash: ledgerHead(l).hash };
  const cut = mk(1);
  const r = await recordWitness(db, cut, { ...ctx(cut), floor });
  assert.equal(r.ok, false); assert.equal(r.reason, "behind");
  assert.equal((await recordWitness(db, l, { ...ctx(l), floor })).ok, true);
  const other = mk(3); other.entries[2].statement = "different"; // same length, different head
  assert.equal((await recordWitness(d1(), other, { ...ctx(l), floor })).ok, false);
  // bootstrapSql: the record's checkpoint becomes the rows a fresh database starts with
  const O = newOwnerKey(), anchor = "a".repeat(40);
  const rec = makeRecord({ project: "testproject", seq: 1, key: O, approvals: { shariah: { ledger: "s.json", anchor, roster: [{ name: "Dr A", publicKey: A.publicKey }] } }, extra: { checkpoint: { recordSeq: 1, ledgers: { shariah: floor } } } });
  const fresh = d1(); fresh.raw.exec(bootstrapSql(rec));
  assert.deepEqual(await witnessedHead(fresh, "testproject:trust"), { seq: 1, hash: recordHash(rec) });
  assert.deepEqual(await witnessedHead(fresh, `testproject:shariah@${genesisFor(anchor)}`), floor);
  assert.equal((await recordWitness(fresh, cut, ctx(cut))).ok, false, "the bootstrapped database refuses the rolled-back ledger");
});

// ---- the trust record is a witnessed, chained sequence with a floor (F2, H3) ----
const OWNER = newOwnerKey(), AGENT = newOwnerKey();
const TCTX = { owner: "masoud", ownerKeys: [OWNER.rawB64], repo: "SaasReport/site", project: "p" };
const appr = { concepts: null };
const spec = (seq, extra = {}) => ({ project: "p", approvals: appr, seq, key: OWNER, ...extra });

test("F2 / H3: the record chain: seq + 1 and supersedes = the witnessed hash; an older, forked or unchained record is refused; an unverifiable one is never recorded", async () => {
  const db = d1(), [r1, r2, r3] = chain([spec(1), spec(2), spec(3)]);
  assert.equal((await recordTrustWitness(db, r1, TCTX)).ok, true);
  assert.equal((await recordTrustWitness(db, r1, TCTX)).ok, true, "idempotent");
  assert.equal((await recordTrustWitness(db, r2, TCTX)).ok, true);
  assert.equal((await recordTrustWitness(db, r3, TCTX)).ok, true);
  const old = await recordTrustWitness(db, r2, TCTX);
  assert.match(old.problems.join(), /behind the witnessed seq 3: an older record was put back/); assert.equal(old.reason, "behind");
  const sibling = makeRecord({ ...spec(3, { at: "2026-10-07T11:00:00.000Z" }), supersedes: recordHash(r2) });
  assert.equal((await recordTrustWitness(db, sibling, TCTX)).reason, "fork");
  const jump = makeRecord({ ...spec(7), supersedes: recordHash(r3) });
  assert.equal((await recordTrustWitness(db, jump, TCTX)).reason, "chain", "a record must be seq + 1");
  const unchained = makeRecord({ ...spec(4), supersedes: "d".repeat(64) });
  assert.equal((await recordTrustWitness(db, unchained, TCTX)).reason, "chain");
  const bad = await recordTrustWitness(db, makeRecord({ ...spec(4), key: AGENT }), TCTX);
  assert.equal(bad.ok, false); assert.equal(bad.reason, "unverifiable");
  assert.equal((await witnessedHead(db, "p:trust")).seq, 3, "only verified, chained records, only ahead");
});

test("P4 / H3: a REPLACED or empty database cannot accept an older record once the owner's floor is pinned; an empty one only starts the chain at seq 1 without a floor", async () => {
  const [r1, r2] = chain([spec(1), spec(2)]);
  const floor = { recordSeq: 2 };
  const back = await recordTrustWitness(d1(), r1, { ...TCTX, floor });
  assert.equal(back.ok, false); assert.equal(back.reason, "floor"); assert.match(back.problems.join(), /below the owner's checkpoint floor/);
  assert.equal((await recordTrustWitness(d1(), r2, { ...TCTX, floor })).ok, true, "a replaced database accepts the CURRENT record at the floor");
  assert.equal((await recordTrustWitness(d1(), r2, TCTX)).reason, "chain", "without a floor an empty database only starts at seq 1");
  assert.equal((await recordTrustWitness(d1(), r1, TCTX)).ok, true);
});

test("F2 / L2 / L3: checkTrustWitness is read-only, judged by the database's clock; a lapsed record is refused; no store fails closed", async () => {
  const db = d1(), [r1, r2] = chain([spec(1), spec(2)]);
  await recordTrustWitness(db, r1, TCTX);
  assert.equal((await checkTrustWitness(db, r1, { project: "p" })).ok, true);
  assert.equal((await checkTrustWitness(db, r2, { project: "p" })).ok, true, "a newer record is readable before it is recorded");
  await recordTrustWitness(db, r2, TCTX);
  assert.match((await checkTrustWitness(db, r1, { project: "p" })).problems.join(), /behind the witnessed seq 2/);
  const lapsed = makeRecord({ ...spec(3, { at: "2019-01-01T00:00:00.000Z", expires: "2020-01-01T00:00:00.000Z" }), supersedes: recordHash(r2) });
  assert.match((await checkTrustWitness(db, lapsed, { project: "p" })).problems.join(), /expired at 2020-01-01.*witness's clock says 20/);
  assert.match((await recordTrustWitness(db, lapsed, TCTX)).problems.join(), /expired/);
  assert.match((await checkTrustWitness(null, r1, { project: "p" })).problems.join(), /fail closed/);
  assert.match(await serverNow(db), /^20\d\d-\d\d-\d\dT/);
});

test("F8 / L4 / L5: the endpoint has no default-allow authorize, caps the body WHILE STREAMING, takes the status from the typed reason, and refuses a database that does not report changes", async () => {
  const db = d1(), l = mk(2);
  assert.throws(() => witnessEndpoint(db, { resolve: () => ctx(l) }), /`authorize` is required/);
  assert.throws(() => witnessEndpoint(db, { authorize: () => true }), /`resolve` is required/);
  const WK = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]), pinned = { publicKey: Buffer.from(await crypto.subtle.exportKey("raw", WK.publicKey)).toString("base64") };
  const h = witnessEndpoint(db, { resolve: (id) => (id === l.id ? ctx(l) : null), resolveTrust: () => TCTX, authorize: (req) => req.headers.get("authorization") === "Bearer t", maxBytes: 4000, signKey: WK.privateKey });
  const post = (body, headers = {}) => h(new Request("https://w/", { method: "POST", headers: { authorization: "Bearer t", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }));
  assert.equal((await post({ ledger: l })).status, 200);
  assert.equal((await h(new Request("https://w/", { method: "POST", body: "{}" }))).status, 401);
  assert.equal((await h(new Request("https://w/", { method: "GET" }))).status, 405);
  assert.equal((await post({ ledger: { ...C(l), id: "x:persian" } })).status, 404);
  const fork = mk(2); approve(fork, A, "o", H("9"));
  assert.equal((await post({ ledger: fork })).status, 409, "a typed 'fork', not wording");
  const bad = C(l); bad.entries[0].statement = "edited";
  assert.equal((await post({ ledger: bad })).status, 422);
  assert.equal((await post("not json")).status, 400);
  // the cap applies to a declared length AND to a stream with no length at all
  assert.equal((await post("x".repeat(5000), { "content-length": "5000" })).status, 413);
  const chunked = new Request("https://w/", { method: "POST", headers: { authorization: "Bearer t" }, duplex: "half", body: new ReadableStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(new TextEncoder().encode("x".repeat(1000))); c.close(); } }) });
  assert.equal((await h(chunked)).status, 413, "streamed past the cap with no content-length");
  const rb = await readBodyBounded(new Request("https://w/", { method: "POST", body: "abc" }), 10);
  assert.equal(rb.text, "abc");
  assert.equal((await readBodyBounded(new Request("https://w/", { method: "POST", headers: { "content-length": "nope" }, body: "abc" }), 10)).error, 413);
  // the shared reader can be injected (the broker passes @saasreport/uploads/bounded's readBoundedJson)
  const injected = witnessEndpoint(db, { resolve: () => ctx(l), authorize: () => true, readJson: async () => { const e = new Error("too_large"); e.status = 413; throw e; } });
  assert.equal((await injected(new Request("https://w/", { method: "POST", body: "{}" }))).status, 413);
  // the CI client
  const viaHandler = async (url, init) => h(new Request(url, init));
  assert.equal((await witnessViaEndpoint(viaHandler, "https://w/", "t", l, pinned)).ok, true);
  const refused = await witnessViaEndpoint(viaHandler, "https://w/", "t", fork, pinned);
  assert.equal(refused.ok, false); assert.equal(refused.reason, "fork");
  assert.equal((await witnessViaEndpoint(viaHandler, "https://w/", "t", l)).ok, false, "no pinned witness key: nothing is believed");
  assert.match((await witnessViaEndpoint(async () => { throw new Error("ECONNREFUSED"); }, "https://w/", "t", l, pinned)).problems.join(), /unreachable/);
  // a database that does not report changes is refused, never defaulted
  const db3 = d1(), noChanges = { raw: db3.raw, prepare: (sql) => ({ bind: (...a) => ({ first: db3.prepare(sql).bind(...a).first, run: async () => { db3.raw.prepare(sql).run(...a); return { meta: {} }; } }) }) };
  const l3 = mk(3);
  const r = await recordWitness(noChanges, l3, ctx(l3));
  assert.equal(r.ok, false); assert.match(r.problems.join(), /did not report how many rows/);
});
