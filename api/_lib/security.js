const { createHmac, createHash, timingSafeEqual } = require('node:crypto');

function toBuffer(str) {
  return Buffer.from(String(str), 'utf8');
}

function digestHex(raw) {
  return createHash('sha256').update(raw || '', 'utf8').digest('hex');
}

function canonicalMessage({ method, path, timestamp, nonce, bodyHash }) {
  return [String(method || '').toUpperCase(), String(path || ''), String(timestamp || ''), String(nonce || ''), String(bodyHash || '')].join('\n');
}

function signHmac(secret, message) {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

function safeEqualHex(a, b) {
  const aBuffer = toBuffer(String(a || '').toLowerCase());
  const bBuffer = toBuffer(String(b || '').toLowerCase());
  if (aBuffer.length !== bBuffer.length) return false;
  return timingSafeEqual(aBuffer, bBuffer);
}

function verifyRequestSignature(config, req, rawBody) {
  const keyId = req.headers['x-vanta-key-id'];
  const timestamp = req.headers['x-vanta-timestamp'];
  const nonce = req.headers['x-vanta-nonce'];
  const signature = req.headers['x-vanta-signature'];

  if (!keyId || !timestamp || !nonce || !signature) {
    throw new Error('Missing HMAC authentication headers');
  }

  const tsSeconds = Number(timestamp);
  if (!Number.isFinite(tsSeconds)) throw new Error('Invalid request timestamp');

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsSeconds) > config.hmac.maxSkewSeconds) {
    throw new Error('Request timestamp is outside the allowed skew window');
  }

  const sharedSecret = config.hmac.secrets[String(keyId)];
  if (!sharedSecret) throw new Error('Unknown HMAC key id');

  const bodyHash = digestHex(rawBody);
  const message = canonicalMessage({
    method: req.method,
    path: req.url.split('?')[0],
    timestamp: tsSeconds,
    nonce,
    bodyHash,
  });

  const expected = signHmac(sharedSecret, message);
  if (!safeEqualHex(expected, signature)) {
    throw new Error('Invalid HMAC signature');
  }

  return {
    keyId: String(keyId),
    nonce: String(nonce),
    requestHash: bodyHash,
    timestamp: tsSeconds,
  };
}

function verifyWebhookSignature(signatureKey, payload, headerValue) {
  // Fail closed: with no signature key there is nothing to prove a webhook
  // came from Authorize.net, so none is accepted.
  if (!signatureKey || !headerValue) return false;

  // Authorize.Net signs webhooks with the Signature Key's text as the HMAC
  // key. The hex-decoded form (used for transHashSha2) is accepted too, so a
  // key in either convention verifies; both forms are the same secret.
  const incoming = String(headerValue).replace(/^sha512=/i, '').toLowerCase();
  const keys = [signatureKey];
  if (/^[A-Fa-f0-9]+$/.test(signatureKey) && signatureKey.length % 2 === 0) keys.push(Buffer.from(signatureKey, 'hex'));
  return keys.some((key) => safeEqualHex(createHmac('sha512', key).update(payload, 'utf8').digest('hex'), incoming));
}

module.exports = {
  canonicalMessage,
  digestHex,
  safeEqualHex,
  signHmac,
  verifyRequestSignature,
  verifyWebhookSignature,
};
