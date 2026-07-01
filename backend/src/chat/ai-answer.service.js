import { config } from '../config/env.js';
import { formatRetrievalOnly } from './providers/retrieval-only.provider.js';
import { NOT_FOUND_ANSWER } from './answer-formatter.js';
import { callChatCompletion } from './providers/openai-compatible.provider.js';
import { getConfiguredChain } from './provider-chain.js';
import { logger } from '../shared/logger/logger.js';

// Builds the chat answer. retrieval_only mode (or non-conversational / not-found
// results) uses the deterministic formatter. Otherwise the provider chain
// (groq -> gemini -> openrouter -> ollama) is tried in order; the first success
// wins, and any provider failure (rate limit, timeout, error) silently falls
// through to the next provider, then to retrieval-only. The user never sees a
// provider switch — only server logs record it.

// Conversational answers benefit from an LLM. Page chunks + pricing already did;
// link/video/image/cta/faq lists now do too, so the LLM returns the single most
// relevant one (with its URL) instead of dumping the whole list. Exact single
// values (H1, canonical, og_*) stay deterministic.
const CONVERSATIONAL_FACT_KEYS = new Set(['pricing', 'link', 'video', 'image', 'cta', 'faq', 'email', 'phone']);

function isConversational(retrieval) {
  if (retrieval.type === 'chunk') return true;
  if (retrieval.type === 'fact') return CONVERSATIONAL_FACT_KEYS.has(retrieval.factKey);
  return false;
}

// Video fact values are stored as "<heading> :: <vimeo player URL>", and the
// player URL is domain-restricted (not publicly viewable). For the LLM context we
// strip the player URL and expose the heading + the public page URL, so the model
// hands the visitor a link that actually works.
function contextRetrieval(retrieval) {
  if (retrieval.type === 'fact' && retrieval.factKey === 'video') {
    const results = (retrieval.results ?? []).map((r) => {
      const v = String(r.value ?? '');
      const sep = v.indexOf(' :: ');
      return { value: sep > -1 ? v.slice(0, sep).trim() : v.trim(), url: r.url, title: r.title };
    });
    return { ...retrieval, results };
  }
  return retrieval;
}

// A provider answer is unusable if it is empty or just the canned not-found
// line. When retrieval has real results, an unusable AI answer must NOT erase
// them: we discard it and fall back to deterministic retrieval-only formatting,
// so a question that has data always gets answered (consistent across repeats).
function isUsableAnswer(answer) {
  const trimmed = (answer ?? '').trim();
  if (!trimmed) return false;
  if (trimmed.startsWith(NOT_FOUND_ANSWER)) return false;
  return true;
}

// Maps a provider error to a safe, non-technical reason (server-side only).
function classifyError(providerName, err) {
  const message = err?.message ?? '';
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timeout|aborted/i.test(message)) {
    return `${providerName}_timeout`;
  }
  if (/API key is not set/i.test(message)) return `${providerName}_auth`;
  const statusMatch = /failed:\s*(\d{3})/.exec(message);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  if (status === 429) return `${providerName}_rate_limited`;
  if (status === 401 || status === 403) return `${providerName}_auth`;
  if (status === 400 || status === 404) return `${providerName}_model`;
  if (status && status >= 500) return `${providerName}_server`;
  return `${providerName}_error`;
}

export async function buildAnswer(question, audience, retrieval, history = []) {
  const llmEnabled = config.chat.answerMode !== 'retrieval_only';

  // AI-first: the model answers EVERY conversational message so it always
  // understands the question and replies helpfully — grounded strictly on the
  // provided context for Ease-specific facts, and gracefully redirecting when the
  // question is off-topic (see the system prompt). Only exact single-value facts
  // (H1, canonical, og_*, title/meta/url attributes) stay deterministic, since
  // those need no phrasing. When retrieval found nothing, the context is empty and
  // the model handles it as an out-of-scope question rather than dead-ending.
  const useLLM = llmEnabled && (retrieval.found ? isConversational(retrieval) : true);

  if (!useLLM) {
    return formatRetrievalOnly(retrieval);
  }

  const chain = getConfiguredChain();
  if (chain.length === 0) {
    return { ...formatRetrievalOnly(retrieval), fallbackReason: 'no_provider_configured' };
  }

  const shared = {
    maxTokens: config.chat.maxTokens,
    temperature: config.chat.temperature,
    timeoutMs: config.chat.timeoutMs,
  };

  const promptRetrieval = contextRetrieval(retrieval);
  let lastReason = null;
  let aiJudgedNotFound = false;
  for (const provider of chain) {
    try {
      const result = await callChatCompletion(provider, shared, question, audience, promptRetrieval, history);
      // If the model explicitly returned the not-found line, it judged the
      // retrieved context insufficient to answer (e.g. "is there a mobile app?"
      // when there is none). Remember that — if every model agrees, we should show
      // a clean "not found" rather than dumping the raw retrieved text.
      if (String(result.answer ?? '').trim().startsWith(NOT_FOUND_ANSWER)) {
        aiJudgedNotFound = true;
      }
      // Guard: empty or not-found answer while retrieval has results -> treat as a
      // failure and try the next provider (then the fallbacks below).
      if (!isUsableAnswer(result.answer)) {
        lastReason = `${provider.name}_unusable_answer`;
        logger.warn({ provider: provider.name, reason: lastReason }, 'Chat provider gave an unusable answer despite retrieval results; trying next');
        continue;
      }
      return result;
    } catch (err) {
      lastReason = classifyError(provider.name, err);
      // Silent fallback: log server-side only, then try the next provider.
      logger.warn({ provider: provider.name, reason: lastReason, err: err.message }, 'Chat provider failed; trying next');
    }
  }

  // If a model explicitly judged the question unanswerable from context, trust
  // that verdict and return a clean, friendly not-found reply — never dump the raw
  // retrieved chunk (which is what made "is there a mobile app?" return a wall of
  // homepage text when the AI was unavailable).
  if (aiJudgedNotFound) {
    const support = config.chat.supportEmail;
    const tail = support ? ` I can help with pricing, how Ease works, behavior topics, and support — or reach our team at ${support}.` : '';
    return { answer: `${NOT_FOUND_ANSWER}${tail}`, mode: 'not_found', provider: 'none', model: null, fallbackReason: lastReason ?? 'ai_judged_not_found' };
  }

  // Otherwise (providers errored/rate-limited without judging) -> deterministic
  // retrieval-only answer built from the results we already have.
  return { ...formatRetrievalOnly(retrieval), fallbackReason: lastReason ?? 'all_providers_failed' };
}
