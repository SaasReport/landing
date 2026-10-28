-- @saasreport/cloudflare: multi-locale sites (site.locales in kit.config.js).
-- Every row keeps its data; existing rows get locale '' = the site's default locale, which is also what the default
-- locale writes, so a single-locale site that adds languages later needs no data migration.
-- Rows of another locale carry its code ('ar') and a slug prefixed with it ('ar/week-2026-10-05'), so slugs stay unique
-- (primary keys, R2 audio keys, channel state) and /ar/blog/week-2026-10-05 finds them. A single-locale site never reads this column.
ALTER TABLE posts ADD COLUMN locale TEXT NOT NULL DEFAULT '';
ALTER TABLE podcast_episodes ADD COLUMN locale TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN locale TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS posts_locale ON posts (locale, status, published_at DESC);
CREATE INDEX IF NOT EXISTS podcast_locale ON podcast_episodes (locale, show, status, published_at DESC);
CREATE INDEX IF NOT EXISTS events_locale ON events (locale, starts_at);
