const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertChargeLineItems,
  assertNoSensitiveCardFields,
  mapWebhookEventToOrderStatus,
  redactPaymentPayload,
} = require('../api/_lib/service');
const { buildChargeRequest, normalizeRefundCardReference } = require('../api/_lib/authnet');

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

// The transaction record at Authorize.net must say whose sale it is.
test('buildChargeRequest names the originating storefront and order, and itemises shipping and tax', () => {
  const config = { authnet: { apiLoginId: 'l', transactionKey: 't', merchantDescriptor: 'Vanta Skin payment service' } };
  const json = buildChargeRequest(config, {
    orderId: 'f7a1c2d3-0000-4000-8000-1234567890ab',
    orderNumber: 'VL-1042',
    originStorefront: 'vantalabsresearch.com',
    amountCents: 10_350,
    capture: true,
    shippingCents: 995,
    taxCents: 310,
    opaqueData: { dataDescriptor: 'COMMON.ACCEPT.INAPP.PAYMENT', dataValue: 'tok' },
    lineItems: [{ sku: 'bpc-157-10mg', name: 'BPC-157 10mg', quantity: 2, unitPriceCents: 4_500 }],
  }).getJSON().createTransactionRequest.transactionRequest;

  assert.equal(json.amount, '103.50');
  assert.equal(json.order.invoiceNumber, 'VL-1042');
  assert.equal(json.order.description, 'vantalabsresearch.com order VL-1042 | processed by Vanta Skin payment service');
  assert.equal(json.shipping.amount, '9.95');
  assert.equal(json.tax.amount, '3.10');
  assert.equal(json.lineItems.lineItem[0].name, 'BPC-157 10mg');
  assert.equal(json.lineItems.lineItem[0].unitPrice, '45.00');
});

test('buildChargeRequest falls back to the order id and leaves out zero shipping and tax', () => {
  const json = buildChargeRequest({ authnet: { apiLoginId: 'l', transactionKey: 't', merchantDescriptor: 'Vanta Skin' } }, {
    orderId: 'order-12345678901234567890',
    originStorefront: 'vanta.skin',
    amountCents: 100,
    opaqueData: { dataDescriptor: 'd', dataValue: 'v' },
  }).getJSON().createTransactionRequest.transactionRequest;
  assert.equal(json.order.invoiceNumber, 'order-12345678901234');
  assert.equal(json.order.description, 'vanta.skin order order-12345678901234567890 | processed by Vanta Skin');
  assert.equal(json.shipping, undefined);
  assert.equal(json.tax, undefined);
});

// The Accept.js nonce is single-use and expires, but it is still a payment
// credential: it is not kept in payment_events.request_payload.
test('redactPaymentPayload drops opaqueData.dataValue and keeps the rest', () => {
  const payload = { orderId: 'o', opaqueData: { dataDescriptor: 'COMMON.ACCEPT.INAPP.PAYMENT', dataValue: 'secret-token' } };
  const redacted = redactPaymentPayload(payload);
  assert.deepEqual(redacted, { orderId: 'o', opaqueData: { dataDescriptor: 'COMMON.ACCEPT.INAPP.PAYMENT', dataValue: '[redacted]' } });
  assert.equal(payload.opaqueData.dataValue, 'secret-token');
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
