const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createFakeStore, makeDeps, testConfig } = require('./support/fakes');
const { runDataRetention, toErrorResponse } = require('../api/_lib/service');

// Data-exposure audit 2026-10-17, M2: the bridge's working tables are purged
// on a schedule (supabase/migrations/20261017002000_payment_data_retention.sql),
// run daily by Vercel Cron with `Authorization: Bearer $CRON_SECRET`.

const CRON = 'cron-secret-value';
const NOW = new Date('2026-10-17T06:00:00Z');

function setup({ cronSecret = CRON, purge } = {}) {
  const store = createFakeStore();
  const calls = [];
  store.purgeExpiredPaymentData = purge || (async (now) => {
    calls.push(now.toISOString());
    return { replays: 3, sessions: 2, idempotency: 0, outbox: 1, webhooks: 0 };
  });
  const ctx = makeDeps({ config: testConfig({ labsSync: { cronSecret } }), store, now: () => NOW });
  return { ctx, calls };
}

async function run(ctx, authorization) {
  try {
    return await runDataRetention(authorization, ctx.deps);
  } catch (error) {
    return toErrorResponse(error, { operation: 'maintenance' });
  }
}

test('purges with the scheduler\'s bearer and reports the counts', async () => {
  const { ctx, calls } = setup();
  const res = await run(ctx, `Bearer ${CRON}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, purged: { replays: 3, sessions: 2, idempotency: 0, outbox: 1, webhooks: 0 } });
  assert.deepEqual(calls, [NOW.toISOString()]);
  assert.ok(ctx.logs.some((entry) => entry.event === 'retention_purge' && entry.sessions === 2));
});

test('refuses any other caller without naming the check', async () => {
  for (const authorization of [undefined, '', 'Bearer wrong', CRON, `bearer ${CRON}`]) {
    const { ctx, calls } = setup();
    const res = await run(ctx, authorization);
    assert.equal(res.statusCode, 401, String(authorization));
    assert.equal(res.body.message, 'Request could not be authenticated');
    assert.equal(calls.length, 0);
  }
});

test('does nothing until CRON_SECRET is configured', async () => {
  const { ctx, calls } = setup({ cronSecret: '' });
  const res = await run(ctx, 'Bearer ');
  assert.equal(res.statusCode, 503);
  assert.equal(calls.length, 0);
});

test('a database failure is a generic 503, logged', async () => {
  const { ctx } = setup({ purge: async () => { throw new Error('connection refused'); } });
  const res = await run(ctx, `Bearer ${CRON}`);
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.stringify(res.body).includes('connection refused'), false);
  assert.ok(ctx.logs.some((entry) => entry.event === 'retention_error'));
});

test('Vercel Cron runs it daily, and the endpoint answers GET only', async () => {
  const vercel = JSON.parse(readFileSync(join(__dirname, '..', 'vercel.json'), 'utf8'));
  const cron = vercel.crons.find((entry) => entry.path === '/api/payments/maintenance');
  assert.ok(cron, 'cron entry');
  assert.match(cron.schedule, /^\d{1,2} \d{1,2} \* \* \*$/);

  const handler = require('../api/payments/maintenance');
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } };
  await handler({ method: 'POST', headers: {} }, res);
  assert.equal(res.statusCode, 405);
});

// What the policy keeps and for how long, pinned so a change is a reviewed
// diff. payment_events is the financial record (and holds no customer PII
// after this change), so the purge never touches it; dead-lettered callbacks
// wait for a person.
test('the retention policy keeps what refunds, disputes and reconciliation need', () => {
  const sql = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '20261017002000_payment_data_retention.sql'), 'utf8')
    .replace(/--.*$/gm, '');
  const fn = sql.slice(sql.indexOf('create or replace function public.purge_payment_bridge_data'));
  assert.match(fn, /delete from public\.payment_request_replays\s+where received_at < p_now - interval '1 day'/);
  assert.match(fn, /delete from public\.payment_sessions\s+where expires_at < p_now - interval '1 day'/);
  assert.match(fn, /delete from public\.payment_idempotency\s+where status = 'completed'\s+and updated_at < p_now - interval '180 days'/);
  assert.match(fn, /delete from public\.payment_order_sync_events\s+where delivery_status = 'delivered'\s+and coalesce\(delivered_at, updated_at\) < p_now - interval '90 days'/);
  assert.match(fn, /delete from public\.authnet_webhook_events\s+where received_at < p_now - interval '180 days'/);
  assert.doesNotMatch(fn, /delete from public\.payment_events\b/);
  assert.doesNotMatch(fn, /'dead'/);
  assert.match(sql, /revoke all on function public\.purge_payment_bridge_data\(timestamptz\) from public, anon, authenticated/);
});
