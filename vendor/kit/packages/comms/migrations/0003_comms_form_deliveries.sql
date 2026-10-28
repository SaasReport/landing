-- One row per form submission and its two deliveries (kit.form-notification.v1, docs/FORMS.md): the submitter's receipt and the
-- owner's notification. Written by the comms engine's POST /v1/comms/submit before anything is sent, so a submission whose record
-- cannot be written sends nothing; each delivery points at its comms_dispatch row. No address and no submitted value: statuses only.
-- An owner delivery that is not 'sent' is a failure (suppressed included); GET /api/forms/deliveries counts them for the monitor.
CREATE TABLE IF NOT EXISTS comms_form_deliveries (
  reference            TEXT PRIMARY KEY,
  form_id              TEXT NOT NULL,
  site                 TEXT NOT NULL,
  test                 INTEGER NOT NULL DEFAULT 0 CHECK (test IN (0, 1)),
  created_at           TEXT NOT NULL,
  updated_at           TEXT,
  receipt_status       TEXT NOT NULL DEFAULT 'pending' CHECK (receipt_status IN ('pending', 'sent', 'suppressed', 'failed')),
  receipt_dispatch_id  TEXT,
  receipt_error        TEXT,
  owner_status         TEXT NOT NULL DEFAULT 'pending' CHECK (owner_status IN ('pending', 'sent', 'failed')),
  owner_dispatch_id    TEXT,
  owner_error          TEXT
);
CREATE INDEX IF NOT EXISTS idx_form_deliveries_owner ON comms_form_deliveries(owner_status, created_at);
CREATE INDEX IF NOT EXISTS idx_form_deliveries_created ON comms_form_deliveries(created_at);

-- A drill header (x-kit-form-drill) is accepted once: its timestamp is the key, so a captured header cannot be replayed inside its
-- five-minute window (acceptDrill in @saasreport/core/form-deliveries). Rows older than two days are deleted on each use.
CREATE TABLE IF NOT EXISTS comms_form_drills (
  ts       TEXT PRIMARY KEY,
  form_id  TEXT NOT NULL,
  seen_at  TEXT NOT NULL,
  outcome  TEXT NOT NULL DEFAULT 'accepted'   -- accepted | recorded | not_recorded: the attempt counts as the day's drill whatever it became
);

-- Lookups of one reference (GET /api/forms/deliveries/<reference>) per client, for the rate limit (lookupAllowed): a hash of the
-- client address, never the address. Rows older than the window are deleted on each lookup.
CREATE TABLE IF NOT EXISTS comms_form_lookups (
  ip_hash  TEXT NOT NULL,
  at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_form_lookups ON comms_form_lookups(ip_hash, at);
