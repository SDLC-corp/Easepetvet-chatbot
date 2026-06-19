-- Allow email-only leads (captured by the in-chat email prompt, which has no
-- name). Migration 006 already created a UNIQUE index on session_id
-- (idx_chat_leads_session); the defensive index below is a no-op safeguard so
-- ON CONFLICT (session_id) always has a unique index to infer from.

ALTER TABLE chat_leads ALTER COLUMN name DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_leads_session_id_unique ON chat_leads(session_id);
