import { pool } from '../db/pool.js';

// All SQL for the websites table. No business logic, no logging; errors from pg
// propagate to the caller.

export async function ensureWebsite(baseUrl, name) {
  const { rows } = await pool.query(
    `INSERT INTO websites (base_url, name)
     VALUES ($1, $2)
     ON CONFLICT (base_url) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [baseUrl, name],
  );
  return rows[0].id;
}

export async function getWebsiteByBaseUrl(baseUrl) {
  const { rows } = await pool.query(
    'SELECT * FROM websites WHERE base_url = $1',
    [baseUrl],
  );
  return rows[0] ?? null;
}
