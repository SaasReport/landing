import { test } from "node:test";
import assert from "node:assert/strict";
import { enginePackages, engineMigrationProblems, syncEngineMigrations } from "../src/engine-migrations.js";
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../core/test/support/temp.mjs";

test("an imported build/health helper never owns the site's D1 schema", () => {
  const monitor = [
    'import { createMonitor } from "@saasreport/monitor";',
    'import { withBuild } from "@saasreport/cloudflare/build";',
  ].join("\n");
  assert.deepEqual([...enginePackages(monitor)], ["monitor"], "monitor D1 must never replay cloudflare site SQL");

  const comms = [
    'import { createCommsEngine } from "@saasreport/comms/engine";',
    'import { withBuild } from "@saasreport/cloudflare/build";',
  ].join("\n");
  assert.deepEqual([...enginePackages(comms)], ["comms"], "comms DB must not replay site tables");

  const site = [
    'import { createKit } from "@saasreport/cloudflare";',
    'import { healthResponse } from "@saasreport/cloudflare/health";',
    'import { readJsonBody } from "@saasreport/cloudflare/body";',
  ].join("\n");
  assert.deepEqual([...enginePackages(site)], ["cloudflare"], "the actual site engine retains its schema gate");
});

test("static tools and script helpers are never mistaken for database engines", () => {
  const src = [
    'import { withBuild } from "../../packages/cloudflare/src/build.js";',
    'import { makeThing } from "../../packages/comms/src/templates.js";',
    'import { createCommsEngine } from "../../packages/comms/src/engine.js";',
    'import { createKit } from "../../packages/cloudflare/src/kit.js";',
    'import { run } from "@saasreport/monitor/runner";',
  ].join("\n");
  assert.deepEqual([...enginePackages(src)], ["comms", "cloudflare"]);
  assert.deepEqual([...enginePackages('import { withBuild } from "@saasreport/cloudflare/build";')], []);
  assert.deepEqual([...enginePackages('import { createKit } from "@saasreport/cloudflare";')], ["cloudflare"]);
  assert.deepEqual([...enginePackages('import engine from "../vendor/kit/packages/comms/workers/comms-engine/engine.js";')], ["comms"], "nested vendor engine imports keep a strict migration gate");
});

test("dynamic import and root engine entries stay detected without treating any package leaf as owner", () => {
  const src = [
    'const app = await import("@saasreport/monitor");',
    'const ignore = await import("@saasreport/cloudflare/health");',
    'const emails = await import("@saasreport/comms/engine");',
    'import "@saasreport/cloudflare/build";',
  ].join("\n");
  assert.deepEqual([...enginePackages(src)], ["monitor", "comms"]);
});


test("one schema owner: a project podcast's governed ledger supersedes Kit's historical ADD COLUMN without replay", (t) => {
  const setup = (withPodcast) => {
    const root = tempDir(t, "kit-schema-owner-");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "migrations"), { recursive: true });
    const source = join(root, "vendor/kit/packages/cloudflare/migrations");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(root, "wrangler.toml"),
      'name = "saasreport"\nmain = "src/worker.js"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "saasreport"\ndatabase_id = "saasreport-id"\nmigrations_dir = "migrations"\n');
    writeFileSync(join(root, "src/worker.js"), 'import { createKit } from "@saasreport/cloudflare";\n');
    writeFileSync(join(source, "0001_posts_events.sql"), "CREATE TABLE IF NOT EXISTS posts (id TEXT);\n");
    writeFileSync(join(source, "0008_podcast_provenance.sql"),
      "ALTER TABLE podcast_episodes ADD COLUMN provenance_json TEXT;\n");
    writeFileSync(join(source, "0009_podcast_provenance_triggers.sql"),
      "DROP TRIGGER IF EXISTS podcast_provenance_insert;\n");
    if (withPodcast) {
      writeFileSync(join(root, "podcast.config.json"), JSON.stringify({ provenance: { required: true, origins: ["cron", "legacy"] } }));
      writeFileSync(join(root, "migrations/0001_base.sql"),
        "CREATE TABLE podcast_episodes (id TEXT PRIMARY KEY, provenance_json TEXT);\n");
      writeFileSync(join(root, "podcast.migrations.lock.json"), JSON.stringify({ files: {} }));
    }
    return root;
  };
  const root = setup(true);
  const out = syncEngineMigrations(root, {}, { write: true });
  assert.deepEqual(out.written, ["migrations/0002_cloudflare_posts_events.sql"],
    "the D1 schema receives the static Kit engine DDL, not a duplicate ALTER TABLE or stale dynamic trigger");
  assert.deepEqual(engineMigrationProblems(root), [], "no static engine migration remains missing");
  assert.ok(!readdirSync(join(root, "migrations")).some((f) => /cloudflare_podcast_provenance/.test(f)));
  const plain = setup(false);
  assert.equal(syncEngineMigrations(plain, {}, { write: true }).written.length, 3,
    "non-podcast projects still receive all declared Kit engine SQL; skip is scoped to project-owned provenance");
});


test("SQL-identical App locale migration has one schema owner despite different documentation and file numbers", (t) => {
  const root = tempDir(t, "kit-sql-identical-");
  mkdirSync(join(root, "src"), { recursive: true });
  const source = join(root, "vendor/kit/packages/cloudflare/migrations");
  mkdirSync(source, { recursive: true }); mkdirSync(join(root, "migrations"), { recursive: true });
  writeFileSync(join(root, "src/worker.js"), 'import { createKit } from "@saasreport/cloudflare";\n');
  writeFileSync(join(root, "wrangler.toml"),
    'name="site"\nmain="src/worker.js"\n[[d1_databases]]\nbinding="DB"\ndatabase_name="site"\ndatabase_id="site-id"\nmigrations_dir="migrations"\n');
  const ddl = "ALTER TABLE posts ADD COLUMN locale TEXT NOT NULL DEFAULT '';\n" +
    "CREATE INDEX IF NOT EXISTS posts_locale ON posts (locale);\n";
  writeFileSync(join(source, "0006_locale.sql"), "-- Kit's historical header\n" + ddl);
  writeFileSync(join(root, "migrations/0008_locale.sql"), "-- App's reviewed historical header differs\n" + ddl);
  assert.deepEqual(engineMigrationProblems(root), [], "identical statements are not migrated a second time");
  assert.deepEqual(syncEngineMigrations(root, {}, { write: true }).written, [],
    "an immutable locale ALTER TABLE is not replayed");
  writeFileSync(join(root, "migrations/0008_locale.sql"),
    "-- Header still differs\nALTER TABLE posts ADD COLUMN other TEXT NOT NULL DEFAULT '';\n" +
    "CREATE INDEX IF NOT EXISTS posts_locale ON posts (other);\n");
  assert.match(engineMigrationProblems(root).map((x) => x.problem).join("\n"), /0006_locale\.sql/,
    "same names with different SQL are NOT declared equivalent");
});
