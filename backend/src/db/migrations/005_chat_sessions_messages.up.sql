-- Extends the existing chat tables (from 001) for the chat API. Reuses the
-- BIGINT keys; adds a public TEXT session token and message metadata. ALTERs
-- only (does not recreate).

ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS session_id TEXT;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill any pre-existing rows so the unique index can be created safely.
UPDATE chat_sessions SET session_id = 'legacy-' || id::text WHERE session_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_session_id ON chat_sessions(session_id);

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
