-- Kit cloudflare engine: canonical Universal Envelope v1, T=0 append-only lifecycle ledger.
-- A site's first D1 binding adopts this through 'kit migrations sync' AFTER the pinned
-- Kit vendor snapshot; never edit applied migrations or rewrite podcast legacy GUIDs.
CREATE TABLE IF NOT EXISTS universal_envelopes (
  envelope_id TEXT PRIMARY KEY NOT NULL,
  tenant TEXT NOT NULL,
  project TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  revision TEXT NOT NULL,
  authority_sha256 TEXT NOT NULL CHECK (length(authority_sha256) = 64),
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) = 64),
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
  created_at TEXT NOT NULL,
  UNIQUE (tenant, project, kind, subject, revision)
);
CREATE INDEX IF NOT EXISTS universal_envelopes_scope
  ON universal_envelopes (tenant, project, kind, created_at);
CREATE TRIGGER IF NOT EXISTS universal_envelopes_immutable_update
  BEFORE UPDATE ON universal_envelopes
  BEGIN SELECT RAISE(ABORT, 'universal envelope immutable: append a transition'); END;
CREATE TRIGGER IF NOT EXISTS universal_envelopes_immutable_delete
  BEFORE DELETE ON universal_envelopes
  BEGIN SELECT RAISE(ABORT, 'universal envelope immutable: historical evidence must persist'); END;

CREATE TABLE IF NOT EXISTS universal_lifecycle_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  envelope_id TEXT NOT NULL REFERENCES universal_envelopes(envelope_id),
  tenant TEXT NOT NULL,
  project TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  event_sha256 TEXT NOT NULL CHECK (length(event_sha256) = 64),
  observed_at TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  UNIQUE (envelope_id, event_kind, event_sha256)
);
CREATE INDEX IF NOT EXISTS universal_lifecycle_events_envelope
  ON universal_lifecycle_events (envelope_id, observed_at, event_kind);
CREATE TRIGGER IF NOT EXISTS universal_lifecycle_events_scope
  BEFORE INSERT ON universal_lifecycle_events
  WHEN NOT EXISTS (
    SELECT 1 FROM universal_envelopes e
    WHERE e.envelope_id = NEW.envelope_id
      AND e.tenant = NEW.tenant AND e.project = NEW.project
  )
  BEGIN SELECT RAISE(ABORT, 'universal lifecycle event: missing or cross-tenant envelope'); END;
CREATE TRIGGER IF NOT EXISTS universal_lifecycle_events_immutable_update
  BEFORE UPDATE ON universal_lifecycle_events
  BEGIN SELECT RAISE(ABORT, 'universal lifecycle events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS universal_lifecycle_events_immutable_delete
  BEFORE DELETE ON universal_lifecycle_events
  BEGIN SELECT RAISE(ABORT, 'universal lifecycle events are append-only'); END;
