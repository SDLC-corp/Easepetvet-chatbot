import { pool } from '../db/pool.js';

// Read/write SQL for page_chunk_embeddings. Every query is scoped by website_id
// and parameterized. Vectors are formatted as pgvector '[...]' literals (no
// pgvector npm package).

// Validates a numeric embedding array and formats it as a pgvector literal.
function toVectorLiteral(embedding) {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('Embedding must be a non-empty numeric array.');
  }
  for (const value of embedding) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('Embedding must contain only finite numbers.');
    }
  }
  return `[${embedding.join(',')}]`;
}

// Chunks for a website with no embedding for (provider, model, dimension), or
// whose stored content_hash no longer matches md5(chunk_text).
export async function findChunksNeedingEmbedding(websiteId, provider, model, dimension, limit) {
  const { rows } = await pool.query(
    `SELECT pc.id AS page_chunk_id, p.id AS page_id, p.url, p.title,
            pc.chunk_index, pc.chunk_text, md5(pc.chunk_text) AS content_hash
     FROM page_chunks pc
     JOIN pages p ON p.id = pc.page_id
     LEFT JOIN page_chunk_embeddings e
       ON e.page_chunk_id = pc.id AND e.provider = $2 AND e.model = $3 AND e.dimension = $4
     WHERE p.website_id = $1
       AND (e.id IS NULL OR e.content_hash <> md5(pc.chunk_text))
     ORDER BY pc.id
     LIMIT $5`,
    [websiteId, provider, model, dimension, limit],
  );
  return rows.map((row) => ({
    pageChunkId: row.page_chunk_id,
    pageId: row.page_id,
    url: row.url,
    title: row.title,
    chunkIndex: row.chunk_index,
    chunkText: row.chunk_text,
    contentHash: row.content_hash,
  }));
}

// Inserts or updates one chunk's embedding for (provider, model).
export async function upsertEmbedding({ pageChunkId, provider, model, dimension, contentHash, embedding }) {
  await pool.query(
    `INSERT INTO page_chunk_embeddings
       (page_chunk_id, provider, model, dimension, content_hash, embedding)
     VALUES ($1, $2, $3, $4, $5, $6::vector)
     ON CONFLICT (page_chunk_id, provider, model) DO UPDATE SET
       dimension = EXCLUDED.dimension,
       content_hash = EXCLUDED.content_hash,
       embedding = EXCLUDED.embedding,
       updated_at = now()`,
    [pageChunkId, provider, model, dimension, contentHash, toVectorLiteral(embedding)],
  );
}

// Counts for the active provider/model/dimension: total chunks, current
// embeddings, missing, and stale (hash mismatch).
export async function getEmbeddingStatus(websiteId, provider, model, dimension) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE e.id IS NOT NULL AND e.content_hash = md5(pc.chunk_text))::int AS embedded_current,
       COUNT(*) FILTER (WHERE e.id IS NULL)::int AS missing,
       COUNT(*) FILTER (WHERE e.id IS NOT NULL AND e.content_hash <> md5(pc.chunk_text))::int AS stale
     FROM page_chunks pc
     JOIN pages p ON p.id = pc.page_id
     LEFT JOIN page_chunk_embeddings e
       ON e.page_chunk_id = pc.id AND e.provider = $2 AND e.model = $3 AND e.dimension = $4
     WHERE p.website_id = $1`,
    [websiteId, provider, model, dimension],
  );
  const row = rows[0];
  return {
    totalChunks: row.total,
    embeddedCurrent: row.embedded_current,
    missing: row.missing,
    stale: row.stale,
  };
}

// Deletes embedding rows only (never chunks/pages/facts/websites/crawl jobs).
// With no options, clears ALL page_chunk_embeddings; with provider/model, scopes
// the delete. Returns the number of rows deleted.
export async function deleteEmbeddings({ provider, model } = {}) {
  const conditions = [];
  const params = [];
  if (provider) {
    params.push(provider);
    conditions.push(`provider = $${params.length}`);
  }
  if (model) {
    params.push(model);
    conditions.push(`model = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rowCount } = await pool.query(`DELETE FROM page_chunk_embeddings ${where}`, params);
  return rowCount;
}

// Cosine-similarity search over a website's chunk embeddings. score = 1 - cosine
// distance (higher is more similar).
export async function searchSimilarChunks(websiteId, provider, model, dimension, queryEmbedding, limit) {
  const queryVector = toVectorLiteral(queryEmbedding);
  const { rows } = await pool.query(
    `SELECT pc.chunk_text, pc.chunk_index, p.id AS page_id, p.url, p.title,
            1 - (e.embedding <=> $5::vector) AS score
     FROM page_chunk_embeddings e
     JOIN page_chunks pc ON pc.id = e.page_chunk_id
     JOIN pages p ON p.id = pc.page_id
     WHERE p.website_id = $1 AND e.provider = $2 AND e.model = $3 AND e.dimension = $4
     ORDER BY e.embedding <=> $5::vector
     LIMIT $6`,
    [websiteId, provider, model, dimension, queryVector, limit],
  );
  return rows.map((row) => ({
    chunkText: row.chunk_text,
    chunkIndex: row.chunk_index,
    pageId: row.page_id,
    url: row.url,
    title: row.title,
    score: row.score,
  }));
}
