import { getWebsiteByBaseUrl } from '../repositories/website.repository.js';
import { resolveOrCreateSession, insertMessage, countUserMessages, getRecentMessages } from '../repositories/chat.repository.js';
import { getSessionEmail } from '../repositories/lead.repository.js';
import { retrieve } from '../retrieval/retrieval.service.js';
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

export async function handleChatMessage({ message, audience, sessionId }) {
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

  await insertMessage(session.id, 'user', message, { audience: session.audience });

  const retrieval = await retrieve(message, website.id, { history });
  const formatted = await buildAnswer(message, session.audience, retrieval, history);

  // Keep found/sources consistent with the visible answer: if the answer is the
  // "not found" message (retrieval-only, or Groq judged the context too weak),
  // report found:false with no sources so the UI never shows a stray source.
  const answerIsNotFound = (formatted.answer || '').trim().startsWith(NOT_FOUND_ANSWER);
  const found = retrieval.found && !answerIsNotFound;
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
        answerMode: formatted.mode,
        provider: formatted.provider,
        fallbackReason: formatted.fallbackReason ?? null,
        finalFound: found,
      },
      'chat answer trace',
    );
  }

  await insertMessage(session.id, 'assistant', formatted.answer, {
    type: retrieval.type,
    found,
    sources,
    provider: formatted.provider,
    mode: formatted.mode,
    model: formatted.model ?? null,
    fallbackReason: formatted.fallbackReason ?? null,
  });

  const messagesUsed = usedBefore + 1;

  return {
    sessionId: session.sessionId,
    message,
    answer: formatted.answer,
    found,
    type: retrieval.type,
    audience: session.audience,
    sources,
    results: found ? (retrieval.results ?? []) : [],
    mode: formatted.mode,
    provider: formatted.provider,
    error: null,
    usage: buildUsage(messagesUsed, emailExists, false),
  };
}
