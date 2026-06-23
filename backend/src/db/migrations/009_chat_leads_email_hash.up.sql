-- Adds a keyed-hash column for the (now encrypted) email so the admin can still
-- find a lead by exact email address. The email/phone values themselves are
-- encrypted at the application layer; this hash is a deterministic HMAC.
ALTER TABLE chat_leads ADD COLUMN IF NOT EXISTS email_hash text;
CREATE INDEX IF NOT EXISTS idx_chat_leads_email_hash ON chat_leads(email_hash);
