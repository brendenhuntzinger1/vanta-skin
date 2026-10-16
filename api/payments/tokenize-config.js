const { loadConfig } = require('../_lib/config');
const { methodNotAllowed, setJson } = require('../_lib/http');

module.exports = function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(req, res, ['GET']);

  try {
    const config = loadConfig();
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
    return setJson(res, 500, { ok: false, error: error.message });
  }
};
