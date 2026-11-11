/**
 * canon check `migrations` (kit check migrations; docs/PODCASTS.md, "the publish chain"): every migrations/*.sql of the repository is
 * EXECUTED against the kit's local D1 engine (d1-local.js: SQLite behind D1's measured limits, no network), in order, on a fresh database per
 * D1 binding, and the check fails on any rejected statement with the statement and D1's message.
 *
 * Root cause it removes (2026-10-14): a migration carried a trigger whose GLOB pattern was 65 bytes. D1 allows 50. A plain SQLite accepts
 * it, so every test passed, the trigger refused every episode insert in production, and the daily podcasts stopped for a week. A limit that
 * only production enforces is found only in production; this puts D1's limits where the SQL is written, and the SQL is run, not read.
 *
 * A pattern over the limit does not fail at CREATE TRIGGER (SQLite checks it when the operator runs, i.e. on the first row), so each statement is
 * also read for its literals (patternProblems) before it is executed. A pattern that is not a literal (a column or a bound value) is checked at
 * run time by the engine (withD1Limits) wherever the code runs it, which is every database a test opens (finding class platform-limits).
 *
 *   migrationsCheck(root, canon) → { ok, configured, checked, summary, problems: [{ file, problem }], notApplicable? }
 *     checked = the number of (directory, binding) databases built; no migrations at all is "not applicable", proven from the files.
 */
import { applyMigrations, migrationDirs, openD1 } from "./d1-local.js";
import { engineMigrationProblems } from "./engine-migrations.js";
import { legacyLedger } from "./legacy-ledger.js";

export function migrationsCheck(root, canon = {}, { env = process.env } = {}) {
  let dirs, missing;
  try { ({ dirs, missing } = migrationDirs(root, canon)); } catch (e) { return { ok: false, configured: true, checked: 0, summary: "cannot read the migrations", problems: [{ file: ".", problem: `the migrations of this repository cannot be listed: ${e.message}` }] }; }
  if (!dirs.length && !missing.length) return { ok: true, configured: false, checked: 0, summary: "not applicable (the repository holds no migrations/*.sql and binds no D1 migrations directory)", problems: [], notApplicable: true };
  // a D1 binding that names a migrations_dir holding no .sql file (or not there) would migrate nothing: the schema its Worker needs is never created
  const problems = missing.map((m) => ({ file: m.config, problem: `D1 binding ${m.binding}${m.env ? ` [env.${m.env}]` : ""} names migrations_dir "${m.dir}", which holds no .sql migration (not found, or empty): wrangler would apply nothing, so the Worker would start on an empty database` }));
  problems.push(...engineMigrationProblems(root, canon));
  const ledger = legacyLedger(root, { env });
  problems.push(...ledger.problems);
  let databases = 0, files = 0;
  for (const d of dirs) {
    // one fresh database per binding that applies this directory; a directory no binding names (a kit package's own) gets one of its own
    const targets = d.bindings.length ? d.bindings.map((b) => `${b.config}${b.env ? ` [env.${b.env}]` : ""} ${b.binding}`) : [`${d.dir} (no binding names it)`];
    files += d.files.length;
    for (const target of targets) {
      let engine;
      try { engine = openD1(); } catch (e) { return { ok: false, configured: true, checked: databases, summary: "no D1 engine", problems: [{ file: d.dir, problem: e.message }] }; }
      databases++;
      for (const p of applyMigrations(engine.sqlite, d.files, { root })) problems.push({ file: p.file, problem: `D1 would reject this migration (${target}): ${p.problem}` });
    }
  }
  return { ok: !problems.length, configured: true, checked: databases, summary: `${files} migration file(s) in ${dirs.length} director${dirs.length === 1 ? "y" : "ies"} run in order on ${databases} fresh database(s) under D1's limits${ledger.notes.length ? ` (note: ${ledger.notes.join("; ")})` : ""}`, problems };
}
