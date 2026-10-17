const { runDataRetention, toErrorResponse } = require('../_lib/service');
const { methodNotAllowed, setJson } = require('../_lib/http');

// GET: the daily Vercel Cron run (vercel.json), authorised by
// `Authorization: Bearer $CRON_SECRET`. Purges expired working data under the
// retention policy in purge_payment_bridge_data().
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(req, res, ['GET']);
  res.setHeader('cache-control', 'no-store');
  try {
    const result = await runDataRetention(req.headers.authorization);
    return setJson(res, result.statusCode, result.body);
  } catch (error) {
    const result = toErrorResponse(error, { operation: 'maintenance' });
    return setJson(res, result.statusCode, result.body);
  }
};
