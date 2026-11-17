/* Gmail query + parsing helpers. No DOM access, so the same file runs in the browser and in Node tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GRI = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var API = 'https://gmail.googleapis.com/gmail/v1/users/me';
  var MAX_EMAILS_PER_CARD = 5;

  // Deliberately strict: anything that could alter the Gmail search query
  // (spaces, braces, brackets, quotes, colons) is rejected.
  var EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
  var EMAIL_FIND_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

  function normalizeEmail(value) {
    var s = String(value == null ? '' : value).trim().toLowerCase();
    return EMAIL_RE.test(s) ? s : null;
  }

  function cleanEmailList(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (item) {
      var e = normalizeEmail(item);
      if (e && out.indexOf(e) === -1) out.push(e);
    });
    return out.slice(0, MAX_EMAILS_PER_CARD);
  }

  function extractEmails(text) {
    var found = String(text || '').match(EMAIL_FIND_RE) || [];
    return cleanEmailList(found.map(function (s) { return s.replace(/\.+$/, ''); }));
  }

  // {a b c} is Gmail's OR group. Matches mail from the address or sent to it in any recipient field.
  function buildQuery(emails) {
    var terms = [];
    cleanEmailList(emails).forEach(function (e) {
      terms.push('from:' + e, 'to:' + e, 'cc:' + e, 'bcc:' + e);
    });
    if (!terms.length) return '';
    return '{' + terms.join(' ') + '} -in:draft -in:chats';
  }

  function mailBase(account) {
    return 'https://mail.google.com/mail/u/' + (account ? '?authuser=' + encodeURIComponent(account) : '0/');
  }

  function threadUrl(threadId, account) {
    return mailBase(account) + '#all/' + encodeURIComponent(threadId);
  }

  function searchUrl(emails, account) {
    return mailBase(account) + '#search/' + encodeURIComponent(buildQuery(emails));
  }

  function header(message, name) {
    var headers = (message && message.payload && message.payload.headers) || [];
    var wanted = name.toLowerCase();
    for (var i = 0; i < headers.length; i++) {
      if (String(headers[i].name).toLowerCase() === wanted) return headers[i].value || '';
    }
    return '';
  }

  // Gmail normally returns headers already decoded; this covers the cases where it does not.
  function decodeRfc2047(value) {
    var s = String(value || '');
    if (s.indexOf('=?') === -1) return s;
    s = s.replace(/(\?=)\s+(=\?)/g, '$1$2');
    return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, function (whole, charset, enc, text) {
      try {
        var bytes = [];
        if (enc.toUpperCase() === 'B') {
          var bin = atob(text);
          for (var i = 0; i < bin.length; i++) bytes.push(bin.charCodeAt(i));
        } else {
          var q = text.replace(/_/g, ' ');
          for (var j = 0; j < q.length; j++) {
            var hex = q.substr(j + 1, 2);
            if (q[j] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); j += 2; }
            else bytes.push(q.charCodeAt(j));
          }
        }
        return new TextDecoder(charset).decode(new Uint8Array(bytes));
      } catch (e) {
        return whole;
      }
    });
  }

  function summarizeThread(thread) {
    var messages = ((thread && thread.messages) || []).filter(function (m) {
      return (m.labelIds || []).indexOf('DRAFT') === -1;
    });
    if (!messages.length) return null;
    messages.sort(function (a, b) { return Number(a.internalDate) - Number(b.internalDate); });
    var first = messages[0];
    var last = messages[messages.length - 1];
    var subject = decodeRfc2047(header(first, 'Subject')).trim() || '(no subject)';
    return {
      id: thread.id,
      subject: subject,
      lastDate: Number(last.internalDate) || 0,
      direction: (last.labelIds || []).indexOf('SENT') !== -1 ? 'out' : 'in',
      count: messages.length,
      unread: messages.some(function (m) { return (m.labelIds || []).indexOf('UNREAD') !== -1; })
    };
  }

  function api(path, token, fetchImpl) {
    var f = fetchImpl || fetch;
    return f(API + path, { headers: { Authorization: 'Bearer ' + token } }).then(function (res) {
      if (res.ok) return res.json();
      return res.json().catch(function () { return {}; }).then(function (body) {
        var message = (body && body.error && body.error.message) || ('Gmail API error ' + res.status);
        var err = new Error(message);
        err.status = res.status;
        err.code = res.status === 401 ? 'AUTH' : res.status === 403 ? 'FORBIDDEN' : res.status === 429 ? 'RATE' : 'API';
        throw err;
      });
    });
  }

  function getProfile(token, fetchImpl) {
    return api('/profile', token, fetchImpl);
  }

  function recentInteractions(token, emails, max, fetchImpl) {
    var q = buildQuery(emails);
    if (!q) return Promise.resolve({ items: [], hasMore: false });
    var limit = Math.max(1, Math.min(Number(max) || 5, 20));
    return api('/threads?maxResults=' + limit + '&q=' + encodeURIComponent(q), token, fetchImpl).then(function (list) {
      var threads = list.threads || [];
      return Promise.all(threads.map(function (th) {
        return api('/threads/' + encodeURIComponent(th.id) +
          '?format=metadata&metadataHeaders=Subject&metadataHeaders=Date', token, fetchImpl);
      })).then(function (full) {
        var items = full.map(summarizeThread).filter(Boolean);
        items.sort(function (a, b) { return b.lastDate - a.lastDate; });
        return { items: items, hasMore: !!list.nextPageToken };
      });
    });
  }

  // Today → time; this year → "12 Aug"; older → "12 Aug 2022".
  function formatDate(ms, nowMs, timeZone) {
    var d = new Date(ms);
    var now = new Date(nowMs == null ? Date.now() : nowMs);
    var tz = timeZone ? { timeZone: timeZone } : {};
    var ymd = function (x) {
      return x.toLocaleDateString('en-CA', Object.assign({ year: 'numeric', month: '2-digit', day: '2-digit' }, tz));
    };
    if (ymd(d) === ymd(now)) {
      return d.toLocaleTimeString('en-AU', Object.assign({ hour: 'numeric', minute: '2-digit' }, tz));
    }
    var opts = { day: 'numeric', month: 'short' };
    if (ymd(d).slice(0, 4) !== ymd(now).slice(0, 4)) opts.year = 'numeric';
    return d.toLocaleDateString('en-AU', Object.assign(opts, tz));
  }

  return {
    MAX_EMAILS_PER_CARD: MAX_EMAILS_PER_CARD,
    normalizeEmail: normalizeEmail,
    cleanEmailList: cleanEmailList,
    extractEmails: extractEmails,
    buildQuery: buildQuery,
    threadUrl: threadUrl,
    searchUrl: searchUrl,
    decodeRfc2047: decodeRfc2047,
    summarizeThread: summarizeThread,
    getProfile: getProfile,
    recentInteractions: recentInteractions,
    formatDate: formatDate
  };
});
