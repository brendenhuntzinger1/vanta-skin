const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const {
  canonicalMessage,
  digestHex,
  signHmac,
  verifyWebhookSignature,
} = require('../api/_lib/security');

test('canonicalMessage stabilizes signing content', () => {
  const msg = canonicalMessage({
    method: 'post',
    path: '/api/payments/charge',
    timestamp: 1000,
    nonce: 'abc',
    bodyHash: digestHex('{"ok":true}'),
  });

  assert.equal(
    msg,
    `POST\n/api/payments/charge\n1000\nabc\n${digestHex('{"ok":true}')}`,
  );
});

test('signHmac returns deterministic signature', () => {
  const signature = signHmac('secret', 'hello');
  assert.equal(signature, '88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b');
});

test('verifyWebhookSignature validates expected hash', () => {
  const key = 'AABBCC-key';
  const payload = '{"event":"sample"}';
  const signature = `sha512=${createHmac('sha512', key).update(payload, 'utf8').digest('hex')}`;
  assert.equal(verifyWebhookSignature(key, payload, signature), true);
  assert.equal(verifyWebhookSignature(key, payload, `${signature}bad`), false);
});

test('verifyWebhookSignature supports hex-encoded signature keys', () => {
  const hexKey = 'A1B2C3D4';
  const payload = '{"event":"hex"}';
  const signature = `sha512=${createHmac('sha512', Buffer.from(hexKey, 'hex')).update(payload, 'utf8').digest('hex')}`;
  assert.equal(verifyWebhookSignature(hexKey, payload, signature), true);
});

// An unset AUTHNET_SIGNATURE_KEY used to accept every webhook unsigned, so
// anyone could post "authcapture.created" for a known transaction id.
test('verifyWebhookSignature fails closed when no signature key is configured', () => {
  assert.equal(verifyWebhookSignature('', '{"event":"x"}', 'sha512=abc'), false);
  assert.equal(verifyWebhookSignature(undefined, '{"event":"x"}', undefined), false);
});
