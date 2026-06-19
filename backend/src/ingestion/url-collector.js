import * as cheerio from 'cheerio';

// Parses sitemap XML and returns the URLs it contains. Parsing only: no network
// and no filtering.
//
// Returns { type, urls }:
//   type 'index'  -> urls are child sitemap URLs (from <sitemapindex>)
//   type 'urlset' -> urls are page URLs (from <urlset>)
//
// The caller (orchestrator) uses the type to decide whether to recurse into
// child sitemaps or treat the URLs as page crawl candidates.

export function collectUrls(xml) {
  const $ = cheerio.load(xml, { xml: true });

  const isIndex = $('sitemapindex').length > 0;
  const type = isIndex ? 'index' : 'urlset';
  const selector = isIndex ? 'sitemap > loc' : 'url > loc';

  const urls = $(selector)
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((url) => url.length > 0);

  return { type, urls };
}
