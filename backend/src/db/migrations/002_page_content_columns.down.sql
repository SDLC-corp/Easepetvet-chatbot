-- Reverses 002_page_content_columns.up.sql. Drops the added columns in reverse
-- order of how they were added.

ALTER TABLE pages DROP COLUMN IF EXISTS h1;
ALTER TABLE pages DROP COLUMN IF EXISTS meta_description;
ALTER TABLE pages DROP COLUMN IF EXISTS clean_text;
ALTER TABLE pages DROP COLUMN IF EXISTS raw_html;
