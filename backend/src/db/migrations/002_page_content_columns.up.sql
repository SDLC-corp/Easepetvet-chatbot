-- Adds page content columns needed by the ingestion pipeline.
-- raw_html: original fetched HTML; clean_text: cleaned plain text;
-- meta_description and h1: core single-value attributes stored as typed columns.

ALTER TABLE pages ADD COLUMN IF NOT EXISTS raw_html TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS clean_text TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS meta_description TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS h1 TEXT;
