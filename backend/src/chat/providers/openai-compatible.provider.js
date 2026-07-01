// Generic OpenAI-compatible chat provider. Works for Groq, Gemini (Google's
// OpenAI-compatible endpoint), OpenRouter, and Ollama Cloud — only baseUrl, key,
// and model differ. Native fetch only. Formats an answer strictly from the
// retrieved context; throws (with HTTP status in the message) on any failure so
// the provider chain can fall through to the next provider.

import { config } from '../../config/env.js';

const SYSTEM_PROMPT = `You are the friendly virtual assistant for Ease Pet Vet, a service that supports pet parents and veterinary teams with expert pet BEHAVIOR care (anxiety, aggression, house-soiling, reactivity, and similar), delivered in partnership with the pet's own veterinarian.
You reply to EVERY message: understand what the visitor is really asking, then respond in a way that leaves them satisfied and cared for.

Tone and style:
- Warm and friendly, but BRIEF. Keep every answer to 2-3 short sentences. Never write long paragraphs or lists.
- At most one short friendly touch, then give the key point in plain language. Do not over-explain, repeat yourself, or pad the reply.
- With pet parents be caring and reassuring; with vets be professional and peer-to-peer.
- You may end with one short, relevant follow-up question when it genuinely helps.

Grounding rules (always follow):
- For anything specific to Ease Pet Vet — prices, policies, plans, services, guarantees, timelines, links, or contact details — state ONLY what appears in the provided context. Never invent or guess these. If a specific Ease detail is not in the context, say you do not have that exact detail and point them to the team at the official contact email (and the contact page if relevant), instead of guessing.
- Use the recent conversation to interpret short or context-dependent replies (e.g. a one-word "yes" answering your previous question), but you must STILL only state Ease facts that appear in the context.
- CONVERSATION CONTINUITY: Always read the latest message in light of the recent conversation. If it is a short acknowledgment, agreement, decline, thanks, or closing (for example "ok", "no", "got it", "that's all", "no thanks", "ok got my answer"), reply in ONE short, warm line that responds to THAT — acknowledge, then gently offer more help or close. Do NOT repeat or expand a previous answer, re-introduce Ease, or pitch services when the user is only acknowledging, declining, or closing.
- OUT-OF-SCOPE / OFF-TOPIC questions (general veterinary, medical, diagnostic, or anything unrelated to Ease Pet Vet, and not supported by the context): do NOT present medical or general facts as an authority or answer them as if from a knowledge source, and do NOT reply with a blunt "not found". Instead, briefly and warmly acknowledge the question, note that Ease Pet Vet focuses on pet behavior support, recommend the pet's own veterinarian for medical or clinical questions, and offer relevant Ease help or to connect them with our team. Keep it short, kind, and genuinely useful.
- Never give a veterinary diagnosis or emergency medical advice. For urgent pet health concerns, kindly urge them to contact their veterinarian or an emergency clinic right away.
- Never mention internal retrieval, chunks, embeddings, vectors, databases, or "sources". Just answer naturally as a knowledgeable assistant.
- Do not include URLs by default. EXCEPTION: if the user is asking for (or about) a link, video, image, page, or resource — or a specific page like pricing, FAQ, registration/vets, pets, or contact — include the SINGLE most relevant URL from the context directly in your reply, copied exactly. Give the link itself; do NOT merely offer to share it. Use the page URL shown as the "source"; never output a raw video player or embed URL (for example player.vimeo.com). Never paste a long list of links or videos unless the user explicitly asks for "all" of them.`;

// Builds a compact context block from the top retrieval results + sources only.
function buildContext(retrieval) {
  const items = (retrieval.results ?? []).slice(0, 5).map((result) => {
    const text = String(result.value ?? result.text ?? '').slice(0, 600).trim();
    return result.url ? `- ${text} (source: ${result.url})` : `- ${text}`;
  });
  const sources = (retrieval.sources ?? [])
    .map((source) => `${source.title ?? ''} ${source.url}`.trim())
    .join('\n');
  return `Results:\n${items.join('\n')}\n\nSources:\n${sources}`;
}

// Maps stored history rows to chat message turns. Keeps only user/assistant turns
// with content, caps each turn's length, and drops a trailing user turn so we
// never send two consecutive user messages (the current question is appended
// after these). Defensive: history is normally prior turns only.
function buildPriorTurns(history) {
  const turns = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 1000) }));
  while (turns.length > 0 && turns[turns.length - 1].role === 'user') {
    turns.pop();
  }
  return turns;
}

// provider = { name, baseUrl, apiKey, model }; shared = { maxTokens, temperature, timeoutMs }.
export async function callChatCompletion(provider, shared, question, audience, retrieval, history = []) {
  if (!provider.apiKey) {
    throw new Error(`${provider.name}: API key is not set`);
  }

  const priorTurns = buildPriorTurns(history);
  const supportEmail = config.chat.supportEmail;
  const contactNote = supportEmail
    ? `\n\nOfficial contact email: ${supportEmail} — if the user asks how to contact/reach the team, for support, or for a contact/email/Gmail address, give them this email (you may also mention the contact page).`
    : '';
  const userContent = `Audience: ${audience}\nQuestion: ${question}\n\n${buildContext(retrieval)}${contactNote}`;

  const body = {
    model: provider.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...priorTurns,
      { role: 'user', content: userContent },
    ],
    temperature: shared.temperature,
    max_tokens: shared.maxTokens,
  };
  // Gemini 2.5 models are "thinking" models: left alone they spend the token
  // budget on internal reasoning and return truncated or empty answers. Turning
  // thinking off keeps replies complete and cheap. Only Gemini 2.5 understands
  // this field, so gate it to avoid unknown-parameter errors on other providers.
  if (provider.name === 'gemini' && /gemini-2\.5/.test(provider.model)) {
    body.reasoning_effort = 'none';
  }

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(shared.timeoutMs),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${provider.name} request failed: ${response.status} ${detail.slice(0, 200)}`);
  }

  const payload = await response.json();
  const answer = payload?.choices?.[0]?.message?.content?.trim();
  if (!answer) {
    throw new Error(`${provider.name} returned empty content`);
  }

  return { answer, mode: 'ai_formatted', provider: provider.name, model: provider.model };
}
