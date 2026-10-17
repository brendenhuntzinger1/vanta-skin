const { handleReconcile } = require('../_lib/service');
const { bridgeHandler } = require('../_lib/handler');

// POST /api/payments/reconcile — read-only: reports what happened to a charge
// attempt from this service's records, else from an Authorize.Net lookup.
module.exports = bridgeHandler('reconcile', (req, rawBody) => handleReconcile(req, rawBody), { includeReplayed: false });
