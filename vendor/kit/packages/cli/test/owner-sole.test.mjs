// Owner decision (2026-10-07): the owner is the sole approver for Persian (fa-review) and Shariah sign-off in every project. The kit carries NO personal identity: the owner handle
// is in packages/core/registry/projects.json (owner.github, schema-validated); the name lives only in the owner-signed roster. `kit trust propose` prepares the UNSIGNED draft (strict
// policy by default) and prints the approval key's fingerprint for the owner to compare with the signing page; nothing is signed or approved by it. The enforcement is the verification side.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileTempDir } from "../../core/test/support/temp.mjs";
import { readJson, writeJson, initRepo, commit, git, trustWith, run as runIn, keygen, setKeyDir, OWNER } from "./approvals-helpers.mjs";
import { verifyTrustRecord, trustBody, trustNamespace, keyFingerprint } from "@saasreport/core/trust";
import { sshSign } from "../../core/test/fixtures/ssh.mjs";
import { bundled } from "../src/bundled.js";
import { config, catalogue } from "../../core/test/fixtures/concepts.mjs";

const TMP = fileTempDir("kit-owner-");
let KEY, OTHER;
before(async () => { setKeyDir(join(TMP, "keys")); KEY = await keygen(TMP, "owner"); OTHER = await keygen(TMP, "other"); });

const CANON = "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/canon.schema.json", CFG = "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/persian-config.schema.json";
function saasreport(name) {
  const root = join(TMP, name); initRepo(root);
  writeJson(root, "kit.canon.json", { $schema: CANON, project: "saasreport", persian: "persian.config.json" });
  writeJson(root, "persian.config.json", { $schema: CFG, sources: [{ name: "ui", files: ["src/*.js"] }], review: {} });
  writeJson(root, "src/ui.js", 'export const T = { a: "پرداخت انجام شد." };\n'); commit(root);
  return root;
}
const VK = (await import("node:crypto")).generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x;
const WKX = (await import("node:crypto")).generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x;
const VERIFIER = ["--verifier-url", "https://broker.example/verify", "--verifier-key", Buffer.from(VK, "base64url").toString("base64"), "--witness-url", "https://witness.example/w", "--witness-key", Buffer.from(WKX, "base64url").toString("base64")];
const args = (extra = []) => ["trust", "propose", "--project", "saasreport", "--github", "SaasReport/core", "--name", "Test Approver", "--public-key", KEY.pub, "--out", "draft.json", ...extra];

test("M4: the kit carries no personal identity: the owner handle comes from projects.json (schema-validated), the name only from the owner-signed roster", async () => {
  const kit = bundled();
  for (const p of kit.registry.projects) assert.match(p.owner.github, /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/, p.key);
  assert.equal(kit.validator.validate(kit.registry, kit.byName("projects").$id).length, 0);
  const bad = JSON.parse(JSON.stringify(kit.registry)); bad.projects[0].owner = { github: "not a handle!" };
  assert.ok(kit.validator.validate(bad, kit.byName("projects").$id).length);
  // nothing personal in the code or the docs
  const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === "node_modules" ? [] : walk(p)) : [p]; });
  const base = new URL("../../../", import.meta.url).pathname;
  const files = [...walk(join(base, "packages/cli/src")), ...walk(join(base, "packages/core/src")), join(base, "docs/CONCEPTS.md"), join(base, "docs/PERSIAN.md"), join(base, "CHANGELOG.md")];
  for (const f of files) { const t = readFileSync(f, "utf8"); assert.doesNotMatch(t, /m\.marandi@|47858146|Masoud Marandi|OWNER_IDENTITY/, f); }
});

test("M5 / M1: propose is STRICT by default (anchor, witnessFrom, verifier required, signer hash, pinned baseline), prints the key fingerprint to compare, and signs nothing", async () => {
  const root = saasreport("strict");
  const r = await runIn(root, args(VERIFIER));
  assert.equal(r.code, 0, r.err);
  const d = readJson(root, "draft.json"), head = git(root, "rev-parse", "HEAD").stdout.trim();
  assert.equal(d.signature, undefined, "UNSIGNED");
  assert.equal(d.owner, "007dude", "from projects.json, not from the code");
  for (const kind of ["persian", "shariah"]) { assert.deepEqual(d.approvals[kind].roster, [{ name: "Test Approver", publicKey: KEY.pub, fingerprint: keyFingerprint(KEY.pub) }]); assert.equal(d.approvals[kind].anchor, head); assert.equal(d.approvals[kind].witnessFrom, 0); }
  assert.equal(d.verifier.required, true); assert.match(d.signer.sha256, /^[0-9a-f]{64}$/); assert.equal(d.witness.url, "https://witness.example/w"); assert.match(d.approvals.persian.scope.sha256, /^[0-9a-f]{64}$/);
  assert.equal(d.approvals.persian.baseline.entries, 1); assert.match(d.approvals.persian.baseline.sha256, /^[0-9a-f]{64}$/);
  assert.equal(d.supersedes, null);
  assert.ok(r.out.includes(`APPROVAL KEY FINGERPRINT: ${keyFingerprint(KEY.pub)}`), "the fingerprint is compared as TEXT: it contains + and /, which a regex built from it would misread");
  assert.match(r.out, /Compare it, character for character, with the fingerprint the SIGNING PAGE shows/);
  assert.match(r.out, /baseline pinned: 1 Persian source file/);
  for (const f of ["/fa-review.json", "/shariah-review.json", "/concepts.config.json", "/persian.config.json"]) assert.match(r.out, new RegExp(`${f.replace(/[./]/g, "\\$&")} @007dude`));
  assert.equal(existsSync(join(root, "fa-review.json")) || existsSync(join(root, "shariah-review.json")), false, "no ledger row or file is written");
  // the strict policy is the only policy: it refuses to be incomplete (no verifier, no witness), and --lenient is gone; --owner overrides the registry's owner
  assert.match((await runIn(root, args())).err, /--verifier-url is required/);
  assert.match((await runIn(root, args(VERIFIER.slice(0, 4)))).err, /--witness-url is required/);
  assert.equal((await runIn(root, args([...VERIFIER, "--lenient"]))).code, 0, "an unknown flag is ignored: there is no lenient policy to select");
  assert.equal(readJson(root, "draft.json").approvals.persian.witnessFrom, 0);
  assert.equal((await runIn(root, [...args(VERIFIER), "--owner", "someone-else"])).code, 0); assert.equal(readJson(root, "draft.json").owner, "someone-else");
  const weak = await runIn(root, [...args(VERIFIER).slice(0, args(VERIFIER).indexOf("--public-key") + 1), Buffer.from("01" + "00".repeat(31), "hex").toString("base64"), ...VERIFIER, "--out", "d3.json"]);
  assert.equal(weak.code, 1); assert.match(weak.err, /--public-key is/);
  assert.match((await runIn(root, args([...VERIFIER, "--seq", "2"]))).err, /--supersedes/);
  // a later record in the chain carries supersedes and the checkpoint floor
  const prev = "a".repeat(64);
  assert.equal((await runIn(root, args([...VERIFIER, "--seq", "2", "--supersedes", prev]))).code, 0);
  const d2 = readJson(root, "draft.json"); assert.equal(d2.supersedes, prev); assert.deepEqual(d2.checkpoint, { recordSeq: 2, ledgers: {} }, "the checkpoint is the record's OWN seq; no ledger exists yet, so no heads");
  // once the OWNER signs it (their SSH key, on their machine) it verifies; before that nothing is trusted
  const ctx = { project: "saasreport", owner: "007dude", ownerKeys: [OWNER.rawB64], repo: "SaasReport/core", now: Date.now() };
  assert.match((await verifyTrustRecord(d2, ctx)).problems.join(), /unsigned|signature/);
  assert.equal((await verifyTrustRecord({ ...d2, signature: sshSign(OWNER, trustBody(d2), trustNamespace("saasreport")) }, ctx)).ok, true);
});

test("sole approver, verification side: a second approver, a name the owner did not sign, another key under the owner's name and a one-member roster addition are all refused", async () => {
  const root = join(TMP, "sole"); initRepo(root);
  const cfg = config({ order: { strategy: "catalogue" }, gate: { accuracy: { minVerifiedPrefix: 2, unverified: "never" } } }), cat = catalogue();
  const texts = Object.fromEntries(cat.concepts.filter((c) => c.accuracy.status === "verified").flatMap((c) => c.sources.map((s) => [`texts/${s.sha256}.txt`, `…${s.quote}…`])));
  for (const [f, b] of Object.entries({ "concepts.config.json": cfg, [cfg.catalogue]: cat, "kit.canon.json": { $schema: CANON, project: "saasreport" }, ".github/CODEOWNERS": "/shariah-review.json @007dude\n/concepts.config.json @007dude\n", ...texts })) writeJson(root, f, b);
  commit(root);
  const T = trustWith("saasreport", { concepts: "shariah", shariah: { ledger: "shariah-review.json", anchor: null, roster: [{ name: "Test Approver", publicKey: KEY.pub }] } });
  await runIn(root, ["shariah", "init"], { trust: T }); commit(root);
  const sign = (by, key) => runIn(root, ["shariah", "approve", "--by", by, "--key", key, "--statement", "Read the entry and the AAOIFI text.", "murabaha"], { trust: T });
  assert.match((await sign("Second Approver", OTHER.file)).err, /is not in the roster/, "a second approver is refused");
  assert.match((await sign("Test Approver", OTHER.file)).err, /not Test Approver's registered key/, "another key under the owner's name is refused");
  assert.equal(readJson(root, "shariah-review.json").entries.length, 0);
  assert.equal((await sign("Test Approver", KEY.file)).code, 0);
  const add = await runIn(root, ["ledger", "roster", "add", "shariah", "--by", "Test Approver", "--key", KEY.file, "--name", "Second Approver", "--public-key", OTHER.pub], { trust: T });
  assert.equal(add.code, 1); assert.match(add.err, /one-member roster changes only through the owner-signed trust record/);
  // a hand-written entry by a second key is refused by the gate
  const l = readJson(root, "shariah-review.json"); l.entries.push({ ...l.entries[0], seq: 2, id: "salam", by: "Second Approver", prev: "0".repeat(64) });
  writeJson(root, "shariah-review.json", l);
  assert.equal((await runIn(root, ["check", "concepts"], { trust: T })).code, 1);
  void writeFileSync;
});

test("CI regression (ubuntu-26.04 failure of 41eb85b): the output check works for ANY key, including one whose fingerprint contains several '+' (a regex built from the fingerprint did not)", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  let pub, fp, n = 0;
  // The old construction escaped only the first '+'. It fails on most such keys, but not on every one (a '+' that
  // follows the escaped one turns into a quantifier that still matches), so the search keeps going until it finds a
  // key the old construction really fails on: a random key alone made this test flaky.
  const oldBreaks = (f) => { try { return !new RegExp(f.replace("+", "\\+")).test(f); } catch { return true; /* a construction that throws has failed, which is exactly the key being searched for */ } };
  do { pub = Buffer.from(generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x, "base64url").toString("base64"); fp = keyFingerprint(pub); n++; } while (!((fp.match(/\+/g) || []).length >= 2 && oldBreaks(fp)) && n < 5000);
  assert.ok((fp.match(/\+/g) || []).length >= 2, "found a fingerprint with two plus signs");
  assert.throws(() => new RegExp(fp.replace("+", "\\+")).test(fp) || (() => { throw new Error("regex built from the fingerprint does not match itself"); })(), /does not match itself|Nothing to repeat|Invalid/, "the old regex construction breaks on such a key");
  const root = saasreport("plus");
  const r = await runIn(root, ["trust", "propose", "--project", "saasreport", "--github", "SaasReport/core", "--name", "Test Approver", "--public-key", pub, "--out", "d.json", ...VERIFIER]);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes(`APPROVAL KEY FINGERPRINT: ${fp}`));
});
