/* Card-back section: shows the most recent Gmail emails (sent and received) with this card's client email address(es). */
(function () {
  'use strict';

  var CFG = window.GRI_CONFIG || {};
  var G = window.GRI;
  var SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
  var SECRET_KEY = 'gri_token';   // browser-local, encrypted by Trello's client library
  var EMAILS_KEY = 'gri_emails';  // card / shared pluginData: array of client email addresses
  var GIS_SRC = 'https://accounts.google.com/gsi/client';

  var t = window.TrelloPowerUp.iframe();
  var app = document.getElementById('app');

  var state = {
    emails: [],
    session: null,       // { access_token, exp, email }
    editing: false,
    notice: '',
    showFallback: false, // offer the separate sign-in window
    suggestions: []
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
    drawLoading();
    G.getProfile(accessToken).then(function (p) {
      if (p && p.emailAddress) session.email = String(p.emailAddress).toLowerCase();
    }).catch(function () { /* profile is only used for nicer links */ }).then(function () {
      return saveSession(session);
    }).then(draw);
  }

  function signOut() {
    state.session = null;
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

    var done = state.emails.length ? el('div', { class: 'actions' }, [
      el('button', { type: 'button', class: 'btn', text: 'Done', onclick: function () { state.editing = false; state.notice = ''; draw(); } })
    ]) : null;

    show([el('div', { class: 'panel stack' }, [
      noticeNode(),
      el('div', { class: 'muted small', text: state.emails.length
        ? 'Client email addresses for this card (visible to everyone on the board):'
        : 'Add the client’s email address to see your recent Gmail emails with them, sent and received. The address is saved on this card for everyone on the board.' }),
      chips, form, suggest, done
    ])]).then(function () { if (!state.emails.length || state.editing) input.focus({ preventScroll: true }); });
  }

  function drawConnect() {
    ensureGis();
    var who = state.emails.join(', ');
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
    var n = Math.min(Number(CFG.MAX_ROWS || CFG.MAX_THREADS) || 8, 3);
    var bars = [];
    for (var i = 0; i < n; i++) bars.push(el('div', { class: 'skel' }));
    show(bars);
  }

  function footer(hasMore) {
    var account = state.session && state.session.email;
    return el('div', { class: 'footer' }, [
      el('a', { href: G.searchUrl(state.emails, account), target: '_blank', rel: 'noopener noreferrer', text: hasMore ? 'More in Gmail' : 'Open in Gmail' }),
      el('span', { text: state.emails.join(', ') }),
      el('button', { type: 'button', class: 'linklike', text: 'Edit', onclick: startEditing }),
      el('span', { class: 'spacer' }),
      account ? el('span', { text: account }) : null,
      el('button', { type: 'button', class: 'linklike', text: 'Sign out', onclick: signOut })
    ]);
  }

  function drawList(result) {
    var account = state.session && state.session.email;
    var now = Date.now();
    var body;
    if (!result.items.length) {
      body = el('div', { class: 'panel muted', text: 'No emails found with ' + state.emails.join(', ') + ' in this mailbox.' });
    } else {
      body = el('ul', { class: 'rows' }, result.items.map(function (it) {
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
    show([noticeNode(), body, footer(result.hasMore)]);
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
    if (state.editing || !state.emails.length) return drawEditor();
    if (!isLive(state.session)) return drawConnect();

    drawLoading();
    G.recentInteractions(state.session.access_token, state.emails, CFG.MAX_ROWS || CFG.MAX_THREADS).then(function (result) {
      if (mine === seq) drawList(result);
    }).catch(function (err) {
      if (mine !== seq) return;
      if (err && err.code === 'AUTH') {
        // Token expired or revoked: keep the address for a one-click reconnect.
        var s = { access_token: '', exp: 0, email: (state.session && state.session.email) || '' };
        state.notice = '';
        saveSession(s).then(draw);
      } else {
        drawError(err);
      }
    });
  }

  function refresh() {
    return Promise.all([
      loadEmails(),
      loadSession(),
      t.card('name', 'desc').then(function (c) { return G.extractEmails((c.name || '') + '\n' + (c.desc || '')); }).catch(function () { return []; })
    ]).then(function (r) {
      state.emails = r[0];
      // Keep an in-memory session if storage is unavailable.
      if (r[1] || !state.session) state.session = r[1];
      state.suggestions = r[2];
      draw();
    });
  }

  // Trello calls render on first load and whenever card data changes.
  t.render(refresh);
})();
