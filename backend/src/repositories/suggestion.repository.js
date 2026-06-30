import { pool } from '../db/pool.js';

// Read-only, website-scoped sources for the admin Custom Q&A autocomplete:
// emails and links collected from already-stored website data (page facts, page
// clean_text, page URLs/titles). Never invents values; never reads secrets.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const EMAIL_RE_G = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Extracts a single clean email from an over-captured value
// ("brandy@easepetvet.com.4" -> "brandy@easepetvet.com"). Returns null if none.
function cleanEmail(value) {
  const m = EMAIL_RE.exec(String(value ?? ''));
  return m ? m[0].toLowerCase() : null;
}

// Distinct website emails from email facts + a regex scan of page clean_text.
// Deduped case-insensitively. Returns [{ value, label, source:'website' }].
export async function getWebsiteEmails(websiteId) {
  const { rows } = await pool.query(
    `SELECT pf.fact_value AS raw
       FROM page_facts pf JOIN pages p ON p.id = pf.page_id
      WHERE p.website_id = $1 AND pf.fact_key = 'email'
     UNION ALL
     SELECT p.clean_text AS raw
       FROM pages p
      WHERE p.website_id = $1 AND p.clean_text IS NOT NULL`,
    [websiteId],
  );

  const seen = new Map();
  for (const row of rows) {
    const raw = String(row.raw ?? '');
    // Email facts hold one address; clean_text may hold several, so scan globally.
    const matches = raw.match(EMAIL_RE_G) || [];
    for (const match of matches) {
      const email = cleanEmail(match);
      if (email && !seen.has(email)) seen.set(email, { value: email, label: email, source: 'website' });
    }
  }
  return [...seen.values()];
}

// Strips a trailing site-name suffix from a page title ("Pricing - Ease Pet Vet"
// -> "Pricing") so the label reads cleanly.
function cleanTitle(title) {
  if (!title) return '';
  return String(title).replace(/\s*[|\-–—]\s*Ease Pet Vet\s*$/i, '').trim();
}

// Last non-empty path segment of a URL, used as a label fallback and for ranking.
function urlSlug(url) {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '');
    const seg = path.split('/').filter(Boolean).pop() || '';
    return seg.toLowerCase();
  } catch (e) {
    return '';
  }
}

// Normalized dedup key: lowercase origin + path, trailing-slash-insensitive.
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return (u.origin + u.pathname).replace(/\/+$/, '').toLowerCase();
  } catch (e) {
    return String(url ?? '').replace(/\/+$/, '').toLowerCase();
  }
}

function prettyFromSlug(slug) {
  if (!slug) return '';
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// All useful website links from page URLs + link/CTA facts ("Label :: URL").
// Deduped by normalized URL, preferring a page-sourced entry and a non-empty
// label. Returns [{ value, label, url, source }].
export async function getWebsiteLinks(websiteId) {
  const [pagesRes, factsRes] = await Promise.all([
    pool.query('SELECT url, title, h1 FROM pages WHERE website_id = $1', [websiteId]),
    pool.query(
      `SELECT pf.fact_key, pf.fact_value
         FROM page_facts pf JOIN pages p ON p.id = pf.page_id
        WHERE p.website_id = $1 AND pf.fact_key IN ('link', 'cta')`,
      [websiteId],
    ),
  ]);

  const byKey = new Map();
  const add = (url, label, source) => {
    if (!/^https?:\/\//i.test(url)) return;
    const key = normalizeUrl(url);
    const cleanLabel = (label || '').trim();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { value: url, label: cleanLabel || prettyFromSlug(urlSlug(url)) || url, url, source });
      return;
    }
    // Prefer page source; otherwise fill in a missing label.
    if (existing.source !== 'page' && source === 'page') {
      byKey.set(key, { value: url, label: cleanLabel || existing.label, url, source });
    } else if (!existing.label && cleanLabel) {
      existing.label = cleanLabel;
    }
  };

  for (const p of pagesRes.rows) {
    const label = cleanTitle(p.title) || (p.h1 ? String(p.h1).trim() : '') || prettyFromSlug(urlSlug(p.url));
    add(p.url, label, 'page');
  }
  for (const f of factsRes.rows) {
    const v = String(f.fact_value ?? '');
    const sep = v.indexOf(' :: ');
    const label = sep > -1 ? v.slice(0, sep).trim() : '';
    const url = sep > -1 ? v.slice(sep + 4).trim() : v.trim();
    add(url, label, f.fact_key);
  }

  return [...byKey.values()];
}
