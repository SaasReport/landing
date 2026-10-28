-- Same table as @saasreport/monitor migrations/0001_monitor_runs.sql (read by GET /api/status). Safe to apply twice.
CREATE TABLE IF NOT EXISTS monitor_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT NOT NULL,
  trigger      TEXT NOT NULL,
  ok           INTEGER NOT NULL,
  results_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS monitor_runs_started ON monitor_runs (started_at DESC);
