-- Allow name-only leads: the conversational widget now asks for the visitor's
-- name first (before any email), so a lead row may exist with only a name.
ALTER TABLE chat_leads ALTER COLUMN email DROP NOT NULL;
