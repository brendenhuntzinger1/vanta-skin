const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalMessage,
  digestHex,
  signHmac,
  verifyRequestSignature,
} = require('../api/_lib/security');

function withMockedNow(epochSeconds, fn) {
  const original = Date.now;
  Date.now = () => epochSeconds * 1000;
  try {
    return fn();
  } finally {
    Date.now = original;
  }
}

function makeSignedRequest({ secret = 'shared-secret', timestamp = 1700000000, nonce = 'nonce-1', body = '{"a":1}', path = '/api/payments/charge?x=1' } = {}) {
  const bodyHash = digestHex(body);
  const message = canonicalMessage({
    method: 'POST',
    path: '/api/payments/charge',
    timestamp,
    nonce,
    bodyHash,
  });

  const signature = signHmac(secret, message);
  return {
    req: {
      method: 'POST',
      url: path,
      headers: {
        'x-vanta-key-id': 'labs-key',
        'x-vanta-timestamp': String(timestamp),
        'x-vanta-nonce': nonce,
        'x-vanta-signature': signature,
      },
    },
    config: {
      hmac: {
        maxSkewSeconds: 300,
        secrets: {
          'labs-key': secret,
        },
      },
    },
    rawBody: body,
  };
}

test('verifyRequestSignature accepts valid signature', () => {
  const { req, config, rawBody } = makeSignedRequest();
  const result = withMockedNow(1700000100, () => verifyRequestSignature(config, req, rawBody));

  assert.equal(result.keyId, 'labs-key');
  assert.equal(result.nonce, 'nonce-1');
  assert.equal(result.requestHash, digestHex(rawBody));
});

test('verifyRequestSignature rejects stale timestamp', () => {
  const { req, config, rawBody } = makeSignedRequest({ timestamp: 1700000000 });

  assert.throws(
    () => withMockedNow(1700001000, () => verifyRequestSignature(config, req, rawBody)),
    /outside the allowed skew window/,
  );
});

test('verifyRequestSignature rejects invalid signature', () => {
  const { req, config, rawBody } = makeSignedRequest();
  req.headers['x-vanta-signature'] = 'deadbeef';

  assert.throws(
    () => withMockedNow(1700000100, () => verifyRequestSignature(config, req, rawBody)),
    /Invalid HMAC signature/,
  );
});

test('verifyRequestSignature is path-sensitive (query string excluded)', () => {
  const { req, config, rawBody } = makeSignedRequest({ path: '/api/payments/charge?retry=1' });
  assert.doesNotThrow(() => withMockedNow(1700000100, () => verifyRequestSignature(config, req, rawBody)));

  req.url = '/api/payments/refund?retry=1';
  assert.throws(() => withMockedNow(1700000100, () => verifyRequestSignature(config, req, rawBody)), /Invalid HMAC signature/);
});
