const test = require('node:test');
const assert = require('node:assert/strict');
const { assertLabsSyncConfigured, buildSyncEventKey, deliverSyncEvent } = require('../api/_lib/sync');

test('buildSyncEventKey for webhook uses event id', () => {
  assert.equal(buildSyncEventKey({ source: 'webhook', eventId: 'evt-1' }), 'webhook:evt-1');
});

test('buildSyncEventKey for bridge is deterministic', () => {
  const key = buildSyncEventKey({
    source: 'bridge',
    action: 'charge',
    idempotencyKey: 'idem-1',
    orderId: 'order-1',
    transactionId: 'tx-1',
    paymentStatus: 'captured',
  });
  assert.equal(key, 'bridge:charge:idem-1:order-1:tx-1:captured');
});

test('assertLabsSyncConfigured requires endpoint and hmac auth', () => {
  assert.equal(assertLabsSyncConfigured({ labsSync: {} }), false);
  assert.equal(assertLabsSyncConfigured({ labsSync: { endpointUrl: 'https://example.com', outboundKeyId: 'k', outboundSharedSecret: 's' } }), true);
});

test('deliverSyncEvent returns skipped when callback is not configured', async () => {
  const attempt = await deliverSyncEvent(
    { labsSync: { endpointUrl: '', outboundKeyId: '', outboundSharedSecret: '', timeoutMs: 1000 } },
    { eventId: 'evt-1', deliveryAttemptCount: 0 },
  );

  assert.equal(attempt.delivered, false);
  assert.equal(attempt.skipped, true);
});
