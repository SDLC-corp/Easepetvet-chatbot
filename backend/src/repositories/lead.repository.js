import { pool } from '../db/pool.js';
import { encryptField, decryptField, emailHash } from '../shared/crypto/field-crypto.js';

// Persists conversational lead capture. One row per chat session: a resubmit for
// the same session updates the existing row (ON CONFLICT) instead of adding a
// duplicate. The email and phone are encrypted at rest (field-crypto); a keyed
// email hash is stored alongside so the admin can still search by exact email.

// Returns the email captured for a session, or null. Used to decide whether the
// in-chat email prompt should still be shown.
export async function getSessionEmail(sessionRowId) {
  const { rows } = await pool.query(
    'SELECT email FROM chat_leads WHERE session_id = $1',
    [sessionRowId],
  );
  return rows[0] ? decryptField(rows[0].email) : null;
}

// General conversational lead upsert: any subset of name / email / phone for a
// session, one row per session. Rules:
//  - real name (nameIsDerived=false) overwrites the stored name;
//  - a name derived from an email (nameIsDerived=true) is saved only when there is
//    no existing name, so a real name is never clobbered by a derived one;
//  - email / phone are updated when provided, otherwise the existing value stays
//    (COALESCE), so a later email save doesn't wipe an earlier phone and vice versa;
//  - audience is upgraded (never downgraded to 'unknown').
// Email + phone are encrypted at rest; a keyed email hash powers exact search.
export async function upsertSessionLead({ websiteId, sessionRowId, name, email, phone, audience, nameIsDerived }) {
  const encEmail = email ? encryptField(email) : null;
  const emlHash = email ? emailHash(email) : null;
  const encPhone = phone ? encryptField(phone) : null;
  const derived = nameIsDerived === true;
  await pool.query(
    `INSERT INTO chat_leads (website_id, session_id, name, email, email_hash, phone, audience)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (session_id) DO UPDATE SET
       name = CASE
                WHEN $8 = false AND $3 IS NOT NULL AND $3 <> '' THEN $3
                WHEN $8 = true  AND (chat_leads.name IS NULL OR chat_leads.name = '') THEN $3
                ELSE chat_leads.name
              END,
       email = COALESCE($4, chat_leads.email),
       email_hash = COALESCE($5, chat_leads.email_hash),
       phone = COALESCE($6, chat_leads.phone),
       audience = CASE WHEN $7 <> 'unknown' THEN $7 ELSE chat_leads.audience END,
       website_id = EXCLUDED.website_id,
       updated_at = now()`,
    [websiteId ?? null, sessionRowId ?? null, name ?? null, encEmail, emlHash, encPhone, audience || 'unknown', derived],
  );
}
