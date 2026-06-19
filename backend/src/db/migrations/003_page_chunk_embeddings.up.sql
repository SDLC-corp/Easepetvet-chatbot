-- Adds pgvector and a table to store embeddings for page chunks (search only).
-- One row per (chunk, provider, model). No ANN index here; exact scan is fine at
-- this scale, and an HNSW/IVFFlat index can be a later migration.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE page_chunk_embeddings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  page_chunk_id BIGINT NOT NULL REFERENCES page_chunks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  embedding vector(1536) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (page_chunk_id, provider, model)
);

CREATE INDEX idx_pce_page_chunk_id ON page_chunk_embeddings(page_chunk_id);
CREATE INDEX idx_pce_provider_model ON page_chunk_embeddings(provider, model);
