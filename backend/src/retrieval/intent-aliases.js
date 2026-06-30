// Centralized alias / typo map and intent keyword groups for the chatbot.
// Pure data + small pure helpers. No AI, no DB, no network. Used by
// query-normalizer.js (typo correction + intent detection) and
// support-fallbacks.js (safe deterministic fallbacks). The goal is to understand
// imperfect questions before retrieval — never to invent the final answer.

// Direct spelling corrections: common typos, British -> American spelling, and a
// few synonyms. Applied as exact whole-word replacements before the fuzzy pass,
// so high-frequency misspellings are fixed deterministically (score 1).
export const WORD_ALIASES = {
  // behaviour family (British -> American + typos)
  behaviour: 'behavior',
  behaviours: 'behaviors',
  behavioural: 'behavioral',
  behavour: 'behavior',
  behavours: 'behaviors',
  behaviuor: 'behavior',
  behaviuors: 'behaviors',
  behavor: 'behavior',

  // appointment
  appoitment: 'appointment',
  appoitments: 'appointments',
  apointment: 'appointment',
  apointments: 'appointments',
  appointmnet: 'appointment',

  // recommendation / receive
  recomendation: 'recommendation',
  recomendations: 'recommendations',
  recommedation: 'recommendation',
  recommedations: 'recommendations',
  recieve: 'receive',
  recieved: 'received',

  // veterinarian
  vetrinarian: 'veterinarian',
  vetrinarians: 'veterinarians',
  veterenarian: 'veterinarian',
  veterenarians: 'veterinarians',
  vetinarian: 'veterinarian',
  vetenarian: 'veterinarian',

  // account / change / address / create
  chnage: 'change',
  chage: 'change',
  adress: 'address',
  adres: 'address',
  acount: 'account',
  accout: 'account',
  creat: 'create',
  creats: 'create',

  // support / subscription
  suport: 'support',
  supprt: 'support',
  subscrption: 'subscription',
  subscribtion: 'subscription',
  subscripton: 'subscription',

  // pet behavior terms
  agresive: 'aggressive',
  aggresive: 'aggressive',
  agression: 'aggression',
  aggresion: 'aggression',
  anxeity: 'anxiety',
  anxitey: 'anxiety',
  anxeous: 'anxious',

  // misc common
  cancelation: 'cancellation',
  cancelations: 'cancellations',
  refunds: 'refunds',
  refund: 'refund',
  emial: 'email',
  emails: 'emails',
  loging: 'login',
  registraion: 'registration',
  registeration: 'registration',
};

// Intent keyword groups. Each phrase is matched (substring) against the corrected
// query to flag a topic. Phrases may be multi-word; single words feed KNOWN_VOCAB.
export const INTENT_KEYWORDS = {
  account_access: [
    'account',
    'create account',
    'sign up',
    'signup',
    'register',
    'registration',
    'login',
    'log in',
    'portal',
    'ease portal',
  ],

  account_management: [
    'change email',
    'update email',
    'email address',
    'delete account',
    'close account',
    'remove account',
    'account problem',
    'account issue',
    'forgot account',
  ],

  appointment_booking: [
    'appointment',
    'book appointment',
    'book online',
    'schedule appointment',
    'coaching',
    'coaching session',
    'zoom session',
    'book session',
  ],

  demo_contact: [
    'demo',
    'schedule demo',
    'book demo',
    'consultation',
    'connect with team',
    'talk to team',
    'speak with team',
    'contact team',
  ],

  support_problem: [
    'support',
    'help',
    'problem',
    'issue',
    'report problem',
    'not working',
    'trouble',
    'response from support',
  ],

  behavior_reports: [
    'behavior report',
    'behaviour report',
    'reports',
    'recommendations',
    'personalized plan',
    'behavior plan',
    'behaviour plan',
    'follow-up updates',
    'treatment plan',
    'training plan',
  ],

  pricing_policy: [
    'refund',
    'refunds',
    'money back',
    'cancellation',
    'free trial',
    'trial',
    'hidden fees',
    'monthly',
    'subscription',
    'one-time',
    'price',
    'pricing',
    'cost',
  ],

  vet_clinic: [
    'vet',
    'veterinarian',
    'veterinary',
    'clinic',
    'veterinary clinic',
    'referral',
    'refer',
    'clients',
    'patients',
    'clinic workflow',
    'clinic onboarding',
  ],

  pet_parent: [
    'dog',
    'cat',
    'pet',
    'pet parent',
    'pet owner',
    'anxiety',
    'anxious',
    'aggression',
    'aggressive',
    'separation anxiety',
    'noise phobia',
  ],

  urgent_pet_health: [
    'cannot breathe',
    'can not breathe',
    "can't breathe",
    'trouble breathing',
    'not breathing',
    'bleeding',
    'seizure',
    'collapse',
    'collapsed',
    'emergency',
  ],
};

// Short domain words worth correcting even though they are under the 4-char
// minimum length the fuzzy corrector otherwise skips.
export const SHORT_IMPORTANT_WORDS = new Set(['vet', 'cat', 'dog']);

// Dictionary the fuzzy corrector matches user tokens against. Built from the
// alias targets plus every single word appearing in the intent groups, plus a few
// core terms. Multi-word phrases are split so each word is a candidate target.
export const KNOWN_VOCAB = (() => {
  const vocab = new Set();
  for (const target of Object.values(WORD_ALIASES)) {
    for (const w of target.split(/\s+/)) if (w) vocab.add(w);
  }
  for (const phrases of Object.values(INTENT_KEYWORDS)) {
    for (const phrase of phrases) {
      for (const w of phrase.split(/[\s-]+/)) {
        if (w && w.length >= 3) vocab.add(w);
      }
    }
  }
  for (const w of [
    'ease', 'website', 'service', 'team', 'contact', 'email', 'phone',
    'behavior', 'behaviors', 'behavioral', 'plan', 'plans', 'report', 'reports',
    'recommendation', 'recommendations', 'appointment', 'appointments',
    'account', 'address', 'change', 'update', 'delete', 'create', 'register',
    'registration', 'login', 'portal', 'subscription', 'pricing', 'price',
    'refund', 'refunds', 'cancellation', 'trial', 'demo', 'consultation',
    'support', 'help', 'problem', 'issue', 'veterinarian', 'veterinary',
    'clinic', 'referral', 'anxiety', 'anxious', 'aggression', 'aggressive',
  ]) vocab.add(w);
  return vocab;
})();

// Builds one expansion string from the detected intents' keyword phrases, used as
// a last-resort recall retry during retrieval. Deduped, order-stable.
export function buildExpandedQuery(detectedIntents) {
  const intents = Array.isArray(detectedIntents) ? detectedIntents : [];
  const parts = [];
  const seen = new Set();
  for (const intent of intents) {
    const phrases = INTENT_KEYWORDS[intent];
    if (!phrases) continue;
    for (const phrase of phrases) {
      if (seen.has(phrase)) continue;
      seen.add(phrase);
      parts.push(phrase);
    }
  }
  return parts.join(' ');
}
