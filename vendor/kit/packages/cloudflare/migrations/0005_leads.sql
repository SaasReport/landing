-- @saasreport/cloudflare (optional): form submissions, used by the event RSVP endpoint (options.events.rsvp = true).
CREATE TABLE IF NOT EXISTS leads (
  id            TEXT PRIMARY KEY,          -- reference shown to the visitor
  form          TEXT NOT NULL,             -- e.g. 'event-rsvp'
  ref           TEXT,                      -- e.g. the event slug
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  email_hash    TEXT NOT NULL,
  company       TEXT,
  fields_json   TEXT NOT NULL,
  ip_hash       TEXT,
  user_agent    TEXT,
  created_at    TEXT NOT NULL,
  comms_status  TEXT,                      -- sent | failed | skipped
  dispatch_id   TEXT
);
CREATE INDEX IF NOT EXISTS leads_ip_created ON leads (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS leads_form ON leads (form, created_at);
