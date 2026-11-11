// The ledger across git history (ROOT A and F): every commit is checked against EVERY parent, a merge cannot hide a withdrawal, a correctly resolved fork
// (re-signed on top) passes, the anchor must be an ancestor of HEAD, and the monotonic witness file refuses a rollback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createLedger, ledgerHistoryProblems, fileWitness, writeLedgerFile } from "../src/ledger-io.js";
import { verifyLedger } from "@saasreport/core/ledger";
import { keys, approve, append, rosterOf } from "../../core/test/fixtures/ledger.mjs";
import { fileTempDir } from "../../core/test/support/temp.mjs";
import { git, commit, initRepo } from "./approvals-helpers.mjs";

const TMP = fileTempDir("kit-history-");

const H = (c) => c.repeat(64), C = (x) => JSON.parse(JSON.stringify(x));
const EXPECT = { id: "p:shariah", project: "p", kind: "shariah", subject: "id" };
const NOW = Date.UTC(2026, 9, 8);
const W = (root, l) => writeLedgerFile(root, "ledger.json", l);
const hist = (root, l) => ledgerHistoryProblems(root, "ledger.json", l).map((p) => p.problem);
const ok = async (l, r) => { const v = await verifyLedger(l, { expect: EXPECT, bootstrap: r, now: NOW }); assert.deepEqual(v.problems, []); return v; };
function start(name) {
  const root = join(TMP, name); initRepo(root); commit(root, "root");
  const a = keys("Dr A"), b = keys("Dr B"), r = rosterOf(a, b);
  const l = createLedger(root, EXPECT);
  approve(l, a, "murabaha", H("1")); W(root, l); commit(root, "A approves murabaha");
  return { root, a, b, r, l };
}

test("ROOT A: a merge cannot hide a withdrawal (the old first-parent / simplified history walk accepted it)", async () => {
  const { root, a, r, l } = start("hide");
  const v1 = C(l);
  git(root, "checkout", "-q", "-b", "old"); writeFileSync(join(root, "other.txt"), "x"); commit(root, "a side branch made while murabaha was approved");
  git(root, "checkout", "-q", "main");
  append(l, a, { id: "murabaha", sha256: H("1"), status: "withdrawn", statement: "Withdrawn: the ruling is wrong." });
  W(root, l); commit(root, "withdraw");
  assert.deepEqual(hist(root, l), [], "the honest history is fine");
  // a plain truncation in the working tree
  assert.match(hist(root, v1).join(), /an earlier entry was rewritten, re-sorted or removed in the working tree|append-only/);
  // the attack: merge the old branch and resolve the ledger to the old (approved) version: the merge result is identical to the second parent's blob
  git(root, "merge", "-q", "--no-ff", "--no-commit", "old"); writeLedgerFile(root, "ledger.json", v1); commit(root, "merge old");
  const p = hist(root, v1);
  assert.ok(p.length > 0, "the merge that restored the approval is refused");
  assert.match(p.join(), /an earlier entry was rewritten, re-sorted or removed in commit|removed in the working tree/);
  void r;
});

test("ROOT F: a fork is resolved by a merge that re-signs the other branch's entries on top; dropping one is refused", async () => {
  const { root, a, b, r, l } = start("fork");
  git(root, "checkout", "-q", "-b", "pr-b");
  const lb = C(l); approve(lb, b, "salam", H("2")); W(root, lb); commit(root, "B approves salam");
  git(root, "checkout", "-q", "main");
  const la = C(l); approve(la, a, "ijara", H("3")); W(root, la); commit(root, "A approves ijara");
  // the legitimate resolution: take main's ledger, and B re-signs salam on top
  git(root, "merge", "-q", "--no-commit", "pr-b");
  const m = C(la); approve(m, b, "salam", H("2")); W(root, m); commit(root, "merge pr-b, B re-signs salam");
  const v = await ok(m, r);
  assert.equal(v.subjects.get("salam").status, "approved");
  assert.deepEqual(hist(root, m), [], "a correctly resolved fork passes the full-history check");
  // the same fork resolved WITHOUT re-signing (B's approval silently dropped) is refused
  git(root, "checkout", "-q", "-b", "other", "HEAD~1");   // main before the merge
  git(root, "reset", "-q", "--hard", git(root, "rev-parse", "HEAD~0").stdout.trim());
  git(root, "merge", "-q", "--no-commit", "pr-b");
  W(root, la); commit(root, "merge pr-b, dropping B's entry");
  assert.match(hist(root, la).join(), /merges a branch whose approved of salam is missing from the merged ledger/);
  // a fork that drops a WITHDRAWAL is refused the same way
  git(root, "checkout", "-q", "main");
  git(root, "checkout", "-q", "-b", "wd");
  const lw = C(m); append(lw, b, { id: "murabaha", sha256: H("1"), status: "withdrawn", statement: "Withdrawn: a reason of my own." }); W(root, lw); commit(root, "B withdraws murabaha");
  git(root, "checkout", "-q", "main");
  const lm = C(m); approve(lm, a, "istisna", H("4")); W(root, lm); commit(root, "A approves istisna");
  git(root, "merge", "-q", "--no-commit", "wd"); W(root, lm); commit(root, "merge wd, dropping the withdrawal");
  assert.match(hist(root, lm).join(), /merges a branch whose withdrawn of murabaha is missing/);
});

test("ROOT A: the ledger is never deleted or moved, and the anchor must be an ancestor of HEAD", async () => {
  const { root, l } = start("anchor");
  // an anchor that exists as an object but is not on this branch's history
  git(root, "checkout", "-q", "-b", "elsewhere"); writeFileSync(join(root, "x.txt"), "x"); const off = commit(root, "an unmerged commit");
  git(root, "checkout", "-q", "main");
  const bad = C(l); bad.anchor = { ...bad.anchor, commit: off };
  assert.match(hist(root, bad).join(), /is not an ancestor of HEAD/);
  assert.deepEqual(hist(root, l), []);
  rmSync(join(root, "ledger.json")); commit(root, "delete the ledger");
  assert.match(hist(root, null).join(), /the ledger was deleted in commit/);
});

test("a ledger renamed to a new path leaves the registry's path empty: refused as a deletion", async () => {
  const { root, l } = start("rename");
  git(root, "mv", "ledger.json", "ledger2.json"); commit(root, "rename");
  assert.match(hist(root, l).join(), /the ledger was deleted/);
});

test("the witness file (CI): outside the repository only; a rolled-back or forked ledger is refused; a longer one is recorded", async () => {
  const { root, a, l } = start("witness");
  const wf = join(TMP, "witness-store", "ledger.jsonl");
  assert.deepEqual(fileWitness(root, wf, l), []);
  assert.ok(existsSync(wf));
  const longer = C(l); approve(longer, a, "salam", H("2"));
  assert.deepEqual(fileWitness(root, wf, longer), []);
  assert.match(fileWitness(root, wf, l).map((p) => p.problem).join(), /behind the witnessed head/, "the rolled-back ledger");
  const fork = C(l); approve(fork, a, "other", H("9"));
  assert.match(fileWitness(root, wf, fork).map((p) => p.problem).join(), /forked or rewritten/);
  assert.match(fileWitness(root, join(root, "witness.jsonl"), l).map((p) => p.problem).join(), /must be outside the repository/);
});
