-- @saasreport/comms: the tables the comms engine writes (dispatch log, suppression list, audit events).
-- Apply to the engine's D1 database (wrangler d1 migrations apply <db>) unless the project already has them.
CREATE TABLE IF NOT EXISTS comms_dispatch (
  dispatch_id            TEXT PRIMARY KEY,
  template_id            TEXT NOT NULL,
  channel                TEXT NOT NULL,
  category               TEXT NOT NULL,
  to_hashes_json         TEXT NOT NULL,
  rendered_subject_hash  TEXT,
  rendered_body_hash     TEXT,
  provider_id            TEXT,
  provider_response_id   TEXT,
  requested_at           TEXT NOT NULL,
  dispatched_at          TEXT,
  tenant_id              TEXT,
  idempotency_key        TEXT,
  audit_chain_ref        TEXT,
  send_status            TEXT,
  send_error             TEXT
);
CREATE INDEX IF NOT EXISTS idx_dispatch_idem ON comms_dispatch(idempotency_key, template_id);

CREATE TABLE IF NOT EXISTS comms_suppression (
  recipient_hash TEXT NOT NULL,
  reason         TEXT NOT NULL,
  scope          TEXT NOT NULL DEFAULT 'global',
  actor_id       TEXT,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (recipient_hash, reason)
);

CREATE TABLE IF NOT EXISTS comms_audit (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_family_id  TEXT NOT NULL,
  source_event_id  TEXT NOT NULL,
  emitted_at       TEXT NOT NULL,
  actor_id         TEXT,
  tenant_id        TEXT,
  payload_summary  TEXT,
  audit_chain_ref  TEXT
);
