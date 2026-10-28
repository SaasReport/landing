// Re-review of 41eb85b, CLI side: N1 downgrade, N2 Persian scope, N4 witness stub, M3 checkpoint from the tooling, N5 bootstrap, M5 vendor upstream, and the low items.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileTempDir } from "../../core/test/support/temp.mjs";
import { writeJson, readJson, commit, initRepo, git, trustWith, run, keygen, setKeyDir, seamFor, OWNER, OWNER_NAME, REPO } from "./approvals-helpers.mjs";
import { makeRecord, chain } from "../../core/test/fixtures/trustrec.mjs";
import { d1 } from "../../core/test/fixtures/d1.mjs";
import { recordHash } from "@saasreport/core/trust";
import { baselineHash } from "@saasreport/core/ledger";
import { scopeHash } from "@saasreport/core/scope";
import { witnessEndpoint } from "@saasreport/core/witness";
import { reviewState, baselineCandidates } from "../src/canon/persian.js";
import { compareUpstream } from "../src/vendor.js";
import { createHash } from "node:crypto";

const T = fileTempDir("r2-");
let KEY, BAD;
before(async () => { setKeyDir(join(T, "keys")); KEY = await keygen(T, "owner"); BAD = await keygen(T, "compromised"); });
const CANON = "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/canon.schema.json", CFG = "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/persian-config.schema.json", P = "saasreport";
const VK = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
const VPUB = Buffer.from(await crypto.subtle.exportKey("raw", VK.publicKey)).toString("base64");
const VERIFIER = { url: "https://broker.example/verify", publicKey: VPUB, required: true };
function repo(name) {
  const root = join(T, name); initRepo(root);
  writeJson(root, "kit.canon.json", { $schema: CANON, project: P, persian: "persian.config.json" });
  writeJson(root, "persian.config.json", { $schema: CFG, sources: [{ name: "ui", files: ["src/*.js"] }], review: {} });
  writeJson(root, "src/ui.js", 'export const T = { a: "پرداخت انجام شد." };\n'); writeJson(root, ".github/CODEOWNERS", "/fa-review.json @o\n");
  const head = commit(root);
  const set = baselineCandidates(reviewState(root, readJson(root, "persian.config.json"), null)).map((s) => ({ file: s.file, sha256: s.sha256 }));
  return { root, head, pin: { sha256: baselineHash(set), entries: set.length }, scope: { sha256: scopeHash(readJson(root, "persian.config.json")) } };
}
const rec = (seq, persian, extra = {}, supersedes) => makeRecord({ project: P, approvals: { persian }, seq, github: REPO, owner: OWNER_NAME, key: OWNER, extra, ...(supersedes !== undefined ? { supersedes } : {}) });

test("N1: deleting or corrupting the owner's newest record cannot downgrade the gate: a present-but-invalid higher record fails closed, and the minimum seq and verifier are pinned outside the repo", async () => {
  const { root, head, pin, scope } = repo("n1");
  const base = { ledger: "fa-review.json", anchor: head, baseline: pin, scope };
  const r1 = rec(1, { ...base, roster: [{ name: "Owner", publicKey: KEY.pub }, { name: "Compromised", publicKey: BAD.pub }] });
  const r2 = rec(2, { ...base, witnessFrom: 0, roster: [{ name: "Owner", publicKey: KEY.pub }] }, { verifier: VERIFIER }, recordHash(r1));
  assert.equal((await run(root, ["persian", "baseline"], { trust: { records: [r1] } })).code, 0); commit(root);
  writeJson(root, "src/agent.js", 'export const X = { a: "متنی که مالک هرگز نخوانده است." };\n'); commit(root);
  // the compromised approver (on r1's roster, removed by r2) approves the agent's copy under r1: exactly what the downgrade would let through
  const a = await run(root, ["persian", "approve", "--by", "Compromised", "--key", BAD.file, "src/agent.js"], { trust: { records: [r1] } });
  assert.equal(a.code, 0, a.err); commit(root);
  const calls = []; const fetch = async (u) => { calls.push(u); throw new Error("ECONNREFUSED"); };
  const tampered = { ...r2, expires: "2098-01-01T00:00:00.000Z" };
  const pin2 = { minSeq: 2, verifier: VERIFIER };
  const cases = [
    ["r1 only (r2 deleted), pinned minSeq 2", { records: [r1] }, { pin: pin2 }, /below the minimum seq 2 pinned outside the repository/],
    ["r1 + corrupted r2", { records: [r1, tampered] }, { pin: { minSeq: 1 } }, /higher-seq record is present but invalid, so the gate fails closed/],
    ["r1 only, no pin at all", { records: [r1] }, { pin: undefined }, /no trust pin for this project outside the repository/],
  ];
  for (const [name, trust, seam, why] of cases) {
    const r = await run(root, ["check", "fa-review"], { trust, fetch, seam });
    assert.equal(r.code, 1, name); assert.match(r.err, why, `${name}: refused for the stated reason, not because src/agent.js is unapproved`);
    assert.equal(calls.length, 0);
  }
  const honest = await run(root, ["check", "fa-review"], { trust: { records: [r1, r2] }, fetch, seam: { pin: pin2 } });
  assert.equal(honest.code, 1); assert.match(honest.err, /"Compromised", who is not in the reviewer roster at this point of the chain/, "CONTROL: with the owner's seq 2 the compromised approval is refused");
  // the pin can also come from the environment, next to KIT_OWNER
  const viaEnv = await run(root, ["check", "fa-review"], { trust: { records: [r1] }, fetch, env: { ...process.env, KIT_TRUST_PIN: JSON.stringify({ [P]: pin2 }) } });
  assert.equal(viaEnv.code, 1); assert.match(viaEnv.err, /below the minimum seq 2 pinned outside the repository/);
});

test("N2: the Persian scope (sources, exclude, mixed) is pinned by the owner: an agent-only edit of persian.config.json that excludes a new key is refused by the gate", async () => {
  const { root, head, pin, scope } = repo("n2");
  const trust = { records: [rec(1, { ledger: "fa-review.json", anchor: head, baseline: pin, scope, roster: [{ name: "Owner", publicKey: KEY.pub }] })] };
  assert.equal((await run(root, ["persian", "baseline"], { trust })).code, 0); commit(root);
  assert.equal((await run(root, ["check", "fa-review"], { trust })).code, 0, "the signed scope passes");
  writeJson(root, "src/ui.js", 'export const T = { a: "پرداخت انجام شد.", promo: "این متن را هیچ‌کس نخوانده و تأیید نکرده است." };\n');
  const cfg = readJson(root, "persian.config.json"); cfg.exclude = [{ files: "src/ui.js", keys: ["promo"], reason: "verbatim quotation, hash verified" }]; writeJson(root, "persian.config.json", cfg);
  commit(root, "agent");
  const r = await run(root, ["check", "fa-review"], { trust });
  assert.equal(r.code, 1); assert.match(r.err, /persian\.config\.json's review scope .*differs from the one the owner signed/);
  // a record with no scope pin cannot be used for Persian at all
  const noScope = { records: [rec(1, { ledger: "fa-review.json", anchor: head, baseline: pin, roster: [{ name: "Owner", publicKey: KEY.pub }] })] };
  assert.match((await run(root, ["check", "fa-review"], { trust: noScope })).err, /pins no Persian scope/);
});

test("N4 / M6: a stub witness answering {ok:true} is not a witness: the record pins the witness URL and key, the answer must be signed and bound, and an unpinned witness is refused", async () => {
  const { root, head, pin, scope } = repo("n4");
  const WK = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]), WPUB = Buffer.from(await crypto.subtle.exportKey("raw", WK.publicKey)).toString("base64");
  const WITNESS = { url: "https://witness.example/w", publicKey: WPUB };
  const base = { ledger: "fa-review.json", anchor: head, baseline: pin, scope, witnessFrom: 0, roster: [{ name: "Owner", publicKey: KEY.pub }] };
  const trust = { records: [rec(1, base, { witness: WITNESS })] }, unpinned = { records: [rec(1, base)] };
  assert.equal((await run(root, ["persian", "baseline"], { trust })).code, 0); commit(root);
  const stub = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, problems: [] }) });
  assert.equal((await run(root, ["check", "fa-review"], { trust })).code, 1, "no witness at all");
  const s = await run(root, ["check", "fa-review", "--witness-url", WITNESS.url], { trust, fetch: stub });
  assert.equal(s.code, 1); assert.match(s.err, /no signed answer|not signed/);
  const other = await run(root, ["check", "fa-review", "--witness-url", "https://attacker.example/w"], { trust, fetch: stub });
  assert.equal(other.code, 1); assert.match(other.err, /not the one the owner pinned/);
  const up = await run(root, ["check", "fa-review", "--witness-url", WITNESS.url], { trust: unpinned, fetch: stub });
  assert.equal(up.code, 1); assert.match(up.err, /but pins none \(witness\.url, witness\.publicKey\)/);
  // the real, signing witness passes
  const db = d1(), { bundled } = await import("../src/bundled.js"), { TEST } = await import("../src/test-seam.js");
  const k = bundled({ trust, io: { [TEST]: { owner: OWNER_NAME, ownerKeys: [OWNER.rawB64], repo: REPO, pin: { minSeq: 1 } } } }), ap = await k.approvals(P);
  const h = witnessEndpoint(db, { authorize: () => true, signKey: WK.privateKey, resolve: () => ({ expect: ap.persian, bootstrap: ap.persian.bootstrap }), resolveTrust: () => ({ owner: OWNER_NAME, ownerKeys: [OWNER.rawB64], repo: REPO }) });
  const good = await run(root, ["check", "fa-review", "--witness-url", WITNESS.url], { trust, fetch: async (u, i) => h(new Request(u, i)) });
  assert.equal(good.code, 0, good.err);
});

test("M3 / P4b (CLI): kit trust propose writes checkpoint { recordSeq: seq, ledgers: current heads }, and a witness bootstrapped from it refuses the replaced record", async () => {
  const { root, head, pin, scope } = repo("m3");
  const trust = { records: [rec(1, { ledger: "fa-review.json", anchor: head, baseline: pin, scope, roster: [{ name: "Owner", publicKey: KEY.pub }] })] };
  assert.equal((await run(root, ["persian", "baseline"], { trust })).code, 0); commit(root);
  const VKEY = Buffer.from((await import("node:crypto")).generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
  const WKEY = Buffer.from((await import("node:crypto")).generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
  const r = await run(root, ["trust", "propose", "--project", P, "--github", REPO, "--name", "Test Approver", "--public-key", KEY.pub, "--kinds", "persian", "--verifier-url", "https://b.example/v", "--verifier-key", VKEY, "--witness-url", "https://w.example/w", "--witness-key", WKEY, "--seq", "2", "--supersedes", recordHash(trust.records[0]), "--out", "d.json"], { trust });
  assert.equal(r.code, 0, r.err);
  const d = readJson(root, "d.json");
  assert.equal(d.checkpoint.recordSeq, 2, "the checkpoint is the record's OWN seq");
  assert.equal(d.checkpoint.ledgers.persian.seq, readJson(root, "fa-review.json").entries.length);
  assert.deepEqual(d.witness, { url: "https://w.example/w", publicKey: WKEY });
  assert.equal(d.approvals.persian.scope.sha256, scope.sha256);
  assert.equal((await run(root, ["trust", "propose", "--project", P, "--github", REPO, "--name", "x y", "--public-key", KEY.pub, "--lenient", "--out", "z.json"], { trust })).code, 1, "--lenient is removed");
});

test("N5: kit ledger witness-bootstrap prints SQL only for a record that VERIFIES (owner key, pinned owner, repository)", async () => {
  const root = join(T, "n5"); initRepo(root);
  writeJson(root, "forged.json", { project: P, seq: 9, at: "2026-10-07T00:00:00Z", approvals: { persian: { anchor: "a".repeat(40) } }, checkpoint: { recordSeq: 9, ledgers: { persian: { seq: 0, hash: "0".repeat(64) } } } });
  const forged = await run(root, ["ledger", "witness-bootstrap", "forged.json"]);
  assert.equal(forged.code, 1); assert.match(forged.err, /does not verify|schema/);
  const good = rec(2, { ledger: "fa-review.json", anchor: "a".repeat(40), baseline: { sha256: "b".repeat(64), entries: 0 }, scope: { sha256: "c".repeat(64) }, roster: [{ name: "Owner", publicKey: KEY.pub }] }, { checkpoint: { recordSeq: 2, ledgers: { persian: { seq: 3, hash: "d".repeat(64) } } } }, "e".repeat(64));
  writeJson(root, "good.json", good);
  const ok = await run(root, ["ledger", "witness-bootstrap", "good.json"]);
  assert.equal(ok.code, 0, ok.err); assert.match(ok.out, /INSERT INTO approval_witness/);
});

test("M5: vendor check --upstream pins the upstream repository and a minimum commit outside the manifest, and requires the SAME set of trust files", async () => {
  const good = "export const ok = 1;\n", sha = (t) => createHash("sha256").update(t).digest("hex");
  const files = { "packages/core/src/ledger.js": good, "packages/core/src/trust.js": good };
  const manifest = (over = {}) => ({ source: { repository: "https://github.com/SaasReport/kit", commit: "a".repeat(40) }, files: Object.entries(files).map(([path, t]) => ({ path, sha256: sha(t) })), ...over });
  const pins = { repository: "SaasReport/kit", minCommit: "b".repeat(40) };
  const gh = (o = {}) => async (url) => {
    if (/\/compare\/a{40}\.\.\./.test(url)) return { ok: true, json: async () => ({ status: o.branch ?? "ahead" }) };   // commit...branch: is the commit on the pinned branch
    if (/\/compare\//.test(url)) return { ok: true, json: async () => ({ status: o.status ?? "ahead" }) };
    if (/\/git\/trees\//.test(url)) return { ok: true, json: async () => ({ truncated: false, tree: (o.tree ?? Object.keys(files)).map((path) => ({ path, type: "blob" })) }) };
    return { ok: true, arrayBuffer: async () => Buffer.from(o.body ?? good) };
  };
  assert.deepEqual(await compareUpstream(manifest(), "m.json", gh(), pins), []);
  assert.match((await compareUpstream(manifest({ source: { repository: "https://github.com/Evil/kit", commit: "a".repeat(40) } }), "m.json", gh(), pins))[0].problem, /not the pinned upstream/);
  assert.match((await compareUpstream(manifest(), "m.json", gh({ status: "diverged" }), pins))[0].problem, /does not descend from the pinned minimum/);
  // R3-3: the manifest's commit must be ON the pinned branch: a fork's commit descends from the minimum too, but the branch is not ahead of it
  const fork = await compareUpstream(manifest(), "m.json", gh({ branch: "diverged" }), pins);
  assert.match(fork[0].problem, /not on the pinned branch main of SaasReport\/kit/);
  assert.match((await compareUpstream(manifest(), "m.json", gh({ branch: "behind" }), pins))[0].problem, /not on the pinned branch/);
  assert.match((await compareUpstream(manifest(), "m.json", async (u) => (/\.\.\.main/.test(u) ? { ok: false, status: 404 } : gh()(u)), pins))[0].problem, /cannot be compared with the pinned branch main \(404\)/);
  const urls = []; await compareUpstream(manifest(), "m.json", async (u) => { urls.push(u); return gh()(u); }, { ...pins, branch: "release" });
  assert.ok(urls.some((u) => u.endsWith(`/compare/${"a".repeat(40)}...release`)), "the branch pin comes from KIT_UPSTREAM_BRANCH");
  const miss = await compareUpstream(manifest(), "m.json", gh({ tree: [...Object.keys(files), "packages/core/src/ed25519.js"] }), pins);
  assert.match(miss.map((p) => p.problem).join(), /is a trust file upstream but is not in the manifest/);
  assert.match((await compareUpstream(manifest(), "m.json", gh(), {}))[0].problem, /no pinned upstream/);
  assert.equal((await compareUpstream(manifest(), "m.json", gh({ body: "tampered" }), pins)).length, 2, "both trust files differ");
});

test("low: kit trust verify lists uploads; gitSource and bundled read the same record set (the highest-seq record of the project)", async () => {
  const root = join(T, "low"); initRepo(root);
  const t = trustWith(P, { persian: { ledger: "fa-review.json", anchor: null, roster: [{ name: "Owner", publicKey: KEY.pub }] }, uploads: { ledger: "uploads-review.json", anchor: null, roster: [{ name: "Owner", publicKey: KEY.pub }] } });
  const v = await run(root, ["trust", "verify", P], { trust: t });
  assert.equal(v.code, 0, v.err); assert.match(v.out, /ledgers: persian, uploads/);
  const { gitSource } = await import("../src/content-state.js");
  const [r1, r2] = chain([{ project: P, approvals: { concepts: null }, seq: 1, key: OWNER, github: REPO, owner: OWNER_NAME }, { project: P, approvals: { concepts: null }, seq: 2, key: OWNER, github: REPO, owner: OWNER_NAME }]);
  writeJson(root, `packages/core/registry/trust/${P}.json`, r1); writeJson(root, `packages/core/registry/trust/${P}.v2.json`, r2); const sha = commit(root);
  const src = gitSource(root, sha, null);
  assert.equal((await src.record(P)).seq, 2, "the same rule as bundled(): the highest seq among the project's records");
  void git; void seamFor;
});
