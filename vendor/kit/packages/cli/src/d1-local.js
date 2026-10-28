import { migrationTransportSQL } from "./migration-transport.js";
/**
 * The kit's one local D1: SQLite (node:sqlite, bundled with Node, no network) behind @saasreport/core/d1-limits, so it refuses what
 * Cloudflare D1 refuses (a LIKE or GLOB pattern over 50 bytes, statements over 100 kB, more than 100 bound parameters, values over 2 MB).
 * Two consumers, one engine: `kit check migrations` (migrations-d1.js) and `kit podcast drill` (podcast-drill.js).
 *
 *   openD1()                     → { sqlite, binding }   a fresh in-memory database; `binding` has D1's prepare/bind/first/all/run/raw, batch and exec
 *   migrationDirs(root, canon)   → { dirs: [{ dir, files, bindings: [{ config, env, binding }] }], missing: [binding + dir] }   every directory of *.sql migrations the repository
 *                                  owns or applies: those a wrangler D1 binding names (migrations_dir, default "migrations", relative to its
 *                                  config) and every other migrations/ directory of the repository itself, each once (by real path)
 *   applyMigrations(sqlite, files) → problems [{ file, statement, ordinal, problem }]   one atomic D1 transaction per migration file, stopping at the first
 *                                  rejection (the later files depend on the earlier ones)
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { D1_LIMITS, PATTERN_TOO_COMPLEX, commentProblems, isEmptyStatement, patternOperands, patternProblems, sqlStatements, withD1Limits } from "@saasreport/core/d1-limits";
import { migrationOrder } from "@saasreport/core/migration-order";
import { readWranglerConfig } from "./wrangler-config.js";
import { deployScan } from "./canon/facts.js";

/** node:sqlite is Node 22.5+: absent means the check cannot run, which is a failure, never a pass. */
function sqliteModule() {
  try { return createRequire(import.meta.url)("node:sqlite"); } catch (e) { throw new Error(`node:sqlite is not available (${e.message}): the D1 engine needs Node 22.5 or newer`); }
}

/** D1's binding API over a node:sqlite database (the shape the Workers code calls). */
export function d1Binding(db) {
  const conv = (args) => args.map((v, i) => {
    if (v === undefined) throw new Error(`D1_TYPE_ERROR: undefined bound at position ${i + 1}`);
    return typeof v === "boolean" ? (v ? 1 : 0) : v;
  });
  const log = [];
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, conv(a)),
    first: async (col) => { log.push(sql); const r = db.prepare(sql).get(...args); const o = r ? { ...r } : null; return col ? o?.[col] ?? null : o; },
    all: async () => { log.push(sql); return { success: true, results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }; },
    run: async () => { log.push(sql); const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    raw: async () => db.prepare(sql).all(...args).map((r) => Object.values(r)),
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; }, exec: async (sql) => db.exec(sql), sqlite: db, log };
}

/** A fresh in-memory D1: { sqlite, binding }. */
export function openD1() {
  const { DatabaseSync } = sqliteModule();
  const sqlite = withD1Limits(new DatabaseSync(":memory:"));
  return { sqlite, binding: d1Binding(sqlite) };
}

const SKIP = new Set([".git", "node_modules", ".wrangler", "dist", ".cache", "findings"]);
export { migrationOrder };
const sqlFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith(".sql") && statSync(join(dir, f)).isFile()).sort(migrationOrder);

function walkDirs(root, rel = "", out = []) {
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (!e.isDirectory() || SKIP.has(e.name) || e.name === "fixtures" || e.name === "fixture") continue;
    const next = rel ? `${rel}/${e.name}` : e.name;
    if (e.name === "migrations") out.push(next);
    walkDirs(root, next, out);
  }
  return out;
}

/**
 * The migration directories of a repository, each once. A directory enters by a wrangler D1 binding (any config, any [env.*], found by content
 * by the kit's one reader) or by being a `migrations/` directory of the repository's own tree (the kit's packages ship theirs for the sites
 * to apply). `vendor/` is the kit's snapshot: its directories count when a binding names them, not on their own (they are the kit's, checked in the kit).
 */
export function migrationDirs(root, canon = {}) {
  const byReal = new Map(), missing = [];
  const add = (abs, binding = null) => {
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return false;
    const files = sqlFiles(abs);
    if (!files.length) return true;
    const real = realpathSync(abs);
    const entry = byReal.get(real) || { dir: relative(root, abs).split(sep).join("/"), real, files: files.map((f) => join(abs, f)), bindings: [] };
    if (binding) entry.bindings.push(binding);
    byReal.set(real, entry);
    return true;
  };
  // wrangler resolves migrations_dir from the config's directory; a node_modules path is found the way Node finds a package, in the config's
  // directory or any directory above it, up to the repository root (the kit's own examples bind node_modules/@saasreport/cloudflare/migrations, hoisted to the root)
  const find = (base, dir) => {
    for (let at = base; ; at = resolve(at, "..")) {
      if (existsSync(resolve(at, dir))) return resolve(at, dir);
      if (at === root || at === resolve(at, "..") || !at.startsWith(root)) return null;
      if (!/(^|\/)node_modules\//.test(dir)) return null;
    }
  };
  const deployed = deployScan(root, canon);
  for (const file of deployed.all) {
    let cfg;
    try { cfg = readWranglerConfig(root, file); } catch { continue; /* an unreadable config is reported by the resilience check, which reads the same files */ }
    const base = resolve(root, file, "..");
    for (const [env, facts] of Object.entries(cfg.envs)) for (const d of facts.d1) {
      const dir = d.migrations || "migrations";
      const abs = find(base, dir);
      const binding = { config: file, env, binding: d.binding };
      if ((!abs || !add(abs, binding)) && d.migrations) missing.push({ ...binding, dir });   // only a directory the binding NAMES must exist: a binding without one (the default "migrations") may share a database another Worker migrates
    }
  }
  for (const rel of walkDirs(root)) if (!rel.startsWith("vendor/") && rel !== ".kit" && !rel.startsWith(".kit/")) add(join(root, rel));
  return { dirs: [...byReal.values()].sort((a, b) => a.dir.localeCompare(b.dir)), missing };
}

/** sha256 of the kit-shipped migrations applied before the comment rule (2026-10-14); immutable, so judged by their bytes, never by name. */
const LEGACY = new Set(Object.keys(JSON.parse(readFileSync(new URL("../../core/registry/legacy-migration-comments.json", import.meta.url), "utf8")).files));

const excerpt = (s) => s.replace(/\s+/g, " ").trim().slice(0, 160);
const DEFINES = /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+|UNIQUE\s+|VIRTUAL\s+)*(TABLE|TRIGGER|VIEW|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\.)?["`\[]?([\w$]+)/i;

/**
 * Apply files in order to a fresh D1 (openD1), statement by statement, and judge the schema they leave. → problems [{ file, ordinal, statement, problem }]
 *
 *  - a statement the engine rejects (SQLite's own error, or D1's limit: a statement over 100 kB, an INSERT/UPDATE/SELECT whose GLOB or LIKE
 *    pattern is over 50 bytes, more than 100 bound parameters) is a problem, and the run stops there (later files depend on earlier ones);
 *  - a trigger, view, index or table whose written GLOB or LIKE literal is over D1's limit is a problem too, whichever migration defined it.
 *    SQLite measures the pattern when the operator RUNS, so CREATE TRIGGER succeeds and the first row fails (the 2026-10-07 outage: every episode
 *    insert). It is judged on the FINAL schema, not on each statement: applied migrations are append-only, so a later migration that drops and
 *    recreates the object (kit 0011 after 0008..0010) is the fix, and the history that D1 already ran cannot be rewritten. An object that is
 *    still there with a pattern D1 refuses is what production would run.
 */
export function applyMigrations(sqlite, files, { root = "" } = {}) {
  const problems = [];
  const definedBy = new Map();     // "type name" -> { file, ordinal } of the statement that last created it
  for (const f of files) {
    const name = root ? relative(root, f).split(sep).join("/") : f;
    const sourceSQL = readFileSync(f, "utf8");
    const text = migrationTransportSQL(sourceSQL); // same executable tokens as canonical remote staging
    if (!LEGACY.has(createHash("sha256").update(sourceSQL).digest("hex"))) {
      for (const c of commentProblems(text)) problems.push({ file: name, ordinal: 0, statement: c.comment, problem: `line ${c.line}: a -- comment holds ${c.chars.map((x) => (x === ";" ? "a semicolon" : "an apostrophe")).join(" and ")}; remote D1 splits a migration at ; and chokes on quotes, even inside comments: ${c.comment.slice(0, 120)}` });
      if (problems.length) return problems;
    }
    // Remote D1 runs each migration in its own implicit transaction. Use the
    // native SQLite method ONLY for this internal boundary: the D1 limit wrapper
    // still refuses explicit transaction SQL supplied by a migration.
    const nativeExec = sqliteModule().DatabaseSync.prototype.exec;
    try { nativeExec.call(sqlite, "BEGIN"); } catch (e) {
      return [{ file: name, ordinal: 0, statement: "(implicit transaction)", problem: `cannot start migration transaction: ${e.message}` }];
    }
    const rollback = () => { try { nativeExec.call(sqlite, "ROLLBACK"); } catch { /* report original failure */ } };
    for (const [i, st] of sqlStatements(text).entries()) {
      const ordinal = i + 1;
      if (isEmptyStatement(st)) continue;   // only comments and semicolons (the one tokenizer decides): nothing for D1 to run
      // sqlStatements keeps the leading SQL comments. Schema definitions must be identified by
      // their first meaningful SQL token, or a commented CREATE TRIGGER is wrongly treated as
      // data and a later append-only migration cannot repair its historical oversized GLOB.
      const sqlHead = st.replace(/^(?:\s+|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)*/u, "");
      const m = DEFINES.exec(sqlHead);
      // a data statement runs once, here, and may run on no row at all (a DELETE on an empty table never evaluates its pattern), so its literal is read, not waited for
      if (!m) for (const p of patternProblems(st)) { problems.push({ file: name, ordinal, statement: excerpt(st), problem: `statement ${ordinal}: ${PATTERN_TOO_COMPLEX}: SQLITE_ERROR (D1 allows ${D1_LIMITS.likePatternBytes} bytes, this ${p.op} pattern is ${p.bytes}): ${excerpt(st)}` }); }
      // a pattern that is not a literal (a column, a call, an expression) cannot be shown to fit D1's limit from the text: refused wherever it is written
      for (const p of patternOperands(st)) if (!p.literal) problems.push({ file: name, ordinal, statement: excerpt(st), problem: `statement ${ordinal}: a ${p.op} pattern that is not a string literal cannot be shown to fit D1's ${D1_LIMITS.likePatternBytes}-byte limit (${PATTERN_TOO_COMPLEX}): write the pattern as a literal: ${excerpt(st)}` });
      if (problems.length) { rollback(); return problems; }
      try { sqlite.exec(st); } catch (e) {
        problems.push({ file: name, ordinal, statement: excerpt(st), problem: `statement ${ordinal} is rejected: ${String(e.message || e).split("\n")[0]}: ${excerpt(st)}` });
        rollback();
        return problems;
      }
      if (m) definedBy.set(`${m[1].toLowerCase()} ${m[2]}`, { file: name, ordinal });
    }
    // A deferred foreign-key failure may arise only at COMMIT. Never accept
    // a migration whose statements ran but whose transaction cannot commit.
    try { nativeExec.call(sqlite, "COMMIT"); } catch (e) {
      rollback();
      return [{ file: name, ordinal: sqlStatements(text).length, statement: "(implicit transaction commit)", problem: `migration commit is rejected: ${String(e.message || e).split("\n")[0]}` }];
    }
  }
  for (const o of sqlite.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid").all()) {
    for (const p of patternProblems(o.sql)) {
      const at = definedBy.get(`${o.type} ${o.name}`) || { file: "(schema)", ordinal: 0 };
      problems.push({ file: at.file, ordinal: at.ordinal, statement: excerpt(o.sql), problem: `statement ${at.ordinal} creates ${o.type} ${o.name}, which is still in the schema after the last migration with a ${p.op} pattern of ${p.bytes} bytes: ${PATTERN_TOO_COMPLEX}: SQLITE_ERROR (D1 allows ${D1_LIMITS.likePatternBytes} bytes; SQLite measures it when the ${p.op} runs, so the first row refused would fail in production): ${excerpt(o.sql)}` });
    }
  }
  return problems;
}
