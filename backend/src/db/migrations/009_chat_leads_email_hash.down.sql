DROP INDEX IF EXISTS idx_chat_leads_email_hash;
ALTER TABLE chat_leads DROP COLUMN IF EXISTS email_hash;
