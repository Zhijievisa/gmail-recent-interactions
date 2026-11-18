/* Card-back section: shows the most recent Gmail emails (sent and received) with this card's client email address(es). */
(function () {
  'use strict';

  var CFG = window.GRI_CONFIG || {};
  var G = window.GRI;
  var SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
  var SECRET_KEY = 'gri_token';   // browser-local, encrypted by Trello's client library
  var EMAILS_KEY = 'gri_emails';  // card / shared pluginData: array of client email addresses
  var SHARED_KEY = 'gri_shared';  // addresses used across matters (other side's lawyer, court registry)
  var KEYWORDS_KEY = 'gri_keywords'; // matter keywords that a shared address's email must contain
  var LABEL_KEY = 'gri_label';    // Gmail label name: everything under it is shown
  var GIS_SRC = 'https://accounts.google.com/gsi/client';

  var t = window.TrelloPowerUp.iframe();
  var app = document.getElementById('app');

  var state = {
    emails: [],
    shared: [],
    keywords: [],
    label: '',
    labelNames: null,    // this mailbox's label names, once fetched
    session: null,       // { access_token, exp, email }
    editing: false,
    notice: '',
    showFallback: false, // offer the separate sign-in window
    suggestions: [],
    list: null           // { items, nextPageToken, loadingMore } for the emails currently shown
  };
  var tokenClient = null;
  var gisState = 'idle'; // idle | loading | ready | failed
  var seq = 0;

  /* ---------- small DOM helpers (textContent only: nothing from Gmail is ever parsed as HTML) ---------- */

  function el(tag, props, children) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === 'text') node.textContent = v;
      else if (k === 'class') node.className = v;
      else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function arrowIcon(direction) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(ns, 'path');
    // in: arrow pointing down-left; out: arrow pointing up-right
    path.setAttribute('d', direction === 'out' ? 'M4 12 12 4M6 4h6v6' : 'M12 4 4 12M10 12H4V6');
    svg.appendChild(path);
    return svg;
  }

  function show(nodes) {
    app.replaceChildren.apply(app, nodes.filter(Boolean));
    return t.sizeTo('#app').catch(function () {});
  }

  function noticeNode() {
    return state.notice ? el('div', { class: 'notice', role: 'status', text: state.notice }) : null;
  }

  /* ---------- storage ---------- */

  function isLive(s) {
    return !!(s && s.access_token && s.exp && s.exp - 60000 > Date.now());
  }

  function loadSession() {
    return t.loadSecret(SECRET_KEY).then(function (raw) {
      return raw ? JSON.parse(raw) : null;
    }).catch(function () { return null; });
  }

  function saveSession(s) {
    state.session = s;
    return t.storeSecret(SECRET_KEY, JSON.stringify(s)).catch(function () {
      state.notice = 'Could not save the Gmail session in this browser (is localStorage blocked?). It will last until this card is closed.';
    });
  }

  function loadEmails() {
    return t.get('card', 'shared', EMAILS_KEY, []).then(G.cleanEmailList).catch(function () { return []; });
  }

  function saveEmails(list) {
    var clean = G.cleanEmailList(list);
    return t.set('card', 'shared', EMAILS_KEY, clean).then(function () {
      state.emails = clean;
    });
  }

  function loadMatter() {
    return Promise.all([
      t.get('card', 'shared', SHARED_KEY, []),
      t.get('card', 'shared', KEYWORDS_KEY, []),
      t.get('card', 'shared', LABEL_KEY, '')
    ]).then(function (r) {
      return { shared: G.cleanEmailList(r[0]), keywords: G.cleanKeywordList(r[1]), label: G.normalizeLabel(r[2]) };
    }).catch(function () { return { shared: [], keywords: [], label: '' }; });
  }

  function saveShared(list) {
    var clean = G.cleanEmailList(list);
    return t.set('card', 'shared', SHARED_KEY, clean).then(function () { state.shared = clean; });
  }

  function saveKeywords(list) {
    var clean = G.cleanKeywordList(list);
    return t.set('card', 'shared', KEYWORDS_KEY, clean).then(function () { state.keywords = clean; });
  }

  function saveLabel(name) {
    var clean = G.normalizeLabel(name);
    return t.set('card', 'shared', LABEL_KEY, clean).then(function () { state.label = clean; });
  }

  function spec() {
    return { emails: state.emails, shared: state.shared, keywords: state.keywords, label: state.label };
  }

  // Fetched once per signed-in session; used for the label suggestions and the "not in this mailbox" warning.
  function ensureLabelNames() {
    if (state.labelNames || !isLive(state.session)) return;
    var token = state.session.access_token;
    state.labelNames = [];
    G.listLabels(token).then(function (names) {
      if (!state.session || state.session.access_token !== token) return;
      state.labelNames = names;
      if (state.editing) drawEditor(); else if (state.list && state.label) drawList();
    }).catch(function () { /* suggestions only */ });
  }

  /* ---------- Google sign-in ---------- */

  function configOk() {
    var id = String(CFG.GOOGLE_CLIENT_ID || '');
    return /\.apps\.googleusercontent\.com$/.test(id) && id.indexOf('PASTE_') !== 0;
  }

  // Load Google's script as soon as we know sign-in is needed, so it is ready when the button is clicked
  // (a pop-up opened after an async load would be blocked by the browser).
  function ensureGis() {
    if (gisState !== 'idle') return;
    gisState = 'loading';
    var s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = function () {
      try {
        var cfg = { client_id: CFG.GOOGLE_CLIENT_ID, scope: SCOPE, callback: onTokenResponse, error_callback: onTokenError };
        if (CFG.WORKSPACE_DOMAIN) cfg.hd = CFG.WORKSPACE_DOMAIN;
        tokenClient = window.google.accounts.oauth2.initTokenClient(cfg);
        gisState = 'ready';
      } catch (e) {
        gisState = 'failed';
        state.showFallback = true;
        draw();
      }
    };
    s.onerror = function () {
      gisState = 'failed';
      state.showFallback = true;
      draw();
    };
    document.head.appendChild(s);
  }

  function onConnectClick() {
    if (gisState === 'failed' || !tokenClient) {
      if (gisState === 'failed') return openSignInWindow();
      state.notice = 'Google sign-in is still loading. Try again in a second.';
      return draw();
    }
    var known = state.session && state.session.email;
    // Must run synchronously inside the click handler so the pop-up is allowed.
    tokenClient.requestAccessToken(known ? { prompt: '', login_hint: known } : {});
  }

  function onTokenResponse(resp) {
    if (!resp || resp.error || !resp.access_token) {
      state.notice = 'Google sign-in was not completed' + (resp && resp.error ? ' (' + resp.error + ').' : '.');
      state.showFallback = true;
      return draw();
    }
    if (!window.google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE)) {
      state.notice = 'Gmail read permission was not granted, so there is nothing to show. Connect again and tick the Gmail box.';
      return draw();
    }
    acceptToken(resp.access_token, resp.expires_in);
  }

  function onTokenError(err) {
    var type = err && err.type;
    if (type === 'popup_closed') state.notice = 'The Google sign-in window was closed before finishing.';
    else if (type === 'popup_failed_to_open') state.notice = 'Your browser blocked the Google sign-in pop-up.';
    else state.notice = 'Google sign-in did not complete.';
    state.showFallback = true;
    draw();
  }

  // Fallback: a separate top-level window on our own domain runs the same Google sign-in and hands the token back.
  function openSignInWindow() {
    var url = new URL('./auth.html', window.location.href);
    url.hash = '';
    url.search = '';
    t.authorize(url.href, {
      height: 560,
      width: 500,
      validToken: function (value) {
        try { return !!JSON.parse(value).access_token; } catch (e) { return false; }
      }
    }).then(function (value) {
      var o = JSON.parse(value);
      acceptToken(o.access_token, o.expires_in);
    }).catch(function () {
      state.notice = 'Sign-in window did not return a Gmail session.';
      draw();
    });
  }

  function acceptToken(accessToken, expiresIn) {
    var session = {
      access_token: accessToken,
      exp: Date.now() + (Number(expiresIn) || 3600) * 1000,
      email: (state.session && state.session.email) || ''
    };
    state.notice = '';
    state.showFallback = false;
    state.session = session;
    state.labelNames = null;
    drawLoading();
    G.getProfile(accessToken).then(function (p) {
      if (p && p.emailAddress) session.email = String(p.emailAddress).toLowerCase();
    }).catch(function () { /* profile is only used for nicer links */ }).then(function () {
      return saveSession(session);
    }).then(draw);
  }

  function signOut() {
    state.session = null;
    state.labelNames = null;
    state.list = null;
    state.notice = '';
    t.clearSecret(SECRET_KEY).catch(function () {}).then(draw);
  }

  /* ---------- views ---------- */

  function drawSetup() {
    show([el('div', { class: 'panel stack' }, [
      el('div', { text: 'Setup needed' }),
      el('div', { class: 'muted small', text: 'Put your Google OAuth client ID in js/config.js (see README, step A), then reload Trello.' })
    ])]);
  }

  function drawEditor() {
    var input = el('input', {
      type: 'email', placeholder: 'client@example.com', 'aria-label': 'Client email address',
      autocomplete: 'off', spellcheck: 'false'
    });

    function add(value) {
      var e = G.normalizeEmail(value);
      if (!e) { state.notice = 'That does not look like a single email address.'; return drawEditor(); }
      if (state.emails.indexOf(e) !== -1) { state.notice = 'That address is already on this card.'; return drawEditor(); }
      if (state.emails.length >= G.MAX_EMAILS_PER_CARD) { state.notice = 'Up to ' + G.MAX_EMAILS_PER_CARD + ' addresses per card.'; return drawEditor(); }
      state.notice = '';
      saveEmails(state.emails.concat([e])).then(function () {
        state.editing = false;
        draw();
      }).catch(function () {
        state.notice = 'Could not save to this card (you may not have edit rights on this board).';
        drawEditor();
      });
    }

    function remove(email) {
      state.notice = '';
      saveEmails(state.emails.filter(function (x) { return x !== email; })).then(drawEditor).catch(function () {
        state.notice = 'Could not save to this card.';
        drawEditor();
      });
    }

    var chips = state.emails.length ? el('div', { class: 'chips' }, state.emails.map(function (e) {
      return el('span', { class: 'chip' }, [
        el('span', { text: e }),
        el('button', { type: 'button', 'aria-label': 'Remove ' + e, title: 'Remove', text: '×', onclick: function () { remove(e); } })
      ]);
    })) : null;

    var form = el('form', { class: 'addrow', novalidate: '', onsubmit: function (ev) { ev.preventDefault(); add(input.value); } }, [
      input,
      el('button', { type: 'submit', class: 'btn btn-primary', text: 'Add' })
    ]);

    // Suggest addresses written on the card, but never the firm's own (signed-in account or configured domain).
    var ownDomain = String(CFG.WORKSPACE_DOMAIN || '').toLowerCase();
    var fresh = state.suggestions.filter(function (e) {
      if (state.emails.indexOf(e) !== -1) return false;
      if (state.session && e === state.session.email) return false;
      return !(ownDomain && e.slice(e.lastIndexOf('@') + 1) === ownDomain);
    }).slice(0, 3);
    var suggest = fresh.length ? el('div', { class: 'actions small' }, [el('span', { class: 'muted', text: 'Found on this card:' })].concat(
      fresh.map(function (e) {
        return el('button', { type: 'button', class: 'linklike', text: 'Use ' + e, onclick: function () { add(e); } });
      })
    )) : null;

    var done = G.hasSource(spec()) ? el('div', { class: 'actions' }, [
      el('button', { type: 'button', class: 'btn', text: 'Done', onclick: function () { state.editing = false; state.notice = ''; draw(); } })
    ]) : null;

    function fail() {
      state.notice = 'Could not save to this card (you may not have edit rights on this board).';
      drawEditor();
    }

    // A labelled chip list with its own add row.
    function group(opts) {
      var box = el('input', { type: opts.type || 'text', placeholder: opts.placeholder, 'aria-label': opts.title,
        autocomplete: 'off', spellcheck: 'false', id: opts.id });
      var list = opts.items.length ? el('div', { class: 'chips' }, opts.items.map(function (v) {
        return el('span', { class: 'chip' }, [
          el('span', { text: v }),
          el('button', { type: 'button', 'aria-label': 'Remove ' + v, title: 'Remove', text: '\u00d7', onclick: function () {
            state.notice = '';
            opts.save(opts.items.filter(function (x) { return x !== v; })).then(drawEditor).catch(fail);
          } })
        ]);
      })) : null;
      return el('div', { class: 'group stack' }, [
        el('div', { class: 'grouptitle', text: opts.title }),
        el('div', { class: 'muted small', text: opts.help }),
        list,
        el('form', { class: 'addrow', novalidate: '', onsubmit: function (ev) {
          ev.preventDefault();
          var v = opts.normalize(box.value);
          if (!v) { state.notice = opts.invalid; return drawEditor(); }
          if (opts.items.some(function (x) { return x.toLowerCase() === v.toLowerCase(); })) { state.notice = 'That is already on this card.'; return drawEditor(); }
          if (opts.items.length >= opts.max) { state.notice = 'Up to ' + opts.max + ' per card.'; return drawEditor(); }
          if (opts.reject && opts.reject(v)) { state.notice = opts.reject(v); return drawEditor(); }
          state.notice = '';
          opts.save(opts.items.concat([v])).then(drawEditor).catch(fail);
        } }, [box, el('button', { type: 'submit', class: 'btn', text: 'Add' })])
      ]);
    }

    var sharedGroup = group({
      id: 'shared-input', title: 'Shared addresses', type: 'email', placeholder: 'lawyer@otherside.com.au',
      help: 'Addresses that also appear in other matters, such as the other side\u2019s lawyer or a court registry. Their emails are shown only when they contain one of the matter keywords below.',
      items: state.shared, max: G.MAX_EMAILS_PER_CARD, normalize: G.normalizeEmail, save: saveShared,
      invalid: 'That does not look like a single email address.',
      reject: function (v) { return state.emails.indexOf(v) !== -1 ? 'That address is already a client address on this card.' : ''; }
    });

    var keywordGroup = group({
      id: 'keyword-input', title: 'Matter keywords', placeholder: 'CIV-25-001234',
      help: 'Court file number first, then party names. Used only with the shared addresses above.',
      items: state.keywords, max: G.MAX_KEYWORDS_PER_CARD, normalize: G.normalizeKeyword, save: saveKeywords,
      invalid: 'Use letters, numbers, spaces and - . / & only, at least 4 characters (2 for non-Latin names).'
    });

    var labelInput = el('input', { type: 'text', placeholder: 'Gmail label name', 'aria-label': 'Gmail label',
      autocomplete: 'off', spellcheck: 'false', id: 'label-input', list: 'label-names', value: state.label || null });
    var labelGroup = el('div', { class: 'group stack' }, [
      el('div', { class: 'grouptitle', text: 'Gmail label' }),
      el('div', { class: 'muted small', text: 'Every email under this label is shown, whoever it is from. Each person sees the label in their own mailbox.' }),
      el('datalist', { id: 'label-names' }, (state.labelNames || []).map(function (n) { return el('option', { value: n }); })),
      el('form', { class: 'addrow', novalidate: '', onsubmit: function (ev) {
        ev.preventDefault();
        var raw = labelInput.value.trim();
        var v = G.normalizeLabel(raw);
        if (raw && !G.labelTerm(v)) { state.notice = 'That label name cannot be used.'; return drawEditor(); }
        state.notice = (v && state.labelNames && state.labelNames.length && !G.labelKnown(v, state.labelNames))
          ? 'Saved, but there is no label "' + v + '" in ' + ((state.session && state.session.email) || 'this mailbox') + ' yet.' : '';
        saveLabel(v).then(drawEditor).catch(fail);
      } }, [labelInput, el('button', { type: 'submit', class: 'btn', text: state.label ? 'Update' : 'Set' })])
    ]);

    var matter = el('details', { class: 'matter', open: (state.shared.length || state.keywords.length || state.label) ? '' : null,
      ontoggle: function () { t.sizeTo('#app').catch(function () {}); } }, [
      el('summary', { text: 'Litigation matter: shared addresses, keywords, label' }),
      sharedGroup, keywordGroup, labelGroup
    ]);
    ensureLabelNames();

    show([el('div', { class: 'panel stack' }, [
      noticeNode(),
      el('div', { class: 'muted small', text: state.emails.length
        ? 'Client email addresses for this card (visible to everyone on the board):'
        : 'Add the client’s email address to see your recent Gmail emails with them, sent and received. The address is saved on this card for everyone on the board.' }),
      chips, form, suggest, matter, done
    ])]).then(function () { if (!G.hasSource(spec()) && !state.shared.length) input.focus({ preventScroll: true }); });
  }

  function drawConnect() {
    ensureGis();
    var who = G.describe(spec());
    var expired = state.session && state.session.email;
    show([el('div', { class: 'panel stack' }, [
      noticeNode(),
      el('div', { class: 'muted small', text: expired
        ? 'Gmail access lasts about an hour. Reconnect ' + state.session.email + ' to see emails with ' + who + '.'
        : 'Connect your Gmail to see recent emails with ' + who + '. Read-only; nothing is copied into Trello.' }),
      el('div', { class: 'actions' }, [
        el('button', { type: 'button', class: 'btn btn-primary', text: expired ? 'Reconnect Gmail' : 'Connect Gmail', onclick: onConnectClick }),
        state.showFallback ? el('button', { type: 'button', class: 'linklike small', text: 'Trouble? Use the sign-in window', onclick: openSignInWindow }) : null,
        el('button', { type: 'button', class: 'linklike small', text: 'Edit emails', onclick: startEditing })
      ])
    ])]);
  }

  function drawLoading() {
    var n = Math.min(Number(CFG.MAX_ROWS || CFG.MAX_THREADS) || 8, 3); // a few placeholder bars, not one per row
    var bars = [];
    for (var i = 0; i < n; i++) bars.push(el('div', { class: 'skel' }));
    show(bars);
  }

  function footer() {
    var account = state.session && state.session.email;
    return el('div', { class: 'footer' }, [
      el('a', { href: G.searchUrl(spec(), account), target: '_blank', rel: 'noopener noreferrer', text: 'Open in Gmail' }),
      el('span', { text: G.describe(spec()) }),
      el('button', { type: 'button', class: 'linklike', text: 'Edit', onclick: startEditing }),
      el('span', { class: 'spacer' }),
      account ? el('span', { text: account }) : null,
      el('button', { type: 'button', class: 'linklike', text: 'Sign out', onclick: signOut })
    ]);
  }

  function rowsPerPage() {
    return CFG.MAX_ROWS || CFG.MAX_THREADS;
  }

  function drawList() {
    var list = state.list || { items: [], nextPageToken: '' };
    var account = state.session && state.session.email;
    var now = Date.now();
    var body;
    if (!list.items.length) {
      body = el('div', { class: 'panel muted', text: 'No emails found for ' + G.describe(spec()) + ' in this mailbox.' });
    } else {
      body = el('ul', { class: 'rows' }, list.items.map(function (it) {
        var verb = it.direction === 'out' ? 'Sent' : 'Received';
        var meta = verb + ' \u00b7 ' + G.formatDate(it.date, now);
        return el('li', {}, [
          el('a', { class: 'row', href: G.threadUrl(it.threadId, account), target: '_blank', rel: 'noopener noreferrer', title: it.subject }, [
            el('span', { class: 'dir dir-' + it.direction, title: verb }, [arrowIcon(it.direction)]),
            el('span', { class: 'main' }, [
              el('span', { class: 'subject' + (it.unread ? ' unread' : ''), text: it.subject }),
              el('span', { class: 'meta', text: meta })
            ])
          ])
        ]);
      }));
    }
    var more = list.nextPageToken ? el('div', { class: 'morerow' }, [
      el('button', {
        type: 'button', class: 'btn', id: 'load-more', disabled: list.loadingMore ? '' : null,
        text: list.loadingMore ? 'Loading\u2026' : 'Load more', onclick: loadMore
      }),
      el('span', { class: 'muted small', text: list.items.length + ' shown' })
    ]) : null;
    var keepScroll = app.querySelector('.rows') ? app.querySelector('.rows').scrollTop : 0;
    var warn = [];
    if (G.sharedIgnored(spec())) warn.push('Shared addresses are ignored until a matter keyword is added.');
    if (state.label && state.labelNames && state.labelNames.length && !G.labelKnown(state.label, state.labelNames)) {
      warn.push('There is no Gmail label "' + state.label + '" in ' + (account || 'this mailbox') + '.');
    }
    var warnNode = warn.length ? el('div', { class: 'notice', role: 'status', text: warn.join(' ') }) : null;
    return show([noticeNode(), warnNode, body, more, footer()]).then(function () {
      var rows = app.querySelector('.rows');
      if (rows && keepScroll) rows.scrollTop = keepScroll;
    });
  }

  // Fetches the next (older) page and appends it under the rows already shown.
  function loadMore() {
    var list = state.list;
    if (!list || !list.nextPageToken || list.loadingMore) return;
    var mine = seq; // a newer draw() (card data changed, sign-out…) cancels this request
    list.loadingMore = true;
    state.notice = '';
    drawList();
    G.recentInteractions(state.session.access_token, spec(), rowsPerPage(), undefined, list.nextPageToken).then(function (result) {
      if (mine !== seq || state.list !== list) return;
      list.items = G.mergeItems(list.items, result.items);
      list.nextPageToken = result.nextPageToken;
      list.loadingMore = false;
      drawList();
    }).catch(function (err) {
      if (mine !== seq || state.list !== list) return;
      list.loadingMore = false;
      if (err && err.code === 'AUTH') return expireSession();
      state.notice = err && err.code === 'RATE' ? 'Gmail is rate-limiting requests. Try Load more again in a minute.'
        : 'Could not load more emails' + (err && err.message && err.code ? ': ' + err.message : '. Check your connection and try again.');
      drawList();
    });
  }

  // Token expired or revoked: keep the address so reconnecting is one click.
  function expireSession() {
    var s = { access_token: '', exp: 0, email: (state.session && state.session.email) || '' };
    state.notice = '';
    state.list = null;
    return saveSession(s).then(draw);
  }

  function drawError(err) {
    var msg = err && err.code === 'RATE' ? 'Gmail is rate-limiting requests. Try again in a minute.'
      : err && err.code === 'FORBIDDEN' ? 'Gmail refused the request: ' + err.message
      : err && err.message && err.code ? 'Gmail error: ' + err.message
      : 'Could not reach Gmail. Check your connection and try again.';
    show([el('div', { class: 'panel stack' }, [
      el('div', { class: 'notice', role: 'alert', text: msg }),
      el('div', { class: 'actions' }, [
        el('button', { type: 'button', class: 'btn', text: 'Retry', onclick: draw }),
        el('button', { type: 'button', class: 'linklike small', text: 'Sign out', onclick: signOut })
      ])
    ])]);
  }

  function startEditing() {
    state.editing = true;
    state.notice = '';
    draw();
  }

  /* ---------- controller ---------- */

  function draw() {
    var mine = ++seq;
    if (!configOk()) return drawSetup();
    if (state.editing || !G.hasSource(spec())) return drawEditor();
    if (!isLive(state.session)) return drawConnect();

    drawLoading();
    ensureLabelNames();
    G.recentInteractions(state.session.access_token, spec(), rowsPerPage()).then(function (result) {
      if (mine !== seq) return;
      state.list = { items: result.items, nextPageToken: result.nextPageToken, loadingMore: false };
      drawList();
    }).catch(function (err) {
      if (mine !== seq) return;
      if (err && err.code === 'AUTH') expireSession();
      else drawError(err);
    });
  }

  function refresh() {
    return Promise.all([
      loadEmails(),
      loadSession(),
      t.card('name', 'desc').then(function (c) { return G.extractEmails((c.name || '') + '\n' + (c.desc || '')); }).catch(function () { return []; }),
      loadMatter()
    ]).then(function (r) {
      state.emails = r[0];
      // Keep an in-memory session if storage is unavailable.
      if (r[1] || !state.session) state.session = r[1];
      state.suggestions = r[2];
      state.shared = r[3].shared;
      state.keywords = r[3].keywords;
      state.label = r[3].label;
      draw();
    });
  }

  // Trello calls render on first load and whenever card data changes.
  t.render(refresh);
})();
