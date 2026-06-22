// Retrieval-only answer formatter. Produces readable answers from retrieval
// results without any AI. Never invents content beyond what was retrieved.

const NOT_FOUND = 'I could not find this in the Ease Pet Vet website knowledge base.';

const ATTRIBUTE_LABELS = { h1: 'H1', meta_description: 'meta description', title: 'title', url: 'link' };
const SINGLE_FACT_LABELS = { canonical: 'Canonical URL', og_title: 'OG title', og_type: 'OG type' };
const LIST_FACT_LABELS = {
  link: 'Links', image: 'Images', video: 'Videos', cta: 'Buttons / calls to action',
  heading: 'Headings', faq: 'FAQs', email: 'Emails', phone: 'Phone numbers',
};

// Extracts a clean email from a fact value (drops over-captured trailing text
// like "...com.4").
function cleanEmail(value) {
  const m = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/.exec(value);
  return m ? m[0] : value;
}

// Builds a scroll-to-text snippet from a heading: the clean prefix before any
// comma/hyphen (those are text-directive separators), capped to ~10 words so it
// still matches the heading verbatim on the page.
function videoTextSnippet(heading) {
  if (!heading) return '';
  return heading.split(/[,\-]/)[0].replace(/\s+/g, ' ').trim().split(' ').slice(0, 10).join(' ');
}

function formatFacts(retrieval) {
  const values = retrieval.results.map((r) => r.value).filter(Boolean);
  if (values.length === 0) return NOT_FOUND;

  if (retrieval.factKey === 'pricing') {
    return `Ease pricing information found on the Pricing page:\n- ${values.slice(0, 6).join('\n- ')}`;
  }
  if (SINGLE_FACT_LABELS[retrieval.factKey]) {
    return `${SINGLE_FACT_LABELS[retrieval.factKey]}: ${values[0]}`;
  }

  // Videos are embedded (unlisted/domain-restricted), so the raw player URLs are
  // not publicly viewable. Deep-link to the video's section on the public page
  // using a scroll-to-text fragment built from the video's heading.
  if (retrieval.factKey === 'video') {
    const lines = [];
    const seen = new Set();
    for (const row of retrieval.results) {
      if (!row.url) continue;
      const sep = (row.value || '').indexOf(' :: ');
      const heading = sep > -1 ? row.value.slice(0, sep).trim() : '';
      const snippet = videoTextSnippet(heading);
      const link = snippet ? `${row.url}#:~:text=${encodeURIComponent(snippet)}` : row.url;
      if (seen.has(link)) continue;
      seen.add(link);
      lines.push(heading ? `Watch "${heading}": ${link}` : `Watch the video: ${link}`);
      if (lines.length >= 10) break;
    }
    if (lines.length === 0) return NOT_FOUND;
    return `You can watch these Ease Pet Vet videos:\n- ${lines.join('\n- ')}`;
  }

  let listValues = values;
  if (retrieval.factKey === 'email') listValues = [...new Set(values.map(cleanEmail))];

  const label = LIST_FACT_LABELS[retrieval.factKey] ?? 'Details';
  return `${label} found on the page:\n- ${listValues.slice(0, 10).join('\n- ')}`;
}

function formatPageAttribute(retrieval) {
  const result = retrieval.results[0];
  if (!result?.value) return NOT_FOUND;
  // Navigation answers: give the page URL in the text so the widget linkifies it.
  if (retrieval.attribute === 'url') {
    const name = result.title ? `the "${result.title}" page` : 'that page';
    return `Here is ${name}: ${result.value}`;
  }
  const label = ATTRIBUTE_LABELS[retrieval.attribute] ?? retrieval.attribute ?? 'value';
  const where = result.title ? ` of the "${result.title}" page` : '';
  return `The ${label}${where} is: ${result.value}`;
}

// Collapse the whitespace noise that comes from scraped page text (runs of
// blank lines, stray indentation) so the AI-free fallback reads cleanly.
function cleanSnippet(text) {
  return (text ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*\n\s*/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Trim to a max length at a sentence/line boundary so we never dump a long wall
// of raw page content (e.g. team bios) when the AI is unavailable.
function truncateAtBoundary(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.lastIndexOf('\n'), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  const trimmed = (stop > max * 0.5 ? cut.slice(0, stop + 1) : cut).trim();
  return trimmed.replace(/[\s.,;:!?-]+$/, '') + '…';
}

function formatChunks(retrieval) {
  // AI-free fallback: present a single concise snippet (we do not summarize, so
  // keep it short and readable rather than concatenating raw page chunks).
  const MAX = 480;
  const snippets = retrieval.results
    .map((r) => cleanSnippet(r.text))
    .filter(Boolean);
  if (snippets.length === 0) return NOT_FOUND;
  const body = truncateAtBoundary(snippets[0], MAX);
  if (retrieval.overview) {
    return `Here's how Ease Pet Vet can help:\n\n${body}\n\nAsk me about pricing, how it works, behavior topics, or support for more.`;
  }
  return body;
}

const SMALL_TALK = {
  greeting: "Hi! I'm the Ease Pet Vet assistant. I can help with pricing, how Ease works for pet parents and vets, behavior topics, videos, and support — what would you like to know?",
  thanks: "You're welcome! Is there anything else about Ease Pet Vet I can help you with?",
  goodbye: 'Thanks for stopping by! Take care of your pet, and reach out any time.',
};

export function formatRetrievalAnswer(retrieval) {
  if (retrieval.type === 'smalltalk') {
    return SMALL_TALK[retrieval.smalltalk] ?? SMALL_TALK.greeting;
  }
  if (!retrieval.found || !retrieval.results || retrieval.results.length === 0) {
    return NOT_FOUND;
  }
  if (retrieval.type === 'fact') return formatFacts(retrieval);
  if (retrieval.type === 'page-attribute') return formatPageAttribute(retrieval);
  return formatChunks(retrieval);
}

export const NOT_FOUND_ANSWER = NOT_FOUND;
