-- UploadRecords, migration 0002: the version (compare-and-set) and the operation clock. Generated from MIGRATION_FILES in src/records.js;
-- never edited once applied: a change is a new numbered file.
ALTER TABLE upload_records ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE upload_records ADD COLUMN op_started TEXT;
CREATE INDEX IF NOT EXISTS upload_records_inflight ON upload_records (op_started);
CREATE INDEX IF NOT EXISTS upload_records_released_object ON upload_records (released_bucket, released_key);
CREATE INDEX IF NOT EXISTS upload_records_key ON upload_records (key);
