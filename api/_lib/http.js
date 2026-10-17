const { createHash } = require('node:crypto');

function setJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(raw) {
  if (!raw || !raw.trim()) return {};
  return JSON.parse(raw);
}

function methodNotAllowed(req, res, methods) {
  res.setHeader('allow', methods.join(', '));
  return setJson(res, 405, { error: `Method ${req.method} not allowed` });
}

function hashBody(raw) {
  return createHash('sha256').update(raw || '', 'utf8').digest('hex');
}

module.exports = {
  hashBody,
  methodNotAllowed,
  parseJson,
  readRawBody,
  setJson,
};
