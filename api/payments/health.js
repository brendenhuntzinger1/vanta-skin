const { runHealthCheck } = require('../_lib/health');
const { methodNotAllowed, setSignedJson } = require('../_lib/http');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(req, res, ['GET']);
  res.setHeader('cache-control', 'no-store');
  const result = await runHealthCheck(req);
  return setSignedJson(req, res, result.statusCode, result.body);
};
