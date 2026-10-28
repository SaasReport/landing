#!/usr/bin/env node
/**
 * The pre-push hook (.githooks/pre-push): npm test runs on the commit being pushed, so a red commit never leaves a checkout
 * (kit #115's 5144ccd was pushed red; CI stays the authority). The tests run on the working tree, so a push is refused unless
 * every ref pushed is the checked-out commit and the tree is clean: pushing another branch, or with uncommitted changes, would
 * test something else. A push that only deletes refs pushes no commit and runs nothing.
 */
import { readFileSync, realpathSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gitEnv } from "../src/git.js";
import { runInTemp, STEPS } from "./test-run.mjs";

const ZERO = /^0+$/;

/**
 * What git's pre-push stdin (one "<local ref> <local sha> <remote ref> <remote sha>" line per ref) asks to be tested, given
 * the checked-out commit, whether the tree is clean and how to peel a pushed object to its commit (an annotated tag):
 * { test: boolean, refuse?: string }.
 */
export function prePushPlan(stdin, { head, clean, peel = (sha) => sha }) {
  const lines = stdin.split("\n").map((l) => l.trim()).filter(Boolean);
  const pushed = [];
  for (const l of lines) {
    const f = l.split(" ");
    if (f.length !== 4) throw new Error(`pre-push: git wrote a line this hook does not read: ${JSON.stringify(l)}`);
    if (!ZERO.test(f[1])) pushed.push({ ref: f[0], given: f[1], sha: peel(f[1]) });   // an annotated tag names its commit
  }
  if (!pushed.length) return { test: false };
  const bare = pushed.find((p) => !p.sha);
  if (bare) return { test: false, refuse: `pre-push: ${bare.ref} (${bare.given.slice(0, 12)}) names no commit (a tag of a tree or a blob): npm test cannot test it` };
  const other = pushed.find((p) => p.sha !== head);
  if (other) return { test: false, refuse: `pre-push: ${other.ref} (${other.sha.slice(0, 12)}) is not the checked-out commit (${head.slice(0, 12)}), so npm test here would not test it: check it out (or push from its worktree) and push again` };
  if (!clean) return { test: false, refuse: "pre-push: the working tree has changes that are not committed, so npm test here would not test the pushed commit: commit or set them aside, then push" };
  return { test: true };
}

if ((() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; /* argv[1] names no file (node -, -e): not run directly */ } })()) {
  const git = (...a) => execFileSync("git", a, { encoding: "utf8", env: gitEnv() });
  // null when the object names no commit (rev-parse --verify --quiet exits 1 and prints nothing); the sha is git's own hex
  const peel = (sha) => { const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], { encoding: "utf8", env: gitEnv() }); if (r.error) throw r.error; return r.status === 0 ? r.stdout.trim() : null; };
  const plan = prePushPlan(readFileSync(0, "utf8"), { head: git("rev-parse", "HEAD").trim(), clean: git("status", "--porcelain").trim() === "", peel });
  if (plan.refuse) { console.error(plan.refuse); process.exitCode = 1; }
  else if (plan.test) process.exitCode = runInTemp(STEPS).code;
}
