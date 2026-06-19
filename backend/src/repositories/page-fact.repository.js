import { pool } from '../db/pool.js';

// All SQL for the page_facts table. Replace semantics: a page's facts are
// deleted and re-inserted in one transaction so re-ingestion never accumulates
// stale facts. Returns the number of facts inserted.

export async function replacePageFacts(pageId, facts) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM page_facts WHERE page_id = $1', [pageId]);

    let inserted = 0;
    if (facts && facts.length > 0) {
      const params = [pageId];
      const valueTuples = facts.map((fact, index) => {
        params.push(fact.key, fact.value);
        return `($1, $${index * 2 + 2}, $${index * 2 + 3})`;
      });
      const result = await client.query(
        `INSERT INTO page_facts (page_id, fact_key, fact_value)
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
