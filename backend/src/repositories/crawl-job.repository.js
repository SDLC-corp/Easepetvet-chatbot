import { pool } from '../db/pool.js';

// All SQL for the crawl_jobs table. Status transitions are explicit functions;
// errors propagate to the caller, which decides job outcome and logs.

// Bulk-inserts URLs as pending jobs for a website. Duplicate (website_id, url)
// pairs are skipped. Returns the number of rows actually inserted.
export async function insertPendingJobs(websiteId, urls) {
  if (!urls || urls.length === 0) return 0;

  const valueTuples = urls.map((_, index) => `($1, $${index + 2})`).join(', ');
  const { rowCount } = await pool.query(
    `INSERT INTO crawl_jobs (website_id, url)
     VALUES ${valueTuples}
     ON CONFLICT (website_id, url) DO NOTHING`,
    [websiteId, ...urls],
  );
  return rowCount;
}

// Atomically claims the oldest pending job for a website, marking it processing.
// FOR UPDATE SKIP LOCKED makes this safe under concurrency. Returns the claimed
// job row, or null if none remain.
export async function claimNextPendingJob(websiteId) {
  const { rows } = await pool.query(
    `UPDATE crawl_jobs
     SET status = 'processing', started_at = now(), updated_at = now()
     WHERE id = (
       SELECT id FROM crawl_jobs
       WHERE website_id = $1 AND status = 'pending'
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    [websiteId],
  );
  return rows[0] ?? null;
}

export async function markJobCompleted(jobId) {
  await pool.query(
    `UPDATE crawl_jobs
     SET status = 'completed', completed_at = now(), updated_at = now()
     WHERE id = $1`,
    [jobId],
  );
}

export async function markJobFailed(jobId, errorMessage) {
  await pool.query(
    `UPDATE crawl_jobs
     SET status = 'failed', error_message = $2,
         retry_count = retry_count + 1, completed_at = now(), updated_at = now()
     WHERE id = $1`,
    [jobId, errorMessage],
  );
}

export async function markJobSkipped(jobId, skipReason) {
  await pool.query(
    `UPDATE crawl_jobs
     SET status = 'skipped', skip_reason = $2,
         completed_at = now(), updated_at = now()
     WHERE id = $1`,
    [jobId, skipReason],
  );
}

export async function getJobCountsByStatus(websiteId) {
  const { rows } = await pool.query(
    `SELECT status, COUNT(*)::int AS count
     FROM crawl_jobs
     WHERE website_id = $1
     GROUP BY status`,
    [websiteId],
  );
  return rows;
}

// Resets and claims a single job for manual reprocessing in one atomic update
// (clears prior state incl. retry_count, marks it processing). Matches the URL
// trailing-slash-insensitively. Returns the job, or null if none matches.
export async function claimJobForReprocess(websiteId, url) {
  const { rows } = await pool.query(
    `UPDATE crawl_jobs
     SET status = 'processing', started_at = now(), completed_at = NULL,
         error_message = NULL, skip_reason = NULL, retry_count = 0, updated_at = now()
     WHERE website_id = $1 AND rtrim(url, '/') = rtrim($2, '/')
     RETURNING *`,
    [websiteId, url],
  );
  return rows[0] ?? null;
}

// Resets all of a website's jobs to pending (for a full reprocess). Returns the
// number of jobs reset.
export async function resetAllJobsToPending(websiteId) {
  const { rowCount } = await pool.query(
    `UPDATE crawl_jobs
     SET status = 'pending', started_at = NULL, completed_at = NULL,
         error_message = NULL, skip_reason = NULL, updated_at = now()
     WHERE website_id = $1`,
    [websiteId],
  );
  return rowCount;
}
