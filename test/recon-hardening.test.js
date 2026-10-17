const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { SIGNATURE_KEY, chargeBody, createFakeGateway, gatewayResult, makeDeps, signedRequest } = require('./support/fakes');
const { CHARGE_ENDPOINT, handleCharge, handleReconcile, handleWebhook, toErrorResponse } = require('../api/_lib/service');
const { createGateway, invoiceNumberFor, mapGatewayResponse } = require('../api/_lib/authnet');
const { createStore } = require('../api/_lib/supabase');

// Reconciliation hardening (final readiness audit 2026-10-17, B H2 / M2, A L6).
// Fakes only: no network, no Authorize.Net, no database.

const ORDER = 'order-2f5da385-b1b1-42be-a806-80adb74205f4';
const KEY = `vskin:charge:${ORDER}:1`;
const INVOICE = invoiceNumberFor({ orderId: ORDER });
const NOW = new Date('2026-10-16T12:00:00.000Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60 * 1000).toISOString();

// ---------------------------------------------------------------------------
// (a) An Authorize.Net capture for a charge Skin recorded as uncertain, or
//     never recorded, is matched by its VS- invoice and amount and forwarded
//     to Labs for review instead of dropped.
// ---------------------------------------------------------------------------

function sign(raw) {
  return `sha512=${createHmac('sha512', SIGNATURE_KEY).update(raw, 'utf8').digest('hex').toUpperCase()}`;
}

function notification(payload, id = `n-${Math.random()}`) {
  return JSON.stringify({ notificationId: id, eventType: 'net.authorize.payment.authcapture.created', eventDate: '2026-10-16T12:00:00Z', webhookId: 'w1', payload });
}

const authcapture = (overrides = {}) => ({ responseCode: 1, authCode: 'ABC123', authAmount: 46.04, entityName: 'transaction', id: '60277777777', invoiceNumber: INVOICE, ...overrides });

async function deliver(ctx, raw) {
  try {
    return await handleWebhook(raw, sign(raw), ctx.deps);
  } catch (error) {
    return toErrorResponse(error, { operation: 'webhook' });
  }
}

function withUncertainCharge(ctx, overrides = {}) {
  ctx.store.db.paymentEvents.push({
    action: 'charge', order_id: ORDER, origin_storefront: 'vantalabsresearch.com', authnet_transaction_id: null,
    amount_cents: 4604, currency: 'USD', status: 'pending', outcome: 'uncertain', idempotency_key: KEY,
    created_at: minutesAgo(30), ...overrides,
  });
  return ctx;
}

test('a capture for a charge recorded as uncertain is matched by VS- invoice and amount and forwarded for review', async () => {
  const ctx = withUncertainCharge(makeDeps({ now: () => NOW }));
  const res = await deliver(ctx, notification(authcapture()));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.forwarded, true);
  assert.equal(res.body.verification, 'matched_by_invoice');
  assert.equal(ctx.labs.calls.length, 1);
  const cb = ctx.labs.calls[0];
  assert.equal(cb.action, 'webhook_update');
  assert.equal(cb.outcome, 'captured');
  assert.equal(cb.paymentStatus, 'paid');
  assert.equal(cb.orderId, ORDER);
  assert.equal(cb.attemptKey, KEY);
  assert.equal(cb.transactionId, '60277777777');
  assert.equal(cb.amountCents, 4604);
  assert.equal(cb.reviewReason, 'unknown_transaction');
  const stored = [...ctx.store.db.webhooks.values()][0];
  assert.equal(stored.verification, 'matched_by_invoice');
  assert.equal(stored.reconciled_order_id, ORDER);
});

test('a capture for a charge with only an in-progress claim (no payment event at all) is matched through the attempt key', async () => {
  const ctx = makeDeps({ now: () => NOW });
  ctx.store.db.idempotency.set(`${CHARGE_ENDPOINT}|${KEY}`, { status: 'in_progress', request_hash: 'h', created_at: minutesAgo(20) });
  const res = await deliver(ctx, notification(authcapture()));
  assert.equal(res.body.forwarded, true);
  const cb = ctx.labs.calls[0];
  assert.equal(cb.orderId, ORDER);
  assert.equal(cb.attemptKey, KEY);
  assert.equal(cb.amountCents, 4604);
});

test('a capture for a charge recorded as held (same transaction) is forwarded for review', async () => {
  const ctx = withUncertainCharge(makeDeps({ now: () => NOW }), { outcome: 'held', status: 'held', authnet_transaction_id: '60277777777' });
  const res = await deliver(ctx, notification(authcapture()));
  assert.equal(res.body.forwarded, true);
  assert.equal(ctx.labs.calls[0].reviewReason, 'recorded_outcome_not_captured');
  assert.equal(ctx.labs.calls[0].attemptKey, KEY);
});

test('two uncertain attempts for the order: forwarded for the order, without guessing which attempt', async () => {
  const ctx = withUncertainCharge(makeDeps({ now: () => NOW }));
  withUncertainCharge(ctx, { idempotency_key: `vskin:charge:${ORDER}:2`, created_at: minutesAgo(10) });
  const res = await deliver(ctx, notification(authcapture()));
  assert.equal(res.body.forwarded, true);
  assert.equal(ctx.labs.calls[0].orderId, ORDER);
  assert.equal(ctx.labs.calls[0].attemptKey, null);
});

test('never forwarded: another order\'s invoice, a different amount, a declined record, a non-VS- invoice', async () => {
  for (const [label, arrange, payload] of [
    ['other invoice', () => {}, authcapture({ invoiceNumber: invoiceNumberFor({ orderId: 'order-other' }) })],
    ['other amount', () => {}, authcapture({ authAmount: 46.05 })],
    ['not a VS- invoice', () => {}, authcapture({ invoiceNumber: 'VL-10042' })],
    ['declined record', (ctx) => { ctx.store.db.paymentEvents[0].outcome = 'declined'; }, authcapture()],
  ]) {
    const ctx = withUncertainCharge(makeDeps({ now: () => NOW }));
    arrange(ctx);
    const res = await deliver(ctx, notification(payload));
    assert.equal(res.body.forwarded, false, label);
    assert.equal(ctx.labs.calls.length, 0, label);
  }
});

test('records older than the match window are not candidates', async () => {
  const ctx = withUncertainCharge(makeDeps({ now: () => NOW }), { created_at: new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString() });
  const res = await deliver(ctx, notification(authcapture()));
  assert.equal(res.body.forwarded, false);
});

test('a records failure while matching answers 500, so Authorize.Net redelivers (nothing recorded yet)', async () => {
  const ctx = withUncertainCharge(makeDeps({ now: () => NOW }));
  ctx.store.fail.listRecentChargeRecords = new Error('db down');
  const res = await deliver(ctx, notification(authcapture()));
  assert.equal(res.statusCode, 500);
  assert.equal(ctx.store.db.webhooks.size, 0);
  assert.equal(ctx.labs.calls.length, 0);
});

// ---------------------------------------------------------------------------
// (b) Several captured matches for one invoice: a distinct answer with every id.
// ---------------------------------------------------------------------------

function reconcileBody(overrides = {}) {
  return { orderId: ORDER, idempotencyKey: KEY, invoiceNumber: INVOICE, amountCents: 4604, attemptStartedAt: minutesAgo(40), knownTransactionIds: [], ...overrides };
}

function tx(overrides = {}) {
  return { transId: '60212345678', submitTimeUTC: minutesAgo(39), invoiceNumber: INVOICE, settleAmount: 46.04, transactionStatus: 'capturedPendingSettlement', accountType: 'Visa', accountNumber: 'XXXX1111', ...overrides };
}

function reconcileCtx({ unsettled = [], settled = [], details } = {}) {
  const gateway = createFakeGateway({
    getUnsettledTransactionList: async () => unsettled,
    getRecentSettledTransactions: async () => settled,
    getTransactionDetails: async (_c, id) => (details ? details(id) : { transId: id, transactionStatus: 'capturedPendingSettlement', authAmount: 46.04, payment: { creditCard: { cardNumber: 'XXXX4242', cardType: 'Visa' } } }),
  });
  const ctx = makeDeps({ gateway, now: () => NOW });
  ctx.store.db.idempotency.set(`${CHARGE_ENDPOINT}|${KEY}`, { status: 'uncertain', request_hash: 'h', created_at: minutesAgo(40) });
  return ctx;
}

async function reconcile(ctx, payload = reconcileBody()) {
  const { req, rawBody } = signedRequest({ path: '/api/payments/reconcile', body: payload });
  try {
    return await handleReconcile(req, rawBody, ctx.deps);
  } catch (error) {
    return toErrorResponse(error, { operation: 'reconcile' });
  }
}

test('two captured transactions for one attempt → multiple_captures with every id, never the first alone', async () => {
  const ctx = reconcileCtx({ unsettled: [tx({ transId: 'A' }), tx({ transId: 'B', submitTimeUTC: minutesAgo(30) })] });
  const res = await reconcile(ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.outcome, 'multiple_captures');
  assert.deepEqual(res.body.captures.map((c) => c.transactionId).sort(), ['A', 'B']);
  assert.ok(['A', 'B'].includes(res.body.transactionId));
  for (const c of res.body.captures) assert.equal(c.amountCents, 4604);
});

test('a second capture is found even when one is unsettled and the other already settled', async () => {
  const ctx = reconcileCtx({ unsettled: [tx({ transId: 'A' })], settled: [tx({ transId: 'S', transactionStatus: 'settledSuccessfully' })] });
  const res = await reconcile(ctx);
  assert.equal(res.body.outcome, 'multiple_captures');
  assert.deepEqual(res.body.captures.map((c) => c.transactionId).sort(), ['A', 'S']);
});

test('the same transaction in both listings is one capture', async () => {
  const ctx = reconcileCtx({ unsettled: [tx({ transId: 'A' })], settled: [tx({ transId: 'A', transactionStatus: 'settledSuccessfully' })] });
  const res = await reconcile(ctx);
  assert.equal(res.body.outcome, 'captured');
  assert.equal(res.body.transactionId, 'A');
});

test('a duplicate the merchant voided is not a second capture', async () => {
  const ctx = reconcileCtx({
    unsettled: [tx({ transId: 'A' }), tx({ transId: 'V' })],
    details: (id) => ({ transId: id, transactionStatus: id === 'V' ? 'voided' : 'capturedPendingSettlement', authAmount: 46.04 }),
  });
  const res = await reconcile(ctx);
  assert.equal(res.body.outcome, 'captured');
  assert.equal(res.body.transactionId, 'A');
});

test('an incomplete (truncated) listing never proves not_found', async () => {
  const truncated = [];
  Object.defineProperty(truncated, 'truncated', { value: true });
  const ctx = reconcileCtx({ unsettled: truncated });
  const res = await reconcile(ctx);
  assert.equal(res.body.outcome, 'pending');
});

// ---------------------------------------------------------------------------
// (c) Paging: more than one page of transactions, bounded.
// ---------------------------------------------------------------------------

const lookupConfig = { authnet: { apiLoginId: 'l', transactionKey: 't', sandbox: true, timeoutMs: 20000 } };

function pagedExecutor(pages) {
  const seen = [];
  const execute = async (json, { controller }) => {
    const req = json.getUnsettledTransactionListRequest || json.getTransactionListRequest;
    if (controller === 'GetSettledBatchListController') return { messages: { resultCode: 'Ok' }, batchList: { batch: [{ batchId: 'b1' }] } };
    seen.push({ controller, offset: req.paging.offset, limit: req.paging.limit });
    const page = pages[req.paging.offset - 1] || [];
    return { messages: { resultCode: 'Ok' }, transactions: { transaction: page.map((transId) => ({ transId })) } };
  };
  return { execute, seen };
}

test('the unsettled list is read page by page until a short page', async () => {
  const { execute, seen } = pagedExecutor([['1', '2'], ['3', '4'], ['5']]);
  const gateway = createGateway({ execute, pageSize: 2, maxPages: 5 });
  const list = await gateway.getUnsettledTransactionList(lookupConfig);
  assert.deepEqual(list.map((t) => t.transId), ['1', '2', '3', '4', '5']);
  assert.deepEqual(seen.map((s) => s.offset), [1, 2, 3]);
  assert.ok(seen.every((s) => s.limit === 2));
  assert.equal(list.truncated, undefined);
});

test('paging is bounded: past the last allowed page the list is marked truncated', async () => {
  const { execute, seen } = pagedExecutor([['1', '2'], ['3', '4'], ['5', '6'], ['7', '8']]);
  const gateway = createGateway({ execute, pageSize: 2, maxPages: 3 });
  const list = await gateway.getUnsettledTransactionList(lookupConfig);
  assert.equal(seen.length, 3);
  assert.equal(list.length, 6);
  assert.equal(list.truncated, true);
});

test('each settled batch is paged too, and truncation carries through', async () => {
  const { execute } = pagedExecutor([['1', '2'], ['3', '4']]);
  const gateway = createGateway({ execute, pageSize: 2, maxPages: 2 });
  const list = await gateway.getRecentSettledTransactions(lookupConfig, { now: NOW, days: 2 });
  assert.deepEqual(list.map((t) => t.transId), ['1', '2', '3', '4']);
  assert.equal(list.truncated, true);
});

test('the default page size is the gateway maximum, 1000', async () => {
  const { execute, seen } = pagedExecutor([['1']]);
  await createGateway({ execute }).getUnsettledTransactionList(lookupConfig);
  assert.equal(seen[0].limit, 1000);
});

// ---------------------------------------------------------------------------
// (d) AVS and CVV result codes are kept in their own columns.
// ---------------------------------------------------------------------------

test('the gateway answer carries the AVS and CVV result codes, cleaned', () => {
  const r = mapGatewayResponse({ messages: { resultCode: 'Ok' }, transactionResponse: { responseCode: '1', transId: '6001', avsResultCode: 'y', cvvResultCode: 'M' } });
  assert.equal(r.avsResultCode, 'Y');
  assert.equal(r.cvvResultCode, 'M');
  const odd = mapGatewayResponse({ messages: { resultCode: 'Ok' }, transactionResponse: { responseCode: '2', transId: '6002', avsResultCode: '<script>', cvvResultCode: '' } });
  assert.equal(odd.avsResultCode, null);
  assert.equal(odd.cvvResultCode, null);
});

test('a charge stores AVS and CVV codes in payment_events columns, alongside (not instead of) the response', async () => {
  const gateway = createFakeGateway({ charge: async () => gatewayResult('declined', { avsResultCode: 'N', cvvResultCode: 'N' }) });
  const ctx = makeDeps({ gateway });
  const { req, rawBody } = signedRequest({ body: chargeBody(), idempotencyKey: KEY });
  await handleCharge(req, rawBody, ctx.deps);
  const [row] = ctx.store.db.paymentEvents;
  assert.equal(row.avs_result_code, 'N');
  assert.equal(row.cvv_result_code, 'N');
  assert.ok(row.response_payload);
});

function fakeClient(respond) {
  const queries = [];
  return {
    queries,
    from(table) {
      const ops = [];
      queries.push({ table, ops });
      const builder = {};
      for (const name of ['insert', 'select', 'eq', 'in', 'gte', 'order', 'limit']) {
        builder[name] = (...args) => { ops.push([name, ...args]); return builder; };
      }
      builder.then = (resolve, reject) => Promise.resolve(respond(table, ops, queries.length)).then(resolve, reject);
      return builder;
    },
  };
}

test('before the AVS/CVV migration is applied, a payment event is still stored, without those two columns', async () => {
  const client = fakeClient((_t, _o, n) => (n === 1
    ? { error: { code: 'PGRST204', message: "Could not find the 'avs_result_code' column of 'payment_events' in the schema cache" } }
    : { error: null }));
  const result = await createStore(client).recordPaymentEvent({ order_id: 'o', action: 'charge', avs_result_code: 'Y', cvv_result_code: 'M' });
  assert.deepEqual(result, { inserted: true });
  assert.equal(client.queries.length, 2);
  assert.deepEqual(client.queries[1].ops[0][1], { order_id: 'o', action: 'charge' });
});

test('any other insert error is still an error', async () => {
  const client = fakeClient(() => ({ error: { code: '08006', message: 'connection failure' } }));
  await assert.rejects(createStore(client).recordPaymentEvent({ order_id: 'o', action: 'charge', avs_result_code: 'Y' }), /Unable to store payment event/);
  assert.equal(client.queries.length, 1);
});

test('listRecentChargeRecords reads recent charge events and charge claims, bounded', async () => {
  const client = fakeClient((table) => ({ data: table === 'payment_events' ? [{ order_id: 'o' }] : [{ idempotency_key: 'k' }], error: null }));
  const out = await createStore(client).listRecentChargeRecords({ since: '2026-10-09T12:00:00.000Z', limit: 50 });
  assert.deepEqual(out, { events: [{ order_id: 'o' }], claims: [{ idempotency_key: 'k' }] });
  const [events, claims] = client.queries;
  assert.equal(events.table, 'payment_events');
  assert.deepEqual(events.ops.find((o) => o[0] === 'eq'), ['eq', 'action', 'charge']);
  assert.deepEqual(events.ops.find((o) => o[0] === 'gte'), ['gte', 'created_at', '2026-10-09T12:00:00.000Z']);
  assert.deepEqual(events.ops.find((o) => o[0] === 'limit'), ['limit', 50]);
  assert.equal(claims.table, 'payment_idempotency');
  assert.deepEqual(claims.ops.find((o) => o[0] === 'eq'), ['eq', 'endpoint', CHARGE_ENDPOINT]);
});

test('the AVS/CVV migration adds the columns idempotently and backfills from the stored response', () => {
  const dir = path.join(__dirname, '..', 'supabase', 'migrations');
  const file = fs.readdirSync(dir).find((f) => /avs_cvv/.test(f));
  assert.ok(file, 'migration file present');
  const sql = fs.readFileSync(path.join(dir, file), 'utf8');
  assert.match(sql, /add column if not exists avs_result_code/);
  assert.match(sql, /add column if not exists cvv_result_code/);
  assert.match(sql, /response_payload\s*->\s*'transactionResponse'\s*->>\s*'avsResultCode'/);
});
