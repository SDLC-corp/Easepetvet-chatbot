// Gemini embeddings provider. Native fetch only (no Axios). Uses the
// batchEmbedContents endpoint for both chunk batches and single-question
// embedding. Embeddings only — no content generation.

export function createGeminiProvider(embeddingConfig) {
  const { apiKey, baseUrl, model, dimension } = embeddingConfig;

  // Embeds an array of strings -> number[][] (one vector per input, in order).
  async function embed(texts) {
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is required to generate embeddings.');
    }
    if (!Array.isArray(texts) || texts.length === 0) {
      return [];
    }

    const response = await fetch(`${baseUrl}/models/${model}:batchEmbedContents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
          // REST batchEmbedContents takes outputDimensionality at the top level
          // of each request (the nested embedContentConfig form is ignored and
          // returns the model default of 3072).
          outputDimensionality: dimension,
        })),
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Gemini embeddings request failed: ${response.status} ${detail.slice(0, 200)}`);
    }

    const payload = await response.json();
    const items = payload?.embeddings;
    if (!Array.isArray(items) || items.length !== texts.length) {
      throw new Error(`Gemini embeddings: expected ${texts.length} embeddings, got ${items?.length ?? 0}`);
    }

    const vectors = items.map((item) => item?.values);
    for (const vector of vectors) {
      if (!Array.isArray(vector) || vector.length !== dimension) {
        throw new Error(`Gemini embedding dimension mismatch: expected ${dimension}, got ${vector?.length ?? 0}`);
      }
    }

    return vectors;
  }

  return { provider: 'gemini', model, dimension, embed };
}
