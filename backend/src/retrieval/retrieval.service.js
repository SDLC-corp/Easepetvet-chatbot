import { detectQuestionType } from './question-detector.js';
import { normalizeUserQuery } from './query-normalizer.js';
import { buildExpandedQuery } from './intent-aliases.js';
import {
  searchChunks,
  searchPageChunks,
  getFirstPageChunks,
  findPagesByKeyword,
  findPageBySlug,
  getFactsByKey,
} from '../repositories/retrieval.repository.js';
import { searchSimilarChunks } from '../repositories/embedding.repository.js';
import { getEmbeddingProvider } from '../embeddings/embedding-provider.js';
import { getEmbeddingStatusForWebsite } from '../embeddings/embedding.service.js';
import { config } from '../config/env.js';
import { logger } from '../shared/logger/logger.js';

// Orchestrates retrieval: detect question type, query the retrieval repository,
// and assemble a result with sources. Read-only. Reusable: takes websiteId as a
// parameter (no site hardcoded). Never fabricates — unmatched queries return
// found:false with empty results.

const CHUNK_LIMIT = 5;

// Pages that rarely answer general questions; excluded from open-ended results
// unless the user explicitly asks about these topics.
const LOW_VALUE_URL_PARTS = ['/privacy', '/login', '/vet-portal', '/press', '/category', '/product-category', '/shop', '/cart', '/checkout', '/my-account'];
const LOW_VALUE_TERMS = ['privacy', 'sms', 'login', 'portal', 'press', 'category', 'product', 'terms', 'policy'];

function filterLowValue(rows, question) {
  const lower = (question ?? '').toLowerCase();
  if (LOW_VALUE_TERMS.some((term) => lower.includes(term))) return rows;
  return rows.filter((row) => !LOW_VALUE_URL_PARTS.some((part) => (row.url ?? '').toLowerCase().includes(part)));
}

function uniqueSources(rows) {
  const seen = new Map();
  for (const row of rows) {
    if (row && row.url && !seen.has(row.url)) {
      seen.set(row.url, { url: row.url, title: row.title ?? null });
    }
  }
  return [...seen.values()];
}

// Trims a snippet so it does not start mid-sentence where possible. If the text
// begins with a lowercase letter (likely a partial sentence from chunk overlap),
// cut to the next sentence/paragraph boundary when enough text remains.
function cleanSnippet(text) {
  if (!text) return text;
  const trimmed = text.trim();

  const firstAlpha = trimmed.search(/[a-zA-Z]/);
  if (firstAlpha === -1) return trimmed;

  const startsLower = /[a-z]/.test(trimmed[firstAlpha]);
  if (!startsLower) return trimmed;

  const boundary = trimmed.search(/[.!?]\s+|\n+/);
  if (boundary === -1) return trimmed;

  const rest = trimmed.slice(boundary).replace(/^[.!?\s\n]+/, '');
  return rest.length >= 40 ? rest : trimmed;
}

function mapChunks(rows) {
  return rows.map((row) => ({
    text: cleanSnippet(row.chunk_text),
    url: row.url,
    title: row.title,
    rank: row.rank,
  }));
}

// Resolves a target page from the question: exact/partial slug match first, then
// the best keyword-ranked page. Returns null when nothing matches.
async function resolveTargetPage(websiteId, detection) {
  if (detection.slug) {
    const page = await findPageBySlug(websiteId, detection.slug);
    if (page) return page;
  }
  if (detection.keywords.length > 0) {
    const pages = await findPagesByKeyword(websiteId, detection.keywords, 1);
    if (pages[0]) return pages[0];
  }
  return null;
}

// Expanded site keywords used as a last-resort full-text query for broad
// overview/service questions, so they still surface core pages instead of
// returning nothing.
const OVERVIEW_KEYWORDS = 'ease pet vet behavior service support help pricing parent clinic';

// Builds the query used for semantic/full-text matching. For a follow-up that
// depends on the previous turn (e.g. the one-word reply "surgery" answering a
// bot question), the bare message has no standalone meaning, so we prepend the
// most recent prior turn to give it context. Used ONLY for matching/gating — the
// raw question is still used for question-type detection and low-value filtering.
// With no history this returns the question unchanged, so cold-start behaviour is
// identical to before.
const CONTEXT_QUERY_MAX_CHARS = 200;

export function buildContextualQuery(question, history) {
  const turns = Array.isArray(history) ? history : [];
  if (turns.length === 0) return question;
  const prev = turns[turns.length - 1];
  const prevText = (prev && prev.content ? String(prev.content) : '').replace(/\s+/g, ' ').trim();
  if (!prevText) return question;
  return `${prevText} ${question}`.slice(0, CONTEXT_QUERY_MAX_CHARS);
}

export async function retrieve(question, websiteId, opts = {}) {
  const result = await retrieveInternal(question, websiteId, opts.history ?? []);
  debugLogRetrieval(question, websiteId, result);
  return result;
}

// Dev-only retrieval trace (never in production, never logs secrets). Helps
// diagnose routing/found inconsistencies.
function debugLogRetrieval(question, websiteId, result) {
  if (config.nodeEnv === 'production') return;
  logger.info(
    {
      question: (question ?? '').trim(),
      websiteId,
      type: result.type,
      overview: Boolean(result.overview),
      factKey: result.factKey ?? null,
      smalltalk: result.smalltalk ?? null,
      found: result.found,
      resultCount: (result.results ?? []).length,
      topSources: (result.sources ?? []).slice(0, 3).map((s) => s.url),
    },
    'retrieval trace',
  );
}

// Short acknowledgments / declines / closings ("ok", "no", "got it", "that's all",
// "ok got my answer") are conversational turns, not new questions. We detect them
// so retrieval can skip content search — otherwise the context-enriched query pulls
// unrelated chunks and the model re-answers from them instead of responding to the
// conversation. Conservative: only very short messages with an ack/closing cue and
// no question or Ease-topic keyword.
function isShortConversationalReply(message) {
  const raw = String(message ?? '').trim();
  if (!raw || /[?]/.test(raw)) return false;
  const t = raw.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = t.split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 5) return false;
  // Don't hijack short real questions/requests about Ease topics.
  if (/\b(how|what|where|when|which|why|who|price|pricing|cost|demo|contact|login|account|refund|book|appointment|help|behaviou?r|anxiety|aggression|dog|cat|pet|vet|clinic|plan|report|email)\b/.test(t)) return false;
  // Acknowledgment / decline / closing cues.
  return /\b(ok|okay|k|no|nope|nah|yes|yeah|yep|yup|sure|thanks|thank|thanx|thx|ty|got|understood|noted|nothing|good|great|cool|fine|alright|awesome|perfect|done|all|bye|goodbye|cya|nvm|nevermind)\b/.test(t);
}

async function retrieveInternal(question, websiteId, history = []) {
  // Normalize first: fix spelling, detect Ease intents, build an expansion. The
  // corrected query drives detection + matching; the raw question is kept for
  // display/storage and low-value filtering. The normalization object is attached
  // to every result so chat.service can pick a safe support fallback.
  const norm = normalizeUserQuery(question);
  const corrected = norm.correctedQuery || question;
  const expandedQuery = buildExpandedQuery(norm.detectedIntents);

  const detection = detectQuestionType(corrected);
  const base = { type: detection.type, query: question, overview: Boolean(detection.overview), normalized: norm };
  // Context-aware query for matching/gating only. Low-value filtering keeps using
  // the raw question.
  const searchQuery = buildContextualQuery(corrected, history);

  // Greetings / thanks / goodbye: answered instantly, no DB or embedding call.
  if (detection.type === 'smalltalk') {
    return { ...base, smalltalk: detection.smalltalk, found: true, results: [], sources: [] };
  }

  // Short acknowledgment/decline/closing ("no", "ok got my answer"): return no
  // results so the answer builder responds from the conversation history instead of
  // re-answering from unrelated retrieved content.
  if (isShortConversationalReply(question)) {
    return { ...base, found: false, results: [], sources: [] };
  }

  if (detection.type === 'fact') {
    // Email/phone are site-wide contact info, not tied to one page, so they are
    // looked up across the whole site rather than scoped to a slug's page.
    const siteWide = detection.factKey === 'email' || detection.factKey === 'phone';
    const page = (!siteWide && detection.slug) ? await findPageBySlug(websiteId, detection.slug) : null;
    const factOptions = siteWide ? {} : { slug: detection.slug, pageId: page?.id };
    let rows = await getFactsByKey(websiteId, detection.factKey, factOptions);
    // Media (video/image) is not really page-specific. If a scoped lookup found
    // nothing (e.g. a multi-part question whose slug resolved to /pricing/), fall
    // back to a site-wide search so "...is there a video?" still finds the videos.
    if (rows.length === 0 && (detection.factKey === 'video' || detection.factKey === 'image') && (detection.slug || page)) {
      rows = await getFactsByKey(websiteId, detection.factKey, {});
    }
    if (rows.length > 0) {
      const results = rows.map((row) => ({ value: row.fact_value, url: row.url, title: row.title }));
      return { ...base, factKey: detection.factKey, found: true, results, sources: uniqueSources(rows) };
    }
    // Pricing with no pricing fact: fall back to the /pricing/ page chunks, then
    // to global vector/full-text search.
    if (detection.factKey === 'pricing') {
      if (page) {
        let chunkRows = await searchPageChunks(websiteId, page.id, question, CHUNK_LIMIT);
        if (chunkRows.length === 0) chunkRows = await getFirstPageChunks(websiteId, page.id, CHUNK_LIMIT);
        if (chunkRows.length > 0) {
          return { ...base, type: 'chunk', found: true, results: mapChunks(chunkRows), sources: uniqueSources([page]) };
        }
      }
      return globalChunkSearch(websiteId, searchQuery, question, base, expandedQuery);
    }
    return { ...base, found: false, results: [], sources: [] };
  }

  if (detection.type === 'page-attribute') {
    let page = detection.slug ? await findPageBySlug(websiteId, detection.slug) : null;
    if (!page) {
      const candidates = await findPagesByKeyword(websiteId, detection.keywords, 1);
      page = candidates[0] ?? null;
    }
    // No page named (e.g. "what is the h1") -> default to the homepage.
    if (!page) {
      page = await findPageBySlug(websiteId, '');
    }
    if (!page) {
      return { ...base, found: false, results: [], sources: [] };
    }
    const value = page[detection.attribute] ?? null;
    const results = value ? [{ value, url: page.url, title: page.title }] : [];
    return { ...base, attribute: detection.attribute, found: results.length > 0, results, sources: uniqueSources([page]) };
  }

  // Off-topic gate for open-ended questions (no explicit page slug, not an
  // overview): if embeddings are ready and nothing on the site is semantically
  // close (max similarity below minScore), the query is off-topic/nonsense — so a
  // stray keyword match (e.g. "question" -> FAQ page) must not surface a page.
  // Skip the gate when a known Ease intent was detected: the question is on-topic
  // by construction, so it should reach retrieval (and, if recall is weak, a safe
  // support fallback) rather than be rejected as off-topic.
  if (!detection.overview && !detection.slug && norm.detectedIntents.length === 0
      && (await isOffTopic(websiteId, searchQuery))) {
    return { ...base, found: false, results: [], sources: [] };
  }

  // chunk: overview questions pin the homepage; otherwise use the matched page.
  const page = detection.overview
    ? await findPageBySlug(websiteId, '')
    : await resolveTargetPage(websiteId, detection);
  if (page) {
    let chunkRows = await searchPageChunks(websiteId, page.id, question, CHUNK_LIMIT);
    if (chunkRows.length === 0) {
      chunkRows = await getFirstPageChunks(websiteId, page.id, CHUNK_LIMIT);
    }
    const results = mapChunks(chunkRows);
    // Only return here when the page actually yielded content. If it is empty,
    // fall through to global search instead of returning found:false.
    if (results.length > 0) {
      return { ...base, found: true, results, sources: uniqueSources([page]) };
    }
  }

  // No target page (or the page was empty): semantic vector search first, then
  // full-text, then expanded-keyword full-text for overview/intent questions.
  return globalChunkSearch(websiteId, searchQuery, question, base, expandedQuery);
}

// Open-ended chunk search: vector first (when ready), then full-text. searchQuery
// is the (possibly context-enriched) matching query; rawQuestion is the user's
// own words, used only for low-value page filtering. Low-value pages are filtered
// unless the question explicitly asks about them.
async function globalChunkSearch(websiteId, searchQuery, rawQuestion, base, expandedQuery = '') {
  const vectorRows = await vectorSearch(websiteId, searchQuery, rawQuestion, CHUNK_LIMIT);
  if (vectorRows && vectorRows.length > 0) {
    return { ...base, type: 'chunk', found: true, results: mapChunks(vectorRows), sources: uniqueSources(vectorRows) };
  }
  // vectorRows === [] means vector ran and judged the query off-topic. Trust that
  // and do NOT let full-text match a single stray word (the nonsense leak), UNLESS
  // we have a retry signal: an overview question, or an intent-expanded query for a
  // known Ease topic. vectorRows === null means embeddings are unavailable ->
  // full-text is the only signal, so fall through.
  const allowRetry = base.overview || Boolean(expandedQuery);
  if (Array.isArray(vectorRows) && !allowRetry) {
    return { ...base, type: 'chunk', found: false, results: [], sources: [] };
  }
  let globalRows = filterLowValue(await searchChunks(websiteId, searchQuery, CHUNK_LIMIT), rawQuestion);
  // Weak full-text on a known Ease topic: retry with the intent-expanded keywords
  // so related content still surfaces (the "related" answer tier) instead of
  // dead-ending. The deterministic support fallback covers the case where even
  // this finds nothing.
  if (globalRows.length === 0 && expandedQuery) {
    globalRows = filterLowValue(await searchChunks(websiteId, expandedQuery, CHUNK_LIMIT), rawQuestion);
  }
  // Broad overview/service questions: if still weak, retry with expanded site
  // keywords so we surface the core pages.
  if (globalRows.length === 0 && base.overview) {
    globalRows = filterLowValue(await searchChunks(websiteId, OVERVIEW_KEYWORDS, CHUNK_LIMIT), rawQuestion);
  }
  const results = mapChunks(globalRows);
  return { ...base, type: 'chunk', found: results.length > 0, results, sources: uniqueSources(globalRows) };
}

// Relevance judge for open-ended questions. Returns true only when embeddings are
// ready AND the single best raw similarity across the whole site is below
// minScore (i.e. the query is off-topic/nonsense). Uses RAW scores (no low-value
// filtering) on purpose: even a privacy/SMS match means the query is on-topic for
// the site, so we should not reject it. Returns false (do not gate) when
// embeddings are unavailable or the query is on-topic.
async function isOffTopic(websiteId, question) {
  try {
    const status = await getEmbeddingStatusForWebsite(websiteId);
    if (!status.vectorReady) return false;
    const provider = getEmbeddingProvider(config);
    const [queryVector] = await provider.embed([question]);
    if (!queryVector) return false;
    const rows = await searchSimilarChunks(
      websiteId,
      config.embedding.provider,
      config.embedding.model,
      config.embedding.dimension,
      queryVector,
      3,
    );
    const maxScore = rows.length ? Math.max(...rows.map((r) => Number(r.score))) : 0;
    return maxScore < config.embedding.minScore;
  } catch (err) {
    logger.warn({ err: err.message }, 'Relevance gate unavailable; not gating');
    return false;
  }
}

// Embeds the question and runs cosine-similarity search. Returns rows shaped like
// the full-text rows (chunk_text/url/title/rank), an empty array when vector ran
// but found nothing relevant, or null when embeddings are unavailable (missing
// key, provider error, etc.) so the caller falls back to full-text.
async function vectorSearch(websiteId, searchQuery, rawQuestion, limit) {
  try {
    // Only trust vector search once embedding coverage is high enough.
    const status = await getEmbeddingStatusForWebsite(websiteId);
    if (!status.vectorReady) {
      logger.info(
        { coveragePercent: status.coveragePercent, minCoverage: status.minCoverage, missing: status.missing, stale: status.stale },
        'Vector search skipped: embeddings incomplete; using full-text fallback',
      );
      return null;
    }

    const provider = getEmbeddingProvider(config);
    const [queryVector] = await provider.embed([searchQuery]);
    if (!queryVector) return null;

    const rows = await searchSimilarChunks(
      websiteId,
      config.embedding.provider,
      config.embedding.model,
      config.embedding.dimension,
      queryVector,
      limit,
    );

    // Drop low-value pages and weak matches so nonsense queries don't surface
    // irrelevant chunks.
    const allowed = filterLowValue(rows, rawQuestion);
    const passing = allowed.filter((row) => Number(row.score) >= config.embedding.minScore);
    if (passing.length === 0) {
      // Vector ran and found nothing semantically relevant. Return [] (not null)
      // so the caller can tell this apart from "embeddings unavailable" and avoid
      // a stray full-text word match (e.g. nonsense containing "question").
      logger.info({ minScore: config.embedding.minScore }, 'No vector results above minScore (query judged off-topic)');
      return [];
    }

    return passing.map((row) => ({
      chunk_text: row.chunkText,
      url: row.url,
      title: row.title,
      rank: row.score,
    }));
  } catch (err) {
    logger.warn({ err: err.message }, 'Vector search unavailable; falling back to full-text');
    return null;
  }
}
