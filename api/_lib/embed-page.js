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
  'body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:12px;color:#1c1a17;background:#fff}',
  'label{display:block;font-size:12px;font-weight:600;margin:8px 0 4px}',
  'input{box-sizing:border-box;width:100%;padding:8px;border:1px solid #c9c4bb;border-radius:6px;font-size:14px}',
  '.row{display:flex;gap:8px}.row>div{flex:1}',
  'button{margin-top:12px;width:100%;padding:10px;border:0;border-radius:6px;background:#1c1a17;color:#fff;font-size:14px;cursor:pointer}',
  'button[disabled]{opacity:.5;cursor:default}',
  '.status{font-size:12px;margin-top:8px;min-height:16px}',
  '.error{color:#a33}.muted{color:#6b675f}',
].join('');

const EMBED_SCRIPT = `(function () {
  'use strict';

  var SESSION_ID_RE = /^[0-9a-f]{24}$/;
  var TOKEN_RE = /^vps_[0-9a-f]{64}$/;

  var cfg = null;
  var acceptLoading = null;

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
      script.onerror = function () { reject(new Error('Unable to load the secure payment library')); };
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
    if (!cfg) return;
    var button = document.getElementById('pay-submit');
    button.disabled = true;
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
              var msg = (response.messages.message && response.messages.message[0] && response.messages.message[0].text) || 'Card tokenization failed';
              reject(new Error(msg));
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
        button.disabled = false;
        status('Card secured. You can place your order.', false);
        postToParent({ type: 'vanta:pay:tokenized', sessionId: cfg.sessionId, opaqueData: opaqueData });
      })
      .catch(function (error) {
        button.disabled = false;
        status(error.message, true);
        postToParent({ type: 'vanta:pay:error', sessionId: cfg.sessionId, message: error.message });
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
        document.getElementById('pay-amount').textContent = (cfg.amountCents / 100).toFixed(2) + ' ' + cfg.currency;
        document.getElementById('pay-form').hidden = false;
        status('', false);
        window.addEventListener('message', onParentMessage);
        postToParent({ type: 'vanta:pay:ready', sessionId: cfg.sessionId });
      })
      .catch(function (error) {
        status(error.message, true);
      });
  }

  document.getElementById('pay-form').addEventListener('submit', function (event) {
    event.preventDefault();
    tokenize();
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
    "connect-src 'self' https://apitest.authorize.net https://api.authorize.net",
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
    '<title>Vanta Skin Secure Payment</title>',
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
    '<button id="pay-submit" type="submit">Secure card for <span id="pay-amount"></span></button>',
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
