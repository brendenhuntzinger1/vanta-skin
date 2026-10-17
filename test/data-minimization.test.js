const test = require('node:test');
const assert = require('node:assert/strict');
const { chargeBody, createFakeGateway, gatewayResult, makeDeps, signedRequest } = require('./support/fakes');
const { handleCharge, handleRefund, toErrorResponse } = require('../api/_lib/service');
const { buildChargeRequest } = require('../api/_lib/authnet');

// Data-exposure audit 2026-10-17, M2 and L2. Labs is the system of record for
// the customer; Skin keeps what reconciliation, refunds and disputes need
// (order, amounts, invoice, transaction id, card last 4 and type, the gateway's
// own result codes), and the names of the customer fields it forwarded, never
// their values.

const PII = ['shopper@example.com', '5125550100', 'Ada', 'Lovelace', '1 Main St', 'Austin', '78701', 'VL-10042'];

async function charge(ctx, body) {
  const { req, rawBody } = signedRequest({ body, idempotencyKey: 'vskin:charge:order-1:1' });
  try {
    return await handleCharge(req, rawBody, ctx.deps);
  } catch (error) {
    return toErrorResponse(error, { operation: 'charge' });
  }
}

test('a charge stores no customer PII in payment_events.request_payload', async () => {
  const ctx = makeDeps({ gateway: createFakeGateway({ charge: async () => gatewayResult('captured') }) });
  const res = await charge(ctx, chargeBody());
  assert.equal(res.statusCode, 200);

  const [row] = ctx.store.db.paymentEvents;
  const stored = JSON.stringify(row.request_payload);
  for (const value of PII) assert.equal(stored.includes(value), false, `${value} stored`);
  assert.equal(stored.includes('accept-js-token-SECRET'), false);

  assert.deepEqual(row.request_payload, {
    orderId: 'order-2f5da385-b1b1-42be-a806-80adb74205f4',
    attemptNo: 1,
    originStorefront: 'vantalabsresearch.com',
    amountCents: 4604,
    currency: 'USD',
    capture: true,
    requireSandbox: true,
    shippingCents: 995,
    taxCents: 0,
    opaqueData: { dataDescriptor: 'COMMON.ACCEPT.INAPP.PAYMENT', dataValue: '[redacted]' },
    sentCustomerFields: [
      'customer.email', 'customer.phone',
      'billTo.firstName', 'billTo.lastName', 'billTo.address', 'billTo.city', 'billTo.state', 'billTo.zip', 'billTo.country',
    ],
  });
  // The columns reconciliation and disputes read are unchanged.
  assert.equal(row.order_id, 'order-2f5da385-b1b1-42be-a806-80adb74205f4');
  assert.equal(row.amount_cents, 4604);
  assert.ok(row.authnet_transaction_id);
  assert.ok(row.response_payload);
});

test('a refund stores no masked card reference in request_payload (card_last4 keeps it)', async () => {
  const ctx = makeDeps({ gateway: createFakeGateway({ refund: async () => gatewayResult('captured', { transactionId: '60299990001', cardLast4: null, cardType: null }) }) });
  const body = { orderId: 'order-1', originStorefront: 'vantalabsresearch.com', transactionId: '60212345678', amountCents: 1500, currency: 'USD', cardNumberMasked: '1111' };
  const { req, rawBody } = signedRequest({ path: '/api/payments/refund', body, idempotencyKey: 'vskin:refund:order-1:1' });
  const res = await handleRefund(req, rawBody, ctx.deps);
  assert.equal(res.statusCode, 200);
  const [row] = ctx.store.db.paymentEvents;
  assert.deepEqual(row.request_payload, {
    orderId: 'order-1', originStorefront: 'vantalabsresearch.com', transactionId: '60212345678', amountCents: 1500, currency: 'USD',
  });
  assert.equal(row.card_last4, '1111');
});

// Labs no longer sends customer.firstName, customer.lastName or orderNumber.
// Skin never forwarded any of them, so what Authorize.Net receives is
// byte-for-byte the same with or without them.
test('the Authorize.Net request is identical without the fields Labs stopped sending', () => {
  const config = { authnet: { apiLoginId: 'login', transactionKey: 'key', merchantDescriptor: 'Vanta Skin' } };
  const before = chargeBody();
  const after = chargeBody({ customer: { email: before.customer.email, phone: before.customer.phone } });
  delete after.orderNumber;
  const json = (payload) => JSON.stringify(buildChargeRequest(config, payload, { refId: 'ref' }).getJSON());
  assert.equal(json(after), json(before));
});

// An unauthenticated caller learns only that it was refused; which check
// failed (key id, timestamp, signature, nonce) goes to the log.
test('authentication refusals name no check to the caller and log the reason', async () => {
  const ctx = makeDeps();
  const badSignature = signedRequest({ body: chargeBody(), idempotencyKey: 'k1', secret: 'wrong' });
  let res;
  try { res = await handleCharge(badSignature.req, badSignature.rawBody, ctx.deps); } catch (error) { res = toErrorResponse(error, { operation: 'charge' }); }
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.message, 'Request could not be authenticated');
  assert.deepEqual(ctx.logs.find((entry) => entry.event === 'auth_rejected'), { event: 'auth_rejected', reason: 'Invalid HMAC signature' });

  const replay = signedRequest({ body: chargeBody(), idempotencyKey: 'k2', nonce: 'fixed-nonce' });
  await charge(ctx, chargeBody()); // unrelated first request
  try { await handleCharge(replay.req, replay.rawBody, ctx.deps); } catch { /* first use */ }
  try { res = await handleCharge(replay.req, replay.rawBody, ctx.deps); } catch (error) { res = toErrorResponse(error, { operation: 'charge' }); }
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.message, 'Request could not be authenticated');
  assert.ok(ctx.logs.some((entry) => entry.event === 'auth_rejected' && entry.reason === 'replayed nonce'));
});
