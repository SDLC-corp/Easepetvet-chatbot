import { config } from '../config/env.js';

// Deterministic, safe support fallbacks for known Ease Pet Vet topics. Used when
// retrieval has no exact answer (or the produced answer is the not-found line) but
// the question is clearly about an Ease topic. Never invents policies, prices, or
// medical claims — it offers the closest safe next step (a known page link and/or
// the support email). Pure, no AI, no DB, no network.
//
//   getSupportFallback({ originalQuery, correctedQuery, detectedIntents,
//                        retrievalResult, weak })
//   -> null | { answer, answerConfidence: 'fallback', intent, shouldTriggerLeadCapture }

const SUPPORT_EMAIL = config.chat.supportEmail || 'support@easepetvet.com';

// Known safe site URLs. These are stable top-level pages of easepetvet.com; the
// coaching URL is the public booking page. Each is verified against ingested data
// during rollout (see the plan's verification step); if any is later found
// missing, drop it here and the affected fallback degrades to the support email.
const SAFE_URLS = {
  login: 'https://easepetvet.com/login/',
  pricing: 'https://easepetvet.com/pricing/',
  pets: 'https://easepetvet.com/pets/',
  vets: 'https://easepetvet.com/vets/',
  coaching: 'https://easepetvet.com/tp/tpcsd/csd-coaching/',
};

// Each entry returns the deterministic copy for its category. Support email and
// safe links are always preserved verbatim so the widget can linkify them.
const COPY = {
  loginDirect: () => `You can log in to the Ease Portal here: ${SAFE_URLS.login}.`,

  accountCreate: () =>
    `I could not find detailed account creation steps in the Ease Pet Vet website knowledge base. `
    + `If you already have portal access, you can start from the login page: ${SAFE_URLS.login}. `
    + `For account setup help, contact ${SUPPORT_EMAIL}.`,

  accountManagement: () =>
    `I could not find self-service account management steps in the website knowledge base. `
    + `Please contact ${SUPPORT_EMAIL} so the Ease Pet Vet team can help with account changes.`,

  deleteAccount: () =>
    `I could not find a self-service delete-account process in the website knowledge base. `
    + `Please email ${SUPPORT_EMAIL} for help with account removal.`,

  behaviorReports: () =>
    `I could not find the exact term "behavior report" in the website knowledge base. `
    + `The site does describe personalized behavior plans, recommendations, and follow-up support. `
    + `For a report-style document or specific deliverable, contact ${SUPPORT_EMAIL}.`,

  refund: () =>
    `I could not find a refund policy in the website knowledge base. `
    + `Please contact ${SUPPORT_EMAIL} for refund-related questions.`,

  freeTrial: () =>
    `I could not find a free trial mentioned in the website knowledge base. `
    + `The pricing page describes the available pricing details: ${SAFE_URLS.pricing}. `
    + `For confirmation, contact ${SUPPORT_EMAIL}.`,

  pricingGeneric: () =>
    `I could not find that pricing detail in the website knowledge base. `
    + `The pricing page has the available details: ${SAFE_URLS.pricing}. `
    + `For anything not listed there, contact ${SUPPORT_EMAIL}.`,

  supportResponse: () =>
    `I could not find a specific support response time in the website knowledge base. `
    + `You can contact the Ease Pet Vet team at ${SUPPORT_EMAIL}.`,

  reportProblem: () => `You can report a problem by emailing ${SUPPORT_EMAIL}.`,

  // Booking: only the safe, non-specific form. We never assert specific time
  // slots, session length, or turnaround here because that would invent detail
  // not guaranteed by retrieval — when the coaching page IS retrieved, the normal
  // answer path (not this fallback) handles those specifics.
  booking: () =>
    `Yes, you can book a coaching session online through the Ease Pet Vet coaching page: ${SAFE_URLS.coaching}. `
    + `If you'd like help booking, contact ${SUPPORT_EMAIL}.`,

  demoContact: () =>
    `Yes, you can request a demo or connect with the Ease Pet Vet team. `
    + `If you share your email, the team can follow up with the right details.`,

  urgent: () =>
    `If your pet is having trouble breathing or showing emergency symptoms, contact your veterinarian `
    + `or an emergency veterinary clinic immediately. I can help with Ease Pet Vet website information, `
    + `but this sounds urgent.`,
};

function fb(intent, answer, shouldTriggerLeadCapture = false) {
  return { answer, answerConfidence: 'fallback', intent, shouldTriggerLeadCapture };
}

export function getSupportFallback({ correctedQuery, originalQuery, detectedIntents, weak } = {}) {
  const q = String(correctedQuery || originalQuery || '').toLowerCase();
  const intents = new Set(Array.isArray(detectedIntents) ? detectedIntents : []);

  // 8. Urgent pet health — safety first, even when retrieval found something.
  if (intents.has('urgent_pet_health')) {
    return fb('urgent_pet_health', COPY.urgent(), false);
  }

  // All other categories only intervene when the normal answer is weak/not-found,
  // so a strong exact answer is never overridden.
  if (!weak) return null;

  // 1 + 2. Account access / management. Handled together so the delete/change
  // signal in the text routes correctly even when only the broad "account" intent
  // fired (e.g. "delete my account" -> management, not create).
  if (intents.has('account_management') || intents.has('account_access')) {
    if (/\b(delete|close|remove|deactivate|cancel)\b/.test(q) && /\baccount\b/.test(q)) {
      return fb('account_management', COPY.deleteAccount(), false);
    }
    if (/\b(change|update|forgot|reset)\b/.test(q) && /\b(email|password|account)\b/.test(q)) {
      return fb('account_management', COPY.accountManagement(), false);
    }
    if (/\baccount\b.*\b(problem|issue)\b|\b(problem|issue)\b.*\baccount\b/.test(q)) {
      return fb('account_management', COPY.accountManagement(), false);
    }
    const loginOnly = /\blog ?in\b/.test(q) && !/(create|sign ?up|register|registration)/.test(q);
    return fb('account_access', loginOnly ? COPY.loginDirect() : COPY.accountCreate(), false);
  }

  // 6. Appointment / booking.
  if (intents.has('appointment_booking')) {
    return fb('appointment_booking', COPY.booking(), false);
  }

  // 7. Demo / contact team -> trigger conversational lead capture.
  if (intents.has('demo_contact')) {
    return fb('demo_contact', COPY.demoContact(), true);
  }

  // 3. Behavior reports / recommendations.
  if (intents.has('behavior_reports')) {
    return fb('behavior_reports', COPY.behaviorReports(), false);
  }

  // 5. Support / problem reporting.
  if (intents.has('support_problem')) {
    if (/report (a |an )?(problem|issue)/.test(q)) {
      return fb('support_problem', COPY.reportProblem(), false);
    }
    return fb('support_problem', COPY.supportResponse(), false);
  }

  // 4. Refund / policies.
  if (intents.has('pricing_policy')) {
    if (/free trial|\btrial\b/.test(q)) return fb('pricing_policy', COPY.freeTrial(), false);
    if (/refund|money back/.test(q)) return fb('pricing_policy', COPY.refund(), false);
    return fb('pricing_policy', COPY.pricingGeneric(), false);
  }

  // vet_clinic / pet_parent alone have no specific deterministic fallback; let the
  // normal not-found stand rather than guess.
  return null;
}
