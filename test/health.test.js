const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalMessage, digestHex, signHmac } = require('../api/_lib/security');

// GET /api/payments/health proves, without revealing either value, that the
// bridge secret Labs signs with matches VANTA_HMAC_SHARED_SECRET here (the
// request verifies) and, with ?callback=1, that VANTA_LABS_SYNC_SHARED_SECRET
// matches Labs's copy (Labs answers a signed ping with the challenge).

const BRIDGE = 'bridge-secret-for-tests';
const SYNC = 'sync-secret-for-tests';

function withEnv(vars, fn) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (/^(VANTA_|AUTHNET_|SUPABASE_)/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, vars);
  return Promise.resolve().then(fn).finally(() => { process.env = saved; });
}

function signedGet(path = '/api/payments/health', { secret = BRIDGE, keyId = 'labs-to-skin-1', ts = Math.floor(Date.now() / 1000) } = {}) {
  const nonce = `n-${Math.random()}`;
  const message = canonicalMessage({ method: 'GET', path: path.split('?')[0], timestamp: ts, nonce, bodyHash: digestHex('') });
  return {
    method: 'GET',
    url: path,
    headers: {
      'x-vanta-key-id': keyId,
      'x-vanta-timestamp': String(ts),
      'x-vanta-nonce': nonce,
      'x-vanta-signature': signHmac(secret, message),
    },
  };
}

const baseEnv = {
  VANTA_HMAC_KEY_ID: 'labs-to-skin-1',
  VANTA_HMAC_SHARED_SECRET: BRIDGE,
  AUTHNET_SANDBOX: 'true',
  AUTHNET_API_LOGIN_ID: 'login',
  AUTHNET_TRANSACTION_KEY: 'txkey',
  AUTHNET_CLIENT_KEY: 'client',
  AUTHNET_SIGNATURE_KEY: 'sig',
};

const { runHealthCheck } = require('../api/_lib/health');

test('refuses an unsigned or wrongly signed request', async () => {
  await withEnv(baseEnv, async () => {
    const unsigned = await runHealthCheck({ method: 'GET', url: '/api/payments/health', headers: {} }, {});
    assert.equal(unsigned.statusCode, 401);
    const wrong = await runHealthCheck(signedGet('/api/payments/health', { secret: 'not-the-secret' }), {});
    assert.equal(wrong.statusCode, 401);
  });
});

test('answers 503 when no bridge secret is configured', async () => {
  await withEnv({}, async () => {
    const result = await runHealthCheck(signedGet(), {});
    assert.equal(result.statusCode, 503);
  });
});

test('a correctly signed request gets readiness booleans and never a secret', async () => {
  await withEnv(baseEnv, async () => {
    const result = await runHealthCheck(signedGet(), {});
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.sandbox, true);
    assert.deepEqual(result.body.checks.bridgeSignature, 'verified');
    assert.equal(result.body.checks.authnetCredentials, 'present');
    assert.equal(result.body.checks.database, 'not_configured');
    assert.equal(result.body.checks.labsCallback, 'not_requested');
    const text = JSON.stringify(result.body);
    for (const secret of [BRIDGE, 'txkey', 'sig', 'login', 'client']) assert.equal(text.includes(secret), false, secret);
  });
});

test('reports a reachable database through the injected probe', async () => {
  await withEnv({ ...baseEnv, SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'srk' }, async () => {
    const ok = await runHealthCheck(signedGet(), { probeDatabase: async () => ({ ok: true }) });
    assert.equal(ok.body.checks.database, 'reachable');
    const bad = await runHealthCheck(signedGet(), { probeDatabase: async () => ({ ok: false, code: '42P01' }) });
    assert.equal(bad.body.checks.database, 'error:42P01');
  });
});

test('?callback=1 verifies the Labs callback secret by challenge-response', async () => {
  const env = {
    ...baseEnv,
    VANTA_LABS_SYNC_ENDPOINT_URL: 'https://labs.test/api/webhooks/vanta-skin',
    VANTA_LABS_SYNC_KEY_ID: 'labs-sync-1',
    VANTA_LABS_SYNC_SHARED_SECRET: SYNC,
  };
  await withEnv(env, async () => {
    let sent;
    const echo = async (_labsSync, payload) => {
      sent = payload;
      return { status: 200, body: { success: true, pong: payload.challenge } };
    };
    const verified = await runHealthCheck(signedGet('/api/payments/health?callback=1'), { postToLabs: echo });
    assert.equal(verified.body.checks.labsCallback, 'verified');
    assert.equal(sent.type, 'ping');
    assert.equal(sent.sandbox, true);
    assert.match(sent.eventId, /^ping:/);

    const wrong = await runHealthCheck(signedGet('/api/payments/health?callback=1'), {
      postToLabs: async () => ({ status: 401, body: { success: false } }),
    });
    assert.equal(wrong.body.checks.labsCallback, 'failed:401');

    const mismatched = await runHealthCheck(signedGet('/api/payments/health?callback=1'), {
      postToLabs: async () => ({ status: 200, body: { pong: 'something-else' } }),
    });
    assert.equal(mismatched.body.checks.labsCallback, 'failed:challenge_mismatch');
  });
});

test('?callback=1 without callback configuration says so', async () => {
  await withEnv(baseEnv, async () => {
    const result = await runHealthCheck(signedGet('/api/payments/health?callback=1'), {});
    assert.equal(result.body.checks.labsCallback, 'not_configured');
  });
});

test('?gateway=1 runs the sandbox gateway check only for a signed request, once per window', async () => {
  const { gatewayCheckLimiter } = require('../api/_lib/gateway-check');
  await withEnv(baseEnv, async () => {
    const calls = [];
    const runGatewayCheck = async (opts) => { calls.push(opts.ping); return { ok: true, checks: { authenticate: { ok: true, code: 'I00001' } } }; };
    const limiter = gatewayCheckLimiter({ windowMs: 60000 });

    const unsigned = await runHealthCheck({ method: 'GET', url: '/api/payments/health?gateway=1', headers: {} }, { runGatewayCheck, gatewayLimiter: limiter });
    assert.equal(unsigned.statusCode, 401);
    assert.equal(calls.length, 0);

    const first = await runHealthCheck(signedGet('/api/payments/health?gateway=1&ping=1'), { runGatewayCheck, gatewayLimiter: limiter });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.body.gateway, { ok: true, checks: { authenticate: { ok: true, code: 'I00001' } } });
    assert.deepEqual(calls, [true]);

    const second = await runHealthCheck(signedGet('/api/payments/health?gateway=1'), { runGatewayCheck, gatewayLimiter: limiter });
    assert.equal(second.statusCode, 429);
    assert.equal(second.body.ok, false);
    assert.ok(second.body.retryAfterSeconds > 0);
    assert.equal(calls.length, 1);

    // A plain health check is never rate-limited by the gateway window.
    const plain = await runHealthCheck(signedGet(), { runGatewayCheck, gatewayLimiter: limiter });
    assert.equal(plain.statusCode, 200);
    assert.equal(plain.body.gateway, undefined);
  });
});

test('?authcheck=1 reports whether the gateway accepts the login; never asked otherwise', async () => {
  await withEnv(baseEnv, async () => {
    const calls = [];
    const checkGatewayAuth = async (input) => { calls.push(input.sandbox); return 'rejected:E00008'; };
    const plain = await runHealthCheck(signedGet(), { checkGatewayAuth });
    assert.equal(plain.body.checks.gatewayAuthentication, 'not_requested');
    assert.equal(calls.length, 0);
    const asked = await runHealthCheck(signedGet('/api/payments/health?callback=0&authcheck=1'), { checkGatewayAuth });
    assert.equal(asked.body.checks.gatewayAuthentication, 'rejected:E00008');
    assert.deepEqual(calls, [true]);
  });
});
