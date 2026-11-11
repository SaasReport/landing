// Re-review of 41eb85b (N1, N3, M3, M4, M6 and the low items): attacks that PASSED are must-fail tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { trustedApprovals } from "../src/approvals.js";
import { recordHash, verifyTrustRecord, pinProblems } from "../src/trust.js";
import { verifyLedger, memberHash } from "../src/ledger.js";
import { recordTrustWitness, witnessEndpoint, witnessViaEndpoint, bootstrapSql, recordWitness } from "../src/witness.js";
import { scopeHash } from "../src/scope.js";
import { newOwnerKey } from "./fixtures/ssh.mjs";
import { makeRecord, chain } from "./fixtures/trustrec.mjs";
import { d1 } from "./fixtures/d1.mjs";
import * as L from "./fixtures/ledger.mjs";

const OWNER = newOwnerKey(), REPO = "SaasReport/site", NOW = Date.parse("2026-10-08T00:00:00Z");
const A = L.keys("Aa"), X = L.keys("Xx");
const VER = { url: "https://broker/verify", publicKey: Buffer.from(newOwnerKey().raw).toString("base64"), required: true };
const ap = (roster, extra = {}) => ({ shariah: { ledger: "s.json", anchor: null, roster, ...extra } });
const ctxT = (over = {}) => ({ owner: "masoud", ownerKeys: [OWNER.rawB64], repo: REPO, now: NOW, pin: { minSeq: 1 }, ...over });

test("N1: a higher-seq record that is present but invalid fails closed; a pinned minimum seq and verifier (outside the repo) can only be added to by the record, never dropped", async () => {
  const [r1, r2] = chain([{ project: "p", approvals: ap(L.rosterOf(A, X)), seq: 1, key: OWNER }, { project: "p", approvals: ap(L.rosterOf(A)), seq: 2, key: OWNER, extra: { verifier: VER } }]);
  const tampered = { ...r2, expires: "2098-01-01T00:00:00.000Z" };
  // the owner's seq 2 deleted, or corrupted: the old record must not be the fallback
  assert.equal((await trustedApprovals({ records: [r1, tampered] }, "p", ctxT())).known, false, "a present but invalid higher record fails closed");
  assert.match((await trustedApprovals({ records: [r1, tampered] }, "p", ctxT())).problems.join(), /higher-seq record.*invalid|fails closed/);
  const pin = { minSeq: 2, verifier: VER };
  const gone = await trustedApprovals({ records: [r1] }, "p", ctxT({ pin }));
  assert.equal(gone.known, false); assert.match(gone.problems.join(), /below the minimum seq 2 pinned outside the repository/);
  assert.equal((await trustedApprovals({ records: [r1, r2] }, "p", ctxT({ pin }))).known, true);
  // a record that DROPS or CHANGES the pinned verifier is refused; one that adds a requirement is fine
  const noVer = makeRecord({ project: "p", approvals: ap(L.rosterOf(A)), seq: 2, supersedes: recordHash(r1), key: OWNER });
  assert.match((await trustedApprovals({ records: [r1, noVer] }, "p", ctxT({ pin }))).problems.join(), /drops or changes the verifier pinned outside the repository/);
  const other = makeRecord({ project: "p", approvals: ap(L.rosterOf(A)), seq: 2, supersedes: recordHash(r1), key: OWNER, extra: { verifier: { ...VER, url: "https://attacker/v" } } });
  assert.match((await trustedApprovals({ records: [r1, other] }, "p", ctxT({ pin }))).problems.join(), /drops or changes the verifier/);
  assert.equal((await trustedApprovals({ records: [r1, r2] }, "p", ctxT({ pin: { minSeq: 1 } }))).known, true, "no pinned verifier: the record's own is used");
});

test("N3 / M4: a roster-add carries actions limited to what its signers hold: two scoped members cannot add an unscoped third by majority", async () => {
  const O = L.keys("Owner"), B1 = L.keys("Bot One"), B2 = L.keys("Bot Two"), B3 = L.keys("Bot Three");
  const boot = [{ name: O.name, publicKey: O.publicKey }, { name: B1.name, publicKey: B1.publicKey, actions: ["rescan"] }, { name: B2.name, publicKey: B2.publicKey, actions: ["rescan"] }];
  const mk = (actions) => { const l = L.ledger("uploads"), m = { name: B3.name, publicKey: B3.publicKey, ...(actions ? { actions } : {}) };
    L.append(l, B1, { member: m, sha256: memberHash(m), status: "roster-add", expires: new Date(Date.UTC(2026, 9, 8)).toISOString() }); L.append(l, B2, { member: m, sha256: memberHash(m), status: "roster-add", expires: new Date(Date.UTC(2026, 9, 8)).toISOString() }); return l; };
  const v = (l) => verifyLedger(l, { expect: L.expectOf(l), bootstrap: boot, now: L.NOW });
  const unscoped = mk(null); L.append(unscoped, B3, { id: "u1", sha256: "1".repeat(64), status: "release" });
  assert.match((await v(unscoped)).problems.join(), /an added member carries actions limited to what the signers hold/);
  const wide = mk(["release"]); L.append(wide, B3, { id: "u1", sha256: "1".repeat(64), status: "release" });
  assert.match((await v(wide)).problems.join(), /actions limited to what the signers hold/, "release is not a subset of {rescan}");
  const ok = mk(["rescan"]); L.append(ok, B3, { id: "u1", sha256: "1".repeat(64), status: "rescan" });
  assert.deepEqual((await v(ok)).problems, []);
  const bad = mk(["rescan"]); L.append(bad, B3, { id: "u1", sha256: "1".repeat(64), status: "release" });
  assert.match((await v(bad)).problems.join(), /B?ot Three is not permitted the action "release"/);
  // an unscoped signer pair may add an unscoped member
  const free = L.ledger("uploads"), m2 = { name: B3.name, publicKey: B3.publicKey }; L.append(free, O, { member: m2, sha256: memberHash(m2), status: "roster-add", expires: new Date(Date.UTC(2026, 9, 8)).toISOString() });
  assert.deepEqual((await v(free)).problems, [], "one proposal of three is pending, not an error");
});

test("M3 / P4b: the checkpoint is recordSeq = the record's own seq: a fresh witness given the floor refuses the replaced record", async () => {
  const [r1, r2] = chain([{ project: "testproject", approvals: ap(L.rosterOf(A, X)), seq: 1, key: OWNER, github: "O/r", owner: "o" }, { project: "testproject", approvals: ap(L.rosterOf(A)), seq: 2, key: OWNER, github: "O/r", owner: "o", extra: { checkpoint: { recordSeq: 2, ledgers: {} } } }]);
  const ctx = { owner: "o", ownerKeys: [OWNER.rawB64], repo: "O/r", project: "testproject", floor: r2.checkpoint };
  const back = await recordTrustWitness(d1(), r1, ctx);
  assert.equal(back.ok, false); assert.equal(back.reason, "floor");
  assert.equal((await recordTrustWitness(d1(), r2, ctx)).ok, true, "the current record is at the floor");
});

test("M6: the witness is pinned (url, publicKey) in the record and SIGNS its answers: an unsigned or wrongly signed {ok:true}, another key and a replayed answer are not a witness", async () => {
  const db = d1(), l = (() => { const x = L.ledger(); L.approve(x, A, "c", "1".repeat(64)); return x; })();
  const WK = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]), WPUB = Buffer.from(await crypto.subtle.exportKey("raw", WK.publicKey)).toString("base64");
  const OTHER = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const ctx = { expect: L.expectOf(l), bootstrap: L.rosterOf(A), now: L.NOW };
  const mkH = (signKey) => witnessEndpoint(db, { authorize: () => true, resolve: () => ctx, signKey });
  const via = (h) => async (url, init) => h(new Request(url, init));
  const pinned = { publicKey: WPUB };
  assert.equal((await witnessViaEndpoint(via(mkH(WK.privateKey)), "https://w/", null, { ledger: l }, pinned)).ok, true);
  const stub = await witnessViaEndpoint(async () => ({ status: 200, ok: true, json: async () => ({ ok: true, problems: [] }) }), "https://w/", null, { ledger: l }, pinned);
  assert.equal(stub.ok, false); assert.match(stub.problems.join(), /no signed answer|not signed/);
  const wrong = await witnessViaEndpoint(via(mkH(OTHER.privateKey)), "https://w/", null, { ledger: l }, pinned);
  assert.equal(wrong.ok, false); assert.match(wrong.problems.join(), /does not verify under the witness key/);
  // a replayed answer (another nonce) and an answer for another head are refused
  const good = await mkH(WK.privateKey)(new Request("https://w/", { method: "POST", body: JSON.stringify({ ledger: l, nonce: "a".repeat(32) }) })), saved = await good.json();
  const replay = await witnessViaEndpoint(async () => ({ status: 200, ok: true, json: async () => saved }), "https://w/", null, { ledger: l }, pinned);
  assert.equal(replay.ok, false); assert.match(replay.problems.join(), /another request \(nonce differs\)/);
  // no pinned key: not accepted at all (there is nothing to verify the answer against)
  assert.match((await witnessViaEndpoint(via(mkH(WK.privateKey)), "https://w/", null, { ledger: l }, {})).problems.join(), /pins no witness key/);
});

test("N5: witness-bootstrap SQL comes only from a VERIFIED record, and a ledger kind with no anchor cannot be keyed (explicit error)", async () => {
  const rec = makeRecord({ project: "p", approvals: ap(L.rosterOf(A), { anchor: null }), seq: 2, key: OWNER, extra: { checkpoint: { recordSeq: 2, ledgers: { shariah: { seq: 3, hash: "c".repeat(64) } } } } });
  assert.throws(() => bootstrapSql(rec), /has no anchor/);
  const rec2 = makeRecord({ project: "p", approvals: ap(L.rosterOf(A), { anchor: "a".repeat(40) }), seq: 2, key: OWNER, extra: { checkpoint: { recordSeq: 2, ledgers: { shariah: { seq: 3, hash: "c".repeat(64) } } } } });
  assert.match(bootstrapSql(rec2), /'p:shariah@[0-9a-f]{64}', 3, 'c{64}'/);
  const forged = { ...rec2, signature: undefined };
  assert.match((await verifyTrustRecord(forged, { project: "p", owner: "masoud", ownerKeys: [OWNER.rawB64], repo: REPO, now: NOW })).problems.join(), /signature|unsigned/);
});

test("N2: the Persian scope (sources, exclude, mixed) is hashed canonically; any edit moves the hash", () => {
  const cfg = { sources: [{ name: "ui", files: ["src/*.js"], mixed: true }], exclude: [], review: {} };
  const h = scopeHash(cfg);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(scopeHash({ ...cfg, classes: { brand: ["x"] }, allow: [], review: { x: 1 } }), h, "lint settings are not the review scope");
  assert.notEqual(scopeHash({ ...cfg, exclude: [{ files: "src/ui.js", keys: ["promo"], reason: "r" }] }), h);
  assert.notEqual(scopeHash({ ...cfg, sources: [{ name: "ui", files: ["src/*.js", "x/*.js"], mixed: true }] }), h);
  assert.notEqual(scopeHash({ ...cfg, sources: [{ name: "ui", files: ["src/*.js"] }] }), h, "mixed is part of the scope");
  assert.equal(scopeHash({ exclude: [], sources: [{ mixed: true, files: ["src/*.js"], name: "ui" }] }), h, "key order is irrelevant");
});

test("R3-2: N1 does not fail open: an unset, empty, null or malformed pin, a record with no integer seq, or a malformed record in the set all fail closed", async () => {
  const [r1, r2] = chain([{ project: "p", approvals: ap(L.rosterOf(A, X)), seq: 1, key: OWNER }, { project: "p", approvals: ap(L.rosterOf(A)), seq: 2, key: OWNER, extra: { verifier: VER } }]);
  assert.equal((await trustedApprovals({ records: [r1, r2] }, "p", ctxT({ pin: { minSeq: 2 } }))).known, true, "CONTROL: a valid pin and the full chain");
  for (const pin of [undefined, null, {}, [], { minSeq: "2" }, { minSeq: 0 }, { minSeq: 1.5 }, { minSeq: 1, verifier: { url: "http://x" } }, { minSeq: 1, extra: 1 }]) {
    const r = await trustedApprovals({ records: [r1] }, "p", ctxT({ pin }));
    assert.equal(r.known, false, `pin ${JSON.stringify(pin)} must fail closed`); assert.match(r.problems.join(), /trust pin|no trust pin/);
  }
  assert.deepEqual(pinProblems({ minSeq: 3, verifier: VER, witness: { url: "https://w", publicKey: VER.publicKey } }), []);
  assert.deepEqual(pinProblems({ minSeq: 1 }, { needVerifier: false }), []);
  assert.match(pinProblems({ minSeq: 1 }, { needVerifier: true }).join(), /verifier pin .* required config of the broker/);
  for (const seq of [null, "two", undefined, 0, 1.5]) {
    const r = await trustedApprovals({ records: [r1, { ...r2, seq }] }, "p", ctxT());
    assert.equal(r.known, false, `seq ${JSON.stringify(seq)}`); assert.match(r.problems.join(), /no valid seq/);
  }
  const noProject = await trustedApprovals({ records: [r1, r2, { ...r2, project: undefined }] }, "p", ctxT());
  assert.equal(noProject.known, false); assert.match(noProject.problems.join(), /have no project/);
  const renamed = await trustedApprovals({ records: [r1, { ...r2, project: "other" }] }, "p", ctxT({ pin: { minSeq: 2 } }));
  assert.equal(renamed.known, false, "a renamed seq 2 is a deletion: the pinned minimum catches it"); assert.match(renamed.problems.join(), /below the minimum seq 2/);
});

test("R3-5: removing a member needs signers whose scopes cover the removed member's: two scoped members cannot remove the unscoped owner by majority", async () => {
  const O = L.keys("Owner"), B1 = L.keys("Bot One"), B2 = L.keys("Bot Two");
  const boot = [{ name: O.name, publicKey: O.publicKey }, { name: B1.name, publicKey: B1.publicKey, actions: ["rescan"] }, { name: B2.name, publicKey: B2.publicKey, actions: ["rescan", "release"] }];
  const v = (l) => verifyLedger(l, { expect: L.expectOf(l), bootstrap: boot, now: L.NOW });
  const run = (target, ...signers) => { const l = L.ledger("uploads"); for (const s of signers) L.removeMember(l, s, target); return l; };
  const gone = async (l, who) => (await v(l)).roster.every((m) => m.name !== who);
  const attack = run(O, B1, B2), a = await v(attack);
  assert.match(a.problems.join(), /a removal needs signers whose scopes cover the removed member's \(rescan here\)/);
  assert.equal(a.ok, false);
  assert.ok(a.roster.some((m) => m.name === "Owner"), "the owner is still on the roster the verifier reports");
  // a wider scoped member cannot be removed by a narrower pair either
  const wide = run(B2, O, B1); assert.match((await v(wide)).problems.join(), /a removal needs signers whose scopes cover/);
  // CONTROL: signers whose scope covers the removed member's can remove them, and unscoped signers can remove anyone
  const narrow = run(B1, B2, B1); assert.deepEqual((await v(narrow)).problems, []); assert.equal(await gone(narrow, "Bot One"), true);
  const byOwners = L.ledger("uploads"), O2 = L.keys("Owner Two"), boot2 = [{ name: O.name, publicKey: O.publicKey }, { name: O2.name, publicKey: O2.publicKey }, { name: B1.name, publicKey: B1.publicKey, actions: ["rescan"] }];
  L.removeMember(byOwners, O, B1); L.removeMember(byOwners, O2, B1);
  const r = await verifyLedger(byOwners, { expect: L.expectOf(byOwners), bootstrap: boot2, now: L.NOW });
  assert.deepEqual(r.problems, []); assert.ok(r.roster.every((m) => m.name !== "Bot One"));
});
