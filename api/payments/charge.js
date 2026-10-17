const { handleCharge } = require('../_lib/service');
const { bridgeHandler } = require('../_lib/handler');

module.exports = bridgeHandler('charge', (req, rawBody) => handleCharge(req, rawBody));
