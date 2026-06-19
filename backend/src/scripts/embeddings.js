import {
  generateMissingEmbeddings,
  getEmbeddingStatusForWebsite,
  testEmbeddingSearch,
  resetEmbeddings,
} from '../embeddings/embedding.service.js';
import { getWebsiteByBaseUrl } from '../repositories/website.repository.js';
import { config } from '../config/env.js';
import { pool } from '../db/pool.js';
import { logger } from '../shared/logger/logger.js';

// Console runner for embeddings. Thin dispatcher over the embedding service.
//
//   node src/scripts/embeddings.js status
//   node src/scripts/embeddings.js generate
//   node src/scripts/embeddings.js reset [--all | --provider=openai --model=...]
//   node src/scripts/embeddings.js test "How much do I need to pay?"

const BASE_URL = 'https://easepetvet.com/';
const PREVIEW_LENGTH = 300;

function parseFlags(argv) {
  const flags = {};
  for (const token of argv) {
    const match = token.match(/^--([^=]+)(?:=(.*))?$/);
    if (match) flags[match[1]] = match[2] ?? true;
  }
  return flags;
}

async function resolveWebsiteId() {
  const website = await getWebsiteByBaseUrl(BASE_URL);
  return website ? website.id : null;
}

async function runReset(flags) {
  const summary = await resetEmbeddings({
    all: flags.all === true,
    provider: typeof flags.provider === 'string' ? flags.provider : undefined,
    model: typeof flags.model === 'string' ? flags.model : undefined,
  });
  console.log(`Deleted ${summary.deleted} embedding row(s) from page_chunk_embeddings [${summary.scope}].`);
  console.log('Chunks, pages, facts, websites, and crawl jobs were NOT touched.');
}

async function runStatus(websiteId) {
  console.log(await getEmbeddingStatusForWebsite(websiteId));
}

async function runGenerate(websiteId) {
  const summary = await generateMissingEmbeddings(websiteId);
  console.log(summary);
  if (summary.stopped) {
    logger.error('Embedding generation stopped early. Re-run "npm run embeddings:generate" later to continue the remaining chunks.');
    process.exitCode = 1;
  } else if (summary.totalChecked > 0 && summary.embedded === 0 && summary.updated === 0) {
    logger.error(`No embeddings were generated (check the ${config.embedding.provider} API key and provider config).`);
    process.exitCode = 1;
  }
}

async function runTest(websiteId, question) {
  const minScore = config.embedding.minScore;
  const { results } = await testEmbeddingSearch(websiteId, question);
  console.log(`Question: ${question} (minScore ${minScore})`);
  if (results.length === 0) {
    console.log('No similar chunks found.');
    return;
  }
  let anyPass = false;
  results.forEach((result, index) => {
    const score = Number(result.score);
    const pass = score >= minScore;
    if (pass) anyPass = true;
    console.log(`  ${index + 1}. [score ${score.toFixed(4)}] ${pass ? 'PASS' : 'below minScore'} ${result.title ?? ''}`);
    console.log(`     ${result.url}`);
    console.log(`     ${(result.chunkText ?? '').slice(0, PREVIEW_LENGTH)}`);
  });
  if (!anyPass) {
    console.log(`No result meets minScore ${minScore}; retrieval would fall back to full-text.`);
  }
}

async function main() {
  const command = process.argv[2];
  if (!['generate', 'status', 'test', 'reset'].includes(command)) {
    logger.error({ command }, 'Unknown command. Use generate | status | test | reset.');
    process.exitCode = 1;
    return;
  }

  // reset does not need a website id.
  if (command === 'reset') {
    await runReset(parseFlags(process.argv.slice(3)));
    return;
  }

  const websiteId = await resolveWebsiteId();
  if (!websiteId) {
    logger.error('No website found. Run ingestion first.');
    process.exitCode = 1;
    return;
  }

  if (command === 'status') {
    await runStatus(websiteId);
  } else if (command === 'generate') {
    await runGenerate(websiteId);
  } else {
    const question = process.argv.slice(3).join(' ').trim();
    if (!question) {
      logger.error('Provide a question, e.g. npm run embeddings:test -- "How much do I need to pay?"');
      process.exitCode = 1;
      return;
    }
    await runTest(websiteId, question);
  }
}

main()
  .catch((err) => {
    logger.error({ err }, 'Embeddings runner failed');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
