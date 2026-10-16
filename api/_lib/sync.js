const { randomUUID } = require('node:crypto');
const { canonicalMessage, digestHex, signHmac } = require('./security');

const MAX_DELIVERY_ATTEMPTS = 15;
const BASE_BACKOFF_MS = 60 * 1000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
// A freshly queued event is delivered inline by the request that created it;
// the retry job leaves it alone for this long so the two do not race.
const INLINE_GRACE_MS = 60 * 1000;

// bridge:<action>:<idempotencyKey>:<transId|none>:<outcome>
// webhook:<notificationId>
function buildSyncEventKey({ source, action, eventId, idempotencyKey, transactionId, outcome }) {
  if (source === 'webhook' && eventId) return `webhook:${eventId}`;
  return ['bridge', action || 'unknown', idempotencyKey || 'none', transactionId || 'none', outcome || 'unknown'].join(':');
}

function assertLabsSyncConfigured(config) {
  return !!(config.labsSync.endpointUrl && config.labsSync.outboundKeyId && config.labsSync.outboundSharedSecret);
}

// 1m, 2m, 4m, 8m … capped at 6h. `attempts` is the number of failed attempts
// so far (≥ 1).
function backoffMs(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(BASE_BACKOFF_MS * 2 ** (n - 1), MAX_BACKOFF_MS);
}

// One signed POST to the Labs callback endpoint, shared by payment-status
// delivery and the health check's ping so both sign identically. Resolves to
// { status, body } (body null when it is not JSON); rejects on network failure
// or timeout.
async function signedLabsPost(labsSync, payload) {
  const endpoint = new URL(labsSync.endpointUrl);
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomUUID();
  const message = canonicalMessage({
    method: 'POST',
    path: endpoint.pathname,
    timestamp,
    nonce,
    bodyHash: digestHex(body),
  });

  const headers = {
    'content-type': 'application/json',
    'x-vanta-key-id': labsSync.outboundKeyId,
    'x-vanta-timestamp': String(timestamp),
    'x-vanta-nonce': nonce,
    'x-vanta-signature': signHmac(labsSync.outboundSharedSecret, message),
    'x-idempotency-key': String(payload.eventId || ''),
  };
  // Gets the callback past Vercel Deployment Protection on a Labs preview,
  // which otherwise answers with a 302 to Vercel's SSO page. A header, not a
  // query string, so the secret stays out of access logs. Labs still checks
  // the HMAC signature.
  if (labsSync.protectionBypass) {
    headers['x-vercel-protection-bypass'] = labsSync.protectionBypass;
  }

  const res = await fetch(labsSync.endpointUrl, {
    method: 'POST',
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(labsSync.timeoutMs || 4000),
  });
  const parsed = await res.json().catch(() => null);
  return { status: res.status, body: parsed };
}

// One delivery attempt. Labs answers 2xx = processed (or already processed),
// 422 = permanently rejected, anything else = try again later.
async function deliverSyncEvent(config, eventPayload, { previousAttempts = 0, post = signedLabsPost } = {}) {
  const prior = Number(previousAttempts || 0);
  if (!assertLabsSyncConfigured(config)) {
    return {
      delivered: false,
      permanent: false,
      deliveryAttemptCount: prior,
      httpStatus: null,
      error: 'Labs sync endpoint not configured',
      skipped: true,
    };
  }

  try {
    const res = await post(config.labsSync, eventPayload);
    if (res.status >= 200 && res.status < 300) {
      return { delivered: true, permanent: false, deliveryAttemptCount: prior + 1, httpStatus: res.status, error: null };
    }
    return {
      delivered: false,
      permanent: res.status === 422,
      deliveryAttemptCount: prior + 1,
      httpStatus: res.status,
      error: `Sync callback failed with status ${res.status}`,
    };
  } catch (error) {
    return {
      delivered: false,
      permanent: false,
      deliveryAttemptCount: prior + 1,
      httpStatus: null,
      error: error?.name === 'TimeoutError' ? 'Sync callback timed out' : 'Sync callback request failed',
    };
  }
}

// Turns an attempt into the outbox row's next state.
function planNextDelivery(attempt, now = new Date()) {
  const base = {
    delivery_attempt_count: attempt.deliveryAttemptCount,
    last_delivery_http_status: attempt.httpStatus || null,
    last_delivery_error: attempt.error || null,
  };
  const nowMs = new Date(now).getTime();
  if (attempt.delivered) {
    return { ...base, delivery_status: 'delivered', next_attempt_at: new Date(nowMs).toISOString() };
  }
  if (attempt.permanent) {
    return { ...base, delivery_status: 'dead', next_attempt_at: new Date(nowMs).toISOString(), last_delivery_error: `Labs rejected the event permanently (HTTP ${attempt.httpStatus})` };
  }
  if (attempt.deliveryAttemptCount >= MAX_DELIVERY_ATTEMPTS) {
    return { ...base, delivery_status: 'dead', next_attempt_at: new Date(nowMs).toISOString(), last_delivery_error: `Gave up after ${attempt.deliveryAttemptCount} attempts: ${attempt.error || 'unknown error'}` };
  }
  return {
    ...base,
    delivery_status: 'failed',
    next_attempt_at: new Date(nowMs + backoffMs(attempt.deliveryAttemptCount)).toISOString(),
  };
}

module.exports = {
  BASE_BACKOFF_MS,
  INLINE_GRACE_MS,
  MAX_BACKOFF_MS,
  MAX_DELIVERY_ATTEMPTS,
  assertLabsSyncConfigured,
  backoffMs,
  buildSyncEventKey,
  deliverSyncEvent,
  planNextDelivery,
  signedLabsPost,
};
