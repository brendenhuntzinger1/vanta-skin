const { retryPendingSyncDeliveries } = require('../_lib/service');
const { methodNotAllowed, setJson } = require('../_lib/http');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(req, res, ['POST']);

  try {
    const token = req.headers['x-sync-retry-token'];
    const result = await retryPendingSyncDeliveries(token);
    return setJson(res, result.statusCode, result.body);
  } catch (error) {
    return setJson(res, error.statusCode || 400, { ok: false, error: error.message });
  }
};
