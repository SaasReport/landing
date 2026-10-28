/**
 * Append-only provenance migrations. A D1 migration that was applied is never run again, so editing it changes nothing in production
 * while a local check would pass: the files are therefore immutable. `migrate` only ever ADDS a numbered file (the first one carries the
 * column; every later one drops and recreates the triggers), and podcast.migrations.lock.json (the ledger) holds each file's sha256, so
 * `kit check podcast` fails when a committed migration changes, is deleted, or a provenance migration is missing from the ledger.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoSnapshotRoots } from "./vendor-path.js";
import { migrationOrder } from "@saasreport/core/migration-order";
import { provenanceMigrationSql, provenanceTriggersSql } from "@saasreport/core/podcast-provenance-sql";

export const LEDGER = "podcast.migrations.lock.json";
const IS_PROV = /_podcast_provenance(_triggers)?\.sql$/;
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export const migrationFiles = (root) => (existsSync(join(root, "migrations")) ? readdirSync(join(root, "migrations")).sort(migrationOrder) : []);
export const provenanceFiles = (root) => migrationFiles(root).filter((f) => IS_PROV.test(f));
export const readLedger = (root) => (existsSync(join(root, LEDGER)) ? JSON.parse(readFileSync(join(root, LEDGER), "utf8")) : null);
const writeLedger = (root, files) => writeFileSync(join(root, LEDGER), `${JSON.stringify({ description: "sha256 of every podcast provenance migration (kit podcast migrate). Applied migrations are never edited: a changed hash fails kit check podcast.", files }, null, 2)}\n`);
const nextNumber = (root) => String(Math.max(0, ...migrationFiles(root).map((f) => Number(/^(\d+)_/.exec(f)?.[1] || 0))) + 1).padStart(4, "0");

/** What the newest provenance migration should contain for these origins ("" when there is none yet). */
export function expectedFor(root, origins) {
  const files = provenanceFiles(root);
  if (!files.length) return { kind: "first", sql: provenanceMigrationSql({ origins }) };
  const latest = files[files.length - 1];
  return /_triggers\.sql$/.test(latest) ? { kind: "triggers", file: latest, sql: provenanceTriggersSql({ origins }) } : { kind: "base", file: latest, sql: provenanceMigrationSql({ origins }) };
}

/** Problems with the migrations and the ledger, and with the newest file against the generator. */
export function migrationProblems(root, origins) {
  const problems = [], files = provenanceFiles(root), ledger = readLedger(root);
  if (!files.length && !ledger) return ["no *_podcast_provenance.sql: run `kit podcast migrate` (the database would accept an episode without provenance)"];
  if (!ledger) return [`${LEDGER} is missing: run \`kit podcast migrate\` once to record the migrations that exist`];
  for (const [f, hash] of Object.entries(ledger.files || {})) {
    if (!existsSync(join(root, "migrations", f))) problems.push(`migrations/${f}: listed in ${LEDGER} but missing (an applied migration is never deleted)`);
    else if (sha256(readFileSync(join(root, "migrations", f), "utf8")) !== hash) problems.push(`migrations/${f}: changed since it was committed (migrations are append-only: an applied one is never re-run; revert it and run \`kit podcast migrate\`, which adds a NEW numbered migration)`);
  }
  for (const f of files) if (!ledger.files?.[f]) problems.push(`migrations/${f}: not in ${LEDGER} (only \`kit podcast migrate\` adds provenance migrations)`);
  if (!files.length) return problems;
  if (!/ADD COLUMN provenance_json/.test(readFileSync(join(root, "migrations", files.find((f) => !/_triggers\.sql$/.test(f)) || files[0]), "utf8"))) problems.push("no provenance migration adds the provenance_json column");
  const want = expectedFor(root, origins);
  if (want.file && readFileSync(join(root, "migrations", want.file), "utf8") !== want.sql) problems.push(`migrations/${want.file}: the newest provenance migration is not what the generator makes from kit.podcast-provenance.v1 and podcast.config.json provenance.origins: run \`kit podcast migrate\` (it writes a NEW numbered migration; the old one stays untouched)`);
  return problems;
}

/** Only an EXACT provenance migration copied by the verified Kit engine-sync is
 * eligible for adoption into an EXISTING podcast ledger. A freehand SQL file
 * remains an immutable-ledger violation. A package migration's bytes are
 * compared to the authoritative bundled, vendored or installed source and the
 * prefix proves its source and intent; any mismatch fails closed. */
function exactEngineProvenance(root, file) {
  if (!/^\d+_cloudflare_podcast_provenance(?:_triggers)?\.sql$/.test(file)) return false;
  const actual = readFileSync(join(root, "migrations", file));
  const bases = ["packages/cloudflare", ...repoSnapshotRoots(root).map((r) => `${r.snapshot}/packages/cloudflare`),
    "node_modules/@saasreport/cloudflare"];
  for (const base of bases) {
    const dir = join(root, base, "migrations");
    if (!existsSync(dir)) continue;
    for (const source of readdirSync(dir).filter((f) => /^\d+_podcast_provenance(?:_triggers)?\.sql$/.test(f))) {
      if (readFileSync(join(dir, source)).equals(actual)) return true;
    }
  }
  return false;
}

/** A trigger migration duplicated by an interrupted generator already has
 * independently trusted, byte-identical provenance in this exact ledger. It
 * is safe to adopt its existing bytes (never edit or re-run them here); unlike
 * an ADD COLUMN base migration, DROP/CREATE triggers are repeatable. This is
 * the only project-owned adoption path without the Kit package prefix.
 * Mutated, arbitrary or duplicate base SQL remains forbidden.
 */
function exactTrackedTrigger(root, name, ledger) {
  if (!/^\d+_podcast_provenance_triggers\.sql$/.test(name)) return false;
  const actual = sha256(readFileSync(join(root, "migrations", name), "utf8"));
  return Object.entries(ledger.files || {}).some(([prior, expected]) =>
    prior !== name && /^\d+_podcast_provenance_triggers\.sql$/.test(prior) &&
    expected === actual);
}

/** Adds what is needed and never touches an existing file: → { created: string|null, adopted: string[] }. */
export function migrate(root, origins) {
  mkdirSync(join(root, "migrations"), { recursive: true });
  const existing = provenanceFiles(root);
  let ledger = readLedger(root);
  const adopted = [];
  if (!ledger) {   // first run: record the migrations that exist as they are (the baseline)
    ledger = { files: Object.fromEntries(existing.map((f) => [f, sha256(readFileSync(join(root, "migrations", f), "utf8"))])) };
    adopted.push(...existing);
  } else {
    // kit migrations sync may append byte-identical package provenance SQL to
    // this same D1 folder. Reconcile those verified Kit-owned files into the
    // podcast lock before generating the next current trigger migration.
    // Never silently adopt hand-written SQL or overlook a previously changed
    // lock entry: both would make an applied migration appear authentic.
    for (const [name, expected] of Object.entries(ledger.files || {})) {
      const file = join(root, "migrations", name);
      if (!existsSync(file) || sha256(readFileSync(file, "utf8")) !== expected)
        throw new Error(`podcast provenance ledger: ${name} is missing or has changed; applied SQL is immutable`);
    }
    for (const name of existing) {
      if (Object.hasOwn(ledger.files, name)) continue;
      if (!exactEngineProvenance(root, name) && !exactTrackedTrigger(root, name, ledger))
        throw new Error(`podcast provenance ledger: untracked ${name} is not byte-identical to a trusted Kit cloudflare provenance migration or a previously locked generated trigger; refuse adoption`);
      ledger.files[name] = sha256(readFileSync(join(root, "migrations", name), "utf8"));
      adopted.push(name);
    }
  }
  const want = expectedFor(root, origins);
  let created = null;
  if (want.kind === "first") created = `${nextNumber(root)}_podcast_provenance.sql`;
  else if (readFileSync(join(root, "migrations", want.file), "utf8") !== want.sql) created = `${nextNumber(root)}_podcast_provenance_triggers.sql`;
  if (created) {
    const sql = want.kind === "first" ? want.sql : provenanceTriggersSql({ origins });
    writeFileSync(join(root, "migrations", created), sql);
    ledger.files[created] = sha256(sql);
  }
  writeLedger(root, Object.fromEntries(Object.entries(ledger.files).sort()));
  return { created, adopted };
}
