const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeGateway, makeDeps, signedRequest, testConfig } = require('./support/fakes');
const { CHARGE_ENDPOINT, handleReconcile, outcomeForTransactionStatus, toErrorResponse } = require('../api/_lib/service');

const ORDER = 'order-2f5da385-b1b1-42be-a806-80adb74205f4';
const KEY = `vskin:charge:${ORDER}:1`;
const NOW = new Date('2026-10-16T12:00:00.000Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60 * 1000).toISOString();

function body(overrides = {}) {
  return { orderId: ORDER, idempotencyKey: KEY, invoiceNumber: 'VL-10042', amountCents: 4604, attemptStartedAt: minutesAgo(40), knownTransactionIds: [], ...overrides };
}

function tx(overrides = {}) {
  return { transId: '60212345678', submitTimeUTC: minutesAgo(39), invoiceNumber: 'VL-10042', settleAmount: 46.04, transactionStatus: 'capturedPendingSettlement', accountType: 'Visa', accountNumber: 'XXXX1111', ...overrides };
}

function ctxWith({ unsettled = [], settled = [], details, unsettledError, settledError } = {}) {
  const gateway = createFakeGateway({
    getUnsettledTransactionList: async () => { if (unsettledError) throw unsettledError; return unsettled; },
    getRecentSettledTransactions: async () => { if (settledError) throw settledError; return settled; },
    getTransactionDetails: async (_c, id) => (details ? details(id) : { transId: id, transactionStatus: 'capturedPendingSettlement', authAmount: 46.04, payment: { creditCard: { cardNumber: 'XXXX4242', cardType: 'MasterCard' } } }),
  });
  return makeDeps({ gateway, now: () => NOW });
}

async function reconcile(ctx, payload = body(), opts = {}) {
  const { req, rawBody } = opts.request || signedRequest({ path: '/api/payments/reconcile', body: payload });
  try {
    return await handleReconcile(req, rawBody, ctx.deps);
  } catch (error) {
    return toErrorResponse(error, { operation: 'reconcile' });
  }
}

test('a completed Skin record answers from skin_record without touching the gateway', async () => {
  const ctx = ctxWith();
  ctx.store.db.idempotency.set(`${CHARGE_ENDPOINT}|${KEY}`, {
    status: 'completed', request_hash: 'h', response_status: 200,
    response_body: { orderId: ORDER, outcome: 'captured', transactionId: '60212345678', cardLast4: '1111', cardType: 'Visa', amountCents: 4604 },
  });
  const res = await reconcile(ctx);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, orderId: ORDER, outcome: 'captured', transactionId: '60212345678', cardLast4: '1111', cardType: 'Visa', amountCents: 4604, source: 'skin_record' });
  assert.equal(ctx.gateway.calls.length, 0);
});

test('a recorded declined attempt is reported declined from skin_record', async () => {
  const ctx = ctxWith();
  ctx.store.db.paymentEvents.push({ action: 'charge', idempotency_key: KEY, order_id: ORDER, outcome: 'declined', authnet_transaction_id: '602', amount_cents: 4604 });
  const res = await reconcile(ctx);
  assert.equal(res.body.outcome, 'declined');
  assert.equal(res.body.source, 'skin_record');
});

test('an in-progress/uncertain attempt is looked up at the gateway: captured, with card from details', async () => {
  const ctx = ctxWith({ unsettled: [tx({ invoiceNumber: 'OTHER' }), tx()] });
  ctx.store.db.idempotency.set(`${CHARGE_ENDPOINT}|${KEY}`, { status: 'uncertain', request_hash: 'h', created_at: minutesAgo(40) });
  const res = await reconcile(ctx);
  assert.equal(res.body.outcome, 'captured');
  assert.equal(res.body.source, 'gateway_lookup');
  assert.equal(res.body.transactionId, '60212345678');
  assert.equal(res.body.cardLast4, '4242');
  assert.equal(res.body.cardType, 'MasterCard');
  assert.equal(res.body.amountCents, 4604);
});

test('gateway lookup ignores other amounts, other invoices, earlier attempts and known transaction ids', async () => {
  const ctx = ctxWith({
    unsettled: [
      tx({ transId: '1', settleAmount: 46.05 }),
      tx({ transId: '2', invoiceNumber: 'VL-99999' }),
      tx({ transId: '3', submitTimeUTC: minutesAgo(60) }),
      tx({ transId: '4' }),
    ],
  });
  const res = await reconcile(ctx, body({ knownTransactionIds: ['4'] }));
  assert.equal(res.body.outcome, 'not_found');
});

test('a declined transaction found at the gateway → declined', async () => {
  const ctx = ctxWith({ unsettled: [tx({ transactionStatus: 'declined' })], details: (id) => ({ transId: id, transactionStatus: 'declined' }) });
  const res = await reconcile(ctx);
  assert.equal(res.body.outcome, 'declined');
});

test('a captured match wins over a declined one for the same attempt', async () => {
  const ctx = ctxWith({ unsettled: [tx({ transId: 'd', transactionStatus: 'declined' }), tx({ transId: 'c' })] });
  const res = await reconcile(ctx);
  assert.equal(res.body.transactionId, 'c');
  assert.equal(res.body.outcome, 'captured');
});

test('falls back to recently settled batches', async () => {
  const ctx = ctxWith({ unsettled: [], settled: [tx({ transactionStatus: 'settledSuccessfully' })] });
  const res = await reconcile(ctx);
  assert.equal(res.body.outcome, 'captured');
  assert.ok(ctx.gateway.calls.some((c) => c.name === 'getRecentSettledTransactions'));
});

test('nothing found, attempt ≥ 30 minutes old, lookups succeeded → not_found', async () => {
  const ctx = ctxWith();
  const res = await reconcile(ctx, body({ attemptStartedAt: minutesAgo(30) }));
  assert.equal(res.body.outcome, 'not_found');
});

test('nothing found but the attempt is younger than 30 minutes → pending', async () => {
  const ctx = ctxWith();
  const res = await reconcile(ctx, body({ attemptStartedAt: minutesAgo(10) }));
  assert.equal(res.body.outcome, 'pending');
});

test('nothing found and a lookup failed → pending, however old', async () => {
  for (const errs of [{ unsettledError: new Error('E00011') }, { settledError: new Error('timeout') }]) {
    const ctx = ctxWith(errs);
    const res = await reconcile(ctx, body({ attemptStartedAt: minutesAgo(600) }));
    assert.equal(res.body.outcome, 'pending');
  }
});

test('a young Skin claim keeps the answer pending even if Labs started earlier', async () => {
  const ctx = ctxWith();
  ctx.store.db.idempotency.set(`${CHARGE_ENDPOINT}|${KEY}`, { status: 'in_progress', request_hash: 'h', created_at: minutesAgo(5) });
  const res = await reconcile(ctx, body({ attemptStartedAt: minutesAgo(40) }));
  assert.equal(res.body.outcome, 'pending');
});

test('reconcile is signed: bad signature 401; nonce is stored (replay 409); bad input 400', async () => {
  const ctx = ctxWith();
  const bad = await reconcile(ctx, body(), { request: signedRequest({ path: '/api/payments/reconcile', body: body(), secret: 'nope' }) });
  assert.equal(bad.statusCode, 401);
  const request = signedRequest({ path: '/api/payments/reconcile', body: body(), nonce: 'n-fixed' });
  assert.equal((await reconcile(ctx, body(), { request })).statusCode, 200);
  assert.equal((await reconcile(ctx, body(), { request })).statusCode, 409);
  assert.equal((await reconcile(ctx, body({ attemptStartedAt: 'yesterday' }))).statusCode, 400);
  assert.equal((await reconcile(ctx, body({ amountCents: -1 }))).statusCode, 400);
});

test('reconcile never moves money: no charge/refund/void calls', async () => {
  const ctx = ctxWith({ unsettled: [tx()] });
  await reconcile(ctx);
  assert.equal(ctx.gateway.calls.some((c) => ['charge', 'refund', 'void'].includes(c.name)), false);
  assert.equal(ctx.store.db.idempotency.size, 0);
});

test('review and unknown statuses map to held, never to a guess', () => {
  assert.equal(outcomeForTransactionStatus('FDSPendingReview'), 'held');
  assert.equal(outcomeForTransactionStatus('underReview'), 'held');
  assert.equal(outcomeForTransactionStatus('somethingNew'), 'held');
  assert.equal(outcomeForTransactionStatus('settledSuccessfully'), 'captured');
  assert.equal(outcomeForTransactionStatus('generalError'), 'rejected');
});

test('reconcile refuses when live is requested but not approved', async () => {
  const ctx = ctxWith();
  ctx.deps.loadConfig = () => testConfig({ authnet: { configError: 'live_mode_not_approved', mode: 'misconfigured' } });
  const res = await reconcile(ctx);
  assert.equal(res.statusCode, 503);
});

// The charge goes to Authorize.Net under the storefront's order id as the
// invoice (schema-truncated to 20 chars). Labs may still send a legacy order
// number it recorded earlier. Both must match: a miss becomes not_found after
// 30 minutes and would invite the customer to pay again.
test('a lost charge is found under the order-id invoice even when Labs sends its legacy order number', async () => {
  const { invoiceNumberFor } = require('../api/_lib/authnet');
  const invoice = invoiceNumberFor({ orderId: ORDER });
  assert.equal(invoice, ORDER.slice(0, 20));
  const ctx = ctxWith({ unsettled: [tx({ invoiceNumber: invoice })] });
  const res = await reconcile(ctx, body({ invoiceNumber: 'VL-10042' }));
  assert.equal(res.body.outcome, 'captured');
  assert.equal(res.body.transactionId, '60212345678');
});

test('a charge recorded under a legacy invoice is still found by the recorded number', async () => {
  const ctx = ctxWith({ unsettled: [tx({ invoiceNumber: 'VL-10042' })] });
  const res = await reconcile(ctx, body({ invoiceNumber: 'VL-10042' }));
  assert.equal(res.body.outcome, 'captured');
});

test('another order\'s invoice is still never matched', async () => {
  const ctx = ctxWith({ unsettled: [tx({ invoiceNumber: 'order-SOMEONEELSE000' })] });
  const res = await reconcile(ctx, body({ invoiceNumber: 'VL-10042' }));
  assert.equal(res.body.outcome, 'not_found');
});
