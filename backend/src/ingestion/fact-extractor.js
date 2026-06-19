// Extracts structured facts from a page's content element. Pure (no network):
// receives the cheerio root, the content element, and the page URL (for
// resolving relative links). Returns an array of { key, value } facts.
//
// URL-based facts (link, image, video, cta-with-url) dedupe by normalized URL;
// text-based facts (pricing, faq, email, phone, heading, cta-without-url) dedupe
// by normalized text. Not every fact has a URL part.

const CAPS = {
  link: 50, image: 30, video: 10, cta: 15,
  pricing: 10, faq: 20, email: 10, phone: 10, heading: 20,
};

const CTA_SELECTOR =
  'a[class*="btn"], a[class*="button"], a[class*="cta"], button, [role="button"], input[type="submit"]';

const PRICING_SELECTOR = 'p, li, td, h2, h3, strong, span';
const PRICING_PATTERNS = [
  /\$\s?\d[\d.,]*/,
  /\b\d+\s?(usd|dollars?)\b/i,
  /\bper\s?(month|year|mo|yr)\b/i,
  /\/(mo|month|year|yr)\b/i,
];
const EMAIL_PATTERN = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;

function toAbsoluteUrl(href, pageUrl) {
  if (!href) return null;
  try {
    const url = new URL(href, pageUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

function urlDedupeKey(url) {
  const copy = new URL(url.toString());
  copy.hash = '';
  return copy.toString().toLowerCase();
}

function normalizeText(text) {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function labelWithUrl(text, url) {
  const label = normalizeText(text);
  return label ? `${label} :: ${url}` : url;
}


export function extractFacts($, container, pageUrl) {
  const facts = [];
  const urlSeen = { link: new Set(), image: new Set(), video: new Set() };
  const textSeen = { pricing: new Set(), faq: new Set(), email: new Set(), phone: new Set(), heading: new Set() };
  const ctaSeen = new Set();

  const selfKey = (() => {
    const url = toAbsoluteUrl(pageUrl, pageUrl);
    return url ? urlDedupeKey(url) : null;
  })();

  const addUrlFact = (key, text, url) => {
    if (urlSeen[key].size >= CAPS[key]) return;
    const dedupeKey = urlDedupeKey(url);
    if (urlSeen[key].has(dedupeKey)) return;
    urlSeen[key].add(dedupeKey);
    facts.push({ key, value: labelWithUrl(text, url.toString()) });
  };

  const addTextFact = (key, rawText) => {
    const value = normalizeText(rawText);
    if (!value) return;
    if (textSeen[key].size >= CAPS[key]) return;
    const dedupeKey = value.toLowerCase();
    if (textSeen[key].has(dedupeKey)) return;
    textSeen[key].add(dedupeKey);
    facts.push({ key, value });
  };

  // Links
  container.find('a[href]').each((_, el) => {
    const url = toAbsoluteUrl($(el).attr('href'), pageUrl);
    if (!url) return;
    if (selfKey && urlDedupeKey(url) === selfKey) return;
    addUrlFact('link', $(el).text(), url);
  });

  // Images (src, or first srcset candidate)
  container.find('img').each((_, el) => {
    const $el = $(el);
    let src = $el.attr('src');
    if (!src) {
      const srcset = $el.attr('srcset');
      if (srcset) src = srcset.split(',')[0].trim().split(/\s+/)[0];
    }
    if (!src || src.startsWith('data:')) return;
    const width = Number($el.attr('width'));
    const height = Number($el.attr('height'));
    if (width === 1 || height === 1) return;
    const url = toAbsoluteUrl(src, pageUrl);
    if (!url) return;
    addUrlFact('image', $el.attr('alt'), url);
  });

  // Videos (iframe + video/source). Walk headings and videos in document order,
  // tagging each video with the most recent heading above it, so the chat answer
  // can deep-link to the video's section on the page.
  let lastHeading = '';
  container.find('h1, h2, h3, h4, h5, h6, iframe[src], video[src], video source[src]').each((_, el) => {
    const tag = (el.name || '').toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      const text = normalizeText($(el).text());
      if (text) lastHeading = text;
      return;
    }
    const url = toAbsoluteUrl($(el).attr('src'), pageUrl);
    if (url) addUrlFact('video', lastHeading, url);
  });

  // CTAs (link-based dedupe by URL, button/submit dedupe by text)
  container.find(CTA_SELECTOR).each((_, el) => {
    if (ctaSeen.size >= CAPS.cta) return;
    const $el = $(el);
    const text = normalizeText($el.is('input') ? $el.attr('value') : $el.text());
    const url = toAbsoluteUrl($el.attr('href'), pageUrl);
    const dedupeKey = url ? urlDedupeKey(url) : (text ? `text:${text.toLowerCase()}` : null);
    if (!dedupeKey || ctaSeen.has(dedupeKey)) return;
    const value = url ? labelWithUrl(text, url.toString()) : text;
    if (!value) return;
    ctaSeen.add(dedupeKey);
    facts.push({ key: 'cta', value });
  });

  // Pricing snippets
  container.find(PRICING_SELECTOR).each((_, el) => {
    const text = normalizeText($(el).text());
    if (!text || text.length > 200) return;
    if (PRICING_PATTERNS.some((pattern) => pattern.test(text))) addTextFact('pricing', text);
  });

  // FAQ (best-effort within faq/accordion markup)
  container.find('[class*="faq"], [class*="accordion"], [id*="faq"]').each((_, faqEl) => {
    const $faq = $(faqEl);
    $faq.find('dt').each((__, dt) => {
      const q = normalizeText($(dt).text());
      const a = normalizeText($(dt).next('dd').text());
      if (q) addTextFact('faq', a ? `${q} :: ${a}` : q);
    });
    $faq.find('summary, .question, h3, h4').each((__, qel) => {
      const q = normalizeText($(qel).text());
      if (!q) return;
      const a = normalizeText($(qel).next().text());
      addTextFact('faq', a ? `${q} :: ${a}` : q);
    });
  });

  // Emails (mailto links + text scan)
  container.find('a[href^="mailto:"]').each((_, el) => {
    const addr = $(el).attr('href').replace(/^mailto:/i, '').split('?')[0].trim();
    if (addr) addTextFact('email', addr);
  });
  const emailMatches = container.text().match(EMAIL_PATTERN);
  if (emailMatches) emailMatches.forEach((addr) => addTextFact('email', addr));

  // Phones (tel links)
  container.find('a[href^="tel:"]').each((_, el) => {
    const num = $(el).attr('href').replace(/^tel:/i, '').trim();
    if (num) addTextFact('phone', num);
  });

  // Headings (sections)
  container.find('h2, h3').each((_, el) => addTextFact('heading', $(el).text()));

  return facts;
}
