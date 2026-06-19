DROP TABLE IF EXISTS website_sync_runs;

ALTER TABLE websites DROP COLUMN IF EXISTS last_sync_started_at;
ALTER TABLE websites DROP COLUMN IF EXISTS last_sync_completed_at;
ALTER TABLE websites DROP COLUMN IF EXISTS last_sync_status;
ALTER TABLE websites DROP COLUMN IF EXISTS last_sync_error;
ALTER TABLE websites DROP COLUMN IF EXISTS next_sync_at;
ALTER TABLE websites DROP COLUMN IF EXISTS sync_interval_days;
