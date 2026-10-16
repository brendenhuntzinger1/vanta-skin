const { randomUUID } = require('node:crypto');
const { canonicalMessage, digestHex, signHmac } = require('./security');

function buildSyncEventKey({ source, action, eventId, idempotencyKey, orderId, transactionId, paymentStatus }) {
  if (source === 'webhook' && eventId) return `webhook:${eventId}`;
  return ['bridge', action || 'unknown', idempotencyKey || 'none', orderId || 'none', transactionId || 'none', paymentStatus || 'unknown'].join(':');
}

function assertLabsSyncConfigured(config) {
  return !!(config.labsSync.endpointUrl && config.labsSync.outboundKeyId && config.labsSync.outboundSharedSecret);
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
    signal: AbortSignal.timeout(labsSync.timeoutMs || 8000),
  });
  const parsed = await res.json().catch(() => null);
  return { status: res.status, body: parsed };
}

async function deliverSyncEvent(config, eventPayload) {
  const previousAttempts = Number(eventPayload.deliveryAttemptCount || 0);
  if (!assertLabsSyncConfigured(config)) {
    return {
      delivered: false,
      deliveryAttemptCount: previousAttempts,
      httpStatus: null,
      error: 'Labs sync endpoint not configured',
      skipped: true,
    };
  }

  try {
    const res = await signedLabsPost(config.labsSync, eventPayload);
    if (res.status < 200 || res.status >= 300) {
      return {
        delivered: false,
        deliveryAttemptCount: previousAttempts + 1,
        httpStatus: res.status,
        error: `Sync callback failed with status ${res.status}`,
      };
    }
    return {
      delivered: true,
      deliveryAttemptCount: previousAttempts + 1,
      httpStatus: res.status,
      error: null,
    };
  } catch (error) {
    return {
      delivered: false,
      deliveryAttemptCount: previousAttempts + 1,
      httpStatus: null,
      error: error?.message || 'Sync callback failed',
    };
  }
}

module.exports = {
  assertLabsSyncConfigured,
  buildSyncEventKey,
  deliverSyncEvent,
  signedLabsPost,
};
