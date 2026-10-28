-- Contract migration 0014: append-only successor to Kit cloudflare 0013.
-- 0013's original Git blob remains byte-identical to its first introduction.
-- This trigger moves strict canonical admission to an additive SQL step so
-- preexisting D1 installations and migration history are never rewritten.
CREATE TRIGGER IF NOT EXISTS universal_envelopes_t0_admission
BEFORE INSERT ON universal_envelopes
WHEN COALESCE(
  NEW.envelope_id = NEW.tenant || '/' || NEW.project || '/' || NEW.kind || '/' || NEW.subject || '/' || NEW.revision
  AND json_extract(NEW.envelope_json,'$.schema')='kit.universal-envelope.v1'
  AND json_extract(NEW.envelope_json,'$.id')=NEW.envelope_id
  AND json_extract(NEW.envelope_json,'$.tenant')=NEW.tenant
  AND json_extract(NEW.envelope_json,'$.project')=NEW.project
  AND json_extract(NEW.envelope_json,'$.kind')=NEW.kind
  AND json_extract(NEW.envelope_json,'$.subject')=NEW.subject
  AND json_extract(NEW.envelope_json,'$.revision')=NEW.revision
  AND json_extract(NEW.envelope_json,'$.trace.idempotency_key')=NEW.idempotency_key
  AND json_extract(NEW.envelope_json,'$.authority.root_sha256')=NEW.authority_sha256
  AND json_extract(NEW.envelope_json,'$.provenance.source_sha256')=NEW.source_sha256
  AND json_extract(NEW.envelope_json,'$.payload.sha256')=NEW.payload_sha256
  AND length(json_extract(NEW.envelope_json,'$.payload.schema_id'))>0
  AND length(json_extract(NEW.envelope_json,'$.payload.schema_sha256'))=64
  AND length(json_extract(NEW.envelope_json,'$.authority.registry_ref'))>0
  AND length(json_extract(NEW.envelope_json,'$.authority.policy_ref'))>0
  AND json_extract(NEW.envelope_json,'$.authority.contract_ref')=json_extract(NEW.envelope_json,'$.payload.contract_ref')
  AND length(json_extract(NEW.envelope_json,'$.payload.contract_ref'))>0
  AND json_extract(NEW.envelope_json,'$.lifecycle.state')='planned-not-executed'
,0)=0
BEGIN SELECT RAISE(ABORT,'universal T0 envelope source/authority/payload contract mismatch'); END;

-- Any recorded observation must bind to a required T0 evidence kind and the
-- identical tenant/project/idempotency identity; a Worker cannot fabricate a
-- new per-component evidence policy after the envelope was sealed.
CREATE TRIGGER IF NOT EXISTS universal_lifecycle_events_declared
  BEFORE INSERT ON universal_lifecycle_events
  WHEN NOT EXISTS (
    SELECT 1 FROM universal_envelopes e,
      json_each(json_extract(e.envelope_json, '$.lifecycle.required_evidence')) declared
    WHERE e.envelope_id = NEW.envelope_id
      AND e.tenant = NEW.tenant AND e.project = NEW.project
      AND declared.value = NEW.event_kind
      AND json_extract(NEW.event_json, '$.idempotency_key') = e.idempotency_key
      AND json_extract(NEW.event_json, '$.envelope_id') = e.envelope_id
      AND json_extract(NEW.event_json, '$.tenant') = e.tenant
      AND json_extract(NEW.event_json, '$.project') = e.project
      AND json_extract(NEW.event_json, '$.kind') = NEW.event_kind
      AND json_extract(NEW.event_json, '$.status') = 'verified'
  )
  BEGIN SELECT RAISE(ABORT, 'universal event undeclared or not bound to immutable T0 intent'); END;
