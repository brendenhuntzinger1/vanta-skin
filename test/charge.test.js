const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chargeBody,
  createFakeGateway,
  createFakeStore,
  fakeLabs,
  gatewayResult,
  makeDeps,
  sha256Hex,
  signedRequest,
  testConfig,
} = require('./support/fakes');
const { BridgeError, CHARGE_ENDPOINT, CUSTOMER_MESSAGES, handleCharge, handleCreatePaymentSession, toErrorResponse } = require('../api/_lib/service');
const { createGateway } = require('../api/_lib/authnet');

const KEY = 'vskin:charge:order-2f5da385-b1b1-42be-a806-80adb74205f4:1';

async function charge(ctx, { body = chargeBody(), key = KEY, request } = {}) {
  const { req, rawBody } = request || signedRequest({ body, idempotencyKey: key });
  try {
    return await handleCharge(req, rawBody, ctx.deps);
  } catch (error) {
    return { ...toErrorResponse(error, { operation: 'charge' }), thrown: error };
  }
}

function setup({ outcome = 'captured', gw, config, labs, store } = {}) {
  const gateway = createFakeGateway({ charge: gw || (async () => gatewayResult(outcome)) });
  return makeDeps({ gateway, config, labs, store });
}

// ---------------------------------------------------------------------------
// Response contract (§3)
// ---------------------------------------------------------------------------

test('captured → 200 with the contract body', async () => {
  const ctx = setup();
  const res = await charge(ctx);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body).sort(), [
    'action', 'amountCents', 'authCode', 'cardLast4', 'cardType', 'currency', 'customerMessage', 'declineCategory', 'gatewayContacted', 'invoiceNumber',
    'message', 'ok', 'orderId', 'outcome', 'paymentStatus', 'processorCode', 'refId', 'retryable', 'sandbox', 'transactionId',
  ].sort());
  assert.equal(res.body.ok, true);
  assert.equal(res.body.outcome, 'captured');
  assert.equal(res.body.paymentStatus, 'captured');
  assert.equal(res.body.retryable, false);
  assert.equal(res.body.gatewayContacted, true);
  assert.equal(res.body.transactionId, '60212345678');
  assert.equal(res.body.refId, sha256Hex(KEY).slice(0, 20));
  assert.equal(res.body.invoiceNumber, require('../api/_lib/authnet').invoiceNumberFor({ orderId: 'order-2f5da385-b1b1-42be-a806-80adb74205f4' }));
  assert.match(res.body.invoiceNumber, /^VS-[0-9A-F]{17}$/);
  assert.equal(res.body.authCode, 'ABC123');
  assert.equal(res.body.cardLast4, '1111');
  assert.equal(res.body.cardType, 'Visa');
  assert.equal(res.body.amountCents, 4604);
  assert.equal(res.body.currency, 'USD');
  assert.equal(res.body.sandbox, true);
  assert.equal(res.body.processorCode, '1');
  assert.equal(res.body.customerMessage, null);
  assert.equal(res.replayed, false);
  // The refId the gateway was given is the same one.
  assert.equal(ctx.gateway.calls[0].args[2].refId, res.body.refId);
});

for (const [outcome, status, retryable] of [['declined', 402, true], ['rejected', 422, true], ['held', 202, false]]) {
  test(`${outcome} → ${status} with safe customer text`, async () => {
    const ctx = setup({ outcome });
    const res = await charge(ctx);
    assert.equal(res.statusCode, status);
    assert.equal(res.body.outcome, outcome);
    assert.equal(res.body.paymentStatus, outcome);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.retryable, retryable);
    assert.equal(res.body.customerMessage, CUSTOMER_MESSAGES[outcome]);
    assert.equal(ctx.store.db.idempotency.get(`${CHARGE_ENDPOINT}|${KEY}`).status, 'completed');
  });
}

test('customer messages are the agreed safe texts', () => {
  assert.equal(CUSTOMER_MESSAGES.declined, 'Your card was declined. Please check the details or use a different card.');
  assert.equal(CUSTOMER_MESSAGES.rejected, "We couldn't process this card. No payment was taken.");
  for (const text of Object.values(CUSTOMER_MESSAGES).filter(Boolean)) {
    assert.equal(/skin|AUTHNET|SUPABASE|VANTA_/i.test(text), false, text);
  }
});

test('a duplicate-transaction refusal (error 11) is rejected but not retryable', async () => {
  const ctx = setup({ gw: async () => gatewayResult('rejected', { errorCode: '11' }) });
  const res = await charge(ctx);
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.retryable, false);
});

// ---------------------------------------------------------------------------
// Atomic idempotency
// ---------------------------------------------------------------------------

test('the key is claimed (in_progress) before the gateway is called', async () => {
  let statusAtGateway;
  const store = createFakeStore();
  const ctx = setup({
    store,
    gw: async () => {
      statusAtGateway = store.db.idempotency.get(`${CHARGE_ENDPOINT}|${KEY}`)?.status;
      return gatewayResult('captured');
    },
  });
  await charge(ctx);
  assert.equal(statusAtGateway, 'in_progress');
  const order = store.log.filter((e) => !e.startsWith('recordReplayNonce'));
  assert.deepEqual(order.slice(0, 2), ['claimIdempotency', 'finishIdempotency:completed']);
});

test('result is persisted before secondary writes and before the Labs callback', async () => {
  const store = createFakeStore();
  const labs = fakeLabs();
  let persistedWhenLabsCalled;
  const ctx = setup({
    store,
    labs: {
      ...labs,
      post: async (s, p) => {
        persistedWhenLabsCalled = store.db.idempotency.get(`${CHARGE_ENDPOINT}|${KEY}`).status;
        return labs.post(s, p);
      },
    },
  });
  await charge(ctx);
  assert.equal(persistedWhenLabsCalled, 'completed');
  const finish = store.log.indexOf('finishIdempotency:completed');
  assert.ok(finish < store.log.indexOf('recordPaymentEvent'));
  assert.ok(finish < store.log.indexOf('insertSyncEvent'));
});

test('a concurrent request for an in-progress key gets 409 in_progress and no gateway call', async () => {
  const store = createFakeStore();
  store.db.idempotency.set(`${CHARGE_ENDPOINT}|${KEY}`, { status: 'in_progress', request_hash: 'whatever' });
  const ctx = setup({ store });
  const { req, rawBody } = signedRequest({ body: chargeBody(), idempotencyKey: KEY });
  store.db.idempotency.get(`${CHARGE_ENDPOINT}|${KEY}`).request_hash = sha256Hex(rawBody);
  const res = await charge(ctx, { request: { req, rawBody } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.outcome, 'in_progress');
  assert.equal(ctx.gateway.calls.length, 0);
});

test('two simultaneous requests with one key charge once', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const ctx = setup({ gw: async () => { await gate; return gatewayResult('captured'); } });
  const body = chargeBody();
  const first = charge(ctx, { request: signedRequest({ body, idempotencyKey: KEY }) });
  await new Promise((r) => setImmediate(r));
  const second = await charge(ctx, { request: signedRequest({ body, idempotencyKey: KEY }) });
  release();
  const one = await first;
  assert.equal(one.statusCode, 200);
  assert.equal(second.statusCode, 409);
  assert.equal(second.body.outcome, 'in_progress');
  assert.equal(ctx.gateway.calls.length, 1);
});

test('a completed key with the same body replays the stored response; no second charge', async () => {
  const ctx = setup();
  const body = chargeBody();
  const first = await charge(ctx, { body });
  const again = await charge(ctx, { body });
  assert.equal(again.statusCode, 200);
  assert.equal(again.replayed, true);
  assert.deepEqual(again.body, first.body);
  assert.equal(ctx.gateway.calls.length, 1);
});

test('a completed key with a different body → 409 conflict', async () => {
  const ctx = setup();
  await charge(ctx, { body: chargeBody() });
  const res = await charge(ctx, { body: chargeBody({ amountCents: 9999 }) });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.outcome, 'conflict');
  assert.equal(ctx.gateway.calls.length, 1);
});

test('an uncertain key replays 502 uncertain', async () => {
  const ctx = setup({ outcome: 'uncertain' });
  const body = chargeBody();
  const first = await charge(ctx, { body });
  assert.equal(first.statusCode, 502);
  const again = await charge(ctx, { body });
  assert.equal(again.statusCode, 502);
  assert.equal(again.body.outcome, 'uncertain');
  assert.equal(again.replayed, true);
  assert.equal(ctx.gateway.calls.length, 1);
});

test('gateway timeout → 502 uncertain, row marked uncertain, no callback, never declined', async () => {
  const ctx = setup();
  ctx.deps.gateway = createGateway({ execute: () => new Promise(() => {}), timeoutMs: 20 });
  const res = await charge(ctx);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.outcome, 'uncertain');
  assert.equal(res.body.paymentStatus, 'uncertain');
  assert.equal(res.body.retryable, false);
  assert.equal(res.body.customerMessage, CUSTOMER_MESSAGES.uncertain);
  assert.equal(ctx.store.db.idempotency.get(`${CHARGE_ENDPOINT}|${KEY}`).status, 'uncertain');
  assert.equal(ctx.labs.calls.length, 0);
});

test('a gateway call that throws → 502 uncertain and the row is marked uncertain', async () => {
  const ctx = setup({ gw: async () => { throw new Error('socket hang up'); } });
  const res = await charge(ctx);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.outcome, 'uncertain');
  assert.equal(JSON.stringify(res.body).includes('socket hang up'), false);
  assert.equal(ctx.store.db.idempotency.get(`${CHARGE_ENDPOINT}|${KEY}`).status, 'uncertain');
});

test('captured but the result cannot be saved → 502 uncertain WITH the transaction id (never 4xx)', async () => {
  const store = createFakeStore();
  store.fail.finishIdempotency = new Error('db down');
  const ctx = setup({ store });
  const res = await charge(ctx);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.outcome, 'uncertain');
  assert.equal(res.body.transactionId, '60212345678');
  assert.equal(res.body.cardLast4, '1111');
  // The claim stays in_progress, so a retry with the same key cannot charge again.
  const again = await charge(ctx);
  assert.equal(again.statusCode, 409);
  assert.equal(ctx.gateway.calls.length, 1);
});

test('held but the result cannot be saved → 502 uncertain', async () => {
  const store = createFakeStore();
  store.fail.finishIdempotency = new Error('db down');
  const res = await charge(setup({ store, outcome: 'held' }));
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.transactionId, '60212345680');
});

test('declined but the result cannot be saved → still 402 declined (definitive, nothing charged)', async () => {
  const store = createFakeStore();
  store.fail.finishIdempotency = new Error('db down');
  const res = await charge(setup({ store, outcome: 'declined' }));
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.outcome, 'declined');
});

test('secondary write failures never change the response or allow a second charge', async () => {
  const store = createFakeStore();
  store.fail.recordPaymentEvent = new Error('events table missing');
  store.fail.insertSyncEvent = new Error('outbox missing');
  const labs = fakeLabs(() => { throw new Error('labs down'); });
  const ctx = setup({ store, labs });
  const res = await charge(ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.outcome, 'captured');
  const again = await charge(ctx);
  assert.equal(again.statusCode, 200);
  assert.equal(again.replayed, true);
  assert.equal(ctx.gateway.calls.length, 1);
});

test('the idempotency claim failing for a non-duplicate reason → 503 not charged, no gateway call', async () => {
  const store = createFakeStore();
  store.fail.claimIdempotency = new Error('relation payment_idempotency column status does not exist');
  const ctx = setup({ store });
  const res = await charge(ctx);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.outcome, 'rejected');
  assert.equal(res.body.gatewayContacted, false);
  assert.equal(res.body.retryable, true);
  assert.equal(JSON.stringify(res.body).includes('payment_idempotency'), false);
  assert.equal(ctx.gateway.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Pre-gateway refusals leave no claim behind
// ---------------------------------------------------------------------------

const INVALID_BODIES = {
  'missing orderId': chargeBody({ orderId: undefined }),
  'non-USD currency': chargeBody({ currency: 'EUR' }),
  'missing currency': chargeBody({ currency: undefined }),
  'lowercase usd': chargeBody({ currency: 'usd' }),
  'zero amount': chargeBody({ amountCents: 0 }),
  'fractional amount': chargeBody({ amountCents: 10.5 }),
  'unapproved storefront': chargeBody({ originStorefront: 'evil.example' }),
  'raw card number': chargeBody({ cardNumber: '4111111111111111' }),
  'missing token': chargeBody({ opaqueData: { dataDescriptor: 'COMMON.ACCEPT.INAPP.PAYMENT' } }),
  'auth-only': chargeBody({ capture: false }),
  'negative shipping': chargeBody({ shippingCents: -1 }),
  'requireSandbox not boolean': chargeBody({ requireSandbox: 'yes' }),
};

for (const [name, body] of Object.entries(INVALID_BODIES)) {
  test(`invalid input (${name}) → 400 invalid, no claim, no gateway call`, async () => {
    const ctx = setup();
    const res = await charge(ctx, { body });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.outcome, 'invalid');
    assert.equal(res.body.gatewayContacted, false);
    assert.equal(ctx.store.db.idempotency.size, 0);
    assert.equal(ctx.gateway.calls.length, 0);
  });
}

test('missing idempotency key → 400 invalid', async () => {
  const ctx = setup();
  const res = await charge(ctx, { request: signedRequest({ body: chargeBody() }) });
  assert.equal(res.statusCode, 400);
  assert.equal(ctx.gateway.calls.length, 0);
});

test('malformed JSON → 400 invalid', async () => {
  const ctx = setup();
  const res = await charge(ctx, { request: signedRequest({ body: '{not json', idempotencyKey: KEY }) });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.outcome, 'invalid');
});

test('bad signature → 401 invalid, no claim, no gateway call', async () => {
  const ctx = setup();
  const res = await charge(ctx, { request: signedRequest({ body: chargeBody(), idempotencyKey: KEY, secret: 'wrong' }) });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.outcome, 'invalid');
  assert.equal(ctx.store.db.idempotency.size, 0);
  assert.equal(ctx.gateway.calls.length, 0);
});

test('a replayed nonce → 409 invalid, no gateway call', async () => {
  const ctx = setup();
  const request = signedRequest({ body: chargeBody(), idempotencyKey: KEY, nonce: 'fixed-nonce' });
  await charge(ctx, { request });
  const res = await charge(ctx, { request });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.outcome, 'invalid');
  assert.equal(ctx.gateway.calls.length, 1);
});

test('requireSandbox=true against a live service → 422 rejected, not retryable, before the gateway', async () => {
  const ctx = setup({ config: testConfig({ authnet: { sandbox: false, mode: 'live' } }) });
  const res = await charge(ctx, { body: chargeBody({ requireSandbox: true }) });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.outcome, 'rejected');
  assert.equal(res.body.retryable, false);
  assert.equal(res.body.gatewayContacted, false);
  assert.equal(ctx.gateway.calls.length, 0);
  assert.equal(ctx.store.db.idempotency.size, 0);
});

test('requireSandbox=true in sandbox, or absent in live, goes to the gateway', async () => {
  const sandbox = setup();
  assert.equal((await charge(sandbox, { body: chargeBody({ requireSandbox: true }) })).statusCode, 200);
  const live = setup({ config: testConfig({ authnet: { sandbox: false, mode: 'live' } }) });
  const res = await charge(live, { body: chargeBody({ requireSandbox: undefined }) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sandbox, false);
});

test('live requested but not approved → 503 not charged, before the gateway', async () => {
  const ctx = setup({ config: testConfig({ authnet: { sandbox: true, mode: 'misconfigured', configError: 'live_mode_not_approved' } }) });
  const res = await charge(ctx);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.outcome, 'rejected');
  assert.equal(res.body.retryable, false);
  assert.equal(res.body.customerMessage, CUSTOMER_MESSAGES.unavailable);
  assert.equal(ctx.gateway.calls.length, 0);
});

test('a configuration error is answered 503 without naming any variable', async () => {
  const ctx = setup();
  ctx.deps.loadConfig = () => {
    const err = new Error('Missing required environment variable: AUTHNET_TRANSACTION_KEY');
    err.code = 'config_error';
    throw err;
  };
  const res = await charge(ctx);
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.stringify(res.body).includes('AUTHNET'), false);
});

test('an unexpected (non-bridge) error maps to 502 uncertain with no raw text', () => {
  const res = toErrorResponse(new Error('duplicate key value violates unique constraint "x" password=hunter2'), { operation: 'charge' });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.outcome, 'uncertain');
  assert.equal(JSON.stringify(res.body).includes('hunter2'), false);
  assert.equal(res.body.message, 'internal_error');
  assert.ok(new BridgeError({ statusCode: 400, outcome: 'invalid', message: 'x' }) instanceof Error);
});

// ---------------------------------------------------------------------------
// Card data and audit rows (§8)
// ---------------------------------------------------------------------------

test('payment_events row carries card data, outcome, refId, key and auth amount; token redacted', async () => {
  const ctx = setup();
  await charge(ctx);
  const [row] = ctx.store.db.paymentEvents;
  assert.equal(row.action, 'charge');
  assert.equal(row.outcome, 'captured');
  assert.equal(row.status, 'captured');
  assert.equal(row.card_last4, '1111');
  assert.equal(row.card_type, 'Visa');
  assert.equal(row.ref_id, sha256Hex(KEY).slice(0, 20));
  assert.equal(row.idempotency_key, KEY);
  assert.equal(row.auth_amount_cents, 4604);
  assert.equal(row.authnet_transaction_id, '60212345678');
  assert.equal(JSON.stringify(row).includes('accept-js-token-SECRET'), false);
  assert.equal(JSON.stringify(ctx.store.db.idempotency.get(`${CHARGE_ENDPOINT}|${KEY}`)).includes('accept-js-token-SECRET'), false);
});

// ---------------------------------------------------------------------------
// Callback (§5)
// ---------------------------------------------------------------------------

test('the charge callback follows contract §5', async () => {
  const ctx = setup();
  await charge(ctx);
  assert.equal(ctx.labs.calls.length, 1);
  const cb = ctx.labs.calls[0];
  assert.deepEqual(Object.keys(cb).sort(), [
    'action', 'amountCents', 'attemptKey', 'cardLast4', 'cardType', 'currency', 'eventId', 'message', 'occurredAt', 'orderId',
    'originStorefront', 'outcome', 'paymentStatus', 'processorCode', 'sandbox', 'source', 'transactionId',
  ].sort());
  assert.equal(cb.eventId, `bridge:charge:${KEY}:60212345678:captured`);
  assert.equal(cb.source, 'vanta-skin-payment-bridge');
  assert.equal(cb.attemptKey, KEY);
  assert.equal(cb.outcome, 'captured');
  assert.equal(cb.amountCents, 4604);
  assert.equal(cb.cardLast4, '1111');
  assert.equal(cb.cardType, 'Visa');
  const [row] = ctx.store.db.outbox;
  assert.equal(row.event_key, cb.eventId);
  assert.equal(row.delivery_status, 'delivered');
});

test('a declined charge is called back with transId and outcome; an uncertain one is not', async () => {
  const declined = setup({ outcome: 'declined' });
  await charge(declined);
  assert.equal(declined.labs.calls[0].eventId, `bridge:charge:${KEY}:60212345679:declined`);
  assert.equal(declined.labs.calls[0].amountCents, 4604);

  const rejected = setup({ outcome: 'rejected' });
  await charge(rejected);
  assert.equal(rejected.labs.calls[0].eventId, `bridge:charge:${KEY}:none:rejected`);

  const uncertain = setup({ outcome: 'uncertain' });
  await charge(uncertain);
  assert.equal(uncertain.labs.calls.length, 0);
});

test('Labs answering 422 dead-letters the callback immediately', async () => {
  const ctx = setup({ labs: fakeLabs(() => ({ status: 422, body: null })) });
  const res = await charge(ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(ctx.store.db.outbox[0].delivery_status, 'dead');
});

test('Labs answering 500 leaves the callback failed with a backoff', async () => {
  const now = new Date('2026-10-16T12:00:00.000Z');
  const ctx = makeDeps({ gateway: createFakeGateway({ charge: async () => gatewayResult('captured') }), labs: fakeLabs(() => ({ status: 500 })), now: () => now });
  await charge(ctx);
  const [row] = ctx.store.db.outbox;
  assert.equal(row.delivery_status, 'failed');
  assert.equal(row.delivery_attempt_count, 1);
  assert.equal(row.next_attempt_at, '2026-10-16T12:01:00.000Z');
});

// ---------------------------------------------------------------------------
// Decline categories: what the customer can fix, from the reason code
// ---------------------------------------------------------------------------

for (const [errorCode, outcome, category] of [
  ['8', 'rejected', 'expiry'],
  ['317', 'rejected', 'expiry'],
  ['6', 'rejected', 'card_number'],
  ['78', 'rejected', 'cvv'],
  ['44', 'declined', 'cvv'],
  ['27', 'declined', 'billing'],
  ['45', 'declined', 'billing_and_cvv'],
  ['11', 'rejected', 'duplicate'],
  ['2', 'declined', 'generic'],
  ['254', 'declined', 'generic'], // a fraud-filter decline is never named as such
  [null, 'declined', 'generic'],
]) {
  test(`reason code ${errorCode} (${outcome}) → declineCategory ${category}`, async () => {
    const ctx = setup({ gw: async () => gatewayResult(outcome, { errorCode }) });
    const res = await charge(ctx);
    assert.equal(res.body.outcome, outcome);
    assert.equal(res.body.declineCategory, category);
  });
}

test('captured, held and uncertain answers carry no decline category', async () => {
  for (const outcome of ['captured', 'held']) {
    const res = await charge(setup({ outcome }));
    assert.equal(res.body.declineCategory, null, outcome);
  }
});

// ---------------------------------------------------------------------------
// Payment sessions (embedded checkout): charge binding + consumption
// ---------------------------------------------------------------------------

const SESSION_TOKEN = `vps_${'a'.repeat(64)}`;

function sessionRow(overrides = {}) {
  return {
    token_hash: sha256Hex(SESSION_TOKEN),
    order_id: chargeBody().orderId,
    amount_cents: 4604,
    currency: 'USD',
    origin_storefront: 'vantalabsresearch.com',
    parent_origin: 'https://vantalabsresearch.com',
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    consumed_at: null,
    ...overrides,
  };
}

function setupWithSession({ outcome = 'captured', gw, config, row = sessionRow() } = {}) {
  const store = createFakeStore();
  if (row) store.db.sessions.set(row.token_hash, row);
  const gateway = createFakeGateway({ charge: gw || (async () => gatewayResult(outcome)) });
  return makeDeps({ gateway, config, store });
}

test('a charge with a valid payment session consumes it and charges', async () => {
  const ctx = setupWithSession();
  const res = await charge(ctx, { body: chargeBody({ paymentSession: SESSION_TOKEN }) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.outcome, 'captured');
  assert.equal(ctx.gateway.calls.filter((c) => c.name === 'charge').length, 1);
  assert.ok(ctx.store.db.sessions.get(sha256Hex(SESSION_TOKEN)).consumed_at, 'session consumed');
});

test('a consumed session is rejected 409 before the gateway is touched', async () => {
  const ctx = setupWithSession({ row: sessionRow({ consumed_at: new Date().toISOString() }) });
  const res = await charge(ctx, { body: chargeBody({ paymentSession: SESSION_TOKEN }) });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.outcome, 'conflict');
  assert.equal(ctx.gateway.calls.length, 0);
});

test('session amount or order drift is rejected and the session stays unspent', async () => {
  const ctx = setupWithSession();
  const res = await charge(ctx, { body: chargeBody({ paymentSession: SESSION_TOKEN, amountCents: 1 }) });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.outcome, 'invalid');
  assert.equal(ctx.gateway.calls.length, 0);
  assert.equal(ctx.store.db.sessions.get(sha256Hex(SESSION_TOKEN)).consumed_at, null);
});

test('an expired session is rejected before the gateway is touched', async () => {
  const ctx = setupWithSession({ row: sessionRow({ expires_at: new Date(Date.now() - 1000).toISOString() }) });
  const res = await charge(ctx, { body: chargeBody({ paymentSession: SESSION_TOKEN }) });
  assert.equal(res.statusCode, 400);
  assert.equal(ctx.gateway.calls.length, 0);
});

// Nothing was charged, and a new session lets the shopper pay: the answer says
// so (retryable, reason payment_session), or Labs leaves them at a dead end.
test('a session refusal (expired, spent, drifted) says nothing was charged and a new session may be opened', async () => {
  for (const row of [
    sessionRow({ expires_at: new Date(Date.now() - 1000).toISOString() }),
    sessionRow({ consumed_at: new Date().toISOString() }),
    sessionRow({ amount_cents: 1 }),
  ]) {
    const ctx = setupWithSession({ row });
    const res = await charge(ctx, { body: chargeBody({ paymentSession: SESSION_TOKEN }) });
    assert.equal(res.body.gatewayContacted, false);
    assert.equal(res.body.retryable, true);
    assert.equal(res.body.reason, 'payment_session');
    assert.equal(ctx.gateway.calls.length, 0);
  }
});

test('other refusals carry no payment_session reason', async () => {
  const res = await charge(setup(), { body: chargeBody({ paymentSession: 'not-a-token' }) });
  assert.equal(res.body.reason, undefined);
});

test('a malformed paymentSession is rejected as invalid', async () => {
  const res = await charge(setup(), { body: chargeBody({ paymentSession: 'not-a-token' }) });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.outcome, 'invalid');
});

test('when sessions are required, a charge without one is refused', async () => {
  const ctx = setup({ config: testConfig({ bridge: { requirePaymentSession: true } }) });
  const res = await charge(ctx);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.outcome, 'invalid');
  assert.equal(ctx.gateway.calls.length, 0);
});

test('an idempotent replay of a session charge does not consume twice', async () => {
  const ctx = setupWithSession();
  const body = chargeBody({ paymentSession: SESSION_TOKEN });
  const first = await charge(ctx, { body });
  const second = await charge(ctx, { body });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.replayed ?? second.replayed, true);
  assert.equal(ctx.gateway.calls.filter((c) => c.name === 'charge').length, 1);
});

test('session creation stores only the token hash and returns the embed URL', async () => {
  const ctx = setup();
  const { req, rawBody } = signedRequest({
    path: '/api/payments/session',
    body: { orderId: 'order-1', amountCents: 4604, currency: 'USD', originStorefront: 'vantalabsresearch.com', embedOrigin: 'https://vantalabsresearch.com' },
  });
  const res = await handleCreatePaymentSession(req, rawBody, ctx.deps);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.sessionToken, /^vps_[0-9a-f]{64}$/);
  assert.equal(res.body.embedUrl, `/api/payments/embed?session=${res.body.sessionToken}`);
  assert.match(res.body.sessionId, /^[0-9a-f]{24}$/);
  const stored = ctx.store.db.sessions.get(sha256Hex(res.body.sessionToken));
  assert.ok(stored, 'session stored by hash');
  assert.equal(stored.order_id, 'order-1');
  assert.equal(JSON.stringify([...ctx.store.db.sessions.values()]).includes('vps_'), false);
});

test('session creation rejects an unapproved embed origin', async () => {
  const ctx = setup();
  const { req, rawBody } = signedRequest({
    path: '/api/payments/session',
    body: { orderId: 'order-1', amountCents: 4604, currency: 'USD', originStorefront: 'vantalabsresearch.com', embedOrigin: 'https://vantalabsresearch.com.evil.test' },
  });
  await assert.rejects(() => handleCreatePaymentSession(req, rawBody, ctx.deps), /not approved/);
  assert.equal(ctx.store.db.sessions.size, 0);
});
