const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
require('./support/fakes');
const { bridgeHandler } = require('../api/_lib/handler');
const { BridgeError } = require('../api/_lib/service');

function req(body = '{}', method = 'POST') {
  const stream = Readable.from([Buffer.from(body)]);
  stream.method = method;
  stream.url = '/api/payments/charge';
  stream.headers = {};
  return stream;
}

function res() {
  const out = { headers: {}, statusCode: null, body: null };
  out.setHeader = (k, v) => { out.headers[k.toLowerCase()] = v; };
  out.end = (text) => { out.body = JSON.parse(text); };
  return out;
}

test('an unexpected error in a charge never leaks its text and is answered uncertain (502)', async (t) => {
  t.mock.method(console, 'error', () => {});
  const handler = bridgeHandler('charge', async () => { throw new Error('connect ECONNREFUSED db.internal:5432 password=x'); });
  const r = res();
  await handler(req(), r);
  assert.equal(r.statusCode, 502);
  assert.equal(r.body.outcome, 'uncertain');
  assert.equal(JSON.stringify(r.body).includes('ECONNREFUSED'), false);
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('a bridge error keeps its status and outcome', async () => {
  const handler = bridgeHandler('charge', async () => { throw new BridgeError({ statusCode: 400, outcome: 'invalid', message: 'currency must be USD' }); });
  const r = res();
  await handler(req(), r);
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.outcome, 'invalid');
  assert.equal(r.body.replayed, false);
  assert.equal(r.body.customerMessage, "We couldn't process this payment. No payment was taken.");
});

test('success passes status and body through with replayed', async () => {
  const handler = bridgeHandler('charge', async (_req, raw) => ({ statusCode: 200, body: { ok: true, outcome: 'captured', raw }, replayed: true }));
  const r = res();
  await handler(req('{"a":1}'), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.raw, '{"a":1}');
  assert.equal(r.body.replayed, true);
});

test('non-POST → 405', async () => {
  const handler = bridgeHandler('charge', async () => ({ statusCode: 200, body: {} }));
  const r = res();
  await handler(req('', 'GET'), r);
  assert.equal(r.statusCode, 405);
});

test('every payment endpoint module loads', () => {
  for (const name of ['charge', 'refund', 'void', 'reconcile', 'webhook', 'sync-retry', 'tokenize-config', 'health']) {
    assert.equal(typeof require(`../api/payments/${name}`), 'function', name);
  }
});
