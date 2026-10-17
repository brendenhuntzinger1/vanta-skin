const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeLabs, makeDeps, testConfig } = require('./support/fakes');
const { MAX_DELIVERY_ATTEMPTS, backoffMs, deliverSyncEvent, planNextDelivery } = require('../api/_lib/sync');
const { retryPendingSyncDeliveries, toErrorResponse } = require('../api/_lib/service');

const NOW = new Date('2026-10-16T12:00:00.000Z');
const MIN = 60 * 1000;

test('backoff: 1m, 2m, 4m, 8m … capped at 6h', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(backoffMs), [1, 2, 4, 8, 16].map((m) => m * MIN));
  assert.equal(backoffMs(9), 256 * MIN);
  assert.equal(backoffMs(10), 6 * 60 * MIN);
  assert.equal(backoffMs(14), 6 * 60 * MIN);
});

test('plan: 2xx → delivered', () => {
  const plan = planNextDelivery({ delivered: true, deliveryAttemptCount: 1, httpStatus: 200 }, NOW);
  assert.equal(plan.delivery_status, 'delivered');
});

test('plan: Labs 422 → dead immediately (permanent)', () => {
  const plan = planNextDelivery({ delivered: false, permanent: true, deliveryAttemptCount: 1, httpStatus: 422, error: 'x' }, NOW);
  assert.equal(plan.delivery_status, 'dead');
  assert.match(plan.last_delivery_error, /422/);
});

test('plan: other failures → failed with next_attempt_at = now + backoff', () => {
  const plan = planNextDelivery({ delivered: false, permanent: false, deliveryAttemptCount: 3, httpStatus: 503, error: 'Sync callback failed with status 503' }, NOW);
  assert.equal(plan.delivery_status, 'failed');
  assert.equal(plan.next_attempt_at, new Date(NOW.getTime() + 4 * MIN).toISOString());
  assert.equal(plan.last_delivery_http_status, 503);
});

test(`plan: the ${MAX_DELIVERY_ATTEMPTS}th failure → dead with the last error`, () => {
  assert.equal(MAX_DELIVERY_ATTEMPTS, 15);
  const plan = planNextDelivery({ delivered: false, permanent: false, deliveryAttemptCount: 15, httpStatus: 500, error: 'Sync callback failed with status 500' }, NOW);
  assert.equal(plan.delivery_status, 'dead');
  assert.match(plan.last_delivery_error, /15 attempts.*status 500/);
  assert.equal(planNextDelivery({ delivered: false, deliveryAttemptCount: 14, httpStatus: 500 }, NOW).delivery_status, 'failed');
});

test('deliverSyncEvent classifies 2xx, 422, 409/5xx and network errors', async () => {
  const config = testConfig();
  const post = (status) => async () => ({ status });
  assert.equal((await deliverSyncEvent(config, {}, { post: post(204) })).delivered, true);
  const dead = await deliverSyncEvent(config, {}, { post: post(422), previousAttempts: 2 });
  assert.equal(dead.permanent, true);
  assert.equal(dead.deliveryAttemptCount, 3);
  assert.equal((await deliverSyncEvent(config, {}, { post: post(409) })).permanent, false);
  const thrown = await deliverSyncEvent(config, {}, { post: async () => { const e = new Error('x'); e.name = 'TimeoutError'; throw e; } });
  assert.equal(thrown.delivered, false);
  assert.equal(thrown.error, 'Sync callback timed out');
});

function outboxRow(id, overrides = {}) {
  return {
    id, event_key: `bridge:charge:k${id}:t:captured`, delivery_status: 'failed', delivery_attempt_count: 1,
    next_attempt_at: new Date(NOW.getTime() - MIN).toISOString(), payload: { eventId: `bridge:charge:k${id}:t:captured` }, ...overrides,
  };
}

async function retry(ctx, token = 'retry-token') {
  try {
    return await retryPendingSyncDeliveries(token, ctx.deps);
  } catch (error) {
    return toErrorResponse(error, { operation: 'sync-retry' });
  }
}

test('retry delivers only due rows, oldest due first, and records the plan', async () => {
  const labs = fakeLabs((payload) => (payload.eventId.includes('k2') ? { status: 422 } : { status: 200 }));
  const ctx = makeDeps({ labs, now: () => NOW });
  ctx.store.db.outbox.push(
    outboxRow(1, { next_attempt_at: new Date(NOW.getTime() - 2 * MIN).toISOString() }),
    outboxRow(2, { next_attempt_at: new Date(NOW.getTime() - 5 * MIN).toISOString() }),
    outboxRow(3, { next_attempt_at: new Date(NOW.getTime() + 5 * MIN).toISOString() }),
    outboxRow(4, { delivery_status: 'dead' }),
    outboxRow(5, { delivery_status: 'delivered' }),
  );
  const res = await retry(ctx);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.results.map((r) => r.id), [2, 1]);
  assert.deepEqual(labs.calls.map((c) => c.eventId), ['bridge:charge:k2:t:captured', 'bridge:charge:k1:t:captured']);
  const byId = Object.fromEntries(ctx.store.db.outbox.map((r) => [r.id, r]));
  assert.equal(byId[2].delivery_status, 'dead');
  assert.equal(byId[1].delivery_status, 'delivered');
  assert.equal(byId[1].delivery_attempt_count, 2);
  assert.equal(byId[3].delivery_status, 'failed');
});

test('retry gives up after the 15th failed attempt', async () => {
  const ctx = makeDeps({ labs: fakeLabs(() => ({ status: 500 })), now: () => NOW });
  ctx.store.db.outbox.push(outboxRow(1, { delivery_attempt_count: 14 }));
  await retry(ctx);
  assert.equal(ctx.store.db.outbox[0].delivery_status, 'dead');
  assert.equal(ctx.store.db.outbox[0].delivery_attempt_count, 15);
});

test('retry requires the token; errors carry no variable names', async () => {
  const ctx = makeDeps({ now: () => NOW });
  const res = await retry(ctx, 'wrong');
  assert.equal(res.statusCode, 401);
  ctx.deps.loadConfig = () => testConfig({ labsSync: { retryAuthToken: '' } });
  const off = await retry(ctx, '');
  assert.equal(off.statusCode, 503);
  assert.equal(JSON.stringify(off.body).includes('VANTA_'), false);
});
