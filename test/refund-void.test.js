const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeGateway, gatewayResult, makeDeps, signedRequest } = require('./support/fakes');
const { REFUND_ENDPOINT, handleRefund, handleVoid, toErrorResponse } = require('../api/_lib/service');

const ORIGINAL = '60212345678';
const REFUND_TX = '60299990001';
const ORDER = 'order-2f5da385-b1b1-42be-a806-80adb74205f4';

function refundBody(overrides = {}) {
  return { orderId: ORDER, originStorefront: 'vantalabsresearch.com', transactionId: ORIGINAL, amountCents: 1500, currency: 'USD', cardNumberMasked: '1111', ...overrides };
}

async function call(fn, ctx, { body, key = 'vskin:refund:order-1:1', path }) {
  const { req, rawBody } = signedRequest({ path, body, idempotencyKey: key });
  try {
    return await fn(req, rawBody, ctx.deps);
  } catch (error) {
    return toErrorResponse(error, { operation: fn === handleRefund ? 'refund' : 'void' });
  }
}

const refund = (ctx, opts) => call(handleRefund, ctx, { path: '/api/payments/refund', ...opts });
const voidTx = (ctx, opts) => call(handleVoid, ctx, { path: '/api/payments/void', key: 'vskin:void:order-1:1', ...opts });

test('refund: new refund transId and the original transId are returned separately', async () => {
  const ctx = makeDeps({ gateway: createFakeGateway({ refund: async () => gatewayResult('captured', { transactionId: REFUND_TX, cardLast4: null, cardType: null }) }) });
  const res = await refund(ctx, { body: refundBody() });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.outcome, 'captured');
  assert.equal(res.body.paymentStatus, 'refunded');
  assert.equal(res.body.transactionId, REFUND_TX);
  assert.equal(res.body.originalTransactionId, ORIGINAL);
  assert.equal(res.body.amountCents, 1500);

  const [row] = ctx.store.db.paymentEvents;
  assert.equal(row.action, 'refund');
  assert.equal(row.authnet_transaction_id, REFUND_TX);
  assert.equal(row.original_transaction_id, ORIGINAL);
  assert.equal(row.card_last4, '1111');

  const cb = ctx.labs.calls[0];
  assert.equal(cb.action, 'refund');
  assert.equal(cb.transactionId, REFUND_TX);
  assert.equal(cb.originalTransactionId, ORIGINAL);
  assert.equal(cb.amountCents, 1500);
  assert.equal(cb.paymentStatus, 'refunded');
  assert.equal(cb.eventId, `bridge:refund:vskin:refund:order-1:1:${REFUND_TX}:captured`);
});

test('refund: the gateway is given the masked last-4 reference and the original transId', async () => {
  const ctx = makeDeps({ gateway: createFakeGateway({ refund: async () => gatewayResult('captured', { transactionId: REFUND_TX }) }) });
  await refund(ctx, { body: refundBody({ cardNumberMasked: '4242' }) });
  const [, payload, opts] = ctx.gateway.calls[0].args;
  assert.equal(payload.cardNumberMasked, '4242');
  assert.equal(payload.transactionId, ORIGINAL);
  assert.equal(opts.refId.length, 20);
});

for (const [name, value] of [['missing', undefined], ['empty', ''], ['3 digits', '123'], ['5 digits', '12345'], ['full PAN', '4111111111111111'], ['letters', 'abcd'], ['number type', 1111]]) {
  test(`refund: cardNumberMasked ${name} → 400 invalid, no gateway call`, async () => {
    const ctx = makeDeps({ gateway: createFakeGateway({}) });
    const res = await refund(ctx, { body: refundBody({ cardNumberMasked: value }) });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.outcome, 'invalid');
    assert.equal(ctx.gateway.calls.length, 0);
    assert.equal(ctx.store.db.idempotency.size, 0);
  });
}

test('refund: non-USD currency → 400 invalid', async () => {
  const ctx = makeDeps({ gateway: createFakeGateway({}) });
  const res = await refund(ctx, { body: refundBody({ currency: 'CAD' }) });
  assert.equal(res.statusCode, 400);
});

test('refund: declined → 402 refund_failed', async () => {
  const ctx = makeDeps({ gateway: createFakeGateway({ refund: async () => gatewayResult('declined', { transactionId: null }) }) });
  const res = await refund(ctx, { body: refundBody() });
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.paymentStatus, 'refund_failed');
  assert.equal(res.body.originalTransactionId, ORIGINAL);
});

test('refund: gateway timeout → 502 uncertain, row uncertain, no callback', async () => {
  const ctx = makeDeps({ gateway: createFakeGateway({ refund: async () => gatewayResult('uncertain') }) });
  const res = await refund(ctx, { body: refundBody() });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.outcome, 'uncertain');
  assert.equal(res.body.paymentStatus, 'refund_uncertain');
  assert.equal(ctx.store.db.idempotency.get(`${REFUND_ENDPOINT}|vskin:refund:order-1:1`).status, 'uncertain');
  assert.equal(ctx.labs.calls.length, 0);
});

test('refund: same key replays, never refunds twice; in-progress key → 409', async () => {
  const ctx = makeDeps({ gateway: createFakeGateway({ refund: async () => gatewayResult('captured', { transactionId: REFUND_TX }) }) });
  await refund(ctx, { body: refundBody() });
  const again = await refund(ctx, { body: refundBody() });
  assert.equal(again.statusCode, 200);
  assert.equal(again.replayed, true);
  assert.equal(ctx.gateway.calls.length, 1);

  ctx.store.db.idempotency.set(`${REFUND_ENDPOINT}|k2`, { status: 'in_progress', request_hash: 'x' });
  const busy = await refund(ctx, { body: refundBody(), key: 'k2' });
  assert.equal(busy.statusCode, 409);
});

test('void: without amountCents uses the recorded charge amount; callback amount is non-null', async () => {
  const ctx = makeDeps({ gateway: createFakeGateway({ void: async () => gatewayResult('captured', { transactionId: ORIGINAL, cardLast4: null, cardType: null }) }) });
  ctx.store.db.paymentEvents.push({ action: 'charge', authnet_transaction_id: ORIGINAL, amount_cents: 4604, order_id: ORDER, outcome: 'captured' });
  const res = await voidTx(ctx, { body: { orderId: ORDER, originStorefront: 'vantalabsresearch.com', transactionId: ORIGINAL } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.paymentStatus, 'voided');
  assert.equal(res.body.transactionId, ORIGINAL);
  assert.equal(res.body.originalTransactionId, ORIGINAL);
  assert.equal(res.body.amountCents, 4604);
  assert.equal(ctx.labs.calls[0].amountCents, 4604);
  assert.equal(ctx.labs.calls[0].originalTransactionId, ORIGINAL);
});

test('void: unknown charge and no amountCents → 400 invalid, no gateway call', async () => {
  const ctx = makeDeps({ gateway: createFakeGateway({}) });
  const res = await voidTx(ctx, { body: { orderId: ORDER, originStorefront: 'vantalabsresearch.com', transactionId: '999' } });
  assert.equal(res.statusCode, 400);
  assert.equal(ctx.gateway.calls.length, 0);
});

test('void: rejected → 422 void_failed', async () => {
  const ctx = makeDeps({ gateway: createFakeGateway({ void: async () => gatewayResult('rejected') }) });
  const res = await voidTx(ctx, { body: { orderId: ORDER, originStorefront: 'vantalabsresearch.com', transactionId: ORIGINAL, amountCents: 4604 } });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.paymentStatus, 'void_failed');
  assert.equal(res.body.transactionId, null);
  assert.equal(res.body.originalTransactionId, ORIGINAL);
});
