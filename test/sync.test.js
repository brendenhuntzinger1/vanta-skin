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
    transactionId: 'tx-1',
    outcome: 'captured',
  });
  // Contract §5: bridge:charge:<idempotencyKey>:<transId|none>:<outcome>
  assert.equal(key, 'bridge:charge:idem-1:tx-1:captured');
  assert.equal(buildSyncEventKey({ source: 'bridge', action: 'charge', idempotencyKey: 'vskin:charge:o:2', outcome: 'declined' }), 'bridge:charge:vskin:charge:o:2:none:declined');
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

// Vanta Labs preview deployments sit behind Vercel Deployment Protection, which
// answers an unauthenticated callback with a 302 to Vercel's SSO page. The Labs
// project's "Protection Bypass for Automation" secret gets the callback past
// that edge; the HMAC signature is still what Labs trusts.
function stubFetch(t) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response('{}', { status: 200 });
  });
  return calls;
}

const configuredSync = (extra = {}) => ({
  labsSync: {
    endpointUrl: 'https://labs.test/api/webhooks/vanta-skin',
    outboundKeyId: 'labs-sync-1',
    outboundSharedSecret: 'sync-secret',
    timeoutMs: 1000,
    ...extra,
  },
});

test('deliverSyncEvent sends x-vercel-protection-bypass when a Labs bypass secret is configured', async (t) => {
  const calls = stubFetch(t);
  const attempt = await deliverSyncEvent(configuredSync({ protectionBypass: 'labs-bypass-secret' }), { eventId: 'evt-1' });

  assert.equal(attempt.delivered, true);
  assert.equal(calls[0].init.headers['x-vercel-protection-bypass'], 'labs-bypass-secret');
  assert.equal(calls[0].url.includes('labs-bypass-secret'), false);
});

test('deliverSyncEvent sends no bypass header when none is configured', async (t) => {
  const calls = stubFetch(t);
  await deliverSyncEvent(configuredSync(), { eventId: 'evt-1' });
  await deliverSyncEvent(configuredSync({ protectionBypass: '' }), { eventId: 'evt-2' });

  for (const call of calls) {
    assert.equal('x-vercel-protection-bypass' in call.init.headers, false);
  }
});

test('loadConfig reads VANTA_LABS_PROTECTION_BYPASS into labsSync.protectionBypass', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      AUTHNET_API_LOGIN_ID: 'x',
      AUTHNET_TRANSACTION_KEY: 'x',
      SUPABASE_URL: 'https://db.test',
      SUPABASE_SERVICE_ROLE_KEY: 'x',
      VANTA_HMAC_KEY_ID: 'k',
      VANTA_HMAC_SHARED_SECRET: 's',
      VANTA_LABS_PROTECTION_BYPASS: ' labs-bypass-secret ',
    });
    const { loadConfig } = require('../api/_lib/config');
    assert.equal(loadConfig().labsSync.protectionBypass, 'labs-bypass-secret');
  } finally {
    process.env = saved;
  }
});

// A protected Labs preview answers an unauthenticated callback with a 302 to
// Vercel's SSO page. Followed, that page answers 200 — and the callback was
// counted as delivered while Labs never saw it.
test('deliverSyncEvent does not follow redirects: a 302 is a failed delivery', async (t) => {
  let init;
  t.mock.method(globalThis, 'fetch', async (_url, i) => {
    init = i;
    return new Response(null, { status: 302, headers: { location: 'https://vercel.com/sso-api' } });
  });
  const attempt = await deliverSyncEvent(configuredSync(), { eventId: 'evt-1' });
  assert.equal(init.redirect, 'manual');
  assert.equal(attempt.delivered, false);
  assert.equal(attempt.httpStatus, 302);
});
