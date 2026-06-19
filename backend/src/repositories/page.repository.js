import { pool } from '../db/pool.js';

// All SQL for the pages table. Upsert keyed on (website_id, url): re-ingesting a
// page overwrites its stored snapshot. Returns the page id.

export async function upsertPage(page) {
  const {
    websiteId,
    url,
    title,
    httpStatus,
    fetchedAt,
    rawHtml,
    cleanText,
    metaDescription,
    h1,
  } = page;

  const { rows } = await pool.query(
    `INSERT INTO pages (website_id, url, title, http_status, fetched_at,
       raw_html, clean_text, meta_description, h1)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (website_id, url) DO UPDATE SET
       title = EXCLUDED.title,
       http_status = EXCLUDED.http_status,
       fetched_at = EXCLUDED.fetched_at,
       raw_html = EXCLUDED.raw_html,
       clean_text = EXCLUDED.clean_text,
       meta_description = EXCLUDED.meta_description,
       h1 = EXCLUDED.h1
     RETURNING id`,
    [websiteId, url, title, httpStatus, fetchedAt, rawHtml, cleanText, metaDescription, h1],
  );
  return rows[0].id;
}
