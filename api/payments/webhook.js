const { handleWebhook } = require('../_lib/service');
const { bridgeHandler } = require('../_lib/handler');

module.exports = bridgeHandler('webhook', (req, rawBody) => handleWebhook(rawBody, req.headers['x-anet-signature']), { includeReplayed: false });
