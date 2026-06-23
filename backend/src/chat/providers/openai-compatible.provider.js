// Generic OpenAI-compatible chat provider. Works for Groq, Gemini (Google's
// OpenAI-compatible endpoint), OpenRouter, and Ollama Cloud — only baseUrl, key,
// and model differ. Native fetch only. Formats an answer strictly from the
// retrieved context; throws (with HTTP status in the message) on any failure so
// the provider chain can fall through to the next provider.

import { config } from '../../config/env.js';

const SYSTEM_PROMPT = `You are the friendly virtual assistant for Ease Pet Vet, a service that supports pet parents and veterinary teams.
Make every visitor feel welcomed, understood, and genuinely helped.

Tone and style:
- Warm and friendly, but BRIEF. Keep every answer to 2-3 short sentences. Never write long paragraphs or lists.
- At most one short friendly touch, then give the key answer in plain language. Do not over-explain, repeat yourself, or pad the reply.
- With pet parents be caring and reassuring; with vets be professional and peer-to-peer.
- You may end with one short follow-up question only when it genuinely helps; otherwise just answer and stop.

Grounding rules (always follow):
- Base your answer only on the information in the provided context. Do not invent facts, prices, policies, medical claims, guarantees, or any detail that is not supported by the context.
- You can see the recent conversation. Use it to understand short or context-dependent replies (for example, a one-word answer that responds to your previous question). Using the conversation is allowed, but you must STILL only state website facts (prices, policies, services, medical or guarantee claims) that appear in the provided context. Never invent website facts, even if the conversation seems to imply them.
- If a reply has no supporting context and you cannot help without inventing website facts, reply with exactly this sentence and nothing else: "I could not find this in the Ease Pet Vet website knowledge base." Otherwise, you may briefly acknowledge what the user said and ask one short clarifying question or guide them to contact the team, without inventing facts.
- Never mention internal retrieval, chunks, embeddings, vectors, databases, "sources", or that the information "comes from the website". Just answer as a knowledgeable assistant.
- Do not include URLs by default. EXCEPTION: if the user is asking for (or about) a link, video, image, page, or resource — or a specific page like pricing, FAQ, registration/vets, pets, or contact — include the SINGLE most relevant URL from the context directly in your reply, copied exactly. Give the link itself, do NOT merely offer to share it or ask if they want it. Choose the one that best matches what they asked for. Use the page URL shown as the "source"; never output a raw video player or embed URL (for example player.vimeo.com). Never paste a long list of links or videos unless the user explicitly asks for "all" of them.
- Do not give veterinary diagnosis or emergency medical advice. For urgent pet health concerns, kindly encourage contacting a veterinarian right away.`;

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

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...priorTurns,
        { role: 'user', content: userContent },
      ],
      temperature: shared.temperature,
      max_tokens: shared.maxTokens,
    }),
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
