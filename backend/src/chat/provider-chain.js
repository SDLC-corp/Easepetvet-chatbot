import { config } from '../config/env.js';

// Hardcoded chat provider fallback order. Each provider is OpenAI-compatible and
// configured via env; a provider with no API key is skipped. retrieval-only is
// the implicit final fallback (handled by ai-answer.service).
export const PROVIDER_ORDER = ['groq', 'gemini', 'openrouter', 'ollama'];

// Returns the ordered, configured providers (those with an API key set), each as
// { name, baseUrl, apiKey, model }.
export function getConfiguredChain() {
  const providers = config.chat.providers;
  return PROVIDER_ORDER
    .filter((name) => providers[name] && providers[name].apiKey)
    .map((name) => ({ name, ...providers[name] }));
}

// Safe (no-secret) summary of the chain for health/startup output.
export function describeChain() {
  const providers = config.chat.providers;
  return PROVIDER_ORDER.map((name) => ({
    name,
    configured: Boolean(providers[name] && providers[name].apiKey),
    model: providers[name] ? providers[name].model : null,
  }));
}
