// The independent review of c80bdbe (proofs P1-P4): attacks that PASSED on c80bdbe are must-fail tests here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "../../core/test/support/temp.mjs";
import { writeJson, commit, initRepo, trustWith, run, keygen, setKeyDir, OWNER, OWNER_NAME, REPO, readJson, persianPins } from "./approvals-helpers.mjs";
import { d1 } from "../../core/test/fixtures/d1.mjs";
import * as L from "../../core/test/fixtures/ledger.mjs";
import { recordWitness, recordTrustWitness } from "@saasreport/core/witness";
import { trustBody, trustNamespace } from "@saasreport/core/trust";
import { sshSign, newOwnerKey } from "../../core/test/fixtures/ssh.mjs";
import { makeRecord } from "../../core/test/fixtures/trustrec.mjs";
import { genesisFor } from "@saasreport/core/ledger";

const CANON = "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/canon.schema.json";
const CFG = "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/persian-config.schema.json";
const files = { "kit.canon.json": { $schema: CANON, project: "saasreport", persian: "persian.config.json" },
  "persian.config.json": { $schema: CFG, sources: [{ name: "ui", files: ["src/*.js"] }], review: {} },
  "src/ui.js": 'export const T = { a: "پرداخت انجام شد." };\n', ".github/CODEOWNERS": "/fa-review.json @owner\n" };

test("P1 / H1: an agent cannot create a baseline for copy the owner never read: the gate fails with ZERO owner signatures unless the owner-signed record pins exactly that baseline", async (t) => {
  const T = tempDir(t, "p1-"); setKeyDir(join(T, "keys")); const KEY = await keygen(T, "owner");
  const root = join(T, "r"); initRepo(root); for (const [f, b] of Object.entries(files)) writeJson(root, f, b); commit(root);
  const REG = trustWith("saasreport", { persian: { ledger: "fa-review.json", anchor: null, roster: [{ name: "Masoud", publicKey: KEY.pub }], scope: (await persianPins(root)).scope } });
  writeJson(root, "src/agent.js", 'export const X = { a: "متنی که هیچ‌کس نخوانده است." };\n'); commit(root);
  const b = await run(root, ["persian", "baseline"], { trust: REG });
  assert.equal(b.code, 1); assert.match(b.err, /owner-signed (trust )?record pins no baseline/);
  const g = await run(root, ["check", "fa-review"], { trust: REG });
  assert.equal(g.code, 1);
  // the agent hand-writes a ledger with baseline entries for the copy it wrote: the verifier refuses it (no owner pin)
  const { createLedger, writeLedgerFile } = await import("../src/ledger-io.js"), { reviewState } = await import("../src/canon/persian.js");
  const st = reviewState(root, readJson(root, "persian.config.json"), null).map((s) => ({ file: s.file, sha256: s.sha256, segments: s.segments }));
  const { default: _x } = { default: 0 }; void _x;
  const exp = { id: "saasreport:persian", project: "saasreport", kind: "persian", subject: "file", anchor: null };
  writeLedgerFile(root, "fa-review.json", createLedger(root, exp, { baselines: st })); commit(root);
  const h = await run(root, ["check", "fa-review"], { trust: REG });
  assert.equal(h.code, 1); assert.match(h.err, /pins no baseline: a baseline counts as approved copy/);
  // the owner pins a set (after reading it): the baseline of exactly that set works, and copy the agent adds afterwards is NOT covered
  const { baselineHash } = await import("@saasreport/core/ledger");
  const head = (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const { rmSync } = await import("node:fs"); rmSync(join(root, "fa-review.json")); commit(root);
  const set = reviewState(root, readJson(root, "persian.config.json"), null).filter((s) => s.state === "new" || s.state === "invalid").map((s) => ({ file: s.file, sha256: s.sha256 }));
  const PIN = trustWith("saasreport", { persian: { ledger: "fa-review.json", anchor: head, roster: [{ name: "Masoud", publicKey: KEY.pub }], baseline: { sha256: baselineHash(set.filter((s) => s.file !== "src/agent.js")), entries: set.length - 1 }, scope: (await persianPins(root)).scope } });
  const other = await run(root, ["persian", "baseline"], { trust: PIN });
  assert.equal(other.code, 1); assert.match(other.err, /is not the one the owner pinned/, "the owner pinned the set WITHOUT the agent's file");
});

test("P2 / H2: a stub verifier saying {ok:true} replaces nothing: the verdict must be signed by the key the owner-signed record pins, and the witness check still runs", async (t) => {
  const T = tempDir(t, "p2-"); setKeyDir(join(T, "keys")); const KEY = await keygen(T, "owner");
  const verifierKey = L.keys("verifier");
  const root = join(T, "r"); initRepo(root); for (const [f, b] of Object.entries(files)) writeJson(root, f, b); commit(root);
  const head = (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const { reviewState } = await import("../src/canon/persian.js");
  const states = reviewState(root, readJson(root, "persian.config.json"), null).filter((s) => s.state === "new" || s.state === "invalid").map((s) => ({ file: s.file, sha256: s.sha256 }));
  const core = await import("@saasreport/core/ledger");
  const REG = trustWith("saasreport", { persian: { ledger: "fa-review.json", anchor: head, roster: [{ name: "Masoud", publicKey: KEY.pub }], witnessFrom: 0, scope: (await persianPins(root)).scope, ...(core.baselineHash ? { baseline: { sha256: core.baselineHash(states), entries: states.length } } : {}) } }, { extra: { verifier: { url: "https://broker.example/verify", publicKey: verifierKey.publicKey, required: true } } });
  await run(root, ["persian", "baseline"], { trust: REG }); commit(root);
  const stub = async () => ({ status: 200, ok: true, json: async () => ({ ok: true, problems: [] }) });
  const msgs = [];
  for (const argv of [["check", "fa-review"], ["check", "fa-review", "--verifier-url", "https://broker.example/verify"], ["check", "fa-review", "--verifier-url", "https://attacker.example/"]]) {
    const r = await run(root, argv, { trust: REG, fetch: stub });
    assert.equal(r.code, 1, argv.join(" ")); msgs.push(r.err);
  }
  assert.match(msgs[1], /no signed verdict/, "the stub's {ok:true} is not a verdict");
  assert.match(msgs[1], /requires a witness .*but pins none/, "and a verdict would never replace the witness anyway");
  assert.match(msgs[2], /not the one the owner pinned/);
});

test("P3 / H3: the owner's recovery (a new owner-signed record with a new anchor) works end to end: the new ledger is witnessed under its own epoch", async () => {
  const db = d1(), A = L.keys("Masoud"), roster = L.rosterOf(A);
  const old = L.ledger("persian"); for (let i = 0; i < 3; i++) L.approve(old, A, "f" + i, String(i + 1).repeat(64));
  assert.equal((await recordWitness(db, old, { expect: { ...L.expectOf(old) }, bootstrap: roster, now: L.NOW })).ok, true);
  const fresh = L.ledger("persian"); const c = "b".repeat(40); fresh.anchor = { commit: c, genesis: genesisFor(c), baselineThrough: 0 }; L.approve(fresh, A, "f0", "9".repeat(64));
  const w = await recordWitness(db, fresh, { expect: { ...L.expectOf(fresh), anchor: c }, bootstrap: roster, now: L.NOW });
  assert.equal(w.ok, true, w.problems.join());
  assert.match((await recordWitness(db, old, { expect: { ...L.expectOf(old), anchor: c }, bootstrap: roster, now: L.NOW })).problems.join(), /anchor/, "the old epoch's ledger is refused by the new record's anchor");
});

test("P4 / H3: a replaced or empty witness database cannot accept an OLDER trust record once the owner's floor (the signed checkpoint) is pinned", async () => {
  const O = newOwnerKey(), A = L.keys("Masoud");
  const mk = (seq, roster, supersedes) => makeRecord({ project: "testproject", github: "O/r", owner: "o", seq, supersedes, key: O, approvals: { shariah: { ledger: "s.json", anchor: null, roster } } });
  const ctx = { owner: "o", ownerKeys: [O.rawB64], repo: "O/r", project: "testproject" };
  const r1 = mk(1, L.rosterOf(A, L.keys("Compromised")), null), r2 = mk(2, L.rosterOf(A));
  assert.equal((await recordTrustWitness(d1(), r1, ctx)).ok, true, "without a floor an empty database accepts the chain start (what P4 exploited)");
  const back = await recordTrustWitness(d1(), r1, { ...ctx, floor: { recordSeq: 2 } });
  assert.equal(back.ok, false); assert.match(back.problems.join(), /floor|checkpoint/);
  assert.equal((await recordTrustWitness(d1(), r2, { ...ctx, floor: { recordSeq: 2 } })).ok, true);
  void OWNER; void OWNER_NAME; void REPO; void readJson; void trustBody; void trustNamespace; void sshSign;
});
