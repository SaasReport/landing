// Test-owned temporary directories (docs/CONSTITUTION.md §10, zero post-facto: finding class test-temp-unowned).
//
// A test never calls mkdtemp itself: a directory a test makes and does not remove stays in the host's temp directory for good
// (on 2026-10-07 thousands of kit-* directories, 6.8 GB, filled /tmp twice, from runs of `node --test <file>` that bypassed the
// per-run TMPDIR of `npm test`). These helpers create the directory under os.tmpdir() and register its removal with node:test, so
// it is removed whatever the result of the test, and whoever started it.
//
// This is the one file that may call mkdtemp: the class excludes exactly this path (packages/core/test/support/temp.mjs), so
// nothing else in a test directory can: a copy of it elsewhere, or a tempDir of a test file's own, is refused.
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const remove = (dir) => () => fs.rmSync(dir, { recursive: true, force: true });

/**
 * A fresh directory owned by one test (or one suite): removed when `t` (the test's own context, the argument its callback
 * receives) finishes, whatever its result. `under` is the parent directory, os.tmpdir() unless a test nests it in a directory
 * it owns.
 */
export function tempDir(t, prefix, under = tmpdir()) {
  if (typeof t?.after !== "function") throw new TypeError("tempDir(t, prefix): t is the test context, the argument of the test callback; a directory without an owner is never made");
  const dir = fs.mkdtempSync(join(under, prefix));
  t.after(remove(dir));
  return dir;
}

/**
 * A fresh directory owned by one test file: removed when all the file's tests have finished, whatever their result. Call it at
 * the top level of the file only: node:test runs a hook registered inside a hook at once, which would remove the directory
 * before the tests use it. A directory made inside a test is tempDir(t, prefix).
 */
export function fileTempDir(prefix, under = tmpdir()) {
  const dir = fs.mkdtempSync(join(under, prefix));
  after(remove(dir));
  return dir;
}
