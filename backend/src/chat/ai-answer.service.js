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

// Conversational answers (page chunks, pricing) benefit from an LLM. Exact
// structured values (H1, headings, links, canonical, etc.) stay deterministic.
function isConversational(retrieval) {
  if (retrieval.type === 'chunk') return true;
  if (retrieval.type === 'fact' && retrieval.factKey === 'pricing') return true;
  return false;
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
  const hasHistory = Array.isArray(history) && history.length > 0;
  const llmEnabled = config.chat.answerMode !== 'retrieval_only';

  // Normal path: retrieval found conversational content.
  const useChain = llmEnabled && retrieval.found && isConversational(retrieval);
  // Follow-up path: retrieval found nothing, but we are mid-conversation. Let the
  // LLM use the prior turns to interpret/acknowledge the reply. Grounding is still
  // enforced by the system prompt (it must not invent website facts, and may emit
  // the not-found line). Brand-new (no history) not-found questions never reach
  // the LLM, so cold-start off-topic/nonsense is still rejected deterministically.
  const useFollowUp = llmEnabled && !retrieval.found && hasHistory;

  if (!useChain && !useFollowUp) {
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

  let lastReason = null;
  for (const provider of chain) {
    try {
      const result = await callChatCompletion(provider, shared, question, audience, retrieval, history);
      // Guard: if the provider returns empty or a not-found line while retrieval
      // actually has results, treat it as a failure and try the next provider
      // (and ultimately retrieval-only). This is what kept the same question
      // intermittently "not found" on repeat.
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

  // Every configured provider failed or gave nothing usable -> deterministic
  // retrieval-only answer built from the results we already have.
  return { ...formatRetrievalOnly(retrieval), fallbackReason: lastReason ?? 'all_providers_failed' };
}
