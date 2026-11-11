-- UploadRecords (kit.upload-record.v1): one Evidence row per upload. Generated from recordsMigration("upload_records") in
-- src/records.js; a project with another table name (uploads.config.json storage.records.table) generates its own.
CREATE TABLE IF NOT EXISTS upload_records (
  upload_id TEXT PRIMARY KEY, project TEXT NOT NULL, form TEXT NOT NULL, sha256 TEXT NOT NULL, stage TEXT NOT NULL, verdict TEXT NOT NULL,
  bucket TEXT NOT NULL, key TEXT NOT NULL, released_bucket TEXT, released_key TEXT, retain_until TEXT NOT NULL, hold INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL, record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS upload_records_retention ON upload_records (stage, retain_until);
CREATE INDEX IF NOT EXISTS upload_records_object ON upload_records (bucket, key);
