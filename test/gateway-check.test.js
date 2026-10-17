const test = require('node:test');
const assert = require('node:assert/strict');
const { runGatewayCheck, gatewayCheckLimiter, SANDBOX_API, SANDBOX_REST } = require('../api/_lib/gateway-check');

const SECRETS = { apiLoginId: 'login-SECRET-1', transactionKey: 'txkey-SECRET-2', clientKey: 'client-SECRET-3', signatureKey: 'sig-SECRET-4' };
const HOST = 'vanta-skin-git-branch.vercel.app';

function env(overrides = {}) {
  return {
    AUTHNET_SANDBOX: 'true',
    AUTHNET_API_LOGIN_ID: SECRETS.apiLoginId,
    AUTHNET_TRANSACTION_KEY: SECRETS.transactionKey,
    AUTHNET_CLIENT_KEY: SECRETS.clientKey,
    AUTHNET_SIGNATURE_KEY: SECRETS.signatureKey,
    VERCEL_BRANCH_URL: HOST,
    ...overrides,
  };
}

const ok = (extra = {}) => ({ messages: { resultCode: 'Ok', message: [{ code: 'I00001', text: 'Successful.' }] }, ...extra });
const err = (code) => ({ messages: { resultCode: 'Error', message: [{ code, text: 'nope' }] } });

// A fake Authorize.Net: answers by request type, records every call.
function fakeGateway({ api = {}, webhooks = [], ping = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body || null });
    if (url === SANDBOX_API) {
      const [type] = Object.keys(JSON.parse(init.body));
      const answer = api[type] ?? ok();
      // Authorize.Net prefixes its JSON with a byte-order mark.
      return { ok: true, status: 200, text: async () => `﻿${JSON.stringify(answer)}` };
    }
    if (url === `${SANDBOX_REST}/webhooks`) return { ok: true, status: 200, text: async () => JSON.stringify(webhooks) };
    if (/\/pings$/.test(url)) return { ok: ping < 300, status: ping, text: async () => '' };
    throw new Error(`unexpected ${url}`);
  };
  return { calls, fetchImpl };
}

const goodWebhook = {
  webhookId: 'wh-1', name: 'vanta-skin-sandbox', status: 'active',
  url: `https://${HOST}/api/payments/webhook?x-vercel-protection-bypass=BYPASS-SECRET-5`,
  eventTypes: ['net.authorize.payment.authcapture.created', 'net.authorize.payment.refund.created', 'net.authorize.payment.void.created'],
};

function noSecretsIn(value) {
  const text = JSON.stringify(value);
  for (const s of [...Object.values(SECRETS), 'BYPASS-SECRET-5', 'opaque-SECRET-6']) assert.equal(text.includes(s), false, `leaked ${s}`);
}

test('all checks pass against a correctly configured sandbox account', async () => {
  const gw = fakeGateway({
    api: {
      getMerchantDetailsRequest: ok({ isTestMode: false, publicClientKey: SECRETS.clientKey, merchantName: 'Vanta Skin' }),
      securePaymentContainerRequest: ok({ opaqueData: { dataDescriptor: 'COMMON.ACCEPT.INAPP.PAYMENT', dataValue: 'opaque-SECRET-6' } }),
    },
    webhooks: [goodWebhook],
  });
  const result = await runGatewayCheck({ env: env(), fetchImpl: gw.fetchImpl, ping: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.authenticate, { ok: true, code: 'I00001' });
  assert.deepEqual(result.checks.clientKeyTokenize, { ok: true, code: 'I00001' });
  assert.deepEqual(result.checks.merchantDetails, { ok: true, code: 'I00001', isTestMode: false, publicClientKeyMatches: true });
  assert.deepEqual(result.checks.transactionDetails, { ok: true, code: 'I00001' });
  assert.deepEqual(result.checks.webhooks, {
    ok: true, count: 1, matching: 1,
    endpoints: [{ status: 'active', pointsHere: true, carriesBypass: true, eventTypes: goodWebhook.eventTypes, missingEventTypes: [] }],
  });
  assert.deepEqual(result.checks.webhookPing, { ok: true, status: 200 });
  noSecretsIn(result);
});

test('it talks only to the sandbox, never sends the card to anything but tokenization, and pings only the matching webhook', async () => {
  const gw = fakeGateway({ webhooks: [goodWebhook, { ...goodWebhook, webhookId: 'other', url: 'https://elsewhere.example/hook' }] });
  await runGatewayCheck({ env: env(), fetchImpl: gw.fetchImpl, ping: true });
  for (const c of gw.calls) assert.ok(c.url.startsWith('https://apitest.authorize.net/'), c.url);
  const withCard = gw.calls.filter((c) => c.body && c.body.includes('4111111111111111'));
  assert.equal(withCard.length, 1);
  assert.ok(JSON.parse(withCard[0].body).securePaymentContainerRequest);
  // The client-key check authenticates with the client key, never the transaction key.
  assert.equal(withCard[0].body.includes(SECRETS.transactionKey), false);
  const pings = gw.calls.filter((c) => /\/pings$/.test(c.url));
  assert.deepEqual(pings.map((c) => c.url), [`${SANDBOX_REST}/webhooks/wh-1/pings`]);
  // No charge, refund, void or any other transaction request is ever made.
  for (const c of gw.calls.filter((x) => x.url === SANDBOX_API)) {
    assert.ok(['authenticateTestRequest', 'getMerchantDetailsRequest', 'securePaymentContainerRequest', 'getUnsettledTransactionListRequest'].includes(Object.keys(JSON.parse(c.body))[0]));
  }
});

test('a client key from another account fails on its own, whatever merchant details say', async () => {
  const gw = fakeGateway({ api: { securePaymentContainerRequest: err('E00007'), getMerchantDetailsRequest: ok({ publicClientKey: SECRETS.clientKey }) } });
  const result = await runGatewayCheck({ env: env(), fetchImpl: gw.fetchImpl });
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.clientKeyTokenize, { ok: false, code: 'E00007' });
  noSecretsIn(result);
});

test('failures report the gateway code only: bad transaction key, Transaction Details API off, no webhook', async () => {
  const gw = fakeGateway({ api: { authenticateTestRequest: err('E00007'), getUnsettledTransactionListRequest: err('E00011') }, webhooks: [] });
  const result = await runGatewayCheck({ env: env(), fetchImpl: gw.fetchImpl, ping: true });
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.authenticate, { ok: false, code: 'E00007' });
  assert.deepEqual(result.checks.transactionDetails, { ok: false, code: 'E00011' });
  assert.deepEqual(result.checks.webhooks, { ok: false, count: 0, matching: 0, endpoints: [] });
  assert.deepEqual(result.checks.webhookPing, { ok: false, status: null, reason: 'no_matching_webhook' });
});

test('a mismatched public client key in merchant details is reported, compared without revealing either', async () => {
  const gw = fakeGateway({ api: { getMerchantDetailsRequest: ok({ publicClientKey: 'someone-elses-key' }) } });
  const result = await runGatewayCheck({ env: env(), fetchImpl: gw.fetchImpl });
  assert.equal(result.checks.merchantDetails.publicClientKeyMatches, false);
  assert.equal(JSON.stringify(result).includes('someone-elses-key'), false);
});

test('refuses outside sandbox mode and when credentials are missing, without calling anything', async () => {
  const gw = fakeGateway();
  const live = await runGatewayCheck({ env: env({ AUTHNET_SANDBOX: 'false', AUTHNET_LIVE_APPROVED: 'true', VERCEL_ENV: 'production' }), fetchImpl: gw.fetchImpl });
  assert.deepEqual(live, { ok: false, error: 'sandbox_only' });
  const missing = await runGatewayCheck({ env: env({ AUTHNET_CLIENT_KEY: '' }), fetchImpl: gw.fetchImpl });
  assert.deepEqual(missing, { ok: false, error: 'credentials_missing', missing: ['AUTHNET_CLIENT_KEY'] });
  assert.equal(gw.calls.length, 0);
});

test('a network failure is a failed check, not a crash', async () => {
  const result = await runGatewayCheck({ env: env(), fetchImpl: async () => { throw new Error('ECONNRESET with secret txkey-SECRET-2'); } });
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.authenticate, { ok: false, code: 'unreachable' });
  noSecretsIn(result);
});

test('the limiter allows one gateway check per window', () => {
  const limiter = gatewayCheckLimiter({ windowMs: 60_000 });
  assert.deepEqual(limiter.take(1_000), { allowed: true });
  assert.deepEqual(limiter.take(30_000), { allowed: false, retryAfterSeconds: 31 });
  assert.deepEqual(limiter.take(61_000), { allowed: true });
});
