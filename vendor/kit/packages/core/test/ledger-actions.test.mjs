// One signing format, one ledger: other decision streams (the upload decisions of #112) are an ENTRY KIND of the approval ledger. The kind declares its allowed actions (uploads:
// release, hold, unhold, rescan, delete), the owner-signed trust record scopes each member to some of them, checkAppend refuses the rest, and the primitives #112 consumes are a stable API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as core from "../src/index.js";
import { verifyLedger, checkAppend, signedBody, memberHash } from "../src/ledger.js";
import { verifyTrustRecord } from "../src/trust.js";
import { createValidator, formatProblems } from "../src/schema.js";
import { keys, ledger, append, rosterOf, NOW } from "./fixtures/ledger.mjs";
import { newOwnerKey } from "./fixtures/ssh.mjs";
import { makeRecord } from "./fixtures/trustrec.mjs";

const H = (c) => c.repeat(64), A = keys("Dr A"), B = keys("Dr B"), C = keys("Dr C");
const up = (l, by, status, id = "u-1", extra = {}) => append(l, by, { id, sha256: H("1"), status, ...extra });
const ex = (l, scopes = {}) => ({ expect: { id: l.id, project: l.project, kind: l.kind, subject: l.subject }, bootstrap: [A, B, C].map((k) => ({ name: k.name, publicKey: k.publicKey, ...(scopes[k.name] ? { actions: scopes[k.name] } : {}) })), now: NOW });
const probs = async (l, scopes) => (await verifyLedger(l, ex(l, scopes))).problems.join("\n");

test("the uploads kind declares its actions: release, hold, unhold, rescan, delete are verified entries; approval statuses are not its actions, and its actions are not a Shariah ledger's", async () => {
  assert.deepEqual(core.kindActions("uploads"), ["release", "hold", "unhold", "rescan", "delete"]);
  assert.deepEqual(core.kindActions("shariah"), ["approved", "rejected", "withdrawn"]);
  const l = ledger("uploads"); up(l, A, "hold"); up(l, B, "unhold"); up(l, A, "release", "u-2"); up(l, C, "rescan", "u-3"); up(l, A, "delete", "u-4");
  const v = await verifyLedger(l, ex(l));
  assert.deepEqual(v.problems, []);
  assert.equal(v.subjects.get("u-1").status, "unhold", "the latest action of an upload is its state");
  assert.equal(v.subjects.get("u-4").status, "delete");
  assert.match(await probs(up(ledger("uploads"), A, "approved")), /"approved" is not an action of the uploads kind/);
  assert.match(await probs(up(ledger("shariah"), A, "release")), /"release" is not an action of the shariah kind/);
  assert.match(await probs(up(ledger("uploads"), A, "bogus")), /not an action of the uploads kind/);
});

test("per-member scopes from the owner-signed record: a member may be allowed some actions and not others; no scope means every action of the kind", async () => {
  const scopes = { "Dr A": ["release", "hold"], "Dr B": ["hold", "unhold"] };
  const l = ledger("uploads"); up(l, A, "release"); up(l, B, "unhold", "u-2"); up(l, C, "delete", "u-3");   // C has no scope: all actions
  assert.deepEqual((await verifyLedger(l, ex(l, scopes))).problems, []);
  assert.match(await probs(up(ledger("uploads"), B, "release"), scopes), /Dr B is not permitted the action "release"/);
  assert.match(await probs(up(ledger("uploads"), A, "delete"), scopes), /Dr A is not permitted the action "delete"/);
  assert.match(await probs(up(ledger("uploads"), A, "unhold"), scopes), /Dr A is not permitted/);
  // scopes follow the member through a key rotation
  const l2 = ledger("uploads"), A2 = keys("Dr A");
  append(l2, A, { member: { name: "Dr A", publicKey: A2.publicKey }, sha256: memberHash({ name: "Dr A", publicKey: A2.publicKey }), status: "roster-rotate" }); up(l2, A2, "delete");
  assert.match(await probs(l2, scopes), /Dr A is not permitted the action "delete"/);
});

test("checkAppend refuses an action the kind does not have or the member is not scoped to, BEFORE anything is written", async () => {
  const scopes = { "Dr A": ["hold"] }, l = ledger("uploads"), c = ex(l, scopes);
  const cand = (by, status) => { const t = JSON.parse(JSON.stringify(l)); up(t, by, status); return t.entries.at(-1); };
  assert.equal((await checkAppend(l, cand(A, "hold"), c)).ok, true);
  assert.match((await checkAppend(l, cand(A, "release"), c)).problems.join(), /Dr A is not permitted the action "release"/);
  assert.match((await checkAppend(l, cand(A, "approved"), c)).problems.join(), /not an action of the uploads kind/);
  assert.equal(l.entries.length, 0);
});

test("the owner-signed record scopes members of an uploads roster; unknown actions, actions outside the kind and empty scopes are refused", async () => {
  const OWNER = newOwnerKey();
  const rec = (roster, kind = "uploads") => makeRecord({ project: "p", github: "Org/site", approvals: { [kind]: { ledger: "uploads-review.json", anchor: null, roster } }, key: OWNER });
  const ctx = { project: "p", owner: "masoud", ownerKeys: [OWNER.rawB64], repo: "Org/site", now: Date.parse("2026-10-08T00:00:00Z") };
  const m = (k, extra = {}) => ({ name: k.name, publicKey: k.publicKey, ...extra });
  const ok = await verifyTrustRecord(rec([m(A, { actions: ["release", "hold"] }), m(B)]), ctx);
  assert.equal(ok.ok, true, ok.problems.join());
  assert.equal(ok.approvals.uploads.id, "p:uploads"); assert.equal(ok.approvals.uploads.subject, "id");
  assert.deepEqual(ok.approvals.uploads.bootstrap[0].actions, ["release", "hold"]);
  assert.match((await verifyTrustRecord(rec([m(A, { actions: ["shred"] })]), ctx)).problems.join(), /action "shred"|schema/);
  assert.match((await verifyTrustRecord(rec([m(A, { actions: ["approved"] })]), ctx)).problems.join(), /not an action of the uploads kind/);
  assert.match((await verifyTrustRecord(rec([m(A, { actions: [] })]), ctx)).problems.join(), /at least one action|schema/);
});

test("the ledger schema declares the kind and its actions", () => {
  const s = JSON.parse(readFileSync(new URL("../schemas/approval-ledger.schema.json", import.meta.url), "utf8")), v = createValidator([s]);
  const l = ledger("uploads"); up(l, A, "release");
  assert.deepEqual(formatProblems(v.validate(l, s.$id)), []);
  const bad = JSON.parse(JSON.stringify(l)); bad.entries[0].status = "shred";
  assert.ok(formatProblems(v.validate(bad, s.$id)).length);
  const badKind = JSON.parse(JSON.stringify(l)); badKind.kind = "other";
  assert.ok(formatProblems(v.validate(badKind, s.$id)).length);
});

test("the stable API #112 consumes: signedBody, ed25519Verify (canonical base64, prime-order key, s < L), checkAppend, kindActions, from @saasreport/core", async () => {
  for (const n of ["signedBody", "ed25519Verify", "checkPublicKey", "checkSignature", "canonicalBase64", "checkAppend", "verifyLedger", "kindActions", "LEDGER_KINDS", "memberHash", "entryHash"]) assert.equal(typeof core[n] === "function" || typeof core[n] === "object", true, n);
  const l = ledger("uploads"); up(l, A, "release");
  const body = core.signedBody(l, l.entries[0]);
  assert.match(body, /"kind":"uploads"/);
  assert.equal(await core.ed25519Verify(A.publicKey, body, l.entries[0].sig), true);
  assert.equal(await core.ed25519Verify(A.publicKey, body + " ", l.entries[0].sig), false);
  assert.equal(await core.ed25519Verify(B.publicKey, body, l.entries[0].sig), false);
  // the strict encoding checks #112 needs: a small-order key, a non-canonical base64 signature and s >= L are refused
  assert.ok(core.checkPublicKey(Buffer.from("01" + "00".repeat(31), "hex").toString("base64")));
  assert.equal(core.checkPublicKey(A.publicKey), null);
  const sig = Buffer.from(l.entries[0].sig, "base64"); const big = Buffer.from(sig); Buffer.from("edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010", "hex").copy(big, 32);
  assert.ok(core.checkSignature(big.toString("base64")), "s >= L");
  const A64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", s0 = l.entries[0].sig;
  const alt = s0.slice(0, 85) + A64[A64.indexOf(s0[85]) ^ 1] + "==";   // the same 64 bytes, a second base64 spelling (the padding bits differ)
  assert.notEqual(alt, s0);
  assert.equal(Buffer.from(alt, "base64").equals(Buffer.from(s0, "base64")), true, "decodes to the same bytes");
  assert.ok(core.checkSignature(alt), "the second spelling is refused by checkSignature");
  assert.equal(await core.ed25519Verify(A.publicKey, body, alt), false, "and does not verify");
});
