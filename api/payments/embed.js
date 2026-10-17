const { loadConfig } = require('../_lib/config');
const { buildEmbedCsp, renderEmbedPage } = require('../_lib/embed-page');
const { methodNotAllowed, setJson } = require('../_lib/http');
const { TOKEN_RE } = require('../_lib/payment-session');

// Serves the hosted payment component that the Vanta Labs checkout iframes.
//
// Embedding is restricted two ways:
//  - CSP frame-ancestors carries only the approved Vanta Labs origins.
//  - The component itself validates the embedding origin server-side via the
//    per-session parent_origin and refuses to message any other origin.
//
// X-Frame-Options is intentionally not sent: it cannot express a cross-origin
// allowlist, and CSP frame-ancestors supersedes it in every modern browser.
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(req, res, ['GET']);

  try {
    // The session token normally arrives in the URL fragment, which the
    // browser never sends here: the page is static and the frame validates the
    // token itself (POST /api/payments/session-validate). A token in the query
    // string (links issued before the change) is still shape-checked.
    const url = new URL(req.url, 'https://localhost');
    const token = url.searchParams.get('session');
    if (token !== null && !TOKEN_RE.test(token)) {
      return setJson(res, 400, { ok: false, error: 'Invalid payment session' });
    }

    const config = loadConfig();
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-security-policy', buildEmbedCsp(config.bridge.allowedEmbedOrigins));
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    res.end(renderEmbedPage());
  } catch (error) {
    try {
      console.error(JSON.stringify({ service: 'payment-bridge', event: 'embed_error', code: error?.code || null, message: error?.message || null }));
    } catch {
      // ignore
    }
    return setJson(res, 503, { ok: false, error: 'Secure card entry is temporarily unavailable' });
  }
};
