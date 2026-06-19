import { ensureWebsite } from '../repositories/website.repository.js';
import { insertPendingJobs } from '../repositories/crawl-job.repository.js';

// Turns a list of filtered page URLs into pending crawl jobs using the existing
// repositories. Contains no SQL and does no fetching/parsing itself.

export async function createCrawlJobs(baseUrl, name, urls) {
  const websiteId = await ensureWebsite(baseUrl, name);
  const inserted = await insertPendingJobs(websiteId, urls);
  return { websiteId, inserted };
}
