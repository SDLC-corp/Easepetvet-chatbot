import * as cheerio from 'cheerio';
import { extractFacts } from './fact-extractor.js';

// Extracts content from a page's HTML. Pure: receives an HTML string and the
// page URL (for resolving relative links), no network. Returns core fields
// (title, metaDescription, h1) for the pages table, structured facts for
// page_facts, and rawText for the text cleaner.

// Content containers tried in order; first match wins.
const CONTENT_SELECTORS = ['.entry-content', 'article', 'main', '#content', '.main-content', 'body'];

// Site chrome removed before locating content (keeps iframe/img/a for facts).
const REMOVE_CHROME = 'nav, header, footer, aside, #wpadminbar, .cookie, .cookies, .cookie-banner';

// Non-text nodes removed before reading rawText (after facts are extracted).
const REMOVE_FOR_TEXT = 'script, style, noscript, iframe, form';

function metaContent($, selector) {
  const value = $(selector).attr('content');
  return value ? value.trim() : null;
}

function pickContainer($) {
  for (const selector of CONTENT_SELECTORS) {
    const element = $(selector).first();
    if (element.length > 0) return element;
  }
  return null;
}

export function extractPage(html, pageUrl) {
  const $ = cheerio.load(html);

  // Capture head/heading data before removing anything.
  const titleTag = $('title').first().text().trim();
  const ogTitle = metaContent($, 'meta[property="og:title"]');
  const ogType = metaContent($, 'meta[property="og:type"]');
  const canonical = $('link[rel="canonical"]').attr('href');

  // Read H1 with separators so a dropped <br> or inline split does not glue
  // words ("veterinary<br>behaviorist" -> "veterinary behaviorist").
  const h1Element = $('h1').first();
  h1Element.find('br').replaceWith(' ');
  h1Element.find('*').each((_, element) => $(element).append(' '));
  const firstH1 = h1Element.text().replace(/\s+/g, ' ').trim();

  const title = titleTag || ogTitle || firstH1 || null;
  const metaDescription =
    metaContent($, 'meta[name="description"]') ||
    metaContent($, 'meta[property="og:description"]') ||
    null;
  const h1 = firstH1 || null;

  const facts = [];
  if (canonical) facts.push({ key: 'canonical', value: canonical.trim() });
  if (ogTitle) facts.push({ key: 'og_title', value: ogTitle });
  if (ogType) facts.push({ key: 'og_type', value: ogType });

  // Remove site chrome, then extract structured facts from the content element
  // (iframes still present so videos are captured).
  $(REMOVE_CHROME).remove();
  const container = pickContainer($);
  if (container) {
    facts.push(...extractFacts($, container, pageUrl));
  }

  // Remove non-text nodes, then read text with separators inserted between
  // elements so adjacent inline/block text does not glue together.
  $(REMOVE_FOR_TEXT).remove();

  let rawText = '';
  const textContainer = pickContainer($);
  if (textContainer) {
    textContainer.find('br').replaceWith(' ');
    textContainer.find('*').each((_, element) => $(element).append(' '));
    rawText = textContainer.text();
  }

  return { title, metaDescription, h1, facts, rawText };
}
