-- @saasreport/monitor: how the alert and the dead-man ping went, per run. Apply to the MONITOR's database (binding MONITOR_DB), after 0001.
ALTER TABLE monitor_runs ADD COLUMN alert_status TEXT;     -- 'none' | 'sent' | 'failed'
ALTER TABLE monitor_runs ADD COLUMN alert_error  TEXT;     -- why no channel accepted the alert (never a recipient)
ALTER TABLE monitor_runs ADD COLUMN deadman_status TEXT;   -- reserved: the ping outcome of the run that wrote the row
