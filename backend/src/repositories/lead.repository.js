import { pool } from '../db/pool.js';

// Persists widget lead-capture submissions. One row per chat session: a resubmit
// for the same session updates the existing row (ON CONFLICT) instead of adding
// a duplicate.

export async function upsertLead({ websiteId, sessionRowId, name, email, phone, audience }) {
  const { rows } = await pool.query(
    `INSERT INTO chat_leads (website_id, session_id, name, email, phone, audience)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (session_id) DO UPDATE SET
       name = EXCLUDED.name,
       email = EXCLUDED.email,
       phone = EXCLUDED.phone,
       audience = EXCLUDED.audience,
       website_id = EXCLUDED.website_id,
       updated_at = now()
     RETURNING id`,
    [websiteId ?? null, sessionRowId ?? null, name, email, phone ?? null, audience],
  );
  return rows[0].id;
}

// Returns the email captured for a session, or null. Used to decide whether the
// in-chat email prompt should still be shown.
export async function getSessionEmail(sessionRowId) {
  const { rows } = await pool.query(
    'SELECT email FROM chat_leads WHERE session_id = $1',
    [sessionRowId],
  );
  return rows[0]?.email ?? null;
}

// Attaches (or updates) an email for an existing session without requiring a
// name. Leaves any existing name/phone intact on conflict. Does not create or
// reset the chat session.
export async function upsertSessionEmail({ websiteId, sessionRowId, email, phone, audience }) {
  await pool.query(
    `INSERT INTO chat_leads (website_id, session_id, email, phone, audience)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (session_id) DO UPDATE SET
       email = EXCLUDED.email,
       phone = COALESCE(EXCLUDED.phone, chat_leads.phone),
       website_id = EXCLUDED.website_id,
       audience = CASE WHEN EXCLUDED.audience <> 'unknown' THEN EXCLUDED.audience ELSE chat_leads.audience END,
       updated_at = now()`,
    [websiteId ?? null, sessionRowId ?? null, email, phone ?? null, audience || 'unknown'],
  );
}
