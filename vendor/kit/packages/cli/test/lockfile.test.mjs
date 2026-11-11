// package-lock.json must satisfy package.json and every workspace, or `npm ci` (the first step of CI) fails before any test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lockfileProblems } from "../src/canon/lockfile.js";
import { tempDir } from "../../core/test/support/temp.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
test("this repository's lockfile satisfies its workspaces", () => assert.deepEqual(lockfileProblems(ROOT), []));

function fixture(t) {
  const d = tempDir(t, "kit-lock-");
  mkdirSync(join(d, "packages/a"), { recursive: true });
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "r", workspaces: ["packages/*"], devDependencies: { x: "^1" } }));
  writeFileSync(join(d, "packages/a/package.json"), JSON.stringify({ name: "@k/a", dependencies: { "@k/b": "*" } }));
  writeFileSync(join(d, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "r", devDependencies: { x: "^1" } }, "node_modules/@k/a": { resolved: "packages/a", link: true }, "packages/a": { name: "@k/a", dependencies: { "@k/b": "*" } } } }));
  return d;
}
test("must-fail: a new workspace package without a lockfile update, a changed range, a removed dependency", (t) => {
  const d = fixture(t);
  assert.deepEqual(lockfileProblems(d), [], "the fixture starts in sync");
  mkdirSync(join(d, "packages/b"));
  writeFileSync(join(d, "packages/b/package.json"), JSON.stringify({ name: "@k/b" }));
  assert.match(lockfileProblems(d).map((p) => p.problem).join("\n"), /@k\/b \(packages\/b\) is not in the lockfile: run `npm install --package-lock-only`/);
  writeFileSync(join(d, "packages/a/package.json"), JSON.stringify({ name: "@k/a", dependencies: { "@k/b": "^2" } }));
  assert.match(lockfileProblems(d).map((p) => p.problem).join("\n"), /dependencies\.@k\/b is "\^2" in package.json but "\*" in the lockfile/);
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "r", workspaces: ["packages/*"] }));
  assert.match(lockfileProblems(d).map((p) => p.problem).join("\n"), /devDependencies\.x is in the lockfile but no longer in package.json/);
});

