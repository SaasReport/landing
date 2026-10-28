-- @saasreport/broker: the evidence chain (kit.broker-evidence.v1) and the single-use nonces. Append-only: the database
-- refuses an update or delete of evidence, and an insert whose seq does not follow the last one.
CREATE TABLE IF NOT EXISTS broker_evidence (
  seq  INTEGER PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE CHECK (length(hash) = 64),
  -- COALESCE(…, 0): a CHECK passes on NULL, and a missing field makes every comparison NULL, so NULL must mean "refused".
  body TEXT NOT NULL CHECK (COALESCE(json_valid(body) AND json_type(body, '$.seq') = 'integer' AND json_extract(body, '$.seq') = seq
    AND json_type(body, '$.hash') = 'text' AND json_extract(body, '$.hash') = hash AND json_type(body, '$.prev') = 'text'
    AND json_extract(body, '$.decision') IN ('allow', 'deny'), 0))
);
CREATE TRIGGER IF NOT EXISTS broker_evidence_contiguous BEFORE INSERT ON broker_evidence
-- IS NOT, never <>: a missing field is NULL, and NULL <> x is NULL, which would let the row through.
WHEN NEW.seq IS NOT (SELECT COALESCE(MAX(seq), 0) + 1 FROM broker_evidence)
  OR json_extract(NEW.body, '$.prev') IS NOT COALESCE((SELECT hash FROM broker_evidence ORDER BY seq DESC LIMIT 1), '0000000000000000000000000000000000000000000000000000000000000000')
BEGIN SELECT RAISE(ABORT, 'broker evidence must extend the chain'); END;
CREATE TRIGGER IF NOT EXISTS broker_evidence_no_update BEFORE UPDATE ON broker_evidence
BEGIN SELECT RAISE(ABORT, 'broker evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS broker_evidence_no_delete BEFORE DELETE ON broker_evidence
BEGIN SELECT RAISE(ABORT, 'broker evidence is append-only'); END;

CREATE TABLE IF NOT EXISTS broker_nonce (
  agent TEXT NOT NULL,
  nonce TEXT NOT NULL,
  at    INTEGER NOT NULL,
  PRIMARY KEY (agent, nonce)
);
CREATE INDEX IF NOT EXISTS broker_nonce_at ON broker_nonce (at);
