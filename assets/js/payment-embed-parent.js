/*
 * REFERENCE IMPLEMENTATION — for the Vanta Labs checkout page.
 *
 * This file is not loaded by any Vanta Skin page. It documents and implements
 * the parent side of the embedded payment component contract so the Vanta
 * Labs checkout can embed the Vanta Skin hosted payment iframe and receive an
 * Authorize.net opaqueData token without ever touching raw card data.
 *
 * Flow:
 *   1. Labs backend calls POST /api/payments/session (HMAC-signed) and gets
 *      { sessionToken, sessionId, expiresAt, embedUrl }.
 *   2. Labs checkout mounts this component with the embedUrl.
 *   3. When the shopper places the order, Labs calls submit(); the iframe
 *      tokenizes the card with Accept.js and posts back opaqueData.
 *   4. Labs checkout forwards { orderId, amountCents, opaqueData,
 *      paymentSession: sessionToken } to its own backend, which calls
 *      POST /api/payments/charge (HMAC-signed, idempotency key).
 *
 * Security rules implemented here:
 *   - event.origin must exactly equal the Vanta Skin origin (never "*").
 *   - every message must carry the exact sessionId for this mount.
 *   - opaqueData is forwarded, never logged or persisted in the browser.
 */
(function () {
  'use strict';

  var MESSAGE_TYPES = ['vanta:pay:ready', 'vanta:pay:tokenized', 'vanta:pay:error'];
  var SESSION_ID_RE = /^[0-9a-f]{24}$/;

  function deriveSessionId(sessionToken) {
    return window.crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(sessionToken))
      .then(function (hash) {
        return Array.from(new Uint8Array(hash))
          .map(function (b) { return b.toString(16).padStart(2, '0'); })
          .join('')
          .slice(0, 24);
      });
  }

  function isValidMessage(data, sessionId) {
    if (!data || typeof data !== 'object') return false;
    if (MESSAGE_TYPES.indexOf(data.type) === -1) return false;
    if (typeof data.sessionId !== 'string' || !SESSION_ID_RE.test(data.sessionId)) return false;
    return data.sessionId === sessionId;
  }

  /**
   * @param {object} options
   * @param {HTMLElement} options.container  Element the iframe is mounted into.
   * @param {string} options.embedUrl        Absolute embedUrl returned by the session endpoint.
   * @param {string} options.sessionToken    Raw session token (used only to derive the session id).
   * @param {string} options.skinOrigin      Exact Vanta Skin origin, e.g. "https://vanta.skin".
   * @param {function} options.onTokenized   Called with (opaqueData).
   * @param {function} [options.onReady]     Called when the component is ready.
   * @param {function} [options.onError]     Called with (Error).
   */
  function mount(options) {
    var skinOrigin;
    try {
      skinOrigin = new URL(options.skinOrigin).origin;
    } catch (err) {
      throw new Error('skinOrigin must be a valid absolute URL');
    }
    if (new URL(options.embedUrl).origin !== skinOrigin) {
      throw new Error('embedUrl must be served from the Vanta Skin origin');
    }

    return deriveSessionId(options.sessionToken).then(function (sessionId) {
      var iframe = document.createElement('iframe');
      iframe.src = options.embedUrl;
      iframe.title = 'Secure payment form';
      iframe.setAttribute('loading', 'eager');
      // If sandboxing is desired, it must include all of:
      // allow-scripts allow-forms allow-same-origin
      iframe.style.border = '0';
      iframe.style.width = '100%';
      iframe.style.minHeight = '260px';
      options.container.appendChild(iframe);

      function onMessage(event) {
        if (event.origin !== skinOrigin) return;
        if (!isValidMessage(event.data, sessionId)) return;

        if (event.data.type === 'vanta:pay:ready' && options.onReady) {
          options.onReady();
        } else if (event.data.type === 'vanta:pay:tokenized') {
          options.onTokenized(event.data.opaqueData);
        } else if (event.data.type === 'vanta:pay:error' && options.onError) {
          options.onError(new Error(event.data.message || 'Payment failed'));
        }
      }

      window.addEventListener('message', onMessage);

      return {
        submit: function submit() {
          if (!iframe.contentWindow) return;
          iframe.contentWindow.postMessage({ type: 'vanta:pay:submit', sessionId: sessionId }, skinOrigin);
        },
        destroy: function destroy() {
          window.removeEventListener('message', onMessage);
          iframe.remove();
        },
      };
    });
  }

  window.VantaPaymentEmbed = { mount: mount };
})();
