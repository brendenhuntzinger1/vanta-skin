const { loadConfig } = require('../_lib/config');
const { methodNotAllowed, parseJson, readRawBody, setJson } = require('../_lib/http');
const {
  assertPaymentSessionTokenShape,
  buildPublicSessionPayload,
  hashPaymentSessionToken,
} = require('../_lib/payment-session');
const { createSupabase, findPaymentSessionByTokenHash } = require('../_lib/supabase');

// Browser-facing session validation for the hosted payment component. The
// 256-bit session token is the credential (the browser cannot hold the bridge
// HMAC secret); only its hash is looked up and only public, per-session
// fields are returned. The Authorize.net transaction key is never exposed.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(req, res, ['POST']);
  res.setHeader('cache-control', 'no-store');

  const invalid = () => setJson(res, 400, { ok: false, error: 'Invalid or expired payment session' });

  try {
    const rawBody = await readRawBody(req);
    const payload = parseJson(rawBody);
    assertPaymentSessionTokenShape(payload.sessionToken);

    const config = loadConfig();
    const supabase = createSupabase(config);
    const record = await findPaymentSessionByTokenHash(supabase, hashPaymentSessionToken(payload.sessionToken));

    const expired = !record || new Date(record.expires_at).getTime() <= Date.now();
    if (expired || record.consumed_at) return invalid();

    const clientKey = process.env.AUTHNET_CLIENT_KEY || '';
    if (!clientKey) throw new Error('Authorize.net tokenization is not configured');

    return setJson(res, 200, buildPublicSessionPayload(record, config.authnet, clientKey));
  } catch (error) {
    if (error.message === 'Invalid payment session token') return invalid();
    return setJson(res, error.statusCode || 400, { ok: false, error: error.message });
  }
};
