/* Ease Pet Vet — LEFT intent-based chatbot. A separate, self-contained instance
   that runs alongside the existing (right) widget on the same page. It starts
   anonymously (no intro form), detects audience from the conversation, and asks
   for email/contact only when follow-up intent appears. Reuses the shared
   epv-chatbot-* styles + the existing backend APIs. Distinct localStorage keys
   and DOM ids so it never collides with the right widget. */
(function () {
  'use strict';

  var cfg = (window.EASE_CHATBOT_LEFT_CONFIG && typeof window.EASE_CHATBOT_LEFT_CONFIG === 'object')
    ? window.EASE_CHATBOT_LEFT_CONFIG : {};

  var API_BASE_URL = (cfg.apiBaseUrl || 'http://localhost:3000').replace(/\/+$/, '');
  var WEBSITE_BASE_URL = (cfg.websiteBaseUrl || 'https://easepetvet.com').replace(/\/+$/, '');
  var EMAIL_LINK_MODE = cfg.emailLinkMode || 'mailto';
  var POSITION = cfg.position === 'bottom-right' ? 'bottom-right' : 'bottom-left';
  var SOURCE = 'website_chatbot';
  // Generic optional-email prompt shown at Q1/Q5/Q10/Q15 (driven by the backend's
  // usage.showEmailPrompt). Intent-based prompts use audience-specific text.
  var GENERIC_PROMPT = 'Would you like to share your email? We can use it to follow up, send future updates, or help you if your chat limit is reached.';
  var SAVE_SUCCESS = 'Thanks — our team can use this to follow up with helpful information.';
  // Short bot replies used when intercepting agreement / repeated confirmations.
  var ALREADY_HAVE = 'Thanks — we already have your email. Our team can follow up with you using the details you shared.';
  var FOLLOWUP_CONFIRM = 'Thanks — our team can follow up with you using the details you shared.';
  var CLARIFY = 'Could you please tell me what you’d like help with?';
  var EMAIL_ASK = 'Great — please type your email here and I’ll pass it to our team. You can include a contact number too if you’d prefer a call.';
  var LOGIN_COPY = 'Would you like to share your email so our team can help if you have trouble accessing the portal? You can also add your contact number if you prefer a call.';

  // Separate storage keys so the two widgets never overwrite each other. Some are
  // per-session (suffixed with the session id).
  var SESSION_KEY = 'epv_left_chatbot_session_id';
  var AUDIENCE_KEY = 'epv_left_chatbot_audience';
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
    if (sessionId) store(leadStateKey(sessionId), JSON.stringify({ leadOfferActive: leadOfferActive, lastLeadIntent: lastLeadIntent }));
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
  var leadSaved = false;
  var dismissedCounts = [];
  var leadOfferActive = false, lastLeadIntent = 'general';
  var greeted = false, convLimit = 20, remaining = null, limitReached = false;

  /* ---------- agreement / conversion detection (left widget only) ---------- */
  // Agreement: the WHOLE message is a short confirmation / acceptance (section A).
  // Anchored so it never hijacks a longer real request like "please tell me about
  // pricing" or "ready to hear the details" — those must still be answered.
  var AGREEMENT_RE = /^(?:yes|yeah|yep|yup|ok|okay|k|sure|please|ready|fine|cool|alright|great|hmm+|yes please|i am ready|i'?m ready|go ahead|book it|schedule it|connect me|contact me|call me|send (?:me )?details|share details|i want (?:a )?demo|i want to log\s?in|i want to connect|i want support|sounds good|let'?s do it)[.!\s]*$/i;
  // Explicit "I want / book / schedule ..." a conversion action (longer phrasing).
  var WANT_RE = /\b(i\s+want|i'?d\s+like|i\s+would\s+like|book|schedule|sign\s+me\s+up|let'?s\s+do)\b/i;
  // Lead/conversion topics (section A). Extends the follow-up topics.
  var CONVERSION_RE = /\bdemo\b|schedule (a )?demo|consultation|book (a )?call|contact (the )?team|connect (with )?(the )?team|\bsupport\b|follow ?up|login help|portal access|pricing help|clinic onboarding|vet onboarding|partnership|get started|set ?up|referral workflow|detailed assistance|talk to (someone|a person|the team)|speak (to|with)|reach out/i;
  var LOGIN_RE = /log\s?in|sign\s?in|portal/i;
  // A genuine question -> let the AI answer it instead of intercepting.
  var QUESTION_RE = /[?]|\b(how|where|what|when|which|why|can i|do i|should i|could you)\b/i;
  // Detect an email / phone number typed directly inside a chat message.
  var EMAIL_FIND_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  var PHONE_FIND_RE = /\+?\d[\d\s().-]{6,}\d/;
  // The AI answer itself offered a lead step ("Would you like to ... demo/connect/...").
  var BOT_ASK_RE = /would you like[^.?!]*(demo|schedule|book|consult|connect|team|follow ?up|email|log\s?in|portal|get started|set ?up)/i;

  function leadIntentFrom(text) {
    if (LOGIN_RE.test(text)) return 'login_help';
    if (/\bdemo\b|consultation|book (a )?call/i.test(text)) return 'demo_offer';
    if (/pricing/i.test(text)) return 'pricing_help';
    if (/contact|connect|team|reach out|talk to|speak/i.test(text)) return 'contact_offer';
    if (/support|follow ?up|onboarding|partnership|get started|set ?up/i.test(text)) return 'support_offer';
    return 'general';
  }
  function conversionCopy() {
    if (lastLeadIntent === 'login_help') return LOGIN_COPY;
    if (audience === 'vet') return 'Sure — please share your email so our team can follow up with clinic/demo details. You can also add your contact number if you prefer a call.';
    if (audience === 'pet_parent') return 'Sure — please share your email so our team can follow up with helpful information. You can also add your contact number if you prefer a call.';
    return 'Sure — please share your email so our team can follow up with the right information. You can also add your contact number if you prefer a call.';
  }
  // A soft, natural ask that's appended to a normal answer (woven in, not a popup
  // or an abrupt standalone message).
  function wovenEmailAsk() {
    if (audience === 'vet') return 'By the way, if you’d like our team to follow up with clinic or demo details, just share your email here and I’ll pass it along.';
    if (audience === 'pet_parent') return 'By the way, if you’d like our team to follow up and help further, feel free to share your email here.';
    return 'By the way, if you’d like our team to follow up with you, just share your email here and I’ll pass it along.';
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

  var root, panel, messagesEl, inputEl, sendBtn, launcherBtn, composerEl, remainingEl, warningEl;
  var isOpen = false, busy = false, typeTimer = null;

  function el(tag, cls, html) { var n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }

  /* ---------- intent detection ---------- */
  var VET_RE = /\bvet(s|erinary|erinarian|erinarians)?\b|\bclinic(s)?\b|veterinary team|\bportal\b|(our|my)\s+(clients|patients|practice)|recommend\s+ease|for my clinic|onboarding for vets/i;
  var PET_RE = /(my|our)\s+(dog|cat|pet|puppy|kitten|animal|dogs|cats|pets)|\bpet\s+(parent|owner)s?\b|separation anxiety|\banxiety\b|\bbehaviou?r\b|\baggression\b|help (with )?my pet|my (dog|cat|pet)/i;
  var FOLLOWUP_RE = /pricing help|partnership|onboarding|consultation|speak (to|with)|\bdemo\b|set ?up|callback|call back|contact|more details|for my clinic|help for my pet|get started|someone (can )?contact|reach out|talk to (someone|a person|the team)|want to use this|use this for my|i want more|contact me/i;

  function detectAudience(text) {
    if (VET_RE.test(text)) return 'vet';
    if (PET_RE.test(text)) return 'pet_parent';
    return null;
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
    inputEl.addEventListener('input', autoGrow); inputEl.addEventListener('keydown', onKeyDown);
    sendBtn = el('button', 'epv-chatbot-send', ICONS.send); sendBtn.setAttribute('aria-label', 'Send message');
    sendBtn.addEventListener('click', send);
    composerEl.appendChild(inputEl); composerEl.appendChild(sendBtn);
    panel.appendChild(composerEl);

    // Question counter intentionally hidden; the 20-message limit is still enforced
    // silently via applyLimitBlock().
    panel.appendChild(el('div', 'epv-chatbot-footer', 'Answers come from the Ease Pet Vet website.'));

    root.appendChild(panel); root.appendChild(launcherBtn);
    document.body.appendChild(root);

    if (sessionId) { var r = load(remainingKey(sessionId)); if (r != null && r !== '') remaining = Number(r); }
    updateUsageUI(null);
    ensureGreeted();
  }

  function ensureGreeted() {
    if (greeted) return; greeted = true;
    addBotMessage('Hi! I can help with Ease Pet Vet — pricing, how it works for vets and pet parents, behavior topics, and support. What can I help you with?');
  }

  /* ---------- usage / limit ---------- */
  function updateUsageUI(usage) {
    if (usage) {
      if (typeof usage.messageLimit === 'number') convLimit = usage.messageLimit;
      if (typeof usage.remainingMessages === 'number') remaining = usage.remainingMessages;
      limitReached = !!usage.limitReached || (remaining != null && remaining <= 0);
      if (sessionId && remaining != null) store(remainingKey(sessionId), String(remaining));
    }
    renderRemaining(); applyLimitBlock();
  }
  function renderRemaining() { /* counter hidden; limit enforced silently */ }
  function applyLimitBlock() {
    if (limitReached) { inputEl.disabled = true; sendBtn.disabled = true; inputEl.setAttribute('placeholder', 'Question limit reached'); }
    else { inputEl.disabled = false; if (!busy) sendBtn.disabled = false; inputEl.setAttribute('placeholder', 'Type your question...'); }
  }

  /* ---------- conversational email / lead capture (no popup) ---------- */
  // The bot asks for the email as a normal chat message; the user types it in the
  // chat and the inline detector (saveInlineLead) captures it. No popup card.
  function removePrompt() {} // kept as a no-op (popups removed)

  // The bot's email-ask wording. Count-based (Q1/Q5/Q10/Q15) uses GENERIC_PROMPT;
  // conversion/agreement asks use the audience-specific conversionCopy().
  function askEmailInChat(textWanted) {
    if (leadSaved) return;
    leadOfferActive = true; saveLeadState();
    addBotMessage(textWanted);
  }

  // Save an email/phone the user typed directly in chat to this session (so the
  // chat is named by the email in admin) without showing the popup form.
  function saveInlineLead(email, phone) {
    var body = { sessionId: sessionId, email: email, audience: audience, widgetSource: SOURCE };
    if (phone) body.contactNumber = phone;
    fetch(API_BASE_URL + '/api/chat/email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
      .then(function (out) {
        if (out.ok) { leadSaved = true; if (sessionId) store(emailSavedKey(sessionId), '1'); removePrompt(); }
        else { leadSaved = false; }
      })
      .catch(function () { leadSaved = false; });
  }

  /* ---------- chat plumbing (shared style with the right widget) ---------- */
  function autoGrow() { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px'; }
  function onKeyDown(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }
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
    leadSaved = false; dismissedCounts = [];
    leadOfferActive = false; lastLeadIntent = 'general';
    audience = 'unknown'; store(AUDIENCE_KEY, 'unknown');
    updateUsageUI(null); ensureGreeted();
  }

  function send() {
    if (busy || limitReached) return;
    var text = (inputEl.value || '').trim(); if (!text) return;
    inputEl.value = ''; autoGrow();

    // Intent detection (frontend): upgrade audience, never downgrade.
    var detected = detectAudience(text);
    if (detected) { audience = detected; store(AUDIENCE_KEY, audience); }

    // Inline lead capture (no popup): if the user typed an email (and maybe a
    // phone) right in the chat, capture it for this session. If the message is
    // essentially just the email, confirm in chat and skip the AI call.
    var inlineEmail = (!leadSaved) ? (text.match(EMAIL_FIND_RE) || [null])[0] : null;
    var inlinePhone = inlineEmail ? (text.match(PHONE_FIND_RE) || [null])[0] : null;
    if (sessionId && inlineEmail) {
      var leftover = text.replace(EMAIL_FIND_RE, ' ').replace(PHONE_FIND_RE, ' ').replace(/[^a-z0-9]/gi, ' ').trim();
      var emailOnly = leftover.split(/\s+/).filter(Boolean).length <= 3 && !QUESTION_RE.test(text);
      leadSaved = true; // optimistic; persisted on save
      if (emailOnly) {
        addUserMessage(text);
        saveInlineLead(inlineEmail, inlinePhone);
        addBotMessage(SAVE_SUCCESS);
        if (!limitReached) inputEl.focus();
        return;
      }
    }

    // Conversational lead capture (no popup): when the user agrees after an offer
    // or explicitly asks to book/connect, the bot ASKS for the email as a normal
    // chat message; the user then types it (captured above). Never intercept a
    // real question or an email-bearing message. Intercepted confirmations are not
    // sent to the backend, so they don't count toward the 20-question limit.
    if (sessionId && !inlineEmail && !QUESTION_RE.test(text)) {
      var conv = CONVERSION_RE.test(text);
      var isLogin = LOGIN_RE.test(text);
      var isAgree = AGREEMENT_RE.test(text);
      var isWant = WANT_RE.test(text) && conv && !isLogin;

      // (1) Explicit "I want to book a demo" style request -> ask for the email.
      if (isWant) {
        addUserMessage(text);
        lastLeadIntent = leadIntentFrom(text);
        if (leadSaved) addBotMessage(ALREADY_HAVE); else askEmailInChat(conversionCopy());
        if (!limitReached) inputEl.focus();
        return;
      }
      // (2) Standalone confirmation ("yes", "ok", "sure", ...) — section A/G.
      if (isAgree) {
        addUserMessage(text);
        if (leadSaved) {
          addBotMessage(leadOfferActive ? ALREADY_HAVE : FOLLOWUP_CONFIRM);
        } else if (leadOfferActive) {
          addBotMessage(EMAIL_ASK);
        } else {
          addBotMessage(CLARIFY);
        }
        if (!limitReached) inputEl.focus();
        return;
      }
    }

    addUserMessage(text); setBusy(true); showTyping();

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

        // Remember whether this exchange was a lead/conversion offer, so the next
        // "yes"/"ok" opens the capture form instead of repeating the answer.
        leadOfferActive = BOT_ASK_RE.test(rawAnswer) || CONVERSION_RE.test(text) || CONVERSION_RE.test(rawAnswer);
        if (leadOfferActive) {
          lastLeadIntent = leadIntentFrom((CONVERSION_RE.test(text) || userIsLogin) ? text : rawAnswer);
        }

        // Weave the optional email ask into THIS reply instead of a separate abrupt
        // message. Driven by the backend's showEmailPrompt cadence (Q1/Q5/Q10/Q15 and
        // when the limit is reached), plus one last nudge right before the final
        // question — only if no email yet and the answer didn't already ask for one.
        var botAlreadyAsked = /your email|share your email|email address/i.test(rawAnswer) || BOT_ASK_RE.test(rawAnswer);
        if (!leadSaved && !botAlreadyAsked && usage) {
          var used = usage.messagesUsed;
          var beforeLast = (usage.messageLimit || convLimit) - 1;
          if (usage.showEmailPrompt || used === beforeLast) {
            answer = rawAnswer + '\n\n' + wovenEmailAsk();
            leadOfferActive = true;
          }
        }
        saveLeadState();

        typeBotMessage(answer);
        updateUsageUI(usage);

        // Persist an email/phone the user typed inline (chat is then named by it).
        if (inlineEmail && sessionId) saveInlineLead(inlineEmail, inlinePhone);

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
