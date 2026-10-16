const { runHealthCheck } = require('../_lib/health');
const { methodNotAllowed, setJson } = require('../_lib/http');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(req, res, ['GET']);
  res.setHeader('cache-control', 'no-store');
  const result = await runHealthCheck(req);
  return setJson(res, result.statusCode, result.body);
};
