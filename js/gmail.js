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

  var MAX_KEYWORDS_PER_CARD = 6;
  var MAX_LABEL_LENGTH = 80;

  // A matter keyword (court file number, party name) is always sent to Gmail as a quoted phrase, so only
  // characters that cannot break out of the quotes or act as search operators are allowed.
  // Latin-only keywords need 4+ characters so a bare surname or initials cannot pull in other matters.
  function normalizeKeyword(value) {
    var s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (!s || s.length > 60) return null;
    if (!/^[\p{L}\p{N}][\p{L}\p{N} .&'\/_-]*$/u.test(s)) return null;
    var min = /^[\x00-\x7F]*$/.test(s) ? 4 : 2;
    return s.replace(/[^\p{L}\p{N}]/gu, '').length >= min ? s : null;
  }

  function cleanKeywordList(list) {
    var out = [], seen = {};
    (Array.isArray(list) ? list : []).forEach(function (item) {
      var k = normalizeKeyword(item);
      if (k && !seen[k.toLowerCase()]) { seen[k.toLowerCase()] = true; out.push(k); }
    });
    return out.slice(0, MAX_KEYWORDS_PER_CARD);
  }

  // The Gmail label is stored by its display name, because label ids differ between mailboxes.
  function normalizeLabel(value) {
    var s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (!s || s.length > MAX_LABEL_LENGTH) return '';
    return /[\p{L}\p{N}]/u.test(s) ? s : '';
  }

  // Gmail's label: operator takes the name with spaces, slashes and punctuation written as hyphens.
  function labelTerm(name) {
    var n = normalizeLabel(name);
    if (!n) return '';
    var slug = n.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, '-').replace(/^-+|-+$/g, '');
    return slug ? 'label:' + slug : '';
  }

  // What a card matches. A plain array is the original form: client addresses only.
  //   emails   - client addresses: every email with them is shown
  //   shared   - addresses used across matters (other side's lawyer, court registry):
  //              shown only when the email also contains one of the matter keywords
  //   keywords - court file number, party names
  //   label    - a Gmail label: everything under it is shown
  function cleanSpec(spec) {
    if (Array.isArray(spec)) spec = { emails: spec };
    spec = spec || {};
    var emails = cleanEmailList(spec.emails);
    return {
      emails: emails,
      shared: cleanEmailList(spec.shared).filter(function (e) { return emails.indexOf(e) === -1; }),
      keywords: cleanKeywordList(spec.keywords),
      label: normalizeLabel(spec.label)
    };
  }

  function addressGroup(list) {
    var terms = [];
    list.forEach(function (e) { terms.push('from:' + e, 'to:' + e, 'cc:' + e, 'bcc:' + e); });
    return '{' + terms.join(' ') + '}'; // {a b c} is Gmail's OR group
  }

  // Shared addresses with no keyword are left out of the search entirely: they never fall back to "all mail".
  function hasSource(spec) {
    var s = cleanSpec(spec);
    return !!(s.emails.length || (s.shared.length && s.keywords.length) || labelTerm(s.label));
  }

  function sharedIgnored(spec) {
    var s = cleanSpec(spec);
    return s.shared.length > 0 && !s.keywords.length;
  }

  function buildQuery(spec) {
    var s = cleanSpec(spec);
    var parts = [];
    if (s.emails.length) parts.push(addressGroup(s.emails));
    if (s.shared.length && s.keywords.length) {
      parts.push('(' + addressGroup(s.shared) + ' {' +
        s.keywords.map(function (k) { return '"' + k + '"'; }).join(' ') + '})');
    }
    var lt = labelTerm(s.label);
    if (lt) parts.push(lt);
    if (!parts.length) return '';
    var core = parts.length === 1 ? parts[0] : '(' + parts.join(' OR ') + ')';
    return core + ' -in:draft -in:chats';
  }

  function describe(spec) {
    var s = cleanSpec(spec);
    var bits = s.emails.slice();
    if (s.shared.length && s.keywords.length) bits.push(s.shared.join(', ') + ' (matter keywords only)');
    if (s.label) bits.push('label "' + s.label + '"');
    return bits.join(', ');
  }

  // Names of the mailbox's own labels, for the label picker and the "not in this mailbox" warning.
  function listLabels(token, fetchImpl) {
    return api('/labels', token, fetchImpl).then(function (res) {
      return ((res && res.labels) || []).filter(function (l) { return l && l.type === 'user' && l.name; })
        .map(function (l) { return String(l.name); }).sort(function (a, b) { return a.localeCompare(b); });
    });
  }

  function labelKnown(name, names) {
    var want = labelTerm(name);
    return !!want && (names || []).some(function (n) { return labelTerm(n) === want; });
  }

  function mailBase(account) {
    return 'https://mail.google.com/mail/u/' + (account ? '?authuser=' + encodeURIComponent(account) : '0/');
  }

  function threadUrl(threadId, account) {
    return mailBase(account) + '#all/' + encodeURIComponent(threadId);
  }

  function searchUrl(spec, account) {
    return mailBase(account) + '#search/' + encodeURIComponent(buildQuery(spec));
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

  // One row per email (not per conversation), so mail we sent is listed in its own right even when
  // it sits inside a longer thread whose latest message came from someone else.
  function summarizeMessage(message) {
    if (!message || !message.id) return null;
    var labels = message.labelIds || [];
    if (labels.indexOf('DRAFT') !== -1) return null;
    return {
      id: message.id,
      threadId: message.threadId || message.id,
      subject: decodeRfc2047(header(message, 'Subject')).trim() || '(no subject)',
      date: Number(message.internalDate) || 0,
      direction: labels.indexOf('SENT') !== -1 ? 'out' : 'in',
      unread: labels.indexOf('UNREAD') !== -1
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

  // Returns one page of emails, newest first. Pass the previous page's nextPageToken to get older ones.
  function recentInteractions(token, spec, max, fetchImpl, pageToken) {
    var q = buildQuery(spec);
    if (!q) return Promise.resolve({ items: [], hasMore: false, nextPageToken: '' });
    var limit = Math.max(1, Math.min(Number(max) || 8, 20));
    var path = '/messages?maxResults=' + limit + '&q=' + encodeURIComponent(q) +
      (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    return api(path, token, fetchImpl).then(function (list) {
      var messages = list.messages || [];
      return Promise.all(messages.map(function (m) {
        return api('/messages/' + encodeURIComponent(m.id) +
          '?format=metadata&metadataHeaders=Subject&metadataHeaders=Date', token, fetchImpl);
      })).then(function (full) {
        var items = full.map(summarizeMessage).filter(Boolean);
        items.sort(function (x, y) { return y.date - x.date; });
        return { items: items, hasMore: !!list.nextPageToken, nextPageToken: list.nextPageToken || '' };
      });
    });
  }

  // Appends an older page to the rows already shown: no duplicates, still newest first.
  function mergeItems(existing, more) {
    var seen = {};
    var out = [];
    (existing || []).concat(more || []).forEach(function (it) {
      if (!it || seen[it.id]) return;
      seen[it.id] = true;
      out.push(it);
    });
    out.sort(function (x, y) { return y.date - x.date; });
    return out;
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
    MAX_KEYWORDS_PER_CARD: MAX_KEYWORDS_PER_CARD,
    normalizeKeyword: normalizeKeyword,
    cleanKeywordList: cleanKeywordList,
    normalizeLabel: normalizeLabel,
    labelTerm: labelTerm,
    cleanSpec: cleanSpec,
    hasSource: hasSource,
    sharedIgnored: sharedIgnored,
    describe: describe,
    listLabels: listLabels,
    labelKnown: labelKnown,
    normalizeEmail: normalizeEmail,
    cleanEmailList: cleanEmailList,
    extractEmails: extractEmails,
    buildQuery: buildQuery,
    threadUrl: threadUrl,
    searchUrl: searchUrl,
    decodeRfc2047: decodeRfc2047,
    summarizeMessage: summarizeMessage,
    getProfile: getProfile,
    recentInteractions: recentInteractions,
    mergeItems: mergeItems,
    formatDate: formatDate
  };
});
