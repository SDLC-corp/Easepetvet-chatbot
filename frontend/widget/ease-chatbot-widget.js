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
  var VALID_AUDIENCES = ['pet_parent', 'vet', 'unknown'];
  // Same pragmatic email shape check the backend uses.
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* ignore */ } }
  function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

  var sessionId = load(SESSION_KEY) || null;
  var audience = load(AUDIENCE_KEY) || DEFAULT_AUDIENCE;
  if (VALID_AUDIENCES.indexOf(audience) < 0) audience = 'unknown';

  // Conversation usage state (driven by the API usage object).
  var greeted = false;
  var convLimit = 20;     // updated from usage.messageLimit
  var remaining = null;   // updated from usage.remainingMessages
  var limitReached = false;
  var emailSaved = false;

  // Per-session localStorage keys for email-saved / dismissed prompt counts / remaining.
  function emailSavedKey() { return 'epv_chatbot_email_saved_' + (sessionId || 'none'); }
  function dismissKey() { return 'epv_chatbot_email_prompt_dismissed_counts_' + (sessionId || 'none'); }
  function remainingKey() { return 'epv_chatbot_remaining_' + (sessionId || 'none'); }
  function getDismissed() { try { return JSON.parse(load(dismissKey()) || '[]'); } catch (e) { return []; } }
  function addDismissed(n) { var a = getDismissed(); if (a.indexOf(n) < 0) { a.push(n); store(dismissKey(), JSON.stringify(a)); } }

  var ICONS = {
    chat: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3C6.5 3 2 6.8 2 11.5c0 2.2 1 4.2 2.7 5.7L4 21l4.2-1.6c1.2.3 2.5.5 3.8.5 5.5 0 10-3.8 10-8.5S17.5 3 12 3z"/></svg>',
    paw: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="10" r="2"/><circle cx="10" cy="6" r="2"/><circle cx="14" cy="6" r="2"/><circle cx="18" cy="10" r="2"/><path d="M12 12c-2.5 0-4.5 2-4.5 4 0 1.7 1.3 3 3 3 .7 0 1-.3 1.5-.3s.8.3 1.5.3c1.7 0 3-1.3 3-3 0-2-2-4-4.5-4z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    clear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 11l18-8-8 18-2-7-8-3z"/></svg>',
  };

  var root, panel, messagesEl, inputEl, sendBtn, launcherBtn, composerEl, remainingEl, warningEl;
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
    header.appendChild(el('div', 'epv-chatbot-header-avatar', ICONS.paw));
    var headerText = el('div', 'epv-chatbot-header-text');
    headerText.appendChild(el('div', 'epv-chatbot-title', 'Ease Pet Vet Assistant'));
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

    // Remaining-question counter + low-count warning.
    var meta = el('div', 'epv-chatbot-meta');
    remainingEl = el('div', 'epv-chatbot-remaining');
    warningEl = el('div', 'epv-chatbot-warning');
    warningEl.style.display = 'none';
    meta.appendChild(remainingEl);
    meta.appendChild(warningEl);
    panel.appendChild(meta);

    panel.appendChild(el('div', 'epv-chatbot-footer', 'Answers come from the Ease Pet Vet website.'));

    root.appendChild(panel);
    root.appendChild(launcherBtn);
    document.body.appendChild(root);

    // Restore per-session state so the limit persists across reloads.
    if (sessionId) {
      emailSaved = load(emailSavedKey()) === '1';
      var storedRem = load(remainingKey());
      if (storedRem != null && storedRem !== '') remaining = Number(storedRem);
    }
    updateUsageUI(null);
    ensureGreeted();
  }

  // Greets once per conversation. Client-only; never counts toward the limit.
  function ensureGreeted() {
    if (greeted) return;
    greeted = true;
    addBotMessage('Hi! I can answer questions about Ease Pet Vet — pricing, how it works for vets and pet parents, and support. How can I help?');
  }

  // ---- usage / remaining count / limit block ----
  function updateUsageUI(usage) {
    if (usage) {
      if (typeof usage.messageLimit === 'number') convLimit = usage.messageLimit;
      if (typeof usage.remainingMessages === 'number') remaining = usage.remainingMessages;
      if (usage.emailSaved) emailSaved = true;
      limitReached = !!usage.limitReached || (remaining != null && remaining <= 0);
      if (sessionId) {
        if (remaining != null) store(remainingKey(), String(remaining));
        if (emailSaved) store(emailSavedKey(), '1');
      }
    }
    renderRemaining();
    applyLimitBlock();
  }

  function renderRemaining() {
    var n = (remaining == null) ? convLimit : remaining;
    if (n < 0) n = 0;
    remainingEl.textContent = n + (n === 1 ? ' question remaining' : ' questions remaining');
    if (n <= 3) {
      warningEl.textContent = 'You have ' + n + (n === 1 ? ' question' : ' questions') + ' left in this conversation.';
      warningEl.style.display = 'block';
      remainingEl.classList.add('epv-low');
    } else {
      warningEl.style.display = 'none';
      remainingEl.classList.remove('epv-low');
    }
  }

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

  // ---- optional in-chat email prompt ----
  function maybeShowEmailPrompt(usage) {
    if (!usage || !usage.showEmailPrompt || emailSaved) return;
    if (getDismissed().indexOf(usage.messagesUsed) > -1) return;
    renderEmailPrompt(usage.messagesUsed);
  }

  function removeEmailPrompt() {
    var e = document.getElementById('epv-emailprompt');
    if (e) e.remove();
  }

  function renderEmailPrompt(count) {
    removeEmailPrompt();
    var card = el('div', 'epv-chatbot-emailprompt');
    card.id = 'epv-emailprompt';
    card.appendChild(el('div', 'epv-chatbot-emailprompt-text',
      'Would you like to share your email? We can use it to follow up, send future updates, or help you if your chat limit is reached.'));
    var btns = el('div', 'epv-chatbot-emailprompt-btns');
    var shareBtn = el('button', 'epv-chatbot-emailprompt-btn epv-chatbot-emailprompt-primary', 'Share email');
    shareBtn.type = 'button';
    var laterBtn = el('button', 'epv-chatbot-emailprompt-btn', 'Maybe later');
    laterBtn.type = 'button';
    shareBtn.addEventListener('click', function () { showEmailField(card); });
    laterBtn.addEventListener('click', function () { addDismissed(count); removeEmailPrompt(); });
    btns.appendChild(shareBtn);
    btns.appendChild(laterBtn);
    card.appendChild(btns);
    messagesEl.appendChild(card);
    scrollDown();
  }

  function showEmailField(card) {
    var btns = card.querySelector('.epv-chatbot-emailprompt-btns');
    if (btns) btns.remove();
    var row = el('div', 'epv-chatbot-emailprompt-row');
    var input = el('input', 'epv-chatbot-emailprompt-input');
    input.type = 'email';
    input.setAttribute('placeholder', 'you@example.com');
    var saveBtn = el('button', 'epv-chatbot-emailprompt-btn epv-chatbot-emailprompt-primary', 'Save email');
    saveBtn.type = 'button';
    var err = el('div', 'epv-chatbot-emailprompt-err');
    err.style.display = 'none';

    function doSave() {
      var email = (input.value || '').trim();
      if (!EMAIL_RE.test(email)) { err.textContent = 'Please enter a valid email address.'; err.style.display = 'block'; return; }
      err.style.display = 'none';
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      fetch(API_BASE_URL + '/api/chat/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId, email: email }),
      })
        .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
        .then(function (out) {
          if (!out.ok) {
            err.textContent = (out.data && out.data.error) ? out.data.error : 'Could not save your email. Please try again.';
            err.style.display = 'block';
            saveBtn.disabled = false; saveBtn.textContent = 'Save email';
            return;
          }
          emailSaved = true;
          if (sessionId) store(emailSavedKey(), '1');
          removeEmailPrompt();
          addBotMessage('Thanks — we’ll use this email only to follow up or send helpful updates.');
        })
        .catch(function () {
          err.textContent = 'Could not connect. Please try again.';
          err.style.display = 'block';
          saveBtn.disabled = false; saveBtn.textContent = 'Save email';
        });
    }

    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });
    saveBtn.addEventListener('click', doSave);
    row.appendChild(input);
    row.appendChild(saveBtn);
    card.appendChild(row);
    card.appendChild(err);
    input.focus();
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

  // Starts a fresh conversation: new (anonymous) session, reset usage, re-greet.
  function clearChat() {
    if (typeTimer) { clearTimeout(typeTimer); typeTimer = null; }
    removeEmailPrompt();
    messagesEl.innerHTML = '';
    sessionId = null;
    store(SESSION_KEY, '');
    greeted = false;
    remaining = null;
    limitReached = false;
    emailSaved = false;
    updateUsageUI(null);
    ensureGreeted();
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
        maybeShowEmailPrompt(out.data.usage);
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
