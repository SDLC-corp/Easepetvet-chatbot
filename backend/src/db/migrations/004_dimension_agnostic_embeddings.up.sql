-- Makes the embedding column dimension-agnostic so providers with different
-- output sizes (e.g. Gemini 768) can be stored. Safe while no embeddings exist.
-- Vector comparisons stay dimension-safe because queries filter by
-- provider + model + dimension.

ALTER TABLE page_chunk_embeddings ALTER COLUMN embedding TYPE vector;
