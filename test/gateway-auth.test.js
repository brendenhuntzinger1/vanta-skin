const test = require('node:test');
const assert = require('node:assert/strict');
const { createGatewayAuthCheck } = require('../api/_lib/gateway-auth');

const env = { AUTHNET_API_LOGIN_ID: 'login-id-x', AUTHNET_TRANSACTION_KEY: 'txn-key-secret-x' };
const answer = (code) => async () => ({
  status: 200,
  text: async () => '﻿' + JSON.stringify({ messages: { resultCode: code === 'I00001' ? 'Ok' : 'Error', message: [{ code, text: 'x' }] } }),
});

test('verified only when the gateway accepts the login (I00001)', async () => {
  const check = createGatewayAuthCheck({ fetchImpl: answer('I00001'), now: () => 0 });
  assert.equal(await check({ env, sandbox: false }), 'verified');
});

test('an inactive account (E00008) or bad keys (E00007) is reported, never verified', async () => {
  assert.equal(await createGatewayAuthCheck({ fetchImpl: answer('E00008'), now: () => 0 })({ env, sandbox: false }), 'rejected:E00008');
  assert.equal(await createGatewayAuthCheck({ fetchImpl: answer('E00007'), now: () => 0 })({ env, sandbox: false }), 'rejected:E00007');
});

test('asks the gateway the mode points at, and never echoes a secret', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, body: init.body }); return answer('I00001')(); };
  const check = createGatewayAuthCheck({ fetchImpl, now: () => 0 });
  const live = await check({ env, sandbox: false });
  assert.equal(seen[0].url, 'https://api.authorize.net/xml/v1/request.api');
  assert.ok(!live.includes('txn-key-secret-x'));
  await createGatewayAuthCheck({ fetchImpl, now: () => 0 })({ env, sandbox: true });
  assert.equal(seen[1].url, 'https://apitest.authorize.net/xml/v1/request.api');
  assert.ok(JSON.parse(seen[1].body).authenticateTestRequest);
});

test('missing credentials and network failures are not verified', async () => {
  assert.equal(await createGatewayAuthCheck({ fetchImpl: answer('I00001'), now: () => 0 })({ env: {}, sandbox: false }), 'missing');
  const boom = createGatewayAuthCheck({ fetchImpl: async () => { throw new Error('down'); }, now: () => 0 });
  assert.equal(await boom({ env, sandbox: false }), 'unreachable');
});

test('one gateway call per minute per instance: later asks get the cached answer', async () => {
  let calls = 0;
  let t = 0;
  const check = createGatewayAuthCheck({ fetchImpl: async () => { calls += 1; return answer('E00008')(); }, now: () => t });
  await check({ env, sandbox: false });
  t = 30_000;
  assert.equal(await check({ env, sandbox: false }), 'rejected:E00008');
  assert.equal(calls, 1);
  t = 61_000;
  await check({ env, sandbox: false });
  assert.equal(calls, 2);
});
