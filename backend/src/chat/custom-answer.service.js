import { normalizeUserQuery, similarity } from '../retrieval/query-normalizer.js';
import { findExactCustomAnswer, findCandidateCustomAnswers } from '../repositories/admin-custom-answer.repository.js';

// Admin custom-answer lookup. Runs BEFORE retrieval/AI: if an admin has authored
// an answer for this (or a high-confidence variant of this) question, return it
// verbatim. No weak matches — only an exact normalized match or fuzzy >= 0.90.

const FUZZY_THRESHOLD = 0.9;

// Derives the canonical question key used for matching + storage. Reused by the
// admin routes so stored and looked-up forms are produced identically. Beyond the
// shared normalizer (lowercase + typo correction), it strips punctuation and
// dropped articles/possessives so trivial wording differences ("how do i create
// an account?" vs "how do i create account") collapse to the same key and match
// exactly. The raw question is still stored separately for display.
export function toNormalizedQuestion(question) {
  const norm = normalizeUserQuery(question);
  return (norm.correctedQuery || norm.normalizedQuery || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(a|an|the|my|your|our)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function findCustomAnswerForQuestion({ websiteId, message, audience }) {
  const nq = toNormalizedQuestion(message);
  if (!nq) return { matched: false };

  // 1) Exact normalized match (audience-scoped, specific beats 'all').
  const exact = await findExactCustomAnswer({ websiteId, normalizedQuestion: nq, audience });
  if (exact) {
    return {
      matched: true,
      matchType: 'exact',
      similarity: 1,
      answer: exact.answer,
      question: exact.question,
      customAnswerId: exact.id,
      answerConfidence: 'admin_custom',
    };
  }

  // 2) High-confidence fuzzy match. Compare the normalized user query against each
  //    candidate's stored normalized_question; take the best at/above threshold.
  const candidates = await findCandidateCustomAnswers({ websiteId, audience });
  let best = null;
  for (const c of candidates) {
    const score = similarity(nq, c.normalizedQuestion);
    if (score >= FUZZY_THRESHOLD && (!best || score > best.score)) {
      best = { row: c, score };
    }
  }
  if (best) {
    return {
      matched: true,
      matchType: 'fuzzy',
      similarity: Number(best.score.toFixed(2)),
      answer: best.row.answer,
      question: best.row.question,
      customAnswerId: best.row.id,
      answerConfidence: 'admin_custom',
    };
  }

  return { matched: false };
}
