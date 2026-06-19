import { pool } from '../db/pool.js';

// All SQL for the page_chunks table. Replace semantics: a page's chunks are
// deleted and re-inserted in one transaction so re-ingestion never accumulates
// stale chunks. Stores chunk_text only (no embeddings). Returns the number of
// chunks inserted.

export async function replacePageChunks(pageId, chunks) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM page_chunks WHERE page_id = $1', [pageId]);

    let inserted = 0;
    if (chunks && chunks.length > 0) {
      const params = [pageId];
      const valueTuples = chunks.map((chunk, index) => {
        params.push(chunk.chunkIndex, chunk.chunkText);
        return `($1, $${index * 2 + 2}, $${index * 2 + 3})`;
      });
      const result = await client.query(
        `INSERT INTO page_chunks (page_id, chunk_index, chunk_text)
         VALUES ${valueTuples.join(', ')}`,
        params,
      );
      inserted = result.rowCount;
    }

    await client.query('COMMIT');
    return inserted;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
