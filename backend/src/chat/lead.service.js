import { getWebsiteByBaseUrl } from '../repositories/website.repository.js';
import { resolveOrCreateSession } from '../repositories/chat.repository.js';
import { upsertSessionEmail } from '../repositories/lead.repository.js';
import { ChatServiceError } from './chat.service.js';

const BASE_URL = 'https://easepetvet.com/';

// Attaches an email to an existing (or freshly resolved) session from the
// optional in-chat email prompt. Does not require a name and does not reset the
// session or its message count.
export async function saveSessionEmail({ sessionId, email, phone, audience }) {
  const website = await getWebsiteByBaseUrl(BASE_URL);
  if (!website) {
    throw new ChatServiceError('Knowledge base is not ready. Run ingestion first.', 503);
  }
  // Passing audience here reinforces a detected audience on the session without
  // downgrading it (resolveOrCreateSession only upgrades from 'unknown').
  const session = await resolveOrCreateSession(sessionId, audience);
  await upsertSessionEmail({
    websiteId: website.id,
    sessionRowId: session.id,
    email,
    phone,
    audience: audience || session.audience,
  });
  return { sessionId: session.sessionId, emailSaved: true };
}
