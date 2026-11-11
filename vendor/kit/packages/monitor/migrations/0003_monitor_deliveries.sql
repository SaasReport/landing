-- @saasreport/monitor: one row per alert route and message (the daily canary, alerts, route and dead-man failures). Apply to the MONITOR's
-- database (binding MONITOR_DB), after 0002. The status document derives each route's freshness from it; the watcher fails on a stale
-- route or a failed delivery in its window.
CREATE TABLE IF NOT EXISTS monitor_deliveries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_started_at  TEXT NOT NULL,
  route           TEXT NOT NULL,             -- email | telegram | bale | webhook
  kind            TEXT NOT NULL,             -- canary | alert | route-failure | deadman-failure
  ok              INTEGER NOT NULL,          -- 1 when the route accepted the message
  error           TEXT,                      -- why it did not (never a recipient)
  at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS monitor_deliveries_at ON monitor_deliveries (at DESC);
