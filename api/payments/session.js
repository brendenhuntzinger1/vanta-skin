const { handleCreatePaymentSession } = require('../_lib/service');
const { bridgeHandler } = require('../_lib/handler');

module.exports = bridgeHandler('session', (req, rawBody) => handleCreatePaymentSession(req, rawBody), { includeReplayed: false });
