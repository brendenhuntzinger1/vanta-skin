const { createHash } = require('node:crypto');

function setJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

// setJson, signed as the answer to `req` when it was a signed bridge request
// (security.js responseSignatureHeaders). A signing failure never blocks the
// answer: Labs refuses an unsigned answer and treats the call as uncertain.
function setSignedJson(req, res, status, payload) {
  const raw = JSON.stringify(payload);
  try {
    const { loadHmacSecrets } = require('./config');
    const { responseSignatureHeaders } = require('./security');
    const headers = responseSignatureHeaders(loadHmacSecrets(), req, status, raw);
    if (headers) for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  } catch {
    // unsigned
  }
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(raw);
}

// A charge request is about 2 KB. Anything far larger is refused unread
// rather than buffered (audit 2026-10-18, browser F7).
const MAX_BODY_BYTES = 64 * 1024;

async function readRawBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('Request body too large');
      error.code = 'body_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
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
  MAX_BODY_BYTES,
  hashBody,
  methodNotAllowed,
  parseJson,
  readRawBody,
  setJson,
  setSignedJson,
};
