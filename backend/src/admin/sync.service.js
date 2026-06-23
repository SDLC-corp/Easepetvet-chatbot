import { getWebsiteByBaseUrl, ensureWebsite } from '../repositories/website.repository.js';
import { createWebsiteCrawlJobs, processPendingCrawlJobs } from '../ingestion/ingestion.service.js';
import { resetAllJobsToPending } from '../repositories/crawl-job.repository.js';
import { generateMissingEmbeddings } from '../embeddings/embedding.service.js';
import {
  getRunningRun,
  createRun,
  completeRun,
  failRun,
  markWebsiteSyncStarted,
  markWebsiteSyncCompleted,
  markWebsiteSyncFailed,
} from '../repositories/sync.repository.js';
import { config } from '../config/env.js';
import { logger } from '../shared/logger/logger.js';

// Re-syncs the website knowledge base by reusing the existing ingestion +
// embedding pipeline. Runs are tracked in website_sync_runs and summarized on the
// websites row so the admin dashboard can show status without holding the HTTP
// request open.

const BASE_URL = 'https://easepetvet.com/';
const WEBSITE_NAME = 'EasePetVet';
const DAY_MS = 24 * 60 * 60 * 1000;

// In-process guard so two requests in the same Node process cannot start two
// concurrent syncs. The DB check (getRunningRun) covers cross-check + crashes.
let inProcessRunning = false;

export class SyncBusyError extends Error {
  constructor(message = 'Sync is already running.') {
    super(message);
    this.name = 'SyncBusyError';
    this.statusCode = 409;
  }
}

function nextSyncDate(intervalDays) {
  const days = Number.isFinite(intervalDays) && intervalDays > 0 ? intervalDays : config.admin.sync.intervalDays;
  return new Date(Date.now() + days * DAY_MS);
}

async function resolveWebsite() {
  let website = await getWebsiteByBaseUrl(BASE_URL);
  if (!website) {
    // Bootstrap on a fresh database: create the website row so the very first
    // "Sync Now" can run the full crawl + embedding pipeline end to end (no shell
    // / manual ingestion required for the initial load).
    await ensureWebsite(BASE_URL, WEBSITE_NAME);
    website = await getWebsiteByBaseUrl(BASE_URL);
  }
  if (!website) {
    const err = new Error('Knowledge base could not be initialized.');
    err.statusCode = 503;
    throw err;
  }
  return website;
}

// Heavy lifting. Throws on failure (caller records it). Returns the summary.
async function executeSync(website, runId) {
  const summary = {};

  const created = await createWebsiteCrawlJobs(BASE_URL, WEBSITE_NAME);
  summary.urlsCollected = created.collected ?? 0;
  summary.jobsInserted = created.inserted ?? 0;

  summary.jobsReset = await resetAllJobsToPending(website.id);

  const processed = await processPendingCrawlJobs(website.id, {});
  summary.processed = processed.processed ?? 0;
  summary.completed = processed.completed ?? 0;
  summary.failed = processed.failed ?? 0;
  summary.skipped = processed.skipped ?? 0;

  // Embeddings must not crash the whole sync if the provider key is missing.
  try {
    const emb = await generateMissingEmbeddings(website.id);
    summary.embedding = {
      embedded: emb.embedded ?? 0,
      updated: emb.updated ?? 0,
      skipped: emb.skipped ?? 0,
      failed: emb.failed ?? 0,
      stopped: emb.stopped ?? false,
    };
    if (emb.stopped) {
      summary.embeddingWarning = 'Embedding generation stopped early (provider unavailable). Embeddings may need regeneration.';
    }
  } catch (err) {
    logger.warn({ err: err.message, runId }, 'Embedding step failed during sync; ingestion still completed');
    summary.embedding = { error: true };
    summary.embeddingWarning = 'Embeddings could not be generated (provider error). Knowledge base text updated; embeddings may need regeneration.';
  }

  return summary;
}

// Runs a full sync to completion. Used by the background trigger and the scheduler.
export async function runSync(triggerType) {
  if (inProcessRunning) throw new SyncBusyError();
  const website = await resolveWebsite();
  if (await getRunningRun(website.id)) throw new SyncBusyError();

  inProcessRunning = true;
  const runId = await createRun(website.id, triggerType);
  await markWebsiteSyncStarted(website.id);
  logger.info({ runId, triggerType }, 'Website sync started');

  try {
    const summary = await executeSync(website, runId);
    await completeRun(runId, summary);
    await markWebsiteSyncCompleted(website.id, nextSyncDate(website.sync_interval_days));
    logger.info({ runId, summary }, 'Website sync completed');
    return { runId, status: 'completed', summary };
  } catch (err) {
    const message = (err && err.message) ? String(err.message).slice(0, 500) : 'Sync failed.';
    await failRun(runId, message);
    await markWebsiteSyncFailed(website.id, message);
    logger.error({ runId, err: message }, 'Website sync failed');
    return { runId, status: 'failed', error: message };
  } finally {
    inProcessRunning = false;
  }
}

// Starts a sync in the background and returns the runId immediately so the HTTP
// handler can respond 202 without holding the connection open.
export async function startSyncInBackground(triggerType) {
  if (inProcessRunning) throw new SyncBusyError();
  const website = await resolveWebsite();
  if (await getRunningRun(website.id)) throw new SyncBusyError();

  inProcessRunning = true;
  const runId = await createRun(website.id, triggerType);
  await markWebsiteSyncStarted(website.id);
  logger.info({ runId, triggerType }, 'Website sync started (background)');

  // Fire and forget. Errors are recorded on the run + website rows.
  (async () => {
    try {
      const summary = await executeSync(website, runId);
      await completeRun(runId, summary);
      await markWebsiteSyncCompleted(website.id, nextSyncDate(website.sync_interval_days));
      logger.info({ runId, summary }, 'Website sync completed (background)');
    } catch (err) {
      const message = (err && err.message) ? String(err.message).slice(0, 500) : 'Sync failed.';
      await failRun(runId, message).catch(() => {});
      await markWebsiteSyncFailed(website.id, message).catch(() => {});
      logger.error({ runId, err: message }, 'Website sync failed (background)');
    } finally {
      inProcessRunning = false;
    }
  })();

  return { runId };
}

export function isSyncRunningInProcess() {
  return inProcessRunning;
}
