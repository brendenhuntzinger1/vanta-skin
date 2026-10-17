const { loadConfig } = require('../_lib/config');
const { buildEmbedCsp, buildEmbedErrorCsp, renderEmbedErrorPage, renderEmbedPage } = require('../_lib/embed-page');
const { methodNotAllowed } = require('../_lib/http');
const { TOKEN_RE, normalizeOrigin } = require('../_lib/payment-session');

// Serves the hosted payment component that the Vanta Labs checkout iframes.
//
// Embedding is restricted two ways:
//  - CSP frame-ancestors carries only the approved Vanta Labs origins.
//  - The component itself validates the embedding origin server-side via the
//    per-session parent_origin and refuses to message any other origin.
//
// X-Frame-Options is intentionally not sent: it cannot express a cross-origin
// allowlist, and CSP frame-ancestors supersedes it in every modern browser.

// The allowlist for an error page when the full configuration cannot load
// (a missing database or HMAC variable must not stop the frame from telling
// the Labs page). Read the same way as config.js; any entry that is not a
// clean https origin means no one may frame the page.
function errorPageOrigins() {
  try {
    return loadConfig().bridge.allowedEmbedOrigins;
  } catch {
    const raw = process.env.VANTA_EMBED_ALLOWED_ORIGINS || 'https://vantalabsresearch.com';
    const origins = raw.split(',').map(normalizeOrigin);
    return origins.every(Boolean) ? origins : [];
  }
}

function sendHtml(res, statusCode, csp, html) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-security-policy', csp);
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(html);
}

// The iframe shows whatever this answers, so errors are a short page for the
// shopper (never JSON or the internal reason) that also tells the Labs page.
function sendError(res, statusCode, code) {
  const allowedOrigins = errorPageOrigins();
  return sendHtml(res, statusCode, buildEmbedErrorCsp(allowedOrigins), renderEmbedErrorPage({ code, allowedOrigins }));
}

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
      return sendError(res, 400, 'VS_SESSION');
    }

    const config = loadConfig();
    const origins = config.bridge.allowedEmbedOrigins;
    return sendHtml(res, 200, buildEmbedCsp(origins), renderEmbedPage(origins));
  } catch (error) {
    try {
      console.error(JSON.stringify({ service: 'payment-bridge', event: 'embed_error', code: error?.code || null, message: error?.message || null }));
    } catch {
      // ignore
    }
    return sendError(res, 503, 'VS_UNAVAILABLE');
  }
};
