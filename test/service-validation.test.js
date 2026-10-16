const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertChargeLineItems,
  assertNoSensitiveCardFields,
  mapWebhookEventToOrderStatus,
  redactPaymentPayload,
} = require('../api/_lib/service');
const { normalizeRefundCardReference } = require('../api/_lib/authnet');

test('assertNoSensitiveCardFields rejects raw card fields', () => {
  assert.throws(
    () => assertNoSensitiveCardFields({ cardNumber: '4111111111111111' }),
    /Sensitive field cardNumber is not allowed/,
  );
  assert.doesNotThrow(() => assertNoSensitiveCardFields({ opaqueData: { dataValue: 'tok' } }));
});

// amountCents is the authoritative charge: the originating storefront computes
// it from the order and signs it. Line items list the real goods at their own
// prices; coupons, free items and credits mean they need not add up to it.
test('assertChargeLineItems accepts real line items that do not sum to the total', () => {
  assert.doesNotThrow(() => assertChargeLineItems({
    amountCents: 9_995,
    lineItems: [{ name: 'Item', quantity: 2, unitPriceCents: 4_500 }, { name: 'Free item', quantity: 1, unitPriceCents: 0 }],
  }));
  assert.doesNotThrow(() => assertChargeLineItems({ amountCents: 100 }));
});

test('assertChargeLineItems rejects malformed line items', () => {
  for (const bad of [
    { quantity: 0, unitPriceCents: 100 },
    { quantity: 1.5, unitPriceCents: 100 },
    { quantity: 1, unitPriceCents: -1 },
    { quantity: 1, unitPriceCents: 10.5 },
  ]) {
    assert.throws(() => assertChargeLineItems({ amountCents: 100, lineItems: [bad] }), /lineItems/);
  }
  assert.throws(() => assertChargeLineItems({ amountCents: 100, lineItems: 'x' }), /lineItems/);
  assert.throws(() => assertChargeLineItems({ amountCents: 100, shippingCents: -5 }), /shippingCents/);
  assert.throws(() => assertChargeLineItems({ amountCents: 100, taxCents: 1.5 }), /taxCents/);
});

// The Accept.js nonce is single-use and expires, but it is still a payment
// credential: it is not kept in payment_events.request_payload.
test('redactPaymentPayload drops opaqueData.dataValue and keeps the rest', () => {
  const payload = { orderId: 'o', opaqueData: { dataDescriptor: 'COMMON.ACCEPT.INAPP.PAYMENT', dataValue: 'secret-token' } };
  const redacted = redactPaymentPayload(payload);
  assert.deepEqual(redacted, { orderId: 'o', opaqueData: { dataDescriptor: 'COMMON.ACCEPT.INAPP.PAYMENT', dataValue: '[redacted]' } });
  assert.equal(payload.opaqueData.dataValue, 'secret-token');
});

// The payment session token is a bearer credential: it is redacted from
// payment_events.request_payload alongside the Accept.js nonce.
test('redactPaymentPayload drops paymentSession bearer tokens', () => {
  const payload = {
    orderId: 'o',
    paymentSession: 'vps_' + 'a'.repeat(64),
    opaqueData: { dataDescriptor: 'COMMON.ACCEPT.INAPP.PAYMENT', dataValue: 'secret-token' },
  };
  const redacted = redactPaymentPayload(payload);
  assert.equal(redacted.paymentSession, '[redacted]');
  assert.equal(redacted.opaqueData.dataValue, '[redacted]');
  assert.equal(redacted.orderId, 'o');
  assert.equal(JSON.stringify(redacted).includes('vps_'), false);
  assert.equal(payload.paymentSession.startsWith('vps_'), true);
});

test('mapWebhookEventToOrderStatus maps known event types', () => {
  assert.equal(mapWebhookEventToOrderStatus('net.authorize.payment.authcapture.created'), 'paid');
  assert.equal(mapWebhookEventToOrderStatus('net.authorize.payment.refund.created'), 'refunded');
  assert.equal(mapWebhookEventToOrderStatus('NET.AUTHORIZE.PAYMENT.VOID.CREATED'), 'voided');
  assert.equal(mapWebhookEventToOrderStatus('unknown.event'), null);
});

test('normalizeRefundCardReference accepts only safe formats', () => {
  assert.equal(normalizeRefundCardReference('1111'), 'XXXX1111');
  assert.equal(normalizeRefundCardReference('xxxx1111'), 'XXXX1111');
  assert.throws(() => normalizeRefundCardReference('4111111111111111'), /must be last 4 digits/);
});
