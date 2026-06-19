// OpenAI embeddings provider. Native fetch only (no Axios). Returns vectors for
// search; never calls chat/completions and never generates answers.

export function createOpenAiProvider(embeddingConfig) {
  const { apiKey, baseUrl, model, dimension, timeoutMs = 20000 } = embeddingConfig;

  // Embeds an array of strings -> number[][] (one vector per input, in order).
  async function embed(texts) {
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required to generate embeddings.');
    }
    if (!Array.isArray(texts) || texts.length === 0) {
      return [];
    }

    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      // dimensions makes text-embedding-3-* output the configured size (e.g. 768).
      body: JSON.stringify({ model, input: texts, dimensions: dimension }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`OpenAI embeddings request failed: ${response.status} ${detail.slice(0, 200)}`);
    }

    const payload = await response.json();
    const items = payload?.data;
    if (!Array.isArray(items) || items.length !== texts.length) {
      throw new Error(`OpenAI embeddings: expected ${texts.length} embeddings, got ${items?.length ?? 0}`);
    }

    // OpenAI returns each item with its input index; preserve input order.
    const vectors = [...items]
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);

    for (const vector of vectors) {
      if (!Array.isArray(vector) || vector.length !== dimension) {
        throw new Error(`OpenAI embedding dimension mismatch: expected ${dimension}, got ${vector?.length ?? 0}`);
      }
    }

    return vectors;
  }

  return { provider: 'openai', model, dimension, embed };
}
