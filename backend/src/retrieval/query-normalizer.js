import {
  WORD_ALIASES,
  INTENT_KEYWORDS,
  KNOWN_VOCAB,
  SHORT_IMPORTANT_WORDS,
} from './intent-aliases.js';

// Reusable query normalization. Corrects spelling and expands understanding of a
// user question BEFORE retrieval, without ever changing the stored/displayed
// message. Pure, no library, no AI, no DB.
//
//   normalizeUserQuery('can i chnage my email adress')
//   -> {
//        originalQuery: 'can i chnage my email adress',
//        normalizedQuery: 'can i chnage my email adress',
//        correctedQuery: 'can i change my email address',
//        corrections: [ { from: 'chnage', to: 'change', score: 1 },
//                       { from: 'adress', to: 'address', score: 1 } ],
//        detectedIntents: ['account_management']
//      }

const SIMILARITY_THRESHOLD = 0.8;
const MIN_TOKEN_LEN = 4; // shorter tokens are skipped unless important (vet/cat/dog)

// Levenshtein edit distance (iterative two-row DP). No dependency.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

// Similarity in [0, 1]: 1 means identical, 0 means completely different.
function similarity(a, b) {
  if (!a && !b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// A token we must never alter: email, URL, or phone number. Quoted text is
// handled separately (quote state spans multiple tokens).
function isProtectedToken(token) {
  if (token.indexOf('@') !== -1) return true;               // email
  if (/^https?:\/\//i.test(token) || /^www\./i.test(token)) return true; // url
  if (/^\+?[\d][\d().-]{6,}$/.test(token)) return true;     // phone number
  return false;
}

// Whether a token is worth fuzzy-correcting at all.
function isMeaningfulToken(token) {
  if (SHORT_IMPORTANT_WORDS.has(token)) return true;
  return token.length >= MIN_TOKEN_LEN;
}

// Best fuzzy match for a token within KNOWN_VOCAB. Only considers candidates of a
// similar length and the same leading letter (typos rarely change the first
// letter) so we never warp a word into an unrelated one. Returns the best
// { word, score } at or above the threshold, otherwise null.
function bestVocabMatch(token) {
  let best = null;
  for (const candidate of KNOWN_VOCAB) {
    if (Math.abs(candidate.length - token.length) > 2) continue;
    if (candidate[0] !== token[0]) continue;
    const score = similarity(token, candidate);
    if (score >= SIMILARITY_THRESHOLD && (!best || score > best.score)) {
      best = { word: candidate, score };
    }
  }
  return best;
}

// Corrects a single bare word (already lowercased, no surrounding punctuation).
// Returns { word, correction } where correction is null when unchanged.
function correctWord(word) {
  // 1) Exact alias replacement (deterministic, score 1).
  if (Object.prototype.hasOwnProperty.call(WORD_ALIASES, word)) {
    const to = WORD_ALIASES[word];
    return { word: to, correction: to === word ? null : { from: word, to, score: 1 } };
  }
  // 2) Already a known good word -> keep.
  if (KNOWN_VOCAB.has(word)) return { word, correction: null };
  // 3) Fuzzy correction for meaningful tokens only.
  if (!isMeaningfulToken(word)) return { word, correction: null };
  const match = bestVocabMatch(word);
  if (match && match.word !== word) {
    return { word: match.word, correction: { from: word, to: match.word, score: Number(match.score.toFixed(2)) } };
  }
  return { word, correction: null };
}

// Detect intent groups by substring-matching each keyword phrase against the
// corrected query. Also matches a "compact" form with common filler words
// (my/your/the/a/our) removed, so "delete my account" matches "delete account"
// and "change my email" matches "change email". Returns matched keys in order.
function detectIntents(correctedQuery) {
  const lower = correctedQuery.toLowerCase();
  const compact = lower.replace(/\b(my|your|our|the|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const intents = [];
  for (const [intent, phrases] of Object.entries(INTENT_KEYWORDS)) {
    if (phrases.some((phrase) => lower.includes(phrase) || compact.includes(phrase))) intents.push(intent);
  }
  return intents;
}

export function normalizeUserQuery(message) {
  const originalQuery = typeof message === 'string' ? message : '';

  // Normalized form: lowercase, collapse repeated punctuation and whitespace.
  const normalizedQuery = originalQuery
    .toLowerCase()
    .replace(/([!?.,;:])\1+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  const corrections = [];
  let inQuote = false;

  const correctedQuery = normalizedQuery
    .split(' ')
    .map((rawToken) => {
      if (!rawToken) return rawToken;

      // Quoted text is protected: flip quote state on any quote char in the token
      // and never correct a token that touches/sits inside quotes.
      const hasQuote = /["']/.test(rawToken);
      const protectedByQuote = inQuote || hasQuote;
      if (hasQuote) {
        const count = (rawToken.match(/["']/g) || []).length;
        if (count % 2 === 1) inQuote = !inQuote;
      }
      if (protectedByQuote) return rawToken;

      // Emails / URLs / phone numbers: never altered.
      if (isProtectedToken(rawToken)) return rawToken;

      // Separate leading/trailing punctuation so it is preserved around the word.
      const m = rawToken.match(/^([^a-z0-9]*)([a-z0-9'-]*)([^a-z0-9]*)$/i);
      const lead = m ? m[1] : '';
      const word = m ? m[2] : rawToken;
      const trail = m ? m[3] : '';
      if (!word) return rawToken;

      const { word: corrected, correction } = correctWord(word);
      if (correction) corrections.push(correction);
      return lead + corrected + trail;
    })
    .join(' ');

  const detectedIntents = detectIntents(correctedQuery);

  return { originalQuery, normalizedQuery, correctedQuery, corrections, detectedIntents };
}
