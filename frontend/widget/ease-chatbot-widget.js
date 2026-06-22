/* Ease Pet Vet chatbot widget. Self-contained vanilla JS. Attaches a floating
   chat panel that calls POST {apiBaseUrl}/api/chat/message. No dependencies, no
   API keys in the frontend. All DOM classes are namespaced epv-chatbot-*. */
(function () {
  'use strict';

  var scriptEl = document.currentScript;
  var userConfig = (window.EASE_CHATBOT_CONFIG && typeof window.EASE_CHATBOT_CONFIG === 'object')
    ? window.EASE_CHATBOT_CONFIG
    : {};

  function dataAttr(name, fallback) {
    if (scriptEl && scriptEl.getAttribute('data-' + name)) return scriptEl.getAttribute('data-' + name);
    return fallback;
  }

  var API_BASE_URL = (dataAttr('api-base-url', null) || userConfig.apiBaseUrl || 'http://localhost:3000').replace(/\/+$/, '');
  var POSITION = dataAttr('position', null) || userConfig.position || 'bottom-right';
  var DEFAULT_AUDIENCE = userConfig.defaultAudience || 'unknown';
  var WEBSITE_BASE_URL = (dataAttr('website-base-url', null) || userConfig.websiteBaseUrl || 'https://easepetvet.com').replace(/\/+$/, '');
  var EMAIL_LINK_MODE = dataAttr('email-link-mode', null) || userConfig.emailLinkMode || 'mailto';

  var SESSION_KEY = 'epv_chatbot_session_id';
  var AUDIENCE_KEY = 'epv_chatbot_audience';
  var LEAD_KEY = 'epv_chatbot_lead';
  var VALID_AUDIENCES = ['pet_parent', 'vet', 'unknown'];
  var AUDIENCES = [
    { value: 'pet_parent', label: 'Pet Parent' },
    { value: 'vet', label: 'Vet' },
    { value: 'unknown', label: 'Not sure' },
  ];
  // Same pragmatic email shape check the backend uses.
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* ignore */ } }
  function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

  var sessionId = load(SESSION_KEY) || null;
  var audience = load(AUDIENCE_KEY) || DEFAULT_AUDIENCE;
  if (VALID_AUDIENCES.indexOf(audience) < 0) audience = 'unknown';

  // Returning visitors who already submitted the intro form skip straight to chat.
  var savedLead = (function () { try { return JSON.parse(load(LEAD_KEY) || 'null'); } catch (e) { return null; } })();
  var leadName = (savedLead && savedLead.name) ? savedLead.name : null;
  var formAudience = null;

  // Conversation usage state (driven by the API usage object).
  var greeted = false;
  var convLimit = 20;     // updated from usage.messageLimit
  var remaining = null;   // updated from usage.remainingMessages
  var limitReached = false;

  function remainingKey() { return 'epv_chatbot_remaining_' + (sessionId || 'none'); }

  var ICONS = {
    chat: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3C6.5 3 2 6.8 2 11.5c0 2.2 1 4.2 2.7 5.7L4 21l4.2-1.6c1.2.3 2.5.5 3.8.5 5.5 0 10-3.8 10-8.5S17.5 3 12 3z"/></svg>',
    paw: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="10" r="2"/><circle cx="10" cy="6" r="2"/><circle cx="14" cy="6" r="2"/><circle cx="18" cy="10" r="2"/><path d="M12 12c-2.5 0-4.5 2-4.5 4 0 1.7 1.3 3 3 3 .7 0 1-.3 1.5-.3s.8.3 1.5.3c1.7 0 3-1.3 3-3 0-2-2-4-4.5-4z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    clear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 11l18-8-8 18-2-7-8-3z"/></svg>',
    ease: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><mask id="epvRightEaseCut"><rect width="64" height="64" fill="#fff"/><circle cx="42" cy="32" r="18.5" fill="#000"/></mask></defs><circle cx="30" cy="32" r="27" fill="#1AB5AC" mask="url(#epvRightEaseCut)"/><path d="M31 46 C24.5 40 16 35.5 16 28.3 C16 23 21.8 20.8 26 23.5 C28.2 24.9 29.9 27.4 31 29.6 C32.1 27.4 33.8 24.9 36 23.5 C40.2 20.8 46 23 46 28.3 C46 35.5 37.5 40 31 46 Z" fill="#0E8C84"/><path d="M24.5 31 L30.5 38 L49 15.5" fill="none" stroke="#0E8C84" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    easeFull: '<svg viewBox="0 0 250 72" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="ease"><defs><mask id="epvRightEaseFullCut"><rect width="72" height="72" fill="#fff"/><circle cx="46" cy="36" r="20.5" fill="#000"/></mask></defs><circle cx="33" cy="36" r="30" fill="#1AB5AC" mask="url(#epvRightEaseFullCut)"/><path d="M34 51 C27 44.5 17.5 39.5 17.5 31.5 C17.5 25.5 24 23 28.7 26 C31.2 27.6 33 30.4 34 32.8 C35 30.4 36.8 27.6 39.3 26 C44 23 50.5 25.5 50.5 31.5 C50.5 39.5 41 44.5 34 51 Z" fill="#0E8C84"/><path d="M26.5 34.5 L33.5 42.5 L54 17" fill="none" stroke="#0E8C84" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/><text x="80" y="53" font-family="Poppins, Nunito, Quicksand, \'Segoe UI\', system-ui, Arial, sans-serif" font-size="56" font-weight="700" letter-spacing="-2" fill="#333333">ease</text></svg>',
  };

  var root, panel, messagesEl, inputEl, sendBtn, launcherBtn, composerEl, remainingEl, warningEl, formEl, metaEl;
  var isOpen = false;
  var busy = false;
  var typeTimer = null;

  function el(tag, className, html) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (html != null) node.innerHTML = html;
    return node;
  }

  function build() {
    root = el('div', 'epv-chatbot-root epv-pos-' + (POSITION === 'bottom-left' ? 'bottom-left' : 'bottom-right'));

    launcherBtn = el('button', 'epv-chatbot-launcher', ICONS.chat);
    launcherBtn.setAttribute('aria-label', 'Open Ease Pet Vet chat assistant');
    launcherBtn.addEventListener('click', toggle);

    panel = el('div', 'epv-chatbot-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Ease Pet Vet Assistant');

    // Header
    var header = el('div', 'epv-chatbot-header');
    var headerLogo = el('div', null, ICONS.easeFull);
    headerLogo.style.cssText = 'background:#fff;border-radius:8px;padding:4px 9px;display:flex;align-items:center;flex:none';
    var headerLogoSvg = headerLogo.querySelector('svg');
    if (headerLogoSvg) { headerLogoSvg.style.height = '22px'; headerLogoSvg.style.width = 'auto'; headerLogoSvg.style.display = 'block'; }
    header.appendChild(headerLogo);
    var headerText = el('div', 'epv-chatbot-header-text');
    headerText.appendChild(el('div', 'epv-chatbot-title', 'Pet Vet Assistant'));
    headerText.appendChild(el('div', 'epv-chatbot-subtitle', 'Ask about Ease, pricing, vets, pet parents, and support'));
    header.appendChild(headerText);
    var actions = el('div', 'epv-chatbot-header-actions');
    var clearBtn = el('button', 'epv-chatbot-icon-btn', ICONS.clear);
    clearBtn.setAttribute('aria-label', 'Delete chat history');
    clearBtn.setAttribute('title', 'Delete chat history');
    clearBtn.addEventListener('click', clearChat);
    var closeBtn = el('button', 'epv-chatbot-icon-btn', ICONS.close);
    closeBtn.setAttribute('aria-label', 'Minimize chat');
    closeBtn.setAttribute('title', 'Minimize chat');
    closeBtn.addEventListener('click', toggle);
    actions.appendChild(clearBtn);
    actions.appendChild(closeBtn);
    header.appendChild(actions);
    panel.appendChild(header);

    // Intro form (gate). Shown until the visitor submits their details.
    formEl = buildForm();
    panel.appendChild(formEl);

    // Messages
    messagesEl = el('div', 'epv-chatbot-messages');
    messagesEl.setAttribute('aria-live', 'polite');
    panel.appendChild(messagesEl);

    // Composer
    composerEl = el('div', 'epv-chatbot-composer');
    inputEl = el('textarea', 'epv-chatbot-input');
    inputEl.setAttribute('rows', '1');
    inputEl.setAttribute('placeholder', 'Type your question...');
    inputEl.setAttribute('aria-label', 'Message');
    inputEl.addEventListener('input', autoGrow);
    inputEl.addEventListener('keydown', onKeyDown);
    sendBtn = el('button', 'epv-chatbot-send', ICONS.send);
    sendBtn.setAttribute('aria-label', 'Send message');
    sendBtn.addEventListener('click', send);
    composerEl.appendChild(inputEl);
    composerEl.appendChild(sendBtn);
    panel.appendChild(composerEl);

    // Question counter intentionally hidden; the 20-message limit is still enforced
    // silently via applyLimitBlock(). metaEl is kept (empty) so applyLeadState's
    // metaEl.style.display toggle stays valid.
    metaEl = el('div', 'epv-chatbot-meta');
    panel.appendChild(metaEl);

    panel.appendChild(el('div', 'epv-chatbot-footer', 'Answers come from the Ease Pet Vet website.'));

    root.appendChild(panel);
    root.appendChild(launcherBtn);
    document.body.appendChild(root);

    // Restore the per-session remaining count so the limit persists across reloads.
    if (sessionId) {
      var storedRem = load(remainingKey());
      if (storedRem != null && storedRem !== '') remaining = Number(storedRem);
    }
    updateUsageUI(null);
    applyLeadState();
  }

  // Builds a labelled text field { wrap, input }. Enter submits the form.
  function formField(labelText, type, id, placeholder, required) {
    var wrap = el('div', 'epv-chatbot-form-field');
    var label = el('label', 'epv-chatbot-form-label', labelText + (required ? ' *' : ''));
    label.setAttribute('for', id);
    var input = el('input', 'epv-chatbot-form-input');
    input.id = id;
    input.type = type;
    input.setAttribute('placeholder', placeholder);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitLead(); }
    });
    wrap.appendChild(label);
    wrap.appendChild(input);
    return { wrap: wrap, input: input };
  }

  function buildForm() {
    var form = el('div', 'epv-chatbot-form');

    var head = el('div', 'epv-chatbot-form-head');
    var formAvatar = el('div', 'epv-chatbot-form-avatar', ICONS.ease);
    formAvatar.style.background = '#fff';
    head.appendChild(formAvatar);
    var headText = el('div', 'epv-chatbot-form-headtext');
    headText.appendChild(el('div', 'epv-chatbot-form-title', "Let's get started"));
    headText.appendChild(el('div', 'epv-chatbot-form-sub', 'Tell us a bit about you so we can help.'));
    head.appendChild(headText);
    form.appendChild(head);

    var nameF = formField('Name', 'text', 'epv-lead-name', 'Your name', true);
    var emailF = formField('Email', 'email', 'epv-lead-email', 'you@example.com', true);
    var phoneF = formField('Contact number', 'tel', 'epv-lead-phone', 'Optional', false);
    form.appendChild(nameF.wrap);
    form.appendChild(emailF.wrap);
    form.appendChild(phoneF.wrap);

    var audWrap = el('div', 'epv-chatbot-form-field');
    audWrap.appendChild(el('span', 'epv-chatbot-form-label', 'I am a: *'));
    var audBtns = el('div', 'epv-chatbot-form-aud');
    AUDIENCES.forEach(function (a) {
      var b = el('button', 'epv-chatbot-audience-btn', a.label);
      b.type = 'button';
      b.dataset.value = a.value;
      b.addEventListener('click', function () {
        formAudience = a.value;
        audBtns.querySelectorAll('.epv-chatbot-audience-btn').forEach(function (x) {
          x.classList.toggle('epv-active', x.dataset.value === a.value);
        });
      });
      audBtns.appendChild(b);
    });
    audWrap.appendChild(audBtns);
    form.appendChild(audWrap);

    var errorEl = el('div', 'epv-chatbot-form-error');
    errorEl.style.display = 'none';
    form.appendChild(errorEl);

    var submit = el('button', 'epv-chatbot-form-submit', 'Submit');
    submit.type = 'button';
    submit.addEventListener('click', submitLead);
    form.appendChild(submit);

    form.appendChild(el('div', 'epv-chatbot-form-hint', 'You can start chatting right after you submit.'));

    form._fields = { name: nameF.input, email: emailF.input, phone: phoneF.input, error: errorEl, submit: submit };
    return form;
  }

  function showFormError(msg) {
    var e = formEl._fields.error;
    e.textContent = msg || '';
    e.style.display = msg ? 'block' : 'none';
  }

  function submitLead() {
    var f = formEl._fields;
    var name = (f.name.value || '').trim();
    var email = (f.email.value || '').trim();
    var phone = (f.phone.value || '').trim();
    if (!name) { showFormError('Please enter your name.'); f.name.focus(); return; }
    if (!email) { showFormError('Please enter your email.'); f.email.focus(); return; }
    if (email.indexOf('@') === -1) { showFormError('Email must contain @ (e.g. you@example.com).'); f.email.focus(); return; }
    if (!EMAIL_RE.test(email)) { showFormError('Please enter a valid email address (e.g. you@example.com).'); f.email.focus(); return; }
    if (!formAudience) { showFormError('Please tell us if you are a pet parent or a vet.'); return; }
    showFormError('');
    f.submit.disabled = true;
    f.submit.textContent = 'Saving...';

    var body = { name: name, email: email, phone: phone, audience: formAudience };
    if (sessionId) body.sessionId = sessionId;

    fetch(API_BASE_URL + '/api/chat/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (out) {
        if (!out.ok) {
          showFormError((out.data && out.data.error) ? out.data.error : 'Could not save your details. Please try again.');
          f.submit.disabled = false;
          f.submit.textContent = 'Submit';
          return;
        }
        if (out.data.sessionId) { sessionId = out.data.sessionId; store(SESSION_KEY, sessionId); }
        audience = out.data.audience || formAudience;
        store(AUDIENCE_KEY, audience);
        leadName = name;
        store(LEAD_KEY, JSON.stringify({ name: name, audience: audience }));
        applyLeadState();
      })
      .catch(function () {
        showFormError('Could not connect. Please try again.');
        f.submit.disabled = false;
        f.submit.textContent = 'Submit';
      });
  }

  // Shows the form until a lead is captured, then reveals the chat (with the
  // remaining-question counter) and greets the visitor by name once.
  function applyLeadState() {
    var done = !!leadName;
    formEl.style.display = done ? 'none' : '';
    messagesEl.style.display = done ? '' : 'none';
    composerEl.style.display = done ? '' : 'none';
    metaEl.style.display = done ? '' : 'none';
    if (done && !greeted) {
      greeted = true;
      var hi = leadName ? ('Hi ' + leadName + '!') : 'Hi!';
      addBotMessage(hi + ' I can answer questions about Ease Pet Vet — pricing, how it works for vets and pet parents, and support. How can I help?');
      setTimeout(function () { if (inputEl && !inputEl.disabled) inputEl.focus(); }, 100);
    }
  }

  // ---- usage / remaining count / limit block ----
  function updateUsageUI(usage) {
    if (usage) {
      if (typeof usage.messageLimit === 'number') convLimit = usage.messageLimit;
      if (typeof usage.remainingMessages === 'number') remaining = usage.remainingMessages;
      limitReached = !!usage.limitReached || (remaining != null && remaining <= 0);
      if (sessionId && remaining != null) store(remainingKey(), String(remaining));
    }
    renderRemaining();
    applyLimitBlock();
  }

  function renderRemaining() { /* counter hidden; limit enforced silently */ }

  function applyLimitBlock() {
    if (limitReached) {
      inputEl.disabled = true;
      sendBtn.disabled = true;
      inputEl.setAttribute('placeholder', 'Question limit reached');
    } else {
      inputEl.disabled = false;
      if (!busy) sendBtn.disabled = false;
      inputEl.setAttribute('placeholder', 'Type your question...');
    }
  }

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function toggle() {
    isOpen = !isOpen;
    root.classList.toggle('epv-open', isOpen);
    launcherBtn.innerHTML = isOpen ? ICONS.close : ICONS.chat;
    launcherBtn.setAttribute('aria-label', isOpen ? 'Close chat' : 'Open Ease Pet Vet chat assistant');
    if (isOpen) setTimeout(function () { inputEl.focus(); }, 150);
  }

  function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  function addUserMessage(text) {
    var node = el('div', 'epv-chatbot-msg epv-chatbot-msg-user');
    node.textContent = text;
    messagesEl.appendChild(node);
    scrollDown();
  }

  // Builds the href for a matched token. type: 'url' | 'www' | 'path' | 'email'.
  function buildHref(type, value) {
    if (type === 'url') return value;
    if (type === 'www') return 'https://' + value;
    if (type === 'path') return WEBSITE_BASE_URL + value;
    if (type === 'email') {
      return EMAIL_LINK_MODE === 'gmail'
        ? 'https://mail.google.com/mail/?view=cm&fs=1&to=' + encodeURIComponent(value)
        : 'mailto:' + value;
    }
    return value;
  }

  // Appends text to parentNode, converting emails / URLs / internal paths into
  // safe anchor elements. DOM-only (createTextNode + createElement + textContent);
  // never uses innerHTML, so AI/answer text cannot inject markup.
  function appendLinkified(parentNode, text) {
    if (!text) return;
    // Priority: email | http(s) URL | www | internal path.
    var pattern = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})|(https?:\/\/[^\s]+)|(www\.[^\s]+)|(\/[A-Za-z0-9._~\-/]*[A-Za-z0-9][A-Za-z0-9._~\-/]*\/?)/g;
    var lastIndex = 0;
    var match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parentNode.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      var type = match[1] ? 'email' : match[2] ? 'url' : match[3] ? 'www' : 'path';
      var token = match[0];
      var trailing = '';
      if (type !== 'email') {
        // Strip trailing punctuation off URL/path matches and keep it as text.
        var t = token.match(/[.,;:!?)\]]+$/);
        if (t) { trailing = t[0]; token = token.slice(0, token.length - trailing.length); }
      }
      var anchor = document.createElement('a');
      anchor.className = 'epv-chatbot-link';
      anchor.textContent = token;
      anchor.href = buildHref(type, token);
      var newTab = type !== 'email' || EMAIL_LINK_MODE === 'gmail';
      if (newTab) { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; }
      parentNode.appendChild(anchor);
      if (trailing) parentNode.appendChild(document.createTextNode(trailing));
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      parentNode.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  function addBotMessage(text) {
    var node = el('div', 'epv-chatbot-msg epv-chatbot-msg-bot');
    appendLinkified(node, text);
    messagesEl.appendChild(node);
    scrollDown();
  }

  // Reveals the answer progressively (typewriter), then swaps in the linkified
  // version so URLs/emails become clickable. Speed scales with length so long
  // answers stay quick.
  function typeBotMessage(text) {
    var node = el('div', 'epv-chatbot-msg epv-chatbot-msg-bot');
    messagesEl.appendChild(node);
    var i = 0;
    var step = Math.max(2, Math.round(text.length / 140));
    function tick() {
      i = Math.min(text.length, i + step);
      node.textContent = text.slice(0, i);
      scrollDown();
      if (i < text.length) {
        typeTimer = setTimeout(tick, 16);
      } else {
        node.textContent = '';
        appendLinkified(node, text);
        scrollDown();
      }
    }
    tick();
  }

  function addErrorMessage(text) {
    var node = el('div', 'epv-chatbot-msg epv-chatbot-msg-bot epv-chatbot-msg-error');
    node.textContent = text;
    messagesEl.appendChild(node);
    scrollDown();
  }

  function showTyping() {
    var node = el('div', 'epv-chatbot-msg epv-chatbot-msg-bot');
    node.id = 'epv-typing';
    node.appendChild(el('div', 'epv-chatbot-typing', '<span></span><span></span><span></span>'));
    messagesEl.appendChild(node);
    scrollDown();
  }
  function hideTyping() {
    var t = document.getElementById('epv-typing');
    if (t) t.remove();
  }

  function setBusy(value) {
    busy = value;
    sendBtn.disabled = value;
  }

  // Starts a fresh conversation thread: keeps the captured lead (already given),
  // resets the chat + question count, and re-greets.
  function clearChat() {
    if (typeTimer) { clearTimeout(typeTimer); typeTimer = null; }
    messagesEl.innerHTML = '';
    sessionId = null;
    store(SESSION_KEY, '');
    greeted = false;
    remaining = null;
    limitReached = false;
    updateUsageUI(null);
    applyLeadState();
  }

  function send() {
    if (busy || limitReached) return;
    var text = (inputEl.value || '').trim();
    if (!text) return;
    inputEl.value = '';
    autoGrow();
    addUserMessage(text);
    setBusy(true);
    showTyping();

    var body = { message: text, audience: audience };
    if (sessionId) body.sessionId = sessionId;

    fetch(API_BASE_URL + '/api/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (out) {
        hideTyping();
        if (!out.ok || !out.data || typeof out.data.answer !== 'string') {
          var msg = (out.data && out.data.error) ? out.data.error : 'Something went wrong. Please try again.';
          addErrorMessage(msg);
          return;
        }
        if (out.data.sessionId) { sessionId = out.data.sessionId; store(SESSION_KEY, sessionId); }
        typeBotMessage(out.data.answer);
        updateUsageUI(out.data.usage);
      })
      .catch(function () {
        hideTyping();
        addErrorMessage('Sorry, I could not connect to the chatbot service. Please try again later.');
      })
      .finally(function () {
        setBusy(false);
        applyLimitBlock();
        if (!limitReached) inputEl.focus();
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
