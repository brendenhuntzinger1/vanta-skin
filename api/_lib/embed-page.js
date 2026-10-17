const { createHash } = require('node:crypto');
const { buildFrameAncestors } = require('./payment-session');

// The hosted payment component served by GET /api/payments/embed.
//
// The HTML is fully static: the session token is read from the query string
// inside the iframe and every per-session value arrives via the
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

const EMBED_SCRIPT = `(function () {
  'use strict';

  var SESSION_ID_RE = /^[0-9a-f]{24}$/;
  var TOKEN_RE = /^vps_[0-9a-f]{64}$/;

  var cfg = null;
  var acceptLoading = null;
  var busy = false;

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

  function loadAcceptJs(sandbox) {
    if (window.Accept) return Promise.resolve(window.Accept);
    if (acceptLoading) return acceptLoading;
    acceptLoading = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = sandbox
        ? 'https://jstest.authorize.net/v1/Accept.js'
        : 'https://js.authorize.net/v1/Accept.js';
      script.async = true;
      script.onload = function () { resolve(window.Accept); };
      script.onerror = function () { acceptLoading = null; reject(new Error('Unable to load the secure payment library')); };
      document.head.appendChild(script);
    });
    return acceptLoading;
  }

  function readCard() {
    return {
      cardNumber: document.getElementById('card-number').value.trim(),
      month: document.getElementById('card-exp-month').value.trim(),
      year: document.getElementById('card-exp-year').value.trim(),
      cardCode: document.getElementById('card-code').value.trim(),
      zip: document.getElementById('card-zip').value.trim()
    };
  }

  function clearCard() {
    ['card-number', 'card-exp-month', 'card-exp-year', 'card-code', 'card-zip'].forEach(function (id) {
      document.getElementById(id).value = '';
    });
  }

  function tokenize() {
    if (!cfg || busy) return;
    busy = true;
    status('Encrypting card details…', false);

    loadAcceptJs(cfg.authnet.sandbox)
      .then(function () {
        return new Promise(function (resolve, reject) {
          window.Accept.dispatchData({
            authData: {
              apiLoginID: cfg.authnet.apiLoginId,
              clientKey: cfg.authnet.clientKey
            },
            cardData: readCard()
          }, function (response) {
            if (response.messages.resultCode === 'Error') {
              var first = response.messages.message && response.messages.message[0];
              var err = new Error('Card tokenization failed');
              err.code = first && typeof first.code === 'string' ? first.code : null;
              reject(err);
              return;
            }
            resolve(response.opaqueData);
          });
        });
      })
      .then(function (opaqueData) {
        // Raw card data never leaves this iframe: only the Authorize.net
        // opaqueData token is sent to the parent checkout.
        clearCard();
        busy = false;
        status('', false);
        postToParent({ type: 'vanta:pay:tokenized', sessionId: cfg.sessionId, opaqueData: opaqueData });
      })
      .catch(function (error) {
        busy = false;
        status('', false);
        // The parent shows the shopper its own sentence for this code.
        postToParent({ type: 'vanta:pay:error', sessionId: cfg.sessionId, code: error.code || null });
      });
  }

  function onParentMessage(event) {
    // Strict validation: exact origin approved server-side for this session,
    // exact message type, and the message must carry this session's id.
    if (!cfg || event.origin !== cfg.embedOrigin) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type !== 'vanta:pay:submit') return;
    if (typeof data.sessionId !== 'string' || !SESSION_ID_RE.test(data.sessionId)) return;
    if (data.sessionId !== cfg.sessionId) return;
    tokenize();
  }

  function init() {
    var token = new URLSearchParams(window.location.search).get('session') || '';
    if (!TOKEN_RE.test(token)) {
      status('This payment session link is invalid.', true);
      return;
    }

    fetch('/api/payments/session-validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionToken: token })
    })
      .then(function (res) { return res.json().then(function (json) { return { status: res.status, json: json }; }); })
      .then(function (result) {
        if (result.status !== 200 || !result.json.ok) {
          throw new Error(result.json.error || 'This payment session is no longer valid.');
        }
        cfg = result.json;
        document.getElementById('pay-form').hidden = false;
        status('', false);
        window.addEventListener('message', onParentMessage);
        postToParent({ type: 'vanta:pay:ready', sessionId: cfg.sessionId });
      })
      .catch(function (error) {
        status(error.message, true);
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

// CSP for the hosted component: no framing by anyone except the approved
// Vanta Labs origins, scripts limited to the hashed inline bootstrap and the
// Authorize.net Accept.js CDN, connections limited to this origin (session
// validation) and the Authorize.net tokenization API.
function buildEmbedCsp(allowedOrigins) {
  return [
    "default-src 'none'",
    `script-src ${cspHash(EMBED_SCRIPT)} https://jstest.authorize.net https://js.authorize.net`,
    `style-src ${cspHash(EMBED_STYLE)}`,
    // Accept.js fetches its own core library from the js hosts to check its
    // integrity before use, then posts card data to the api hosts.
    "connect-src 'self' https://apitest.authorize.net https://api.authorize.net https://jstest.authorize.net https://js.authorize.net",
    "img-src 'none'",
    "font-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    buildFrameAncestors(allowedOrigins),
  ].join('; ');
}

function renderEmbedPage() {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Secure card details</title>',
    `<style>${EMBED_STYLE}</style>`,
    '</head>',
    '<body>',
    '<form id="pay-form" hidden novalidate>',
    '<div><label for="card-number">Card number</label><input id="card-number" inputmode="numeric" autocomplete="cc-number" required></div>',
    '<div class="row">',
    '<div><label for="card-exp-month">Exp month (MM)</label><input id="card-exp-month" inputmode="numeric" maxlength="2" autocomplete="cc-exp-month" required></div>',
    '<div><label for="card-exp-year">Exp year (YYYY)</label><input id="card-exp-year" inputmode="numeric" maxlength="4" autocomplete="cc-exp-year" required></div>',
    '</div>',
    '<div class="row">',
    '<div><label for="card-code">Security code</label><input id="card-code" inputmode="numeric" autocomplete="cc-csc" required></div>',
    '<div><label for="card-zip">Billing ZIP</label><input id="card-zip" inputmode="numeric" autocomplete="postal-code" required></div>',
    '</div>',
    '<button class="sr-submit" type="submit" tabindex="-1" aria-hidden="true">Pay</button>',
    '</form>',
    '<p id="pay-status" class="status muted" role="status">Loading secure payment…</p>',
    `<script>${EMBED_SCRIPT}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

module.exports = {
  EMBED_SCRIPT,
  EMBED_STYLE,
  buildEmbedCsp,
  renderEmbedPage,
};
