// kit check migrations: every migrations/*.sql is RUN against the local D1 engine (SQLite behind D1's measured limits), in order, on a fresh
// database per binding. The outage of 2026-10-07..13 is the must-fail: a trigger whose GLOB pattern was 65 bytes (D1 allows 50) passed every
// test on a plain SQLite and refused every episode insert in production.
import { migrationOrder } from "@saasreport/core/migration-order";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileTempDir } from "../../core/test/support/temp.mjs";
import { migrationsCheck } from "../src/migrations-d1.js";
import { runCanon, CHECKS } from "../src/canon/index.js";
import { main } from "../src/index.js";

const BASE = fileTempDir("kit-mig-");
let SEQ = 0;
const repo = (files) => {
  const root = join(BASE, `r${SEQ++}`);
  for (const [f, t] of Object.entries(files)) { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), t); }
  return root;
};

/** The pattern of kit's 0008..0010 provenance trigger: exactly the 65 bytes D1 refused. */
const GLOB65 = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]*";
const TABLE = "CREATE TABLE podcast_episodes (slug TEXT PRIMARY KEY, created_at TEXT);\n";
const trigger = (pattern) => `CREATE TRIGGER podcast_created_at BEFORE INSERT ON podcast_episodes\nWHEN NEW.created_at IS NULL OR NEW.created_at NOT GLOB '${pattern}'\nBEGIN SELECT RAISE(ABORT, 'created_at is not an ISO timestamp'); END;\n`;

test("the pattern of the outage is 65 bytes (the fixture is the real thing)", () => {
  assert.equal(new TextEncoder().encode(GLOB65).length, 65);
});

test("MUST FAIL: the 65-byte GLOB trigger of the 2026-10-07 outage is refused, with the statement and D1's message", () => {
  const root = repo({ "migrations/0001_t.sql": TABLE, "migrations/0002_trigger.sql": trigger(GLOB65) });
  const r = migrationsCheck(root);
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 1, JSON.stringify(r.problems));
  assert.equal(r.problems[0].file, "migrations/0002_trigger.sql");
  assert.match(r.problems[0].problem, /LIKE or GLOB pattern too complex: SQLITE_ERROR/);
  assert.match(r.problems[0].problem, /D1 allows 50 bytes/);
  assert.match(r.problems[0].problem, /65 bytes/);
  assert.match(r.problems[0].problem, /CREATE TRIGGER podcast_created_at/, "the statement is named");
});

test("MUST PASS: the same trigger at D1's limit (50 bytes) runs", () => {
  const ok = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*";
  assert.ok(new TextEncoder().encode(ok).length <= 50);
  const r = migrationsCheck(repo({ "migrations/0001_t.sql": TABLE, "migrations/0002_trigger.sql": trigger(ok) }));
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.equal(r.checked, 1);
});

test("an applied migration cannot be edited, so a later migration that drops and recreates the object is the fix (the final schema is judged)", () => {
  const fixed = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*";
  const r = migrationsCheck(repo({
    "migrations/0001_t.sql": TABLE, "migrations/0002_bad.sql": trigger(GLOB65),
    "migrations/0003_fix.sql": `DROP TRIGGER podcast_created_at;\n${trigger(fixed)}`,
  }));
  assert.deepEqual(r.problems, [], "kit 0008..0010 carry the 65-byte pattern; 0011 replaced the triggers");
});

test("MUST FAIL: a pattern in a view and in a CHECK constraint is judged the same way", () => {
  const view = repo({ "migrations/0001_v.sql": `CREATE TABLE t (a TEXT);\nCREATE VIEW v AS SELECT a FROM t WHERE a GLOB '${GLOB65}';\n` });
  assert.match(migrationsCheck(view).problems[0].problem, /creates view v/);
  const check = repo({ "migrations/0001_c.sql": `CREATE TABLE t (a TEXT CHECK (a GLOB '${GLOB65}'));\n` });
  assert.match(migrationsCheck(check).problems[0].problem, /creates table t/);
});

test("MUST FAIL: an INSERT whose literal pattern is over the limit is rejected by the engine itself", () => {
  const r = migrationsCheck(repo({ "migrations/0001_t.sql": `${TABLE}DELETE FROM podcast_episodes WHERE slug LIKE '${"x".repeat(51)}';\n` }));
  assert.equal(r.ok, false);
  assert.match(r.problems[0].problem, /pattern too complex/);
});

test("MUST FAIL: a statement SQLite rejects names the file, the statement and the engine's message; later files do not run on a broken schema", () => {
  const r = migrationsCheck(repo({ "migrations/0001_t.sql": TABLE, "migrations/0002_bad.sql": "ALTER TABLE nope ADD COLUMN x TEXT;\n", "migrations/0003_after.sql": "CREATE TABLE after (a);\n" }));
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].file, "migrations/0002_bad.sql");
  assert.match(r.problems[0].problem, /statement 1 is rejected: .*no such table: nope.*ALTER TABLE nope/s);
});

test("migrations run in order on a fresh database: a later file needs an earlier one, and an order that breaks it fails", () => {
  const ok = migrationsCheck(repo({ "migrations/0001_a.sql": "CREATE TABLE a (x);\n", "migrations/0002_b.sql": "ALTER TABLE a ADD COLUMN y TEXT;\n" }));
  assert.deepEqual(ok.problems, []);
  const reversed = migrationsCheck(repo({ "migrations/0002_a.sql": "CREATE TABLE a (x);\n", "migrations/0001_b.sql": "ALTER TABLE a ADD COLUMN y TEXT;\n" }));
  assert.equal(reversed.ok, false, "0001 runs first and finds no table");
});

test("a database per binding, from the wrangler config (any name, migrations_dir relative to it), and a directory no binding names", () => {
  const root = repo({
    "wrangler.toml": 'name = "w"\nmain = "src/w.js"\ncompatibility_date = "2026-09-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "site"\ndatabase_id = "site-id"\nmigrations_dir = "vendor/kit/packages/cloudflare/migrations"\n[[d1_databases]]\nbinding = "OTHER"\ndatabase_name = "other"\ndatabase_id = "other-id"\n',
    "vendor/kit/packages/cloudflare/migrations/0001_t.sql": TABLE,
    "migrations/0001_o.sql": "CREATE TABLE o (a);\n",
    "tools/migrations/0001_x.sql": "CREATE TABLE x (a);\n",
    "node_modules/pkg/migrations/0001_bad.sql": "THIS IS NOT SQL;\n",
    "findings/c/must-fail/r/migrations/0001_bad.sql": "THIS IS NOT SQL;\n",
  });
  const r = migrationsCheck(root);
  assert.deepEqual(r.problems, []);
  assert.equal(r.checked, 3, "DB (the vendored dir), OTHER (migrations/) and tools/migrations (no binding): node_modules and findings/ are not the repository's");
});

test("MUST FAIL: the binding's migrations are the ones judged, wherever they live (a vendored kit migration with the pattern fails the site that applies it)", () => {
  const root = repo({
    "wrangler.toml": 'name = "w"\nmain = "src/w.js"\ncompatibility_date = "2026-09-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "site"\ndatabase_id = "site-id"\nmigrations_dir = "vendor/kit/packages/cloudflare/migrations"\n',
    "vendor/kit/packages/cloudflare/migrations/0001_t.sql": TABLE,
    "vendor/kit/packages/cloudflare/migrations/0002_trigger.sql": trigger(GLOB65),
  });
  const r = migrationsCheck(root);
  assert.equal(r.ok, false);
  assert.match(r.problems[0].problem, /wrangler\.toml DB/, "the binding that would apply it is named");
});

test("MUST FAIL: a binding that names a migrations_dir with nothing in it migrates nothing; one that names none may share a database another Worker migrates", () => {
  const w = (extra) => `name = "w"\nmain = "src/w.js"\ncompatibility_date = "2026-09-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "site"\ndatabase_id = "site-id"\n${extra}`;
  const named = migrationsCheck(repo({ "wrangler.toml": w('migrations_dir = "db/migrations"\n') }));
  assert.equal(named.ok, false);
  assert.match(named.problems[0].problem, /names migrations_dir "db\/migrations", which holds no \.sql migration/);
  assert.equal(migrationsCheck(repo({ "wrangler.toml": w("") })).notApplicable, true, "no named directory, no migrations in the tree: nothing to run");
  const hoisted = migrationsCheck(repo({ "sub/wrangler.toml": w('migrations_dir = "node_modules/@x/c/migrations"\n'), "node_modules/@x/c/migrations/0001_t.sql": TABLE }));
  assert.deepEqual(hoisted.problems, [], "a node_modules path is found the way Node finds a package: in the config's directory or above it");
  assert.equal(hoisted.checked, 1);
});

test("no migration at all is not applicable, proven from the files (never a silent pass of a repository that has some)", () => {
  const r = migrationsCheck(repo({ "README.md": "x" }));
  assert.equal(r.notApplicable, true);
  assert.equal(r.checked, 0);
});

test("the kit's own migrations run clean", () => {
  const r = migrationsCheck(new URL("../../../", import.meta.url).pathname);
  assert.deepEqual(r.problems, []);
  assert.ok(r.checked >= 5, `the kit's packages ship migrations (cloudflare, uploads, broker, monitor, comms): ${r.checked}`);
});

test("migrations is a canon check, so npm test (kit check canon, first) runs it everywhere; kit check migrations runs it alone", async () => {
  assert.ok(CHECKS.includes("migrations"));
  const root = repo({ "migrations/0001_t.sql": TABLE, "migrations/0002_trigger.sql": trigger(GLOB65) });
  const out = [], err = [];
  const io = { cwd: root, out: (s) => out.push(s), err: (s) => err.push(s), env: {}, spawn: () => ({ status: 0 }) };
  const code = await main(["check", "migrations"], io).catch((e) => { err.push(e.message); return 1; });
  assert.notEqual(code, 0);
  assert.match(err.join("\n"), /migrations|kit\.canon\.json/);
  void runCanon;
});

test("immutable legacy line comments are normalized only at the canonical D1 transport boundary", () => {
  const quoted = migrationsCheck(repo({ "migrations/0001_t.sql": `-- the site's table\n${TABLE}` }));
  assert.deepEqual(quoted.problems, [], "an apostrophe in non-SQL prose is normalized without changing the table");
  const semi = migrationsCheck(repo({ "migrations/0001_t.sql": `${TABLE}-- one thing; another thing\nCREATE INDEX i ON podcast_episodes (slug);\n` }));
  assert.deepEqual(semi.problems, [], "a semicolon inside a comment does not reach Wrangler's remote SQL splitter");
  const trailing = migrationsCheck(repo({ "migrations/0001_t.sql": "CREATE TABLE t (a TEXT); -- e.g. 'x'\n" }));
  assert.deepEqual(trailing.problems, [], "a trailing comment cannot alter the executable statement");
});

test("MUST PASS: an ASCII comment without either, and a ; or ' inside a string literal (SQL, not a comment)", () => {
  const r = migrationsCheck(repo({ "migrations/0001_t.sql": `-- the table of episodes, one row per episode\n${TABLE}INSERT INTO podcast_episodes VALUES ('a;b -- not a comment', 'it''s');\n` }));
  assert.deepEqual(r.problems, []);
});

test("the kit-shipped migrations applied before the rule are excused by their bytes, and the generator emits none", async () => {
  const { provenanceMigrationSql, provenanceTriggersSql } = await import("@saasreport/core/podcast-provenance-sql");
  const { commentProblems } = await import("@saasreport/core/d1-limits");
  for (const sql of [provenanceMigrationSql({ origins: ["cron", "cron-retry"] }), provenanceTriggersSql({ origins: ["cron", "catchup"] })]) assert.deepEqual(commentProblems(sql), []);
  const copy = repo({ "migrations/0001_t.sql": `-- the site's table\n${TABLE}` });
  assert.equal(migrationsCheck(copy).ok, true, "safe transport applies the same SQL from an unedited legacy file");
});

test("legacy generated headers are transport-normalized without editing executable SQL or historical bytes", async () => {
  const { commentProblems } = await import("@saasreport/core/d1-limits");
  const old = "-- @saasreport/cloudflare: the t=0 rule for podcasts. GENERATED by `kit podcast migrate` from kit.podcast-provenance.v1 and the project's\n-- podcast.config.json provenance.origins (cron, cron-retry); never hand-edited (`kit check podcast` compares it with the generator).\nSELECT 1;\n";
  const found = commentProblems(old);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => f.chars), [["'"], [";"]]);
  const { migrationTransportSQL } = await import("../src/migration-transport.js");
  const { tokenize } = await import("@saasreport/core/d1-limits");
  const r = migrationsCheck(repo({ "migrations/0014_podcast_provenance_triggers.sql": old }));
  assert.equal(r.ok, true, "the remote Wrangler boundary repairs comments without touching applied SQL");
  const staged = migrationTransportSQL(old);
  const tokens = (s) => tokenize(s).filter((t) => !["ws", "line", "block"].includes(t.t)).map((t) => [t.t, t.v]);
  assert.deepEqual(tokens(staged), tokens(old), "SQL executable tokens are identical");
  assert.deepEqual(commentProblems(staged), []);
  assert.match(old, /project.s/, "historical source bytes stay untouched");
});

// finding class engine-migrations-present (Codex on app#54): a site's comms Worker ran the vendored engine on the project's migrations, which lacked
// comms 0002 (the partial UNIQUE index the engine's idempotency relies on): concurrent dispatches with one key both inserted.
const COMMS_1 = "CREATE TABLE comms_dispatch (id INTEGER PRIMARY KEY, idem TEXT);\nCREATE INDEX idx_dispatch_idem ON comms_dispatch (idem);\n";
const COMMS_2 = "CREATE UNIQUE INDEX uq_dispatch_idem ON comms_dispatch (idem) WHERE idem IS NOT NULL;\n";
const WR = (dir) => `name = "site-comms"\nmain = "src/comms.js"\ncompatibility_date = "2026-09-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "site"\ndatabase_id = "site-id"\nmigrations_dir = "${dir}"\n`;
const engineSite = (own) => repo({
  "vendor/kit/packages/comms/migrations/0001_comms.sql": COMMS_1, "vendor/kit/packages/comms/migrations/0002_comms_dispatch_idempotency.sql": COMMS_2,
  "src/comms.js": 'import engine from "../vendor/kit/packages/comms/workers/comms-engine/engine.js";\nexport default engine;\n',
  "wrangler.toml": WR("migrations"), ...own,
});

test("MUST FAIL: a Worker that runs the vendored comms engine on a migrations directory without the engine's 0002 is refused, naming the missing file", () => {
  const r = migrationsCheck(engineSite({ "migrations/0001_comms.sql": COMMS_1 }));
  assert.equal(r.ok, false);
  const p = r.problems.find((x) => /engine-migrations-present/.test(x.problem));
  assert.ok(p, JSON.stringify(r.problems));
  assert.match(p.problem, /comms engine of the kit/);
  assert.match(p.problem, /0002_comms_dispatch_idempotency\.sql/);
  assert.match(p.problem, /kit migrations sync/);
});

test("MUST PASS: the engine's migrations present byte for byte (under any number), or the binding applies the package's own directory", () => {
  assert.deepEqual(migrationsCheck(engineSite({ "migrations/0001_comms.sql": COMMS_1, "migrations/0007_comms_unique.sql": COMMS_2 })).problems, []);
  const own = repo({
    "vendor/kit/packages/comms/migrations/0001_comms.sql": COMMS_1, "vendor/kit/packages/comms/migrations/0002_x.sql": COMMS_2,
    "src/comms.js": 'import "@saasreport/comms";\n', "wrangler.toml": WR("vendor/kit/packages/comms/migrations"),
  });
  assert.deepEqual(migrationsCheck(own).problems, []);
});

test("kit migrations sync appends what is missing as the next number, never edits an existing file, and the check then passes; --check writes nothing", async () => {
  const root = engineSite({ "migrations/0001_comms.sql": COMMS_1, "migrations/0002_site_own.sql": "CREATE TABLE own (a);\n" });
  const out = [], err = [];
  const io = { cwd: root, env: {}, out: (s) => out.push(s), err: (s) => err.push(s) };
  assert.equal(await main(["migrations", "sync", "--check"], io), 1);
  assert.equal(readdirSync(join(root, "migrations")).length, 2, "--check writes nothing");
  assert.equal(await main(["migrations", "sync"], io), 0, err.join("\n"));
  assert.deepEqual(readdirSync(join(root, "migrations")).sort(migrationOrder), ["0001_comms.sql", "0002_site_own.sql", "0003_comms_comms_dispatch_idempotency.sql"]);
  assert.equal(readFileSync(join(root, "migrations/0003_comms_comms_dispatch_idempotency.sql"), "utf8"), COMMS_2);
  assert.equal(readFileSync(join(root, "migrations/0001_comms.sql"), "utf8"), COMMS_1);
  assert.deepEqual(migrationsCheck(root).problems, []);
  assert.equal(await main(["migrations", "sync"], io), 0);
  assert.equal(readdirSync(join(root, "migrations")).length, 3, "idempotent");
});

test("MUST FAIL (review of e865a625): what remote D1 refuses is refused in a migration: BEGIN/COMMIT, foreign keys off, a pattern as a concatenation, double quotes, or no literal at all", () => {
  const sixty = "x".repeat(60);
  const bad = (sql, re) => { const r = migrationsCheck(repo({ "migrations/0001_t.sql": `${TABLE}${sql}\n` })); assert.equal(r.ok, false, sql); assert.match(r.problems.map((p) => p.problem).join("\n"), re, sql); };
  bad("BEGIN TRANSACTION;\nCREATE TABLE b (a);\nCOMMIT;", /D1 does not run this statement \(explicit-transaction\)/);
  bad("PRAGMA foreign_keys=OFF;", /foreign-keys-off/);
  bad(`CREATE TRIGGER t1 BEFORE INSERT ON podcast_episodes WHEN NEW.slug GLOB 'abc' || '${sixty}' BEGIN SELECT RAISE(ABORT, 'x'); END;`, /pattern too complex/);
  bad(`CREATE TRIGGER t2 BEFORE INSERT ON podcast_episodes WHEN NEW.slug GLOB "${sixty}" BEGIN SELECT RAISE(ABORT, 'x'); END;`, /not a string literal/);
  // review of 7fa30afa: a non-literal tail after || is not a literal pattern
  for (const [i, tail] of ["NEW.created_at", "upper(NEW.slug)", "lower('X')", "(SELECT 'y')", "CAST(NEW.slug AS TEXT)"].entries()) bad(`CREATE TRIGGER u${i} BEFORE INSERT ON podcast_episodes WHEN NEW.slug GLOB 'a' || ${tail} BEGIN SELECT RAISE(ABORT, 'x'); END;`, /not a string literal/);
  // and everything the registry lists reaches a migration the same way
  bad("ATTACH DATABASE ':memory:' AS other;", /attach-detach/);
  bad("VACUUM;", /\(vacuum\)/);
  bad("PRAGMA writable_schema = ON;", /pragma-unsupported/);
  bad("CREATE VIRTUAL TABLE v USING rtree(id, a, b);", /virtual-table-module/);
  bad("CREATE TRIGGER t3 BEFORE INSERT ON podcast_episodes WHEN NEW.slug GLOB NEW.created_at BEGIN SELECT RAISE(ABORT, 'x'); END;", /not a string literal/);
});

test("MUST FAIL (review of e865a625): migrations apply in numeric order of their prefix (9_ before 10_), the order wrangler applies them in", async () => {
  const { migrationOrder } = await import("../src/d1-local.js");
  assert.deepEqual(["10_b.sql", "0002_c.sql", "9_a.sql", "0001_x.sql", "notes.sql"].sort(migrationOrder), ["0001_x.sql", "0002_c.sql", "9_a.sql", "10_b.sql", "notes.sql"]);
  const ok = migrationsCheck(repo({ "migrations/9_a.sql": "CREATE TABLE a (x);\n", "migrations/10_b.sql": "ALTER TABLE a ADD COLUMN y TEXT;\n" }));
  assert.deepEqual(ok.problems, [], "lexicographic order would run 10_ first and fail");
});

test("MUST FAIL (review of 62db4e32): the order is wrangler's own (parseInt of the text before the first _, NaN last, string tie-break); two files with one number have a defined order and are no finding", async () => {
  const { migrationOrder } = await import("@saasreport/core/migration-order");
  const { default: source } = await import("@saasreport/core/registry/migration-order-source.json", { with: { type: "json" } });
  assert.equal(source.wrangler.version, "4.145.0");
  // a reference implementation of wrangler's compareSegments, written from the registry's rule, on a fixture with an applied pair and a NaN-prefixed name
  const ref = (a, b) => { const x = parseInt(a.split("_")[0], 10), y = parseInt(b.split("_")[0], 10); if (Number.isNaN(x) !== Number.isNaN(y)) return Number.isNaN(x) ? 1 : -1; if (x !== y && !Number.isNaN(x)) return x < y ? -1 : 1; return a < b ? -1 : a > b ? 1 : 0; };
  const fixture = ["0010_z.sql", "0008_podcast_provenance.sql", "notes.sql", "9_a.sql", "0008_a_ids.sql", "0001_x.sql", "12abc_q.sql", "README.sql"];
  assert.deepEqual([...fixture].sort(migrationOrder), [...fixture].sort(ref));
  assert.deepEqual([...fixture].sort(migrationOrder), ["0001_x.sql", "0008_a_ids.sql", "0008_podcast_provenance.sql", "9_a.sql", "0010_z.sql", "12abc_q.sql", "README.sql", "notes.sql"]);
  const pair = migrationsCheck(repo({ "migrations/0008_a_ids.sql": "CREATE TABLE a (x);\n", "migrations/0008_podcast_provenance.sql": "ALTER TABLE a ADD COLUMN y TEXT;\n" }));
  assert.deepEqual(pair.problems, [], "the applied pair is in order, not a finding");
});

test("MUST FAIL (review of e865a625): the legacy ledger is reviewed entries { path, reason, reviewed }, each matching a file in the tree, and it only shrinks against the base ref", async () => {
  const { legacyLedgerProblems, legacyLedger, LEDGER_PATH } = await import("../src/legacy-ledger.js");
  const { execFileSync } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const { bundled } = await import("../src/canon/index.js");
  const kit = bundled();
  const sha = (t) => createHash("sha256").update(t).digest("hex");
  const mig = "-- the site's table\nCREATE TABLE a (x);\n";
  const entry = (path) => ({ path, reason: "Applied before the comment rule and immutable; its comment holds an apostrophe.", reviewed: "2026-10-14" });
  const ledger = (files, base = "origin/main") => JSON.stringify({ about: "Kit-shipped migrations excused from the comment rule by sha256, a list that only shrinks.", base, files }, null, 2);
  const root = repo({ [LEDGER_PATH]: ledger({ [sha(mig)]: entry("packages/x/migrations/0001_a.sql") }), "packages/x/migrations/0001_a.sql": mig });
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q"); git("add", "-A"); git("commit", "-q", "-m", "base"); git("update-ref", "refs/remotes/origin/main", "HEAD");
  assert.deepEqual(legacyLedgerProblems(root), [], "an entry that matches its file and is in the base passes");
  // an entry whose file changed is stale
  writeFileSync(join(root, "packages/x/migrations/0001_a.sql"), `${mig}-- edited\n`);
  assert.match(legacyLedgerProblems(root)[0].problem, /does not match packages\/x\/migrations\/0001_a\.sql/);
  writeFileSync(join(root, "packages/x/migrations/0001_a.sql"), mig);
  // a new entry that the base does not hold: the list only shrinks
  const other = "-- it's another\nCREATE TABLE b (y);\n";
  writeFileSync(join(root, "packages/x/migrations/0002_b.sql"), other);
  writeFileSync(join(root, LEDGER_PATH), ledger({ [sha(mig)]: entry("packages/x/migrations/0001_a.sql"), [sha(other)]: entry("packages/x/migrations/0002_b.sql") }));
  assert.match(legacyLedgerProblems(root).map((p) => p.problem).join("\n"), /not in origin\/main's ledger: the list only shrinks/);
  // an entry for a file that is gone
  writeFileSync(join(root, LEDGER_PATH), ledger({ [sha("zzz")]: entry("packages/x/migrations/0009_gone.sql") }));
  assert.match(legacyLedgerProblems(root)[0].problem, /not in the tree/);
  // the schema: no reason, no entry
  const bad = JSON.parse(ledger({ [sha(mig)]: { path: "packages/x/migrations/0001_a.sql" } }));
  assert.ok(kit.validator.validate(bad, kit.byName("legacy-migration-comments")).length > 0, "an entry without reason and reviewed is not valid");
  // review of 7fa30afa: the base ref is the ledger's own field; a ref that does not resolve is a FINDING under CI and an explicit note elsewhere, never silence
  writeFileSync(join(root, LEDGER_PATH), ledger({ [sha(mig)]: entry("packages/x/migrations/0001_a.sql") }, "refs/remotes/upstream/gone"));
  const local = legacyLedger(root, { env: {} });
  assert.deepEqual(local.problems, []);
  assert.match(local.notes.join("\n"), /refs\/remotes\/upstream\/gone cannot be resolved here.*NOT proven; CI refuses to skip it/);
  for (const flag of [{ CI: "true" }, { GITHUB_ACTIONS: "true" }]) {
    const ci = legacyLedger(root, { env: flag });
    assert.match(ci.problems.map((p) => p.problem).join("\n"), /refs\/remotes\/upstream\/gone cannot be resolved here.*a CI run never skips this proof/);
    assert.deepEqual(ci.notes, []);
  }
  const check = migrationsCheck(root, {}, { env: {} });
  assert.match(check.summary, /note: .*cannot be resolved here/, "`kit check migrations` prints the note");
  // a base ref that resolves but holds no ledger yet: this change introduces it (a note, not a finding)
  const fresh = repo({ "packages/x/migrations/0001_a.sql": mig, "README": "x" });
  const g2 = (...a) => execFileSync("git", ["-C", fresh, ...a], { stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g2("init", "-q"); g2("add", "-A"); g2("commit", "-q", "-m", "base"); g2("update-ref", "refs/remotes/origin/main", "HEAD");
  mkdirSync(join(fresh, "packages/core/registry"), { recursive: true });
  writeFileSync(join(fresh, LEDGER_PATH), ledger({ [sha(mig)]: entry("packages/x/migrations/0001_a.sql") }));
  const intro = legacyLedger(fresh, { env: { CI: "true" } });
  assert.deepEqual(intro.problems, []);
  assert.match(intro.notes.join("\n"), /origin\/main holds no legacy ledger yet: this change introduces it/);
});


test("review regression: leading SQL comments do not turn a schema migration into a rejected data statement", () => {
  const fixed = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*";
  const root = repo({
    "migrations/0001_t.sql": TABLE,
    "migrations/0002_old.sql": "-- historical trigger kept immutable\n/* provenance */\n" + trigger(GLOB65),
    "migrations/0003_fix.sql": `-- append-only repair\nDROP TRIGGER podcast_created_at;\n${trigger(fixed)}`,
  });
  assert.deepEqual(migrationsCheck(root).problems, [], "only the final D1 schema is authoritative for DDL patterns");
  const stillBad = repo({
    "migrations/0001_t.sql": TABLE,
    "migrations/0002_old.sql": "-- historical trigger kept immutable\n" + trigger(GLOB65),
  });
  assert.match(migrationsCheck(stillBad).problems[0].problem, /creates trigger podcast_created_at/, "a still-dangerous commented trigger remains blocked");
});

test("review regression: the same D1 migration directory shared by environments receives each SQL file once", async () => {
  const wrangler = WR("migrations") + [
    "[env.production]",
    'main = "src/comms.js"',
    "[[env.production.d1_databases]]",
    'binding = "DB"',
    'database_name = "site-production"',
    'database_id = "site-production-id"',
    'migrations_dir = "migrations"',
    "",
  ].join("\n");
  const root = engineSite({ "wrangler.toml": wrangler, "migrations/0001_comms.sql": COMMS_1 });
  const err = [];
  const io = { cwd: root, env: {}, out: () => {}, err: (s) => err.push(s) };
  assert.equal(await main(["migrations", "sync", "--check"], io), 1);
  assert.equal(await main(["migrations", "sync"], io), 0, err.join("\n"));
  assert.deepEqual(readdirSync(join(root, "migrations")).sort(migrationOrder), [
    "0001_comms.sql", "0002_comms_comms_dispatch_idempotency.sql",
  ], "no second copy for env.production on the same database directory");
  assert.deepEqual(migrationsCheck(root).problems, [], "the resulting D1 migration chain is valid");
  assert.equal(await main(["migrations", "sync"], io), 0);
  assert.equal(readdirSync(join(root, "migrations")).length, 2, "reruns do not add duplicates");
});


test("D1 migrations defer foreign keys until their per-file COMMIT, but do not permit explicit transaction SQL", () => {
  const header = "CREATE TABLE parents (id INTEGER PRIMARY KEY);\nCREATE TABLE children (parent_id INTEGER REFERENCES parents(id));\n";
  const valid = repo({ "migrations/0001_deferral.sql": header + "PRAGMA defer_foreign_keys=ON;\nINSERT INTO children VALUES (5);\nINSERT INTO parents VALUES (5);\n" });
  assert.deepEqual(migrationsCheck(valid).problems, [], "child-first data can be repaired before migration commit");
  const broken = repo({ "migrations/0001_deferral.sql": header + "PRAGMA defer_foreign_keys=ON;\nINSERT INTO children VALUES (5);\n" });
  assert.match(migrationsCheck(broken).problems.map((p) => p.problem).join("\n"), /migration commit is rejected|FOREIGN KEY constraint failed/i,
    "a deferred violation cannot escape the implicit migration COMMIT");
  const explicit = repo({ "migrations/0001_bad.sql": header + "BEGIN;\n" });
  assert.match(migrationsCheck(explicit).problems.map((p) => p.problem).join("\n"), /explicit-transaction/,
    "user-controlled transaction boundaries are still refused by D1");
});
