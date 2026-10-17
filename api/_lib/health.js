const { randomBytes, randomUUID } = require('node:crypto');
const { hmacMaxSkewSeconds, loadHmacSecrets, loadLabsSyncConfig, resolveAuthnetMode } = require('./config');
const { verifyRequestSignature } = require('./security');
const { signedLabsPost } = require('./sync');
const gatewayCheck = require('./gateway-check');

const defaultGatewayLimiter = gatewayCheck.gatewayCheckLimiter();

// GET /api/payments/health — a read-only readiness check that proves the
// shared secrets match without either side revealing them:
//
//   • The request must carry a valid bridge signature (the same HMAC scheme as
//     /api/payments/charge), so a 200 means Labs's VANTA_SKIN_SHARED_SECRET
//     equals VANTA_HMAC_SHARED_SECRET here.
//   • With ?callback=1, this service sends Labs a signed ping carrying a random
//     challenge; Labs echoes it only after verifying the signature, so a match
//     means both copies of VANTA_LABS_SYNC_SHARED_SECRET agree.
//
// Nothing here moves money or writes data. The nonce is not stored: a replayed
// health check inside the skew window returns the same booleans and, at most,
// one more ping. The response carries only states, never configuration values.

function hasEnv(name) {
  return typeof process.env[name] === 'string' && process.env[name].trim() !== '';
}

async function probeDatabase() {
  const { createClient } = require('@supabase/supabase-js');
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const { error } = await client
    .from('payment_idempotency')
    .select('endpoint', { head: true, count: 'exact' })
    .limit(1);
  return error ? { ok: false, code: String(error.code || 'unknown') } : { ok: true };
}

async function checkLabsCallback(labsSync, sandbox, postToLabs) {
  if (!labsSync.endpointUrl || !labsSync.outboundKeyId || !labsSync.outboundSharedSecret) {
    return 'not_configured';
  }
  const challenge = randomBytes(16).toString('hex');
  try {
    const res = await postToLabs(labsSync, { type: 'ping', eventId: `ping:${randomUUID()}`, challenge, sandbox });
    if (res.status !== 200) return `failed:${res.status}`;
    return res.body && res.body.pong === challenge ? 'verified' : 'failed:challenge_mismatch';
  } catch (error) {
    return `failed:${error?.name === 'TimeoutError' ? 'timeout' : 'unreachable'}`;
  }
}

async function runHealthCheck(req, {
  probeDatabase: probe = probeDatabase,
  postToLabs = signedLabsPost,
  runGatewayCheck = gatewayCheck.runGatewayCheck,
  gatewayLimiter = defaultGatewayLimiter,
} = {}) {
  let secrets;
  try {
    secrets = loadHmacSecrets();
  } catch {
    secrets = {};
  }
  if (!Object.keys(secrets).length) {
    return { statusCode: 503, body: { ok: false, error: 'Bridge signing is not configured' } };
  }

  try {
    verifyRequestSignature(
      { hmac: { secrets, maxSkewSeconds: hmacMaxSkewSeconds() } },
      req,
      '',
    );
  } catch {
    return { statusCode: 401, body: { ok: false, error: 'Invalid or missing bridge signature' } };
  }

  // Same strict rule the payment endpoints use: live only with
  // AUTHNET_SANDBOX=false, AUTHNET_LIVE_APPROVED=true and VERCEL_ENV=production.
  const authnetMode = resolveAuthnetMode(process.env);
  const sandbox = authnetMode.sandbox;
  let database = 'not_configured';
  if (hasEnv('SUPABASE_URL') && hasEnv('SUPABASE_SERVICE_ROLE_KEY')) {
    try {
      const result = await probe();
      database = result.ok ? 'reachable' : `error:${result.code || 'unknown'}`;
    } catch {
      database = 'error:unreachable';
    }
  }

  // ?gateway=1 (and &ping=1): the sandbox credential check in
  // gateway-check.js. Signed requests only (above), one per window.
  const wantsGateway = /[?&]gateway=1(&|$)/.test(String(req.url || ''));
  let gateway;
  if (wantsGateway) {
    const slot = gatewayLimiter.take();
    if (!slot.allowed) return { statusCode: 429, body: { ok: false, error: 'rate_limited', retryAfterSeconds: slot.retryAfterSeconds } };
    const url = String(req.url || '');
    gateway = await runGatewayCheck({ ping: /[?&]ping=1(&|$)/.test(url), register: /[?&]register=1(&|$)/.test(url) });
  }

  const wantsCallback = /[?&]callback=1(&|$)/.test(String(req.url || ''));
  const labsCallback = wantsCallback
    ? await checkLabsCallback(loadLabsSyncConfig(), sandbox, postToLabs)
    : 'not_requested';

  return {
    statusCode: 200,
    body: {
      ok: true,
      service: 'vanta-skin-payment-service',
      sandbox,
      authnetMode: authnetMode.mode,
      checks: {
        bridgeSignature: 'verified',
        authnetCredentials: hasEnv('AUTHNET_API_LOGIN_ID') && hasEnv('AUTHNET_TRANSACTION_KEY') ? 'present' : 'missing',
        acceptJsClientKey: hasEnv('AUTHNET_CLIENT_KEY') ? 'present' : 'missing',
        webhookSignatureKey: hasEnv('AUTHNET_SIGNATURE_KEY') ? 'present' : 'missing',
        database,
        labsCallback,
      },
      ...(gateway ? { gateway } : {}),
    },
  };
}

module.exports = { runHealthCheck };
