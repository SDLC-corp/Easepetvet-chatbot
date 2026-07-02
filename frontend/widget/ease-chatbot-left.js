/* Ease Pet Vet chatbot — a single, self-contained conversational widget. It starts
   anonymously (no intro form), detects audience from the conversation, and asks for
   email/contact only when follow-up intent appears. Styles live in
   ease-chatbot-left.css (epv-chatbot-* classes); it talks to the backend chat +
   email APIs. */
(function () {
  'use strict';

  var cfg = (window.EASE_CHATBOT_LEFT_CONFIG && typeof window.EASE_CHATBOT_LEFT_CONFIG === 'object')
    ? window.EASE_CHATBOT_LEFT_CONFIG : {};

  var API_BASE_URL = (cfg.apiBaseUrl || 'http://localhost:3000').replace(/\/+$/, '');
  var WEBSITE_BASE_URL = (cfg.websiteBaseUrl || 'https://easepetvet.com').replace(/\/+$/, '');
  var EMAIL_LINK_MODE = cfg.emailLinkMode || 'mailto';
  var POSITION = cfg.position === 'bottom-right' ? 'bottom-right' : 'bottom-left';
  var SOURCE = 'website_chatbot';
  // Per-message length caps. These fallbacks match the backend defaults; the real
  // values are fetched from /api/chat/health on load (fetchLimits) so the widget
  // stays in sync with the server's CHAT_MAX_MESSAGE_CHARS / _WORDS env vars.
  var MAX_CHARS = 800, MAX_WORDS = 120;
  var FOOTER_TEXT = 'Answers come from the Ease Pet Vet website.';
  var TOO_LONG_TEXT = 'Message is too long.'; // generic; never reveals the numbers
  // Short bot replies used when intercepting agreement / repeated confirmations.
  var SAVE_SUCCESS = 'Thanks — I’ve saved your details. How else can I help?';
  var ALREADY_HAVE = 'Thanks — we already have your details. Our team can follow up with you.';
  var FOLLOWUP_CONFIRM = 'Thanks — our team can follow up with you using the details you shared.';
  var CLARIFY = 'Could you please tell me what you’d like help with?';
  var EMAIL_ASK = 'Great — please share your Gmail/email and I’ll pass it to the Ease team. You can include a contact number too if you’d prefer a call.';
  // Name-first + contact-capture copy.
  var NAME_SKIP_REPLY = 'No problem. What can I help you with today?';
  var ASK_CONTACT = 'Thanks. Would you also like to share a contact number in case the team needs to call you? You can skip this if you prefer email only.';
  var CONTACT_SAVED = 'Thanks — I’ve saved your contact details. How else can I help?';
  var CONTACT_SKIPPED = 'No problem — we’ll use email only. How else can I help?';
  var DECLINE_ACK = 'No problem — I won’t ask again. How else can I help?';

  // Separate storage keys so the two widgets never overwrite each other. Some are
  // per-session (suffixed with the session id).
  var SESSION_KEY = 'epv_left_chatbot_session_id';
  var AUDIENCE_KEY = 'epv_left_chatbot_audience';
  // Browser-scoped (NOT per-session): once the question limit is hit, it stays hit
  // across clear-chat and reload so deleting the chat can't reset the cap.
  var LIMIT_KEY = 'epv_left_chatbot_limit_reached';
  var LIMIT_NOTICE = 'You’ve reached the question limit for this conversation. Clearing the chat won’t add more questions — please reach out to the Ease team if you need more help.';
  function emailSavedKey(sid) { return 'epv_left_chatbot_email_saved_' + sid; }
  function dismissedKey(sid) { return 'epv_left_chatbot_email_prompt_dismissed_counts_' + sid; }
  function remainingKey(sid) { return 'epv_left_chatbot_remaining_' + sid; }
  function leadStateKey(sid) { return 'epv_left_chatbot_lead_state_' + sid; }
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function loadDismissed(sid) {
    if (!sid) return [];
    try { var a = JSON.parse(load(dismissedKey(sid)) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function loadLeadState(sid) {
    if (!sid) return { leadOfferActive: false, lastLeadIntent: 'general' };
    try {
      var s = JSON.parse(load(leadStateKey(sid)) || '{}');
      return { leadOfferActive: !!s.leadOfferActive, lastLeadIntent: s.lastLeadIntent || 'general' };
    } catch (e) { return { leadOfferActive: false, lastLeadIntent: 'general' }; }
  }
  function saveLeadState() {
    if (sessionId) store(leadStateKey(sessionId), JSON.stringify({
      leadOfferActive: leadOfferActive, lastLeadIntent: lastLeadIntent,
      leadName: leadName, nameCaptured: nameCaptured, nameSkipped: nameSkipped,
      emailCaptured: emailCaptured, contactCaptured: contactCaptured, contactSkipped: contactSkipped,
      leadDeclined: leadDeclined, leadAskCount: leadAskCount,
    }));
  }

  // Start a FRESH conversation on every page load. The transcript is not restored
  // on reload, so reusing a stored session would carry hidden state (e.g. "email
  // already provided", question count) that contradicts the empty chat the visitor
  // sees — that's what made the bot say "we already have your email" in a brand-new
  // conversation. Clear any leftover per-session state from a previous visit.
  (function clearPreviousSession() {
    try {
      var prev = load(SESSION_KEY);
      if (prev) {
        localStorage.removeItem(emailSavedKey(prev));
        localStorage.removeItem(dismissedKey(prev));
        localStorage.removeItem(remainingKey(prev));
        localStorage.removeItem(leadStateKey(prev));
      }
      localStorage.removeItem(SESSION_KEY);
    } catch (e) {}
  })();
  var sessionId = null;
  var audience = 'unknown';
  var dismissedCounts = [];
  var leadOfferActive = false, lastLeadIntent = 'general';
  var greeted = false, convLimit = 20, remaining = null, limitReached = false;
  // Conversational lead-capture state (name-first -> email -> optional contact).
  var leadName = null, nameCaptured = false, nameSkipped = false, awaitingName = false;
  var emailCaptured = false, awaitingContact = false, contactCaptured = false, contactSkipped = false;
  // leadDeclined: user said no to an email ask -> suppress AUTOMATIC/woven asks for
  // the rest of the session (explicit demo/contact/support requests still may ask).
  // leadAskCount: number of AUTOMATIC email asks woven so far (capped, wording varies).
  var leadDeclined = false, leadAskCount = 0;
  var leadSavePromise = null; // in-flight /api/chat/lead (resolves the session id)

  /* ---------- agreement / conversion detection (left widget only) ---------- */
  // Agreement: the WHOLE message is a short confirmation / acceptance (section A).
  // Anchored so it never hijacks a longer real request like "please tell me about
  // pricing" or "ready to hear the details" — those must still be answered.
  var AGREEMENT_RE = /^(?:yes|yeah|yep|yup|ok|okay|k|sure|please|ready|fine|cool|alright|great|hmm+|yes please|i am ready|i'?m ready|go ahead|book it|schedule it|connect me|contact me|call me|send (?:me )?details|share details|i want (?:a )?demo|i want to log\s?in|i want to connect|i want support|sounds good|let'?s do it)[.!\s]*$/i;
  // Lead/conversion topics (section A). Extends the follow-up topics.
  var CONVERSION_RE = /\bdemo\b|schedule (a )?demo|consultation|book (a )?call|contact (the )?team|connect (with )?(the )?team|\bsupport\b|follow ?up|login help|portal access|pricing help|clinic onboarding|vet onboarding|partnership|get started|set ?up|referral workflow|detailed assistance|talk to (someone|a person|the team)|speak (to|with)|reach out/i;
  // Self-standing EXPLICIT follow-up requests. These are a genuine ask (not a bare
  // "yes/ok"), so they must reach the backend for a real answer AND may ask for an
  // email even after the user previously declined an automatic ask.
  var EXPLICIT_LEAD_RE = /\bdemo\b|book (?:a )?call|schedule|(?:have )?your team (?:can )?(?:contact|follow|reach)|contact (?:me|you|us)|connect me|call me|reach out|follow ?up|i want (?:support|someone|a demo|to connect|help)|someone (?:can )?(?:contact|follow|reach)|talk to (?:someone|a person|the team)|speak (?:to|with)|get started|onboard/i;
  var LOGIN_RE = /log\s?in|sign\s?in|portal/i;
  // A genuine question -> let the AI answer it instead of intercepting.
  var QUESTION_RE = /[?]|\b(how|where|what|when|which|why|can i|do i|should i|could you)\b/i;
  // Detect an email / phone number typed directly inside a chat message.
  var EMAIL_FIND_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  var PHONE_FIND_RE = /\+?\d[\d\s().-]{6,}\d/;
  // The AI answer itself offered a lead step ("Would you like to ... demo/connect/...").
  var BOT_ASK_RE = /would you like[^.?!]*(demo|schedule|book|consult|connect|team|follow ?up|email|log\s?in|portal|get started|set ?up)/i;
  // Whole-message decline of an email ask ("no", "not now", "later", ...).
  var EMAIL_DECLINE_RE = /^(?:no|no thanks?|no thank you|not now|not right now|not interested|maybe later|later|nah|nope|no email|don'?t want(?: to share| my email| the email| email)?)[.!\s]*$/i;
  // Explicit "stop asking" phrasing, allowed anywhere in a longer sentence.
  var STOP_ASKING_RE = /already said no|i said no|stop asking|don'?t ask (?:me )?again|no need to ask/i;
  // Remove emails/URLs before intent matching so an answer like "reach out to
  // support@easepetvet.com" can't be misread as a conversion/follow-up turn.
  var EMAIL_STRIP_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  var URL_STRIP_RE = /https?:\/\/[^\s]+|www\.[^\s]+/gi;
  function stripContacts(s) { return String(s || '').replace(EMAIL_STRIP_RE, ' ').replace(URL_STRIP_RE, ' '); }

  function leadIntentFrom(text) {
    if (LOGIN_RE.test(text)) return 'login_help';
    if (/\bdemo\b|consultation|book (a )?call/i.test(text)) return 'demo_offer';
    if (/pricing/i.test(text)) return 'pricing_help';
    if (/contact|connect|team|reach out|talk to|speak/i.test(text)) return 'contact_offer';
    if (/support|follow ?up|onboarding|partnership|get started|set ?up/i.test(text)) return 'support_offer';
    return 'general';
  }
  // Soft, natural ask appended to the END of a normal answer (woven in, never a
  // standalone/abrupt message). Intent- and audience-aware.
  function wovenEmailAsk() {
    // Second (and later) asks use softer, different wording so it never reads as a
    // repeated copy-paste line. leadAskCount is still pre-increment here (0 -> first).
    var i = leadAskCount > 0 ? 1 : 0;
    var v;
    if (lastLeadIntent === 'demo_offer' || lastLeadIntent === 'contact_offer' || audience === 'vet')
      v = ['By the way, if you’d like our team to follow up with clinic or demo details, just share your email here and I’ll pass it along.',
           'Whenever you’re ready, drop your email and I’ll have the team reach out with the clinic and demo details.'];
    else if (lastLeadIntent === 'support_offer' || lastLeadIntent === 'login_help')
      v = ['By the way, if you’d like our team to follow up about your account or support request, just share your email here.',
           'Whenever it’s convenient, leave your email and I’ll have support follow up with you.'];
    else if (lastLeadIntent === 'pricing_help')
      v = ['By the way, if you’d like the Ease team to follow up with pricing details, just share your email here.',
           'And if pricing follow-up would help, just drop your email whenever you’re ready.'];
    else if (audience === 'pet_parent')
      v = ['By the way, if you’d like our team to follow up and help further, feel free to share your email here.',
           'Whenever you’re ready, you can leave your email and we’ll follow up to help further.'];
    else
      v = ['By the way, if you’d like the Ease team to follow up, just share your email here and I’ll pass it along.',
           'And whenever you’re ready, just drop your email and I’ll have the team follow up.'];
    return v[i];
  }

  /* ---------- name detection + derived name (frontend, no NLP libs) ---------- */
  var NAME_INTRO_RE = /\b(?:my name is|i am|i'?m|this is|name'?s|call me)\s+(.+)$/i;
  var NAME_SKIP_RE = /^(?:skip|no|no thanks?|no thank you|not now|later|maybe later|nah|prefer not|rather not)[.!\s]*$/i;
  var CONTACT_SKIP_RE = /^(?:skip|no|no thanks?|no thank you|not now|later|nope|nah|email only|prefer email|that'?s ok|that'?s fine)[.!\s]*$/i;
  var NON_NAME_WORD_RE = /^(pricing|price|cost|demo|support|login|help|account|refund|appointment|booking|book|anxiety|aggression|behaviou?r|yes|ok|okay|hi|hello|hey|thanks|thank|vet|vets|dog|dogs|cat|cats|pet|pets)$/i;

  function isNameSkip(text) { return NAME_SKIP_RE.test(String(text || '').trim()); }

  function isProbablyName(text) {
    var t = String(text || '').trim();
    if (!t || t.length > 40) return false;
    if (QUESTION_RE.test(t) || /[?]/.test(t)) return false;
    if (EMAIL_FIND_RE.test(t) || PHONE_FIND_RE.test(t)) return false;
    if (NAME_INTRO_RE.test(t)) return true; // "my name is ...", "i am ...", "this is ..."
    // Bare reply (no "my name is …"): treat it as a name ONLY when it is a single
    // word of at most 12 characters. Anything with a space (e.g. "I LIKE IT") or
    // longer than 12 chars is a normal message, not a name.
    var word = t.replace(/[.,!]+$/, '');
    if (/\s/.test(word)) return false;                       // must be one word
    if (word.length < 1 || word.length > 12) return false;   // 12-character cap
    if (!/^[A-Za-z][A-Za-z'’.\-]*$/.test(word)) return false; // letters only
    if (NON_NAME_WORD_RE.test(word)) return false;           // not a greeting/topic
    return true;
  }

  function titleCaseWord(w) { return w ? w.charAt(0).toUpperCase() + w.slice(1) : w; }

  function extractName(text) {
    var t = String(text || '').trim().replace(/[.!]+$/, '');
    var m = t.match(NAME_INTRO_RE);
    if (m) t = m[1].trim();
    var words = t.split(/\s+/).filter(Boolean).slice(0, 3);
    return words.map(titleCaseWord).join(' ');
  }

  // shrinath.kathar@gmail.com -> "Shrinath Kathar"; john123@gmail.com -> "John".
  function deriveNameFromEmail(email) {
    var local = String(email || '').split('@')[0] || '';
    local = local.replace(/[._\-]+/g, ' ').replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!local) return null;
    var words = local.split(' ').filter(Boolean).slice(0, 3);
    if (!words.length) return null;
    return words.map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }).join(' ');
  }

  var ICONS = {
    chat: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3C6.5 3 2 6.8 2 11.5c0 2.2 1 4.2 2.7 5.7L4 21l4.2-1.6c1.2.3 2.5.5 3.8.5 5.5 0 10-3.8 10-8.5S17.5 3 12 3z"/></svg>',
    paw: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="10" r="2"/><circle cx="10" cy="6" r="2"/><circle cx="14" cy="6" r="2"/><circle cx="18" cy="10" r="2"/><path d="M12 12c-2.5 0-4.5 2-4.5 4 0 1.7 1.3 3 3 3 .7 0 1-.3 1.5-.3s.8.3 1.5.3c1.7 0 3-1.3 3-3 0-2-2-4-4.5-4z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    clear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 11l18-8-8 18-2-7-8-3z"/></svg>',
    ease: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><mask id="epvLeftEaseCut"><rect width="64" height="64" fill="#fff"/><circle cx="42" cy="32" r="18.5" fill="#000"/></mask></defs><circle cx="30" cy="32" r="27" fill="#1AB5AC" mask="url(#epvLeftEaseCut)"/><path d="M31 46 C24.5 40 16 35.5 16 28.3 C16 23 21.8 20.8 26 23.5 C28.2 24.9 29.9 27.4 31 29.6 C32.1 27.4 33.8 24.9 36 23.5 C40.2 20.8 46 23 46 28.3 C46 35.5 37.5 40 31 46 Z" fill="#0E8C84"/><path d="M24.5 31 L30.5 38 L49 15.5" fill="none" stroke="#0E8C84" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    easeFull: '<svg viewBox="0 0 250 72" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="ease"><defs><mask id="epvLeftEaseFullCut"><rect width="72" height="72" fill="#fff"/><circle cx="46" cy="36" r="20.5" fill="#000"/></mask></defs><circle cx="33" cy="36" r="30" fill="#1AB5AC" mask="url(#epvLeftEaseFullCut)"/><path d="M34 51 C27 44.5 17.5 39.5 17.5 31.5 C17.5 25.5 24 23 28.7 26 C31.2 27.6 33 30.4 34 32.8 C35 30.4 36.8 27.6 39.3 26 C44 23 50.5 25.5 50.5 31.5 C50.5 39.5 41 44.5 34 51 Z" fill="#0E8C84"/><path d="M26.5 34.5 L33.5 42.5 L54 17" fill="none" stroke="#0E8C84" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/><text x="80" y="53" font-family="Poppins, Nunito, Quicksand, \'Segoe UI\', system-ui, Arial, sans-serif" font-size="56" font-weight="700" letter-spacing="-2" fill="#333333">ease</text></svg>',
  };

  var root, panel, messagesEl, inputEl, sendBtn, launcherBtn, composerEl, remainingEl, warningEl, footerEl;
  var isOpen = false, busy = false, typeTimer = null;

  function el(tag, cls, html) { var n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }

  /* ---------- intent detection ---------- */
  var VET_RE = /\bvet(s|erinary|erinarian|erinarians)?\b|\bclinic(s)?\b|veterinary team|\bportal\b|(our|my)\s+(clients|patients|practice)|recommend\s+ease|for my clinic|onboarding for vets/i;
  var PET_RE = /(my|our)\s+(dog|cat|pet|puppy|kitten|animal|dogs|cats|pets)|\bi\s+have\s+(a\s+)?(dog|cat|pet|puppy|kitten)\b|\bpet\s+(parent|owner)s?\b|separation anxiety|\banxiety\b|\bbehaviou?r\b|\baggression\b|help (with )?my pet|my (dog|cat|pet)/i;
  var FOLLOWUP_RE = /pricing help|partnership|onboarding|consultation|speak (to|with)|\bdemo\b|set ?up|callback|call back|contact|more details|for my clinic|help for my pet|get started|someone (can )?contact|reach out|talk to (someone|a person|the team)|want to use this|use this for my|i want more|contact me/i;
  // Strong = explicit self-identification. Used to (a) prefer the right audience on
  // first detection and (b) allow flipping an already-set audience. Weak topic
  // mentions (e.g. "clinic", "anxiety") never flip a locked audience.
  var STRONG_VET_RE = /\b(i'?m|i am|we'?re|we are)\s+(a\s+)?(vet|veterinarian|veterinary|dvm)\b|\bas a (vet|veterinarian)\b|\b(my|our)\s+(clinic|practice|hospital)\b|onboard(?:ing)?\s+(?:my|our)\s+(?:clinic|practice)|for (?:my|our) (?:clinic|practice)|\b(?:my|our)\s+(?:patients|clients)\b/i;
  var STRONG_PET_RE = /\bi(?:'?m| am)\s+a\s+pet\s+(?:parent|owner)\b|\bi\s+have\s+(?:a\s+)?(?:dog|cat|pet|puppy|kitten)\b|\b(?:my|our)\s+(?:dog|cat|pet|puppy|kitten)\b/i;

  function detectAudience(text) {
    // Prefer explicit self-identification; fall back to general topic signals.
    if (STRONG_VET_RE.test(text)) return 'vet';
    if (STRONG_PET_RE.test(text)) return 'pet_parent';
    if (VET_RE.test(text) && !PET_RE.test(text)) return 'vet';
    if (PET_RE.test(text)) return 'pet_parent';
    return null;
  }
  function isStrongAudience(text, aud) {
    if (aud === 'vet') return STRONG_VET_RE.test(text);
    if (aud === 'pet_parent') return STRONG_PET_RE.test(text);
    return false;
  }
  function isFollowup(text) { return FOLLOWUP_RE.test(text); }

  /* ---------- build ---------- */
  function build() {
    root = el('div', 'epv-chatbot-root epv-pos-' + POSITION);
    launcherBtn = el('button', 'epv-chatbot-launcher', ICONS.chat);
    launcherBtn.setAttribute('aria-label', 'Open Ease Pet Vet Assistant');
    launcherBtn.addEventListener('click', toggle);

    panel = el('div', 'epv-chatbot-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Ease Pet Vet Assistant');

    var header = el('div', 'epv-chatbot-header');
    var logo = el('div', null, ICONS.easeFull);
    logo.style.cssText = 'background:#fff;border-radius:8px;padding:4px 9px;display:flex;align-items:center;flex:none';
    var logoSvg = logo.querySelector('svg');
    if (logoSvg) { logoSvg.style.height = '22px'; logoSvg.style.width = 'auto'; logoSvg.style.display = 'block'; }
    header.appendChild(logo);
    var ht = el('div', 'epv-chatbot-header-text');
    ht.appendChild(el('div', 'epv-chatbot-title', 'Pet Vet Assistant'));
    ht.appendChild(el('div', 'epv-chatbot-subtitle', 'Ask anything — vets, pet parents, pricing, support'));
    header.appendChild(ht);
    var actions = el('div', 'epv-chatbot-header-actions');
    var clearBtn = el('button', 'epv-chatbot-icon-btn', ICONS.clear);
    clearBtn.setAttribute('title', 'Delete chat history'); clearBtn.addEventListener('click', clearChat);
    var closeBtn = el('button', 'epv-chatbot-icon-btn', ICONS.close);
    closeBtn.setAttribute('title', 'Minimize chat'); closeBtn.addEventListener('click', toggle);
    actions.appendChild(clearBtn); actions.appendChild(closeBtn);
    header.appendChild(actions);
    panel.appendChild(header);

    messagesEl = el('div', 'epv-chatbot-messages'); messagesEl.setAttribute('aria-live', 'polite');
    panel.appendChild(messagesEl);

    composerEl = el('div', 'epv-chatbot-composer');
    inputEl = el('textarea', 'epv-chatbot-input'); inputEl.setAttribute('rows', '1');
    inputEl.setAttribute('placeholder', 'Type your question...'); inputEl.setAttribute('aria-label', 'Message');
    inputEl.setAttribute('maxlength', String(MAX_CHARS)); // native hard-cap on characters
    inputEl.addEventListener('input', autoGrow); inputEl.addEventListener('input', enforceLimit);
    inputEl.addEventListener('keydown', onKeyDown);
    sendBtn = el('button', 'epv-chatbot-send', ICONS.send); sendBtn.setAttribute('aria-label', 'Send message');
    sendBtn.addEventListener('click', send);
    composerEl.appendChild(inputEl); composerEl.appendChild(sendBtn);
    panel.appendChild(composerEl);

    // Question counter intentionally hidden; the 20-message limit is still enforced
    // silently via applyLimitBlock().
    footerEl = el('div', 'epv-chatbot-footer', FOOTER_TEXT);
    panel.appendChild(footerEl);

    root.appendChild(panel); root.appendChild(launcherBtn);
    document.body.appendChild(root);

    if (sessionId) { var r = load(remainingKey(sessionId)); if (r != null && r !== '') remaining = Number(r); }
    if (load(LIMIT_KEY) === '1') limitReached = true; // stay capped across reloads
    updateUsageUI(null);
    greetOrLimit();
    fetchLimits();
  }

  function ensureGreeted() {
    if (greeted) return; greeted = true;
    awaitingName = true;
    addBotMessage('Hi! I can help with Ease Pet Vet — pricing, how it works for vets and pet parents, behavior topics, demos, and support. Before we begin, may I know your name?');
  }

  // Greet normally, or — if the browser already hit the question cap — show the
  // limit notice instead (the input stays disabled via applyLimitBlock). Used on
  // build and after clear-chat so the cap can't be reset by deleting the chat.
  function greetOrLimit() {
    if (limitReached) { greeted = true; awaitingName = false; addBotMessage(LIMIT_NOTICE); }
    else ensureGreeted();
  }

  /* ---------- usage / limit ---------- */
  function updateUsageUI(usage) {
    if (usage) {
      if (typeof usage.messageLimit === 'number') convLimit = usage.messageLimit;
      if (typeof usage.remainingMessages === 'number') remaining = usage.remainingMessages;
      limitReached = !!usage.limitReached || (remaining != null && remaining <= 0);
      if (sessionId && remaining != null) store(remainingKey(sessionId), String(remaining));
      if (limitReached) store(LIMIT_KEY, '1'); // remember across clear + reload
    }
    renderRemaining(); applyLimitBlock();
  }
  function renderRemaining() { /* counter hidden; limit enforced silently */ }
  function applyLimitBlock() {
    if (limitReached) { inputEl.disabled = true; sendBtn.disabled = true; inputEl.setAttribute('placeholder', 'Question limit reached'); }
    else { inputEl.disabled = false; if (!busy) sendBtn.disabled = false; inputEl.setAttribute('placeholder', 'Type your question...'); }
  }

  /* ---------- conversational name / email / contact capture (no popup) ---------- */
  // The bot asks for name/email/contact as normal chat messages; the user types
  // them in the chat and saveLeadInfo() persists them via /api/chat/lead. No form.
  function removePrompt() {} // kept as a no-op (popups removed)

  // General conversational lead save (name and/or email and/or contact number).
  // Uses POST /api/chat/lead, which creates/resolves the session, so it works even
  // before a session exists. Stores the returned sessionId and tracks the in-flight
  // request so the next /message can reuse the same session (no duplicate rows).
  function saveLeadInfo(info) {
    // Build + POST when it actually runs (not now), so a save chained after an
    // earlier one picks up the sessionId that earlier save created.
    var run = function () {
      var body = { audience: audience, widgetSource: SOURCE };
      if (sessionId) body.sessionId = sessionId;
      if (info.name) body.name = info.name;
      if (info.email) body.email = info.email;
      if (info.contactNumber) body.contactNumber = info.contactNumber;
      if (info.nameIsDerived) body.nameIsDerived = true;
      return fetch(API_BASE_URL + '/api/chat/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
        .then(function (out) {
          if (out.ok && out.data && out.data.sessionId) {
            sessionId = out.data.sessionId; store(SESSION_KEY, sessionId);
            if (out.data.emailSaved) { emailCaptured = true; store(emailSavedKey(sessionId), '1'); }
            saveLeadState();
          }
        })
        .catch(function () {});
    };
    // Chain after any in-flight lead save so a rapid name -> email -> contact all
    // land on the SAME session (the first save creates it; the rest reuse it).
    var p = (leadSavePromise || Promise.resolve()).then(run, run);
    leadSavePromise = p;
    return p;
  }

  /* ---------- chat plumbing (shared style with the right widget) ---------- */
  function autoGrow() { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px'; }
  function onKeyDown(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }
  // Show/clear the generic "too long" notice in the footer spot (no numbers).
  function setFooterWarning(on) {
    if (!footerEl) return;
    footerEl.textContent = on ? TOO_LONG_TEXT : FOOTER_TEXT;
    footerEl.classList.toggle('epv-chatbot-footer-warning', !!on);
  }
  // Live cap: characters are held by the native maxlength; words are trimmed here.
  // Warns (and blocks going further) once either ceiling is reached.
  function enforceLimit() {
    var words = (inputEl.value || '').split(/\s+/).filter(Boolean);
    if (words.length > MAX_WORDS) { inputEl.value = words.slice(0, MAX_WORDS).join(' '); words = words.slice(0, MAX_WORDS); }
    var reached = inputEl.value.trim().length >= MAX_CHARS || words.length >= MAX_WORDS;
    setFooterWarning(reached);
  }
  // Pull the live limits from the backend so the widget matches the server env vars.
  // On any failure it silently keeps the fallback defaults set above.
  function fetchLimits() {
    fetch(API_BASE_URL + '/api/chat/health', { method: 'GET' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.limits) return;
        if (Number(d.limits.maxMessageChars) > 0) MAX_CHARS = Number(d.limits.maxMessageChars);
        if (Number(d.limits.maxMessageWords) > 0) MAX_WORDS = Number(d.limits.maxMessageWords);
        if (inputEl) inputEl.setAttribute('maxlength', String(MAX_CHARS));
      })
      .catch(function () {});
  }
  function toggle() {
    isOpen = !isOpen; root.classList.toggle('epv-open', isOpen);
    launcherBtn.innerHTML = isOpen ? ICONS.close : ICONS.chat;
    if (isOpen) setTimeout(function () { if (!inputEl.disabled) inputEl.focus(); }, 150);
  }
  function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }
  function addUserMessage(text) { var n = el('div', 'epv-chatbot-msg epv-chatbot-msg-user'); n.textContent = text; messagesEl.appendChild(n); scrollDown(); }

  function buildHref(type, value) {
    if (type === 'url') return value;
    if (type === 'www') return 'https://' + value;
    if (type === 'path') return WEBSITE_BASE_URL + value;
    if (type === 'email') return EMAIL_LINK_MODE === 'gmail' ? 'https://mail.google.com/mail/?view=cm&fs=1&to=' + encodeURIComponent(value) : 'mailto:' + value;
    return value;
  }
  function appendLinkified(parent, text) {
    if (!text) return;
    var pattern = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})|(https?:\/\/[^\s]+)|(www\.[^\s]+)|(\/[A-Za-z0-9._~\-/]*[A-Za-z0-9][A-Za-z0-9._~\-/]*\/?)/g;
    var last = 0, m;
    while ((m = pattern.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      var type = m[1] ? 'email' : m[2] ? 'url' : m[3] ? 'www' : 'path';
      var token = m[0], trailing = '';
      if (type !== 'email') { var t = token.match(/[.,;:!?)\]]+$/); if (t) { trailing = t[0]; token = token.slice(0, token.length - trailing.length); } }
      var a = document.createElement('a'); a.className = 'epv-chatbot-link'; a.textContent = token; a.href = buildHref(type, token);
      if (type !== 'email' || EMAIL_LINK_MODE === 'gmail') { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      parent.appendChild(a); if (trailing) parent.appendChild(document.createTextNode(trailing));
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }
  function addBotMessage(text) { var n = el('div', 'epv-chatbot-msg epv-chatbot-msg-bot'); appendLinkified(n, text); messagesEl.appendChild(n); scrollDown(); }
  function typeBotMessage(text) {
    var n = el('div', 'epv-chatbot-msg epv-chatbot-msg-bot'); messagesEl.appendChild(n);
    var i = 0, step = Math.max(2, Math.round(text.length / 140));
    function tick() {
      i = Math.min(text.length, i + step); n.textContent = text.slice(0, i); scrollDown();
      if (i < text.length) typeTimer = setTimeout(tick, 16);
      else { n.textContent = ''; appendLinkified(n, text); scrollDown(); }
    }
    tick();
  }
  function addErrorMessage(text) { var n = el('div', 'epv-chatbot-msg epv-chatbot-msg-bot epv-chatbot-msg-error'); n.textContent = text; messagesEl.appendChild(n); scrollDown(); }
  function showTyping() { var n = el('div', 'epv-chatbot-msg epv-chatbot-msg-bot'); n.id = 'epv-left-typing'; n.appendChild(el('div', 'epv-chatbot-typing', '<span></span><span></span><span></span>')); messagesEl.appendChild(n); scrollDown(); }
  function hideTyping() { var t = document.getElementById('epv-left-typing'); if (t) t.remove(); }
  function setBusy(v) { busy = v; sendBtn.disabled = v; }

  function clearChat() {
    if (typeTimer) { clearTimeout(typeTimer); typeTimer = null; }
    removePrompt(); messagesEl.innerHTML = '';
    if (sessionId) {
      try {
        localStorage.removeItem(emailSavedKey(sessionId));
        localStorage.removeItem(dismissedKey(sessionId));
        localStorage.removeItem(remainingKey(sessionId));
        localStorage.removeItem(leadStateKey(sessionId));
      } catch (e) {}
    }
    sessionId = null; store(SESSION_KEY, '');
    greeted = false; remaining = null; limitReached = false;
    dismissedCounts = [];
    leadOfferActive = false; lastLeadIntent = 'general';
    // Reset conversational lead-capture state so the name prompt starts fresh.
    leadName = null; nameCaptured = false; nameSkipped = false; awaitingName = false;
    emailCaptured = false; awaitingContact = false; contactCaptured = false; contactSkipped = false;
    leadDeclined = false; leadAskCount = 0;
    leadSavePromise = null;
    audience = 'unknown'; store(AUDIENCE_KEY, 'unknown');
    // Preserve the browser-scoped question cap: clearing the chat must NOT reset it.
    limitReached = (load(LIMIT_KEY) === '1');
    updateUsageUI(null); greetOrLimit();
  }

  function send() {
    if (busy || limitReached) return;
    var text = (inputEl.value || '').trim(); if (!text) return;
    // Never send an over-limit message (the input is already hard-capped; this is a
    // belt-and-suspenders guard so the backend "too long" reply can't be triggered).
    if (text.length > MAX_CHARS || text.split(/\s+/).filter(Boolean).length > MAX_WORDS) {
      setFooterWarning(true); return;
    }
    inputEl.value = ''; autoGrow(); setFooterWarning(false);

    // Intent detection (frontend): set audience on the first clear signal; once set,
    // only flip on a strong/explicit signal for the other audience (never on weak
    // topic mentions), and never downgrade back to 'unknown'.
    var detected = detectAudience(text);
    if (detected) {
      if (audience === 'unknown') { audience = detected; store(AUDIENCE_KEY, audience); }
      else if (detected !== audience && isStrongAudience(text, detected)) { audience = detected; store(AUDIENCE_KEY, audience); }
    }

    // ----- Name-first capture (never a hard gate) -----
    if (awaitingName) {
      if (isNameSkip(text)) {
        addUserMessage(text);
        awaitingName = false; nameSkipped = true; saveLeadState();
        addBotMessage(NAME_SKIP_REPLY);
        if (!limitReached) inputEl.focus(); return;
      }
      if (isProbablyName(text)) {
        addUserMessage(text);
        var nm = extractName(text);
        awaitingName = false; nameCaptured = true; leadName = nm; saveLeadState();
        saveLeadInfo({ name: nm });
        addBotMessage('Thanks, ' + nm + '. What can I help you with today?');
        if (!limitReached) inputEl.focus(); return;
      }
      // A real question instead of a name -> stop asking, answer it normally.
      awaitingName = false; nameSkipped = true; saveLeadState();
    }

    // ----- Inline email capture (works even before a session exists) -----
    var inlineEmail = (!emailCaptured) ? (text.match(EMAIL_FIND_RE) || [null])[0] : null;
    var inlinePhone = inlineEmail ? (text.match(PHONE_FIND_RE) || [null])[0] : null;
    if (inlineEmail) {
      var leftover = text.replace(EMAIL_FIND_RE, ' ').replace(PHONE_FIND_RE, ' ').replace(/[^a-z0-9]/gi, ' ').trim();
      var emailOnly = leftover.split(/\s+/).filter(Boolean).length <= 3 && !QUESTION_RE.test(text);
      if (emailOnly) {
        addUserMessage(text);
        var derived = (!nameCaptured && !leadName) ? deriveNameFromEmail(inlineEmail) : null;
        if (derived) leadName = derived;
        emailCaptured = true;
        saveLeadInfo({ email: inlineEmail, contactNumber: inlinePhone, name: derived, nameIsDerived: !!derived });
        if (inlinePhone) { contactCaptured = true; saveLeadState(); addBotMessage(SAVE_SUCCESS); }
        else { awaitingContact = true; saveLeadState(); addBotMessage(ASK_CONTACT); }
        if (!limitReached) inputEl.focus(); return;
      }
      // Email embedded in a longer question -> saved after the answer (below).
    }

    // ----- Optional contact-number capture (after email) -----
    if (awaitingContact && !inlineEmail) {
      var phoneOnly = (text.match(PHONE_FIND_RE) || [null])[0];
      if (phoneOnly && !QUESTION_RE.test(text)) {
        addUserMessage(text);
        contactCaptured = true; awaitingContact = false; saveLeadState();
        saveLeadInfo({ contactNumber: phoneOnly });
        addBotMessage(CONTACT_SAVED);
        if (!limitReached) inputEl.focus(); return;
      }
      if (CONTACT_SKIP_RE.test(text)) {
        addUserMessage(text);
        contactSkipped = true; awaitingContact = false; saveLeadState();
        addBotMessage(CONTACT_SKIPPED);
        if (!limitReached) inputEl.focus(); return;
      }
      // Neither a number nor a skip -> stop asking; answer normally.
      awaitingContact = false; contactSkipped = true; saveLeadState();
    }

    // ----- Decline interception: "no / not now / stop asking" to an email offer.
    // Suppress all future AUTOMATIC email asks, acknowledge, and do NOT send to RAG.
    // (An explicit demo/contact/support request later can still ask — see sendToBackend.)
    if (!inlineEmail && !emailCaptured && !awaitingContact &&
        ((leadOfferActive && EMAIL_DECLINE_RE.test(text)) || STOP_ASKING_RE.test(text))) {
      addUserMessage(text);
      leadDeclined = true; leadOfferActive = false; saveLeadState();
      addBotMessage(DECLINE_ACK);
      if (!limitReached) inputEl.focus(); return;
    }

    // ----- Agreement interception: a bare "yes/ok/sure" reply to an email offer.
    // Explicit interest like "I want a demo" / "contact me" is NOT intercepted — it
    // falls through to the backend for a real answer with the email ask woven at the
    // end (the explicit-intent path in sendToBackend). -----
    if (!inlineEmail && !QUESTION_RE.test(text) && AGREEMENT_RE.test(text) && !EXPLICIT_LEAD_RE.test(text)) {
      addUserMessage(text);
      if (emailCaptured) addBotMessage(leadOfferActive ? ALREADY_HAVE : FOLLOWUP_CONFIRM);
      else if (leadOfferActive) addBotMessage(EMAIL_ASK);
      else addBotMessage(CLARIFY);
      if (!limitReached) inputEl.focus(); return;
    }

    // ----- Normal /message flow -----
    addUserMessage(text); setBusy(true); showTyping();
    // If a lead save is still creating the session, wait for it so this message
    // reuses the same session (no duplicate session with the lead detached).
    if (!sessionId && leadSavePromise) {
      leadSavePromise.then(function () { sendToBackend(text, inlineEmail, inlinePhone); },
                           function () { sendToBackend(text, inlineEmail, inlinePhone); });
    } else {
      sendToBackend(text, inlineEmail, inlinePhone);
    }
  }

  function sendToBackend(text, inlineEmail, inlinePhone) {
    var body = { message: text, audience: audience, widgetSource: SOURCE };
    if (sessionId) body.sessionId = sessionId;

    fetch(API_BASE_URL + '/api/chat/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
      .then(function (out) {
        hideTyping();
        if (!out.ok || !out.data || typeof out.data.answer !== 'string') {
          addErrorMessage((out.data && out.data.error) ? out.data.error : 'Something went wrong. Please try again.'); return;
        }
        if (out.data.sessionId) { sessionId = out.data.sessionId; store(SESSION_KEY, sessionId); }
        var rawAnswer = out.data.answer;
        var answer = rawAnswer;
        var usage = out.data.usage;
        var userIsLogin = LOGIN_RE.test(text);

        // Whether the USER explicitly asked for follow-up this turn (their own words,
        // with any emails/URLs stripped so an answer's "support@..." can't leak in).
        // The bot's answer text is NOT used to detect conversion intent anymore.
        var cleanUserText = stripContacts(text);
        var explicitIntent = CONVERSION_RE.test(cleanUserText) || EXPLICIT_LEAD_RE.test(cleanUserText);
        var botOffered = BOT_ASK_RE.test(rawAnswer);
        // Remember whether an offer is on the table, so a following "yes"/"ok" opens
        // the email ask, and track the intent purely for the ask's wording.
        leadOfferActive = botOffered;
        if (botOffered) lastLeadIntent = leadIntentFrom(rawAnswer);
        else if (explicitIntent || userIsLogin) lastLeadIntent = leadIntentFrom(userIsLogin ? text : cleanUserText);

        // Weave the optional email ask softly onto the END of THIS reply — never if
        // we already have an email, are collecting contact, or the answer itself asked.
        // Two paths:
        //   - explicit user request (demo/contact/support): always allowed, even after
        //     a prior "no", and not limited by the automatic cap.
        //   - automatic cadence (showEmailPrompt Q1/Q5/Q10/Q15, or the last question):
        //     suppressed after a decline and capped at 2 asks, with varied wording.
        var botAlreadyAsked = /your email|share your email|email address|gmail/i.test(rawAnswer) || botOffered;
        if (!emailCaptured && !awaitingContact && !botAlreadyAsked && usage) {
          var used = usage.messagesUsed;
          var beforeLast = (usage.messageLimit || convLimit) - 1;
          var autoTrigger = usage.showEmailPrompt || used === beforeLast;
          if (explicitIntent) {
            answer = rawAnswer + '\n\n' + wovenEmailAsk();
            leadOfferActive = true; leadAskCount++;
          } else if (!leadDeclined && leadAskCount < 2 && autoTrigger) {
            answer = rawAnswer + '\n\n' + wovenEmailAsk();
            leadOfferActive = true; leadAskCount++;
          }
        }
        saveLeadState();

        typeBotMessage(answer);
        updateUsageUI(usage);

        // Persist an email/phone the user typed inside a longer question.
        if (inlineEmail && !emailCaptured) {
          var derived2 = (!nameCaptured && !leadName) ? deriveNameFromEmail(inlineEmail) : null;
          if (derived2) leadName = derived2;
          emailCaptured = true;
          saveLeadInfo({ email: inlineEmail, contactNumber: inlinePhone, name: derived2, nameIsDerived: !!derived2 });
        }

        // Login reliability: make sure the login link is offered.
        if (userIsLogin && !/\/login\b/i.test(rawAnswer) && !/login\./i.test(rawAnswer)) {
          addBotMessage('You can log in here: ' + WEBSITE_BASE_URL + '/login/');
          leadOfferActive = true; lastLeadIntent = 'login_help'; saveLeadState();
        }
      })
      .catch(function () { hideTyping(); addErrorMessage('Sorry, I could not connect to the chatbot service. Please try again later.'); })
      .finally(function () { setBusy(false); applyLimitBlock(); if (!limitReached) inputEl.focus(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
