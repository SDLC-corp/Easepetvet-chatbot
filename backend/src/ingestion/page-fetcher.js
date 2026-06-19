// Fetches a single page with native fetch. Returns the HTTP status, content
// type, and HTML (or html: null for non-2xx or non-HTML responses). It does NOT
// decide crawl-job status — the orchestrator interprets the result. Network /
// abort errors propagate to the caller.
//
// Accepts optional { userAgent, timeoutMs }; the orchestrator passes crawl
// config. Falls back to these defaults when not provided.

const DEFAULT_USER_AGENT = 'EasePetVetBot/0.1 (+https://easepetvet.com)';
const DEFAULT_TIMEOUT_MS = 15000;

export async function fetchPage(url, options = {}) {
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const response = await fetch(url, {
    headers: {
      'User-Agent': userAgent,
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });

  const httpStatus = response.status;
  const contentType = response.headers.get('content-type');
  const isHtml = response.ok && contentType !== null && contentType.includes('text/html');

  const html = isHtml ? await response.text() : null;

  return { url, httpStatus, contentType, html };
}
