import { pool } from '../db/pool.js';

// Read-only retrieval SQL, separate from the write repositories. Every query is
// scoped by website_id and uses parameterized values.

// Full-text search over all of a website's page_chunks, ranked by ts_rank.
export async function searchChunks(websiteId, query, limit = 5) {
  const { rows } = await pool.query(
    `SELECT pc.chunk_text, pc.chunk_index, p.id AS page_id, p.url, p.title,
            ts_rank(to_tsvector('english', pc.chunk_text),
                    plainto_tsquery('english', $2)) AS rank
     FROM page_chunks pc
     JOIN pages p ON p.id = pc.page_id
     WHERE p.website_id = $1
       AND to_tsvector('english', pc.chunk_text) @@ plainto_tsquery('english', $2)
     ORDER BY rank DESC, pc.chunk_index
     LIMIT $3`,
    [websiteId, query, limit],
  );
  return rows;
}

// Full-text search restricted to a single page's chunks, ranked by ts_rank.
export async function searchPageChunks(websiteId, pageId, query, limit = 5) {
  const { rows } = await pool.query(
    `SELECT pc.chunk_text, pc.chunk_index, p.id AS page_id, p.url, p.title,
            ts_rank(to_tsvector('english', pc.chunk_text),
                    plainto_tsquery('english', $3)) AS rank
     FROM page_chunks pc
     JOIN pages p ON p.id = pc.page_id
     WHERE p.website_id = $1 AND pc.page_id = $2
       AND to_tsvector('english', pc.chunk_text) @@ plainto_tsquery('english', $3)
     ORDER BY rank DESC, pc.chunk_index
     LIMIT $4`,
    [websiteId, pageId, query, limit],
  );
  return rows;
}

// Returns a page's opening chunks (used when in-page FTS finds nothing).
export async function getFirstPageChunks(websiteId, pageId, limit = 3) {
  const { rows } = await pool.query(
    `SELECT pc.chunk_text, pc.chunk_index, p.id AS page_id, p.url, p.title
     FROM page_chunks pc
     JOIN pages p ON p.id = pc.page_id
     WHERE p.website_id = $1 AND pc.page_id = $2
     ORDER BY pc.chunk_index
     LIMIT $3`,
    [websiteId, pageId, limit],
  );
  return rows;
}

// Locates pages by ILIKE matching any term, ranked by a weighted relevance score
// that boosts url/title/h1 over meta_description.
export async function findPagesByKeyword(websiteId, terms, limit = 5) {
  if (!terms || terms.length === 0) return [];

  const params = [websiteId];
  const matchClauses = [];
  const scoreParts = [];
  for (const term of terms) {
    params.push(`%${term}%`);
    const i = params.length;
    matchClauses.push(
      `(p.url ILIKE $${i} OR p.title ILIKE $${i} OR p.h1 ILIKE $${i} OR p.meta_description ILIKE $${i})`,
    );
    scoreParts.push(
      `(CASE WHEN p.url ILIKE $${i} THEN 3 ELSE 0 END
        + CASE WHEN p.title ILIKE $${i} THEN 2 ELSE 0 END
        + CASE WHEN p.h1 ILIKE $${i} THEN 2 ELSE 0 END
        + CASE WHEN p.meta_description ILIKE $${i} THEN 1 ELSE 0 END)`,
    );
  }
  params.push(limit);
  const limitIndex = params.length;

  const { rows } = await pool.query(
    `SELECT p.id, p.url, p.title, p.h1, p.meta_description,
            (${scoreParts.join(' + ')}) AS score
     FROM pages p
     WHERE p.website_id = $1 AND (${matchClauses.join(' OR ')})
     ORDER BY score DESC, length(p.url)
     LIMIT $${limitIndex}`,
    params,
  );
  return rows;
}

// Finds the best page for a slug: prefer the exact main page (path is exactly
// /<slug>/, compared against the website's base_url, trailing-slash-insensitive)
// before any partial url/title/h1 match.
export async function findPageBySlug(websiteId, slug) {
  const exact = await pool.query(
    `SELECT p.id, p.url, p.title, p.h1, p.meta_description, p.clean_text
     FROM pages p
     JOIN websites w ON w.id = p.website_id
     WHERE p.website_id = $1
       AND rtrim(p.url, '/') = rtrim(w.base_url || $2, '/')
     LIMIT 1`,
    [websiteId, slug],
  );
  if (exact.rows[0]) return exact.rows[0];

  const partial = await pool.query(
    `SELECT id, url, title, h1, meta_description, clean_text
     FROM pages
     WHERE website_id = $1
       AND (url ILIKE '%' || $2 || '%' OR title ILIKE '%' || $2 || '%' OR h1 ILIKE '%' || $2 || '%')
     ORDER BY length(url)
     LIMIT 1`,
    [websiteId, slug],
  );
  return partial.rows[0] ?? null;
}

// Returns facts for a key, scoped by website. options.pageId restricts to one
// page (precise); else options.slug restricts to pages whose url/title/h1 match
// the slug. Default limit is high enough for list facts (links, headings, ...).
export async function getFactsByKey(websiteId, factKey, options = {}) {
  const { slug, pageId, limit = 20 } = options;

  const params = [websiteId, factKey];
  let filter = '';
  if (pageId) {
    params.push(pageId);
    filter = `AND pf.page_id = $${params.length}`;
  } else if (slug) {
    params.push(`%${slug}%`);
    const i = params.length;
    filter = `AND (p.url ILIKE $${i} OR p.title ILIKE $${i} OR p.h1 ILIKE $${i})`;
  }
  params.push(limit);
  const limitIndex = params.length;

  const { rows } = await pool.query(
    `SELECT pf.fact_value, p.url, p.title
     FROM page_facts pf
     JOIN pages p ON p.id = pf.page_id
     WHERE p.website_id = $1 AND pf.fact_key = $2 ${filter}
     ORDER BY p.url
     LIMIT $${limitIndex}`,
    params,
  );
  return rows;
}
