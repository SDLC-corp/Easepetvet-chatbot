import { getWebsiteByBaseUrl } from '../repositories/website.repository.js';
import { resolveOrCreateSession, insertMessage, countUserMessages, getRecentMessages } from '../repositories/chat.repository.js';
import { getSessionEmail } from '../repositories/lead.repository.js';
import { retrieve } from '../retrieval/retrieval.service.js';
import { getSupportFallback } from '../retrieval/support-fallbacks.js';
import { findCustomAnswerForQuestion } from './custom-answer.service.js';
import { buildAnswer } from './ai-answer.service.js';
import { NOT_FOUND_ANSWER } from './answer-formatter.js';
import { config } from '../config/env.js';
import { logger } from '../shared/logger/logger.js';

const BASE_URL = 'https://easepetvet.com/';

// Limit-reached message. Includes the support email so the visitor can reach the
// team directly; the widget linkifies the address into a clickable contact link.
function limitAnswer() {
  return 'You’ve reached the question limit for this conversation. If you shared your email, our team can follow up with you — or contact us anytime at '
    + config.chat.supportEmail
    + '. You can also start a new conversation later.';
}

// Builds the usage block returned with every chat response. messagesUsed counts
// accepted user questions; the email prompt cadence is driven by that count only.
function buildUsage(messagesUsed, emailExists, limitReached) {
  const limit = config.chat.conversationMessageLimit;
  const remaining = Math.max(0, limit - messagesUsed);
  const interval = config.chat.emailPromptInterval;
  const firstPrompt = config.chat.emailPromptAfterFirst && messagesUsed === 1;
  const intervalPrompt = interval > 0 && messagesUsed % interval === 0 && messagesUsed < limit;
  return {
    messageLimit: limit,
    messagesUsed,
    remainingMessages: remaining,
    limitReached: Boolean(limitReached),
    warning: limitReached ? true : remaining <= config.chat.limitWarningAt,
    showEmailPrompt: !emailExists && (limitReached ? true : firstPrompt || intervalPrompt),
    emailSaved: emailExists,
  };
}

// Raised when the chat cannot run for an operational reason (e.g. no website
// ingested yet). The route maps statusCode to the HTTP response.
export class ChatServiceError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'ChatServiceError';
    this.statusCode = statusCode;
  }
}

export async function handleChatMessage({ message, audience, sessionId, source }) {
  const website = await getWebsiteByBaseUrl(BASE_URL);
  if (!website) {
    throw new ChatServiceError('Knowledge base is not ready. Run ingestion first.', 503);
  }

  const session = await resolveOrCreateSession(sessionId, audience);

  const usedBefore = await countUserMessages(session.id);
  const emailExists = Boolean(await getSessionEmail(session.id));

  // Conversation cap: the limit-th question is still answered; the next one is
  // blocked without storing it or calling retrieval/AI.
  if (usedBefore >= config.chat.conversationMessageLimit) {
    return {
      sessionId: session.sessionId,
      message,
      answer: limitAnswer(),
      found: false,
      type: 'limit',
      audience: session.audience,
      sources: [],
      results: [],
      mode: 'limit',
      provider: 'none',
      error: null,
      usage: buildUsage(usedBefore, emailExists, true),
    };
  }

  // Prior conversation turns (fetched before storing the current message, so it
  // is history only). Used to interpret context-dependent follow-ups and to give
  // the LLM multi-turn memory.
  const history = await getRecentMessages(session.id, config.chat.historyTurns);

  await insertMessage(session.id, 'user', message, { audience: session.audience, source: source ?? null });

  // Admin custom-answer override: highest priority. If an admin authored an answer
  // for this question (exact normalized, or fuzzy >= 0.90), return it verbatim and
  // skip retrieval/AI/fallback entirely. The AI never rewrites an admin answer.
  const custom = await findCustomAnswerForQuestion({ websiteId: website.id, message, audience: session.audience });
  if (custom.matched) {
    await insertMessage(session.id, 'assistant', custom.answer, {
      type: 'custom',
      found: true,
      sources: [],
      provider: 'admin_custom',
      mode: 'admin_custom_answer',
      answerConfidence: 'admin_custom',
      customAnswerId: custom.customAnswerId,
      matchType: custom.matchType,
      similarity: custom.similarity,
      source: source ?? null,
    });
    const used = usedBefore + 1;
    return {
      sessionId: session.sessionId,
      message,
      answer: custom.answer,
      found: true,
      type: 'custom',
      audience: session.audience,
      sources: [],
      results: [],
      mode: 'admin_custom_answer',
      provider: 'admin_custom',
      error: null,
      usage: buildUsage(used, emailExists, false),
    };
  }

  const retrieval = await retrieve(message, website.id, { history });
  const formatted = await buildAnswer(message, session.audience, retrieval, history);

  // Deterministic safe fallback — only as a SAFETY NET now that the AI answers every
  // message and gracefully handles off-topic itself. It applies when the produced
  // answer is the not-found line (e.g. all AI providers were down, so the
  // deterministic formatter returned not-found) for a known Ease topic. Urgent
  // pet-health always triggers regardless. It intentionally does NOT fire just
  // because retrieval found nothing — the AI's conversational/graceful reply stands.
  const norm = retrieval.normalized ?? {};
  const answerIsNotFound = (formatted.answer || '').trim().startsWith(NOT_FOUND_ANSWER);
  const weak = answerIsNotFound;
  const fallback = getSupportFallback({
    originalQuery: message,
    correctedQuery: norm.correctedQuery,
    detectedIntents: norm.detectedIntents,
    retrievalResult: retrieval,
    weak,
  });

  // Final answer/mode/confidence after the fallback decision.
  const answer = fallback ? fallback.answer : formatted.answer;
  const mode = fallback ? 'fallback' : formatted.mode;
  const provider = fallback ? 'fallback' : formatted.provider;
  const answerConfidence = fallback
    ? 'fallback'
    : (answerIsNotFound ? 'not_found' : (retrieval.found ? 'exact' : 'related'));

  // Keep found/sources consistent with the visible answer: a fallback or not-found
  // answer reports found:false with no sources so the UI never shows a stray source.
  const found = retrieval.found && !answerIsNotFound && !fallback;
  const sources = found ? (retrieval.sources ?? []) : [];

  // Dev-only trace: how a question resolved end to end (no secrets). Makes the
  // "answered once, failed on repeat" class of bug visible in server logs.
  if (config.nodeEnv !== 'production') {
    logger.info(
      {
        sessionId: session.sessionId,
        audience: session.audience,
        historyLength: history.length,
        retrievalType: retrieval.type,
        retrievalFound: retrieval.found,
        resultCount: (retrieval.results ?? []).length,
        detectedIntents: norm.detectedIntents ?? [],
        corrections: (norm.corrections ?? []).length,
        answerMode: mode,
        answerConfidence,
        fallbackIntent: fallback ? fallback.intent : null,
        provider,
        fallbackReason: formatted.fallbackReason ?? null,
        finalFound: found,
      },
      'chat answer trace',
    );
  }

  await insertMessage(session.id, 'assistant', answer, {
    type: retrieval.type,
    found,
    sources,
    provider,
    mode,
    model: formatted.model ?? null,
    fallbackReason: formatted.fallbackReason ?? null,
    answerConfidence,
    fallbackIntent: fallback ? fallback.intent : null,
    source: source ?? null,
  });

  const messagesUsed = usedBefore + 1;
  const usage = buildUsage(messagesUsed, emailExists, false);
  // A demo/contact fallback invites the visitor to share their email; surface the
  // email prompt so widgets that rely on the backend signal capture the lead.
  if (fallback?.shouldTriggerLeadCapture && !emailExists) usage.showEmailPrompt = true;

  return {
    sessionId: session.sessionId,
    message,
    answer,
    found,
    type: retrieval.type,
    audience: session.audience,
    sources,
    results: found ? (retrieval.results ?? []) : [],
    mode,
    provider,
    error: null,
    usage,
  };
}
