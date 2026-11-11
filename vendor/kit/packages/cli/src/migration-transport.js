/**
 * The canonical remote-D1 migration transport. Historical, already-applied
 * SQL is immutable: we NEVER edit it or its filename. Wrangler's remote
 * migration parser may split semicolons / quotes in line comments incorrectly.
 * Project source remains byte-identical, while the temporary transport strips
 * ONLY unsafe line-comment text using the single SQL tokenizer.
 *
 * The executable SQL token stream is asserted byte-for-byte identical (type
 * and value), so code, string literals, and ordering cannot be rewritten.
 * Wrangler sees the original numbered basenames, preserving its D1 ledger.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commentProblems, tokenize } from "@saasreport/core/d1-limits";
import { migrationOrder } from "@saasreport/core/migration-order";

const signature = (sql) => JSON.stringify(tokenize(sql)
  .filter((x) => !["ws", "line", "block"].includes(x.t))
  .map(({ t, v }) => [t, v]));
const sha = (s) => createHash("sha256").update(s).digest("hex");

/** Exactly the SQL statements in source, without unsafe line-comment content. */
export function migrationTransportSQL(source) {
  const sql = String(source);
  const unsafe = tokenize(sql).filter((t) => t.t === "line" && /[;']/.test(t.v));
  if (!unsafe.length) return sql;
  let out = "", offset = 0;
  for (const t of unsafe) {
    out += sql.slice(offset, t.start) + "--"; // preserve the newline, line numbering, and SQL context
    offset = t.end;
  }
  out += sql.slice(offset);
  if (commentProblems(out).length || signature(sql) !== signature(out))
    throw new Error("migration transport changed executable SQL or left an unsafe line comment");
  return out;
}

/** Copy immutable numbered SQL into an isolated staging dir with source/transport hashes. */
export function stageD1Migrations(sourceDir, stageDir) {
  if (!existsSync(sourceDir)) throw new Error(`migrations directory missing: ${sourceDir}`);
  const files = readdirSync(sourceDir).filter((x) => x.endsWith(".sql")).sort(migrationOrder);
  if (!files.length) throw new Error(`migrations directory has no numbered SQL: ${sourceDir}`);
  mkdirSync(stageDir, { recursive: true });
  const evidence = [];
  for (const name of files) {
    const source = readFileSync(join(sourceDir, name), "utf8");
    const staged = migrationTransportSQL(source);
    writeFileSync(join(stageDir, name), staged, { flag: "wx" }); // never reuse previous stage
    evidence.push({ name, source_sha256: sha(source), transport_sha256: sha(staged),
      comments_normalized: source !== staged });
  }
  // The proof belongs outside the migrations folder; Wrangler reads only SQL.
  return { source_dir: sourceDir, staged_dir: stageDir, files: evidence,
    normalised: evidence.filter((x) => x.comments_normalized).length };
}
