import { Router } from 'express';
import { requireAdmin } from '../middleware/admin-auth.middleware.js';
import { getSummary, listChats, getChatDetail, deleteChats, listChatIds, exportChats } from '../repositories/admin.repository.js';
import {
  listCustomAnswers, getCustomAnswerById, createCustomAnswer, updateCustomAnswer,
  deleteCustomAnswer, checkDuplicateCustomAnswer,
  bulkDeleteCustomAnswers, bulkSetCustomAnswerStatus,
} from '../repositories/admin-custom-answer.repository.js';
import { toNormalizedQuestion } from '../chat/custom-answer.service.js';
import { questionSimilarity } from '../retrieval/query-normalizer.js';
import { getWebsiteEmails, getWebsiteLinks } from '../repositories/suggestion.repository.js';
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

/* ---------- Custom Q&A overrides ---------- */

const CUSTOM_AUDIENCES = ['all', 'vet', 'pet_parent', 'unknown'];
const CUSTOM_STATUSES = ['active', 'inactive'];
// Threshold for the non-blocking "possible duplicate" warning. Uses token-set
// similarity (questionSimilarity), which rates reworded questions higher than the
// char-level ratio, so genuine rewordings are flagged without over-warning.
const SIMILAR_THRESHOLD = 0.82;

// Validates + normalizes a create/update body. Returns { error } or { data }.
function parseCustomAnswerBody(body) {
  const b = body || {};
  const question = typeof b.question === 'string' ? b.question.trim() : '';
  const answer = typeof b.answer === 'string' ? b.answer.trim() : '';
  const audience = b.audience == null || b.audience === '' ? 'all' : String(b.audience);
  const status = b.status == null || b.status === '' ? 'active' : String(b.status);
  const priority = b.priority == null || b.priority === '' ? 100 : Number(b.priority);

  if (question.length < 3) return { error: 'question is required (min 3 characters).' };
  if (answer.length < 3) return { error: 'answer is required (min 3 characters).' };
  if (!CUSTOM_AUDIENCES.includes(audience)) return { error: `audience must be one of ${CUSTOM_AUDIENCES.join(', ')}.` };
  if (!CUSTOM_STATUSES.includes(status)) return { error: `status must be one of ${CUSTOM_STATUSES.join(', ')}.` };
  if (!Number.isFinite(priority)) return { error: 'priority must be a number.' };

  const normalizedQuestion = toNormalizedQuestion(question);
  if (!normalizedQuestion) return { error: 'question could not be normalized.' };
  return { data: { question, answer, audience, status, priority: Math.trunc(priority), normalizedQuestion } };
}

// Finds the closest non-exact same-audience answer (>= SIMILAR_THRESHOLD), used to
// warn about possible duplicates. Excludes the row being edited.
async function findSimilarCustomAnswer(websiteId, normalizedQuestion, audience, excludeId) {
  const { items } = await listCustomAnswers({ websiteId, audience, limit: 2000 });
  let best = null;
  for (const it of items) {
    if (excludeId != null && it.id === Number(excludeId)) continue;
    if (it.normalizedQuestion === normalizedQuestion) continue; // exact handled separately
    const score = questionSimilarity(normalizedQuestion, it.normalizedQuestion);
    if (score >= SIMILAR_THRESHOLD && (!best || score > best.similarity)) {
      best = { id: it.id, question: it.question, audience: it.audience, similarity: Number(score.toFixed(2)) };
    }
  }
  return best;
}

router.get('/custom-answers', async (req, res) => {
  try {
    const website = await resolveWebsiteId();
    if (!website) return res.status(503).json({ error: 'Knowledge base is not ready.' });
    const { search, audience, status, limit, offset } = req.query;
    if (audience && !CUSTOM_AUDIENCES.includes(String(audience))) {
      return res.status(400).json({ error: `audience must be one of ${CUSTOM_AUDIENCES.join(', ')}.` });
    }
    if (status && !CUSTOM_STATUSES.includes(String(status))) {
      return res.status(400).json({ error: `status must be one of ${CUSTOM_STATUSES.join(', ')}.` });
    }
    const result = await listCustomAnswers({
      websiteId: website.id,
      search: search ? String(search).trim() : undefined,
      audience: audience ? String(audience) : undefined,
      status: status ? String(status) : undefined,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
    });
    return res.status(200).json({
      items: result.items,
      pagination: { limit: result.limit, offset: result.offset, total: result.total },
    });
  } catch (err) {
    logger.error({ err }, 'Admin custom-answers list failed');
    return res.status(500).json({ error: 'Failed to load custom answers.' });
  }
});

router.post('/custom-answers/check-duplicate', async (req, res) => {
  try {
    const website = await resolveWebsiteId();
    if (!website) return res.status(503).json({ error: 'Knowledge base is not ready.' });
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    const audience = req.body?.audience == null || req.body.audience === '' ? 'all' : String(req.body.audience);
    const excludeId = req.body?.excludeId != null ? Number(req.body.excludeId) : null;
    if (question.length < 3) return res.status(400).json({ error: 'question is required (min 3 characters).' });
    if (!CUSTOM_AUDIENCES.includes(audience)) return res.status(400).json({ error: 'invalid audience.' });

    const normalizedQuestion = toNormalizedQuestion(question);
    const exact = await checkDuplicateCustomAnswer({ websiteId: website.id, normalizedQuestion, audience, excludeId });
    const similar = exact ? null : await findSimilarCustomAnswer(website.id, normalizedQuestion, audience, excludeId);
    const matches = [];
    if (exact) matches.push({ id: exact.id, question: exact.question, audience: exact.audience, similarity: 1 });
    if (similar) matches.push(similar);
    return res.status(200).json({
      exactDuplicate: Boolean(exact),
      possibleDuplicate: Boolean(similar),
      matches,
    });
  } catch (err) {
    logger.error({ err }, 'Admin custom-answers check-duplicate failed');
    return res.status(500).json({ error: 'Failed to check duplicate.' });
  }
});

router.post('/custom-answers', async (req, res) => {
  try {
    const website = await resolveWebsiteId();
    if (!website) return res.status(503).json({ error: 'Knowledge base is not ready.' });
    const parsed = parseCustomAnswerBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { question, normalizedQuestion, answer, audience, status, priority } = parsed.data;

    // Exact duplicate -> block.
    const exact = await checkDuplicateCustomAnswer({ websiteId: website.id, normalizedQuestion, audience });
    if (exact) {
      return res.status(409).json({
        error: 'duplicate_question',
        message: 'This question is already added. Please edit the existing answer instead.',
        existing: { id: exact.id, question: exact.question, audience: exact.audience },
      });
    }
    // Similar duplicate -> require confirmation.
    if (req.body?.confirmSimilarDuplicate !== true) {
      const similar = await findSimilarCustomAnswer(website.id, normalizedQuestion, audience, null);
      if (similar) {
        return res.status(409).json({
          error: 'similar_question',
          message: 'A similar question already exists. Please confirm if you still want to add this as a separate answer.',
          canOverride: true,
          existing: similar,
        });
      }
    }

    const created = await createCustomAnswer({
      websiteId: website.id, question, normalizedQuestion, answer, audience, status, priority,
      createdBy: 'admin',
    });
    return res.status(201).json({ item: created });
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'duplicate_question', message: 'This question is already added.' });
    }
    logger.error({ err }, 'Admin custom-answers create failed');
    return res.status(500).json({ error: 'Failed to create custom answer.' });
  }
});

router.put('/custom-answers/:id', async (req, res) => {
  try {
    const website = await resolveWebsiteId();
    if (!website) return res.status(503).json({ error: 'Knowledge base is not ready.' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id.' });
    const existing = await getCustomAnswerById({ websiteId: website.id, id });
    if (!existing) return res.status(404).json({ error: 'Custom answer not found.' });

    const parsed = parseCustomAnswerBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { question, normalizedQuestion, answer, audience, status, priority } = parsed.data;

    // Re-check duplicates only when the matching key (question/audience) changed.
    if (normalizedQuestion !== existing.normalizedQuestion || audience !== existing.audience) {
      const dup = await checkDuplicateCustomAnswer({ websiteId: website.id, normalizedQuestion, audience, excludeId: id });
      if (dup) {
        return res.status(409).json({
          error: 'duplicate_question',
          message: 'This question is already added. Please edit the existing answer instead.',
          existing: { id: dup.id, question: dup.question, audience: dup.audience },
        });
      }
      if (req.body?.confirmSimilarDuplicate !== true) {
        const similar = await findSimilarCustomAnswer(website.id, normalizedQuestion, audience, id);
        if (similar) {
          return res.status(409).json({
            error: 'similar_question',
            message: 'A similar question already exists. Please confirm if you still want to keep this as a separate answer.',
            canOverride: true,
            existing: similar,
          });
        }
      }
    }

    const updated = await updateCustomAnswer({
      websiteId: website.id, id, question, normalizedQuestion, answer, audience, status, priority,
    });
    return res.status(200).json({ item: updated });
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'duplicate_question', message: 'This question is already added.' });
    }
    logger.error({ err }, 'Admin custom-answers update failed');
    return res.status(500).json({ error: 'Failed to update custom answer.' });
  }
});

router.delete('/custom-answers/:id', async (req, res) => {
  try {
    const website = await resolveWebsiteId();
    if (!website) return res.status(503).json({ error: 'Knowledge base is not ready.' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id.' });
    const deleted = await deleteCustomAnswer({ websiteId: website.id, id });
    if (!deleted) return res.status(404).json({ error: 'Custom answer not found.' });
    return res.status(200).json({ deleted: true });
  } catch (err) {
    logger.error({ err }, 'Admin custom-answers delete failed');
    return res.status(500).json({ error: 'Failed to delete custom answer.' });
  }
});

// Parses a body.ids array into a clean list of positive integers.
function parseIdList(raw) {
  if (!Array.isArray(raw)) return null;
  const ids = raw.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return ids;
}

router.post('/custom-answers/bulk-delete', async (req, res) => {
  try {
    const website = await resolveWebsiteId();
    if (!website) return res.status(503).json({ error: 'Knowledge base is not ready.' });
    const ids = parseIdList(req.body && req.body.ids);
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'ids (non-empty array) is required.' });
    const deleted = await bulkDeleteCustomAnswers({ websiteId: website.id, ids });
    return res.status(200).json({ deleted });
  } catch (err) {
    logger.error({ err }, 'Admin custom-answers bulk delete failed');
    return res.status(500).json({ error: 'Failed to delete custom answers.' });
  }
});

router.post('/custom-answers/bulk-status', async (req, res) => {
  try {
    const website = await resolveWebsiteId();
    if (!website) return res.status(503).json({ error: 'Knowledge base is not ready.' });
    const ids = parseIdList(req.body && req.body.ids);
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'ids (non-empty array) is required.' });
    const status = String(req.body && req.body.status);
    if (!CUSTOM_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${CUSTOM_STATUSES.join(', ')}.` });
    const updated = await bulkSetCustomAnswerStatus({ websiteId: website.id, ids, status });
    return res.status(200).json({ updated, status });
  } catch (err) {
    logger.error({ err }, 'Admin custom-answers bulk status failed');
    return res.status(500).json({ error: 'Failed to update custom answers.' });
  }
});

/* ---------- Custom Q&A autocomplete suggestions ---------- */

// name_search-style ranking. Returns a score (higher = better) or -1 to exclude
// when q is non-empty and the item does not match at all.
function rankEmail(item, q) {
  if (!q) return 0;
  const full = item.value.toLowerCase();
  const local = full.split('@')[0];
  const domain = full.split('@')[1] || '';
  if (full.startsWith(q)) return 4;
  if (local.startsWith(q)) return 3;
  if (domain.startsWith(q)) return 2;
  if (full.includes(q)) return 1;
  return -1;
}

function lastSlug(url) {
  const path = String(url || '').replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  return (path.split('/').filter(Boolean).pop() || '').toLowerCase();
}

function rankLink(item, q) {
  if (!q) return 0;
  const label = (item.label || '').toLowerCase();
  const url = (item.url || '').toLowerCase();
  const slug = lastSlug(item.url);
  if (label.startsWith(q)) return 4;
  if (slug.startsWith(q)) return 3;
  if (label.includes(q)) return 2;
  if (url.includes(q)) return 1;
  return -1;
}

// Applies ranking + filtering + limit. With empty q, keeps all in a stable order
// via tieBreak; with a query, drops non-matches and sorts best-first.
function rankAndLimit(items, q, rankFn, limit, tieBreak) {
  const scored = items
    .map((item) => ({ item, score: rankFn(item, q) }))
    .filter((s) => s.score >= 0);
  scored.sort((a, b) => (b.score - a.score) || tieBreak(a.item, b.item));
  return scored.slice(0, limit).map((s) => s.item);
}

function normalizeQ(raw, stripChar) {
  let q = String(raw ?? '').trim().toLowerCase();
  if (stripChar && q.startsWith(stripChar)) q = q.slice(stripChar.length);
  return q.trim();
}

router.get('/suggestions/emails', async (req, res) => {
  try {
    const website = await resolveWebsiteId();
    if (!website) return res.status(503).json({ error: 'Knowledge base is not ready.' });
    const q = normalizeQ(req.query.q, '@');
    const emails = await getWebsiteEmails(website.id);
    const items = rankAndLimit(emails, q, rankEmail, 20, (a, b) => a.value.localeCompare(b.value));
    return res.status(200).json({ items });
  } catch (err) {
    logger.error({ err }, 'Admin email suggestions failed');
    return res.status(500).json({ error: 'Failed to load email suggestions.' });
  }
});

router.get('/suggestions/links', async (req, res) => {
  try {
    const website = await resolveWebsiteId();
    if (!website) return res.status(503).json({ error: 'Knowledge base is not ready.' });
    const q = normalizeQ(req.query.q, '/');
    const links = await getWebsiteLinks(website.id);
    // Empty-q order: page-sourced first, then shortest URL (core pages on top).
    const tieBreak = (a, b) => {
      const pa = a.source === 'page' ? 0 : 1;
      const pb = b.source === 'page' ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return (a.url || '').length - (b.url || '').length;
    };
    const items = rankAndLimit(links, q, rankLink, 30, tieBreak);
    return res.status(200).json({ items });
  } catch (err) {
    logger.error({ err }, 'Admin link suggestions failed');
    return res.status(500).json({ error: 'Failed to load link suggestions.' });
  }
});

export default router;
