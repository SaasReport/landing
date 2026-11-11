-- One live dispatch per idempotency key (wo-0009, zero silent failure): two dispatches racing with the same key cannot both
-- reserve a row, so one key sends once. A failed dispatch does not hold the key, so its retry can reserve it again.
-- An installation upgraded from 0001 may already hold more than one live row per key (0001's index was not unique and the
-- old lookup-before-send did not serialise): one row per key stays live (sent, then partial, then sending; the earliest
-- first), the others are marked reconciled_duplicate with the reason, never deleted, so the unique index can be built.
UPDATE comms_dispatch
   SET send_status = 'reconciled_duplicate',
       send_error = COALESCE(send_error || ' | ', '') || 'migration 0002: another live dispatch holds this idempotency key; this one was kept for the record'
 WHERE rowid IN (
   SELECT rowid FROM (
     SELECT rowid, ROW_NUMBER() OVER (
       PARTITION BY idempotency_key, template_id
       ORDER BY CASE send_status WHEN 'sent' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END, requested_at, rowid) AS n
     FROM comms_dispatch
     WHERE idempotency_key IS NOT NULL AND send_status IN ('sending', 'sent', 'partial'))
   WHERE n > 1);
DROP INDEX IF EXISTS idx_dispatch_idem;
CREATE INDEX IF NOT EXISTS idx_dispatch_idem ON comms_dispatch(idempotency_key, template_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_idem_live ON comms_dispatch(idempotency_key, template_id)
  WHERE idempotency_key IS NOT NULL AND send_status IN ('sending', 'sent', 'partial');
