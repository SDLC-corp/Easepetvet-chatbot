import { extractKeywords } from './keyword-extractor.js';

// Rule-based question-type detection. Pure, no AI. Maps trigger words to a type
// and (for facts/attributes) a factKey/attribute, and extracts a page slug when
// the question references a page. Defaults to chunk search.

// Maps natural-language words to a canonical page slug, so "price"/"cost" ->
// pricing, "vet"/"veterinarian" -> vets, etc.
const SLUG_SYNONYMS = {
  pets: 'pets', pet: 'pets',
  vets: 'vets', vet: 'vets', veterinarian: 'vets', veterinarians: 'vets', veterinary: 'vets',
  shelters: 'shelters', shelter: 'shelters',
  pricing: 'pricing', price: 'pricing', prices: 'pricing', cost: 'pricing', costs: 'pricing', fee: 'pricing', fees: 'pricing',
  about: 'about',
  contact: 'contact',
  team: 'team',
  faq: 'faq', faqs: 'faq', questions: 'faq',
  blog: 'blog',
  press: 'press',
  privacy: 'privacy',
};

const PAGE_WORD_STOP = ['the', 'this', 'that', 'a', 'an'];

function detectSlug(lowerQuestion, keywords) {
  // "the pets page" / "pricing page" -> normalize via synonyms, else use as-is.
  const pageMatch = lowerQuestion.match(/\b([a-z0-9-]+)\s+page\b/);
  if (pageMatch && !PAGE_WORD_STOP.includes(pageMatch[1])) {
    return SLUG_SYNONYMS[pageMatch[1]] ?? pageMatch[1];
  }
  // Otherwise map the first keyword that is a known page synonym.
  for (const keyword of keywords) {
    if (SLUG_SYNONYMS[keyword]) return SLUG_SYNONYMS[keyword];
  }
  return null;
}

// Detects an explicit FAQ-list intent (vs a broad "what does the FAQ say").
function isFaqListIntent(lower) {
  if (/\bfaqs\b/.test(lower)) return true;
  if (!/\bfaq\b/.test(lower)) return false;
  return lower.includes('list') || lower.includes('items') || lower.includes('questions')
    || /what\s+faq/.test(lower) || /which\s+faq/.test(lower);
}

// Pricing / payment intent: cost, fees, paying, subscriptions, "how much", etc.
function isPricingIntent(lower) {
  if (lower.includes('how much')) return true;
  return /\b(pricing|prices?|cost|costs?|fee|fees?|pay|payment|payments|charge|charges|charged|subscriptions?|free|one[-\s]?time)\b/.test(lower);
}

// Vet/clinic context for payment questions ("do vets pay?", "free for clinics").
function isVetContext(lower) {
  return /\bvets?\b/.test(lower) || /\bclinics?\b/.test(lower) || /veterinar/.test(lower);
}

// Whole-message greeting / thanks / goodbye. Anchored to the full message so a
// real question like "thanks, what's the price?" is NOT treated as small-talk.
function detectSmallTalk(lower) {
  const t = lower.trim();
  if (/^(hi|hello|hey|hiya|howdy|yo|namaste|greetings)[\s!.,]*$/.test(t)) return 'greeting';
  if (/^good\s+(morning|afternoon|evening|day)[\s!.,]*$/.test(t)) return 'greeting';
  if (/^(thanks|thank you|thank u|thankyou|thx|ty)[\s!.,]*$/.test(t)) return 'thanks';
  if (/^(bye|goodbye|good bye|see you|see ya|cya|take care)[\s!.,]*$/.test(t)) return 'goodbye';
  return null;
}

// Generic site-overview questions ("what facility/service does this site
// provide", "what is this about", "what do you do", "tell me about this site").
// Tolerant of imperfect grammar ("what service provided by this site", "what
// facilities this site provide"). Requires site/Ease context (or explicit
// overview words) so it does not capture specific questions like "what is vet".
function isOverviewIntent(lower) {
  const mentionsSite = /\b(this|the)\s+(site|website|web\s?site|page|company|service|platform)\b/.test(lower)
    || /\bease(\s+pet\s+vet)?\b/.test(lower)
    || /\b(here|available here)\b/.test(lower);
  // Overview verbs/nouns, including tense/grammar variants.
  const overviewVerb = /\b(about|provide|provides|provided|providing|offer|offers|offered|does|do|is|facility|facilities|service|services|support|help|helps|available)\b/.test(lower);
  const asks = /\b(what|tell|describe|explain|how|which|who|why)\b/.test(lower);

  if (asks && mentionsSite && overviewVerb) return true;
  if (/\bwhat\s+(do|can)\s+you\s+(do|offer|provide|help)\b/.test(lower)) return true;
  if (/\bwhat\s+support\s+do\s+you\s+provide\b/.test(lower)) return true;
  if (/^\s*what\s+is\s+this\b/.test(lower)) return true;
  // "facility/facilities/service/services ... provided/available/here" even when
  // the site noun is implicit ("what services are provided").
  if (/\b(facilit(?:y|ies)|services?)\b/.test(lower)
      && /\b(provide|provides|provided|providing|offer|offers|offered|available|this|here)\b/.test(lower)) return true;
  // Explicit overview phrasings, but only with site context so off-topic
  // "tell me about spaceships" does not get pinned to the homepage.
  if (mentionsSite && /\b(overview|tell me about|explain this)\b/.test(lower)) return true;
  if (/\babout this (?:site|website|service)\b/.test(lower)) return true;
  return false;
}

export function detectQuestionType(question) {
  const lower = (question ?? '').toLowerCase();
  const keywords = extractKeywords(question);
  const slug = detectSlug(lower, keywords);
  const fact = (factKey) => ({ type: 'fact', factKey, slug, keywords });
  const attribute = (attr) => ({ type: 'page-attribute', attribute: attr, slug, keywords });

  // Greetings / thanks / goodbye answered instantly, before any retrieval.
  const smalltalk = detectSmallTalk(lower);
  if (smalltalk) return { type: 'smalltalk', smalltalk, keywords };

  // Canonical / OG facts first, so "canonical URL" never falls into link/url.
  if (lower.includes('canonical')) return fact('canonical');
  if (lower.includes('og:title') || lower.includes('og title') || lower.includes('open graph title')) return fact('og_title');
  if (lower.includes('og:type') || lower.includes('og type')) return fact('og_type');

  // Exact H1 -> pages.h1, checked BEFORE headings so they never collide.
  if (/\bh1\b/.test(lower)) return attribute('h1');

  // Structured page_facts intents.
  if (/\bheadings?\b/.test(lower) || /\bh2\b/.test(lower) || /\bh3\b/.test(lower) || /\bsections?\b/.test(lower)) return fact('heading');
  if (/\bctas?\b/.test(lower) || lower.includes('call to action') || /\bbuttons?\b/.test(lower)) return fact('cta');
  // Navigation: "give me the <X> page link", "privacy policy link", "homepage
  // link", "link to the vets page" -> return that PAGE's own URL (page-attribute
  // 'url'), not the links found on the page. Checked before the generic
  // link/video/image fact intents. The page-attribute branch resolves the page by
  // slug, then keyword, then homepage, so even loose phrasings find the right page.
  if (/\b(link|url)\b/.test(lower) && !/\b(video|image|picture|photo)s?\b/.test(lower)) {
    if (/\bhome\s?page\b/.test(lower) || /\bhomepage\b/.test(lower)) {
      return { type: 'page-attribute', attribute: 'url', slug: '', keywords };
    }
    if (slug !== null || /\bpage\b/.test(lower)) {
      return attribute('url');
    }
  }

  // Video before link/image so "video links" routes to videos, not links.
  if (/\bvideos?\b/.test(lower)) return fact('video');
  if (/\blinks?\b/.test(lower) || /\burls?\b/.test(lower)) return fact('link');
  if (/\bimages?\b/.test(lower) || /\bpictures?\b/.test(lower) || /\bphotos?\b/.test(lower)) return fact('image');

  // Pricing / payment intent. Vet-payment questions ("do vets pay?", "free for
  // clinics?") prefer the /vets/ page content; other pricing questions route to
  // pricing facts on /pricing/ (the service falls back to /pricing/ chunks then
  // global search when no pricing fact is found).
  if (isPricingIntent(lower)) {
    if (isVetContext(lower)) return { type: 'chunk', slug: 'vets', keywords };
    return { type: 'fact', factKey: 'pricing', slug: 'pricing', keywords };
  }

  if (/\bemails?\b/.test(lower) || lower.includes('e-mail')) return fact('email');
  if (/\bphones?\b/.test(lower) || lower.includes('telephone') || lower.includes('phone number')) return fact('phone');
  if (isFaqListIntent(lower)) return fact('faq');

  // Other single-value page attributes.
  if (lower.includes('meta description') || lower.includes('description')) return attribute('meta_description');
  if (lower.includes('title')) return attribute('title');

  // Generic "what does this site provide/offer/about" -> homepage overview.
  if (isOverviewIntent(lower)) return { type: 'chunk', overview: true, slug: null, keywords };

  return { type: 'chunk', slug, keywords };
}
