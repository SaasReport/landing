// Round 4 of the reviews of #116 (F2 record rollback and expiry, F3 durable witness, F5 authenticated GitHub fetch, F6 merge workflows, F7 proposals and append-time refusal,
// F8 endpoint, F1/F4 the remote verifier). The local CLI cannot be made trustworthy against the agent that runs it; these tests show the broker's verdict is the one that counts.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLedger, ledgerHistoryProblems, writeLedgerFile, appendChecked } from "../src/ledger-io.js";
import { gitSource } from "../src/content-state.js";
import { bundled, kitFor } from "../src/bundled.js";
import { TEST } from "../src/test-seam.js";
import { witnessEndpoint } from "@saasreport/core/witness";
import { verifierEndpoint } from "@saasreport/core/verifier";
import { keys, approve, append, addMember, removeMember, rosterOf, ledger as coreLedger, expectOf } from "../../core/test/fixtures/ledger.mjs";
import { d1 } from "../../core/test/fixtures/d1.mjs";
import { newOwnerKey } from "../../core/test/fixtures/ssh.mjs";
import { fileTempDir } from "../../core/test/support/temp.mjs";
import { readJson, writeJson, git, commit, initRepo, trustWith, signedRecord, run as runIn, keygen, setKeyDir, seamFor, OWNER, OWNER_NAME, REPO } from "./approvals-helpers.mjs";
import { config, catalogue } from "../../core/test/fixtures/concepts.mjs";

const TMP = fileTempDir("kit-r4-");
let SCHOLAR, SECOND;
const PROJECT = "saasreport";
before(async () => { setKeyDir(join(TMP, "keys")); SCHOLAR = await keygen(TMP, "scholar"); SECOND = await keygen(TMP, "second"); });
const H = (c) => c.repeat(64), C = (x) => JSON.parse(JSON.stringify(x));
const approvals = (extra = {}) => ({ concepts: "shariah", shariah: { ledger: "shariah-review.json", anchor: null, roster: [{ name: "Dr Reviewer", publicKey: SCHOLAR.pub }, { name: "Dr Second", publicKey: SECOND.pub }], ...extra } });
const CANON = { $schema: "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/canon.schema.json", project: PROJECT };
const texts = (cat) => Object.fromEntries(cat.concepts.filter((c) => c.accuracy.status === "verified").flatMap((c) => c.sources.map((s) => [`texts/${s.sha256}.txt`, `…${s.quote}…`])));
async function repo(name, trust) {
  const root = join(TMP, name); initRepo(root);
  const cfg = config({ order: { strategy: "catalogue" }, gate: { accuracy: { minVerifiedPrefix: 2, unverified: "never" } } }), cat = catalogue();
  for (const [f, b] of Object.entries({ "concepts.config.json": cfg, [cfg.catalogue]: cat, "kit.canon.json": CANON, ".github/CODEOWNERS": "/shariah-review.json @s\n/concepts.config.json @s\n", ...texts(cat) })) writeJson(root, f, b);
  commit(root);
  await runIn(root, ["shariah", "init"], { trust }); commit(root);
  await runIn(root, ["shariah", "approve", "--by", "Dr Reviewer", "--key", SCHOLAR.file, "--statement", "Read the entry and the AAOIFI text.", "murabaha"], { trust }); commit(root, "approve");
  return root;
}
// the broker: its own pin, its own credential (the owner's keys), its own witness database and signing key; it reads the repository at the commit ITSELF (gitSource);
// the repository comes from the caller's authenticated identity
const VK = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
const VPUB = Buffer.from(await crypto.subtle.exportKey("raw", VK.publicKey)).toString("base64");
const VERIFIER = { url: "https://broker/verify", publicKey: VPUB, required: true };
const withVerifier = (project, ap, opts = {}) => trustWith(project, ap, { ...opts, extra: { verifier: VERIFIER, ...(opts.extra || {}) } });
const broker = (root, trust, over = {}) => {
  const db = d1(), io = { cwd: root, [TEST]: seamFor({ trust }) }, kit = kitFor(io);   // `trust` plays the record COMMITTED in the repo at that commit
  const ctx = { repo: REPO, owner: OWNER_NAME, ownerKeys: [OWNER.rawB64], db, source: gitSource(root, git(root, "rev-parse", "HEAD").stdout.trim(), kit, { record: () => trust.records[0] }), signKey: VK.privateKey, pin: { minSeq: 1, verifier: VERIFIER }, ...over };
  const h = verifierEndpoint({ context: () => ctx });
  return { db, fetch: async (url, init) => h(new Request(url, init)) };
};

test("F1/F4 + H2: the pinned verifier's SIGNED, bound verdict is the one that counts; an agent-controlled gate (its own pin, its own record) passes locally but the broker refuses it; unreachable fails closed", async () => {
  const genuine = withVerifier(PROJECT, approvals());
  const root = await repo("f1", genuine);
  // the verifier is required by the owner-signed record: no configuration needed, an unreachable broker fails the gate closed
  const down = await runIn(root, ["check", "shariah-review"], { trust: genuine, fetch: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(down.code, 1); assert.match(down.err, /remote verifier is unreachable.*fails closed/);
  // the real broker: it reads the repo at HEAD itself, runs the full check, signs the verdict; the gate verifies the signature under the pinned key and the bindings
  const b = broker(root, genuine);
  const ok = await runIn(root, ["check", "shariah-review"], { trust: genuine, fetch: b.fetch });
  assert.equal(ok.code, 0, ok.err);
  // the agent forges a record with ITS OWN key and pins its own owner and verifier in its own process: locally satisfied (this is why a local answer is not authoritative) ...
  const agent = newOwnerKey(), stub = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const stubPub = Buffer.from(await crypto.subtle.exportKey("raw", stub.publicKey)).toString("base64");
  const forged = trustWith(PROJECT, approvals(), { owner: "agent", key: agent, extra: { verifier: { url: "https://attacker.example/v", publicKey: stubPub, required: true } } });
  const { signVerdict } = await import("@saasreport/core/verdict"), { contentHashOf } = await import("../src/content-state.js"), { recordHash } = await import("@saasreport/core/trust"), { ledgerHead } = await import("@saasreport/core/ledger");
  const stubFetch = async (url, init) => { const rq = JSON.parse(init.body); const ap = (await kitFor({ cwd: root, [TEST]: seamFor({ trust: forged, owner: "agent", ownerKeys: [agent.rawB64] }) }).approvals(PROJECT)); const l = readJson(root, "shariah-review.json");
    const s = await signVerdict({ repo: REPO, sha: rq.sha, ledgerHead: ledgerHead(l), recordHash: ap.shariah.record.hash, contentHash: await contentHashOf(root, "shariah", kitFor({ cwd: root, [TEST]: seamFor({ trust: forged, owner: "agent", ownerKeys: [agent.rawB64] }) }), "shariah-review.json"), nonce: rq.nonce, now: "x", ok: true }, stub.privateKey); return { status: 200, ok: true, json: async () => s }; };
  const local = await runIn(root, ["check", "shariah-review"], { trust: forged, fetch: stubFetch, seam: { owner: "agent", ownerKeys: [agent.rawB64] } });
  assert.equal(local.code, 0, local.err);
  // ... but the broker, with the REAL pinned owner, reads that same repo and refuses the forged record in a signed verdict
  const real = broker(root, forged);   // the real broker pins the REAL owner (OWNER_NAME and the owner's keys) whatever the agent's process believes
  const rr = await runIn(root, ["check", "shariah-review"], { trust: forged, fetch: real.fetch, seam: { owner: "agent", ownerKeys: [agent.rawB64] } });
  assert.equal(rr.code, 1);
  // a verifier the record does NOT pin is refused outright; a configured URL that is not the pinned one is refused
  const unpinned = trustWith(PROJECT, approvals());
  const u = await runIn(root, ["check", "shariah-review", "--verifier-url", "https://anywhere/v"], { trust: unpinned, fetch: b.fetch });
  assert.equal(u.code, 1); assert.match(u.err, /pins no verifier/);
  const wrongUrl = await runIn(root, ["check", "shariah-review", "--verifier-url", "https://other/v"], { trust: genuine, fetch: b.fetch });
  assert.equal(wrongUrl.code, 1); assert.match(wrongUrl.err, /not the one the owner pinned/);
  // a verdict NEVER replaces the witness: with witnessFrom set and no durable witness, the verified verdict is not enough
  const witnessed = withVerifier(PROJECT, approvals({ witnessFrom: 0 }));
  const nw = await runIn(root, ["check", "shariah-review"], { trust: witnessed, fetch: broker(root, witnessed).fetch });
  assert.equal(nw.code, 1); assert.match(nw.err, /requires a witness \(witnessFrom 0\) but pins none/);
});

test("F2 / H3 / M6: the trust record chain is witnessed through the PINNED, signing witness: a rolled-back record is refused (the expiry-by-the-witness's-clock case is in core/test/witness.test.mjs)", async () => {
  const db = d1();
  const WK = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]), WIT = { url: "https://w/", publicKey: Buffer.from(await crypto.subtle.exportKey("raw", WK.publicKey)).toString("base64") };
  const T1 = trustWith(PROJECT, approvals({ witnessFrom: 0 }), { seq: 1, extra: { witness: WIT } });
  const { recordHash } = await import("@saasreport/core/trust");
  const T2 = trustWith(PROJECT, approvals({ witnessFrom: 0 }), { seq: 2, supersedes: recordHash(T1.records[0]), extra: { witness: WIT } });
  const root = await repo("f2", T2);
  const ledgerExpect = async (trust) => { const k = bundled({ trust, io: { [TEST]: { owner: OWNER_NAME, ownerKeys: [OWNER.rawB64], repo: REPO, pin: { minSeq: 1 } } } }); const ap = await k.approvals(PROJECT); return { expect: ap.shariah, bootstrap: ap.shariah.bootstrap }; };
  const h = witnessEndpoint(db, { authorize: () => true, signKey: WK.privateKey, resolve: async () => await ledgerExpect(T2), resolveTrust: () => ({ owner: OWNER_NAME, ownerKeys: [OWNER.rawB64], repo: REPO }) });
  const fetchTo = async (url, init) => h(new Request(url, init));
  const go = (trust, extra = {}) => runIn(root, ["check", "shariah-review"], { trust, fetch: fetchTo, ...extra });
  assert.equal((await go(T1)).code, 0, "seq 1 starts the chain");
  assert.equal((await go(T2)).code, 0, "seq 2 follows it");
  const back = await go(T1);
  assert.equal(back.code, 1); assert.match(back.err, /behind the witnessed seq 2: an older record was put back/);
});

test("F5: a 403/429 from GitHub fails the gate closed with the rate-limit reason (the owner's keys are fetched with the environment's token)", async () => {
  const root = await repo("f5", trustWith(PROJECT, approvals()));
  const sent = [];
  const github = async (url, init) => { sent.push(init.headers); return { ok: false, status: 429, headers: { get: () => null } }; };
  const r = await runIn(root, ["check", "shariah-review"], { trust: trustWith(PROJECT, approvals()), fetch: github, env: { ...process.env, KIT_GITHUB_TOKEN: "tok123" }, seam: { ownerKeys: undefined, pin: { minSeq: 1 } } });
  assert.equal(r.code, 1); assert.match(r.err, /rate limit[\s\S]*FAILS CLOSED[\s\S]*KIT_GITHUB_TOKEN/);
  assert.equal(sent[0].authorization, "Bearer tok123");
});

test("F6 / F7 history: the supported merge workflows (rebase, squash) pass; a plain merge keeping either side is refused with how to fix it; the signed anchor is the one way the anchor changes", async () => {
  const root = join(TMP, "f6"); initRepo(root); commit(root, "root");
  const A = keys("Dr A"), expect = { id: "p:shariah", project: "p", kind: "shariah", subject: "id", anchor: null };
  const W = (l) => writeLedgerFile(root, "L.json", l);
  const base = createLedger(root, expect); approve(base, A, "x", H("1")); W(base); commit(root, "base");
  git(root, "checkout", "-q", "-b", "branch");
  const lb = C(base); approve(lb, A, "y", H("2")); W(lb); commit(root, "branch approves y");
  git(root, "checkout", "-q", "main");
  const lm = C(base); approve(lm, A, "z", H("3")); W(lm); commit(root, "main approves z");
  const hp = (l, o = {}) => ledgerHistoryProblems(root, "L.json", l, o).map((p) => p.problem);
  // plain merge keeping main's ledger: refused, and the message says how to fix it
  git(root, "checkout", "-q", "-b", "plain"); git(root, "merge", "-q", "--no-commit", "branch"); W(lm); commit(root, "plain merge");
  assert.match(hp(lm).join(), /To fix: rebase the branch onto the target[\s\S]*squash-merge after re-signing/);
  // SQUASH: main + the branch's entries re-signed on top, one single-parent commit
  git(root, "checkout", "-q", "main"); git(root, "checkout", "-q", "-b", "squash"); git(root, "merge", "--squash", "-q", "branch");
  const sq = C(lm); approve(sq, A, "y", H("2")); W(sq); commit(root, "squash: branch re-signed on top");
  assert.deepEqual(hp(sq), [], "squash after re-signing passes");
  // REBASE: the branch is replayed on top of main, its ledger entry re-signed on top of main's
  git(root, "checkout", "-q", "main"); git(root, "checkout", "-q", "-b", "rebased");
  const rb = C(lm); approve(rb, A, "y", H("2")); W(rb); commit(root, "branch approves y (rebased, re-signed)");
  assert.deepEqual(hp(rb), [], "a rebased branch is linear history: it passes");
  // the anchor: replacing the ledger with a new anchor is refused, unless the owner-signed record names exactly that anchor
  const head = git(root, "rev-parse", "HEAD").stdout.trim();
  const fresh = createLedger(root, { ...expect, anchor: head }); approve(fresh, A, "n", H("5")); W(fresh); commit(root, "a new ledger");
  assert.match(hp(fresh).join(), /the anchor changed in commit/);
  assert.deepEqual(hp(fresh, { anchor: fresh.anchor.commit }), [], "recovery: the owner-signed record names the new anchor");
});

test("F7: a verification-refused entry is rejected at append time, and a roster proposal's expiry is bounded (kit ledger roster)", async () => {
  const a = keys("Dr A"), b = keys("Dr B"), c = keys("Dr C"), r = rosterOf(a, b, c), exp = expectOf(coreLedger());
  const l = coreLedger(); approve(l, a, "x", H("1")); append(l, a, { id: "x", sha256: H("1"), status: "withdrawn", statement: "Withdrawn: the ruling is wrong." }); removeMember(l, b, a);
  const probe = C(l); removeMember(probe, c, a);
  const keyOf = (k) => k.privateKey;
  await assert.rejects(appendChecked(l, r, keyOf(c), { member: { name: "Dr A", publicKey: a.publicKey }, sha256: (await import("@saasreport/core/ledger")).memberHash({ name: "Dr A", publicKey: a.publicKey }), status: "roster-remove", by: "Dr C", expires: new Date(Date.now() + 864e5).toISOString() }, { expect: exp, bootstrap: r }, new Date(Date.UTC(2026, 9, 7, 11, 0, 0))), /refused at append[\s\S]*owner supersedes it with a new owner-signed trust record/);
  assert.equal(l.entries.length, 3, "nothing was written");
  // CLI: a roster proposal with an out-of-range expiry is refused before anything is signed
  const root = await repo("f7", trustWith(PROJECT, approvals()));
  const bad = await runIn(root, ["ledger", "roster", "add", "shariah", "--by", "Dr Reviewer", "--key", SCHOLAR.file, "--name", "Dr Third", "--public-key", keys("t").publicKey, "--expires-days", "30"], { trust: trustWith(PROJECT, approvals()) });
  assert.equal(bad.code, 1); assert.match(bad.err, /--expires-days must be between 0 and 14/);
  const ok = await runIn(root, ["ledger", "roster", "add", "shariah", "--by", "Dr Reviewer", "--key", SCHOLAR.file, "--name", "Dr Third", "--public-key", keys("t").publicKey, "--expires-days", "7"], { trust: trustWith(PROJECT, approvals()) });
  assert.equal(ok.code, 0, ok.err);
  const e = readJson(root, "shariah-review.json").entries.at(-1);
  assert.equal(e.status, "roster-add"); assert.ok(Date.parse(e.expires) > Date.now() && Date.parse(e.expires) - Date.parse(e.at) <= 14 * 864e5);
  void signedRecord; void addMember; void writeFileSync;
});
