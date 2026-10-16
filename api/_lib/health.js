const { randomBytes, randomUUID } = require('node:crypto');
const { envBool, loadHmacSecrets, loadLabsSyncConfig, optionalNumber } = require('./config');
const { verifyRequestSignature } = require('./security');
const { signedLabsPost } = require('./sync');

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

async function runHealthCheck(req, { probeDatabase: probe = probeDatabase, postToLabs = signedLabsPost } = {}) {
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
      { hmac: { secrets, maxSkewSeconds: optionalNumber('VANTA_HMAC_MAX_SKEW_SECONDS', 300) } },
      req,
      '',
    );
  } catch (error) {
    return { statusCode: 401, body: { ok: false, error: error.message } };
  }

  const sandbox = envBool('AUTHNET_SANDBOX', true);
  let database = 'not_configured';
  if (hasEnv('SUPABASE_URL') && hasEnv('SUPABASE_SERVICE_ROLE_KEY')) {
    try {
      const result = await probe();
      database = result.ok ? 'reachable' : `error:${result.code || 'unknown'}`;
    } catch {
      database = 'error:unreachable';
    }
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
      checks: {
        bridgeSignature: 'verified',
        authnetCredentials: hasEnv('AUTHNET_API_LOGIN_ID') && hasEnv('AUTHNET_TRANSACTION_KEY') ? 'present' : 'missing',
        acceptJsClientKey: hasEnv('AUTHNET_CLIENT_KEY') ? 'present' : 'missing',
        webhookSignatureKey: hasEnv('AUTHNET_SIGNATURE_KEY') ? 'present' : 'missing',
        database,
        labsCallback,
      },
    },
  };
}

module.exports = { runHealthCheck };
