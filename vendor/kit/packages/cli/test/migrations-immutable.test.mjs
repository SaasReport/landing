// Applied migrations are append-only (packages/cli/src/migrations-immutable.js): this repository's own migrations are byte-identical to the
// content they were first committed with, and planted edits fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tempDir } from "../../core/test/support/temp.mjs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrationImmutabilityProblems } from "../src/migrations-immutable.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a]).toString().trim();

test("this repository's applied migrations are unchanged since they were added", () => {
  assert.deepEqual(migrationImmutabilityProblems(ROOT), []);
});

test("must-fail: an edited, renamed or deleted applied migration (committed, staged or only in the tree) fails; a new migration and a revert pass; a shallow clone fails closed", (t) => {
  const dir = tempDir(t, "kit-migrations-");
  git(dir, "init", "-q");
  mkdirSync(join(dir, "pkg/migrations"), { recursive: true });
  const m1 = join(dir, "pkg/migrations/0001_runs.sql");
  writeFileSync(m1, "CREATE TABLE runs (trigger TEXT NOT NULL); -- 'cron' | 'manual'\n");
  git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "add 0001");
  assert.deepEqual(migrationImmutabilityProblems(dir), []);
  // a comment edit is an edit: the bytes changed
  writeFileSync(m1, "CREATE TABLE runs (trigger TEXT NOT NULL); -- 'cron' | 'manual' | 'drill'\n");
  assert.match(migrationImmutabilityProblems(dir).map((p) => `${p.file}: ${p.message}`).join(), /pkg\/migrations\/0001_runs\.sql: an applied migration changed/, "in the tree");
  git(dir, "commit", "-q", "-am", "edit 0001");
  assert.equal(migrationImmutabilityProblems(dir).length, 1, "committed");
  // a revert to the added bytes passes; a new numbered migration passes
  writeFileSync(m1, "CREATE TABLE runs (trigger TEXT NOT NULL); -- 'cron' | 'manual'\n");
  writeFileSync(join(dir, "pkg/migrations/0002_drill.sql"), "ALTER TABLE runs ADD COLUMN mode TEXT;\n");
  git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "revert 0001, add 0002");
  assert.deepEqual(migrationImmutabilityProblems(dir), []);
  // renames and deletions (independent review of a061512: a rename read as the first add let an edit through, a deletion was never looked at)
  const m2 = join(dir, "pkg/migrations/0002_drill.sql");
  const scenario = (name, change, commit = true) => {
    const before = git(dir, "rev-parse", "HEAD");
    change();
    if (commit) { git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", name); }
    const problems = migrationImmutabilityProblems(dir).map((p) => `${p.file}: ${p.message}`).join(" | ");
    git(dir, "reset", "-q", "--hard", before);
    return problems;
  };
  assert.match(scenario("rename + edit + delete", () => { git(dir, "mv", "pkg/migrations/0001_runs.sql", "pkg/migrations/0001_runs2.sql"); writeFileSync(join(dir, "pkg/migrations/0001_runs2.sql"), "-- edited\n"); git(dir, "rm", "-q", "pkg/migrations/0002_drill.sql"); }),
    /0001_runs\.sql: an applied migration .* is gone from its path.*0002_drill\.sql: an applied migration .* is gone from its path/, "the reviewer's reproduction");
  assert.match(scenario("rename only", () => git(dir, "mv", "pkg/migrations/0001_runs.sql", "pkg/migrations/0001_renamed.sql")), /0001_runs\.sql: .*gone from its path: deleted or renamed/);
  assert.match(scenario("delete", () => git(dir, "rm", "-q", "pkg/migrations/0002_drill.sql")), /0002_drill\.sql: .*gone from its path/);
  assert.match(scenario("unstaged delete", () => rmSync(m2), false), /0002_drill\.sql: .*gone from its path/, "reported, never thrown as ENOENT");
  assert.deepEqual(migrationImmutabilityProblems(dir), [], "every scenario was rolled back");
  // names git would quote (core.quotepath): a Persian name, a quote, a newline (delta review of 1662636: a quoted path was skipped)
  const odd = ["0003_تراکنش.sql", '0004_a"b.sql', "0005_new\nline.sql"];
  for (const n of odd) writeFileSync(join(dir, "pkg/migrations", n), `-- ${n.length}\n`);
  git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "odd names");
  assert.deepEqual(migrationImmutabilityProblems(dir), [], "added as they are");
  for (const n of odd) {
    const problems = scenario(`edit ${n}`, () => writeFileSync(join(dir, "pkg/migrations", n), "-- edited\n"));
    assert.ok(problems.includes(`pkg/migrations/${n}: an applied migration changed`), `${JSON.stringify(n)}: ${problems}`);
  }
  // the index too: git rm --cached with the file left on disk
  assert.match(scenario("rm --cached", () => git(dir, "rm", "-q", "--cached", "pkg/migrations/0002_drill.sql"), false), /0002_drill\.sql: .*no longer in the index/);
  assert.match(scenario("staged edit, tree reverted", () => { writeFileSync(m2, "-- staged edit\n"); git(dir, "add", "pkg/migrations/0002_drill.sql"); writeFileSync(m2, "ALTER TABLE runs ADD COLUMN mode TEXT;\n"); }, false), /0002_drill\.sql: the staged copy .* differs/);
  // a directory where the migration was: reported, never thrown as EISDIR
  rmSync(m2); mkdirSync(m2);
  assert.match(migrationImmutabilityProblems(dir).map((p) => `${p.file}: ${p.message}`).join(), /0002_drill\.sql: .*no longer a file at its path \(a directory replaced it\)/);
  rmSync(m2, { recursive: true }); git(dir, "checkout", "-q", "--", "pkg/migrations/0002_drill.sql");
  assert.deepEqual(migrationImmutabilityProblems(dir), [], "restored");
  // a migration that only a merge commit introduced is listed (each commit is read against its first parent)
  const merged = tempDir(t, "kit-migrations-merge-");
  git(merged, "init", "-q", "-b", "main");
  writeFileSync(join(merged, "README"), "x\n"); git(merged, "add", "-A"); git(merged, "commit", "-q", "-m", "base");
  git(merged, "checkout", "-q", "-b", "side"); writeFileSync(join(merged, "side.txt"), "s\n"); git(merged, "add", "-A"); git(merged, "commit", "-q", "-m", "side");
  git(merged, "checkout", "-q", "main"); writeFileSync(join(merged, "main.txt"), "m\n"); git(merged, "add", "-A"); git(merged, "commit", "-q", "-m", "main");
  git(merged, "merge", "-q", "--no-ff", "--no-commit", "side");
  mkdirSync(join(merged, "db/migrations"), { recursive: true });
  writeFileSync(join(merged, "db/migrations/0001_merge.sql"), "CREATE TABLE m (x TEXT);\n");
  git(merged, "add", "-A"); git(merged, "commit", "-q", "-m", "merge side, adding a migration in the merge itself");
  assert.deepEqual(migrationImmutabilityProblems(merged), []);
  writeFileSync(join(merged, "db/migrations/0001_merge.sql"), "-- edited\n");
  assert.match(migrationImmutabilityProblems(merged).map((p) => `${p.file}: ${p.message}`).join(), /db\/migrations\/0001_merge\.sql: an applied migration changed/);
  // two branches each add the same path with different SQL and the merge keeps one (Codex on #141, P1). Applied migrations are what reached
  // main's first-parent line: the merge that kept a's bytes added them once, and b's bytes were never on that line, so it passes; a merge that
  const twice = tempDir(t, "kit-migrations-twice-");
  git(twice, "init", "-q", "-b", "main");
  writeFileSync(join(twice, "README"), "x\n"); git(twice, "add", "-A"); git(twice, "commit", "-q", "-m", "base");
  mkdirSync(join(twice, "db/migrations"), { recursive: true });
  git(twice, "checkout", "-q", "-b", "a"); writeFileSync(join(twice, "db/migrations/0001_t.sql"), "CREATE TABLE t (a TEXT);\n"); git(twice, "add", "-A"); git(twice, "commit", "-q", "-m", "a adds 0001");
  git(twice, "checkout", "-q", "main"); git(twice, "checkout", "-q", "-b", "b"); mkdirSync(join(twice, "db/migrations"), { recursive: true }); writeFileSync(join(twice, "db/migrations/0001_t.sql"), "CREATE TABLE t (b INTEGER);\n"); git(twice, "add", "-A"); git(twice, "commit", "-q", "-m", "b adds 0001");
  git(twice, "checkout", "-q", "main"); git(twice, "merge", "-q", "--no-ff", "a");
  try { git(twice, "merge", "-q", "--no-commit", "b"); } catch { /* the add/add conflict: resolved below to a's bytes */ }
  writeFileSync(join(twice, "db/migrations/0001_t.sql"), "CREATE TABLE t (a TEXT);\n"); git(twice, "add", "-A"); git(twice, "commit", "-q", "-m", "merge b, keeping a's 0001");
  assert.deepEqual(migrationImmutabilityProblems(twice), [], "the merge kept the bytes that were applied: one addition on main's line");
  writeFileSync(join(twice, "db/migrations/0001_t.sql"), "CREATE TABLE t (b INTEGER);\n");
  assert.match(migrationImmutabilityProblems(twice).map((p) => `${p.file}: ${p.message}`).join(), /0001_t\.sql: an applied migration changed/, "b's bytes in the tree are an edit of what was applied");
  git(twice, "checkout", "-q", "--", "db/migrations/0001_t.sql");
  // (a) a migration added on a branch, EDITED on that branch before the merge, then merged: main's first-parent line adds it once (the merge, with the
  // content that was applied); the branch's intermediate content was never applied. main itself failed on exactly this (#142, 0003_comms_form_deliveries.sql).
  const edited = tempDir(t, "kit-migrations-branch-edit-");
  git(edited, "init", "-q", "-b", "main");
  writeFileSync(join(edited, "README"), "x\n"); git(edited, "add", "-A"); git(edited, "commit", "-q", "-m", "base");
  git(edited, "checkout", "-q", "-b", "feature"); mkdirSync(join(edited, "db/migrations"), { recursive: true });
  writeFileSync(join(edited, "db/migrations/0001_f.sql"), "CREATE TABLE f (a TEXT);\n"); git(edited, "add", "-A"); git(edited, "commit", "-q", "-m", "feature adds 0001");
  writeFileSync(join(edited, "db/migrations/0001_f.sql"), "CREATE TABLE f (a TEXT, b TEXT);\n"); git(edited, "commit", "-q", "-am", "feature edits 0001 before the merge");
  git(edited, "checkout", "-q", "main"); writeFileSync(join(edited, "main.txt"), "m\n"); git(edited, "add", "-A"); git(edited, "commit", "-q", "-m", "main moves");
  git(edited, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");
  assert.deepEqual(migrationImmutabilityProblems(edited), [], "one addition, the merge's");
  // (c) an edit AFTER the merge is still an edit of an applied migration
  writeFileSync(join(edited, "db/migrations/0001_f.sql"), "CREATE TABLE f (a TEXT, c TEXT);\n"); git(edited, "commit", "-q", "-am", "edit after the merge");
  assert.match(migrationImmutabilityProblems(edited).map((p) => `${p.file}: ${p.message}`).join(), /db\/migrations\/0001_f\.sql: an applied migration changed/);
  // (b) two separate first-parent additions with different bytes (a merge adds the path, it is removed, another merge adds other bytes)
  const separate = tempDir(t, "kit-migrations-separate-");
  git(separate, "init", "-q", "-b", "main");
  writeFileSync(join(separate, "README"), "x\n"); git(separate, "add", "-A"); git(separate, "commit", "-q", "-m", "base");
  for (const [br, sql] of [["a", "CREATE TABLE t (a TEXT);\n"], ["b", "CREATE TABLE t (b INTEGER);\n"]]) {
    git(separate, "checkout", "-q", "-b", br, "main"); mkdirSync(join(separate, "db/migrations"), { recursive: true });
    writeFileSync(join(separate, "db/migrations/0001_t.sql"), sql); git(separate, "add", "-A"); git(separate, "commit", "-q", "-m", `${br} adds 0001`);
    git(separate, "checkout", "-q", "main"); git(separate, "merge", "-q", "--no-ff", "-m", `merge ${br}`, br);
    if (br === "a") { git(separate, "rm", "-q", "db/migrations/0001_t.sql"); git(separate, "commit", "-q", "-m", "remove 0001"); }
  }
  assert.match(migrationImmutabilityProblems(separate).map((p) => `${p.file}: ${p.message}`).join(), /db\/migrations\/0001_t\.sql: conflicting additions: [0-9a-f]{12} and [0-9a-f]{12} each added this migration with different content/);
  // the same path added on two branches with the SAME bytes is one migration, not a conflict
  const same = tempDir(t, "kit-migrations-same-");
  git(same, "init", "-q", "-b", "main");
  writeFileSync(join(same, "README"), "x\n"); git(same, "add", "-A"); git(same, "commit", "-q", "-m", "base");
  mkdirSync(join(same, "db/migrations"), { recursive: true });
  for (const br of ["a", "b"]) { git(same, "checkout", "-q", "-b", br, "main"); mkdirSync(join(same, "db/migrations"), { recursive: true }); writeFileSync(join(same, "db/migrations/0001_t.sql"), "CREATE TABLE t (a TEXT);\n"); git(same, "add", "-A"); git(same, "commit", "-q", "-m", `${br} adds 0001`); }
  git(same, "checkout", "-q", "main"); git(same, "merge", "-q", "--no-ff", "a"); git(same, "merge", "-q", "--no-ff", "b");
  assert.deepEqual(migrationImmutabilityProblems(same), []);
  // fail closed: a shallow clone, or no git work tree at all
  const shallow = join(tempDir(t, "kit-migrations-shallow-"), "clone");
  execFileSync("git", ["clone", "-q", "--depth", "1", `file://${dir}`, shallow]);
  assert.match(migrationImmutabilityProblems(shallow).map((p) => p.message).join(), /shallow clone/);
  const plain = tempDir(t, "kit-migrations-plain-");
  assert.match(migrationImmutabilityProblems(plain).map((p) => p.message).join(), /not a git work tree/);
});
