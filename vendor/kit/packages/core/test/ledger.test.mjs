// The approval ledger: signed, hash-chained, append-only, registry-bound. Every attack on it is a test that fails the verification.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { verifyLedger, verifiedLedger, checkAppend, baselineHash, entryHash, genesisFor, signedBody, ledgerId, witnessProblems, ledgerHead, memberHash, FUTURE_SKEW_MS } from "../src/ledger.js";
import { createValidator, formatProblems } from "../src/schema.js";
import { WITNESS_SQL } from "../src/witness.js";
import { verifyLedger as verifyL } from "../src/ledger.js";
import { keys, ledger, append, approve, addMember, removeMember, verify, rosterOf, expectOf, NOW, COMMIT } from "./fixtures/ledger.mjs";

const H = (c) => c.repeat(64);
const schema = JSON.parse(readFileSync(new URL("../schemas/approval-ledger.schema.json", import.meta.url), "utf8"));
const clone = (l) => JSON.parse(JSON.stringify(l));
const problems = async (l, r, over) => (await verify(l, r, over)).problems.join("\n");
const b64 = (hex) => Buffer.from(hex, "hex").toString("base64");

test("a signed, chained ledger verifies and the effective entry of a subject is the latest", async () => {
  const s = keys("Dr Reviewer"), l = ledger();
  approve(l, s, "murabaha", H("1")); approve(l, s, "salam", H("2"));
  append(l, s, { id: "murabaha", sha256: H("1"), status: "withdrawn", statement: "Withdrawn pending a correction." });
  const v = await verify(l, rosterOf(s));
  assert.deepEqual(v.problems, []);
  assert.equal(v.subjects.get("murabaha").status, "withdrawn");
  assert.equal(v.subjects.get("salam").status, "approved");
  assert.deepEqual(formatProblems(createValidator([schema]).validate(l, schema.$id)), []);
});

test("identity: only the roster's key signs. A forged `by`, another key, no key and an empty roster all fail, and a failing ledger approves nothing", async () => {
  const s = keys("Dr Reviewer"), mallory = keys("Dr Reviewer"), l = ledger();
  approve(l, s, "murabaha", H("1"));
  assert.match(await problems(l, rosterOf(mallory)), /signature is not Dr Reviewer's/, "the same NAME with another key");
  assert.match(await problems(l, []), /not in the reviewer roster/, "an empty roster approves nothing");
  const forged = ledger(); append(forged, mallory, { id: "murabaha", sha256: H("1"), status: "approved", attests: [], statement: "An agent signing with its own key." });
  assert.match(await problems(forged, rosterOf(s)), /signature is not Dr Reviewer's/);
  const unsigned = clone(l); delete unsigned.entries[0].sig;
  assert.match(await problems(unsigned, rosterOf(s)), /unsigned approved/);
  assert.equal((await verify(forged, rosterOf(s))).subjects.size, 0);
});

test("integrity: editing, back-dating, re-sorting, deleting and re-anchoring all break the chain", async () => {
  const s = keys(), l = ledger();
  approve(l, s, "murabaha", H("1")); approve(l, s, "salam", H("2")); approve(l, s, "ijara", H("3"));
  const r = rosterOf(s);
  assert.equal((await verify(l, r)).ok, true);
  const t = async (mutate) => { const c = clone(l); mutate(c); return problems(c, r); };
  assert.match(await t((c) => { c.entries[0].statement = "Edited by someone else later."; }), /signature is not|prev does not match/);
  assert.match(await t((c) => { c.entries[1].at = "2020-01-01T00:00:00.000Z"; }), /back-dated|signature is not/);
  assert.match(await t((c) => { c.entries.reverse(); }), /seq|prev does not match/);
  assert.match(await t((c) => { c.entries.splice(1, 1); }), /seq|prev does not match/);
  assert.match(await t((c) => { c.entries[1].sha256 = H("9"); }), /signature is not|prev does not match/);
  assert.match(await t((c) => { c.anchor.commit = "b".repeat(40); }), /anchor was edited/);
  const sorted = clone(l); sorted.entries.sort((a, b) => a.id.localeCompare(b.id));
  assert.match(await problems(sorted, r), /seq|prev does not match/);
});

test("ROOT A/E: the ledger's id, project, kind and subject are the registry's, and are inside every signed body (no replay between ledgers)", async () => {
  const s = keys(), l = ledger("shariah"); approve(l, s, "murabaha", H("1"));
  const r = rosterOf(s);
  // the registry expectation is binding
  for (const [field, val] of [["id", "other:shariah"], ["project", "other"], ["kind", "persian"]]) {
    const c = clone(l); c[field] = val;
    assert.match(await problems(c, r, { expect: expectOf(l) }), new RegExp(`${field} is`), field);
  }
  assert.match(await problems(l, r, { expect: { ...expectOf(l), anchor: "c".repeat(40) } }), /anchor.commit is not the commit the registry records/);
  // replay: the same signed entry copied into a ledger of another project or kind does not verify there, even with the header edited to match
  const other = ledger("shariah", 0, "otherproject"); other.entries.push(clone(l.entries[0]));
  other.entries[0].prev = other.anchor.genesis;
  assert.match(await problems(other, r), /signature is not/);
  const otherKind = { ...clone(l), kind: "persian", id: ledgerId("testproject", "persian") };
  assert.match(await problems(otherKind, r), /signature is not/);
  assert.match(signedBody(l, l.entries[0]), /"kind":"shariah","ledger":"testproject:shariah","prev".*"project":"testproject"/);
});

test("ROOT E: `at` is UTC with Z only, not beyond a small future skew, and never earlier than the entry before", async () => {
  const s = keys(), r = rosterOf(s);
  const one = (at) => { const l = ledger(); approve(l, s, "a", H("1"), { at }); return problems(l, r); };
  assert.equal(await one("2026-10-07T10:00:00.000Z"), "");
  assert.match(await one("2026-10-07T10:00:00.000+00:00"), /UTC timestamp ending in Z/);
  assert.match(await one("2026-10-07T12:00:00+02:00"), /UTC timestamp ending in Z/);
  assert.match(await one("2026-10-07"), /UTC timestamp ending in Z/);
  assert.match(await one("2099-01-01T00:00:00.000Z"), /in the future/);
  assert.equal(await one(new Date(NOW + FUTURE_SKEW_MS - 1000).toISOString()), "", "within the skew");
  assert.match(await one(new Date(NOW + FUTURE_SKEW_MS + 60000).toISOString()), /in the future/);
  const l = ledger(); approve(l, s, "a", H("1"), { at: "2026-10-07T10:00:05.000Z" }); approve(l, s, "b", H("2"), { at: "2026-10-07T10:00:01.000Z" });
  assert.match(await problems(l, r), /back-dated/);
});

test("ROOT C / T3: roster changes need a strict majority of the CURRENT roster; weak keys, duplicates and non-canonical spellings are refused; nobody adds their own second key", async () => {
  const a = keys("Dr A"), b = keys("Dr B"), c = keys("Dr C"), mallory = keys("Mallory");
  const both = (l, m) => { addMember(l, a, m); addMember(l, b, m); return l; };      // a majority of {A, B}
  const l = both(ledger(), c); approve(l, c, "x", H("1"));
  const v = await verify(l, rosterOf(a, b));
  assert.deepEqual(v.problems, []);
  assert.deepEqual(v.roster.map((m) => m.name), ["Dr A", "Dr B", "Dr C"], "C approves only because a majority added C");
  // one member alone does not change the roster (with a roster of 2, quorum is 2): C's later signature fails
  const lone = ledger(); addMember(lone, a, c); approve(lone, c, "x", H("1"));
  assert.match(await problems(lone, rosterOf(a, b)), /"Dr C", who is not in the reviewer roster/, "one of two is not a majority");
  // a one-member roster changes only through the owner-signed record: no member adds their own second key or removes themselves
  const solo = ledger(); addMember(solo, a, { name: "Dr A2", publicKey: keys("x").publicKey });
  assert.match(await problems(solo, rosterOf(a)), /one-member roster changes only through the owner-signed trust record/);
  const solo2 = ledger(); removeMember(solo2, a, a);
  assert.match(await problems(solo2, rosterOf(a)), /one-member roster/);
  // with a roster of 3, a member and their own second key do not make a majority; a stranger cannot propose
  const sock = ledger(), b2 = keys("Dr B2"); addMember(sock, b, b2); addMember(sock, b2, b2); approve(sock, b2, "x", H("1"));
  assert.match(await problems(sock, rosterOf(a, b, c)), /Dr B2|not in the reviewer roster/);
  const byStranger = ledger(); addMember(byStranger, mallory, mallory);
  assert.match(await problems(byStranger, rosterOf(a, b)), /roster-add by "Mallory", who is not in the reviewer roster/);
  // removal: a removed member no longer signs
  const removed = both(ledger(), c); removeMember(removed, a, c); removeMember(removed, b, c); approve(removed, c, "x", H("1"));
  assert.match(await problems(removed, rosterOf(a, b)), /"Dr C", who is not in the reviewer roster/);
  // weak keys: the identity, a small-order point, a non-canonical y, other base64 padding bits, in a proposal or in the registry's roster
  const weak = { identity: b64("01" + "00".repeat(31)), order2: b64("ecff" + "ff".repeat(29) + "7f"), nonCanonicalY: b64("edff" + "ff".repeat(29) + "7f"), notBase64: "!!!!", short: "AAAA" };
  for (const [what, publicKey] of Object.entries(weak)) {
    assert.match(await problems(both(ledger(), { name: "Dr W", publicKey }), rosterOf(a, b)), /public key is/, `${what} as a new member`);
    assert.match(await problems(ledger(), [{ name: "Dr W", publicKey }]), /public key is/, `${what} in the owner-signed roster`);
  }
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const altKey = a.publicKey.slice(0, 42) + A[A.indexOf(a.publicKey[42]) ^ 1] + "=";
  assert.match(await problems(ledger(), [{ name: "Dr A", publicKey: altKey }]), /public key is/, "the same bytes, another base64 spelling");
  assert.match(await problems(ledger(), [{ name: "Dr A", publicKey: a.publicKey }, { name: "Dr A", publicKey: b.publicKey }]), /duplicated/);
  assert.match(await problems(ledger(), [{ name: "Dr A", publicKey: a.publicKey }, { name: "Dr B", publicKey: a.publicKey }]), /already another member's/);
  assert.match(await problems(both(ledger(), { name: "Dr A", publicKey: b.publicKey }), rosterOf(a, b)), /duplicated/, "adding an existing name");
  const hashBad = both(ledger(), c); hashBad.entries[0].sha256 = H("0");
  assert.match(await problems(hashBad, rosterOf(a, b)), /sha256 is not the hash of its member|signature is not|prev/);
  assert.equal(memberHash(b).length, 64);
});

test("T3: a member with an open hold cannot be removed; a hold is judged against the roster AT HOLD TIME (no stuffing, no shrinking, no stale approvals)", async () => {
  const a = keys("Dr A"), b = keys("Dr B"), c = keys("Dr C"), id = "x";
  const veto = (l, by) => append(l, by, { id, sha256: H("1"), status: "withdrawn", statement: "Withdrawn: the ruling is wrong." });
  const st = async (l, r) => { const v = await verify(l, r); return v.ok ? (v.subjects.get(id)?.status ?? "none") : "INVALID: " + v.problems.join(" | "); };
  // zz2 #1: B removes the vetoer A and the third member with a "majority", then lifts the veto alone
  const l1 = ledger(); approve(l1, a, id, H("1")); veto(l1, a);
  removeMember(l1, b, a); removeMember(l1, c, a);
  assert.match(await st(l1, rosterOf(a, b, c)), /Dr A has an open hold/, "the vetoer cannot be removed until the hold is resolved");
  // zz2 #2: B adds a sock puppet B2 (with a second member's help) and B + B2 form a majority over the veto
  const l2 = ledger(), b2 = keys("Dr B2"); approve(l2, a, id, H("1")); veto(l2, a);
  addMember(l2, b, b2); addMember(l2, c, b2);                 // a legitimate majority adds B2 AFTER the hold
  approve(l2, b, id, H("1")); approve(l2, b2, id, H("1"));
  assert.equal(await st(l2, rosterOf(a, b, c)), "withdrawn", "a member added after the hold does not count toward lifting it");
  approve(l2, c, id, H("1"));                                  // b + c = 2 of the 3 who were there at hold time
  assert.equal(await st(l2, rosterOf(a, b, c)), "approved");
  // zz2 #3: stale approvals of members later removed do not count, and the quorum does not shrink with the roster
  const l3 = ledger(); approve(l3, a, id, H("1")); veto(l3, a);
  approve(l3, c, id, H("1"));                                  // c's approval is pending (1 of the 2 needed)
  removeMember(l3, a, c); removeMember(l3, b, c);              // c leaves (a and b agree); the hold is A's, A stays
  assert.equal(await st(l3, rosterOf(a, b, c)), "withdrawn", "c's pending approval left with c");
  approve(l3, b, id, H("1"));
  assert.equal(await st(l3, rosterOf(a, b, c)), "withdrawn", "need stays 2 of the original 3; only b counts now");
  approve(l3, a, id, H("1"));
  assert.equal(await st(l3, rosterOf(a, b, c)), "approved", "the vetoer lifts their own hold");
});

test("T7: key rotation is a roster entry signed with the OLD key; the old key's earlier entries stay verifiable, its later ones do not", async () => {
  const a = keys("Dr A"), b = keys("Dr B"), a2 = keys("Dr A"), r = rosterOf(a, b);
  const rotate = (l, by, member) => append(l, by, { member: { name: member.name, publicKey: member.publicKey }, sha256: memberHash(member), status: "roster-rotate" });
  const l = ledger(); approve(l, a, "x", H("1")); rotate(l, a, a2); approve(l, a2, "y", H("2"));
  const v = await verify(l, r);
  assert.deepEqual(v.problems, []);
  assert.equal(v.roster.find((m) => m.name === "Dr A").publicKey, a2.publicKey, "the roster holds the new key");
  assert.equal(v.subjects.get("x").status, "approved", "the entry signed with the old key is still verified");
  // the old key cannot sign after the rotation; nobody rotates someone else's key; a rotation to a member's key or a weak key is refused
  const late = ledger(); rotate(late, a, a2); approve(late, a, "x", H("1"));
  assert.match(await problems(late, r), /signature is not Dr A's/);
  const other = ledger(); rotate(other, b, { name: "Dr A", publicKey: a2.publicKey });
  assert.match(await problems(other, r), /a rotation is signed by the member whose key changes/);
  const toB = ledger(); rotate(toB, a, { name: "Dr A", publicKey: b.publicKey });
  assert.match(await problems(toB, r), /already a member's/);
  const weak = ledger(); rotate(weak, a, { name: "Dr A", publicKey: b64("01" + "00".repeat(31)) });
  assert.match(await problems(weak, r), /new key is/);
  // a vetoer who rotates keeps the hold (it is the member's, not the key's)
  const h = ledger(); approve(h, a, "x", H("1")); append(h, a, { id: "x", sha256: H("1"), status: "withdrawn", statement: "Withdrawn: the ruling is wrong." }); rotate(h, a, a2); approve(h, b, "x", H("1"));
  assert.equal((await verify(h, r)).subjects.get("x").status, "withdrawn");
  approve(h, a2, "x", H("1"));
  assert.equal((await verify(h, r)).subjects.get("x").status, "approved");
});

test("T2: anchor.migratedFrom is accepted only for the migration the owner-signed record names, never on a Shariah ledger", async () => {
  const s = keys("Dr A"), r = rosterOf(s), mig = { sha256: H("a"), entries: 3 };
  const withMig = (kind) => { const l = ledger(kind); l.anchor.migratedFrom = { ...mig }; return l; };
  assert.match(await problems(withMig("persian"), r), /records no migration/, "no migration in the owner-signed record");
  const okExpect = { ...expectOf(withMig("persian")), migration: mig };
  assert.equal((await verifyLedger(withMig("persian"), { expect: okExpect, bootstrap: r, now: NOW })).ok, true);
  assert.match((await verifyLedger(withMig("persian"), { expect: { ...okExpect, migration: { ...mig, entries: 4 } }, bootstrap: r, now: NOW })).problems.join(), /not the migration/);
  assert.match((await verifyLedger(withMig("persian"), { expect: { ...okExpect, migration: { sha256: H("b"), entries: 3 } }, bootstrap: r, now: NOW })).problems.join(), /not the migration/);
  assert.match(await problems(withMig("shariah"), r), /records no migration/, "a Shariah ledger has none");
});

test("veto semantics: a withdrawal or rejection by a member holds the subject until the same member approves again, or a strict majority of the roster approves the same text after it", async () => {
  const a = keys("Dr A"), b = keys("Dr B"), c = keys("Dr C"), r = rosterOf(a, b, c), id = "murabaha";
  const state = async (l) => (await verify(l, r)).subjects.get(id);
  const w = ledger(); approve(w, a, id, H("1")); append(w, b, { id, sha256: H("1"), status: "withdrawn", statement: "I withdraw this: the ruling is wrong." });
  assert.equal((await state(w)).status, "withdrawn");
  approve(w, a, id, H("1"));                                   // the original approver cannot overrule the vetoer alone
  assert.equal((await state(w)).status, "withdrawn", "one other member does not lift the hold (quorum is 2 of 3)");
  approve(w, c, id, H("1"));                                   // a second member, same text: strict majority of 3
  assert.equal((await state(w)).status, "approved", "a strict majority approving the same text after the hold lifts it");
  const w2 = ledger(); approve(w2, a, id, H("1")); append(w2, b, { id, sha256: H("1"), status: "rejected", statement: "Rejected, with a reason." });
  approve(w2, a, id, H("2")); approve(w2, c, id, H("3"));
  assert.equal((await state(w2)).status, "rejected", "approvals of different texts do not add up to a quorum");
  approve(w2, b, id, H("4"));                                  // the vetoer lifts their own hold
  assert.equal((await state(w2)).status, "approved");
  assert.equal((await state(w2)).sha256, H("4"));
  const single = ledger(); approve(single, a, id, H("1")); append(single, a, { id, sha256: H("1"), status: "withdrawn", statement: "Withdrawn pending a correction." }); approve(single, a, id, H("1"));
  assert.equal((await verify(single, rosterOf(a))).subjects.get(id).status, "approved", "a one-member roster: the member lifts their own withdrawal");
});

test("a baseline is unsigned, only inside anchor.baselineThrough, and never an approval", async () => {
  const s = keys(), l = ledger("persian", 2);
  append(l, null, { file: "a.js", sha256: H("1"), status: "baseline", segments: 3, note: "live before the gate" });
  append(l, null, { file: "b.js", sha256: H("2"), status: "baseline", segments: 1 });
  append(l, s, { file: "a.js", sha256: H("3"), status: "approved", segments: 3 });
  const v = await verify(l, rosterOf(s));
  assert.deepEqual(v.problems, []);
  assert.equal(v.subjects.get("a.js").status, "approved");
  const late = ledger("persian", 1);
  append(late, null, { file: "a.js", sha256: H("1"), status: "baseline" }); append(late, null, { file: "b.js", sha256: H("2"), status: "baseline" });
  assert.match(await problems(late, []), /a baseline is only allowed in the first 1 entries/);
  const signedBaseline = clone(l); signedBaseline.entries[0].sig = l.entries[2].sig;
  assert.match(await problems(signedBaseline, rosterOf(s)), /a baseline carries no signature/);
});

test("ROOT G: the whole chain and every signature are always verified (no partial `only` mode), verification is memoized", async () => {
  const s = keys(), l = ledger();
  for (let i = 0; i < 6; i++) approve(l, s, `c-${i}`, H(String(i)));
  const r = rosterOf(s);
  const c = clone(l); c.entries[1].statement = "tampered statement text";
  assert.equal((await verify(c, r)).ok, false, "a tampered middle entry fails the whole ledger");
  const f = clone(l); f.entries[0].sig = f.entries[5].sig;
  assert.equal((await verify(f, r)).ok, false, "a forged OLD (superseded) entry also fails: nothing is skipped");
  const opts = { expect: expectOf(l), bootstrap: r, now: NOW };
  assert.equal(verifiedLedger(l, opts), verifiedLedger(l, opts), "memoized");
  assert.equal((await verifiedLedger(l, opts)).ok, true);
});

test("witness: a ledger behind or forked from the witnessed head is refused (rollback, truncation, hidden withdrawal)", async () => {
  const s = keys(), l = ledger(); approve(l, s, "a", H("1")); approve(l, s, "b", H("2"));
  const seen = ledgerHead(l);
  assert.deepEqual(witnessProblems(l, seen), []);
  assert.deepEqual(witnessProblems(l, null), []);
  const longer = clone(l); approve(longer, s, "c", H("3"));
  assert.deepEqual(witnessProblems(longer, seen), [], "ahead of the witness is fine");
  const rolled = clone(l); rolled.entries.pop();
  assert.match(witnessProblems(rolled, seen).join(), /behind the witnessed head/);
  const fork = ledger(); approve(fork, s, "a", H("1")); approve(fork, s, "x", H("9"));
  assert.match(witnessProblems(fork, seen).join(), /forked or rewritten/);
  assert.match(WITNESS_SQL, /approval_witness_no_update[\s\S]*approval_witness_no_delete[\s\S]*approval_witness_monotonic/);
  assert.equal(entryHash(l.entries[0]).length, 64); void genesisFor; void sign; void COMMIT;
});

test("the schema refuses a baseline with a signature, an unsigned approval, an entry with both id and file, a malformed or non-canonical signature, and an unknown field", () => {
  const v = createValidator([schema]), s = keys(), l = ledger();
  approve(l, s, "murabaha", H("1"));
  const p = (m) => { const c = clone(l); m(c); return formatProblems(v.validate(c, schema.$id)).join("\n"); };
  assert.match(p((c) => { delete c.entries[0].sig; }), /sig/);
  assert.match(p((c) => { c.entries[0].status = "baseline"; }), /excluded shape/);
  assert.match(p((c) => { c.entries[0].file = "x.js"; }), /./);
  assert.match(p((c) => { c.entries[0].sig = "not-a-signature"; }), /sig/);
  assert.match(p((c) => { c.entries[0].extra = 1; }), /unknown property/);
  assert.match(p((c) => { delete c.id; }), /id/);
  assert.match(p((c) => { c.entries[0].at = "2026-10-07T10:00:00+00:00"; }), /at/);
});

test("F7: roster proposals EXPIRE (a signed expiry): a stale proposal can never be completed later by a changed roster", async () => {
  const a = keys("Dr A"), b = keys("Dr B"), c = keys("Dr C"), m = keys("Dr M"), r = rosterOf(a, b, c);
  // zz3: A proposes adding M under {A,B,C}; C is removed (A+B); long after, B signs the old proposal: with no expiry that completes (A and B are a majority of {A,B})
  const stale = ledger(); addMember(stale, a, m, { expires: "2026-10-07T10:00:30.000Z" }); removeMember(stale, a, c); removeMember(stale, b, c);
  addMember(stale, b, m, { expires: "2026-10-30T00:00:00.000Z" }); approve(stale, m, "x", H("1"));
  assert.match(await problems(stale, r), /"Dr M", who is not in the reviewer roster/, "A's proposal lapsed before B signed: one live signature is not a majority of {A,B}");
  // a proposal must carry an expiry, after its time, within 14 days
  const noExp = ledger(); append(noExp, a, { member: { name: m.name, publicKey: m.publicKey }, sha256: memberHash(m), status: "roster-add" });
  assert.match(await problems(noExp, r), /signed expiry after its time and within 14 days/);
  assert.match(await problems((() => { const l = ledger(); addMember(l, a, m, { expires: "2026-12-31T00:00:00.000Z" }); return l; })(), r), /within 14 days/);
  assert.match(await problems((() => { const l = ledger(); addMember(l, a, m, { expires: "2026-10-07T09:00:00.000Z" }); return l; })(), r), /after its time/);
  // a fresh pair completes it
  const ok = ledger(); addMember(ok, a, m); addMember(ok, b, m); approve(ok, m, "x", H("1"));
  assert.deepEqual((await verify(ok, r)).problems, []);
});

test("F7: a verification-refused entry is rejected at APPEND time (checkAppend), so two members cannot brick a ledger", async () => {
  const a = keys("Dr A"), b = keys("Dr B"), c = keys("Dr C"), r = rosterOf(a, b, c), ctx = { expect: expectOf(ledger()), bootstrap: r, now: NOW };
  const l = ledger(); approve(l, a, "x", H("1")); append(l, a, { id: "x", sha256: H("1"), status: "withdrawn", statement: "Withdrawn: the ruling is wrong." });
  removeMember(l, b, a);                                        // one of three: pending
  const tmp = JSON.parse(JSON.stringify(l)); removeMember(tmp, c, a);   // the second signature would complete a removal of the vetoer: the verifier refuses it
  const bad = tmp.entries.at(-1), pre = { ...l, entries: l.entries };
  const refused = await checkAppend(pre, bad, ctx);
  assert.equal(refused.ok, false); assert.match(refused.problems.join(), /open hold/);
  const good = JSON.parse(JSON.stringify(l)); approve(good, b, "x", H("1")); const g = good.entries.at(-1);
  assert.equal((await checkAppend(pre, g, ctx)).ok, true);
  assert.equal(l.entries.length, pre.entries.length, "checkAppend never mutates the ledger");
});

test("H1: a baseline counts as approved copy, so only the owner's signed pin can create one: no pin, another set, a missing anchor and a non-persian kind all fail", async () => {
  const mkB = (files = ["a.js", "b.js"]) => { const l = ledger("persian", files.length); files.forEach((f, i) => append(l, null, { file: f, sha256: H(String(i + 1)), status: "baseline" })); return l; };
  const l = mkB(), good = expectOf(l);
  assert.deepEqual((await verifyLedger(l, { expect: good, bootstrap: [], now: NOW })).problems, [], "the owner's pin of exactly this set (with the anchor) verifies");
  const bare = { id: l.id, project: l.project, kind: l.kind, subject: l.subject };
  assert.match((await verifyLedger(l, { expect: bare, bootstrap: [], now: NOW })).problems.join(), /pins no baseline: a baseline counts as approved copy/);
  assert.match((await verifyLedger(l, { bootstrap: [], now: NOW })).problems.join(), /pins no baseline/, "no expectation at all");
  assert.match((await verifyLedger(l, { expect: { ...good, anchor: null }, bootstrap: [], now: NOW })).problems.join(), /needs the owner-signed record's anchor/);
  const other = mkB(["a.js", "z.js"]);
  assert.match((await verifyLedger(other, { expect: good, bootstrap: [], now: NOW })).problems.join(), /not the set the owner-signed trust record pins/);
  const more = mkB(["a.js", "b.js", "c.js"]);
  assert.match((await verifyLedger(more, { expect: good, bootstrap: [], now: NOW })).problems.join(), /not the set the owner-signed trust record pins/);
  const swapped = mkB(); swapped.entries[1].sha256 = H("9");
  assert.match((await verifyLedger(swapped, { expect: good, bootstrap: [], now: NOW })).problems.join(), /not the set|prev does not match/);
  assert.equal(baselineHash([{ file: "b", sha256: H("2") }, { file: "a", sha256: H("1") }]), baselineHash([{ file: "a", sha256: H("1") }, { file: "b", sha256: H("2") }]), "the pin is over the sorted pairs");
});

test("L3: times are compared as instants: an entry in a different fractional form is not 'earlier' by string order", async () => {
  const s = keys(), l = ledger();
  approve(l, s, "a", H("1"), { at: "2026-10-07T10:00:00.900Z" }); approve(l, s, "b", H("2"), { at: "2026-10-07T10:00:00.950Z" });
  assert.deepEqual((await verify(l, rosterOf(s))).problems, []);
  const back = ledger(); approve(back, s, "a", H("1"), { at: "2026-10-07T10:00:01.000Z" }); approve(back, s, "b", H("2"), { at: "2026-10-07T10:00:00.999Z" });
  assert.match(await problems(back, rosterOf(s)), /back-dated/);
});
