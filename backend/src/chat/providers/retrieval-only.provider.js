import { formatRetrievalAnswer } from '../answer-formatter.js';

// Retrieval-only answer provider. Always available; no AI, no network.

export function formatRetrievalOnly(retrieval) {
  return {
    answer: formatRetrievalAnswer(retrieval),
    mode: 'retrieval_only',
    provider: 'none',
    model: null,
  };
}
