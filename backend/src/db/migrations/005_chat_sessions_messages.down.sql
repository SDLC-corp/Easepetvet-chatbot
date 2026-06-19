-- Reverses 005. Removes the added columns/index; leaves the original 001 tables.

ALTER TABLE chat_messages DROP COLUMN IF EXISTS metadata;
DROP INDEX IF EXISTS idx_chat_sessions_session_id;
ALTER TABLE chat_sessions DROP COLUMN IF EXISTS updated_at;
ALTER TABLE chat_sessions DROP COLUMN IF EXISTS session_id;
