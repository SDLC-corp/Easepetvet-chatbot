-- Restore NOT NULL. Any name-only leads (email IS NULL) get an empty-string email
-- so the constraint can be re-applied.
UPDATE chat_leads SET email = '' WHERE email IS NULL;
ALTER TABLE chat_leads ALTER COLUMN email SET NOT NULL;
