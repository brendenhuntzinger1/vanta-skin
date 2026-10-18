const { BridgeError, toErrorResponse } = require('./service');
const { methodNotAllowed, readRawBody, setSignedJson } = require('./http');

// Wraps a bridge endpoint: POST only, raw body read once, every error mapped
// to a contract response. Raw exception text never reaches the response.
function bridgeHandler(operation, run, { includeReplayed = true } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(req, res, ['POST']);
    res.setHeader('cache-control', 'no-store');

    let rawBody;
    try {
      rawBody = await readRawBody(req);
    } catch {
      // Nothing was processed: the request never arrived whole.
      const result = toErrorResponse(new BridgeError({ statusCode: 400, outcome: 'invalid', message: 'Request body could not be read' }), { operation });
      return setSignedJson(req, res, result.statusCode, result.body);
    }

    try {
      const result = await run(req, rawBody);
      const body = includeReplayed ? { ...result.body, replayed: !!result.replayed } : result.body;
      return setSignedJson(req, res, result.statusCode, body);
    } catch (error) {
      if (!(error instanceof BridgeError)) {
        try {
          console.error(JSON.stringify({ service: 'payment-bridge', event: 'unhandled_error', operation, name: error?.name, message: error?.message }));
        } catch {
          // ignore
        }
      }
      const result = toErrorResponse(error, { operation });
      const body = includeReplayed ? { ...result.body, replayed: false } : result.body;
      return setSignedJson(req, res, result.statusCode, body);
    }
  };
}

module.exports = { bridgeHandler };
