const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeGateway, makeDeps, signedRequest } = require('./support/fakes');
const { REFUND_ENDPOINT, VOID_ENDPOINT, handleReconcile, toErrorResponse } = require('../api/_lib/service');

// Reconciling a refund or void whose result was lost. Every gateway call is a
// fake; the real SDK executor throws if anything reaches it.

const ORDER = 'order-2f5da385-b1b1-42be-a806-80adb74205f4';
const CHARGE_TX = '60212345678';
const REFUND_KEY = `vskin:refund:${ORDER}:1`;
const VOID_KEY = `vskin:void:${ORDER}`;
const NOW = new Date('2026-10-16T12:00:00.000Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60 * 1000).toISOString();

function body(overrides = {}) {
  return {
    operation: 'refund', orderId: ORDER, idempotencyKey: REFUND_KEY, originalTransactionId: CHARGE_TX,
    amountCents: 1500, attemptStartedAt: minutesAgo(40), knownTransactionIds: [], ...overrides,
  };
}

const refundTx = (overrides = {}) => ({
  transId: '70000000001', submitTimeUTC: minutesAgo(39), settleAmount: 15, transactionStatus: 'refundPendingSettlement', ...overrides,
});

function ctxWith({ unsettled = [], settled = [], details = () => ({}), unsettledError, settledError, detailsError } = {}) {
  const gateway = createFakeGateway({
    getUnsettledTransactionList: async () => { if (unsettledError) throw unsettledError; return unsettled; },
    getRecentSettledTransactions: async () => { if (settledError) throw settledError; return settled; },
    getTransactionDetails: async (_c, id) => { if (detailsError) throw detailsError; return details(String(id)); },
  });
  return makeDeps({ gateway, now: () => NOW });
}

async function reconcile(ctx, payload = body()) {
  const { req, rawBody } = signedRequest({ path: '/api/payments/reconcile', body: payload });
  try {
    return await handleReconcile(req, rawBody, ctx.deps);
  } catch (error) {
    return toErrorResponse(error, { operation: 'reconcile' });
  }
}

const noMoneyMoved = (ctx) => assert.ok(ctx.gateway.calls.every((c) => !['charge', 'refund', 'void'].includes(c.name)));

test('refund: a completed Skin record answers without the gateway', async () => {
  const ctx = ctxWith();
  ctx.store.db.idempotency.set(`${REFUND_ENDPOINT}|${REFUND_KEY}`, {
    status: 'completed', request_hash: 'h', response_status: 200,
    response_body: { orderId: ORDER, outcome: 'captured', transactionId: '70000000001', originalTransactionId: CHARGE_TX, amountCents: 1500 },
  });
  const res = await reconcile(ctx);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    ok: true, orderId: ORDER, operation: 'refund', outcome: 'captured', transactionId: '70000000001',
    originalTransactionId: CHARGE_TX, amountCents: 1500, source: 'skin_record',
  });
  assert.equal(ctx.gateway.calls.length, 0);
});

test('refund: a Skin record for a different charge is not trusted', async () => {
  const ctx = ctxWith({ unsettled: [], settled: [] });
  ctx.store.db.idempotency.set(`${REFUND_ENDPOINT}|${REFUND_KEY}`, {
    status: 'completed', request_hash: 'h', created_at: minutesAgo(40),
    response_body: { orderId: ORDER, outcome: 'captured', transactionId: '7', originalTransactionId: 'someone-else' },
  });
  const res = await reconcile(ctx);
  assert.equal(res.body.source, 'gateway_lookup');
  assert.equal(res.body.outcome, 'not_found');
});

test('refund: found at the gateway only when its details reference this charge', async () => {
  const ctx = ctxWith({
    unsettled: [refundTx({ transId: '70000000009' }), refundTx()],
    details: (id) => ({ transId: id, transactionType: 'refundTransaction', refTransId: id === '70000000001' ? CHARGE_TX : 'another-charge', settleAmount: 15 }),
  });
  const res = await reconcile(ctx);
  assert.equal(res.body.outcome, 'captured');
  assert.equal(res.body.transactionId, '70000000001');
  assert.equal(res.body.originalTransactionId, CHARGE_TX);
  assert.equal(res.body.amountCents, 1500);
  noMoneyMoved(ctx);
});

test('refund: other amounts, earlier transactions, known refunds and non-refunds are ignored', async () => {
  const ctx = ctxWith({
    unsettled: [
      refundTx({ transId: '1', settleAmount: 15.01 }),
      refundTx({ transId: '2', submitTimeUTC: minutesAgo(90) }),
      refundTx({ transId: '3' }),
      refundTx({ transId: '4', transactionStatus: 'capturedPendingSettlement' }),
    ],
    details: (id) => ({ transId: id, transactionType: 'refundTransaction', refTransId: CHARGE_TX }),
  });
  const res = await reconcile(ctx, body({ knownTransactionIds: ['3'] }));
  assert.equal(res.body.outcome, 'not_found');
});

test('refund: settled refunds are searched too', async () => {
  const ctx = ctxWith({
    settled: [refundTx({ transactionStatus: 'refundSettledSuccessfully' })],
    details: (id) => ({ transId: id, transactionType: 'refundTransaction', refTransId: CHARGE_TX }),
  });
  assert.equal((await reconcile(ctx)).body.outcome, 'captured');
});

test('refund: too early to say, or a failed lookup, is pending — never not_found', async () => {
  assert.equal((await reconcile(ctxWith(), body({ attemptStartedAt: minutesAgo(5) }))).body.outcome, 'pending');
  assert.equal((await reconcile(ctxWith({ unsettledError: new Error('timeout') }))).body.outcome, 'pending');
  assert.equal((await reconcile(ctxWith({
    unsettled: [refundTx()], detailsError: new Error('timeout'),
  }))).body.outcome, 'pending');
});

test('void: the charge reads voided → the void happened', async () => {
  const ctx = ctxWith({ details: () => ({ transId: CHARGE_TX, transactionStatus: 'voided' }) });
  const res = await reconcile(ctx, body({ operation: 'void', idempotencyKey: VOID_KEY, amountCents: 4604 }));
  assert.equal(res.body.outcome, 'captured');
  assert.equal(res.body.transactionId, CHARGE_TX);
  noMoneyMoved(ctx);
});

test('void: a settled charge was certainly not voided', async () => {
  const ctx = ctxWith({ details: () => ({ transId: CHARGE_TX, transactionStatus: 'settledSuccessfully' }) });
  const res = await reconcile(ctx, body({ operation: 'void', idempotencyKey: VOID_KEY, amountCents: 4604 }));
  assert.equal(res.body.outcome, 'rejected');
});

test('void: still captured — not_found once old enough, pending before', async () => {
  const details = () => ({ transId: CHARGE_TX, transactionStatus: 'capturedPendingSettlement' });
  const old = await reconcile(ctxWith({ details }), body({ operation: 'void', idempotencyKey: VOID_KEY }));
  assert.equal(old.body.outcome, 'not_found');
  const fresh = await reconcile(ctxWith({ details }), body({ operation: 'void', idempotencyKey: VOID_KEY, attemptStartedAt: minutesAgo(5) }));
  assert.equal(fresh.body.outcome, 'pending');
});

test('void: a recorded Skin void answers without the gateway', async () => {
  const ctx = ctxWith();
  ctx.store.db.idempotency.set(`${VOID_ENDPOINT}|${VOID_KEY}`, {
    status: 'completed', request_hash: 'h',
    response_body: { orderId: ORDER, outcome: 'declined', transactionId: null, originalTransactionId: CHARGE_TX },
  });
  const res = await reconcile(ctx, body({ operation: 'void', idempotencyKey: VOID_KEY }));
  assert.equal(res.body.outcome, 'declined');
  assert.equal(res.body.source, 'skin_record');
  assert.equal(ctx.gateway.calls.length, 0);
});

test('a refund/void reconcile without the original transaction is refused', async () => {
  const res = await reconcile(ctxWith(), body({ originalTransactionId: undefined }));
  assert.equal(res.statusCode, 400);
  const bad = await reconcile(ctxWith(), body({ operation: 'capture' }));
  assert.equal(bad.statusCode, 400);
});
