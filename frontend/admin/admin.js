/* Ease Pet Vet admin dashboard. Vanilla JS, same-origin API at /api/admin.
   The admin token is kept only in sessionStorage and sent as a Bearer header. */
(function () {
  'use strict';

  var TOKEN_KEY = 'epv_admin_token';
  var POLL_MS = 7000;
  var state = { page: 1, limit: 20, total: 0, filters: {}, pollTimer: null };

  function $(id) { return document.getElementById(id); }
  function token() { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) { try { sessionStorage.setItem(TOKEN_KEY, t); } catch (e) {} }
  function clearToken() { try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {} }

  function fmtDate(v) {
    if (!v) return '—';
    try { return new Date(v).toLocaleString(); } catch (e) { return String(v); }
  }
  // Display-name priority: email -> name -> "Anonymous Visitor".
  function displayName(email, name) {
    return (email && email.trim()) || (name && name.trim()) || 'Anonymous Visitor';
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // Fetch wrapper. Adds Bearer token; on 401 forces re-login.
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + token() });
    return fetch('/api/admin' + path, opts).then(function (res) {
      if (res.status === 401) { logout(); throw new Error('unauthorized'); }
      return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
    });
  }

  /* ---------- auth screens ---------- */
  function showLogin() { $('epv-admin-login').hidden = false; $('epv-admin-app').hidden = true; }
  function showApp() { $('epv-admin-login').hidden = true; $('epv-admin-app').hidden = false; }
  function logout() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    clearToken();
    showLogin();
  }

  function doLogin(e) {
    e.preventDefault();
    var t = ($('epv-admin-token-input').value || '').trim();
    var errEl = $('epv-admin-login-error');
    errEl.hidden = true;
    if (!t) return;
    setToken(t);
    api('/health').then(function (out) {
      if (out.ok && out.data && out.data.admin) { showApp(); loadAll(); }
      else { clearToken(); errEl.textContent = 'Invalid token.'; errEl.hidden = false; }
    }).catch(function () {
      errEl.textContent = 'Invalid token or server unavailable.'; errEl.hidden = false;
    });
  }

  /* ---------- summary / stats ---------- */
  function loadSummary() {
    return api('/summary').then(function (out) {
      if (!out.ok) return;
      var d = out.data;
      var cards = [
        ['Chats', d.totalChats], ['Leads', d.totalLeads], ['Messages', d.totalMessages],
        ['Pages', d.totalPages], ['Chunks', d.totalChunks], ['Sync', d.sync.lastStatus],
      ];
      var wrap = $('epv-admin-stats');
      wrap.textContent = '';
      cards.forEach(function (c) {
        var card = el('div', 'epv-admin-stat');
        card.appendChild(el('div', 'epv-admin-stat-num', String(c[1])));
        card.appendChild(el('div', 'epv-admin-stat-label', c[0]));
        wrap.appendChild(card);
      });
    });
  }

  /* ---------- sync ---------- */
  function setSyncBadge(status) {
    var badge = $('epv-admin-sync-badge');
    badge.textContent = status || 'never';
    badge.className = 'epv-admin-badge is-' + (status || 'never');
  }

  function loadSyncStatus() {
    return api('/sync/status').then(function (out) {
      if (!out.ok) return false;
      var d = out.data;
      setSyncBadge(d.status);
      $('epv-admin-last-sync').textContent = d.lastCompletedAt ? ('Last sync: ' + fmtDate(d.lastCompletedAt)) : 'Never synced';

      var body = $('epv-admin-sync-body');
      body.textContent = '';
      function row(label, value) {
        var r = el('div', 'epv-admin-sync-row');
        r.appendChild(el('b', null, label + ': '));
        r.appendChild(document.createTextNode(value));
        body.appendChild(r);
      }
      row('Status', d.status || 'never');
      row('Last started', fmtDate(d.lastStartedAt));
      row('Last completed', fmtDate(d.lastCompletedAt));
      row('Next scheduled', fmtDate(d.nextSyncAt));
      var es = d.embeddingStatus;
      if (es) row('Embeddings', es.coveragePercent + '% covered, vectorReady=' + es.vectorReady);
      if (d.latestRun && d.latestRun.summary && Object.keys(d.latestRun.summary).length) {
        row('Latest run', JSON.stringify(d.latestRun.summary));
      }
      if (d.lastError) {
        var warn = el('div', 'epv-admin-sync-warn', 'Last error: ' + d.lastError);
        body.appendChild(warn);
      }
      var sm = d.latestRun && d.latestRun.summary;
      if (sm && sm.embeddingWarning) {
        body.appendChild(el('div', 'epv-admin-sync-warn', sm.embeddingWarning));
      }

      var running = d.status === 'running';
      var btn = $('epv-admin-sync-btn');
      btn.disabled = running;
      btn.textContent = running ? 'Sync running…' : 'Sync Now';
      if (running) startPolling(); else stopPolling();
      return running;
    });
  }

  function startPolling() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(function () {
      loadSyncStatus().then(function (running) {
        if (!running) { loadSummary(); loadChats(state.page); }
      });
    }, POLL_MS);
  }
  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  function runSync() {
    var btn = $('epv-admin-sync-btn');
    btn.disabled = true; btn.textContent = 'Starting…';
    api('/sync/run', { method: 'POST' }).then(function (out) {
      if (out.status === 202 || out.status === 409) {
        btn.textContent = 'Sync running…';
        loadSyncStatus();
        startPolling();
      } else {
        btn.disabled = false; btn.textContent = 'Sync Now';
        alert((out.data && out.data.error) ? out.data.error : 'Could not start sync.');
      }
    }).catch(function () { btn.disabled = false; btn.textContent = 'Sync Now'; });
  }

  /* ---------- chats ---------- */
  function readFilters() {
    var to = ($('epv-admin-to').value || '').trim();
    return {
      search: ($('epv-admin-search').value || '').trim(),
      audience: $('epv-admin-audience').value || '',
      dateFrom: ($('epv-admin-from').value || '').trim(),
      dateTo: to ? to + 'T23:59:59' : '',
    };
  }

  function loadChats(page) {
    state.page = page || 1;
    var f = state.filters;
    var q = '?page=' + state.page + '&limit=' + state.limit;
    if (f.search) q += '&search=' + encodeURIComponent(f.search);
    if (f.audience) q += '&audience=' + encodeURIComponent(f.audience);
    if (f.dateFrom) q += '&dateFrom=' + encodeURIComponent(f.dateFrom);
    if (f.dateTo) q += '&dateTo=' + encodeURIComponent(f.dateTo);

    return api('/chats' + q).then(function (out) {
      if (!out.ok) return;
      state.total = out.data.total;
      var rows = $('epv-admin-chat-rows');
      rows.textContent = '';
      if (!out.data.items.length) {
        var tr = el('tr');
        var td = el('td', 'epv-admin-empty'); td.colSpan = 7; td.textContent = 'No conversations found.';
        tr.appendChild(td); rows.appendChild(tr);
      } else {
        out.data.items.forEach(function (it) {
          var tr = el('tr');
          tr.appendChild(el('td', null, displayName(it.email, it.name)));
          tr.appendChild(el('td', null, it.email || '—'));
          tr.appendChild(el('td', null, it.phone || '—'));
          var audTd = el('td'); audTd.appendChild(el('span', 'epv-admin-aud', (it.audience || 'unknown').replace('_', ' ')));
          tr.appendChild(audTd);
          tr.appendChild(el('td', 'epv-admin-preview', it.lastMessagePreview || '—'));
          tr.appendChild(el('td', null, it.lastMessageAt ? fmtDate(it.lastMessageAt) : fmtDate(it.createdAt)));
          tr.appendChild(el('td', 'epv-admin-num', String(it.messageCount)));
          tr.addEventListener('click', function () { openChat(it.sessionId); });
          rows.appendChild(tr);
        });
      }
      var pages = Math.max(1, Math.ceil(state.total / state.limit));
      $('epv-admin-page-info').textContent = 'Page ' + state.page + ' of ' + pages + ' · ' + state.total + ' total';
      $('epv-admin-prev').disabled = state.page <= 1;
      $('epv-admin-next').disabled = state.page >= pages;
    });
  }

  function openChat(sessionId) {
    api('/chats/' + encodeURIComponent(sessionId)).then(function (out) {
      if (!out.ok) return;
      var d = out.data;
      var leadBox = $('epv-admin-drawer-lead');
      leadBox.textContent = '';
      var lead = d.lead || {};
      [['Name', lead.name], ['Email', lead.email], ['Contact', lead.phone],
       ['Audience', (d.session.audience || 'unknown').replace('_', ' ')],
       ['Started', fmtDate(d.session.createdAt)]].forEach(function (p) {
        var line = el('div');
        line.appendChild(el('b', null, p[0] + ': '));
        line.appendChild(document.createTextNode(p[1] || '—'));
        leadBox.appendChild(line);
      });

      var msgs = $('epv-admin-drawer-messages');
      msgs.textContent = '';
      if (!d.messages.length) msgs.appendChild(el('div', 'epv-admin-empty', 'No messages.'));
      d.messages.forEach(function (m) {
        var bubble = el('div', 'epv-admin-msg ' + (m.role === 'user' ? 'epv-admin-msg-user' : 'epv-admin-msg-bot'));
        bubble.appendChild(document.createTextNode(m.content));
        bubble.appendChild(el('div', 'epv-admin-msg-time', fmtDate(m.createdAt)));
        msgs.appendChild(bubble);
      });
      $('epv-admin-drawer-title').textContent = displayName(lead.email, lead.name) + ' · ' + d.messageCount + ' messages';
      $('epv-admin-drawer').hidden = false;
    });
  }

  function closeDrawer() { $('epv-admin-drawer').hidden = true; }

  function loadAll() {
    state.filters = {};
    loadSummary();
    loadSyncStatus();
    loadChats(1);
  }

  /* ---------- wire up ---------- */
  function init() {
    $('epv-admin-login-form').addEventListener('submit', doLogin);
    $('epv-admin-logout-btn').addEventListener('click', logout);
    $('epv-admin-sync-btn').addEventListener('click', runSync);
    $('epv-admin-apply').addEventListener('click', function () { state.filters = readFilters(); loadChats(1); });
    $('epv-admin-search').addEventListener('keydown', function (e) { if (e.key === 'Enter') { state.filters = readFilters(); loadChats(1); } });
    $('epv-admin-prev').addEventListener('click', function () { if (state.page > 1) loadChats(state.page - 1); });
    $('epv-admin-next').addEventListener('click', function () { loadChats(state.page + 1); });
    $('epv-admin-drawer').addEventListener('click', function (e) { if (e.target.getAttribute('data-close')) closeDrawer(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

    if (token()) { showApp(); loadAll(); } else { showLogin(); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
