const { retryPendingSyncDeliveries, toErrorResponse } = require('../_lib/service');
const { bridgeHandler } = require('../_lib/handler');
const { setJson } = require('../_lib/http');

// POST: an operator retry, authorised by x-sync-retry-token.
const operatorRetry = bridgeHandler('sync-retry', (req) => retryPendingSyncDeliveries(req.headers['x-sync-retry-token']), { includeReplayed: false });

// GET: the scheduled Vercel Cron run (vercel.json), authorised by
// `Authorization: Bearer $CRON_SECRET`. Delivers due callbacks to Labs.
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return operatorRetry(req, res);
  res.setHeader('cache-control', 'no-store');
  try {
    const result = await retryPendingSyncDeliveries(null, undefined, { cronAuthorization: req.headers.authorization });
    return setJson(res, result.statusCode, result.body);
  } catch (error) {
    const result = toErrorResponse(error, { operation: 'sync-retry' });
    return setJson(res, result.statusCode, result.body);
  }
};
