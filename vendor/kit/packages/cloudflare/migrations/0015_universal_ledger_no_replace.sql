-- Canonical additive T=0 write guard for Kit's universal D1 envelope and evidence ledger.
-- NEVER rewrite previously applied 0013/0014. SQLite DELETE/UPDATE triggers alone
-- cannot prevent INSERT OR REPLACE from silently deleting old rows when
-- PRAGMA recursive_triggers=OFF (the default). BEFORE INSERT must reject *all*
-- identity collisions; the D1 adapter reads identical bytes for safe retries.
CREATE TRIGGER IF NOT EXISTS universal_envelopes_no_replace
  BEFORE INSERT ON universal_envelopes
  WHEN EXISTS (
    SELECT 1 FROM universal_envelopes e
    WHERE e.envelope_id = NEW.envelope_id
       OR e.idempotency_key = NEW.idempotency_key
       OR (e.tenant = NEW.tenant AND e.project = NEW.project
           AND e.kind = NEW.kind AND e.subject = NEW.subject
           AND e.revision = NEW.revision)
  )
  BEGIN SELECT RAISE(ABORT, 'universal envelope immutable duplicate: append, never replace'); END;

CREATE TRIGGER IF NOT EXISTS universal_lifecycle_events_no_replace
  BEFORE INSERT ON universal_lifecycle_events
  WHEN EXISTS (
    SELECT 1 FROM universal_lifecycle_events x
    WHERE x.event_id = NEW.event_id
       OR (x.envelope_id = NEW.envelope_id
           AND x.event_kind = NEW.event_kind
           AND x.event_sha256 = NEW.event_sha256)
  )
  BEGIN SELECT RAISE(ABORT, 'universal event immutable duplicate: append, never replace'); END;
