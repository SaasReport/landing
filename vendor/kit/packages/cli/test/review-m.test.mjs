// Review of c80bdbe, medium items: M2 pinned owner key fingerprints and a recent-key refusal, M3 the new head is posted to the witness before anything is written and the missing
// veto/rotation commands exist, witness bootstrap from the signed checkpoint.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { trustContext } from "../src/bundled.js";
import { appendChecked } from "../src/ledger-io.js";
import { witnessEndpoint } from "@saasreport/core/witness";
import { sshFingerprint } from "@saasreport/core/trust";
import { keys, approve, ledger as coreLedger, expectOf, rosterOf, NOW } from "../../core/test/fixtures/ledger.mjs";
import { d1 } from "../../core/test/fixtures/d1.mjs";
import { newOwnerKey } from "../../core/test/fixtures/ssh.mjs";
import { fileTempDir } from "../../core/test/support/temp.mjs";
import { readJson, writeJson, initRepo, commit, trustWith, run as runIn, keygen, setKeyDir, OWNER, persianPins } from "./approvals-helpers.mjs";
import { config, catalogue } from "../../core/test/fixtures/concepts.mjs";

const TMP = fileTempDir("kit-m-");
let ME, SECOND;
before(async () => { setKeyDir(join(TMP, "keys")); ME = await keygen(TMP, "me"); SECOND = await keygen(TMP, "second"); });
const H = (c) => c.repeat(64);

test("M2: GitHub is discovery only: KIT_OWNER_KEYS pins the owner's key fingerprints, and a key added in the last 7 days is refused when nothing is pinned", async () => {
  const agent = newOwnerKey(), fresh = "2999-01-01T00:00:00Z"   /* a creation date after any clock: always younger than the minimum age */, old = "2020-01-01T00:00:00Z";
  const github = async () => ({ ok: true, json: async () => [{ key: OWNER.line, created_at: old }, { key: agent.line, created_at: fresh }] });
  const keysOf = async (env) => (await trustContext({ env: { KIT_OWNER: "owner-test", ...env }, fetch: github, cwd: TMP }).keys());
  const unpinned = await keysOf({});
  assert.deepEqual(unpinned.keys, [OWNER.rawB64], "the key added an hour ago is refused");
  const pinned = await keysOf({ KIT_OWNER_KEYS: sshFingerprint(OWNER.line) });
  assert.deepEqual(pinned.keys, [OWNER.rawB64]);
  const wrong = await keysOf({ KIT_OWNER_KEYS: sshFingerprint(agent.line) });
  assert.deepEqual(wrong.keys, [agent.rawB64], "the PINS decide, whatever GitHub lists or how new a key is: the owner's own pin is what the broker holds");
  const undated = async () => ({ ok: true, json: async () => [{ key: OWNER.line, created_at: old }, { key: agent.line }] });
  const noDate = await trustContext({ env: { KIT_OWNER: "owner-test" }, fetch: undated, cwd: TMP }).keys();
  assert.deepEqual(noDate.keys, [OWNER.rawB64], "a key GitHub lists without created_at has no provable age, so it is refused when nothing is pinned");
  const none = await trustContext({ env: { KIT_OWNER: "owner-test", KIT_OWNER_KEYS: sshFingerprint(newOwnerKey().line) }, fetch: github, cwd: TMP }).keys();
  assert.deepEqual(none.keys, []); assert.match(none.error, /matches a pinned fingerprint/);
});

test("M3 / M6: appendChecked posts the new head to the PINNED witness BEFORE anything is written: an unreachable, unsigned or refusing witness means no entry, and a record that requires one but pins none writes nothing", async () => {
  const A = keys("Dr A"), l = coreLedger("shariah"); approve(l, A, "x", H("1"));
  const WK = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]), WPUB = Buffer.from(await crypto.subtle.exportKey("raw", WK.publicKey)).toString("base64");
  const pinned = { url: "https://w/", publicKey: WPUB };
  const exp = { ...expectOf(l), witness: pinned }, bootstrap = rosterOf(A), db = d1();
  const handler = witnessEndpoint(db, { authorize: () => true, signKey: WK.privateKey, resolve: () => ({ expect: exp, bootstrap, now: NOW }) });
  const fetchTo = async (url, init) => handler(new Request(url, init));
  const fields = { id: "y", sha256: H("2"), status: "approved", by: "Dr A", attests: ["definition-accurate", "sources-read", "positions-fair", "not-a-fatwa"], statement: "I read the entry and its sources." };
  const before = l.entries.length, at = (m) => new Date(Date.UTC(2026, 9, 7, 12, m, 0));
  await appendChecked(l, bootstrap, A.privateKey, fields, { expect: exp, bootstrap, witness: { url: pinned.url, fetch: fetchTo } }, at(0));
  assert.equal(l.entries.length, before + 1);
  const down = { url: pinned.url, fetch: async () => { throw new Error("ECONNREFUSED"); } };
  await assert.rejects(appendChecked(l, bootstrap, A.privateKey, { ...fields, id: "z" }, { expect: exp, bootstrap, witness: down }, at(1)), /witness did not accept the new head, so nothing is written/);
  assert.equal(l.entries.length, before + 1, "the entry was taken back");
  const stub = { url: pinned.url, fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, problems: [] }) }) };
  await assert.rejects(appendChecked(l, bootstrap, A.privateKey, { ...fields, id: "s" }, { expect: exp, bootstrap, witness: stub }, at(2)), /no signed answer/);
  await assert.rejects(appendChecked(l, bootstrap, A.privateKey, { ...fields, id: "u" }, { expect: exp, bootstrap, witness: { url: "https://other/", fetch: fetchTo } }, at(3)), /not the one the owner pinned/);
  await assert.rejects(appendChecked(l, bootstrap, A.privateKey, { ...fields, id: "q" }, { expect: { ...expectOf(l), witnessFrom: 0 }, bootstrap }, at(4)), /requires a witness \(witnessFrom\) but pins none/);
  assert.equal(l.entries.length, before + 1);
});

test("M3: kit persian reject/withdraw and kit ledger roster rotate exist, are verified at append time and keep history verifiable", async () => {
  const root = join(TMP, "m3"); initRepo(root);
  const CANON = "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/canon.schema.json", CFG = "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/persian-config.schema.json";
  writeJson(root, "kit.canon.json", { $schema: CANON, project: "saasreport", persian: "persian.config.json" });
  writeJson(root, "persian.config.json", { $schema: CFG, sources: [{ name: "ui", files: ["src/*.js"] }], review: {} });
  writeJson(root, "src/ui.js", 'export const T = { a: "پرداخت انجام شد." };\n'); writeJson(root, ".github/CODEOWNERS", "/fa-review.json @o\n"); commit(root);
  const { reviewState, baselineCandidates } = await import("../src/canon/persian.js"), { baselineHash } = await import("@saasreport/core/ledger");
  const head = (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const set = baselineCandidates(reviewState(root, readJson(root, "persian.config.json"), null)).map((s) => ({ file: s.file, sha256: s.sha256 }));
  const T = trustWith("saasreport", { persian: { ledger: "fa-review.json", anchor: head, roster: [{ name: "Rev One", publicKey: ME.pub }, { name: "Rev Two", publicKey: SECOND.pub }], baseline: { sha256: baselineHash(set), entries: set.length }, scope: (await persianPins(root)).scope } });
  const r = (...a) => runIn(root, a, { trust: T });
  assert.equal((await r("persian", "baseline")).code, 0);
  commit(root);
  assert.equal((await r("persian", "approve", "--by", "Rev One", "--key", ME.file, "src/ui.js")).code, 0);
  const noWhy = await r("persian", "withdraw", "--by", "Rev Two", "--key", SECOND.file, "src/ui.js");
  assert.equal(noWhy.code, 1); assert.match(noWhy.err, /--statement/);
  const w = await r("persian", "withdraw", "--by", "Rev Two", "--key", SECOND.file, "--statement", "The wording is wrong here.", "src/ui.js");
  assert.equal(w.code, 0, w.err);
  assert.equal(readJson(root, "fa-review.json").entries.at(-1).status, "withdrawn");
  assert.equal((await r("persian", "reject", "--by", "Rev One", "--key", ME.file, "--statement", "Rejected, with a reason.", "src/ui.js")).code, 0);
  // rotation: Rev One replaces their own key with a new one; the old key's earlier entries stay verifiable, the old key can no longer sign
  const third = await keygen(TMP, "third");
  const rot = await r("ledger", "roster", "rotate", "persian", "--by", "Rev One", "--key", ME.file, "--name", "Rev One", "--public-key", third.pub);
  assert.equal(rot.code, 0, rot.err); assert.match(rot.out, /new fingerprint SHA256:/);
  const T2 = trustWith("saasreport", T.records[0].approvals);
  const old = await runIn(root, ["persian", "approve", "--by", "Rev One", "--key", ME.file, "src/ui.js"], { trust: T2 });
  assert.equal(old.code, 1); assert.match(old.err, /not Rev One's registered key|refused at append|signature/);
  const viaNew = await runIn(root, ["persian", "approve", "--by", "Rev One", "--key", third.file, "src/ui.js"], { trust: T2 });
  assert.equal(viaNew.code, 0, viaNew.err);
  assert.equal((await runIn(root, ["ledger", "verify", "persian"], { trust: T2 })).code, 0);
  const notSelf = await r("ledger", "roster", "rotate", "persian", "--by", "Rev One", "--key", third.file, "--name", "Rev Two", "--public-key", ME.pub);
  assert.equal(notSelf.code, 1); assert.match(notSelf.err, /member's own act/);
});

test("H3 / M3: kit ledger witness-bootstrap prints the rows a fresh database starts with (the signed checkpoint), and that database then refuses a rolled-back ledger and the replaced record", async () => {
  const root = join(TMP, "boot"); initRepo(root);
  const A = keys("Rev One"), full = coreLedger("persian", 0, "saasreport"); for (let i = 0; i < 3; i++) approve(full, A, `f${i}`, H(String(i + 1)));
  const { ledgerHead } = await import("@saasreport/core/ledger"), { recordWitness: recW, recordTrustWitness: recT } = await import("@saasreport/core/witness"), { recordHash } = await import("@saasreport/core/trust"), { makeRecord, chain } = await import("../../core/test/fixtures/trustrec.mjs");
  const roster = [{ name: A.name, publicKey: A.publicKey }], mk = (seq, extra = {}, supersedes) => makeRecord({ project: "saasreport", seq, github: "SaasReport/test-repo", owner: "owner-test", key: OWNER, approvals: { persian: { ledger: "fa-review.json", anchor: "a".repeat(40), roster } }, extra, ...(supersedes !== undefined ? { supersedes } : {}) });
  const r1 = mk(1, {}, null), r2 = mk(2, { checkpoint: { recordSeq: 2, ledgers: { persian: ledgerHead(full) } } }, recordHash(r1));
  writeJson(root, "rec.json", r2);
  const out = await runIn(root, ["ledger", "witness-bootstrap", "rec.json"]);
  assert.equal(out.code, 0, out.err);
  assert.match(out.out, /'saasreport:trust', 2,/); assert.match(out.out, /'saasreport:persian@[0-9a-f]{64}', 3, /);
  const db = d1(); db.raw.exec(out.out);
  // the bootstrapped database refuses what the owner's checkpoint rules out
  const cut = coreLedger("persian", 0, "saasreport"); approve(cut, A, "f0", H("1"));
  const lr = await recW(db, cut, { expect: expectOf(cut), bootstrap: rosterOf(A), now: NOW });
  assert.equal(lr.ok, false); assert.equal(lr.reason, "behind", "a ledger rolled back below the witnessed checkpoint head");
  const tr = await recT(db, r1, { owner: "owner-test", ownerKeys: [OWNER.rawB64], repo: "SaasReport/test-repo", project: "saasreport" });
  assert.equal(tr.ok, false); assert.equal(tr.reason, "behind", "the replaced record (seq 1) after the bootstrap at seq 2");
  void chain;
});
