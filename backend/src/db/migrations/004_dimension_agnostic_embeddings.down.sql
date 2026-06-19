-- Reverses 004. Restores the fixed 1536 dimension. Only valid if no rows with a
-- different dimension exist.

ALTER TABLE page_chunk_embeddings ALTER COLUMN embedding TYPE vector(1536);
