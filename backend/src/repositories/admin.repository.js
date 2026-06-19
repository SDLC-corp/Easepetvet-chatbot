import { pool } from '../db/pool.js';

// Read-only queries that power the admin dashboard. All SQL is parameterized.
// Only the public session token (chat_sessions.session_id) is exposed, never the
// internal bigint id.

const PREVIEW_LEN = 140;

export async function getSummary(websiteId) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*) FROM chat_sessions) AS total_chats,
       (SELECT count(*) FROM chat_leads) AS total_leads,
       (SELECT count(*) FROM chat_messages) AS total_messages,
       (SELECT count(*) FROM pages WHERE website_id = $1) AS total_pages,
       (SELECT count(*) FROM page_chunks pc JOIN pages p ON p.id = pc.page_id
          WHERE p.website_id = $1) AS total_chunks,
       w.last_sync_status, w.last_sync_started_at, w.last_sync_completed_at,
       w.next_sync_at, w.last_sync_error
     FROM websites w
     WHERE w.id = $1`,
    [websiteId],
  );
  const r = rows[0] ?? {};
  return {
    totalChats: Number(r.total_chats ?? 0),
    totalLeads: Number(r.total_leads ?? 0),
    totalMessages: Number(r.total_messages ?? 0),
    totalPages: Number(r.total_pages ?? 0),
    totalChunks: Number(r.total_chunks ?? 0),
    sync: {
      lastStatus: r.last_sync_status ?? 'never',
      lastStartedAt: r.last_sync_started_at ?? null,
      lastCompletedAt: r.last_sync_completed_at ?? null,
      nextSyncAt: r.next_sync_at ?? null,
      lastError: r.last_sync_error ?? null,
    },
  };
}

// Builds the shared WHERE clause + params for listChats and its count query.
function buildChatFilters({ search, audience, dateFrom, dateTo }) {
  const clauses = [];
  const params = [];
  if (audience) {
    params.push(audience);
    clauses.push(`s.audience = $${params.length}`);
  }
  if (dateFrom) {
    params.push(dateFrom);
    clauses.push(`s.created_at >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    clauses.push(`s.created_at <= $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    clauses.push(
      `(l.name ILIKE ${p} OR l.email ILIKE ${p} OR l.phone ILIKE ${p}
        OR EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = s.id AND m.content ILIKE ${p}))`,
    );
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

export async function listChats({ page = 1, limit = 20, search, audience, dateFrom, dateTo } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);
  const offset = (safePage - 1) * safeLimit;

  const { where, params } = buildChatFilters({ search, audience, dateFrom, dateTo });

  const countRes = await pool.query(
    `SELECT count(*)::int AS total
     FROM chat_sessions s
     LEFT JOIN chat_leads l ON l.session_id = s.id
     ${where}`,
    params,
  );
  const total = countRes.rows[0]?.total ?? 0;

  const listParams = [...params, safeLimit, offset];
  const { rows } = await pool.query(
    `SELECT s.session_id, s.audience, s.created_at, s.updated_at,
            l.name, l.email, l.phone,
            mc.message_count,
            lm.last_message_at, lm.last_message_preview
     FROM chat_sessions s
     LEFT JOIN chat_leads l ON l.session_id = s.id
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS message_count FROM chat_messages m WHERE m.session_id = s.id
     ) mc ON true
     LEFT JOIN LATERAL (
       SELECT m.created_at AS last_message_at, left(m.content, ${PREVIEW_LEN}) AS last_message_preview
       FROM chat_messages m WHERE m.session_id = s.id
       ORDER BY m.created_at DESC LIMIT 1
     ) lm ON true
     ${where}
     ORDER BY COALESCE(lm.last_message_at, s.created_at) DESC
     LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams,
  );

  const items = rows.map((row) => ({
    sessionId: row.session_id,
    name: row.name ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    audience: row.audience,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at ?? null,
    lastMessagePreview: row.last_message_preview ?? null,
    messageCount: row.message_count ?? 0,
  }));

  return { page: safePage, limit: safeLimit, total, items };
}

// Keep only non-sensitive metadata fields in chat detail.
function safeMetadata(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const { type, provider, mode, found, fallbackReason } = meta;
  return { type, provider, mode, found, fallbackReason };
}

export async function getChatDetail(sessionToken) {
  const sessionRes = await pool.query(
    `SELECT id, session_id, audience, created_at, updated_at
     FROM chat_sessions WHERE session_id = $1`,
    [sessionToken],
  );
  const session = sessionRes.rows[0];
  if (!session) return null;

  const leadRes = await pool.query(
    `SELECT name, email, phone, audience, created_at
     FROM chat_leads WHERE session_id = $1`,
    [session.id],
  );

  const msgRes = await pool.query(
    `SELECT role, content, metadata, created_at
     FROM chat_messages WHERE session_id = $1
     ORDER BY created_at ASC`,
    [session.id],
  );

  const lead = leadRes.rows[0]
    ? {
        name: leadRes.rows[0].name,
        email: leadRes.rows[0].email,
        phone: leadRes.rows[0].phone,
        audience: leadRes.rows[0].audience,
        createdAt: leadRes.rows[0].created_at,
      }
    : null;

  return {
    session: {
      sessionId: session.session_id,
      audience: session.audience,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
    },
    lead,
    messages: msgRes.rows.map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.created_at,
      metadata: safeMetadata(m.metadata),
    })),
    messageCount: msgRes.rows.length,
  };
}
