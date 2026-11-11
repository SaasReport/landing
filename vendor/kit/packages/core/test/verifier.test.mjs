// H2 / F1 / F4: the remote verifier. The gate believes only a verdict SIGNED by the key the owner-signed record pins, bound to the repository, the commit, the ledger head, the record,
// the content state and the gate's nonce. The verifier reads the repository at the commit ITSELF (source) and runs the full check; the repo comes from the caller's authenticated
// identity, the signing key is injected, and a verdict never replaces the witness check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyRequest, verifierEndpoint, remoteVerify } from "../src/verifier.js";
import { signVerdict, verifyVerdict, newNonce } from "../src/verdict.js";
import { recordHash } from "../src/trust.js";
import { ledgerHead } from "../src/ledger.js";
import { witnessedHead } from "../src/witness.js";
import { newOwnerKey } from "./fixtures/ssh.mjs";
import { makeRecord } from "./fixtures/trustrec.mjs";
import { d1 } from "./fixtures/d1.mjs";
import { keys, ledger, approve } from "./fixtures/ledger.mjs";

const OWNER = newOwnerKey(), AGENT = newOwnerKey(), REPO = "SaasReport/site", A = keys("Dr A"), H = (c) => c.repeat(64), SHA = "c".repeat(40);
const vk = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
const VPUB = Buffer.from(await crypto.subtle.exportKey("raw", vk.publicKey)).toString("base64");
const OTHER = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
const record = (seq = 1, over = {}, key = OWNER) => makeRecord({ project: "testproject", approvals: { concepts: "shariah", shariah: { ledger: "shariah-review.json", anchor: null, roster: [{ name: "Dr A", publicKey: A.publicKey }] } }, seq, key, ...over, extra: { verifier: { url: "https://broker/verify", publicKey: VPUB, required: true }, ...(over.extra || {}) } });
const led = (n = 2) => { const l = ledger(); for (let i = 0; i < n; i++) approve(l, A, `c-${i}`, H(String(i + 1)), { at: `2026-01-01T00:00:0${i}.000Z` }); return l; };
const source = (l, r, over = {}) => ({ record: async () => r, file: async () => JSON.stringify(l), history: async () => [], contentState: async () => ({ hash: H("e"), problems: [] }), ...over });
const ctx = (db, l, r, over = {}) => ({ repo: REPO, owner: "masoud", ownerKeys: [OWNER.rawB64], db, source: source(l, r), signKey: vk.privateKey, pin: { minSeq: 1, verifier: { url: "https://broker/verify", publicKey: VPUB, required: true } }, ...over });
const req = (over = {}) => ({ project: "testproject", kind: "shariah", sha: SHA, nonce: newNonce(), ...over });
const bindOf = (l, r, n, over = {}) => ({ repo: REPO, sha: SHA, nonce: n, ledgerHead: ledgerHead(l), recordHash: recordHash(r), contentHash: H("e"), ...over });

test("the verifier reads the repository at the commit itself, checks the record, the ledger, the history and the content, witnesses both, and SIGNS a bound verdict", async () => {
  const db = d1(), l = led(2), r = record(1), body = req();
  const res = await verifyRequest(body, ctx(db, l, r));
  assert.deepEqual(res.problems, []); assert.equal(res.ok, true);
  assert.equal(res.verdict.repo, REPO); assert.equal(res.verdict.sha, SHA); assert.equal(res.verdict.contentHash, H("e"));
  assert.deepEqual(await verifyVerdict(res, VPUB, bindOf(l, r, body.nonce)), []);
  assert.equal((await witnessedHead(db, "testproject:trust")).seq, 1);
  assert.equal((await witnessedHead(db, `testproject:shariah@${l.anchor.genesis}`)).seq, 2);
});

test("H2: an unsigned {ok:true}, a verdict signed by ANY other key, a replayed nonce and a verdict for another commit, head, record or content are not verdicts", async () => {
  const db = d1(), l = led(2), r = record(1), body = req();
  const good = await verifyRequest(body, ctx(db, l, r));
  const bind = bindOf(l, r, body.nonce), V = (s, key = VPUB, b = bind) => verifyVerdict(s, key, b);
  assert.match((await V({ ok: true, problems: [] })).join(), /carries no signed verdict/);
  assert.match((await V({ verdict: good.verdict })).join(), /carries no signed verdict/);
  const wrongKey = await signVerdict(good.verdict, OTHER.privateKey);
  assert.match((await V(wrongKey)).join(), /does not verify under the verifier key the owner-signed record pins/);
  assert.match((await V(good, VPUB, { ...bind, nonce: newNonce() })).join(), /another request \(nonce differs\)/);
  assert.match((await V(good, VPUB, { ...bind, sha: "d".repeat(40) })).join(), /for commit cccccccccccc, not dddddddddddd/);
  assert.match((await V(good, VPUB, { ...bind, repo: "SaasReport/other" })).join(), /is for repository/);
  assert.match((await V(good, VPUB, { ...bind, ledgerHead: { seq: 9, hash: H("9") } })).join(), /another ledger head/);
  assert.match((await V(good, VPUB, { ...bind, recordHash: H("8") })).join(), /another trust record/);
  assert.match((await V(good, VPUB, { ...bind, contentHash: H("7") })).join(), /another content state/);
  // a tampered verdict (ok flipped) breaks the signature; a signed ok:false verdict is a failure that says so
  assert.match((await V({ ...good, verdict: { ...good.verdict, ok: false } })).join(), /does not verify/);
  const bad = await verifyRequest(req(), ctx(d1(), l, r, { source: source(l, r, { history: async () => ["a merge hid a withdrawal"] }) }));
  assert.equal(bad.ok, false); assert.match(bad.problems.join(), /a merge hid a withdrawal/);
  assert.match((await V(bad, VPUB, bindOf(l, r, bad.verdict.nonce))).join(), /NOT ok/);
});

test("F1 (fixed proof): the repository comes from the caller's AUTHENTICATED identity; a body that names another repo is ignored, a record for another repo is refused, and an agent pin or key trusts nothing", async () => {
  const l = led(2), r = record(1);
  const lie = await verifyRequest({ ...req(), repo: "Evil/site", github: "Evil/site" }, ctx(d1(), l, r));
  assert.equal(lie.ok, true); assert.equal(lie.verdict.repo, REPO, "the body's repo is ignored: the verdict names the authenticated one");
  // the record for another repository is refused even when the BODY claims it is this one
  const other = record(1, { github: "SaasReport/other" });
  assert.match((await verifyRequest({ ...req(), repo: "SaasReport/other" }, ctx(d1(), l, other))).problems.join(), /is for repository SaasReport\/other, but this is SaasReport\/site/);
  assert.match((await verifyRequest(req(), ctx(d1(), l, r, { repo: "SaasReport/other" }))).problems.join(), /but this is SaasReport\/other/);
  assert.match((await verifyRequest(req(), ctx(d1(), l, record(1, { owner: "agent", key: AGENT })))).problems.join(), /pinned owner is "masoud"/);
  assert.match((await verifyRequest(req(), ctx(d1(), l, record(1, { key: AGENT })))).problems.join(), /not one of the owner's published signing keys/);
});

test("F2 / H3: the record's seq is witnessed and chained, a floor refuses an older record on a replaced database, and expiry is judged by the witness's clock", async () => {
  const db = d1(), l = led(2), r1 = record(1);
  assert.equal((await verifyRequest(req(), ctx(db, l, r1))).ok, true);
  const r2 = record(2, { supersedes: recordHash(r1) });
  assert.equal((await verifyRequest(req(), ctx(db, l, r2))).ok, true);
  assert.match((await verifyRequest(req(), ctx(db, l, r1))).problems.join(), /behind the witnessed seq 2/);
  assert.match((await verifyRequest(req(), ctx(d1(), l, r1, { floor: { recordSeq: 2 } }))).problems.join(), /below the owner's checkpoint floor/);
  const lapsed = record(1, { at: "2019-01-01T00:00:00.000Z", expires: "2020-01-01T00:00:00.000Z" });
  assert.match((await verifyRequest(req(), ctx(d1(), l, lapsed))).problems.join(), /expired at 2020-01-01.*witness's clock/);
});

test("the ledger is verified against the signed record and witnessed: a forged entry, a truncation, a missing database, a bad request and a missing key are refused", async () => {
  const db = d1(), l = led(3), r = record(1);
  assert.equal((await verifyRequest(req(), ctx(db, l, r))).ok, true);
  assert.match((await verifyRequest(req(), ctx(db, led(1), r))).problems.join(), /behind the witnessed head/);
  const bad = JSON.parse(JSON.stringify(l)); bad.entries[0].statement = "edited";
  assert.equal((await verifyRequest(req(), ctx(d1(), bad, r))).ok, false);
  assert.match((await verifyRequest(req(), ctx(null, l, r))).problems.join(), /no witness database/);
  for (const b of [{ project: "x y" }, req({ sha: "short" }), req({ nonce: "x" }), req({ kind: "bogus" })]) assert.match((await verifyRequest(b, ctx(db, l, r))).problems.join(), /bad request/);
  assert.match((await verifyRequest(req(), ctx(db, l, r, { signKey: null }))).problems.join(), /signing key/);
  assert.match((await verifyRequest(req({ kind: "persian" }), ctx(d1(), l, r))).problems.join(), /names no persian ledger/);
  await assert.rejects(signVerdict({}, null), /injected/);
});

test("the endpoint needs the broker's context, caps the body while streaming; remoteVerify believes only the pinned key's signed, bound verdict and fails closed otherwise", async () => {
  assert.throws(() => verifierEndpoint({}), /`context` is required/);
  const db = d1(), l = led(2), r = record(1);
  const h = verifierEndpoint({ context: (rq) => (rq.headers.get("authorization") === "Bearer oidc" ? ctx(db, l, r) : null), maxBytes: 500 });
  const via = async (url, init) => h(new Request(url, init));
  const pinned = { url: "https://broker/verify", publicKey: VPUB }, bind = (n) => bindOf(l, r, n);
  const okRes = await remoteVerify(via, pinned, "oidc", { project: "testproject", kind: "shariah", sha: SHA, nonce: "f".repeat(32) }, bind("f".repeat(32)));
  assert.equal(okRes.ok, true, okRes.problems.join());
  const denied = await remoteVerify(via, pinned, "wrong", { project: "testproject", kind: "shariah", sha: SHA }, bind("0".repeat(32)));
  assert.equal(denied.ok, false); assert.match(denied.problems.join(), /no signed verdict/);
  assert.match((await remoteVerify(async () => { throw new Error("ECONNREFUSED"); }, pinned, "t", { project: "p", kind: "shariah", sha: SHA }, bind("0".repeat(32)))).problems.join(), /unreachable.*fails closed/);
  // THE STUB: {ok:true} from anybody is not a verdict
  assert.equal((await remoteVerify(async () => ({ status: 200, ok: true, json: async () => ({ ok: true, problems: [] }) }), pinned, "t", { project: "p", kind: "shariah", sha: SHA }, bind("0".repeat(32)))).ok, false);
  // a signature by another key under the same shape
  const forgedVerdict = async (url, init) => { const b = JSON.parse(init.body); const s = await signVerdict({ repo: REPO, sha: SHA, ledgerHead: ledgerHead(l), recordHash: recordHash(r), contentHash: H("e"), nonce: b.nonce, now: "x", ok: true }, OTHER.privateKey); return { status: 200, ok: true, json: async () => s }; };
  const f = await remoteVerify(forgedVerdict, pinned, "t", { project: "p", kind: "shariah", sha: SHA }, bind("0".repeat(32)));
  assert.equal(f.ok, false);
  assert.equal((await h(new Request("https://v/", { method: "GET" }))).status, 405);
  const big = await h(new Request("https://v/", { method: "POST", headers: { authorization: "Bearer oidc" }, body: "x".repeat(2000) }));
  assert.equal(big.status, 413);
});
