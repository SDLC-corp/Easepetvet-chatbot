import { createOpenAiProvider } from './providers/openai-provider.js';
import { createGeminiProvider } from './providers/gemini-provider.js';

// Factory: returns an embedding provider for the configured provider. "gemini"
// is the active provider; "openai" is kept for compatibility. Throws only when
// called with an unsupported provider — importing this module never fails app
// startup.

export function getEmbeddingProvider(config) {
  const provider = config.embedding.provider;

  switch (provider) {
    case 'gemini':
      return createGeminiProvider(config.embedding);
    case 'openai':
      return createOpenAiProvider(config.embedding);
    default:
      throw new Error(`Unsupported embedding provider: "${provider}"`);
  }
}
