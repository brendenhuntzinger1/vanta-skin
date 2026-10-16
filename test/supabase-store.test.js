const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('../api/_lib/supabase');

// A recording stand-in for the Supabase query builder: every chained call is
// logged, and the awaited result comes from `respond(table, ops)`.
function fakeClient(respond) {
  const queries = [];
  return {
    queries,
    from(table) {
      const ops = [];
      queries.push({ table, ops });
      const builder = {};
      for (const name of ['insert', 'update', 'upsert', 'select', 'eq', 'in', 'lte', 'order', 'limit', 'maybeSingle', 'single']) {
        builder[name] = (...args) => {
          ops.push([name, ...args]);
          return builder;
        };
      }
      builder.then = (resolve, reject) => Promise.resolve(respond(table, ops)).then(resolve, reject);
      return builder;
    },
  };
}

const opNames = (q) => q.ops.map((o) => o[0]);

test('claimIdempotency is a plain INSERT with status in_progress (never an upsert)', async () => {
  const client = fakeClient(() => ({ data: null, error: null }));
  const result = await createStore(client).claimIdempotency({ endpoint: '/api/payments/charge', idempotencyKey: 'k', requestHash: 'h' });
  assert.deepEqual(result, { claimed: true, existing: null });
  const [q] = client.queries;
  assert.equal(q.table, 'payment_idempotency');
  assert.deepEqual(opNames(q), ['insert']);
  assert.equal(q.ops[0][1].status, 'in_progress');
  assert.equal(q.ops[0][1].request_hash, 'h');
  assert.equal(q.ops[0][1].response_body, null);
});

test('claimIdempotency on a unique violation reads and returns the existing row', async () => {
  const client = fakeClient((table, ops) => {
    if (ops[0][0] === 'insert') return { data: null, error: { code: '23505', message: 'duplicate key' } };
    return { data: { status: 'completed', request_hash: 'h', response_status: 200, response_body: { outcome: 'captured' } }, error: null };
  });
  const result = await createStore(client).claimIdempotency({ endpoint: '/api/payments/charge', idempotencyKey: 'k', requestHash: 'h' });
  assert.equal(result.claimed, false);
  assert.equal(result.existing.status, 'completed');
  assert.deepEqual(opNames(client.queries[1]), ['select', 'eq', 'eq', 'maybeSingle']);
});

test('claimIdempotency rethrows any other database error', async () => {
  const client = fakeClient(() => ({ data: null, error: { code: '42703', message: 'column "status" does not exist' } }));
  await assert.rejects(createStore(client).claimIdempotency({ endpoint: 'e', idempotencyKey: 'k', requestHash: 'h' }), /Unable to claim/);
});

test('finishIdempotency only updates the caller\'s own in_progress claim and fails if none matched', async () => {
  let rows = [{ idempotency_key: 'k' }];
  const client = fakeClient(() => ({ data: rows, error: null }));
  const store = createStore(client);
  await store.finishIdempotency({ endpoint: 'e', idempotencyKey: 'k', requestHash: 'h', status: 'completed', responseStatus: 200, responseBody: { ok: true } });
  const [q] = client.queries;
  assert.equal(opNames(q)[0], 'update');
  assert.deepEqual(q.ops.filter((o) => o[0] === 'eq').map((o) => [o[1], o[2]]), [['endpoint', 'e'], ['idempotency_key', 'k'], ['request_hash', 'h'], ['status', 'in_progress']]);
  rows = [];
  await assert.rejects(store.finishIdempotency({ endpoint: 'e', idempotencyKey: 'k', requestHash: 'h', status: 'completed', responseStatus: 200, responseBody: {} }), /not saved/);
});

test('insertSyncEvent never resets an existing row', async () => {
  const client = fakeClient((table, ops) => {
    if (ops[0][0] === 'insert') return { data: null, error: { code: '23505', message: 'dup' } };
    return { data: { id: 'x', event_key: 'k', delivery_status: 'delivered', delivery_attempt_count: 1 }, error: null };
  });
  const row = await createStore(client).insertSyncEvent({ event_key: 'k', payload: {} });
  assert.equal(row.delivery_status, 'delivered');
  assert.equal(row.inserted, false);
  assert.equal(client.queries.some((q) => opNames(q).includes('update') || opNames(q).includes('upsert')), false);
});

test('listDueSyncEvents selects pending/failed rows that are due, ordered by next_attempt_at', async () => {
  const client = fakeClient(() => ({ data: [], error: null }));
  await createStore(client).listDueSyncEvents({ limit: 7, now: new Date('2026-10-16T12:00:00.000Z') });
  const [q] = client.queries;
  assert.deepEqual(q.ops.find((o) => o[0] === 'in'), ['in', 'delivery_status', ['pending', 'failed']]);
  assert.deepEqual(q.ops.find((o) => o[0] === 'lte'), ['lte', 'next_attempt_at', '2026-10-16T12:00:00.000Z']);
  assert.deepEqual(q.ops.find((o) => o[0] === 'order'), ['order', 'next_attempt_at', { ascending: true }]);
  assert.deepEqual(q.ops.find((o) => o[0] === 'limit'), ['limit', 7]);
});

test('recordWebhookEvent dedupes by event id (insert; duplicate reported, not overwritten)', async () => {
  const client = fakeClient(() => ({ data: null, error: { code: '23505', message: 'dup' } }));
  assert.deepEqual(await createStore(client).recordWebhookEvent({ event_id: 'n1' }), { inserted: false });
  assert.deepEqual(opNames(client.queries[0]), ['insert']);
});

test('no upsert anywhere in the store', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', '_lib', 'supabase.js'), 'utf8');
  assert.equal(/\.upsert\(/.test(source), false);
});
