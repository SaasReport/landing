// Third review of #116 at ee7756e: every attack that PASSED is a must-fail test. R3-1 the Persian gate is not switched off from the repository; R3-2 N1 does not fail open on a missing or
// malformed pin or a corrupted record; R3-6 one record reader; R3-7 propose prints what it copied.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileTempDir } from "../../core/test/support/temp.mjs";
import { writeJson, readJson, commit, initRepo, git, run, keygen, setKeyDir, seamFor, OWNER, OWNER_NAME, REPO } from "./approvals-helpers.mjs";
import { makeRecord } from "../../core/test/fixtures/trustrec.mjs";
import { d1 } from "../../core/test/fixtures/d1.mjs";
import { recordHash } from "@saasreport/core/trust";
import { baselineHash } from "@saasreport/core/ledger";
import { scopeHash } from "@saasreport/core/scope";
import { verifierEndpoint } from "@saasreport/core/verifier";
import { reviewState, baselineCandidates } from "../src/canon/persian.js";
import { gitSource } from "../src/content-state.js";
import { kitFor, bundled } from "../src/bundled.js";
import { TEST } from "../src/test-seam.js";
import { readTrustRecords, highestRecord } from "../src/trust-records.js";

const T = fileTempDir("r3-");
let KEY, BAD;
before(async () => { setKeyDir(join(T, "keys")); KEY = await keygen(T, "owner"); BAD = await keygen(T, "compromised"); });
const CANON = "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/canon.schema.json", CFG = "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/persian-config.schema.json", P = "saasreport";
const gen = async () => { const k = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]); return { k, pub: Buffer.from(await crypto.subtle.exportKey("raw", k.publicKey)).toString("base64") }; };
const V = await gen(), VERIFIER = { url: "https://broker.example/verify", publicKey: V.pub, required: true };
const rec = (seq, persian, extra = {}, supersedes) => makeRecord({ project: P, approvals: { persian }, seq, github: REPO, owner: OWNER_NAME, key: OWNER, extra, ...(supersedes !== undefined ? { supersedes } : {}) });
function repo(name) {
  const root = join(T, name); initRepo(root);
  writeJson(root, "kit.canon.json", { $schema: CANON, project: P, persian: "persian.config.json" });
  writeJson(root, "persian.config.json", { $schema: CFG, sources: [{ name: "ui", files: ["src/*.js"] }], review: {} });
  writeJson(root, "src/ui.js", 'export const T = { a: "پرداخت انجام شد." };\n'); writeJson(root, ".github/CODEOWNERS", "/fa-review.json @o\n");
  const head = commit(root), cfg = readJson(root, "persian.config.json");
  const set = baselineCandidates(reviewState(root, cfg, null)).map((s) => ({ file: s.file, sha256: s.sha256 }));
  return { root, head, pin: { sha256: baselineHash(set), entries: set.length }, scope: { sha256: scopeHash(cfg, "persian.config.json") } };
}
const base = (head, pin, scope, over = {}) => ({ ledger: "fa-review.json", anchor: head, baseline: pin, scope, roster: [{ name: "Owner", publicKey: KEY.pub }], ...over });
const NEWCOPY = 'export const T = { a: "پرداخت انجام شد.", promo: "این متن را هیچ‌کس نخوانده و تأیید نکرده است." };\n';

test("R3-1 (HIGH): dropping \"persian\" from kit.canon.json (agent-editable) cannot switch the deploy gate off while the owner-signed record names a Persian ledger", async () => {
  const { root, head, pin, scope } = repo("b1");
  const trust = { records: [rec(1, base(head, pin, scope))] };
  assert.equal((await run(root, ["persian", "baseline"], { trust })).code, 0); commit(root);
  writeJson(root, "src/ui.js", NEWCOPY); commit(root);
  assert.equal((await run(root, ["check", "fa-review"], { trust })).code, 1, "CONTROL: unsigned new copy is refused");
  writeJson(root, "kit.canon.json", { $schema: CANON, project: P }); commit(root, "agent");
  const r = await run(root, ["check", "fa-review"], { trust });
  assert.equal(r.code, 1); assert.match(r.err, /names a Persian approval ledger \(fa-review\.json\), but kit\.canon\.json no longer declares "persian"/);
  // a record that does not verify cannot say that the owner names no Persian ledger either
  const forged = { records: [{ ...trust.records[0], expires: "2098-01-01T00:00:00.000Z" }] };
  const f = await run(root, ["check", "fa-review"], { trust: forged });
  assert.equal(f.code, 1); assert.match(f.err, /does not verify, so it cannot be known that the owner names none/);
  // and a project the owner never registered still has nothing to gate (not configured stays a pass)
  const none = await run(root, ["check", "fa-review"], { trust: { records: [] } });
  assert.equal(none.code, 0, none.err);
});

test("R3-1b: the config FILE the scope is about is pinned too: pointing kit.canon.json's \"persian\" at another file with the same sources is a different scope", async () => {
  const { root, head, pin, scope } = repo("b2");
  const trust = { records: [rec(1, base(head, pin, scope))] };
  assert.equal((await run(root, ["persian", "baseline"], { trust })).code, 0); commit(root);
  assert.equal((await run(root, ["check", "fa-review"], { trust })).code, 0, "CONTROL");
  writeJson(root, "other.json", { ...readJson(root, "persian.config.json") });
  writeJson(root, "kit.canon.json", { $schema: CANON, project: P, persian: "other.json" }); commit(root);
  const r = await run(root, ["check", "fa-review"], { trust });
  assert.equal(r.code, 1); assert.match(r.err, /other\.json's review scope .*differs from the one the owner signed/);
  assert.notEqual(scopeHash({ sources: [] }, "a.json"), scopeHash({ sources: [] }, "b.json"));
});

test("R3-1c: the BROKER's content check does not sign ok:true after kit.canon.json drops \"persian\" with unsigned new Persian copy", async () => {
  const { root, head, pin, scope } = repo("b3");
  const r1 = rec(1, base(head, pin, scope), { verifier: VERIFIER }), trust = { records: [r1] };
  assert.equal((await run(root, ["persian", "baseline"], { trust })).code, 0); commit(root);
  writeJson(root, "src/ui.js", NEWCOPY);
  writeJson(root, "kit.canon.json", { $schema: CANON, project: P }); const sha = commit(root, "agent");
  const kit = kitFor({ cwd: root, [TEST]: seamFor({ trust }) });
  const ctx = { repo: REPO, owner: OWNER_NAME, ownerKeys: [OWNER.rawB64], db: d1(), source: gitSource(root, sha, kit, { record: () => r1 }), signKey: V.k.privateKey, pin: { minSeq: 1, verifier: VERIFIER } };
  const h = verifierEndpoint({ context: () => ctx });
  const ask = async (c = ctx) => (await (await verifierEndpoint({ context: () => c })(new Request("https://b/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: P, kind: "persian", sha, nonce: "0".repeat(32) }) }))).json());
  void h;
  const j = await ask();
  assert.equal(j.ok, false); assert.match(j.problems.join(), /no longer declares "persian"/);
  // the broker's own pin (minSeq AND the verifier) is required config: without it nothing is signed
  for (const pin2 of [undefined, null, {}, { minSeq: 1 }, { minSeq: "1", verifier: VERIFIER }]) {
    const x = await ask({ ...ctx, pin: pin2 });
    assert.equal(x.ok, false); assert.match(x.problems.join(), /the broker's own pin is required config/);
  }
});

test("R3-2 (MEDIUM): the downgrade is closed when KIT_TRUST_PIN is unset, {}, null or has a non-integer minSeq (environment from agent-editable workflow YAML); a record with no valid seq or a renamed project fails closed", async () => {
  const { root, head, pin, scope } = repo("a1");
  const b = base(head, pin, scope);
  const r1 = rec(1, { ...b, roster: [{ name: "Owner", publicKey: KEY.pub }, { name: "Compromised", publicKey: BAD.pub }] });
  const r2 = rec(2, { ...b, witnessFrom: 0 }, { verifier: VERIFIER }, recordHash(r1));
  assert.equal((await run(root, ["persian", "baseline"], { trust: { records: [r1] } })).code, 0); commit(root);
  writeJson(root, "src/agent.js", 'export const X = { a: "متنی که مالک هرگز نخوانده است." };\n'); commit(root);
  const a = await run(root, ["persian", "approve", "--by", "Compromised", "--key", BAD.file, "src/agent.js"], { trust: { records: [r1] } });
  assert.equal(a.code, 0, a.err); commit(root);
  const env0 = () => { const e = { ...process.env }; delete e.KIT_TRUST_PIN; return e; };
  const calls = []; const fetch = async (u) => { calls.push(u); throw new Error("ECONNREFUSED"); };
  const honest = await run(root, ["check", "fa-review"], { trust: { records: [r1, r2] }, fetch, env: { ...env0(), KIT_TRUST_PIN: JSON.stringify({ [P]: { minSeq: 2, verifier: VERIFIER } }) } });
  assert.equal(honest.code, 1); assert.match(honest.err, /"Compromised", who is not in the reviewer roster at this point of the chain/, "CONTROL: with seq 2 and a valid pin the compromised approval is refused");
  for (const pinv of [undefined, "", "{}", "null", "[]", "not json", JSON.stringify({ [P]: {} }), JSON.stringify({ [P]: null }), JSON.stringify({ [P]: { minSeq: "2" } }), JSON.stringify({ [P]: { minSeq: 2.5 } }), JSON.stringify({ other: { minSeq: 1 } })]) {
    const env = env0(); if (pinv !== undefined) env.KIT_TRUST_PIN = pinv;
    const r = await run(root, ["check", "fa-review"], { trust: { records: [r1] }, fetch, env });
    assert.equal(r.code, 1, `KIT_TRUST_PIN=${pinv}`); assert.match(r.err, /trust pin|no trust pin/, `KIT_TRUST_PIN=${pinv}: refused because of the pin, not because src/agent.js is unapproved`);
  }
  const penv = { ...env0(), KIT_TRUST_PIN: JSON.stringify({ [P]: { minSeq: 2 } }) };
  for (const [what, records, why] of [
    ["seq null", [r1, { ...r2, seq: null }], /no valid seq/], ["seq \"two\"", [r1, { ...r2, seq: "two" }], /no valid seq/], ["seq missing", [r1, { ...r2, seq: undefined }], /no valid seq/],
    ["project renamed (deleted from this project)", [r1, { ...r2, project: "other" }], /below the minimum seq 2/],
    ["corrupted r2", [r1, { ...r2, expires: "2098-01-01T00:00:00.000Z" }], /higher-seq record is present but invalid/],
  ]) {
    const r = await run(root, ["check", "fa-review"], { trust: { records }, fetch, env: { ...env0(), KIT_TRUST_PIN: what.startsWith("corrupted") ? JSON.stringify({ [P]: { minSeq: 1 } }) : penv.KIT_TRUST_PIN } });
    assert.equal(r.code, 1, what); assert.match(r.err, why, what); assert.equal(calls.length, 0, "the verifier was never reached");
  }
});

test("R3-6: ONE record reader: an unreadable record file is a corrupted set for bundled() and for gitSource() alike, never skipped", async () => {
  assert.deepEqual(readTrustRecords({ files: ["a.json", "b.json", "c.txt", "d.json"], read: (f) => ({ "a.json": '{"project":"p","seq":1}', "b.json": "{ not json", "d.json": "[1]" }[f]) }), [{ project: "p", seq: 1 }, null, null]);
  assert.throws(() => highestRecord([{ project: "p", seq: 1 }, null], "p"), /unreadable or has no project/);
  assert.throws(() => highestRecord([{ project: "p", seq: "x" }], "p"), /no valid seq/);
  assert.equal(highestRecord([{ project: "p", seq: 1 }, { project: "p", seq: 3 }, { project: "q", seq: 9 }], "p").seq, 3);
  // git side: a committed record file that is not JSON (the owner's newest, corrupted)
  const { root } = repo("rd"); const dir = "packages/core/registry/trust";
  writeJson(root, `${dir}/${P}.json`, rec(1, { ledger: "fa-review.json", anchor: "a".repeat(40), roster: [{ name: "Owner", publicKey: KEY.pub }] }));
  writeFileSync(join(root, dir, "broken.json"), "{ truncated");
  const sha = commit(root);
  const kit = kitFor({ cwd: root, [TEST]: seamFor({}) });
  await assert.rejects(gitSource(root, sha, kit).record(P), /unreadable or has no project/);
  // bundled side: the same set read from a directory
  const { mkdirSync } = await import("node:fs"); const d = join(T, "bundle"); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "x.json"), "{ truncated");
  const set = readTrustRecords({ files: ["x.json"], read: (f) => require_(join(d, f)) });
  const b = bundled({ trust: { records: set }, io: { [TEST]: { owner: OWNER_NAME, ownerKeys: [OWNER.rawB64], repo: REPO, pin: { minSeq: 1 } } } });
  const ap = await b.approvals(P);
  assert.equal(ap.known, false); assert.match(ap.problems.join(), /have no project: the set is corrupted/);
});
import { readFileSync } from "node:fs";
const require_ = (f) => readFileSync(f, "utf8");

test("R3-7: kit trust propose prints the anchor and heads it COPIED from the working tree, for the owner to check against git before signing", async () => {
  const { root } = repo("pr"); git(root, ["add", "-A"]);
  const r = await run(root, ["trust", "propose", "--project", P, "--github", REPO, "--name", "Owner", "--public-key", KEY.pub, "--out", "rec.json", "--kinds", "persian", "--verifier-url", "https://b.example/v", "--verifier-key", V.pub, "--witness-url", "https://w.example/w", "--witness-key", V.pub]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /COPIED FROM THE WORKING TREE, check each against `git log`/);
  assert.match(r.out, /persian: anchor [0-9a-f]{40} = the current commit \(a new ledger\)/);
});
