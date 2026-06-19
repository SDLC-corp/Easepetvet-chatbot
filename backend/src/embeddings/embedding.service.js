import { config } from '../config/env.js';
import { getEmbeddingProvider } from './embedding-provider.js';
import {
  getEmbeddingStatus,
  findChunksNeedingEmbedding,
  upsertEmbedding,
  searchSimilarChunks,
  deleteEmbeddings,
} from '../repositories/embedding.repository.js';
import { logger } from '../shared/logger/logger.js';

// Orchestrates embedding generation and search using the configured provider and
// the embedding repository. Status works without an API key; generate/test need
// one (the provider throws clearly when it is missing).

const MAX_FETCH = 1000000;
const BACKOFFS_MS = [10000, 20000, 40000];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Extracts a retryable HTTP status (429 or 5xx) from a provider error message,
// or null if the error is not retryable (missing key, dimension mismatch, etc.).
function retryableStatus(err) {
  const match = /failed: (\d{3})/.exec(err?.message ?? '');
  if (!match) return null;
  const status = Number(match[1]);
  return status === 429 || status >= 500 ? status : null;
}

// Embeds a batch, retrying 429/5xx up to maxRetries with 10s/20s/40s backoff.
async function embedWithRetry(provider, texts, maxRetries) {
  let attempt = 0;
  for (;;) {
    try {
      return await provider.embed(texts);
    } catch (err) {
      const status = retryableStatus(err);
      if (status === null || attempt >= maxRetries) throw err;
      const waitMs = BACKOFFS_MS[Math.min(attempt, BACKOFFS_MS.length - 1)];
      logger.warn({ status, attempt: attempt + 1, waitMs }, 'Embedding provider rate-limited; backing off');
      await delay(waitMs);
      attempt += 1;
    }
  }
}

export async function getEmbeddingStatusForWebsite(websiteId) {
  const { provider, model, dimension, minCoverage } = config.embedding;
  const status = await getEmbeddingStatus(websiteId, provider, model, dimension);

  const coverageRatio = status.totalChunks > 0 ? status.embeddedCurrent / status.totalChunks : 0;
  const coveragePercent = Number((coverageRatio * 100).toFixed(2));
  const vectorReady = coverageRatio >= minCoverage && status.missing === 0 && status.stale === 0;

  return {
    totalChunks: status.totalChunks,
    embeddedCurrent: status.embeddedCurrent,
    missing: status.missing,
    stale: status.stale,
    coverageRatio: Number(coverageRatio.toFixed(4)),
    coveragePercent,
    minCoverage,
    vectorReady,
    provider,
    model,
    dimension,
  };
}

export async function generateMissingEmbeddings(websiteId, options = {}) {
  const { provider: providerName, model, dimension, batchSize, maxRetries, batchDelayMs } = config.embedding;
  const provider = getEmbeddingProvider(config);

  const before = await getEmbeddingStatus(websiteId, providerName, model, dimension);
  const chunks = await findChunksNeedingEmbedding(websiteId, providerName, model, dimension, options.limit ?? MAX_FETCH);

  let stopped = false;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    let vectors;
    try {
      vectors = await embedWithRetry(provider, batch.map((chunk) => chunk.chunkText), maxRetries);
    } catch (err) {
      logger.error(
        { err: err.message, batchStart: i },
        'Embedding provider failed after retries; stopping. Re-run "npm run embeddings:generate" later to continue the remaining chunks.',
      );
      stopped = true;
      break;
    }
    for (let j = 0; j < batch.length; j += 1) {
      try {
        await upsertEmbedding({
          pageChunkId: batch[j].pageChunkId,
          provider: providerName,
          model,
          dimension,
          contentHash: batch[j].contentHash,
          embedding: vectors[j],
        });
      } catch (err) {
        logger.error({ err: err.message, pageChunkId: batch[j].pageChunkId }, 'Embedding upsert failed');
      }
    }
    logger.info({ processed: Math.min(i + batchSize, chunks.length), total: chunks.length }, 'Embedding progress');

    // Wait between batches to respect provider rate limits; no trailing delay.
    const isLastBatch = i + batchSize >= chunks.length;
    if (!isLastBatch && batchDelayMs > 0) await delay(batchDelayMs);
  }

  // Derive counts from before/after status (no per-row bookkeeping needed).
  const after = await getEmbeddingStatus(websiteId, providerName, model, dimension);
  const embedded = before.missing - after.missing;
  const updated = before.stale - after.stale;
  const totalChecked = chunks.length;
  return {
    provider: providerName,
    model,
    dimension,
    embedded,
    updated,
    skipped: before.embeddedCurrent,
    failed: totalChecked - embedded - updated,
    totalChecked,
    stopped,
  };
}

// Clears embedding rows only. Default: the active provider/model. { all:true }
// clears every row; { provider, model } overrides the scope.
export async function resetEmbeddings(options = {}) {
  if (options.all) {
    const deleted = await deleteEmbeddings({});
    return { scope: 'all providers/models', deleted };
  }
  const provider = options.provider ?? config.embedding.provider;
  const model = options.model ?? config.embedding.model;
  const deleted = await deleteEmbeddings({ provider, model });
  return { scope: `provider=${provider}, model=${model}`, deleted };
}

export async function testEmbeddingSearch(websiteId, question, options = {}) {
  const { provider: providerName, model, dimension, minScore } = config.embedding;
  const provider = getEmbeddingProvider(config);
  const [queryVector] = await provider.embed([question]);
  const results = await searchSimilarChunks(websiteId, providerName, model, dimension, queryVector, options.limit ?? 5);
  return { provider: providerName, model, question, minScore, results };
}
