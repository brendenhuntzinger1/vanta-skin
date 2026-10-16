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
  const key = 'AABBCC';
  const payload = '{"event":"sample"}';
  const signature = `sha512=${createHmac('sha512', key).update(payload, 'utf8').digest('hex')}`;
  assert.equal(verifyWebhookSignature(key, payload, signature), true);
  assert.equal(verifyWebhookSignature(key, payload, `${signature}bad`), false);
});
