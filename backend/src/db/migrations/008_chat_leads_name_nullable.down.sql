DROP INDEX IF EXISTS idx_chat_leads_session_id_unique;

UPDATE chat_leads SET name = '' WHERE name IS NULL;
ALTER TABLE chat_leads ALTER COLUMN name SET NOT NULL;
