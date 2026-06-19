import { Router } from 'express';
import { requireAdmin } from '../middleware/admin-auth.middleware.js';
import { getSummary, listChats, getChatDetail } from '../repositories/admin.repository.js';
import { getWebsiteByBaseUrl } from '../repositories/website.repository.js';
import { getJobCountsByStatus } from '../repositories/crawl-job.repository.js';
import { getEmbeddingStatusForWebsite } from '../embeddings/embedding.service.js';
import { getLatestRun } from '../repositories/sync.repository.js';
import { startSyncInBackground, SyncBusyError } from '../admin/sync.service.js';
import { logger } from '../shared/logger/logger.js';

// Admin dashboard API. Every route requires the admin bearer token.

const router = Router();
const BASE_URL = 'https://easepetvet.com/';
const VALID_AUDIENCES = ['pet_parent', 'vet', 'unknown'];

router.use(requireAdmin);

async function resolveWebsiteId() {
  const website = await getWebsiteByBaseUrl(BASE_URL);
  return website ?? null;
}

router.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', admin: true });
});

router.get('/summary', async (req, res) => {
  try {
    const website = await resolveWebsiteId();
    if (!website) return res.status(503).json({ error: 'Knowledge base is not ready.' });
    const summary = await getSummary(website.id);
    return res.status(200).json(summary);
  } catch (err) {
    logger.error({ err }, 'Admin summary failed');
    return res.status(500).json({ error: 'Failed to load summary.' });
  }
});

router.get('/chats', async (req, res) => {
  try {
    const { page, limit, search, audience, dateFrom, dateTo } = req.query;
    if (audience !== undefined && audience !== '' && !VALID_AUDIENCES.includes(String(audience))) {
      return res.status(400).json({ error: `audience must be one of ${VALID_AUDIENCES.join(', ')}.` });
    }
    const result = await listChats({
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
      search: search ? String(search).trim() : undefined,
      audience: audience ? String(audience) : undefined,
      dateFrom: dateFrom ? String(dateFrom) : undefined,
      dateTo: dateTo ? String(dateTo) : undefined,
    });
    return res.status(200).json(result);
  } catch (err) {
    logger.error({ err }, 'Admin chats list failed');
    return res.status(500).json({ error: 'Failed to load chats.' });
  }
});

router.get('/chats/:sessionId', async (req, res) => {
  try {
    const detail = await getChatDetail(req.params.sessionId);
    if (!detail) return res.status(404).json({ error: 'Chat not found.' });
    return res.status(200).json(detail);
  } catch (err) {
    logger.error({ err }, 'Admin chat detail failed');
    return res.status(500).json({ error: 'Failed to load chat.' });
  }
});

router.get('/sync/status', async (req, res) => {
  try {
    const website = await resolveWebsiteId();
    if (!website) return res.status(503).json({ error: 'Knowledge base is not ready.' });
    const [latestRun, jobCounts, embeddingStatus] = await Promise.all([
      getLatestRun(website.id),
      getJobCountsByStatus(website.id),
      getEmbeddingStatusForWebsite(website.id).catch(() => null),
    ]);
    return res.status(200).json({
      website: { baseUrl: website.base_url, name: website.name },
      status: website.last_sync_status ?? 'never',
      lastStartedAt: website.last_sync_started_at ?? null,
      lastCompletedAt: website.last_sync_completed_at ?? null,
      nextSyncAt: website.next_sync_at ?? null,
      lastError: website.last_sync_error ?? null,
      latestRun: latestRun ?? null,
      jobCounts: jobCounts ?? [],
      embeddingStatus: embeddingStatus ?? null,
    });
  } catch (err) {
    logger.error({ err }, 'Admin sync status failed');
    return res.status(500).json({ error: 'Failed to load sync status.' });
  }
});

router.post('/sync/run', async (req, res) => {
  try {
    const { runId } = await startSyncInBackground('manual');
    return res.status(202).json({ started: true, runId, message: 'Sync started.' });
  } catch (err) {
    if (err instanceof SyncBusyError) {
      return res.status(409).json({ error: err.message });
    }
    if (err && err.statusCode === 503) {
      return res.status(503).json({ error: err.message });
    }
    logger.error({ err }, 'Admin sync run failed to start');
    return res.status(500).json({ error: 'Failed to start sync.' });
  }
});

export default router;
