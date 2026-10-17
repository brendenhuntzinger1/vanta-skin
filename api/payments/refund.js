const { handleRefund } = require('../_lib/service');
const { bridgeHandler } = require('../_lib/handler');

module.exports = bridgeHandler('refund', (req, rawBody) => handleRefund(req, rawBody));
