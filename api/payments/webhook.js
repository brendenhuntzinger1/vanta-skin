const { handleWebhook } = require('../_lib/service');
const { methodNotAllowed, readRawBody, setJson } = require('../_lib/http');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(req, res, ['POST']);

  try {
    const rawBody = await readRawBody(req);
    const result = await handleWebhook(rawBody, req.headers['x-anet-signature']);
    return setJson(res, result.statusCode, result.body);
  } catch (error) {
    return setJson(res, error.statusCode || 400, { ok: false, error: error.message });
  }
};
