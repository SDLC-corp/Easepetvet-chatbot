import { getWebsiteByBaseUrl } from '../repositories/website.repository.js';
import { resolveOrCreateSession } from '../repositories/chat.repository.js';
import { upsertSessionLead } from '../repositories/lead.repository.js';
import { ChatServiceError } from './chat.service.js';

const BASE_URL = 'https://easepetvet.com/';

// General conversational lead save. Any subset of name / email / phone can be
// provided; the session is resolved (or created) so the lead is linked to the
// conversation, and the audience carries in without downgrading. A derived name
// never overwrites a real one (enforced in the repository).
export async function saveSessionLead({ sessionId, name, email, phone, audience, nameIsDerived }) {
  const website = await getWebsiteByBaseUrl(BASE_URL);
  if (!website) {
    throw new ChatServiceError('Knowledge base is not ready. Run ingestion first.', 503);
  }
  const session = await resolveOrCreateSession(sessionId, audience);
  await upsertSessionLead({
    websiteId: website.id,
    sessionRowId: session.id,
    name: name ?? null,
    email: email ?? null,
    phone: phone ?? null,
    audience: audience || session.audience,
    nameIsDerived: nameIsDerived === true,
  });
  return { sessionId: session.sessionId };
}

// Backward-compatible email save (route POST /api/chat/email). Requires email at
// the route layer; may also carry an optional name/phone. Delegates to the
// general save so there is a single lead-persistence path.
export async function saveSessionEmail({ sessionId, name, email, phone, audience, nameIsDerived }) {
  const { sessionId: sid } = await saveSessionLead({ sessionId, name, email, phone, audience, nameIsDerived });
  return { sessionId: sid, emailSaved: true };
}
