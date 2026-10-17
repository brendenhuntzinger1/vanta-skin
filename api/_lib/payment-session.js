const { createHash, randomBytes } = require('node:crypto');

// Short-lived payment sessions bind one Labs order/amount to one browser
// tokenization + charge attempt. The raw token is a 256-bit bearer credential
// returned to the Vanta Labs backend exactly once; only its SHA-256 hash is
// stored server-side.

const TOKEN_PREFIX = 'vps_';
const TOKEN_RE = /^vps_[0-9a-f]{64}$/;
const SESSION_ID_RE = /^[0-9a-f]{24}$/;

function generatePaymentSessionToken() {
  return TOKEN_PREFIX + randomBytes(32).toString('hex');
}

function assertPaymentSessionTokenShape(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
    throw new Error('Invalid payment session token');
  }
}

function hashPaymentSessionToken(token) {
  return createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

// Public, non-secret handle that both the Vanta Labs checkout (parent) and the
// Vanta Skin payment iframe can derive from the token. Every postMessage in
// the embed protocol carries it so both sides can bind a message to the exact
// session they are participating in.
function paymentSessionIdFromToken(token) {
  return hashPaymentSessionToken(token).slice(0, 24);
}

// Strict origin parsing: https only, no credentials, no path/query/hash.
// Returns the normalized lowercase origin or null.
function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.pathname !== '/' || url.search || url.hash) return null;

  return url.origin.toLowerCase();
}

// Exact-match allowlist. Substring/suffix tricks such as
// "https://vantalabsresearch.com.evil.test" never match.
function isAllowedEmbedOrigin(allowedOrigins, origin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  return (allowedOrigins || []).includes(normalized);
}

function buildFrameAncestors(allowedOrigins) {
  const origins = (allowedOrigins || []).map(normalizeOrigin).filter(Boolean);
  if (!origins.length) return "frame-ancestors 'none'";
  return `frame-ancestors ${origins.join(' ')}`;
}

function sessionError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode || 400;
  return err;
}

// Validates a payment_sessions row against a charge request. The charge must
// carry the exact order, amount and storefront the Vanta Labs backend signed
// when it created the session; any drift means the charge is rejected.
function assertSessionMatchesCharge(record, { orderId, amountCents, originStorefront }, now = new Date()) {
  if (!record) throw sessionError('Unknown payment session', 400);

  if (record.consumed_at) {
    throw sessionError('Payment session has already been used', 409);
  }

  const expiresAt = new Date(record.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    throw sessionError('Payment session has expired', 400);
  }

  if (String(record.order_id) !== String(orderId)) {
    throw sessionError('Payment session order mismatch', 400);
  }

  if (Number(record.amount_cents) !== Number(amountCents)) {
    throw sessionError('Payment session amount mismatch', 400);
  }

  if (String(record.origin_storefront || '').toLowerCase() !== String(originStorefront || '').toLowerCase()) {
    throw sessionError('Payment session storefront mismatch', 400);
  }

  return record;
}

// Strict validation of postMessage payloads exchanged between the Vanta Labs
// checkout and the Vanta Skin payment iframe. Origin is always checked
// separately against event.origin; this validates payload shape and binds the
// message to one session.
function isValidEmbedMessage(data, { type, sessionId }) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (!type || data.type !== type) return false;
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return false;
  if (data.sessionId !== sessionId) return false;
  return true;
}

// Explicit-field response builder for the browser-facing session validation
// endpoint. Only public, per-session values are ever returned; processor
// secrets (transaction key, signature key, Supabase keys, HMAC secrets) can
// never leak through this payload even if the config object carries them.
function buildPublicSessionPayload(record, authnetConfig, clientKey) {
  return {
    ok: true,
    sessionId: String(record.token_hash || '').slice(0, 24),
    orderId: record.order_id,
    amountCents: record.amount_cents,
    currency: record.currency,
    embedOrigin: record.parent_origin,
    expiresAt: record.expires_at,
    authnet: {
      apiLoginId: authnetConfig.apiLoginId,
      clientKey: String(clientKey || ''),
      sandbox: !!authnetConfig.sandbox,
    },
  };
}

module.exports = {
  TOKEN_RE,
  SESSION_ID_RE,
  assertPaymentSessionTokenShape,
  assertSessionMatchesCharge,
  buildFrameAncestors,
  buildPublicSessionPayload,
  generatePaymentSessionToken,
  hashPaymentSessionToken,
  isAllowedEmbedOrigin,
  isValidEmbedMessage,
  normalizeOrigin,
  paymentSessionIdFromToken,
};
