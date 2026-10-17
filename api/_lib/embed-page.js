const { createHash } = require('node:crypto');
const { buildFrameAncestors, normalizeOrigin } = require('./payment-session');

// The hosted payment component served by GET /api/payments/embed.
//
// The HTML is fully static: the session token is read from the URL fragment
// (#session=…) inside the iframe and every per-session value arrives via the
// session-validate endpoint, so nothing is ever interpolated into this page
// and there is no template-injection surface. The inline script and style are
// locked into the Content-Security-Policy with SHA-256 hashes computed from
// these exact strings at request time.

const EMBED_STYLE = [
  // Matches the Vanta Labs checkout fields (light theme): soft fill, pill
  // shape, muted labels, 16px text so iOS Safari does not zoom.
  'body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:4px 2px;color:#121212;background:#fff}',
  'label{display:block;font-size:12px;font-weight:500;color:#6B665E;margin:10px 4px 6px}',
  'input{box-sizing:border-box;width:100%;padding:12px 16px;border:1px solid #E7E2D9;border-radius:999px;background:#F5F2EC;font-size:16px;color:#121212;outline:none}',
  'input:focus{border-color:#121212;background:#fff}',
  '.row{display:flex;gap:10px}.row>div{flex:1}',
  '.sr-submit{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}',
  '.status{font-size:12px;margin:8px 4px 0;min-height:16px}',
  '.error{color:#a33}.muted{color:#6B665E}',
].join('');

// The frame's half of the Labs pay-page contract:
//  - vanta:pay:ready    { type, sessionId }        session-validate succeeded
//                                                  AND Accept.dispatchData exists
//  - vanta:pay:failed   { type, sessionId, code }  VS_SCRIPT_LOAD, VS_SESSION,
//                                                  VS_UNAVAILABLE; the frame
//                                                  cannot start or can no
//                                                  longer work
//  - vanta:pay:error    { type, sessionId, code }  Accept.js E_WC_* codes,
//                                                  VS_POSTAL, VS_TOKENIZE_TIMEOUT,
//                                                  VS_SCRIPT_LOAD (submit with
//                                                  no Accept.js)
//  - vanta:pay:tokenized { type, sessionId, opaqueData }
// sessionId is the first 24 hex characters of SHA-256(token), which Labs
// derives too. No message ever carries card data, the token or server text.
//
// Inside this template literal a backslash escape is consumed by JavaScript
// before the browser sees the script (\d becomes d), so the script uses no
// backslashes: character classes are written [0-9] and so on.
const EMBED_SCRIPT = `(function () {
  'use strict';

  var SESSION_ID_RE = /^[0-9a-f]{24}$/;
  var TOKEN_RE = /^vps_[0-9a-f]{64}$/;
  // Billing postal code: US ZIP (12345 or 12345-6789) or Canadian postal code
  // (A1A 1A1; no D, F, I, O, Q or U, and no W or Z first). The storefront
  // ships to the US and Canada only.
  var US_ZIP_RE = /^[0-9]{5}(-[0-9]{4})?$/;
  var CA_POSTAL_RE = /^([ABCEGHJ-NPRSTVXY][0-9][ABCEGHJ-NPRSTV-Z])[ -]?([0-9][ABCEGHJ-NPRSTV-Z][0-9])$/;
  var CARD_SPACES_RE = /[ ]/g;
  // Accept.js is only usable once AcceptCore.js, which the loader fetches
  // itself after its own onload, has announced readiness (window.isReady);
  // until then dispatchData is a stub that answers E_WC_03. The frame answers
  // every press before the Labs page's own 30-second tokenize timeout.
  var ACCEPT_READY_TIMEOUT_MS = 15000;
  var TOKENIZE_TIMEOUT_MS = 20000;

  var cfg = null;
  // idle -> loading -> ready | failed. A failed load is reported once
  // (vanta:pay:failed); a later press tries the loader again.
  var acceptState = 'idle';
  var acceptScript = null;
  var acceptGeneration = 0;
  var failedPosted = false;
  var busy = false;
  var tokenSessionId = Promise.resolve(null);

  var TEXT = {
    VS_SESSION: 'This secure payment session is no longer valid.',
    VS_UNAVAILABLE: 'Secure card entry is temporarily unavailable.',
    VS_SCRIPT_LOAD: 'The secure card form couldn’t load.'
  };

  function status(message, isError) {
    var el = document.getElementById('pay-status');
    el.textContent = message || '';
    el.className = 'status ' + (isError ? 'error' : 'muted');
  }

  function postToParent(message) {
    // Strict cross-origin messaging: every frame is targeted at the exact
    // server-approved Vanta Labs origin for this session, never a wildcard.
    if (!cfg || !cfg.embedOrigin) return;
    window.parent.postMessage(message, cfg.embedOrigin);
  }

  // The approved Labs origins, rendered by the server into a meta tag. Used
  // only when session-validate failed, so this session's own origin is
  // unknown: the message goes to each, and postMessage delivers it only to
  // the one that is really the parent.
  function approvedParentOrigins() {
    try {
      var meta = document.querySelector('meta[name="vanta-parent-origins"]');
      var list = JSON.parse((meta && meta.getAttribute('content')) || '[]');
      if (!Array.isArray(list)) return [];
      return list.filter(function (origin) {
        return typeof origin === 'string' && origin.indexOf('https://') === 0;
      });
    } catch (ignored) {
      return [];
    }
  }

  // The public session id Labs derives from the token: the first 24 hex
  // characters of its SHA-256. Null when Web Crypto is unavailable.
  function sessionIdFromToken(token) {
    try {
      var subtle = window.crypto && window.crypto.subtle;
      if (!subtle || typeof TextEncoder !== 'function') return Promise.resolve(null);
      return subtle.digest('SHA-256', new TextEncoder().encode(token)).then(function (digest) {
        var bytes = new Uint8Array(digest);
        var hex = '';
        for (var i = 0; i < 12; i++) hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
        return hex;
      }, function () { return null; });
    } catch (ignored) {
      return Promise.resolve(null);
    }
  }

  // Posted at most once: the frame cannot start, or can no longer work.
  function fail(code) {
    if (failedPosted) return;
    failedPosted = true;
    document.getElementById('pay-form').hidden = true;
    status(TEXT[code], true);
    if (cfg && cfg.embedOrigin) {
      postToParent({ type: 'vanta:pay:failed', sessionId: cfg.sessionId, code: code });
      return;
    }
    tokenSessionId.then(function (sessionId) {
      if (!sessionId) return;
      approvedParentOrigins().forEach(function (origin) {
        try {
          window.parent.postMessage({ type: 'vanta:pay:failed', sessionId: sessionId, code: code }, origin);
        } catch (ignored) {
          // A malformed origin is skipped.
        }
      });
    });
  }

  function acceptReady() {
    return !!(window.Accept && typeof window.Accept.dispatchData === 'function' && window.isReady === true);
  }

  // The loader fetches AcceptCore.js only once, so a load that failed is
  // thrown away whole and the next attempt starts again from the loader.
  function discardAcceptJs() {
    if (acceptScript && acceptScript.parentNode) acceptScript.parentNode.removeChild(acceptScript);
    acceptScript = null;
    window.Accept = undefined;
  }

  // Loaded as soon as the session is valid, so a blocked or slow library is
  // found before the shopper presses Pay, and ready means the card can
  // really be tokenized: window.isReady is polled for until the deadline.
  // Answers from a load that was given up on are ignored.
  function loadAcceptJs(sandbox) {
    var generation = ++acceptGeneration;
    acceptState = 'loading';
    function settle(ok) {
      if (generation !== acceptGeneration || acceptState !== 'loading') return;
      clearTimeout(deadline);
      if (ok) {
        acceptState = 'ready';
        document.getElementById('pay-form').hidden = false;
        status('', false);
        postToParent({ type: 'vanta:pay:ready', sessionId: cfg.sessionId });
        return;
      }
      acceptState = 'failed';
      discardAcceptJs();
      fail('VS_SCRIPT_LOAD');
    }
    var deadline = setTimeout(function () { settle(false); }, ACCEPT_READY_TIMEOUT_MS);
    function check() {
      if (generation !== acceptGeneration || acceptState !== 'loading') return;
      if (acceptReady()) {
        settle(true);
        return;
      }
      setTimeout(check, 50);
    }
    if (window.Accept) {
      check();
      return;
    }
    acceptScript = document.createElement('script');
    acceptScript.src = sandbox
      ? 'https://jstest.authorize.net/v1/Accept.js'
      : 'https://js.authorize.net/v1/Accept.js';
    acceptScript.async = true;
    acceptScript.onload = check;
    acceptScript.onerror = function () { settle(false); };
    document.head.appendChild(acceptScript);
  }

  // US ZIP as typed; Canadian postal code upper-cased as "A1A 1A1". Null when
  // it is neither, so it is never sent to Authorize.Net.
  function normalizePostal(value) {
    var v = String(value || '').trim().toUpperCase();
    if (US_ZIP_RE.test(v)) return v;
    var ca = CA_POSTAL_RE.exec(v);
    return ca ? ca[1] + ' ' + ca[2] : null;
  }

  function readCard() {
    return {
      // Shoppers type the number in groups; Accept.js wants digits only.
      cardNumber: document.getElementById('card-number').value.replace(CARD_SPACES_RE, ''),
      month: document.getElementById('card-exp-month').value.trim(),
      year: document.getElementById('card-exp-year').value.trim(),
      cardCode: document.getElementById('card-code').value.trim(),
      zip: normalizePostal(document.getElementById('card-zip').value)
    };
  }

  function clearCard() {
    ['card-number', 'card-exp-month', 'card-exp-year', 'card-code', 'card-zip'].forEach(function (id) {
      document.getElementById(id).value = '';
    });
  }

  function postError(code) {
    postToParent({ type: 'vanta:pay:error', sessionId: cfg.sessionId, code: code });
  }

  function tokenize() {
    if (!cfg || busy) return;
    if (acceptState !== 'ready' || !acceptReady()) {
      // Not a card problem: the parent shows "the secure card form couldn't
      // load" for this code, never "check your card details". After a failed
      // load the press also starts the loader again; ready follows if it
      // works this time.
      postError('VS_SCRIPT_LOAD');
      if (acceptState === 'failed') loadAcceptJs(cfg.authnet.sandbox);
      return;
    }
    var card = readCard();
    if (!card.zip) {
      // The parent shows its own sentence for this code; the card details
      // stay in the fields to be corrected.
      postError('VS_POSTAL');
      return;
    }
    busy = true;
    status('Encrypting card details…', false);

    // One answer per attempt: the callback or the guard, whichever is first.
    // A callback after the guard fired is dropped, token and all; the card
    // stays in the fields and the shopper presses Pay again.
    var settled = false;
    function finish() {
      if (settled) return false;
      settled = true;
      clearTimeout(guard);
      busy = false;
      status('', false);
      return true;
    }
    var guard = setTimeout(function () {
      if (finish()) postError('VS_TOKENIZE_TIMEOUT');
    }, TOKENIZE_TIMEOUT_MS);

    try {
      window.Accept.dispatchData({
        authData: {
          apiLoginID: cfg.authnet.apiLoginId,
          clientKey: cfg.authnet.clientKey
        },
        cardData: card
      }, function (response) {
        if (!finish()) return;
        var messages = response && response.messages;
        if (!messages || messages.resultCode === 'Error' || !response.opaqueData) {
          var first = messages && messages.message && messages.message[0];
          // The parent shows the shopper its own sentence for this code.
          postError(first && typeof first.code === 'string' ? first.code : null);
          return;
        }
        // Raw card data never leaves this iframe: only the Authorize.net
        // opaqueData token is sent to the parent checkout.
        clearCard();
        postToParent({ type: 'vanta:pay:tokenized', sessionId: cfg.sessionId, opaqueData: response.opaqueData });
      });
    } catch (ignored) {
      // The library itself is broken, which the card cannot fix.
      if (finish()) postError('VS_SCRIPT_LOAD');
    }
  }

  function onParentMessage(event) {
    // Strict validation: the window that framed this form (not merely any
    // window of the approved origin), the exact origin approved server-side
    // for this session, the exact message type, and this session's id.
    if (!cfg || event.source !== window.parent || event.origin !== cfg.embedOrigin) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type !== 'vanta:pay:submit') return;
    if (typeof data.sessionId !== 'string' || !SESSION_ID_RE.test(data.sessionId)) return;
    if (data.sessionId !== cfg.sessionId) return;
    tokenize();
  }

  // The token arrives in the URL fragment, which browsers never send to a
  // server (so it is in no request log or Referer). The query string is still
  // read for links issued before that change. Either way it is then removed
  // from this frame's address, where scripts on the page could read it.
  function readSessionToken() {
    var fromHash = new URLSearchParams(String(window.location.hash || '').slice(1)).get('session');
    var token = fromHash || new URLSearchParams(window.location.search).get('session') || '';
    try {
      window.history.replaceState(null, '', window.location.pathname);
    } catch (ignored) {
      // An address that cannot be rewritten still works.
    }
    return token;
  }

  function validateFailure(code) {
    var err = new Error(code);
    err.vantaCode = code;
    return err;
  }

  function init() {
    var token = readSessionToken();
    // With no token at all (the frame reloaded on its own) there is no
    // session to name, so nothing is posted; Labs' load timer covers it.
    if (token) tokenSessionId = sessionIdFromToken(token);
    if (!TOKEN_RE.test(token)) {
      fail('VS_SESSION');
      return;
    }

    fetch('/api/payments/session-validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionToken: token })
    })
      .then(function (res) {
        if (res.status >= 500) throw validateFailure('VS_UNAVAILABLE');
        if (res.status !== 200) throw validateFailure('VS_SESSION');
        return res.json();
      }, function () {
        throw validateFailure('VS_UNAVAILABLE');
      })
      .then(function (json) {
        if (!json || json.ok !== true) throw validateFailure('VS_SESSION');
        if (typeof json.sessionId !== 'string' || !SESSION_ID_RE.test(json.sessionId) ||
            typeof json.embedOrigin !== 'string' || !json.authnet) {
          throw validateFailure('VS_UNAVAILABLE');
        }
        cfg = json;
        document.getElementById('pay-form').hidden = false;
        window.addEventListener('message', onParentMessage);
        loadAcceptJs(cfg.authnet.sandbox);
      })
      .catch(function (error) {
        fail(error && error.vantaCode ? error.vantaCode : 'VS_UNAVAILABLE');
      });
  }

  // Enter in a card field asks the parent checkout to pay, so the checkout's
  // own Pay button and the keyboard take the same path.
  document.getElementById('pay-form').addEventListener('submit', function (event) {
    event.preventDefault();
    postToParent({ type: 'vanta:pay:submit-request', sessionId: cfg && cfg.sessionId });
  });

  init();
})();`;

function cspHash(source) {
  return `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`;
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The approved parent origins, outside the hash-pinned script so the script
// (and its CSP hash) stays the same whatever the allowlist holds. Only
// normalised https origins are rendered.
function parentOriginsMeta(allowedOrigins) {
  const origins = (allowedOrigins || []).map(normalizeOrigin).filter(Boolean);
  return `<meta name="vanta-parent-origins" content='${escapeAttribute(JSON.stringify(origins))}'>`;
}

// CSP for the hosted component: no framing by anyone except the approved
// Vanta Labs origins, scripts limited to the hashed inline bootstrap and the
// Authorize.net Accept.js CDN, connections limited to this origin (session
// validation) and the Authorize.net tokenization API.
//
// NOT VERIFIED: the real Accept.js has never run under this policy (every
// test so far stubs it). The connect-src hosts follow Authorize.Net's
// documentation (production Accept.js posts to api2.authorize.net, the
// sandbox to apitest.authorize.net) but whether the library also needs
// images, eval or further hosts is only known from a sandbox run with the
// real library. Do not widen this policy on speculation; widen it on what
// that run's CSP violation reports show.
function buildEmbedCsp(allowedOrigins) {
  return [
    "default-src 'none'",
    `script-src ${cspHash(EMBED_SCRIPT)} https://jstest.authorize.net https://js.authorize.net`,
    `style-src ${cspHash(EMBED_STYLE)}`,
    // Accept.js fetches its own core library from the js hosts to check its
    // integrity before use, then posts card data to the api hosts.
    "connect-src 'self' https://apitest.authorize.net https://api.authorize.net https://api2.authorize.net https://jstest.authorize.net https://js.authorize.net",
    "img-src 'none'",
    "font-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    buildFrameAncestors(allowedOrigins),
  ].join('; ');
}

function renderEmbedPage(allowedOrigins) {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    parentOriginsMeta(allowedOrigins),
    '<title>Secure card details</title>',
    `<style>${EMBED_STYLE}</style>`,
    '</head>',
    '<body>',
    // No name attributes, deliberately: if the script ever failed to stop a
    // native submit, a nameless form sends no card data in the URL.
    '<form id="pay-form" hidden novalidate>',
    // Up to 19 digits, typed in groups of four (19 digits + 4 spaces).
    '<div><label for="card-number">Card number</label><input id="card-number" inputmode="numeric" maxlength="23" autocomplete="cc-number" required></div>',
    '<div class="row">',
    '<div><label for="card-exp-month">Exp month (MM)</label><input id="card-exp-month" inputmode="numeric" maxlength="2" autocomplete="cc-exp-month" required></div>',
    '<div><label for="card-exp-year">Exp year (YYYY)</label><input id="card-exp-year" inputmode="numeric" maxlength="4" autocomplete="cc-exp-year" required></div>',
    '</div>',
    '<div class="row">',
    '<div><label for="card-code">Security code</label><input id="card-code" inputmode="numeric" maxlength="4" autocomplete="cc-csc" required></div>',
    '<div><label for="card-zip">Billing ZIP / postal code</label><input id="card-zip" inputmode="text" autocapitalize="characters" autocomplete="postal-code" maxlength="10" spellcheck="false" required></div>',
    '</div>',
    '<button class="sr-submit" type="submit" tabindex="-1" aria-hidden="true">Pay</button>',
    '</form>',
    '<p id="pay-status" class="status muted" role="status">Loading secure payment…</p>',
    `<script>${EMBED_SCRIPT}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

// The page GET /api/payments/embed serves when it cannot serve the card form
// (a malformed legacy link, or configuration the service cannot load). A
// short sentence for the shopper, never JSON or the internal reason. Its
// script tells the Labs page at once (vanta:pay:failed with `code`, to each
// approved parent origin, the same way the card form does when
// session-validate fails) instead of leaving it to wait out its load timer.
const EMBED_ERROR_STYLE = [
  'body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:16px 6px;color:#121212;background:#fff}',
  'p{font-size:14px;line-height:1.45;margin:0 0 6px}',
  '.muted{color:#6B665E;font-size:13px}',
].join('');

const EMBED_ERROR_SCRIPT = `(function () {
  'use strict';
  function read(name) {
    var meta = document.querySelector('meta[name="' + name + '"]');
    return (meta && meta.getAttribute('content')) || '';
  }
  var token = new URLSearchParams(String(window.location.hash || '').slice(1)).get('session') ||
    new URLSearchParams(window.location.search).get('session') || '';
  try {
    window.history.replaceState(null, '', window.location.pathname);
  } catch (ignored) {
    // An address that cannot be rewritten still works.
  }
  var code = read('vanta-failure-code');
  var origins;
  try {
    origins = JSON.parse(read('vanta-parent-origins') || '[]');
  } catch (ignored) {
    origins = [];
  }
  var subtle = window.crypto && window.crypto.subtle;
  if (!token || !code || !Array.isArray(origins) || !subtle || typeof TextEncoder !== 'function') return;
  subtle.digest('SHA-256', new TextEncoder().encode(token)).then(function (digest) {
    var bytes = new Uint8Array(digest);
    var sessionId = '';
    for (var i = 0; i < 12; i++) sessionId += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    origins.forEach(function (origin) {
      if (typeof origin !== 'string' || origin.indexOf('https://') !== 0) return;
      try {
        window.parent.postMessage({ type: 'vanta:pay:failed', sessionId: sessionId, code: code }, origin);
      } catch (ignored) {
        // A malformed origin is skipped.
      }
    });
  }, function () {});
})();`;

const EMBED_ERROR_TEXT = {
  VS_SESSION: 'This secure payment link is no longer valid.',
  VS_UNAVAILABLE: 'Secure card entry is temporarily unavailable.',
};

function buildEmbedErrorCsp(allowedOrigins) {
  return [
    "default-src 'none'",
    `script-src ${cspHash(EMBED_ERROR_SCRIPT)}`,
    `style-src ${cspHash(EMBED_ERROR_STYLE)}`,
    "img-src 'none'",
    "font-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    buildFrameAncestors(allowedOrigins),
  ].join('; ');
}

function renderEmbedErrorPage({ code, allowedOrigins }) {
  const failureCode = EMBED_ERROR_TEXT[code] ? code : 'VS_UNAVAILABLE';
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    parentOriginsMeta(allowedOrigins),
    `<meta name="vanta-failure-code" content='${failureCode}'>`,
    '<title>Secure card details</title>',
    `<style>${EMBED_ERROR_STYLE}</style>`,
    '</head>',
    '<body>',
    `<p role="alert">${EMBED_ERROR_TEXT[failureCode]}</p>`,
    '<p class="muted">Your card was not charged. Please reload the page to try again.</p>',
    `<script>${EMBED_ERROR_SCRIPT}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

module.exports = {
  EMBED_ERROR_SCRIPT,
  EMBED_ERROR_STYLE,
  EMBED_SCRIPT,
  EMBED_STYLE,
  buildEmbedCsp,
  buildEmbedErrorCsp,
  renderEmbedErrorPage,
  renderEmbedPage,
};
