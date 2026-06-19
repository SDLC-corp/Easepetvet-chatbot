// Splits clean text into overlapping chunks for storage. Pure and
// deterministic. Stores chunk_text only (no embeddings). Empty input -> [].

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 150;

// Breaks text into segments no larger than CHUNK_SIZE: by paragraph, then by
// sentence for long paragraphs, then by hard character split as a last resort.
function splitSegments(text) {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const segments = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= CHUNK_SIZE) {
      segments.push(paragraph);
      continue;
    }
    const sentences = paragraph.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    for (const sentence of sentences) {
      if (sentence.length <= CHUNK_SIZE) {
        segments.push(sentence);
      } else {
        for (let i = 0; i < sentence.length; i += CHUNK_SIZE) {
          segments.push(sentence.slice(i, i + CHUNK_SIZE));
        }
      }
    }
  }

  return segments;
}

export function createChunks(cleanText) {
  if (!cleanText || cleanText.trim().length === 0) return [];

  const segments = splitSegments(cleanText);
  const chunks = [];
  let current = '';

  const flush = () => {
    if (current.trim().length > 0) {
      chunks.push({ chunkIndex: chunks.length, chunkText: current.trim() });
    }
  };

  for (const segment of segments) {
    if (current.length === 0) {
      current = segment;
    } else if (current.length + 1 + segment.length <= CHUNK_SIZE) {
      current += `\n${segment}`;
    } else {
      flush();
      const overlap = current.slice(-CHUNK_OVERLAP);
      current = `${overlap}\n${segment}`.trim();
    }
  }
  flush();

  return chunks;
}
