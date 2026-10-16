const { randomUUID } = require('node:crypto');
const { canonicalMessage, digestHex, signHmac } = require('./security');

function buildSyncEventKey({ source, action, eventId, idempotencyKey, orderId, transactionId, paymentStatus }) {
  if (source === 'webhook' && eventId) return `webhook:${eventId}`;
  return ['bridge', action || 'unknown', idempotencyKey || 'none', orderId || 'none', transactionId || 'none', paymentStatus || 'unknown'].join(':');
}

function assertLabsSyncConfigured(config) {
  return !!(config.labsSync.endpointUrl && config.labsSync.outboundKeyId && config.labsSync.outboundSharedSecret);
}

async function deliverSyncEvent(config, eventPayload) {
  if (!assertLabsSyncConfigured(config)) {
    return {
      delivered: false,
      deliveryAttemptCount: Number(eventPayload.deliveryAttemptCount || 0),
      httpStatus: null,
      error: 'Labs sync endpoint not configured',
      skipped: true,
    };
  }

  const endpoint = new URL(config.labsSync.endpointUrl);
  const body = JSON.stringify(eventPayload);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomUUID();
  const path = endpoint.pathname;
  const bodyHash = digestHex(body);
  const message = canonicalMessage({
    method: 'POST',
    path,
    timestamp,
    nonce,
    bodyHash,
  });
  const signature = signHmac(config.labsSync.outboundSharedSecret, message);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.labsSync.timeoutMs);

  try {
    const res = await fetch(config.labsSync.endpointUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vanta-key-id': config.labsSync.outboundKeyId,
        'x-vanta-timestamp': String(timestamp),
        'x-vanta-nonce': nonce,
        'x-vanta-signature': signature,
        'x-idempotency-key': eventPayload.eventId,
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    if (!res.ok) {
      return {
        delivered: false,
        deliveryAttemptCount: Number(eventPayload.deliveryAttemptCount || 0) + 1,
        httpStatus: res.status,
        error: `Sync callback failed with status ${res.status}`,
      };
    }

    return {
      delivered: true,
      deliveryAttemptCount: Number(eventPayload.deliveryAttemptCount || 0) + 1,
      httpStatus: res.status,
      error: null,
    };
  } catch (error) {
    clearTimeout(timeout);
    return {
      delivered: false,
      deliveryAttemptCount: Number(eventPayload.deliveryAttemptCount || 0) + 1,
      httpStatus: null,
      error: error?.message || 'Sync callback failed',
    };
  }
}

module.exports = {
  assertLabsSyncConfigured,
  buildSyncEventKey,
  deliverSyncEvent,
};
