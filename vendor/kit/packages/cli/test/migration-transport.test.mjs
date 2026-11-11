import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tempDir } from "../../core/test/support/temp.mjs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { commentProblems, tokenize } from "@saasreport/core/d1-limits";
import { migrationTransportSQL, stageD1Migrations } from "../src/migration-transport.js";
import { migrate as cliMigrate } from "../src/commands/wrangler.js";
import { migrate as releaseMigrate } from "../src/release/run.js";

const sha = (sql) => createHash("sha256").update(sql).digest("hex");
const semantic = (sql) => tokenize(sql).filter((t) => !["line", "ws", "block"].includes(t.t)).map((x) => [x.t, x.v]);

test("unsafe historical comments are repaired without modifying SQL tokens, literals or source", (t) => {
  const orig = tempDir(t, "kit-d1-immutable-");
  const src = join(orig, "source"), out = join(orig, "stage");
  mkdirSync(src);
  const sql = `-- the site's table; historically applied
CREATE TABLE t (id INTEGER, phrase TEXT);
INSERT INTO t VALUES (1, '-- ; this is inside an SQL string');
-- historical semicolon; new line
CREATE INDEX IF NOT EXISTS t_id ON t(id); -- owner said 'yes'
`;
  const file = join(src, "0002_historical.sql");
  writeFileSync(file, sql);
  assert.ok(commentProblems(sql).length > 0);
  const proof = stageD1Migrations(src, out);
  assert.equal(proof.normalised, 1);
  assert.deepEqual(proof.files.map((x) => x.name), ["0002_historical.sql"]);
  assert.equal(proof.files[0].source_sha256, sha(sql));
  const staged = readFileSync(join(out, "0002_historical.sql"), "utf8");
  assert.equal(proof.files[0].transport_sha256, sha(staged));
  assert.deepEqual(semantic(staged), semantic(sql), "all executable SQL tokens preserved byte for byte");
  assert.deepEqual(commentProblems(staged), []);
  assert.match(staged, /'-- ; this is inside an SQL string'/);
  assert.equal(readFileSync(file, "utf8"), sql, "the applied source migration is NEVER changed");
  assert.equal(migrationTransportSQL(staged), staged, "canonical staging is idempotent");
});

test("safe input remains byte-identical; staging cannot silently overwrite previous evidence", (t) => {
  const orig = tempDir(t, "kit-d1-clean-");
  mkdirSync(join(orig, "sql"));
  writeFileSync(join(orig, "sql", "0001_a.sql"), "CREATE TABLE a (id TEXT);\n");
  writeFileSync(join(orig, "sql", "0002.sql"), "CREATE TABLE b (id TEXT);\n");
  const proof = stageD1Migrations(join(orig, "sql"), join(orig, "stage"));
  assert.deepEqual(proof.files.map((x) => x.name), ["0001_a.sql", "0002.sql"], "Wrangler includes top-level SQL without an underscore");
  assert.equal(proof.normalised, 0);
  assert.equal(proof.files[0].source_sha256, proof.files[0].transport_sha256);
  assert.throws(() => stageD1Migrations(join(orig, "sql"), join(orig, "stage")), /EEXIST/);
});


test("CLI uses the existing custom D1 migrations ledger and transports 0002.sql safely", async (t) => {
  const root = tempDir(t, "kit-d1-custom-ledger-");
  mkdirSync(join(root, "migrations"));
  writeFileSync(join(root, "migrations/0002.sql"), "-- history; preserved\nCREATE TABLE t (id TEXT);\n");
  writeFileSync(join(root, "wrangler.toml"), [
    'name = "test"', 'compatibility_date = "2026-09-01"',
    "[[d1_databases]]", 'binding = "DB"', 'database_name = "custom-db"',
    'database_id = "11111111-1111-1111-1111-111111111111"',
    'migrations_dir = "migrations"', 'migrations_table = "custom_d1_ledger"',
    ""].join("\n"));
  let invoked = false;
  const io = { cwd: root, env: {}, out: () => {}, spawn: async (_cmd, args) => {
    invoked = true;
    assert.ok(args.includes("--remote"));
    const cfg = readFileSync(args[args.indexOf("--config") + 1], "utf8");
    assert.match(cfg, /migrations_table = "custom_d1_ledger"/);
    const staged = readFileSync(args[args.indexOf("--config") + 1].replace(/migration\.toml$/, "migrations/0002.sql"), "utf8");
    assert.deepEqual(commentProblems(staged), []);
    return 0;
  } };
  assert.equal(await cliMigrate(io, { flags: { remote: true } }), 0);
  assert.equal(invoked, true);
  assert.match(readFileSync(join(root, "migrations/0002.sql"), "utf8"), /history;/,
    "source migration is not changed");
});

test("central release preserves the D1 migrations_table and uses token-equivalent SQL", async (t) => {
  const root = tempDir(t, "kit-release-custom-ledger-");
  mkdirSync(join(root, "migrations")); mkdirSync(join(root, "tmp"));
  writeFileSync(join(root, "migrations/0002.sql"), "-- Luma; source\nCREATE TABLE t (id TEXT);\n");
  writeFileSync(join(root, "wrangler.toml"), [
    'name = "release"', 'main = "src/worker.js"', 'compatibility_date = "2026-09-01"',
    "[[d1_databases]]", 'binding = "DB"', 'database_name = "release-db"',
    'database_id = "22222222-2222-2222-2222-222222222222"',
    'migrations_dir = "migrations"', 'migrations_table = "release_ledger"',
    ""].join("\n"));
  let didMigrate = false, stageDir;
  const stages = [];
  const dir = await releaseMigrate(root, {
    name: "release-db", configs: [{ wrangler: "wrangler.toml", migrationsDir: "migrations" }],
    cf: { d1Find: async () => ({ uuid: "22222222-2222-2222-2222-222222222222" }) },
    wrangler: async (args) => {
      didMigrate = true;
      const cfg = readFileSync(args[args.indexOf("--config") + 1], "utf8");
      assert.match(cfg, /migrations_table = "release_ledger"/);
      stageDir = cfg.match(/^migrations_dir = "([^"]+)"$/m)?.[1];
      assert.ok(stageDir, "Wrangler must use an exclusive migrations_dir");
      stages.push(stageDir);
      const staged = readFileSync(join(stageDir, "0002.sql"), "utf8");
      assert.deepEqual(commentProblems(staged), []);
    },
    log: () => {}, tmp: join(root, "tmp"),
  });
  assert.equal(dir, "migrations");
  assert.ok(didMigrate);
  const receipt = JSON.parse(readFileSync(join(stageDir, "../transport-provenance.json"), "utf8"));
  assert.equal(receipt.files.length, 1);
  assert.equal(receipt.normalised, 1);
  // The previous stage intentionally remains; rerunning the same release must
  // not fail with EEXIST or reuse staged SQL under a different source hash.
  await releaseMigrate(root, {
    name: "release-db", configs: [{ wrangler: "wrangler.toml", migrationsDir: "migrations" }],
    cf: { d1Find: async () => ({ uuid: "22222222-2222-2222-2222-222222222222" }) },
    wrangler: async (args) => {
      const cfg = readFileSync(args[args.indexOf("--config") + 1], "utf8");
      stages.push(cfg.match(/^migrations_dir = "([^"]+)"$/m)?.[1]);
    }, log: () => {}, tmp: join(root, "tmp"),
  });
  assert.equal(stages.length, 2);
  assert.notEqual(stages[0], stages[1], "distinct attempts hold independent transport receipts");
});
