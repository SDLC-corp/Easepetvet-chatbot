import { processClaimedJob, processPendingCrawlJobs } from '../ingestion/ingestion.service.js';
import { getWebsiteByBaseUrl } from '../repositories/website.repository.js';
import { findPageBySlug } from '../repositories/retrieval.repository.js';
import { claimJobForReprocess, resetAllJobsToPending } from '../repositories/crawl-job.repository.js';
import { pool } from '../db/pool.js';
import { logger } from '../shared/logger/logger.js';

// Targeted reprocess runner. Reuses the existing ingestion pipeline to refresh a
// single page (--url / --slug) or all pages (--all).
//
//   node src/scripts/reprocess.js --url=https://easepetvet.com/vets/
//   node src/scripts/reprocess.js --slug=vets
//   node src/scripts/reprocess.js --all

const BASE_URL = 'https://easepetvet.com/';

function parseArgs(argv) {
  const args = {};
  for (const token of argv) {
    const match = token.match(/^--([^=]+)(?:=(.*))?$/);
    if (match) args[match[1]] = match[2] ?? true;
  }
  return args;
}

// Normalizes a URL to match stored crawl_jobs.url: https, lowercase host, no
// query/hash. Trailing slash is left as-is (matched slash-insensitively in SQL).
function normalizeUrl(input) {
  const url = new URL(input);
  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase();
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function reprocessOne(websiteId, url) {
  const job = await claimJobForReprocess(websiteId, url);
  if (!job) {
    logger.error({ url }, 'No crawl job found for that URL.');
    process.exitCode = 1;
    return;
  }
  const summary = await processClaimedJob(websiteId, job);
  console.log(summary);
}

async function runUrl(websiteId, rawUrl) {
  let url;
  try {
    url = normalizeUrl(rawUrl);
  } catch {
    logger.error({ url: rawUrl }, 'Invalid --url.');
    process.exitCode = 1;
    return;
  }
  await reprocessOne(websiteId, url);
}

async function runSlug(websiteId, slug) {
  const page = await findPageBySlug(websiteId, slug);
  if (!page) {
    logger.error({ slug }, 'No page found for that slug.');
    process.exitCode = 1;
    return;
  }
  await reprocessOne(websiteId, page.url);
}

async function runAll(websiteId) {
  const reset = await resetAllJobsToPending(websiteId);
  const tally = await processPendingCrawlJobs(websiteId, {});
  console.log({ reset, ...tally });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const modes = ['url', 'slug', 'all'].filter((mode) => args[mode] !== undefined);
  if (modes.length !== 1) {
    logger.error('Provide exactly one of --url=<url> | --slug=<slug> | --all');
    process.exitCode = 1;
    return;
  }

  const website = await getWebsiteByBaseUrl(BASE_URL);
  if (!website) {
    logger.error('No website found. Run ingestion first.');
    process.exitCode = 1;
    return;
  }

  if (args.url !== undefined) {
    if (typeof args.url !== 'string') {
      logger.error('--url requires a value.');
      process.exitCode = 1;
      return;
    }
    await runUrl(website.id, args.url);
  } else if (args.slug !== undefined) {
    if (typeof args.slug !== 'string') {
      logger.error('--slug requires a value.');
      process.exitCode = 1;
      return;
    }
    await runSlug(website.id, args.slug);
  } else {
    await runAll(website.id);
  }
}

main()
  .catch((err) => {
    logger.error({ err }, 'Reprocess runner failed');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
