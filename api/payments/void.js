const { handleVoid } = require('../_lib/service');
const { bridgeHandler } = require('../_lib/handler');

module.exports = bridgeHandler('void', (req, rawBody) => handleVoid(req, rawBody));
