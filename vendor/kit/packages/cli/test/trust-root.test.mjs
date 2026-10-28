// The trust root and the attacks of the re-review of #116 (mint.mjs, hist2.mjs, wit.mjs, kg2.mjs, zz2.mjs): T1 owner-signed trust, T2 one-shot migration, T4 witness fails closed,
// T5 positional merge check, T6 custody (no injectable prompt, key place, passphrase at load, signer integrity). Each test is an attack that passed with full history before.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { main } from "../src/index.js";
import { createLedger, ledgerHistoryProblems, writeLedgerFile, keyPathProblem, signerHash, loadApproverKey } from "../src/ledger-io.js";
import { compareUpstream, TRUST_FILES } from "../src/vendor.js";
import { keys, approve, append, rosterOf, ledger as coreLedger } from "../../core/test/fixtures/ledger.mjs";
import { newOwnerKey } from "../../core/test/fixtures/ssh.mjs";
import { fileTempDir } from "../../core/test/support/temp.mjs";
import { PASS, readJson, writeJson, git, commit, initRepo, trustWith, signedRecord, run as runIn, keygen, setKeyDir, seamFor, OWNER, OWNER_NAME, REPO } from "./approvals-helpers.mjs";
import { TEST } from "../src/test-seam.js";
import { config, catalogue } from "../../core/test/fixtures/concepts.mjs";

const TMP = fileTempDir("kit-trust-");
let SCHOLAR, TRUST;
const PROJECT = "saasreport";
before(async () => { setKeyDir(join(TMP, "keys")); SCHOLAR = await keygen(TMP, "scholar"); TRUST = trustWith(PROJECT, { concepts: "shariah", shariah: { ledger: "shariah-review.json", anchor: null, roster: [{ name: "Dr Reviewer", publicKey: SCHOLAR.pub }] } }); });

const H = (c) => c.repeat(64), C = (x) => JSON.parse(JSON.stringify(x));
const CANON = { $schema: "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/canon.schema.json", project: PROJECT };
const texts = (cat) => Object.fromEntries(cat.concepts.filter((c) => c.accuracy.status === "verified").flatMap((c) => c.sources.map((s) => [`texts/${s.sha256}.txt`, `…${s.quote}…`])));
function repo(name) {
  const root = join(TMP, name); initRepo(root);
  const cfg = config({ order: { strategy: "catalogue" }, gate: { accuracy: { minVerifiedPrefix: 2, unverified: "never" } } }), cat = catalogue();
  for (const [f, b] of Object.entries({ "concepts.config.json": cfg, [cfg.catalogue]: cat, "kit.canon.json": CANON, ".github/CODEOWNERS": "/shariah-review.json @s\n/concepts.config.json @s\n", ...texts(cat) })) writeJson(root, f, b);
  commit(root); return root;
}
const run = (root, ...argv) => runIn(root, argv, { trust: TRUST });
const approveCli = (root, ids, io = {}) => runIn(root, ["shariah", "approve", "--by", "Dr Reviewer", "--key", SCHOLAR.file, "--statement", "Read the entry and the AAOIFI text.", ...ids], { trust: TRUST, ...io });

test("T1: the trust root is outside the repository: a forged, re-signed or edited record, an unpinned owner and a wrong repository trust nothing", async () => {
  const root = repo("t1"); await run(root, "shariah", "init"); commit(root);
  assert.equal((await approveCli(root, ["murabaha"])).code, 0);
  commit(root, "approve");
  assert.equal((await run(root, "check", "shariah-review")).code, 0);
  // the agent edits the vendored registry/record: puts ITS key in the roster and signs the record with its own key
  const agent = newOwnerKey(), agentKey = keys("Agent");
  const forged = trustWith(PROJECT, { concepts: "shariah", shariah: { ledger: "shariah-review.json", anchor: null, roster: [{ name: "Agent", publicKey: agentKey.publicKey }] } }, { key: agent });
  let r = await runIn(root, ["check", "shariah-review"], { trust: forged });
  assert.equal(r.code, 1); assert.match(r.err, /not one of the owner's published signing keys/);
  assert.equal((await runIn(root, ["trust", "verify", PROJECT], { trust: forged })).code, 1);
  // ... or edits the roster and keeps the owner's signature
  const edited = C(TRUST); edited.records[0].approvals.shariah.roster.push({ name: "Agent", publicKey: agentKey.publicKey });
  r = await runIn(root, ["check", "shariah-review"], { trust: edited });
  assert.equal(r.code, 1); assert.match(r.err, /does not verify/);
  // ... or names itself as the owner (its own GitHub account): the owner is pinned OUTSIDE the repository
  const selfOwned = trustWith(PROJECT, TRUST.records[0].approvals, { owner: "agent", key: agent });
  r = await runIn(root, ["check", "shariah-review"], { trust: selfOwned, seam: { owner: "agent", ownerKeys: [agent.rawB64] } });
  assert.equal(r.code, 0, "with the agent's own pin it would pass: the pin must come from outside (an org variable), which the agent cannot write");
  r = await runIn(root, ["check", "shariah-review"], { trust: selfOwned });
  assert.equal(r.code, 1); assert.match(r.err, /pinned owner is "owner-test"/);
  // no pin, no keys, a different repository: nothing is trusted
  assert.match((await runIn(root, ["check", "shariah-review"], { trust: TRUST, seam: { owner: null } })).err, /not pinned outside the repository/);
  assert.match((await runIn(root, ["check", "shariah-review"], { trust: TRUST, seam: { ownerKeys: [] } })).err, /no owner key is available/);
  assert.match((await runIn(root, ["check", "shariah-review"], { trust: TRUST, seam: { repo: "SaasReport/other" } })).err, /but this is SaasReport\/other/);
  // approving is refused too: nothing is signed against an untrusted roster
  r = await approveCli(root, ["salam"], { trust: forged });
  assert.equal(r.code, 1);
  assert.equal(readJson(root, "shariah-review.json").entries.length, 1);
  // the registry file itself carries no approvals any more (they are not read from it)
  const projects = JSON.parse(readFileSync(new URL("../../core/registry/projects.json", import.meta.url), "utf8"));
  assert.equal(projects.projects.some((p) => p.approvals), false);
});

test("T1: the vendored trust files are compared with the upstream kit commit (pinned repository and minimum commit; the full test is in review-r2.test.mjs)", async () => {
  const good = "export const ok = 1;\n", bad = "export const ok = 2; // agent edit\n";
  const manifest = { source: { repository: "https://github.com/SaasReport/kit", commit: "a".repeat(40) }, files: [
    { path: "packages/core/src/ledger.js", sha256: createHash("sha256").update(bad).digest("hex") },
    { path: "packages/core/src/ed25519.js", sha256: createHash("sha256").update(good).digest("hex") },
    { path: "packages/core/src/unrelated.js", sha256: "0".repeat(64) }] };
  const pins = { repository: "SaasReport/kit", minCommit: "a".repeat(40) }, seen = [];
  const fake = async (url) => { seen.push(url); if (/\/compare\//.test(url)) return { ok: true, json: async () => ({ status: "identical" }) }; if (/\/git\/trees\//.test(url)) return { ok: true, json: async () => ({ tree: [{ path: "packages/core/src/ledger.js", type: "blob" }, { path: "packages/core/src/ed25519.js", type: "blob" }] }) }; return { ok: true, arrayBuffer: async () => Buffer.from(good) }; };
  const p = await compareUpstream(manifest, "m.json", fake, pins);
  assert.deepEqual(p.map((x) => x.file), ["packages/core/src/ledger.js"]);
  assert.ok(seen.some((u) => /raw\.githubusercontent\.com\/SaasReport\/kit\/a{40}\/packages\/core\/src\/ledger\.js/.test(u)));
  assert.match((await compareUpstream(manifest, "m.json", async () => { throw new Error("offline"); }, pins))[0].problem, /unreachable/);
  assert.match((await compareUpstream(manifest, "m.json", async (u) => (/\/compare\//.test(u) ? { ok: true, json: async () => ({ status: "identical" }) } : /\/git\/trees\//.test(u) ? { ok: true, json: async () => ({ tree: [] }) } : { ok: false, status: 404 }), pins))[0].problem, /not found upstream/);
  assert.ok(TRUST_FILES.test("packages/core/registry/trust/p.json") && TRUST_FILES.test("packages/cli/src/ledger-io.js") && TRUST_FILES.test("packages/core/src/scope.js") && !TRUST_FILES.test("packages/core/src/planner.js"));
});

test("T2 (mint.mjs): a new-format ledger can never be turned back into the old format, and the migration is only the one the owner signed", async () => {
  const root = join(TMP, "t2"); initRepo(root); commit(root, "root");
  const A = keys("Dr A"), expect = { id: "p:persian", project: "p", kind: "persian", subject: "file", anchor: null };
  const W = (t) => writeFileSync(join(root, "fa-review.json"), typeof t === "string" ? t : JSON.stringify(t, null, 2));
  const l = createLedger(root, expect, { baselines: [{ file: "a.md", sha256: H("1") }] }); approve(l, A, "b.md", H("2")); W(l); commit(root, "ledger");
  // step 1: the agent drops `id` and appends forged plain entries (a "new -> old" transition)
  const crafted = C(l); delete crafted.id; crafted.entries.push({ file: "a.md", sha256: H("9") }, { file: "b.md", sha256: H("8") });
  const txt = JSON.stringify(crafted, null, 2); W(txt); commit(root, "step 1");
  // step 2: what `kit persian migrate` would write for the forged old file
  const baselines = [{ file: "a.md", sha256: H("9") }, { file: "b.md", sha256: H("8") }];
  const nl = createLedger(root, expect, { baselines, migratedFrom: { sha256: createHash("sha256").update(txt).digest("hex"), entries: crafted.entries.length } });
  W(nl); commit(root, "step 2: migrate");
  const problems = (mig) => ledgerHistoryProblems(root, "fa-review.json", nl, { migration: mig }).map((p) => p.problem).join("\n");
  assert.match(problems(null), /turned back into the old format/, "step 1 is refused outright");
  assert.match(problems({ sha256: createHash("sha256").update(txt).digest("hex"), entries: crafted.entries.length }), /turned back into the old format/, "even if the owner had signed this file's hash: the new->old step is the attack");
  // the legitimate path: an old file, then the migration the owner signed
  const ok = join(TMP, "t2-ok"); initRepo(ok); 
  const old = { $schema: "x", entries: [{ file: "a.md", sha256: H("1"), status: "baseline", at: "2026-10-06T00:00:00Z" }, { file: "w.md", sha256: H("7"), status: "withdrawn", at: "2026-10-06T00:00:00Z" }] };
  writeJson(ok, "fa-review.json", old); commit(ok, "old");
  const oldSha = createHash("sha256").update(readFileSync(join(ok, "fa-review.json"))).digest("hex");
  const good = createLedger(ok, expect, { baselines: [{ file: "a.md", sha256: H("1") }], migratedFrom: { sha256: oldSha, entries: 2 } });
  writeLedgerFile(ok, "fa-review.json", good); commit(ok, "migrate");
  const hp = (mig, l = good) => ledgerHistoryProblems(ok, "fa-review.json", l, { migration: mig }).map((p) => p.problem).join("\n");
  assert.equal(hp({ sha256: oldSha, entries: 2 }), "");
  assert.match(hp(null), /without the migration the owner-signed trust record names/, "no migration in the record");
  assert.match(hp({ sha256: H("0"), entries: 2 }), /without the migration/, "another file");
  // a withdrawn entry is never carried into a baseline
  const carried = createLedger(ok, expect, { baselines: [{ file: "a.md", sha256: H("1") }, { file: "w.md", sha256: H("7") }], migratedFrom: { sha256: oldSha, entries: 2 } });
  writeLedgerFile(ok, "fa-review.json", carried); commit(ok, "migrate, carrying the withdrawn");
  assert.match(hp({ sha256: oldSha, entries: 2 }, carried), /without the migration|turned back|rewritten|anchor/);
});

test("T2: kit persian migrate never baselines a withdrawn or rejected entry (it stays pending)", async () => {
  const root = join(TMP, "t2-cli"); initRepo(root);
  const CFG = "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/persian-config.schema.json";
  writeJson(root, "kit.canon.json", { ...CANON, project: "saasreport", persian: "persian.config.json" });
  writeJson(root, "persian.config.json", { $schema: CFG, sources: [{ name: "all", files: ["a.md", "b.md"] }], review: {} });
  writeFileSync(join(root, "a.md"), "متن اول برای بازبینی\n"); writeFileSync(join(root, "b.md"), "متن دوم برای بازبینی\n");
  const { reviewState } = await import("../src/canon/persian.js");
  const cur = new Map(reviewState(root, readJson(root, "persian.config.json"), null).map((x) => [x.file, x]));
  const old = { $schema: "x", entries: [{ file: "a.md", sha256: cur.get("a.md").sha256, status: "baseline", at: "2026-10-06T00:00:00Z", segments: 1 }, { file: "b.md", sha256: cur.get("b.md").sha256, status: "rejected", at: "2026-10-06T00:00:00Z", segments: 1 }] };
  writeJson(root, "fa-review.json", old); writeJson(root, ".github/CODEOWNERS", "/fa-review.json @o\n"); commit(root);
  const sha = createHash("sha256").update(readFileSync(join(root, "fa-review.json"))).digest("hex");
  const { baselineHash } = await import("@saasreport/core/ledger"), head = git(root, "rev-parse", "HEAD").stdout.trim();
  const t = trustWith("saasreport", { persian: { ledger: "fa-review.json", anchor: head, roster: [{ name: "Owner Name", publicKey: SCHOLAR.pub }], migration: { sha256: sha, entries: 2 }, baseline: { sha256: baselineHash([{ file: "a.md", sha256: cur.get("a.md").sha256 }]), entries: 1 }, scope: { sha256: (await import("@saasreport/core/scope")).scopeHash(readJson(root, "persian.config.json")) } } });
  const r = await runIn(root, ["persian", "migrate"], { trust: t });
  assert.equal(r.code, 0, r.err); assert.match(r.out, /1 baseline\(s\) from 2 old entries/); assert.match(r.out, /PENDING.*b\.md/);
  assert.deepEqual(readJson(root, "fa-review.json").entries.map((e) => e.file), ["a.md"]);
});

test("T5 (hist2.mjs): the merge check is POSITIONAL after the first parent's entries: a tuple that exists earlier in the file does not stand in for a dropped withdrawal", async () => {
  const root = join(TMP, "t5"); initRepo(root); commit(root, "root");
  const A = keys("Dr A"), expect = { id: "p:shariah", project: "p", kind: "shariah", subject: "id", anchor: null };
  const W = (l) => writeLedgerFile(root, "L.json", l);
  const l = createLedger(root, expect); approve(l, A, "x", H("1")); W(l); commit(root, "A approves x");
  git(root, "checkout", "-q", "-b", "branch");
  const lb = C(l); append(lb, A, { id: "x", sha256: H("1"), status: "withdrawn", statement: "Withdrawn on the branch: wrong." }); W(lb); commit(root, "branch withdraws x");
  git(root, "checkout", "-q", "main");
  const lm = C(l); append(lm, A, { id: "x", sha256: H("1"), status: "withdrawn", statement: "Withdrawn on main too: wrong." }); approve(lm, A, "x", H("1")); W(lm); commit(root, "main withdraws and re-approves");
  // the merge drops the branch's withdrawal: the SAME tuple (x|H1|withdrawn|Dr A) exists earlier in main's own entries, so "present anywhere" was satisfied
  git(root, "merge", "-q", "--no-commit", "branch"); W(lm); commit(root, "merge, dropping the branch's withdrawal");
  const p = ledgerHistoryProblems(root, "L.json", lm).map((x) => x.problem).join("\n");
  assert.match(p, /is missing from the merged ledger after the first parent's entries/);
  // resolved correctly (re-signed on top, after main's entries) it passes
  git(root, "reset", "-q", "--hard", "HEAD~1"); git(root, "merge", "-q", "--no-commit", "branch");
  const fixed = C(lm); append(fixed, A, { id: "x", sha256: H("1"), status: "withdrawn", statement: "Re-signed on top of main: wrong." }); W(fixed); commit(root, "merge, re-signing on top");
  assert.deepEqual(ledgerHistoryProblems(root, "L.json", fixed).map((x) => x.problem), []);
});

test("T4: after the owner-signed witnessFrom a missing witness fails the deploy gate closed; only the PINNED, signing witness passes; a local file never counts; unreachable and refusing ones fail", async () => {
  const root = repo("t4"); await run(root, "shariah", "init"); commit(root);
  await approveCli(root, ["murabaha"]); commit(root, "approve");
  const WK = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]), WPUB = Buffer.from(await crypto.subtle.exportKey("raw", WK.publicKey)).toString("base64");
  const WIT = { url: "https://witness.example/w", publicKey: WPUB };
  const T = (witnessFrom, pinned = true) => trustWith(PROJECT, { concepts: "shariah", shariah: { ledger: "shariah-review.json", anchor: null, roster: [{ name: "Dr Reviewer", publicKey: SCHOLAR.pub }], ...(witnessFrom != null ? { witnessFrom } : {}) } }, pinned ? { extra: { witness: WIT } } : {});
  let r;
  assert.equal((await runIn(root, ["check", "shariah-review"], { trust: T(null, false) })).code, 0, "bootstrap: not required yet");
  // F3: once witnessFrom is set, a local --witness file NEVER counts (and the ledger's own head is irrelevant): the durable endpoint is required
  r = await runIn(root, ["check", "shariah-review", "--witness", join(TMP, "witness-store", "w.jsonl")], { trust: T(5) });
  assert.equal(r.code, 1); assert.match(r.err, /a local --witness file never counts/);
  r = await runIn(root, ["check", "shariah-review"], { trust: T(1, false) });
  assert.equal(r.code, 1); assert.match(r.err, /requires a witness \(witnessFrom 1\) but pins none/);
  // the pinned witness is used by its pinned URL; an unreachable or refusing one fails closed
  r = await runIn(root, ["check", "shariah-review"], { trust: T(1), fetch: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(r.code, 1); assert.match(r.err, /unreachable.*refused/);
  // the real, SIGNING witness passes; an unsigned {ok:true} does not
  const { witnessEndpoint } = await import("@saasreport/core/witness"), { d1 } = await import("../../core/test/fixtures/d1.mjs"), { bundled } = await import("../src/bundled.js");
  const trust = T(1), k = bundled({ trust, io: { [TEST]: { owner: OWNER_NAME, ownerKeys: [OWNER.rawB64], repo: REPO, pin: { minSeq: 1 } } } }), ap = await k.approvals(PROJECT);
  const h = witnessEndpoint(d1(), { authorize: () => true, signKey: WK.privateKey, resolve: () => ({ expect: ap.shariah, bootstrap: ap.shariah.bootstrap }), resolveTrust: () => ({ owner: OWNER_NAME, ownerKeys: [OWNER.rawB64], repo: REPO }) });
  r = await runIn(root, ["check", "shariah-review"], { trust, fetch: async (u, i) => h(new Request(u, i)) });
  assert.equal(r.code, 0, r.err);
  r = await runIn(root, ["check", "shariah-review"], { trust, fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, problems: [] }) }) });
  assert.equal(r.code, 1); assert.match(r.err, /no signed answer/);
});

test("T6 (kg2.mjs): no injectable prompt in the library API, keys only under the key directory, never in a separate-gitdir work tree, strong passphrase at load, signer integrity", async () => {
  const root = repo("t6");
  await run(root, "shariah", "init"); commit(root);
  // the library API cannot sign: an `io.prompt` is not read (only the kit's own tests have the module-private seam); there is no TTY here
  let err = [];
  let code = await main(["shariah", "approve", "--by", "Dr Reviewer", "--key", SCHOLAR.file, "--statement", "Read the entry and the AAOIFI text.", "murabaha", "--cwd", root], { out() {}, err: (s) => err.push(s), cwd: root, prompt: async () => PASS, [TEST]: seamFor({ trust: TRUST, prompt: undefined }) });
  assert.equal(code, 1); assert.match(err.join(), /only read from an interactive terminal/);
  const io = { cwd: root, [TEST]: seamFor({ prompt: undefined }), prompt: async () => PASS };
  await assert.rejects(loadApproverKey(io, { key: SCHOLAR.file }), /interactive terminal/);
  // a key outside the key directory is refused, wherever it is (also when it is not in any git work tree)
  const stray = join(TMP, "stray.pem"); writeFileSync(stray, readFileSync(SCHOLAR.file));
  await assert.rejects(loadApproverKey({ cwd: join(TMP, "keys", "..", "_cwd"), [TEST]: seamFor() }, { key: stray }), /outside the key directory/);
  // a work tree with a SEPARATE git dir has no .git entry: found by its place (the directory being worked on), and a key outside the key directory is refused anyway
  const wt = join(TMP, "wt"), sep = join(TMP, "sep.git"); mkdirSync(wt, { recursive: true });
  spawnSync("git", [`--git-dir=${sep}`, `--work-tree=${wt}`, "init", "-q"]);
  assert.equal(existsSync(join(wt, ".git")), false);
  assert.match(keyPathProblem({ cwd: wt, [TEST]: seamFor() }, join(wt, "k.pem")), /inside the work tree being worked on/);
  assert.match(keyPathProblem({ cwd: join(TMP, "keys", "..", "_cwd"), [TEST]: seamFor() }, join(wt, "k.pem")), /outside the key directory/);
  // a weak passphrase is refused at load, whatever the key was made with
  const weak = join(TMP, "keys", "weak.pem"); writeFileSync(weak, generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "short" }), { mode: 0o600 });
  await assert.rejects(loadApproverKey({ cwd: join(TMP, "keys", "..", "_cwd"), [TEST]: seamFor({ prompt: async () => "short" }) }, { key: weak }), /at least 12 characters/);
  // signer integrity: a record that pins another signer hash makes the CLI refuse before the key is decrypted
  const pinned = (sha256) => { const rec = signedRecord(PROJECT, TRUST.records[0].approvals, {}); delete rec.signature; return { records: [(() => { const r = { ...rec, signer: { sha256 } }; return signedWith(r); })()] }; };
  const signedWith = (r) => { const { sshSign } = signerLib; r.signature = sshSign(OWNER, trustBodyOf(r), trustNamespace(r.project)); return r; };
  let p = await runIn(root, ["shariah", "approve", "--by", "Dr Reviewer", "--key", SCHOLAR.file, "--statement", "Read the entry and the AAOIFI text.", "murabaha"], { trust: pinned(H("0")) });
  assert.equal(p.code, 1); assert.match(p.err, /signer code differs from the one the owner signed/);
  p = await runIn(root, ["shariah", "approve", "--by", "Dr Reviewer", "--key", SCHOLAR.file, "--statement", "Read the entry and the AAOIFI text.", "murabaha"], { trust: pinned(signerHash()) });
  assert.equal(p.code, 0, p.err);
  assert.match((await runIn(root, ["trust", "signer-hash"], { trust: TRUST })).out, /^[0-9a-f]{64}$/);
});
import * as signerLibMod from "../../core/test/fixtures/ssh.mjs";
import { trustBody as trustBodyOf, trustNamespace } from "@saasreport/core/trust";
const signerLib = signerLibMod;
void coreLedger; void rosterOf; void PASS; void REPO;
