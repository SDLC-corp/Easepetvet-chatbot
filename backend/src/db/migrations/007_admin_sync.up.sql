-- Admin dashboard sync tracking. Additive only: extends websites with sync
-- bookkeeping columns and adds a per-run history table. Does not touch existing
-- tables/columns from migrations 001-006.

ALTER TABLE websites ADD COLUMN IF NOT EXISTS last_sync_started_at TIMESTAMPTZ;
ALTER TABLE websites ADD COLUMN IF NOT EXISTS last_sync_completed_at TIMESTAMPTZ;
ALTER TABLE websites ADD COLUMN IF NOT EXISTS last_sync_status TEXT NOT NULL DEFAULT 'never';
ALTER TABLE websites ADD COLUMN IF NOT EXISTS last_sync_error TEXT;
ALTER TABLE websites ADD COLUMN IF NOT EXISTS next_sync_at TIMESTAMPTZ;
ALTER TABLE websites ADD COLUMN IF NOT EXISTS sync_interval_days INTEGER NOT NULL DEFAULT 30;

-- One row per sync attempt (manual / scheduled / system).
CREATE TABLE IF NOT EXISTS website_sync_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  website_id BIGINT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual', 'scheduled', 'system')),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_website_sync_runs_website_id ON website_sync_runs(website_id);
CREATE INDEX IF NOT EXISTS idx_website_sync_runs_started_at ON website_sync_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_website_sync_runs_status ON website_sync_runs(status);
