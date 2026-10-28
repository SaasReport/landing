/**
 * Finding class `engine-migrations-present` (part of `kit check migrations`) and `kit migrations sync`.
 *
 * Root cause (Codex on app#54, 2026-10-14): a site's comms Worker runs the vendored comms engine, which relies on a partial UNIQUE index that a
 * kit migration creates (comms 0002), but the Worker's D1 binding points at the PROJECT's migrations directory, which held only 0001. Nothing said
 * the engine's schema was missing, so concurrent dispatches with one key both inserted. A vendored engine and its schema travel together: a
 * Worker that runs an engine of a kit package (comms, monitor, the site runtime, uploads, broker) must have every migration of that package in a
 * migrations directory one of its D1 bindings applies, byte for byte (applied migrations are append-only, so a copy is a new numbered file).
 *
 *   engineMigrationProblems(root, canon) → [{ file, problem }]   one per missing migration
 *   syncEngineMigrations(root, canon, { write }) → { missing: [{ config, package, source, into }], written: [path] }
 *       copies each missing migration into the directory of the first D1 binding of that Worker, as the next number, named
 *       <n>_<package>_<name>.sql; it never edits or renames an existing file.
 *
 * An engine is recognised by the Worker's entry (wrangler `main`): its source imports `@saasreport/<package>` or a path through packages/<package>/.
 * The package's migrations are found in the kit's own tree, the vendored snapshot (kit.canon.json vendor.path) or node_modules/@saasreport.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import { readWranglerConfig } from "./wrangler-config.js";
import { deployScan } from "./canon/facts.js";
import { migrationOrder } from "./d1-local.js";
import { vendorRoots } from "./vendor-path.js";

// Schema ownership follows ENGINE entrypoints, never a package prefix. A monitor or comms Worker may import
// @saasreport/cloudflare/build only to expose /api/build: that utility owns no site database tables. Treating it as
// the whole cloudflare engine demanded 11 unrelated site migrations in each other Worker's D1 and could
// accidentally replay CREATE TABLE statements against an existing production database.
const IMPORT_SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
const ENGINE_ENTRYPOINTS = new Set(["", "index", "engine", "worker", "kit", "runtime"]);

/** Engine packages whose schemas this worker owns, not stateless helpers imported by the worker. */
export function enginePackages(source) {
  const packages = new Set();
  for (const m of String(source).matchAll(IMPORT_SPECIFIER)) {
    const spec = m[1];
    let pkg, entry;
    const named = /^@saasreport\/([a-z-]+)(?:\/(.*))?$/.exec(spec);
    if (named) {
      pkg = named[1];
      entry = named[2] || "";
    } else {
      const physical = /(?:^|\/)packages\/([a-z-]+)\/(?:src\/)?(.+)$/.exec(spec);
      if (!physical) continue;
      pkg = physical[1];
      entry = physical[2].replace(/\.m?js$/, "");
    }
    // Vendored Worker entrypoints may sit below a nested engine directory (e.g.
    // packages/comms/workers/comms-engine/engine.js). They still own schema; leaf helpers
    // such as packages/cloudflare/src/build.js and /health.js never do.
    const leaf = entry.split("/").at(-1);
    if (ENGINE_ENTRYPOINTS.has(entry) || (entry.includes("/") && ENGINE_ENTRYPOINTS.has(leaf))) packages.add(pkg);
  }
  return packages;
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
const sqlIn = (dir) => (existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir).filter((f) => f.endsWith(".sql")).sort(migrationOrder) : []);

/** The migrations of a kit package, as { name, abs } in order, or [] when the package ships none or is not found. */
function packageMigrations(root, canon, pkg) {
  const snapshot = vendorRoots(canon.vendor).snapshot;
  for (const base of [`packages/${pkg}`, `${snapshot}/packages/${pkg}`, `node_modules/@saasreport/${pkg}`]) {
    const dir = resolve(root, base, "migrations");
    if (sqlIn(dir).length) return sqlIn(dir).map((name) => ({ name, abs: join(dir, name) }));
  }
  return [];
}

/** A migrations_dir as wrangler would find it: from the config's directory, a node_modules path also in any directory above it up to the root (hoisted installs). */
function hoisted(root, base, dir) {
  for (let at = base; ; at = resolve(at, "..")) {
    if (existsSync(resolve(at, dir))) return resolve(at, dir);
    if (!/(^|\/)node_modules\//.test(dir) || at === root || at === resolve(at, "..")) return resolve(base, dir);
  }
}

/** Every (config, package, directory of each of its D1 bindings) the repository deploys: the engines its Workers run. */
function engines(root, canon) {
  const out = [];
  for (const file of deployScan(root, canon).all) {
    let cfg;
    try { cfg = readWranglerConfig(root, file); } catch { continue; /* an unreadable config is reported by the resilience check, which reads the same files */ }
    const base = resolve(root, file, "..");
    for (const [env, facts] of Object.entries(cfg.envs)) {
      if (!facts.main || !facts.d1.length) continue;
      const main = resolve(base, facts.main);
      if (!existsSync(main) || !statSync(main).isFile()) continue;
      const pkgs = new Set();
      for (const pkg of enginePackages(readFileSync(main, "utf8"))) pkgs.add(pkg);
      for (const pkg of pkgs) {
        const migrations = packageMigrations(root, canon, pkg);
        if (!migrations.length) continue;
        out.push({ config: file, env, pkg, migrations, dirs: facts.d1.map((d) => ({ binding: d.binding, abs: hoisted(root, base, d.migrations || "migrations") })) });
      }
    }
  }
  return out;
}

const bytesIn = (dirs) => new Set(dirs.flatMap((d) => sqlIn(d.abs).map((f) => sha(readFileSync(join(d.abs, f))))));
/** A static migration may already have been applied under a PROJECT-owned
 * number and an alternate prose-only header (e.g. a site locale 0008 vs Kit
 * cloudflare locale 0006). It must NOT run again: SQLite ADD COLUMN is not
 * idempotent. Only exactly identical SQL lines after dropping whole-line
 * documentation comments are equivalent. Different statements, inline
 * comments, ordering or literals remain different and require governance.
 * This is stricter than SQL AST or object-name heuristics, and the D1 fresh
 * migration check remains independent. */
const executableSQL = (bytes) => String(bytes).split(/\r?\n/u)
  .filter((line) => !/^\s*--/.test(line))
  .map((line) => line.trim()).filter(Boolean).join("\n");
const statementsIn = (dirs) => new Set(dirs.flatMap((d) => sqlIn(d.abs)
  .map((f) => sha(executableSQL(readFileSync(join(d.abs, f), "utf8"))))));

const samePlace = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return false; /* a missing directory is the same as no directory: nothing is applied from it */ } };

function missingOf(root, canon) {
  const out = [];
  for (const e of engines(root, canon)) {
    const have = bytesIn(e.dirs);
    const haveSQL = statementsIn(e.dirs);
    const pkgDir = resolve(e.migrations[0].abs, "..");
    if (e.dirs.some((d) => samePlace(d.abs, pkgDir))) continue;   // a binding that applies the package's own directory has all of it by construction
    for (const m of e.migrations) {
      // Podcast provenance is a PROJECT-GENERATED schema, unlike the cloudflare
      // package's static tables. Its origin allow-list comes from the project's
      // podcast.config.json and its historical SQL is already append-only and
      // protected by podcast.migrations.lock.json. Replaying the package's
      // historical 0008 ALTER TABLE ADD COLUMN into that SAME DB would fail with
      // duplicate column (or damage an already applied migration). The separate
      // kit podcast migrate + check podcast gates are its schema authority.
      // Never copy outdated Kit provenance baseline/triggers into a project
      // which has declared that governed provenance lifecycle.
      if (e.pkg === "cloudflare" &&
          /^\d+_podcast_provenance(?:_triggers)?\.sql$/.test(m.name) &&
          existsSync(join(root, "podcast.config.json"))) continue;
      const migrationSQL = readFileSync(m.abs, "utf8");
      if (!have.has(sha(migrationSQL)) && !haveSQL.has(sha(executableSQL(migrationSQL))))
        out.push({ config: e.config, env: e.env, package: e.pkg, source: relative(root, m.abs).split(sep).join("/"), name: m.name, abs: m.abs, dir: e.dirs[0] });
    }
  }
  return out;
}

export function engineMigrationProblems(root, canon = {}) {
  return missingOf(root, canon).map((m) => ({ file: m.config, problem: `engine-migrations-present: this Worker runs the ${m.package} engine of the kit, but no D1 binding of it applies ${m.source} (${m.name}), byte for byte: the schema the engine relies on would be missing in production. Run \`kit migrations sync\` (it appends the file to ${relative(root, m.dir.abs).split(sep).join("/") || "."}, never edits an existing one)` }));
}

export function syncEngineMigrations(root, canon = {}, { write = true } = {}) {
  // The same migrations directory may be attached by multiple Workers and by [env.*] bindings.
  // missingOf is per consumer, but a SQL migration is applied per DIRECTORY: copying twice makes
  // CREATE/ALTER statements fail on D1. Key by resolved directory and the source's exact bytes.
  const pending = new Map(), nextByDir = new Map(), written = [];
  for (const m of missingOf(root, canon)) {
    const dir = existsSync(m.dir.abs) ? realpathSync(m.dir.abs) : resolve(m.dir.abs);
    const digest = sha(readFileSync(m.abs));
    const key = JSON.stringify([dir, digest]);
    if (!pending.has(key)) pending.set(key, m);
  }
  for (const m of pending.values()) {
    const dir = existsSync(m.dir.abs) ? realpathSync(m.dir.abs) : resolve(m.dir.abs);
    // Revalidate physical contents at write time, not just at initial discovery.
    if (bytesIn([m.dir]).has(sha(readFileSync(m.abs))) ||
        statementsIn([m.dir]).has(sha(executableSQL(readFileSync(m.abs, "utf8"))))) continue;
    const number = (nextByDir.get(dir) ?? Math.max(0, ...sqlIn(m.dir.abs).map((f) => Number(/^(\d+)_/.exec(f)?.[1] || 0)))) + 1;
    nextByDir.set(dir, number);
    const into = join(m.dir.abs, `${String(number).padStart(4, "0")}_${m.package}_${m.name.replace(/^\d+_/, "")}`);
    if (write) { mkdirSync(m.dir.abs, { recursive: true }); copyFileSync(m.abs, into); }
    written.push(relative(root, into).split(sep).join("/"));
  }
  return { missing: [...pending.values()].map(({ config, package: pkg, source }) => ({ config, package: pkg, source })), written };
}
