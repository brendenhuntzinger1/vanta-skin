const { retryPendingSyncDeliveries } = require('../_lib/service');
const { bridgeHandler } = require('../_lib/handler');

module.exports = bridgeHandler('sync-retry', (req) => retryPendingSyncDeliveries(req.headers['x-sync-retry-token']), { includeReplayed: false });
