import { Router } from 'express';
import { requireAdmin } from '../middleware/admin-auth.middleware.js';
import { getSummary, listChats, getChatDetail, deleteChats, listChatIds, exportChats } from '../repositories/admin.repository.js';
import { getWebsiteByBaseUrl } from '../repositories/website.repository.js';
import { getJobCountsByStatus } from '../repositories/crawl-job.repository.js';
import { getEmbeddingStatusForWebsite } from '../embeddings/embedding.service.js';
import { getLatestRun } from '../repositories/sync.repository.js';
import { startSyncInBackground, SyncBusyError } from '../admin/sync.service.js';
import { config } from '../config/env.js';
import { logger } from '../shared/logger/logger.js';

const AUDIENCE_LABELS = { pet_parent: 'Pet Parent', vet: 'Vet', unknown: 'Not sure' };

function formatTz(value) {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: config.admin.timezone,
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: true,
    }).format(new Date(value)) + ' CST';
  } catch (e) {
    return String(value);
  }
}

// Minimal, safe CSV cell: always quoted, internal quotes doubled.
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

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
    return res.status(200).json({ ...summary, timezone: config.admin.timezone });
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

// All matching session tokens for the current filters (for "select all across pages").
router.get('/chats/ids', async (req, res) => {
  try {
    const { search, audience, dateFrom, dateTo } = req.query;
    if (audience !== undefined && audience !== '' && !VALID_AUDIENCES.includes(String(audience))) {
      return res.status(400).json({ error: `audience must be one of ${VALID_AUDIENCES.join(', ')}.` });
    }
    const sessionIds = await listChatIds({
      search: search ? String(search).trim() : undefined,
      audience: audience ? String(audience) : undefined,
      dateFrom: dateFrom ? String(dateFrom) : undefined,
      dateTo: dateTo ? String(dateTo) : undefined,
    });
    return res.status(200).json({ total: sessionIds.length, sessionIds });
  } catch (err) {
    logger.error({ err }, 'Admin chat ids failed');
    return res.status(500).json({ error: 'Failed to load chat ids.' });
  }
});

// Export selected conversations as a CSV download.
router.post('/chats/export', async (req, res) => {
  const ids = (req.body && req.body.sessionIds) || [];
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'sessionIds (non-empty array) is required.' });
  }
  if (!ids.every((id) => typeof id === 'string')) {
    return res.status(400).json({ error: 'sessionIds must be strings.' });
  }
  try {
    const rows = await exportChats(ids);
    // Export only the email and the audience (Vet / Pet Parent / Not sure). Rows
    // without an email have nothing to follow up on, so they're skipped.
    const header = ['Email', 'Audience'];
    const lines = [header.map(csvCell).join(',')];
    for (const r of rows) {
      if (!r.email || !r.email.trim()) continue;
      lines.push([
        csvCell(r.email.trim()),
        csvCell(AUDIENCE_LABELS[r.audience] || 'Not sure'),
      ].join(','));
    }
    const csv = '﻿' + lines.join('\r\n'); // BOM so Excel reads UTF-8
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="chat-users-export-${date}.csv"`);
    return res.status(200).send(csv);
  } catch (err) {
    logger.error({ err }, 'Admin chat export failed');
    return res.status(500).json({ error: 'Failed to export chats.' });
  }
});

// Bulk-delete conversations by public session token. Body: { sessionIds: [...] }.
router.post('/chats/delete', async (req, res) => {
  const ids = (req.body && req.body.sessionIds) || [];
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'sessionIds (non-empty array) is required.' });
  }
  if (!ids.every((id) => typeof id === 'string')) {
    return res.status(400).json({ error: 'sessionIds must be strings.' });
  }
  try {
    const deleted = await deleteChats(ids);
    return res.status(200).json({ deleted });
  } catch (err) {
    logger.error({ err }, 'Admin chat delete failed');
    return res.status(500).json({ error: 'Failed to delete chats.' });
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
