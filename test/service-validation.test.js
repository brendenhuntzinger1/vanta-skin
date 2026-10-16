const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertChargeLineItemsAmount,
  assertNoSensitiveCardFields,
  mapWebhookEventToOrderStatus,
} = require('../api/_lib/service');
const { normalizeRefundCardReference } = require('../api/_lib/authnet');

test('assertNoSensitiveCardFields rejects raw card fields', () => {
  assert.throws(
    () => assertNoSensitiveCardFields({ cardNumber: '4111111111111111' }),
    /Sensitive field cardNumber is not allowed/,
  );
  assert.doesNotThrow(() => assertNoSensitiveCardFields({ opaqueData: { dataValue: 'tok' } }));
});

test('assertChargeLineItemsAmount validates line item sum', () => {
  assert.doesNotThrow(() => {
    assertChargeLineItemsAmount({
      amountCents: 300,
      lineItems: [
        { quantity: 1, unitPriceCents: 100 },
        { quantity: 2, unitPriceCents: 100 },
      ],
    });
  });

  assert.throws(
    () => assertChargeLineItemsAmount({
      amountCents: 301,
      lineItems: [
        { quantity: 1, unitPriceCents: 100 },
        { quantity: 2, unitPriceCents: 100 },
      ],
    }),
    /does not match amountCents/,
  );
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
