-- @saasreport/cloudflare: supersedes 0004_monitor_runs.sql (an applied migration is never deleted). The monitor now writes its runs to its
-- OWN D1 (MONITOR_DB, @saasreport/monitor migrations) and the site reads them over the MONITOR service binding: a monitor never writes into
-- the database it watches. This table stays for its history (the owner archives it to <project>-archive under DO-NOT-DELETE/<date>/ and
-- may then drop it); from now on nothing can add a row to it.
CREATE TRIGGER IF NOT EXISTS monitor_runs_superseded BEFORE INSERT ON monitor_runs
BEGIN SELECT RAISE(ABORT, 'monitor_runs in the site database is superseded: the monitor writes to its own D1 (0012)'); END;
