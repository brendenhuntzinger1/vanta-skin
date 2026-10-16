const { handleCreatePaymentSession } = require('../_lib/service');
const { methodNotAllowed, parseJson, readRawBody, setJson } = require('../_lib/http');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(req, res, ['POST']);

  try {
    const rawBody = await readRawBody(req);
    const payload = parseJson(rawBody);
    const result = await handleCreatePaymentSession(req, rawBody, payload);
    return setJson(res, result.statusCode, result.body);
  } catch (error) {
    return setJson(res, error.statusCode || 400, { ok: false, error: error.message });
  }
};
