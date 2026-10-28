-- The admin's own database (saasreport-admin-production): the append-only audit log, the lead state (status and note, kept here so the
-- admin never alters a table another Worker owns) and the idempotency records of the mutations.
-- The audit log has no update and no delete: three triggers refuse both, and a BEFORE INSERT guard refuses INSERT OR REPLACE over an
-- existing id or sequence (SQLite's REPLACE deletes the old row without firing the DELETE trigger while recursive_triggers is off).
CREATE TABLE IF NOT EXISTS admin_audit (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  id               TEXT NOT NULL UNIQUE,
  at               TEXT NOT NULL,
  actor_hash       TEXT NOT NULL CHECK (length(actor_hash) = 64),
  action           TEXT NOT NULL,
  outcome          TEXT NOT NULL CHECK (outcome IN ('done', 'attempted', 'failed', 'denied')),
  target_kind      TEXT NOT NULL,
  target_id        TEXT NOT NULL,
  detail_json      TEXT NOT NULL DEFAULT '{}',
  request_id       TEXT,
  idempotency_key  TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit(action, seq);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit(target_id, seq);

CREATE TRIGGER IF NOT EXISTS admin_audit_no_update
  BEFORE UPDATE ON admin_audit
  BEGIN SELECT RAISE(ABORT, 'admin_audit is append-only: no update'); END;
CREATE TRIGGER IF NOT EXISTS admin_audit_no_delete
  BEFORE DELETE ON admin_audit
  BEGIN SELECT RAISE(ABORT, 'admin_audit is append-only: no delete'); END;
CREATE TRIGGER IF NOT EXISTS admin_audit_no_replace
  BEFORE INSERT ON admin_audit
  WHEN EXISTS (SELECT 1 FROM admin_audit a WHERE a.id = NEW.id OR a.seq = NEW.seq)
  BEGIN SELECT RAISE(ABORT, 'admin_audit is append-only: append, never replace'); END;

CREATE TABLE IF NOT EXISTS admin_lead_state (
  lead_id     TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'qualified', 'won', 'lost')),
  note        TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL CHECK (length(updated_by) = 64)
);
CREATE INDEX IF NOT EXISTS idx_admin_lead_state_status ON admin_lead_state(status, updated_at);

-- One row per Idempotency-Key: the request it first came with (a hash) and the answer it got, replayed on a repeat.
CREATE TABLE IF NOT EXISTS admin_idempotency (
  idempotency_key  TEXT NOT NULL,
  action           TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  status           INTEGER NOT NULL,
  response_json    TEXT NOT NULL,
  at               TEXT NOT NULL,
  PRIMARY KEY (idempotency_key, action)
);
