-- @saasreport/cloudflare: likes and 1-5 ratings. One row per (item, anonymous visitor).
-- item: 'post:<slug>' | 'episode:<slug>'. visitor: SHA-256 of a random cookie id + salt; ip_hash: SHA-256 of the IP + salt (rate limit).
CREATE TABLE IF NOT EXISTS reactions (
  item        TEXT NOT NULL,
  visitor     TEXT NOT NULL,
  liked       INTEGER NOT NULL DEFAULT 0 CHECK (liked IN (0, 1)),
  rating      INTEGER CHECK (rating BETWEEN 1 AND 5),
  ip_hash     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (item, visitor)
);
CREATE INDEX IF NOT EXISTS reactions_item ON reactions (item);
CREATE INDEX IF NOT EXISTS reactions_ip ON reactions (ip_hash, updated_at);
