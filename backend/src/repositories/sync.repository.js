import { pool } from '../db/pool.js';

// Persistence for website sync runs and the per-website sync bookkeeping columns
// added in migration 007. All queries are parameterized.

export async function getRunningRun(websiteId) {
  const { rows } = await pool.query(
    `SELECT id, website_id, trigger_type, status, started_at, completed_at, summary, error_message
     FROM website_sync_runs
     WHERE website_id = $1 AND status = 'running'
     ORDER BY started_at DESC
     LIMIT 1`,
    [websiteId],
  );
  return rows[0] ?? null;
}

export async function getLatestRun(websiteId) {
  const { rows } = await pool.query(
    `SELECT id, website_id, trigger_type, status, started_at, completed_at, summary, error_message
     FROM website_sync_runs
     WHERE website_id = $1
     ORDER BY started_at DESC
     LIMIT 1`,
    [websiteId],
  );
  return rows[0] ?? null;
}

export async function createRun(websiteId, triggerType) {
  const { rows } = await pool.query(
    `INSERT INTO website_sync_runs (website_id, trigger_type, status)
     VALUES ($1, $2, 'running')
     RETURNING id`,
    [websiteId, triggerType],
  );
  return rows[0].id;
}

export async function completeRun(runId, summary) {
  await pool.query(
    `UPDATE website_sync_runs
     SET status = 'completed', completed_at = now(), summary = $2::jsonb
     WHERE id = $1`,
    [runId, JSON.stringify(summary ?? {})],
  );
}

export async function failRun(runId, errorMessage) {
  await pool.query(
    `UPDATE website_sync_runs
     SET status = 'failed', completed_at = now(), error_message = $2
     WHERE id = $1`,
    [runId, errorMessage ?? 'Sync failed.'],
  );
}

export async function markWebsiteSyncStarted(websiteId) {
  await pool.query(
    `UPDATE websites
     SET last_sync_status = 'running', last_sync_started_at = now(), last_sync_error = NULL
     WHERE id = $1`,
    [websiteId],
  );
}

export async function markWebsiteSyncCompleted(websiteId, nextSyncAt) {
  await pool.query(
    `UPDATE websites
     SET last_sync_status = 'completed', last_sync_completed_at = now(),
         last_sync_error = NULL, next_sync_at = $2
     WHERE id = $1`,
    [websiteId, nextSyncAt],
  );
}

export async function markWebsiteSyncFailed(websiteId, errorMessage) {
  await pool.query(
    `UPDATE websites
     SET last_sync_status = 'failed', last_sync_completed_at = now(), last_sync_error = $2
     WHERE id = $1`,
    [websiteId, errorMessage ?? 'Sync failed.'],
  );
}

export async function setNextSyncAt(websiteId, nextSyncAt) {
  await pool.query('UPDATE websites SET next_sync_at = $2 WHERE id = $1', [websiteId, nextSyncAt]);
}
