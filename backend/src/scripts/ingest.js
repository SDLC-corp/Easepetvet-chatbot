import { createWebsiteCrawlJobs, processPendingCrawlJobs } from '../ingestion/ingestion.service.js';
import { getWebsiteByBaseUrl } from '../repositories/website.repository.js';
import { getJobCountsByStatus } from '../repositories/crawl-job.repository.js';
import { pool } from '../db/pool.js';
import { logger } from '../shared/logger/logger.js';

// Console runner for ingestion. Thin dispatcher over ingestion.service.js and
// the repositories; contains no ingestion logic of its own.
//
//   node src/scripts/ingest.js create-jobs
//   node src/scripts/ingest.js process --limit=2
//   node src/scripts/ingest.js status

const BASE_URL = 'https://easepetvet.com/';
const NAME = 'EasePetVet';

function parseArgs(argv) {
  const args = {};
  for (const token of argv) {
    const match = token.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

async function resolveWebsiteId() {
  const website = await getWebsiteByBaseUrl(BASE_URL);
  return website ? website.id : null;
}

async function runCreateJobs() {
  const result = await createWebsiteCrawlJobs(BASE_URL, NAME);
  console.log(result);
}

async function runProcess(args) {
  let limit;
  if (args.limit !== undefined) {
    limit = Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      logger.error({ limit: args.limit }, 'Invalid --limit (must be an integer >= 1)');
      process.exitCode = 1;
      return;
    }
  }

  const websiteId = await resolveWebsiteId();
  if (!websiteId) {
    logger.error('No website found. Run "npm run ingest:create-jobs" first.');
    process.exitCode = 1;
    return;
  }

  const tally = await processPendingCrawlJobs(websiteId, { limit });
  console.log(tally);
}

async function runStatus() {
  const websiteId = await resolveWebsiteId();
  if (!websiteId) {
    logger.error('No website found. Run "npm run ingest:create-jobs" first.');
    process.exitCode = 1;
    return;
  }

  const counts = await getJobCountsByStatus(websiteId);
  console.log(counts);
}

async function main() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  switch (command) {
    case 'create-jobs':
      await runCreateJobs();
      break;
    case 'process':
      await runProcess(args);
      break;
    case 'status':
      await runStatus();
      break;
    default:
      logger.error({ command }, 'Unknown command. Use create-jobs | process | status.');
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    logger.error({ err }, 'Ingestion runner failed');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
