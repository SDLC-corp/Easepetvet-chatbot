import { isNonEmptyString } from '../shared/validators/common.validator.js';

// Filters page crawl URLs for easepetvet.com. This is applied ONLY to page URLs
// (the <urlset> output). Child sitemap URLs must NOT be passed here, so the
// .xml exclusion below never blocks sitemap discovery.

const ALLOWED_HOST = 'easepetvet.com';

// Paths that are administrative, transactional, or non-content.
const EXCLUDED_PATH_SEGMENTS = [
  '/wp-admin/',
  '/wp-content/',
  '/wp-includes/',
  '/wp-json/',
  '/wp-login.php',
  '/cart/',
  '/checkout/',
  '/my-account/',
  '/feed/',
];

// Asset / non-HTML extensions (note: .xml here only affects page URLs).
const EXCLUDED_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico',
  '.css', '.js', '.pdf', '.zip', '.mp4', '.mov', '.json', '.xml',
];

// Normalizes a page URL to canonical https easepetvet.com form, stripping query
// and fragment. Returns null if off-host or unparseable.
function normalize(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== ALLOWED_HOST && host !== `www.${ALLOWED_HOST}`) {
    return null;
  }

  parsed.protocol = 'https:';
  parsed.hostname = ALLOWED_HOST;
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString();
}

function isExcluded(url) {
  const path = new URL(url).pathname.toLowerCase();
  if (EXCLUDED_PATH_SEGMENTS.some((segment) => path.includes(segment))) return true;
  if (path.endsWith('/feed')) return true;
  if (EXCLUDED_EXTENSIONS.some((ext) => path.endsWith(ext))) return true;
  return false;
}

// Takes raw page URLs and returns a clean, deduped, normalized crawl list.
export function filterPageUrls(urls) {
  const result = new Set();

  for (const url of urls) {
    if (!isNonEmptyString(url)) continue;
    const normalized = normalize(url);
    if (!normalized) continue;
    if (isExcluded(normalized)) continue;
    result.add(normalized);
  }

  return [...result];
}
