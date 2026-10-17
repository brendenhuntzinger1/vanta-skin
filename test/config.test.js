const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, resolveAuthnetMode } = require('../api/_lib/config');

const REQUIRED = {
  AUTHNET_API_LOGIN_ID: 'login',
  AUTHNET_TRANSACTION_KEY: 'txkey',
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'srk',
  VANTA_HMAC_KEY_ID: 'k',
  VANTA_HMAC_SHARED_SECRET: 's',
};

function withEnv(vars, fn) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (/^(VANTA_|AUTHNET_|SUPABASE_|VERCEL_)/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, REQUIRED, vars);
  try {
    return fn();
  } finally {
    process.env = saved;
  }
}

const LIVE = { AUTHNET_SANDBOX: 'false', AUTHNET_LIVE_APPROVED: 'true', VERCEL_ENV: 'production' };

test('live only with AUTHNET_SANDBOX=false, AUTHNET_LIVE_APPROVED=true and VERCEL_ENV=production', () => {
  withEnv(LIVE, () => {
    const config = loadConfig();
    assert.equal(config.authnet.sandbox, false);
    assert.equal(config.authnet.mode, 'live');
    assert.equal(config.authnet.configError, null);
  });
});

test('AUTHNET_SANDBOX=false without approval or outside production is a config error (fail closed)', () => {
  for (const vars of [
    { AUTHNET_SANDBOX: 'false' },
    { AUTHNET_SANDBOX: 'false', AUTHNET_LIVE_APPROVED: 'true' },
    { AUTHNET_SANDBOX: 'false', VERCEL_ENV: 'production' },
    { AUTHNET_SANDBOX: 'false', AUTHNET_LIVE_APPROVED: 'true', VERCEL_ENV: 'preview' },
    { AUTHNET_SANDBOX: 'false', AUTHNET_LIVE_APPROVED: 'TRUE', VERCEL_ENV: 'production' },
    { AUTHNET_SANDBOX: 'false', AUTHNET_LIVE_APPROVED: 'yes', VERCEL_ENV: 'production' },
    { AUTHNET_SANDBOX: 'false', AUTHNET_LIVE_APPROVED: 'true', VERCEL_ENV: 'Production' },
  ]) {
    withEnv(vars, () => {
      const config = loadConfig();
      assert.equal(config.authnet.sandbox, true, JSON.stringify(vars));
      assert.equal(config.authnet.mode, 'misconfigured', JSON.stringify(vars));
      assert.equal(config.authnet.configError, 'live_mode_not_approved', JSON.stringify(vars));
    });
  }
});

test('every other AUTHNET_SANDBOX value is sandbox, approval or not', () => {
  for (const value of [undefined, '', 'true', 'TRUE', 'False', 'FALSE', '0', 'no', 'off', 'on', 'garbage', ' false', 'false ']) {
    const vars = { AUTHNET_LIVE_APPROVED: 'true', VERCEL_ENV: 'production' };
    if (value !== undefined) vars.AUTHNET_SANDBOX = value;
    withEnv(vars, () => {
      const config = loadConfig();
      assert.equal(config.authnet.sandbox, true, `AUTHNET_SANDBOX=${JSON.stringify(value)}`);
      assert.equal(config.authnet.mode, 'sandbox');
      assert.equal(config.authnet.configError, null);
    });
  }
});

test('resolveAuthnetMode is pure over the env object it is given', () => {
  assert.deepEqual(resolveAuthnetMode({}), { sandbox: true, mode: 'sandbox', error: null });
  assert.deepEqual(resolveAuthnetMode(LIVE), { sandbox: false, mode: 'live', error: null });
  assert.equal(resolveAuthnetMode({ AUTHNET_SANDBOX: 'false' }).error, 'live_mode_not_approved');
});

test('VANTA_HMAC_MAX_SKEW_SECONDS falls back to 300 unless a finite positive number', () => {
  for (const value of ['', 'abc', '0', '-5', 'NaN', 'Infinity']) {
    withEnv({ VANTA_HMAC_MAX_SKEW_SECONDS: value }, () => {
      assert.equal(loadConfig().hmac.maxSkewSeconds, 300, `value ${JSON.stringify(value)}`);
    });
  }
  withEnv({}, () => assert.equal(loadConfig().hmac.maxSkewSeconds, 300));
  withEnv({ VANTA_HMAC_MAX_SKEW_SECONDS: '120' }, () => assert.equal(loadConfig().hmac.maxSkewSeconds, 120));
});

test('AUTHNET_TIMEOUT_MS defaults to 20000; Labs callback timeout defaults to 4000', () => {
  withEnv({}, () => {
    const config = loadConfig();
    assert.equal(config.authnet.timeoutMs, 20000);
    assert.equal(config.labsSync.timeoutMs, 4000);
  });
  withEnv({ AUTHNET_TIMEOUT_MS: '15000', VANTA_LABS_SYNC_TIMEOUT_MS: '2500' }, () => {
    const config = loadConfig();
    assert.equal(config.authnet.timeoutMs, 15000);
    assert.equal(config.labsSync.timeoutMs, 2500);
  });
  withEnv({ AUTHNET_TIMEOUT_MS: '0', VANTA_LABS_SYNC_TIMEOUT_MS: 'x' }, () => {
    const config = loadConfig();
    assert.equal(config.authnet.timeoutMs, 20000);
    assert.equal(config.labsSync.timeoutMs, 4000);
  });
});

test('config errors are tagged so responses never echo them', () => {
  withEnv({}, () => {
    delete process.env.SUPABASE_URL;
    assert.throws(() => loadConfig(), (err) => err.code === 'config_error');
  });
});

// Labs always opens a session for the embedded card form. Unset, the variable
// used to mean "sessions optional", so a production deploy that forgot it
// accepted signed charges with no single-use session.
test('payment sessions are required unless explicitly turned off', () => {
  withEnv({}, () => assert.equal(loadConfig().bridge.requirePaymentSession, true));
  withEnv({ VANTA_REQUIRE_PAYMENT_SESSION: 'false' }, () => assert.equal(loadConfig().bridge.requirePaymentSession, false));
  withEnv({ VANTA_REQUIRE_PAYMENT_SESSION: 'true' }, () => assert.equal(loadConfig().bridge.requirePaymentSession, true));
});
