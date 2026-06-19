// Tokenizes a question into search keywords. Pure function: lowercases, strips
// punctuation, drops a small stop-word set and very short tokens. Used for page
// and slug ILIKE matching. (Chunk full-text search passes the raw question to
// plainto_tsquery, which does its own stop-word/stemming handling.)

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'to', 'is', 'are', 'was', 'were', 'what',
  'which', 'who', 'whom', 'does', 'do', 'did', 'on', 'in', 'at', 'and', 'or',
  'it', 'this', 'that', 'with', 'about', 'page', 'say', 'says', 'tell', 'me',
  'your', 'their', 'his', 'her', 'how', 'when', 'where', 'why', 'can', 'could',
  'would', 'should', 'will', 'you', 'they', 'them',
]);

export function extractKeywords(question) {
  if (!question) return [];

  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}
