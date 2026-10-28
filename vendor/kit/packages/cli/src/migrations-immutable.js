/**
 * Applied migrations are append-only: once a numbered migration file is committed, it stays at its path with its bytes unchanged (D1 never
 * re-runs an applied migration, so an edit changes nothing in a database that ran it, diverges from one that did not, and breaks any
 * checksum-based migration check). A change of schema is a NEW numbered migration.
 *
 *   migrationImmutabilityProblems(root) → problems: [{ file, message }]
 *
 * Every path that was EVER added under a migrations/ directory on the FIRST-PARENT line of HEAD (the commits that reached the branch: for
 * main, every direct commit and every merge, never the commits inside a merged branch) must still be there, unchanged, both in the index
 * and in the working tree, and must have been added ONCE. Applied migrations are the ones that reached main, so a migration added on a
 * branch, edited there before the merge, then merged is added exactly once, by the merge, with the content that was applied; a branch's
 * own intermediate content was never applied by anyone. Two separate first-parent additions of one path with different content (a merge
 * adds it, it is removed, another merge adds other bytes) are conflicting additions: a database that applied the first has a history the
 * second cannot share. Each commit is read against its first parent, renames are split into a deletion and an addition (so a rename cannot
 * pass for a first add), and every path git hands over is NUL-separated (-z), never quoted: a Persian name, a quote or a newline in a path
 * is read as it is. An edit, a rename, a deletion (committed, staged, `git rm --cached`, or only in the tree) and a path replaced by a
 * directory are problems. Needs the full history: a shallow clone, or a directory that is not a git work tree, is a problem (fail closed),
 * never a pass.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitEnv } from "./git.js";

const MIGRATION = /(^|\/)migrations\/[^/]+\.sql$/s;
const inScope = (f) => MIGRATION.test(f) && !f.startsWith("vendor/") && !f.startsWith(".kit/") && !f.includes("/fixtures/");
const git = (root, args) => execFileSync("git", ["-C", root, ...args], { env: gitEnv(), maxBuffer: 256 * 1024 * 1024 });
const nul = (buf) => buf.toString("utf8").split("\0").filter(Boolean);

/** path → every addition of it ({ commit, blob }) along the FIRST-PARENT line of HEAD, oldest first, each commit read against its first
 *  parent: what reached the branch, not what was tried inside a merged one. The same bytes added twice are one addition. */
function additions(root) {
  const out = new Map();
  // every first-parent commit with its first parent ("<sha> <parent>"), no path limit: history simplification must not hide a merge
  const line = git(root, ["rev-list", "--first-parent", "--parents", "--reverse", "HEAD"]).toString().split("\n").filter(Boolean).map((l) => l.split(" "));
  for (const [c, parent] of line) {
    const args = ["diff-tree", "-z", "-r", "--no-renames", "--no-commit-id", "--raw", "--diff-filter=A"];
    // --raw -z: ":<mode> <mode> <sha> <sha> A\0<path>\0" per entry
    const raw = nul(git(root, parent ? [...args, parent, c] : [...args, "--root", c]));
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const meta = raw[i].split(" "), f = raw[i + 1];
      if (!inScope(f)) continue;
      const blob = meta[3];
      const list = out.get(f) || [];
      if (!list.some((a) => a.blob === blob)) list.push({ commit: c, blob });
      out.set(f, list);
    }
  }
  return out;
}

/** The bytes of `path` in the index, or null when the index does not hold it as a file. */
function staged(root, path, index) {
  if (!index.has(path)) return null;
  return git(root, ["cat-file", "blob", `:${path}`]);
}

export function migrationImmutabilityProblems(root) {
  const P = (file, message) => ({ file, message });
  let shallow;
  try { shallow = git(root, ["rev-parse", "--is-shallow-repository"]).toString().trim(); }
  catch { return [P(".", "applied migrations cannot be verified: this is not a git work tree")]; }
  if (shallow === "true") return [P(".", "applied migrations cannot be verified on a shallow clone: fetch the full history (fetch-depth: 0)")];
  try { git(root, ["rev-parse", "--verify", "-q", "HEAD"]); } catch { return []; }   // no commit yet: nothing has been applied
  const index = new Set(nul(git(root, ["ls-files", "-z"])));
  const out = [];
  for (const [f, adds] of additions(root)) {
    if (adds.length > 1) { out.push(P(f, `conflicting additions: ${adds.map((a) => a.commit.slice(0, 12)).join(" and ")} each added this migration with different content; a database that applied one has a history the other cannot share; migrations are append-only, so the second must be a new numbered migration`)); continue; }
    const [{ commit: added, blob }] = adds;
    const at = added.slice(0, 12);
    const first = git(root, ["cat-file", "blob", blob]);
    let stat = null;
    try { stat = lstatSync(join(root, f)); } catch { /* gone from the tree: reported below */ }
    if (!stat) { out.push(P(f, `an applied migration (added in ${at}) is gone from its path: deleted or renamed; migrations are append-only, restore it`)); continue; }
    if (!stat.isFile()) { out.push(P(f, `an applied migration (added in ${at}) is no longer a file at its path (a ${stat.isDirectory() ? "directory" : "link or other entry"} replaced it); restore it`)); continue; }
    if (!first.equals(readFileSync(join(root, f)))) { out.push(P(f, `an applied migration changed since it was added in ${at}: migrations are append-only; revert it and add a new numbered migration`)); continue; }
    const inIndex = staged(root, f, index);
    if (inIndex === null) out.push(P(f, `an applied migration (added in ${at}) is no longer in the index (git rm --cached): restore it with git add`));
    else if (!first.equals(inIndex)) out.push(P(f, `the staged copy of an applied migration differs from the one added in ${at}: migrations are append-only`));
  }
  return out;
}
