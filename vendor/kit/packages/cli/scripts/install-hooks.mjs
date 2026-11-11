#!/usr/bin/env node
/**
 * npm's prepare step: points git at the repository's hooks (.githooks), so a commit is pushed only after npm test passes on
 * it. Only at the top of the repository's own work tree: a kit nested in another repository (vendored, a package in a
 * monorepo) never sets the parent's core.hooksPath, which would point the parent at a directory it does not have and silence
 * its own hooks. Outside a work tree there is nothing to hook; a git that refuses the setting is an error, never ignored.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gitEnv } from "../src/git.js";

const same = (a, b) => { const x = statSync(a), y = statSync(b); return x.dev === y.dev && x.ino === y.ino; };

export function installHooks(root = process.cwd(), { git = (args) => execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env: gitEnv({ ...process.env, LC_ALL: "C", LANGUAGE: "C" }) }) } = {}) {
  let top;
  try { top = git(["rev-parse", "--show-toplevel"]).trim(); }
  catch (e) {
    if (e.code === "ENOENT") return "no git installed: no hooks to install";
    if (/not a git repository/i.test(String(e.stderr))) return "not a git work tree: no hooks to install";
    throw e;
  }
  if (!top) return "not a git work tree: no hooks to install";
  if (!same(top, root)) return `not the top of its own work tree (inside ${top}): the enclosing repository's hooks are left alone`;
  // the repository's own work tree: its hooks are part of it
  if (!existsSync(`${root}/.githooks/pre-push`)) throw new Error(".githooks/pre-push is missing: the repository's hooks are part of it");
  git(["config", "core.hooksPath", ".githooks"]);
  return "git hooks: .githooks (pre-push runs npm test on the pushed commit)";
}

if ((() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; /* argv[1] names no file (node -, -e): not run directly */ } })()) console.log(installHooks());
