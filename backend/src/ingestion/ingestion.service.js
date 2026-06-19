import { readSitemap } from './sitemap-reader.js';
import { collectUrls } from './url-collector.js';
import { filterPageUrls } from './url-filter.js';
import { createCrawlJobs } from './crawl-job-creator.js';
import { fetchPage } from './page-fetcher.js';
import { extractPage } from './html-extractor.js';
import { cleanText } from './text-cleaner.js';
import { createChunks } from './chunk-creator.js';
import {
  claimNextPendingJob,
  markJobCompleted,
  markJobFailed,
  markJobSkipped,
} from '../repositories/crawl-job.repository.js';
import { upsertPage } from '../repositories/page.repository.js';
import { replacePageFacts } from '../repositories/page-fact.repository.js';
import { replacePageChunks } from '../repositories/page-chunk.repository.js';
import { config } from '../config/env.js';
import { logger } from '../shared/logger/logger.js';

// Orchestrates the ingestion flow. Exports functions only; nothing auto-runs.

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Reads the sitemap index, recurses into child sitemaps, collects page URLs,
// and applies url-filter ONLY to the final page URLs (never to sitemap URLs).
export async function collectWebsitePageUrls(baseUrl) {
  const indexUrl = new URL('sitemap_index.xml', baseUrl).toString();
  const root = collectUrls(await readSitemap(indexUrl));

  let pageUrls = [];
  if (root.type === 'index') {
    for (const childSitemapUrl of root.urls) {
      const child = collectUrls(await readSitemap(childSitemapUrl));
      pageUrls.push(...child.urls);
    }
  } else {
    pageUrls = root.urls;
  }

  return filterPageUrls(pageUrls);
}

// Collects page URLs and inserts them as pending crawl jobs.
export async function createWebsiteCrawlJobs(baseUrl, name) {
  const urls = await collectWebsitePageUrls(baseUrl);
  const { websiteId, inserted } = await createCrawlJobs(baseUrl, name, urls);
  logger.info({ baseUrl, collected: urls.length, inserted }, 'Created crawl jobs');
  return { websiteId, inserted, collected: urls.length };
}

// Runs the full fetch-through-save pipeline for a single already-claimed job and
// marks its final status. Any error marks the job failed. Reused by
// processNextCrawlJob and the targeted reprocess runner.
export async function processClaimedJob(websiteId, job) {
  try {
    const result = await fetchPage(job.url, {
      userAgent: config.crawl.userAgent,
      timeoutMs: config.crawl.timeoutMs,
    });

    if (result.html === null) {
      if (result.httpStatus >= 500) {
        const message = `HTTP ${result.httpStatus}`;
        await markJobFailed(job.id, message);
        logger.error({ jobId: job.id, url: job.url, httpStatus: result.httpStatus }, 'Crawl job failed');
        return { jobId: job.id, url: job.url, status: 'failed', error: message };
      }
      const reason = result.httpStatus >= 400
        ? `HTTP ${result.httpStatus}`
        : `Non-HTML content-type: ${result.contentType ?? 'unknown'}`;
      await markJobSkipped(job.id, reason);
      logger.warn({ jobId: job.id, url: job.url, reason }, 'Crawl job skipped');
      return { jobId: job.id, url: job.url, status: 'skipped', reason };
    }

    const extracted = extractPage(result.html, job.url);
    const clean = cleanText(extracted.rawText);
    const chunks = createChunks(clean);

    const pageId = await upsertPage({
      websiteId,
      url: job.url,
      title: extracted.title,
      httpStatus: result.httpStatus,
      fetchedAt: new Date(),
      rawHtml: result.html,
      cleanText: clean,
      metaDescription: extracted.metaDescription,
      h1: extracted.h1,
    });
    await replacePageFacts(pageId, extracted.facts);
    await replacePageChunks(pageId, chunks);

    await markJobCompleted(job.id);
    logger.info({ jobId: job.id, url: job.url, pageId, chunks: chunks.length }, 'Crawl job completed');
    return { jobId: job.id, url: job.url, status: 'completed', pageId, chunks: chunks.length };
  } catch (err) {
    await markJobFailed(job.id, err.message);
    logger.error({ jobId: job.id, url: job.url, err }, 'Crawl job failed');
    return { jobId: job.id, url: job.url, status: 'failed', error: err.message };
  }
}

// Claims the next pending job for a website and processes it. Returns the
// summary, or null when no pending job remains.
export async function processNextCrawlJob(websiteId) {
  const job = await claimNextPendingJob(websiteId);
  if (!job) return null;
  return processClaimedJob(websiteId, job);
}

// Processes pending jobs for a website until none remain or the optional limit
// is reached, waiting the crawl delay between page requests.
export async function processPendingCrawlJobs(websiteId, options = {}) {
  const limit = options.limit;
  const delayMs = options.delayMs ?? config.crawl.delayMs;

  const tally = { processed: 0, completed: 0, failed: 0, skipped: 0 };

  while (limit === undefined || tally.processed < limit) {
    const summary = await processNextCrawlJob(websiteId);
    if (!summary) break;

    tally.processed += 1;
    tally[summary.status] += 1;

    if (limit !== undefined && tally.processed >= limit) break;
    await delay(delayMs);
  }

  logger.info({ websiteId, ...tally }, 'Processed pending crawl jobs');
  return tally;
}
