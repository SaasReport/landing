/**
 * Where UploadRecords live. A sink is
 *   put(record) → stored record          a record without a version is CREATED (version 1; an existing id is a ConflictError); a record
 *                                        with one is UPDATED only if the stored version is the same and the stored record is not a
 *                                        deleted tombstone (final): compare-and-set, so a write made from a stale read cannot revive
 *                                        or overwrite anything. The stored record (version + 1) is returned.
 *   get(id)
 *   listExpired(nowIso, { limit, after })   settled records past retain_until and not on hold, ORDER BY upload_id, paged by `after`
 *   listInFlight(beforeIso, { limit, after })   records with an operation older than beforeIso (pending intakes included)
 *   list({ after, limit })                  every record, ORDER BY upload_id
 *   referencing(key, { excludeId })         live records (not deleted, not excludeId) that still use this object key
 * `d1Records(db)` writes to D1 (migrations/0001_upload_records.sql); `memoryRecords()` is the in-memory twin for tests.
 */
import { validateRecord } from "./schemas.js";
import { hasShape, isLowerAlpha, isDigit } from "./lex.js";
import { ConflictError } from "./errors.js";
import { SWEEP_STAGES } from "./lifecycle.js";

export class RecordError extends Error { constructor(problems) { super(`upload record invalid: ${problems.slice(0, 3).join("; ")}`); this.problems = problems; } }
const assertValid = (r) => { const p = validateRecord(r); if (p.length) throw new RecordError(p); };

/** Stages the retention sweep may delete: the lifecycle table's `sweepable` states (lifecycle.json: the one definition), settled, with no operation in flight. */
const sweepable = (r) => SWEEP_STAGES.includes(r.stage) && !r.op;
const SWEEP_SQL = SWEEP_STAGES.map((s) => `'${s}'`).join(", ");

export function memoryRecords() {
  const map = new Map();
  const ordered = () => [...map.keys()].sort();
  return {
    map,
    async put(r) {
      const cur = map.get(r.upload_id);
      if (r.version === undefined) {
        if (cur) throw new ConflictError(`upload ${r.upload_id} already exists`, r.upload_id);
        const stored = { ...structuredClone(r), version: 1 };
        assertValid(stored); map.set(r.upload_id, stored); return structuredClone(stored);
      }
      if (!cur) throw new ConflictError(`upload ${r.upload_id} does not exist`, r.upload_id);
      if (cur.stage === "deleted") throw new ConflictError(`upload ${r.upload_id} is a deleted tombstone: final`, r.upload_id);
      if (cur.version !== r.version) throw new ConflictError(`upload ${r.upload_id} changed (version ${cur.version}, write was made from ${r.version})`, r.upload_id);
      const stored = { ...structuredClone(r), version: r.version + 1 };
      assertValid(stored); map.set(r.upload_id, stored); return structuredClone(stored);
    },
    async get(id) { const r = map.get(id); return r ? structuredClone(r) : null; },
    async listExpired(nowIso, { limit = 100, after = null } = {}) { return ordered().filter((id) => !after || id > after).map((id) => map.get(id)).filter((r) => sweepable(r) && !r.retention.hold && r.retention.retain_until <= nowIso).slice(0, limit).map((r) => structuredClone(r)); },
    async listInFlight(beforeIso, { limit = 100, after = null } = {}) { return ordered().filter((id) => !after || id > after).map((id) => map.get(id)).filter((r) => r.op && r.stage !== "deleted" && r.op.started_at <= beforeIso).slice(0, limit).map((r) => structuredClone(r)); },
    async list({ after = null, limit = 500 } = {}) { return ordered().filter((id) => !after || id > after).slice(0, limit).map((id) => structuredClone(map.get(id))); },
    async referencing(key, { excludeId = null } = {}) { return [...map.values()].filter((r) => r.stage !== "deleted" && r.upload_id !== excludeId && (r.storage.key === key || r.storage.released_key === key)).length; },
  };
}

/** D1 sink. `table` comes from config (storage.records.table); the name is validated, never interpolated from input. */
export function d1Records(db, { table = "upload_records" } = {}) {
  if (!hasShape(table, isLowerAlpha, (c) => isLowerAlpha(c) || isDigit(c) || c === 95, { min: 1, max: 39 })) throw new Error("records table name must be lowercase letters, digits and underscores");
  // the version is the column's: a row written before migration 0002 has no version in its record_json
  const parse = (row) => (row ? { ...JSON.parse(row.record_json), version: row.version ?? 1 } : null);
  const cols = (r) => [r.project, r.form, r.sha256, r.stage, r.verdict, r.storage.bucket, r.storage.key, r.storage.released_bucket ?? null, r.storage.released_key ?? null, r.retention.retain_until, r.retention.hold ? 1 : 0, r.received_at, r.op?.started_at ?? null];
  return {
    async put(r) {
      if (r.version === undefined) {
        const stored = { ...r, version: 1 };
        assertValid(stored);
        try {
          await db.prepare(`INSERT INTO ${table} (upload_id, version, project, form, sha256, stage, verdict, bucket, key, released_bucket, released_key, retain_until, hold, received_at, op_started, record_json)
            VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(r.upload_id, ...cols(r), JSON.stringify(stored)).run();
        } catch (e) { throw new ConflictError(`upload ${r.upload_id} could not be created: ${String(e?.message || e).slice(0, 80)}`, r.upload_id); }
        return stored;
      }
      const stored = { ...r, version: r.version + 1 };
      assertValid(stored);
      const res = await db.prepare(`UPDATE ${table} SET version = ?, stage = ?, verdict = ?, bucket = ?, key = ?, released_bucket = ?, released_key = ?, retain_until = ?, hold = ?, op_started = ?, record_json = ?
        WHERE upload_id = ? AND version = ? AND stage != 'deleted'`)
        .bind(stored.version, r.stage, r.verdict, r.storage.bucket, r.storage.key, r.storage.released_bucket ?? null, r.storage.released_key ?? null, r.retention.retain_until, r.retention.hold ? 1 : 0, r.op?.started_at ?? null, JSON.stringify(stored), r.upload_id, r.version).run();
      if ((res?.meta?.changes ?? 0) !== 1) throw new ConflictError(`upload ${r.upload_id} changed since it was read (or is a deleted tombstone): the write was refused`, r.upload_id);
      return stored;
    },
    async get(id) { return parse(await db.prepare(`SELECT record_json, version FROM ${table} WHERE upload_id = ?`).bind(id).first()); },
    async listExpired(nowIso, { limit = 100, after = null } = {}) {
      const { results } = await db.prepare(`SELECT record_json, version FROM ${table} WHERE stage IN (${SWEEP_SQL}) AND op_started IS NULL AND hold = 0 AND retain_until <= ? AND upload_id > ? ORDER BY upload_id LIMIT ?`).bind(nowIso, after ?? "", limit).all();
      return (results || []).map(parse);
    },
    async listInFlight(beforeIso, { limit = 100, after = null } = {}) {
      const { results } = await db.prepare(`SELECT record_json, version FROM ${table} WHERE op_started IS NOT NULL AND stage != 'deleted' AND op_started <= ? AND upload_id > ? ORDER BY upload_id LIMIT ?`).bind(beforeIso, after ?? "", limit).all();
      return (results || []).map(parse);
    },
    async list({ after = null, limit = 500 } = {}) {
      const { results } = await db.prepare(`SELECT record_json, version FROM ${table} WHERE upload_id > ? ORDER BY upload_id LIMIT ?`).bind(after ?? "", limit).all();
      return (results || []).map(parse);
    },
    /** How many live (not deleted) records other than `excludeId` still use this object key. */
    async referencing(key, { excludeId = null } = {}) {
      const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE stage != 'deleted' AND upload_id != ? AND (key = ? OR released_key = ?)`).bind(excludeId ?? "", key, key).first();
      return Number(row?.n ?? 0);
    },
  };
}

/** Migration 0001 as it shipped (the table before records had a version): never edited, so a database that ran it is not diverged from the file. */
export const recordsMigration = (table = "upload_records") => `CREATE TABLE IF NOT EXISTS ${table} (
  upload_id TEXT PRIMARY KEY, project TEXT NOT NULL, form TEXT NOT NULL, sha256 TEXT NOT NULL, stage TEXT NOT NULL, verdict TEXT NOT NULL,
  bucket TEXT NOT NULL, key TEXT NOT NULL, released_bucket TEXT, released_key TEXT, retain_until TEXT NOT NULL, hold INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL, record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ${table}_retention ON ${table} (stage, retain_until);
CREATE INDEX IF NOT EXISTS ${table}_object ON ${table} (bucket, key);
`;
/**
 * Migration 0002: the version (compare-and-set) and the operation clock. Existing rows get version 1; their record_json has no version, so the
 * sink takes the version from the COLUMN on every read. The released-object index serves the "does any live record still use this key" check.
 */
export const recordsMigration0002 = (table = "upload_records") => `ALTER TABLE ${table} ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ${table} ADD COLUMN op_started TEXT;
CREATE INDEX IF NOT EXISTS ${table}_inflight ON ${table} (op_started);
CREATE INDEX IF NOT EXISTS ${table}_released_object ON ${table} (released_bucket, released_key);
CREATE INDEX IF NOT EXISTS ${table}_key ON ${table} (key);
`;
export const MIGRATION_FILES = Object.freeze({ "0001_upload_records.sql": recordsMigration, "0002_upload_records_version.sql": recordsMigration0002 });
