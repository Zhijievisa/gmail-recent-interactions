/* Fallback sign-in window, opened by t.authorize() from the card section when the in-card pop-up fails. */
(function () {
  'use strict';

  var CFG = window.GRI_CONFIG || {};
  var SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
  var btn = document.getElementById('go');
  var msg = document.getElementById('msg');
  var client = null;

  function say(text) {
    msg.textContent = text;
    msg.hidden = !text;
  }

  function handBack(payload) {
    try {
      if (window.opener && typeof window.opener.authorize === 'function') {
        window.opener.authorize(payload);
        say('Connected. This window will close.');
        setTimeout(function () { window.close(); }, 600);
        return;
      }
    } catch (e) { /* opener not reachable */ }
    say('Signed in, but this window could not hand the session back to Trello. Close it, reopen the card and try again.');
  }

  window.griGisLoaded = function () {
    var cfg = {
      client_id: CFG.GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: function (resp) {
        if (!resp || resp.error || !resp.access_token) {
          return say('Google sign-in was not completed' + (resp && resp.error ? ' (' + resp.error + ').' : '.'));
        }
        if (!window.google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE)) {
          return say('Gmail read permission was not granted. Sign in again and tick the Gmail box.');
        }
        handBack(JSON.stringify({ access_token: resp.access_token, expires_in: resp.expires_in }));
      },
      error_callback: function (err) {
        say(err && err.type === 'popup_failed_to_open'
          ? 'Your browser blocked the Google pop-up. Allow pop-ups for this site and try again.'
          : 'Google sign-in did not complete.');
      }
    };
    if (CFG.WORKSPACE_DOMAIN) cfg.hd = CFG.WORKSPACE_DOMAIN;
    client = window.google.accounts.oauth2.initTokenClient(cfg);
    btn.disabled = false;
  };

  window.griGisFailed = function () {
    say('Could not load Google sign-in. Check your connection or any script blocker.');
  };

  btn.addEventListener('click', function () {
    say('');
    if (client) client.requestAccessToken();
  });
})();
