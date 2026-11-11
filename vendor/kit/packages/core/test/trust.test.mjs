// T1: the trust root. Who may approve what is signed by the OWNER's SSH key and checked against keys an agent cannot write (the owner's GitHub SSH signing keys, discovery only, for an
// owner pinned outside the repository). Editing the vendored registry, the record or the ledger can never add an approver.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSshSig, sshEd25519Raw, sshFingerprint, keyFingerprint, verifySshSig, ownerKeysFromGithub, verifyTrustRecord, recordHash, trustBody, trustNamespace } from "../src/trust.js";
import { trustedApprovals } from "../src/approvals.js";
import { newOwnerKey, sshSign } from "./fixtures/ssh.mjs";
import { makeRecord, chain } from "./fixtures/trustrec.mjs";
import { keys } from "./fixtures/ledger.mjs";

const OWNER = newOwnerKey(), AGENT = newOwnerKey(), REPO = "SaasReport/site", NOW = Date.parse("2026-10-08T00:00:00Z");
const A = keys("Dr A");
const approvals = () => ({ concepts: "shariah", shariah: { ledger: "shariah-review.json", anchor: null, roster: [{ name: "Dr A", publicKey: A.publicKey }] } });
const record = (over = {}, key = OWNER) => makeRecord({ project: "p", approvals: approvals(), ...over, key });
const ctx = (over = {}) => ({ owner: "masoud", ownerKeys: [OWNER.rawB64], project: "p", repo: REPO, now: NOW, ...over });
const problems = async (r, c) => (await verifyTrustRecord(r, c)).problems.join("\n");
const OLD = "2020-01-01T00:00:00Z";

test("an OpenSSH SSHSIG signature (ssh-keygen -Y sign) verifies under the owner's key, and nothing else does", async () => {
  const NS = trustNamespace("p"), m = "the exact body", sig = sshSign(OWNER, m, NS);
  assert.deepEqual(parseSshSig(sig).rawKey, OWNER.rawB64);
  assert.equal((await verifySshSig(sig, m, NS, [OWNER.rawB64])).ok, true);
  assert.match((await verifySshSig(sig, m + "x", NS, [OWNER.rawB64])).problem, /does not verify/);
  assert.match((await verifySshSig(sig, m, "other@namespace", [OWNER.rawB64])).problem, /namespace/);
  assert.match((await verifySshSig(sig, m, NS, [AGENT.rawB64])).problem, /not one of the owner's/);
  assert.match((await verifySshSig("-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----", m, NS, [OWNER.rawB64])).problem, /not an SSHSIG|malformed/);
  assert.equal(sshEd25519Raw(OWNER.line), OWNER.rawB64);
  assert.equal(sshEd25519Raw("ssh-rsa AAAAB3NzaC1yc2E"), null);
});

test("M2: GitHub is DISCOVERY only: pinned fingerprints decide when given; without pins a key added recently (created_at) is refused; failures trust nothing", async () => {
  const ok = async (url) => { assert.match(url, /\/users\/masoud\/ssh_signing_keys$/); return { ok: true, json: async () => [{ key: "ssh-rsa AAAAB3NzaC1yc2E x", created_at: OLD }, { key: OWNER.line, created_at: OLD }] }; };
  assert.deepEqual(await ownerKeysFromGithub("masoud", ok, { now: NOW }), [OWNER.rawB64]);
  // an intruder adds a key to the owner's GitHub account: refused while it is recent, and never accepted when the owner's fingerprints are pinned
  const fresh = async () => ({ ok: true, json: async () => [{ key: OWNER.line, created_at: OLD }, { key: AGENT.line, created_at: "2026-10-07T23:00:00Z" }] });
  assert.deepEqual(await ownerKeysFromGithub("masoud", fresh, { now: NOW }), [OWNER.rawB64], "the key added an hour ago is refused");
  assert.deepEqual(await ownerKeysFromGithub("masoud", fresh, { now: NOW, pins: [sshFingerprint(OWNER.line)] }), [OWNER.rawB64]);
  const old = async () => ({ ok: true, json: async () => [{ key: OWNER.line, created_at: OLD }, { key: AGENT.line, created_at: OLD }] });
  assert.deepEqual(await ownerKeysFromGithub("masoud", old, { now: NOW, pins: [sshFingerprint(OWNER.line)] }), [OWNER.rawB64], "an OLD key that is not pinned is ignored when pins exist");
  await assert.rejects(ownerKeysFromGithub("masoud", old, { now: NOW, pins: [sshFingerprint(newOwnerKey().line)] }), /matches a pinned fingerprint/);
  await assert.rejects(ownerKeysFromGithub("masoud", async () => ({ ok: true, json: async () => [{ key: AGENT.line, created_at: "2026-10-07T23:00:00Z" }] }), { now: NOW }), /older than 7 days/);
  await assert.rejects(ownerKeysFromGithub("masoud", async () => ({ ok: false, status: 503 }), { now: NOW }), /503/);
  await assert.rejects(ownerKeysFromGithub("masoud", async () => ({ ok: true, json: async () => [{ key: "ssh-rsa AAAA", created_at: OLD }] }), { now: NOW }), /older than 7 days/);
  await assert.rejects(ownerKeysFromGithub("../etc", ok), /not a GitHub user name/);
  assert.match(sshFingerprint(OWNER.line), /^SHA256:[A-Za-z0-9+/]{43}$/);
});

test("T1: a record verifies only when signed by the owner's key, for the pinned owner, this project and this repository", async () => {
  assert.equal(await problems(record(), ctx()), "");
  const forged = record({ approvals: { ...approvals(), shariah: { ...approvals().shariah, roster: [{ name: "Agent", publicKey: A.publicKey }] } } }, AGENT);
  assert.match(await problems(forged, ctx()), /not one of the owner's published signing keys/);
  const edited = record(); edited.approvals.shariah.roster.push({ name: "Agent", publicKey: keys("Agent").publicKey, fingerprint: keyFingerprint(keys("x").publicKey) });
  assert.match(await problems(edited, ctx()), /does not verify|fingerprint/);
  assert.match(await problems(record({ owner: "agent" }, AGENT), ctx({ ownerKeys: [AGENT.rawB64] })), /pinned owner is "masoud"/);
  assert.match(await problems(record(), ctx({ owner: null })), /not pinned outside the repository/);
  assert.match(await problems(record(), ctx({ ownerKeys: [] })), /no owner key is available/);
  assert.match(await problems(record(), ctx({ repo: "SaasReport/other" })), /is for repository SaasReport\/site, but this is SaasReport\/other/);
  assert.match(await problems(record(), ctx({ repo: null })), /repository being checked is unknown/);
  assert.match(await problems(record({ project: "q", namespaceProject: "q" }), ctx()), /is for "q", not "p"/);
  assert.match(await problems(null, ctx()), /no owner-signed trust record/);
  const unsigned = record(); delete unsigned.signature;
  assert.match(await problems(unsigned, ctx()), /unsigned|signature/);
  assert.match(await problems(record({ approvals: { shariah: { ...approvals().shariah, roster: [{ name: "Dr W", publicKey: Buffer.from("01" + "00".repeat(31), "hex").toString("base64"), fingerprint: "SHA256:" + "A".repeat(43) }] } } }), ctx()), /key is/);
  assert.match(await problems(record({ approvals: { shariah: { ...approvals().shariah, migration: { sha256: "a".repeat(64), entries: 1 } } } }), ctx()), /no migration/);
});

test("M1: a roster member carries the approval key's FINGERPRINT, checked against the key (the owner compares it with the signing page's before signing)", async () => {
  const r = record();
  assert.equal(r.approvals.shariah.roster[0].fingerprint, keyFingerprint(A.publicKey));
  assert.match(keyFingerprint(A.publicKey), /^SHA256:[A-Za-z0-9+/]{43}$/);
  const swapped = record({ approvals: { shariah: { ledger: "shariah-review.json", anchor: null, roster: [{ name: "Dr A", publicKey: keys("Agent").publicKey, fingerprint: keyFingerprint(A.publicKey) }] } } });
  assert.match(await problems(swapped, ctx()), /fingerprint does not match the key/, "a key the agent supplied under the fingerprint the owner expected");
  const none = record({ approvals: { shariah: { ledger: "shariah-review.json", anchor: null, roster: [{ name: "Dr A", publicKey: A.publicKey }] } } });
  delete none.approvals.shariah.roster[0].fingerprint;
  assert.match(await problems(none, ctx()), /fingerprint/);
});

test("L1 / H3: the trust record is validated against its schema; trustedApprovals takes the highest VERIFIED record and the supersedes chain", async () => {
  const [r1, r2] = chain([{ project: "p", approvals: approvals(), seq: 1, key: OWNER }, { project: "p", approvals: approvals(), seq: 2, key: OWNER }]);
  const ctxT = { owner: "masoud", ownerKeys: [OWNER.rawB64], repo: REPO, now: NOW, pin: { minSeq: 1 } };
  const a = await trustedApprovals({ records: [r1, r2] }, "p", ctxT);
  assert.equal(a.known, true); assert.equal(a.record.seq, 2); assert.equal(a.shariah.id, "p:shariah");
  assert.equal(r2.supersedes, recordHash(r1));
  // a higher record that is present but INVALID (forged, or not chained) fails closed: it must not be a way to fall back to an older, weaker record
  const forged = makeRecord({ project: "p", approvals: approvals(), seq: 3, key: AGENT });
  const f = await trustedApprovals({ records: [r1, r2, forged] }, "p", ctxT);
  assert.equal(f.known, false); assert.match(f.problems.join(), /higher-seq record is present but invalid/);
  const broken = makeRecord({ project: "p", approvals: approvals(), seq: 3, supersedes: "b".repeat(64), key: OWNER });
  assert.equal((await trustedApprovals({ records: [r1, r2, broken] }, "p", ctxT)).known, false);
  // schema: an unknown field and a wrong type are refused (the record is validated, not trusted by shape)
  const extra = makeRecord({ project: "p", approvals: approvals(), seq: 1, extra: { surprise: true }, key: OWNER });
  assert.match(await problems(extra, ctx()), /trust record schema/);
  assert.match(await problems(makeRecord({ project: "p", approvals: approvals(), seq: 1, supersedes: "c".repeat(64), key: OWNER }), ctx()), /seq 1 supersedes nothing/);
  assert.equal((await trustedApprovals({ records: [forged] }, "p", ctxT)).known, false);
  assert.equal((await trustedApprovals({ records: [] }, "p", ctxT)).known, false);
});

test("L2 / L3 / F2: a record expires; no clock fails closed; times are compared as instants; the signature is bound to the PROJECT namespace", async () => {
  assert.equal(await problems(record(), ctx({ now: Date.parse("2027-01-01T00:00:00Z") })), "");
  assert.match(await problems(record({ expires: "2027-10-07T10:00:00.000Z" }), ctx({ now: Date.parse("2028-01-01T00:00:00Z"), nowSource: "the witness's clock" })), /expired at 2027-10-07.*witness's clock/);
  assert.match(await problems(record(), ctx({ now: null })), /no clock is available/);
  assert.match(await problems(record({ expires: "nonsense" }), ctx()), /expiry|schema/);
  // instants, not strings: an expiry written in another fractional form is still compared as a time
  assert.match(await problems(record({ at: "2026-10-07T10:00:00Z", expires: "2026-10-07T10:00:00.000Z" }), ctx()), /no valid expiry after its signing time/);
  assert.equal(await problems(record({ at: "2026-10-07T10:00:00.5Z", expires: "2026-10-07T10:00:00.9Z" }), ctx({ now: Date.parse("2026-10-07T10:00:00.7Z") })), "");
  const r = makeRecord({ project: "p", approvals: approvals(), key: OWNER, namespaceProject: "q" });
  assert.match(await problems(r, ctx()), /namespace is "kit-trust@q", not "kit-trust@p"/);
});

test("F5: the GitHub key fetch is authenticated, cached with ETag, and fails CLOSED with a clear message on 403/429", async () => {
  const seen = [], cache = new Map(), c = { get: (o) => cache.get(o), set: (o, e) => cache.set(o, e) };
  const h = (o) => ({ get: (k) => o[k.toLowerCase()] });
  const fake = async (url, init) => { seen.push(init.headers); if (init.headers["if-none-match"] === '"e1"') return { ok: false, status: 304 }; return { ok: true, status: 200, headers: h({ etag: '"e1"' }), json: async () => [{ key: OWNER.line, created_at: OLD }] }; };
  assert.deepEqual(await ownerKeysFromGithub("masoud", fake, { token: "tok", cache: c, now: NOW }), [OWNER.rawB64]);
  assert.equal(seen[0].authorization, "Bearer tok"); assert.equal(seen[0]["if-none-match"], undefined);
  assert.deepEqual(await ownerKeysFromGithub("masoud", fake, { token: "tok", cache: c, now: NOW }), [OWNER.rawB64], "a 304 reuses the cached list");
  assert.equal(seen[1]["if-none-match"], '"e1"');
  for (const status of [403, 429]) await assert.rejects(ownerKeysFromGithub("masoud", async () => ({ ok: false, status, headers: h({ "x-ratelimit-reset": "1893456000" }) }), { cache: c }), /rate limit[\s\S]*FAILS CLOSED[\s\S]*KIT_GITHUB_TOKEN/);
});
