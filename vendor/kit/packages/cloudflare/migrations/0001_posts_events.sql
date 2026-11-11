-- @saasreport/cloudflare: blog posts and events.
-- posts: scheduled posts are upserted by the daily cron (source 'auto'); editorial rows can be synced by the CLI (source 'editorial').
-- kind is free text: topic | report | term (from series) or article | howto | analysis | … (editorial).
-- channel_state / channel_ref are owned by @saasreport/channels (announce once).
CREATE TABLE IF NOT EXISTS posts (
  slug          TEXT PRIMARY KEY,
  series        TEXT,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  body_md       TEXT NOT NULL DEFAULT '',
  tags          TEXT NOT NULL DEFAULT '[]',
  author        TEXT,
  source        TEXT NOT NULL DEFAULT 'auto',
  status        TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published')),
  published_at  TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  channel_state TEXT NOT NULL DEFAULT 'pending' CHECK (channel_state IN ('pending','sent','skipped','failed')),
  channel_ref   TEXT
);
CREATE INDEX IF NOT EXISTS posts_published ON posts (status, published_at DESC);
CREATE INDEX IF NOT EXISTS posts_kind ON posts (kind, status, published_at DESC);

CREATE TABLE IF NOT EXISTS events (
  slug          TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  body_md       TEXT NOT NULL DEFAULT '',
  starts_at     TEXT NOT NULL,
  ends_at       TEXT NOT NULL,
  format        TEXT NOT NULL DEFAULT 'online' CHECK (format IN ('online','in_person','hybrid')),
  location      TEXT,
  join_url      TEXT,
  capacity      INTEGER,
  status        TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
  source        TEXT NOT NULL DEFAULT 'local',
  external_id   TEXT,
  external_url  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  channel_state TEXT NOT NULL DEFAULT 'pending' CHECK (channel_state IN ('pending','sent','skipped','failed')),
  channel_ref   TEXT
);
CREATE INDEX IF NOT EXISTS events_upcoming ON events (status, starts_at);
