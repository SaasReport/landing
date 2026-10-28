-- @saasreport/monitor: one row per synthetic journey run; per-journey results as JSON.
-- Apply to the site's D1 database (the monitor worker and the site's GET /api/status share it).
CREATE TABLE IF NOT EXISTS monitor_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT NOT NULL,
  trigger      TEXT NOT NULL,              -- 'cron' | 'manual'
  ok           INTEGER NOT NULL,           -- 1 when every journey passed
  results_json TEXT NOT NULL               -- [{name, ok, ms, attempts, error?, notes?}]
);
CREATE INDEX IF NOT EXISTS monitor_runs_started ON monitor_runs (started_at DESC);
