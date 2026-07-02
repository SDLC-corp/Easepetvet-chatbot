import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { encryptField, decryptField } from '../shared/crypto/field-crypto.js';

// SQL for chat sessions and messages. The public session token lives on
// chat_sessions.session_id (TEXT); messages link via the existing BIGINT
// chat_sessions.id foreign key.

const VALID_AUDIENCES = ['pet_parent', 'vet', 'unknown'];

function normalizeAudience(audience) {
  return VALID_AUDIENCES.includes(audience) ? audience : 'unknown';
}

// Finds the session by its public token, or creates a new one (crypto.randomUUID
// when no token is supplied). Returns the DB row id and the public session_id.
export async function resolveOrCreateSession(publicId, audience) {
  const normalized = normalizeAudience(audience);

  if (publicId) {
    const { rows } = await pool.query(
      'SELECT id, session_id FROM chat_sessions WHERE session_id = $1',
      [publicId],
    );
    if (rows[0]) {
      // Only upgrade audience; never downgrade a detected audience back to
      // 'unknown' (intent detection sets it, later 'unknown' calls must not clobber).
      await pool.query(
        "UPDATE chat_sessions SET audience = CASE WHEN $2 <> 'unknown' THEN $2 ELSE audience END, updated_at = now() WHERE id = $1",
        [rows[0].id, normalized],
      );
      const { rows: cur } = await pool.query('SELECT audience FROM chat_sessions WHERE id = $1', [rows[0].id]);
      return { id: rows[0].id, sessionId: rows[0].session_id, audience: cur[0] ? cur[0].audience : normalized };
    }
  }

  const sessionId = publicId || randomUUID();
  const { rows } = await pool.query(
    'INSERT INTO chat_sessions (session_id, audience) VALUES ($1, $2) RETURNING id, session_id, audience',
    [sessionId, normalized],
  );
  return { id: rows[0].id, sessionId: rows[0].session_id, audience: rows[0].audience };
}

export async function insertMessage(sessionRowId, role, content, metadata = {}) {
  // Message content is confidential -> encrypted at rest (decrypted on read in
  // getRecentMessages and the admin repository).
  await pool.query(
    'INSERT INTO chat_messages (session_id, role, content, metadata) VALUES ($1, $2, $3, $4::jsonb)',
    [sessionRowId, role, encryptField(content), JSON.stringify(metadata)],
  );
}

// Loads the most recent user/assistant turns for a session, oldest -> newest, so
// they can be threaded into retrieval and the LLM as conversation memory. Call
// this BEFORE inserting the current user message so the result is prior turns
// only (no off-by-one, no trailing duplicate of the message being answered).
export async function getRecentMessages(sessionRowId, limit) {
  const capped = Math.min(Math.max(Number(limit) || 0, 0), 20);
  if (capped === 0) return [];
  const { rows } = await pool.query(
    `SELECT role, content FROM chat_messages
       WHERE session_id = $1 AND role IN ('user', 'assistant')
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
    [sessionRowId, capped],
  );
  // Decrypt content back to plaintext for use as conversation memory.
  return rows.reverse().map((r) => ({ role: r.role, content: decryptField(r.content) }));
}

// Counts accepted user questions in a session (role='user' only). Bot replies,
// greetings, validation errors, and email prompts are never stored as 'user',
// so they are naturally excluded from the conversation limit.
export async function countUserMessages(sessionRowId) {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS count FROM chat_messages WHERE session_id = $1 AND role = 'user'",
    [sessionRowId],
  );
  return rows[0]?.count ?? 0;
}
