-- @saasreport/cloudflare: podcast episodes (rendered by @saasreport/podcast's PodcastWorkflow, audio in R2 at podcasts/<slug>.mp3).
-- series = config series id, show = config shows key; numbering is per series (assigned on first publish).
-- kind / source_type are free text: topic | term | article | post | manual.
CREATE TABLE IF NOT EXISTS podcast_episodes (
  slug          TEXT PRIMARY KEY,
  series        TEXT NOT NULL,
  show          TEXT,
  number        INTEGER,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  source_type   TEXT NOT NULL,
  source_ref    TEXT,
  script_json   TEXT,               -- [{speaker, text, start_ms?}]
  script_model  TEXT,
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','scripting','rendering','published','review','failed')),
  audio_key     TEXT,
  audio_bytes   INTEGER,
  duration_ms   INTEGER,
  workflow_id   TEXT,
  error         TEXT,
  published_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  channel_state TEXT NOT NULL DEFAULT 'pending' CHECK (channel_state IN ('pending','sent','skipped','failed')),
  channel_ref   TEXT
);
CREATE INDEX IF NOT EXISTS podcast_published ON podcast_episodes (status, published_at DESC);
CREATE INDEX IF NOT EXISTS podcast_series ON podcast_episodes (series, status, published_at DESC);
CREATE INDEX IF NOT EXISTS podcast_show ON podcast_episodes (show, status, published_at DESC);
CREATE INDEX IF NOT EXISTS podcast_source ON podcast_episodes (series, source_ref);
