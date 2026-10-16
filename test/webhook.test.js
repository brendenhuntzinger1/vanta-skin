const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { SIGNATURE_KEY, makeDeps, sha256Hex } = require('./support/fakes');
const { handleWebhook, toErrorResponse } = require('../api/_lib/service');

const CHARGE_TX = '60212345678';
const REFUND_TX = '60299990001';
const ORDER = 'order-2f5da385-b1b1-42be-a806-80adb74205f4';
const KEY = 'vskin:charge:order-2f5da385:1';

function sign(raw, key = SIGNATURE_KEY) {
  return `sha512=${createHmac('sha512', key).update(raw, 'utf8').digest('hex').toUpperCase()}`;
}

function event(eventType, payload, extra = {}) {
  return JSON.stringify({ notificationId: `n-${Math.random()}`, eventType, eventDate: '2026-10-16T12:00:00Z', webhookId: 'w1', payload, ...extra });
}

function seeded() {
  const ctx = makeDeps();
  ctx.store.db.paymentEvents.push(
    { action: 'charge', order_id: ORDER, origin_storefront: 'vantalabsresearch.com', authnet_transaction_id: CHARGE_TX, amount_cents: 4604, currency: 'USD', status: 'captured', outcome: 'captured', card_last4: '1111', card_type: 'Visa', idempotency_key: KEY },
    { action: 'charge', order_id: 'order-declined', origin_storefront: 'vantalabsresearch.com', authnet_transaction_id: '60200000002', amount_cents: 4604, currency: 'USD', status: 'declined', outcome: 'declined' },
    { action: 'refund', order_id: ORDER, origin_storefront: 'vantalabsresearch.com', authnet_transaction_id: REFUND_TX, original_transaction_id: CHARGE_TX, amount_cents: 1500, currency: 'USD', status: 'refunded', outcome: 'captured', card_last4: '1111' },
  );
  return ctx;
}

async function deliver(ctx, raw, signature = sign(raw)) {
  try {
    return await handleWebhook(raw, signature, ctx.deps);
  } catch (error) {
    return toErrorResponse(error, { operation: 'webhook' });
  }
}

const capture = (overrides = {}) => ({ responseCode: 1, authCode: 'ABC123', authAmount: 46.04, entityName: 'transaction', id: CHARGE_TX, ...overrides });

test('unsigned webhook → 401, nothing recorded, nothing forwarded', async () => {
  const ctx = seeded();
  const raw = event('net.authorize.payment.authcapture.created', capture());
  const res = await deliver(ctx, raw, null);
  assert.equal(res.statusCode, 401);
  assert.equal(ctx.store.db.webhooks.size, 0);
  assert.equal(ctx.labs.calls.length, 0);
});

test('forged signature → 401', async () => {
  const ctx = seeded();
  const raw = event('net.authorize.payment.authcapture.created', capture());
  const res = await deliver(ctx, raw, sign(raw, 'not-the-key'));
  assert.equal(res.statusCode, 401);
  assert.equal(ctx.labs.calls.length, 0);
});

test('a valid capture for a recorded captured charge is forwarded with the verified amount', async () => {
  const ctx = seeded();
  const raw = event('net.authorize.payment.authcapture.created', capture());
  const res = await deliver(ctx, raw);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.forwarded, true);
  assert.equal(ctx.labs.calls.length, 1);
  const cb = ctx.labs.calls[0];
  assert.equal(cb.action, 'webhook_update');
  assert.equal(cb.paymentStatus, 'paid');
  assert.equal(cb.outcome, 'captured');
  assert.equal(cb.amountCents, 4604);
  assert.equal(cb.transactionId, CHARGE_TX);
  assert.equal(cb.orderId, ORDER);
  assert.equal(cb.attemptKey, KEY);
  assert.equal(cb.cardLast4, '1111');
  assert.match(cb.eventId, /^webhook:n-/);
  const stored = [...ctx.store.db.webhooks.values()][0];
  assert.equal(stored.verification, 'verified');
  assert.equal(stored.reconciled_status, 'paid');
});

test('authcapture event with a declined responseCode is never "paid"', async () => {
  const ctx = seeded();
  const res = await deliver(ctx, event('net.authorize.payment.authcapture.created', capture({ responseCode: 2 })));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.forwarded, false);
  assert.equal(res.body.verification, 'not_approved');
  assert.equal(ctx.labs.calls.length, 0);
  assert.equal(ctx.store.db.webhooks.size, 1);
});

test('amount mismatch → recorded, not forwarded', async () => {
  const ctx = seeded();
  const res = await deliver(ctx, event('net.authorize.payment.authcapture.created', capture({ authAmount: 1.0 })));
  assert.equal(res.body.verification, 'amount_mismatch');
  assert.equal(ctx.labs.calls.length, 0);
});

test('unknown transaction → recorded, not forwarded', async () => {
  const ctx = seeded();
  const res = await deliver(ctx, event('net.authorize.payment.authcapture.created', capture({ id: '1234567' })));
  assert.equal(res.body.verification, 'unknown_transaction');
  assert.equal(ctx.labs.calls.length, 0);
});

test('a capture event for a charge this service recorded as declined is not forwarded', async () => {
  const ctx = seeded();
  const res = await deliver(ctx, event('net.authorize.payment.authcapture.created', capture({ id: '60200000002' })));
  assert.equal(res.body.verification, 'recorded_outcome_not_captured');
  assert.equal(ctx.labs.calls.length, 0);
});

test('the event name alone (no transaction, no amount) never produces paid', async () => {
  const ctx = seeded();
  for (const payload of [{}, { id: CHARGE_TX }, { id: CHARGE_TX, responseCode: 1 }]) {
    const res = await deliver(ctx, event('net.authorize.payment.authcapture.created', payload));
    assert.equal(res.body.forwarded, false);
  }
  assert.equal(ctx.labs.calls.length, 0);
});

test('a charge transId sent as a refund event does not match (refunds match refund rows)', async () => {
  const ctx = seeded();
  const res = await deliver(ctx, event('net.authorize.payment.refund.created', { responseCode: 1, authAmount: 46.04, id: CHARGE_TX }));
  assert.equal(res.body.verification, 'unknown_transaction');
});

test('a verified refund is forwarded with the refund transId and originalTransactionId', async () => {
  const ctx = seeded();
  const res = await deliver(ctx, event('net.authorize.payment.refund.created', { responseCode: 1, authAmount: 15.0, id: REFUND_TX }));
  assert.equal(res.body.forwarded, true);
  const cb = ctx.labs.calls[0];
  assert.equal(cb.paymentStatus, 'refunded');
  assert.equal(cb.transactionId, REFUND_TX);
  assert.equal(cb.originalTransactionId, CHARGE_TX);
  assert.equal(cb.amountCents, 1500);
});

test('other event types are recorded and not forwarded', async () => {
  const ctx = seeded();
  const res = await deliver(ctx, event('net.authorize.payment.authorization.created', capture()));
  assert.equal(res.body.verification, 'ignored_event_type');
  assert.equal(ctx.labs.calls.length, 0);
  assert.equal(ctx.store.db.webhooks.size, 1);
});

test('no notificationId → a stable id from sha256 of the body; a redelivery is a duplicate', async () => {
  const ctx = seeded();
  const raw = JSON.stringify({ eventType: 'net.authorize.payment.authcapture.created', payload: capture() });
  const first = await deliver(ctx, raw);
  const second = await deliver(ctx, raw);
  assert.deepEqual([...ctx.store.db.webhooks.keys()], [`sha256-${sha256Hex(raw)}`]);
  assert.equal(first.body.duplicate, false);
  assert.equal(second.body.duplicate, true);
  // The outbox row is keyed by the event id: delivered once, not again.
  assert.equal(ctx.store.db.outbox.length, 1);
  assert.equal(ctx.labs.calls.length, 1);
});

test('a database failure answers 500 so Authorize.Net redelivers', async () => {
  const ctx = seeded();
  ctx.store.fail.recordWebhookEvent = new Error('db down');
  const res = await deliver(ctx, event('net.authorize.payment.authcapture.created', capture()));
  assert.equal(res.statusCode, 500);
  assert.equal(JSON.stringify(res.body).includes('db down'), false);
});
