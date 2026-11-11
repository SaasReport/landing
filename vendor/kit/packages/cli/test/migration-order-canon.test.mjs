// Canon (review of 7fa30afa): a migrations directory is read in ONE order, @saasreport/core/migration-order's migrationOrder (wrangler's own order: 9_ before 10_).
// A bare `.sort()` on a list of migration files orders them by text and runs 10_ before 9_. This scans every source and test file of the repository
// for that shape, so the class is impossible to reintroduce anywhere: a hit names the file and line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The finding: a line that reads a migrations directory (or its .sql files) and sorts without the comparator. */
export const bareMigrationSorts = (text) => text.split("\n").flatMap((l, i) => (/(migrations|MIGRATIONS|\bMIG\b|\.sql\b|migrationFiles|sqlFiles)/.test(l) && /\.sort\(\)/.test(l) ? [{ line: i + 1, text: l.trim().slice(0, 140) }] : []));

test("MUST FAIL (review of 7fa30afa): the probe shapes are found; a comparator or an unrelated sort is not", () => {
  assert.equal(bareMigrationSorts('readdirSync(join(root, "migrations")).sort()').length, 1);
  assert.equal(bareMigrationSorts('readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()').length, 1);
  assert.equal(bareMigrationSorts('readdirSync(MIG).filter((x) => x.endsWith(".sql") && x < "0008").sort()').length, 1);
  assert.equal(bareMigrationSorts('readdirSync(dir).filter((f) => f.endsWith(".sql")).sort(migrationOrder)').length, 0);
  assert.equal(bareMigrationSorts("names.sort()").length, 0);
});

test("no source or test file of the repository sorts migration files with a bare .sort()", () => {
  const files = execFileSync("git", ["-C", ROOT, "ls-files", "-z", "--", "packages/**/*.js", "packages/**/*.mjs", "scripts/**", "examples/**/*.js", "examples/**/*.mjs"], { encoding: "utf8" }).split("\0").filter((f) => /\.(m?js)$/.test(f) && !f.endsWith("migration-order-canon.test.mjs"));
  const hits = files.flatMap((f) => bareMigrationSorts(readFileSync(`${ROOT}${f}`, "utf8")).map((h) => `${f}:${h.line}: ${h.text}`));
  assert.deepEqual(hits, [], "sort migration files with .sort(migrationOrder) from @saasreport/core/migration-order");
});
