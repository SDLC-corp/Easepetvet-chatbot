import { logger } from '../shared/logger/logger.js';

// Fetches a single sitemap URL and returns its raw XML text. Single
// responsibility: network fetch only. Parsing is done in url-collector.js.
// (Crawl delay / env-based config is intentionally not handled here; that
// belongs to the later orchestrator sub-step.)

const USER_AGENT = 'EasePetVetBot/0.1 (+https://easepetvet.com)';
const REQUEST_TIMEOUT_MS = 15000;

export async function readSitemap(sitemapUrl) {
  logger.info({ sitemapUrl }, 'Fetching sitemap');

  const response = await fetch(sitemapUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/xml, text/xml',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Sitemap fetch failed: ${sitemapUrl} returned ${response.status}`);
  }

  return response.text();
}
