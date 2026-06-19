import { retrieve } from '../retrieval/retrieval.service.js';
import { getWebsiteByBaseUrl } from '../repositories/website.repository.js';
import { pool } from '../db/pool.js';
import { logger } from '../shared/logger/logger.js';

// Console runner for retrieval. Thin dispatcher over retrieval.service.js.
//
//   node src/scripts/retrieve.js "What is the pricing?"

const BASE_URL = 'https://easepetvet.com/';
const TEXT_PREVIEW_LENGTH = 300;

function preview(text) {
  if (!text) return '';
  return text.length > TEXT_PREVIEW_LENGTH ? `${text.slice(0, TEXT_PREVIEW_LENGTH)}...` : text;
}

function printResult(result) {
  console.log(`Question: ${result.query}`);
  console.log(`Type: ${result.type}`);
  console.log(`Found: ${result.found}`);

  if (!result.found) {
    console.log('No answer found in the website knowledge base.');
    return;
  }

  console.log('Results:');
  result.results.forEach((item, index) => {
    const value = item.value ?? preview(item.text);
    console.log(`  ${index + 1}. ${value}`);
    if (item.url) console.log(`     ${item.url}`);
  });

  console.log('Sources:');
  result.sources.forEach((source) => {
    console.log(`  - ${source.url}${source.title ? ` (${source.title})` : ''}`);
  });
}

async function main() {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question) {
    logger.error('Provide a question, e.g. npm run retrieve -- "What is the pricing?"');
    process.exitCode = 1;
    return;
  }

  const website = await getWebsiteByBaseUrl(BASE_URL);
  if (!website) {
    logger.error('No website found. Run ingestion first.');
    process.exitCode = 1;
    return;
  }

  const result = await retrieve(question, website.id);
  printResult(result);
}

main()
  .catch((err) => {
    logger.error({ err }, 'Retrieval runner failed');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
