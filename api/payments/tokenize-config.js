const { loadConfig } = require('../_lib/config');
const { methodNotAllowed, setSignedJson } = require('../_lib/http');

// Public Accept.js settings for the browser. Configuration problems are
// reported generically; variable names stay in the server log.
module.exports = function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(req, res, ['GET']);
  res.setHeader('cache-control', 'no-store');
  const setJson = (r, status, payload) => setSignedJson(req, r, status, payload);

  try {
    const config = loadConfig();
    if (config.authnet.configError) {
      return setJson(res, 503, { ok: false, authnet: { enabled: false }, error: 'Card payments are temporarily unavailable' });
    }
    const clientKey = process.env.AUTHNET_CLIENT_KEY || '';
    return setJson(res, 200, {
      ok: true,
      authnet: {
        enabled: !!clientKey,
        apiLoginId: config.authnet.apiLoginId,
        clientKey,
        sandbox: config.authnet.sandbox,
      },
    });
  } catch (error) {
    try {
      console.error(JSON.stringify({ service: 'payment-bridge', event: 'tokenize_config_error', code: error?.code || null }));
    } catch {
      // ignore
    }
    return setJson(res, 503, { ok: false, authnet: { enabled: false }, error: 'Card payments are temporarily unavailable' });
  }
};
