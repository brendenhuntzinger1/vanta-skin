const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { BRIDGE_KEY_ID, BRIDGE_SECRET, signedRequest } = require('./support/fakes');
const { digestHex, responseCanonicalMessage, responseSignatureHeaders, signHmac } = require('../api/_lib/security');
const { setSignedJson } = require('../api/_lib/http');
const { partialApprovalHeld } = require('../api/_lib/authnet');

// Audit F1 (2026-10-18): every answer to a signed bridge request is signed,
// bound to that request's path and nonce, the status code and the body.

const secrets = { [BRIDGE_KEY_ID]: BRIDGE_SECRET };

function capture() {
  const out = { headers: {}, statusCode: null, raw: null };
  out.setHeader = (k, v) => { out.headers[k.toLowerCase()] = v; };
  out.end = (text) => { out.raw = text; };
  return out;
}

function expectedSignature(req, status, raw, ts) {
  return signHmac(BRIDGE_SECRET, responseCanonicalMessage({ path: req.url.split('?')[0], statusCode: status, requestNonce: req.headers['x-vanta-nonce'], timestamp: ts, bodyHash: digestHex(raw) }));
}

test('a signed request gets a signed answer over the exact bytes sent', () => {
  process.env.VANTA_HMAC_KEY_ID = BRIDGE_KEY_ID;
  process.env.VANTA_HMAC_SHARED_SECRET = BRIDGE_SECRET;
  const { req } = signedRequest({ path: '/api/payments/charge', body: {} });
  const res = capture();
  setSignedJson(req, res, 200, { ok: true, outcome: 'captured', amountCents: 4604 });
  const ts = res.headers['x-vanta-response-timestamp'];
  assert.match(ts, /^\d+$/);
  assert.equal(res.headers['x-vanta-key-id'], BRIDGE_KEY_ID);
  assert.equal(res.headers['x-vanta-response-signature'], expectedSignature(req, 200, res.raw, ts));
  delete process.env.VANTA_HMAC_KEY_ID;
  delete process.env.VANTA_HMAC_SHARED_SECRET;
});

test('the signature changes with the body, the status, the path and the request nonce', () => {
  const { req } = signedRequest({ path: '/api/payments/charge', body: {} });
  const base = responseSignatureHeaders(secrets, req, 200, '{"amountCents":4604}', 1700000000)['x-vanta-response-signature'];
  const differs = (r, status, raw) => assert.notEqual(responseSignatureHeaders(secrets, r, status, raw, 1700000000)['x-vanta-response-signature'], base);
  differs(req, 200, '{"amountCents":1}');
  differs(req, 402, '{"amountCents":4604}');
  differs({ ...req, url: '/api/payments/refund' }, 200, '{"amountCents":4604}');
  differs({ ...req, headers: { ...req.headers, 'x-vanta-nonce': 'another-request' } }, 200, '{"amountCents":4604}');
});

test('no signature for a request with no known key or no nonce', () => {
  const { req } = signedRequest({ path: '/api/payments/charge', body: {} });
  assert.equal(responseSignatureHeaders(secrets, { ...req, headers: { ...req.headers, 'x-vanta-key-id': 'unknown' } }, 200, '{}'), null);
  assert.equal(responseSignatureHeaders(secrets, { ...req, headers: { 'x-vanta-key-id': BRIDGE_KEY_ID } }, 200, '{}'), null);
  assert.equal(responseSignatureHeaders(secrets, { url: '/x', headers: {} }, 200, '{}'), null);
});

test('the bridge handler signs its answers, errors included', async () => {
  process.env.VANTA_HMAC_KEY_ID = BRIDGE_KEY_ID;
  process.env.VANTA_HMAC_SHARED_SECRET = BRIDGE_SECRET;
  const { bridgeHandler } = require('../api/_lib/handler');
  const { req: base } = signedRequest({ path: '/api/payments/charge', body: {} });
  const stream = Readable.from([Buffer.from('{}')]);
  Object.assign(stream, { method: 'POST', url: base.url, headers: base.headers });
  const res = capture();
  await bridgeHandler('charge', async () => { throw new Error('boom'); })(stream, res);
  assert.equal(res.statusCode, 502);
  const ts = res.headers['x-vanta-response-timestamp'];
  assert.equal(res.headers['x-vanta-response-signature'], expectedSignature(base, 502, res.raw, ts));
  delete process.env.VANTA_HMAC_KEY_ID;
  delete process.env.VANTA_HMAC_SHARED_SECRET;
});

// Audit F2: an approval for less than was asked is never reported captured.
test('a partial approval is held for review with the approved amount, never captured', () => {
  const captured = { outcome: 'captured', transactionId: '1', raw: { transactionResponse: { prePaidCard: { requestedAmount: '46.04', approvedAmount: '20.00' } } } };
  const held = partialApprovalHeld(captured, 4604);
  assert.equal(held.outcome, 'held');
  assert.equal(held.reason, 'partial_authorization');
  assert.equal(held.approvedAmountCents, 2000);
  assert.equal(partialApprovalHeld({ ...captured, raw: { transactionResponse: { splitTenderId: '99' } } }, 4604).outcome, 'held');
  assert.equal(partialApprovalHeld({ ...captured, raw: { transactionResponse: { prePaidCard: { approvedAmount: '46.04' } } } }, 4604).outcome, 'captured');
  assert.equal(partialApprovalHeld({ outcome: 'captured', raw: { transactionResponse: {} } }, 4604).outcome, 'captured');
  assert.equal(partialApprovalHeld({ outcome: 'declined', raw: { transactionResponse: { splitTenderId: '9' } } }, 4604).outcome, 'declined');
});
