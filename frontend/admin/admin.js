/* Ease Pet Vet admin dashboard. Vanilla JS, same-origin API at /api/admin.
   The admin token is kept only in sessionStorage and sent as a Bearer header. */
(function () {
  'use strict';

  var TOKEN_KEY = 'epv_admin_token';
  var POLL_MS = 7000;
  // API base. Empty = same-origin (when the admin is served by the backend). When
  // the admin is hosted separately (e.g. Vercel), set window.EASE_ADMIN_API_BASE
  // to the backend URL (e.g. https://easepetvet-backend.onrender.com).
  var API_BASE = ((window.EASE_ADMIN_API_BASE || '') + '').replace(/\/+$/, '');
  var state = { page: 1, limit: 20, total: 0, filters: {}, pollTimer: null, selected: {}, selectAllAcross: false };

  function $(id) { return document.getElementById(id); }
  function token() { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) { try { sessionStorage.setItem(TOKEN_KEY, t); } catch (e) {} }
  function clearToken() { try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {} }

  var TZ = 'America/Chicago';   // overridden by /summary (ADMIN_DASHBOARD_TIMEZONE)
  // Dates shown in the configured timezone, labelled CST.
  function fmtDate(v) {
    if (!v) return '—';
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: TZ, year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: true,
      }).format(new Date(v)) + ' CST';
    } catch (e) { return String(v); }
  }
  var AUDIENCE_LABELS = { pet_parent: 'Pet Parent', vet: 'Vet', unknown: 'Not sure' };
  function formatAudience(a) { return AUDIENCE_LABELS[a] || 'Not sure'; }
  // Display-name priority: name -> email -> "Anonymous Visitor".
  function displayName(name, email) {
    return (name && name.trim()) || (email && email.trim()) || 'Anonymous Visitor';
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
    return fetch(API_BASE + '/api/admin' + path, opts).then(function (res) {
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
      if (d.timezone) TZ = d.timezone;
      var cards = [
        ['Chats', d.totalChats], ['Leads', d.totalLeads],
        ['Messages', d.totalMessages],
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
        var td = el('td', 'epv-admin-empty'); td.colSpan = 8; td.textContent = 'No conversations found.';
        tr.appendChild(td); rows.appendChild(tr);
      } else {
        out.data.items.forEach(function (it) {
          var tr = el('tr');
          var checkTd = el('td', 'epv-admin-check');
          var cb = el('input'); cb.type = 'checkbox'; cb.setAttribute('aria-label', 'Select chat');
          cb.dataset.sid = it.sessionId;
          cb.checked = !!state.selected[it.sessionId];
          cb.addEventListener('click', function (e) { e.stopPropagation(); });
          cb.addEventListener('change', function () {
            if (cb.checked) state.selected[it.sessionId] = true;
            else { delete state.selected[it.sessionId]; state.selectAllAcross = false; }
            syncSelectAllBox();
            refreshActions();
          });
          checkTd.appendChild(cb);
          tr.appendChild(checkTd);
          tr.appendChild(el('td', 'epv-admin-cell', displayName(it.name, it.email)));
          tr.appendChild(el('td', 'epv-admin-cell', it.email || '—'));
          tr.appendChild(el('td', 'epv-admin-cell', it.phone || '—'));
          var audTd = el('td'); audTd.appendChild(el('span', 'epv-admin-aud', formatAudience(it.audience)));
          tr.appendChild(audTd);
          tr.appendChild(el('td', 'epv-admin-preview', it.lastMessagePreview || '—'));
          tr.appendChild(el('td', 'epv-admin-when', it.lastMessageAt ? fmtDate(it.lastMessageAt) : fmtDate(it.createdAt)));
          tr.appendChild(el('td', 'epv-admin-num', String(it.messageCount)));
          tr.addEventListener('click', function () { openChat(it.sessionId); });
          rows.appendChild(tr);
        });
      }
      syncSelectAllBox();
      refreshActions();
      var pages = Math.max(1, Math.ceil(state.total / state.limit));
      $('epv-admin-page-info').textContent = 'Page ' + state.page + ' of ' + pages + ' · ' + state.total + ' total';
      $('epv-admin-prev').disabled = state.page <= 1;
      $('epv-admin-next').disabled = state.page >= pages;
    });
  }

  function selectedIds() { return Object.keys(state.selected || {}); }

  function refreshActions() {
    var n = selectedIds().length;
    var del = $('epv-admin-delete-btn');
    del.disabled = n === 0;
    del.textContent = n > 0 ? ('Delete selected (' + n + ')') : 'Delete selected';
    var exp = $('epv-admin-export-btn');
    exp.disabled = n === 0;
    exp.textContent = n > 0 ? ('Export selected (' + n + ')') : 'Export selected';
    var info = $('epv-admin-selinfo');
    if (n === 0) { info.hidden = true; info.textContent = ''; }
    else {
      info.hidden = false;
      info.textContent = state.selectAllAcross
        ? (n + ' chat' + (n === 1 ? '' : 's') + ' selected across all pages')
        : (n + ' selected on this page');
    }
  }

  // Reflects the header "select all" checkbox state from the current selection.
  function syncSelectAllBox() {
    var sa = $('epv-admin-select-all');
    if (!sa) return;
    var boxes = document.querySelectorAll('#epv-admin-chat-rows .epv-admin-check input');
    var allChecked = boxes.length > 0 && [].every.call(boxes, function (cb) { return cb.checked; });
    sa.checked = state.selectAllAcross || allChecked;
  }

  function clearSelection() {
    state.selected = {};
    state.selectAllAcross = false;
    var sa = $('epv-admin-select-all'); if (sa) sa.checked = false;
    document.querySelectorAll('#epv-admin-chat-rows .epv-admin-check input').forEach(function (cb) { cb.checked = false; });
    refreshActions();
  }

  // Select all chats matching the current filters across ALL pages (not just this one).
  function toggleSelectAll() {
    if (!$('epv-admin-select-all').checked) { clearSelection(); return; }
    var f = state.filters;
    var q = '?all=1';
    if (f.search) q += '&search=' + encodeURIComponent(f.search);
    if (f.audience) q += '&audience=' + encodeURIComponent(f.audience);
    if (f.dateFrom) q += '&dateFrom=' + encodeURIComponent(f.dateFrom);
    if (f.dateTo) q += '&dateTo=' + encodeURIComponent(f.dateTo);
    var sa = $('epv-admin-select-all'); sa.disabled = true;
    api('/chats/ids' + q).then(function (out) {
      sa.disabled = false;
      if (!out.ok) { sa.checked = false; return; }
      state.selected = {};
      out.data.sessionIds.forEach(function (id) { state.selected[id] = true; });
      state.selectAllAcross = true;
      document.querySelectorAll('#epv-admin-chat-rows .epv-admin-check input').forEach(function (cb) { cb.checked = true; });
      refreshActions();
    }).catch(function () { sa.disabled = false; sa.checked = false; });
  }

  function deleteSelected() {
    var ids = selectedIds();
    if (!ids.length) return;
    if (!window.confirm('Delete ' + ids.length + ' conversation' + (ids.length === 1 ? '' : 's') + '? This cannot be undone.')) return;
    var btn = $('epv-admin-delete-btn');
    btn.disabled = true; btn.textContent = 'Deleting…';
    api('/chats/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionIds: ids }),
    }).then(function (out) {
      if (!out.ok) { alert((out.data && out.data.error) || 'Delete failed.'); refreshActions(); return; }
      state.selected = {}; state.selectAllAcross = false;
      loadSummary();
      loadChats(state.page);
    }).catch(function () { alert('Could not connect.'); refreshActions(); });
  }

  function exportSelected() {
    var ids = selectedIds();
    if (!ids.length) return;
    var btn = $('epv-admin-export-btn');
    var orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Exporting…';
    fetch(API_BASE + '/api/admin/chats/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
      body: JSON.stringify({ sessionIds: ids }),
    }).then(function (res) {
      if (res.status === 401) { logout(); throw new Error('unauthorized'); }
      if (!res.ok) throw new Error('export failed');
      return res.blob();
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'chat-users-export.csv';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      btn.disabled = false; btn.textContent = orig; refreshActions();
    }).catch(function () { btn.disabled = false; refreshActions(); alert('Export failed.'); });
  }

  function openChat(sessionId) {
    api('/chats/' + encodeURIComponent(sessionId)).then(function (out) {
      if (!out.ok) return;
      var d = out.data;
      var leadBox = $('epv-admin-drawer-lead');
      leadBox.textContent = '';
      var lead = d.lead || {};
      // Single chatbot now (no left/right), so the source is always the site chatbot.
      [['Name', lead.name], ['Email', lead.email], ['Contact', lead.phone],
       ['Audience', formatAudience(d.session.audience)],
       ['Source', 'Website chatbot'],
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
      $('epv-admin-drawer-title').textContent = displayName(lead.name, lead.email) + ' · ' + d.messageCount + ' messages';
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

  // Live refresh: keep the chat list + counts current so a chat that just captured
  // an email shows its new name without a manual page reload. Skipped while the
  // user is busy (drawer open, a selection in progress, or typing in search) so it
  // never disrupts an action.
  function autoRefresh() {
    if ($('epv-admin-app').hidden) return;
    if (!$('epv-admin-drawer').hidden) return;
    if (state.selectAllAcross || Object.keys(state.selected).length > 0) return;
    if (document.activeElement === $('epv-admin-search')) return;
    loadChats(state.page);
    loadSummary();
  }

  /* ---------- tabs ---------- */
  function switchView(view) {
    var isCustom = view === 'custom';
    $('epv-admin-view-chats').hidden = isCustom;
    $('epv-admin-view-custom').hidden = !isCustom;
    $('epv-tab-chats').classList.toggle('is-active', !isCustom);
    $('epv-tab-custom').classList.toggle('is-active', isCustom);
    if (isCustom && !cq.loaded) { cq.loaded = true; loadCustomAnswers(); }
  }

  /* ---------- custom Q&A ---------- */
  var cq = { loaded: false, filters: {}, editingId: null, pendingConfirm: false, selected: {} };
  var CQ_AUDIENCE = { all: 'All', vet: 'Vet', pet_parent: 'Pet Parent', unknown: 'Not sure' };
  function cqAudienceLabel(a) { return CQ_AUDIENCE[a] || 'All'; }

  function cqShowError(msg) {
    var e = $('epv-cq-form-error');
    if (!msg) { e.hidden = true; e.textContent = ''; return; }
    e.textContent = msg; e.hidden = false;
  }
  function cqHideAlert() { var a = $('epv-cq-alert'); a.hidden = true; a.textContent = ''; }

  // Shows a duplicate alert with optional action buttons [{label, cls, fn}].
  function cqShowAlert(message, isBlock, actions) {
    var a = $('epv-cq-alert');
    a.className = 'epv-cq-alert' + (isBlock ? ' is-block' : '');
    a.textContent = '';
    a.appendChild(document.createTextNode(message));
    if (actions && actions.length) {
      var bar = el('div', 'epv-cq-alert-actions');
      actions.forEach(function (act) {
        var b = el('button', 'epv-admin-btn ' + (act.cls || 'epv-admin-btn-ghost'), act.label);
        b.type = 'button';
        b.addEventListener('click', act.fn);
        bar.appendChild(b);
      });
      a.appendChild(bar);
    }
    a.hidden = false;
  }

  function cqResetForm() {
    cq.editingId = null; cq.pendingConfirm = false;
    $('epv-cq-id').value = '';
    $('epv-cq-question').value = '';
    $('epv-cq-answer').value = '';
    $('epv-cq-audience').value = 'all';
    $('epv-cq-status').value = 'active';
    $('epv-cq-form-title').textContent = 'Add Custom Q&A';
    $('epv-cq-save').textContent = 'Save';
    cqHideAlert(); cqShowError('');
    if (typeof acClose === 'function') acClose();
  }

  function cqFillForm(it) {
    cq.editingId = it.id; cq.pendingConfirm = false;
    $('epv-cq-id').value = it.id;
    $('epv-cq-question').value = it.question;
    $('epv-cq-answer').value = it.answer;
    $('epv-cq-audience').value = it.audience;
    $('epv-cq-status').value = it.status;
    $('epv-cq-form-title').textContent = 'Edit Custom Q&A';
    $('epv-cq-save').textContent = 'Update';
    cqHideAlert(); cqShowError('');
    $('epv-cq-question').focus();
    $('epv-cq-question').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function cqReadFilters() {
    return {
      search: ($('epv-cq-search').value || '').trim(),
      audience: $('epv-cq-filter-audience').value || '',
      status: $('epv-cq-filter-status').value || '',
    };
  }

  function loadCustomAnswers() {
    var f = cq.filters;
    var q = '?limit=200';
    if (f.search) q += '&search=' + encodeURIComponent(f.search);
    if (f.audience) q += '&audience=' + encodeURIComponent(f.audience);
    if (f.status) q += '&status=' + encodeURIComponent(f.status);
    cq.selected = {}; // fresh list -> clear selection
    return api('/custom-answers' + q).then(function (out) {
      if (!out.ok) return;
      renderCustomRows(out.data.items || []);
    });
  }

  function cqSelectedIds() { return Object.keys(cq.selected).map(Number); }

  function cqRefreshBulk() {
    var n = cqSelectedIds().length;
    var del = $('epv-cq-bulk-delete'); del.disabled = n === 0;
    del.textContent = n > 0 ? ('Delete selected (' + n + ')') : 'Delete selected';
    $('epv-cq-bulk-activate').disabled = n === 0;
    $('epv-cq-bulk-deactivate').disabled = n === 0;
  }

  function cqSyncSelectAll() {
    var sa = $('epv-cq-select-all'); if (!sa) return;
    var boxes = document.querySelectorAll('#epv-cq-rows .epv-admin-check input');
    sa.checked = boxes.length > 0 && [].every.call(boxes, function (cb) { return cb.checked; });
  }

  function cqToggleSelectAll() {
    var checked = $('epv-cq-select-all').checked;
    cq.selected = {};
    document.querySelectorAll('#epv-cq-rows .epv-admin-check input').forEach(function (cb) {
      cb.checked = checked;
      if (checked) cq.selected[cb.dataset.id] = true;
    });
    cqRefreshBulk();
  }

  function renderCustomRows(items) {
    var tb = $('epv-cq-rows'); tb.textContent = '';
    if (!items.length) {
      var tr = el('tr'); var td = el('td', 'epv-admin-empty'); td.colSpan = 7;
      td.textContent = 'No custom answers yet.'; tr.appendChild(td); tb.appendChild(tr);
      cqSyncSelectAll(); cqRefreshBulk(); return;
    }
    items.forEach(function (it) {
      var tr = el('tr');
      var checkTd = el('td', 'epv-admin-check');
      var cb = el('input'); cb.type = 'checkbox'; cb.setAttribute('aria-label', 'Select answer');
      cb.dataset.id = it.id; cb.checked = !!cq.selected[it.id];
      cb.addEventListener('change', function () {
        if (cb.checked) cq.selected[it.id] = true; else delete cq.selected[it.id];
        cqSyncSelectAll(); cqRefreshBulk();
      });
      checkTd.appendChild(cb); tr.appendChild(checkTd);
      tr.appendChild(el('td', 'epv-cq-qcell', it.question));
      tr.appendChild(el('td', 'epv-cq-acell', it.answer));
      var audTd = el('td'); audTd.appendChild(el('span', 'epv-admin-aud', cqAudienceLabel(it.audience))); tr.appendChild(audTd);
      var stTd = el('td'); stTd.appendChild(el('span', 'epv-cq-status is-' + it.status, it.status === 'active' ? 'Active' : 'Inactive')); tr.appendChild(stTd);
      tr.appendChild(el('td', 'epv-admin-when', fmtDate(it.updatedAt)));
      var actTd = el('td'); var act = el('div', 'epv-cq-act');
      var edit = el('button', 'epv-admin-btn epv-admin-btn-secondary', 'Edit');
      edit.addEventListener('click', function () { cqFillForm(it); });
      var toggle = el('button', 'epv-admin-btn epv-admin-btn-ghost', it.status === 'active' ? 'Deactivate' : 'Activate');
      toggle.addEventListener('click', function () { cqToggleStatus(it); });
      var del = el('button', 'epv-admin-btn epv-admin-btn-danger', 'Delete');
      del.addEventListener('click', function () { cqDelete(it); });
      act.appendChild(edit); act.appendChild(toggle); act.appendChild(del);
      actTd.appendChild(act); tr.appendChild(actTd);
      tb.appendChild(tr);
    });
    cqSyncSelectAll(); cqRefreshBulk();
  }

  function cqReadForm() {
    return {
      question: ($('epv-cq-question').value || '').trim(),
      answer: ($('epv-cq-answer').value || '').trim(),
      audience: $('epv-cq-audience').value || 'all',
      status: $('epv-cq-status').value || 'active',
      priority: 100, // priority removed from the UI; DB column keeps its default
    };
  }

  function cqSave(confirmSimilar) {
    cqShowError(''); cqHideAlert();
    var body = cqReadForm();
    if (body.question.length < 3) { cqShowError('Question must be at least 3 characters.'); return; }
    if (body.answer.length < 3) { cqShowError('Answer must be at least 3 characters.'); return; }
    if (confirmSimilar) body.confirmSimilarDuplicate = true;
    var editing = cq.editingId != null && cq.editingId !== '';
    var path = editing ? '/custom-answers/' + cq.editingId : '/custom-answers';
    var btn = $('epv-cq-save'); btn.disabled = true;
    api(path, {
      method: editing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (out) {
      btn.disabled = false;
      if (out.ok) { cqResetForm(); loadCustomAnswers(); return; }
      var d = out.data || {};
      if (out.status === 409 && d.error === 'duplicate_question') {
        cqShowAlert(d.message || 'This question is already added.', true, [
          d.existing ? { label: 'Edit existing', cls: 'epv-admin-btn-secondary', fn: function () { openExisting(d.existing.id); } } : null,
          { label: 'Cancel', fn: cqHideAlert },
        ].filter(Boolean));
        return;
      }
      if (out.status === 409 && d.error === 'similar_question') {
        var ex = d.existing || {};
        var msg = 'A similar question already exists' + (ex.question ? ': "' + ex.question + '"' : '') + '. Do you still want to add this as a separate Q&A?';
        cqShowAlert(msg, false, [
          { label: 'Add anyway', cls: 'epv-admin-btn-primary', fn: function () { cqHideAlert(); cqSave(true); } },
          ex.id ? { label: 'Edit existing', cls: 'epv-admin-btn-secondary', fn: function () { openExisting(ex.id); } } : null,
          { label: 'Cancel', fn: cqHideAlert },
        ].filter(Boolean));
        return;
      }
      cqShowError(d.message || d.error || 'Could not save.');
    }).catch(function () { btn.disabled = false; cqShowError('Could not connect.'); });
  }

  // Loads an existing answer into the form (used by the duplicate alert).
  function openExisting(id) {
    api('/custom-answers?limit=200').then(function (out) {
      if (!out.ok) return;
      var item = (out.data.items || []).filter(function (x) { return x.id === id; })[0];
      if (item) cqFillForm(item);
    });
  }

  function cqToggleStatus(it) {
    var next = it.status === 'active' ? 'inactive' : 'active';
    api('/custom-answers/' + it.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: it.question, answer: it.answer, audience: it.audience,
        status: next, priority: it.priority,
      }),
    }).then(function (out) {
      if (out.ok) loadCustomAnswers();
      else alert((out.data && (out.data.message || out.data.error)) || 'Could not update status.');
    });
  }

  function cqDelete(it) {
    if (!window.confirm('Delete this custom answer?\n\n' + it.question)) return;
    api('/custom-answers/' + it.id, { method: 'DELETE' }).then(function (out) {
      if (out.ok) { if (cq.editingId === it.id) cqResetForm(); loadCustomAnswers(); }
      else alert((out.data && (out.data.message || out.data.error)) || 'Could not delete.');
    });
  }

  function cqBulkDelete() {
    var ids = cqSelectedIds(); if (!ids.length) return;
    if (!window.confirm('Delete ' + ids.length + ' custom answer' + (ids.length === 1 ? '' : 's') + '? This cannot be undone.')) return;
    api('/custom-answers/bulk-delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ids }),
    }).then(function (out) {
      if (out.ok) loadCustomAnswers();
      else alert((out.data && (out.data.message || out.data.error)) || 'Could not delete.');
    }).catch(function () { alert('Could not connect.'); });
  }

  function cqBulkStatus(status) {
    var ids = cqSelectedIds(); if (!ids.length) return;
    api('/custom-answers/bulk-status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ids, status: status }),
    }).then(function (out) {
      if (out.ok) loadCustomAnswers();
      else alert((out.data && (out.data.message || out.data.error)) || 'Could not update.');
    }).catch(function () { alert('Could not connect.'); });
  }

  /* ---------- Custom Q&A answer autocomplete (@ emails, / links) ---------- */
  // Many2one-style shortcut autocomplete, bound ONLY to the answer textarea.
  var ac = { open: false, loading: false, mode: null, q: null, tokenStart: 0, items: [], active: -1, debounce: null, seq: 0, cache: { email: null, link: null } };

  function acEls() { return { input: $('epv-cq-answer'), box: $('epv-cq-suggest') }; }

  // Active token = maximal non-whitespace run ending at the caret. It triggers
  // only when it STARTS with @ or / — so URLs ("https://…") and completed emails
  // ("support@…") never trigger (their token starts with a letter).
  function acDetectToken() {
    var input = acEls().input; if (!input) return null;
    var val = input.value, pos = input.selectionStart;
    if (pos == null) return null;
    var start = pos;
    while (start > 0 && !/\s/.test(val[start - 1])) start--;
    var token = val.slice(start, pos);
    if (token[0] === '@') return { mode: 'email', q: token.slice(1), tokenStart: start };
    if (token[0] === '/') return { mode: 'link', q: token.slice(1), tokenStart: start };
    return null;
  }

  function acReevaluate() {
    var t = acDetectToken();
    if (!t) { acClose(); return; }
    if (ac.open && ac.mode === t.mode && ac.q === t.q && ac.tokenStart === t.tokenStart) return;
    ac.open = true; ac.mode = t.mode; ac.q = t.q; ac.tokenStart = t.tokenStart;
    acQuery(t.mode, t.q);
  }

  function acQuery(mode, q) {
    if (ac.debounce) { clearTimeout(ac.debounce); ac.debounce = null; }
    if (q === '') {
      if (ac.cache[mode]) { acSetItems(ac.cache[mode]); }
      else { acLoading(); acFetch(mode, '', true); }
    } else {
      acLoading();
      ac.debounce = setTimeout(function () { acFetch(mode, q, false); }, 200);
    }
  }

  function acFetch(mode, q, isEmpty) {
    var seq = ++ac.seq;
    var path = (mode === 'email' ? '/suggestions/emails?q=' : '/suggestions/links?q=') + encodeURIComponent(q);
    api(path).then(function (out) {
      if (seq !== ac.seq || !ac.open) return;
      var items = (out.ok && out.data && Array.isArray(out.data.items)) ? out.data.items : [];
      if (isEmpty) ac.cache[mode] = items;
      acSetItems(items);
    }).catch(function () { if (seq === ac.seq && ac.open) acSetItems([]); });
  }

  function acLoading() { ac.loading = true; ac.items = []; ac.active = -1; acRender(); }
  function acSetItems(items) { ac.loading = false; ac.items = items || []; ac.active = ac.items.length ? 0 : -1; acRender(); }

  function acRender() {
    var box = acEls().box; if (!box) return;
    if (!ac.open) { box.hidden = true; box.textContent = ''; return; }
    box.textContent = '';
    if (ac.loading) {
      box.appendChild(el('div', 'epv-cq-suggest-empty', 'Loading…'));
    } else if (!ac.items.length) {
      box.appendChild(el('div', 'epv-cq-suggest-empty', ac.mode === 'email' ? 'No matching emails found' : 'No matching links found'));
    } else {
      ac.items.forEach(function (it, i) {
        var row = el('div', 'epv-cq-suggest-row' + (i === ac.active ? ' is-active' : ''));
        row.setAttribute('role', 'option');
        row.appendChild(el('div', 'epv-cq-suggest-label', it.label || it.value));
        if (ac.mode === 'link') row.appendChild(el('div', 'epv-cq-suggest-meta', it.url || it.value));
        row.addEventListener('mouseenter', function () { ac.active = i; acHighlight(); });
        row.addEventListener('click', function () { acSelect(i); });
        box.appendChild(row);
      });
    }
    box.hidden = false;
  }

  function acHighlight() {
    var box = acEls().box; if (!box) return;
    var rows = box.querySelectorAll('.epv-cq-suggest-row');
    for (var i = 0; i < rows.length; i++) {
      var on = i === ac.active;
      rows[i].classList.toggle('is-active', on);
      if (on && rows[i].scrollIntoView) rows[i].scrollIntoView({ block: 'nearest' });
    }
  }

  function acMove(dir) {
    if (!ac.items.length) return;
    ac.active = (ac.active + dir + ac.items.length) % ac.items.length;
    acHighlight();
  }

  function acSelect(i) {
    var item = ac.items[i]; if (!item) return;
    var input = acEls().input; if (!input) return;
    var insertVal = ac.mode === 'link' ? (item.url || item.value) : item.value;
    var val = input.value;
    var before = val.slice(0, ac.tokenStart);
    var after = val.slice(input.selectionStart);
    var needsSpace = after.length === 0 || !/\s/.test(after[0]);
    var head = before + insertVal + (needsSpace ? ' ' : '');
    input.value = head + after;
    var caret = head.length;
    acClose();
    input.focus();
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function acClose() {
    if (ac.debounce) { clearTimeout(ac.debounce); ac.debounce = null; }
    ac.open = false; ac.loading = false; ac.mode = null; ac.q = null; ac.items = []; ac.active = -1;
    var box = acEls().box; if (box) { box.hidden = true; box.textContent = ''; }
  }

  function acKeydown(e) {
    if (!ac.open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); acMove(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); acMove(-1); }
    else if (e.key === 'Enter') { if (ac.items.length && ac.active >= 0) { e.preventDefault(); e.stopPropagation(); acSelect(ac.active); } }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); acClose(); }
  }

  function initAnswerAutocomplete() {
    var els = acEls(); if (!els.input || !els.box) return;
    els.input.addEventListener('input', acReevaluate);
    els.input.addEventListener('click', acReevaluate);
    els.input.addEventListener('keyup', function (e) {
      if (ac.open && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Escape')) return;
      acReevaluate();
    });
    els.input.addEventListener('keydown', acKeydown);
    els.input.addEventListener('blur', function () { setTimeout(acClose, 150); });
    // Keep focus when clicking a row (prevents blur from closing before click).
    els.box.addEventListener('mousedown', function (e) { e.preventDefault(); });
    document.addEventListener('click', function (e) {
      if (!els.box.hidden && !(e.target.closest && e.target.closest('.epv-cq-suggest-wrap'))) acClose();
    });
  }

  /* ---------- wire up ---------- */
  function init() {
    $('epv-admin-login-form').addEventListener('submit', doLogin);
    $('epv-admin-logout-btn').addEventListener('click', logout);
    $('epv-admin-sync-btn').addEventListener('click', runSync);
    $('epv-admin-apply').addEventListener('click', function () { clearSelection(); state.filters = readFilters(); loadChats(1); });
    $('epv-admin-select-all').addEventListener('change', toggleSelectAll);
    $('epv-admin-delete-btn').addEventListener('click', deleteSelected);
    $('epv-admin-export-btn').addEventListener('click', exportSelected);
    $('epv-admin-search').addEventListener('keydown', function (e) { if (e.key === 'Enter') { clearSelection(); state.filters = readFilters(); loadChats(1); } });
    $('epv-admin-prev').addEventListener('click', function () { if (state.page > 1) loadChats(state.page - 1); });
    $('epv-admin-next').addEventListener('click', function () { loadChats(state.page + 1); });
    $('epv-admin-drawer').addEventListener('click', function (e) { if (e.target.getAttribute('data-close')) closeDrawer(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

    // Tabs + Custom Q&A
    $('epv-tab-chats').addEventListener('click', function () { switchView('chats'); });
    $('epv-tab-custom').addEventListener('click', function () { switchView('custom'); });
    $('epv-cq-form').addEventListener('submit', function (e) { e.preventDefault(); cqSave(false); });
    $('epv-cq-cancel').addEventListener('click', function () { cqResetForm(); });
    $('epv-cq-apply').addEventListener('click', function () { cq.filters = cqReadFilters(); loadCustomAnswers(); });
    $('epv-cq-search').addEventListener('keydown', function (e) { if (e.key === 'Enter') { cq.filters = cqReadFilters(); loadCustomAnswers(); } });
    $('epv-cq-select-all').addEventListener('change', cqToggleSelectAll);
    $('epv-cq-bulk-activate').addEventListener('click', function () { cqBulkStatus('active'); });
    $('epv-cq-bulk-deactivate').addEventListener('click', function () { cqBulkStatus('inactive'); });
    $('epv-cq-bulk-delete').addEventListener('click', cqBulkDelete);
    initAnswerAutocomplete();

    if (token()) { showApp(); loadAll(); } else { showLogin(); }
    setInterval(autoRefresh, 12000); // live-update the chat list every 12s
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
