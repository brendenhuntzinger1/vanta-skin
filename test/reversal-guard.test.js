const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeGateway, gatewayResult, makeDeps, seedCharge, signedRequest } = require('./support/fakes');
const { handleRefund, handleVoid, toErrorResponse } = require('../api/_lib/service');

// Skin checks every refund and void against its own records (audit
// 2026-10-18), not only against what Labs asked for.

const TXN = '60212345678';
const body = (overrides = {}) => ({ orderId: 'order-1', originStorefront: 'vantalabsresearch.com', transactionId: TXN, amountCents: 1000, currency: 'USD', cardNumberMasked: '1111', ...overrides });

function deps() {
  return makeDeps({
    gateway: createFakeGateway({
      refund: async () => gatewayResult('captured', { transactionId: `r-${Math.random()}` }),
      void: async () => gatewayResult('captured', { transactionId: TXN }),
    }),
  });
}

async function send(fn, ctx, payload, key) {
  const path = fn === handleRefund ? '/api/payments/refund' : '/api/payments/void';
  const { req, rawBody } = signedRequest({ path, body: payload, idempotencyKey: key });
  try {
    return await fn(req, rawBody, ctx.deps);
  } catch (error) {
    return toErrorResponse(error, { operation: fn === handleRefund ? 'refund' : 'void' });
  }
}
const refund = (ctx, payload, key = `k-${Math.random()}`) => send(handleRefund, ctx, payload, key);
const voidTx = (ctx, payload, key = `v-${Math.random()}`) => send(handleVoid, ctx, payload, key);

function refusedWithoutGateway(ctx, res, reason) {
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.outcome, 'rejected');
  assert.equal(res.body.reason, reason);
  assert.equal(res.body.gatewayContacted, false);
  assert.equal(ctx.gateway.calls.length, 0, 'Authorize.Net was not asked');
  assert.equal(ctx.labs.calls.length, 0, 'Labs was told nothing');
}

test('a refund for a transaction this service never charged is refused before the gateway', async () => {
  const ctx = deps();
  refusedWithoutGateway(ctx, await refund(ctx, body()), 'unknown_transaction');
});

test('a refund redirected to another order\'s transaction is refused', async () => {
  const ctx = deps();
  seedCharge(ctx.store, { order_id: 'order-OTHER' });
  refusedWithoutGateway(ctx, await refund(ctx, body()), 'order_mismatch');
});

test('a refund naming another storefront is refused', async () => {
  const ctx = deps();
  seedCharge(ctx.store, { origin_storefront: 'other-store.example' });
  refusedWithoutGateway(ctx, await refund(ctx, body()), 'storefront_mismatch');
});

for (const outcome of ['declined', 'rejected', 'uncertain', 'held']) {
  test(`a refund of a ${outcome} charge is refused`, async () => {
    const ctx = deps();
    seedCharge(ctx.store, { outcome });
    refusedWithoutGateway(ctx, await refund(ctx, body()), 'not_captured');
  });
}

test('one refund above the captured amount is refused', async () => {
  const ctx = deps();
  seedCharge(ctx.store);
  refusedWithoutGateway(ctx, await refund(ctx, body({ amountCents: 4605 })), 'exceeds_captured');
});

test('partial refunds add up to the captured amount and no further', async () => {
  const ctx = deps();
  seedCharge(ctx.store);
  assert.equal((await refund(ctx, body({ amountCents: 2000 }))).statusCode, 200);
  assert.equal((await refund(ctx, body({ amountCents: 2000 }))).statusCode, 200);
  assert.equal((await refund(ctx, body({ amountCents: 604 }))).statusCode, 200);
  const over = await refund(ctx, body({ amountCents: 1 }));
  assert.equal(over.statusCode, 422);
  assert.equal(over.body.reason, 'exceeds_captured');
  assert.equal(ctx.gateway.calls.length, 3);
});

test('an uncertain earlier refund counts against the balance (it may have taken money)', async () => {
  const ctx = deps();
  seedCharge(ctx.store);
  ctx.store.db.paymentEvents.push({ action: 'refund', original_transaction_id: TXN, amount_cents: 4000, outcome: 'uncertain' });
  const res = await refund(ctx, body({ amountCents: 1000 }));
  assert.equal(res.body.reason, 'exceeds_captured');
});

test('a declined earlier refund does not count against the balance', async () => {
  const ctx = deps();
  seedCharge(ctx.store);
  ctx.store.db.paymentEvents.push({ action: 'refund', original_transaction_id: TXN, amount_cents: 4604, outcome: 'declined' });
  assert.equal((await refund(ctx, body({ amountCents: 4604 }))).statusCode, 200);
});

test('a duplicate refund (same key) replays its answer and is not counted against itself', async () => {
  const ctx = deps();
  seedCharge(ctx.store);
  const first = await refund(ctx, body({ amountCents: 4604 }), 'same-key');
  const again = await refund(ctx, body({ amountCents: 4604 }), 'same-key');
  assert.equal(first.statusCode, 200);
  assert.equal(again.statusCode, 200);
  assert.equal(again.replayed, true);
  assert.equal(ctx.gateway.calls.length, 1);
});

test('a refund refused for an unknown transaction is not stored: the same key works once the charge is on record', async () => {
  const ctx = deps();
  assert.equal((await refund(ctx, body(), 'retry-key')).statusCode, 422);
  seedCharge(ctx.store);
  assert.equal((await refund(ctx, body(), 'retry-key')).statusCode, 200);
});

test('records unavailable → 503 retryable, nothing sent to the gateway', async () => {
  const ctx = deps();
  seedCharge(ctx.store);
  ctx.store.fail.listReversalEvents = new Error('db down');
  const res = await refund(ctx, body());
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.retryable, true);
  assert.equal(ctx.gateway.calls.length, 0);
});

test('a refund after the transaction was voided is refused', async () => {
  const ctx = deps();
  seedCharge(ctx.store);
  assert.equal((await voidTx(ctx, body({ amountCents: undefined, cardNumberMasked: undefined }))).statusCode, 200);
  refusedWithoutGateway({ ...ctx, gateway: { calls: ctx.gateway.calls.slice(1) }, labs: { calls: ctx.labs.calls.slice(1) } }, await refund(ctx, body()), 'already_voided');
});

test('void: eligible captured charge voids once; a second void is refused', async () => {
  const ctx = deps();
  seedCharge(ctx.store);
  const v = body({ amountCents: undefined, cardNumberMasked: undefined });
  assert.equal((await voidTx(ctx, v)).statusCode, 200);
  const again = await voidTx(ctx, v);
  assert.equal(again.statusCode, 422);
  assert.equal(again.body.reason, 'already_voided');
  assert.equal(ctx.gateway.calls.length, 1);
});

test('void: a held (fraud-review) charge may be voided', async () => {
  const ctx = deps();
  seedCharge(ctx.store, { outcome: 'held' });
  assert.equal((await voidTx(ctx, body({ amountCents: undefined, cardNumberMasked: undefined }))).statusCode, 200);
});

test('void: after a partial refund is refused', async () => {
  const ctx = deps();
  seedCharge(ctx.store);
  assert.equal((await refund(ctx, body({ amountCents: 500 }))).statusCode, 200);
  const res = await voidTx(ctx, body({ amountCents: undefined, cardNumberMasked: undefined }));
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.reason, 'has_refunds');
});

test('void: of another order\'s transaction is refused', async () => {
  const ctx = deps();
  seedCharge(ctx.store, { order_id: 'order-OTHER' });
  refusedWithoutGateway(ctx, await voidTx(ctx, body({ amountCents: 4604, cardNumberMasked: undefined })), 'order_mismatch');
});
