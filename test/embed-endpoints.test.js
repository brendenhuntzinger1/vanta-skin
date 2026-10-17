const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
require('./support/fakes');
const embed = require('../api/payments/embed');
const sessionValidate = require('../api/payments/session-validate');
const { EMBED_SCRIPT, buildEmbedCsp, renderEmbedPage } = require('../api/_lib/embed-page');

const TOKEN = `vps_${'a'.repeat(64)}`;

function req({ method = 'POST', url = '/api/payments/session-validate', body = '' } = {}) {
  const stream = Readable.from([Buffer.from(body)]);
  stream.method = method;
  stream.url = url;
  stream.headers = {};
  return stream;
}

function res() {
  const out = { headers: {}, statusCode: null, text: null };
  out.setHeader = (k, v) => { out.headers[k.toLowerCase()] = v; };
  out.end = (text) => { out.text = text; };
  return out;
}

function withoutEnv(names, fn) {
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  return Promise.resolve(fn()).finally(() => {
    for (const [n, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  });
}

test('session-validate never tells the browser which variable or database failed', async (t) => {
  t.mock.method(console, 'error', () => {});
  await withoutEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'], async () => {
    const r = res();
    await sessionValidate(req({ body: JSON.stringify({ sessionToken: TOKEN }) }), r);
    assert.equal(r.statusCode, 503);
    assert.doesNotMatch(r.text, /SUPABASE|environment|variable|supabase/i);
    assert.equal(JSON.parse(r.text).ok, false);
  });
});

test('session-validate answers a malformed token with the generic invalid-session error', async () => {
  const r = res();
  await sessionValidate(req({ body: JSON.stringify({ sessionToken: 'vps_nope' }) }), r);
  assert.equal(r.statusCode, 400);
  assert.equal(JSON.parse(r.text).error, 'Invalid or expired payment session');
});

test('embed never tells the browser which configuration failed', async (t) => {
  t.mock.method(console, 'error', () => {});
  const saved = process.env.VANTA_EMBED_ALLOWED_ORIGINS;
  process.env.VANTA_EMBED_ALLOWED_ORIGINS = 'not-an-origin';
  try {
    const r = res();
    await embed(req({ method: 'GET', url: `/api/payments/embed?session=${TOKEN}` }), r);
    assert.equal(r.statusCode, 503);
    assert.doesNotMatch(r.text, /VANTA_EMBED|not-an-origin/);
  } finally {
    if (saved === undefined) delete process.env.VANTA_EMBED_ALLOWED_ORIGINS;
    else process.env.VANTA_EMBED_ALLOWED_ORIGINS = saved;
  }
});

test('embed CSP: framed only by the approved Labs origins, Accept.js hosts reachable for load and integrity check', () => {
  const csp = buildEmbedCsp(['https://vantalabsresearch.com']);
  assert.match(csp, /frame-ancestors https:\/\/vantalabsresearch\.com(;|$)/);
  const connect = csp.split('; ').find((d) => d.startsWith('connect-src'));
  for (const host of ['https://jstest.authorize.net', 'https://js.authorize.net', 'https://apitest.authorize.net', 'https://api.authorize.net']) {
    assert.ok(connect.includes(host), host);
  }
  assert.match(csp, /default-src 'none'/);
});

test('embed page: no visible pay button of its own; Enter asks the parent checkout to pay', () => {
  const html = renderEmbedPage();
  assert.doesNotMatch(html, /Secure card for/);
  assert.match(html, /class="sr-submit"/);
  assert.match(EMBED_SCRIPT, /vanta:pay:submit-request/);
  // Tokenization runs only when the parent asks, at its exact origin, for this session.
  assert.match(EMBED_SCRIPT, /event\.origin !== cfg\.embedOrigin/);
  assert.match(EMBED_SCRIPT, /window\.parent\.postMessage\(message, cfg\.embedOrigin\)/);
  assert.doesNotMatch(EMBED_SCRIPT, /postMessage\([^)]*'\*'\)/);
  // A tokenization failure sends the Accept.js code, never card data or raw text.
  assert.match(EMBED_SCRIPT, /type: 'vanta:pay:error', sessionId: cfg\.sessionId, code:/);
  // iOS Safari zooms into inputs under 16px.
  assert.match(html, /font-size:16px/);
});

// The token now travels in the URL fragment (never sent to the server), so
// the page is served without it; a token in the query (older links) is still
// shape-checked.
test('embed serves the static page with no token in the query; a malformed query token is still refused', async () => {
  const env = {
    VANTA_EMBED_ALLOWED_ORIGINS: 'https://vantalabsresearch.com',
    AUTHNET_API_LOGIN_ID: 'login', AUTHNET_TRANSACTION_KEY: 'txkey',
    SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'srk',
    VANTA_HMAC_KEY_ID: 'k', VANTA_HMAC_SHARED_SECRET: 's',
  };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const ok = res();
    await embed(req({ method: 'GET', url: '/api/payments/embed' }), ok);
    assert.equal(ok.statusCode, 200);
    assert.match(ok.headers['content-security-policy'], /frame-ancestors https:\/\/vantalabsresearch\.com/);
    assert.equal(ok.headers['referrer-policy'], 'no-referrer');
    assert.equal(ok.headers['cache-control'], 'no-store');
    const bad = res();
    await embed(req({ method: 'GET', url: '/api/payments/embed?session=vps_nope' }), bad);
    assert.equal(bad.statusCode, 400);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('the billing field accepts letters (Canadian postal codes) and is labelled for both', () => {
  const html = renderEmbedPage();
  const zip = html.match(/<input id="card-zip"[^>]*>/)[0];
  assert.doesNotMatch(zip, /inputmode="numeric"/);
  assert.match(zip, /autocomplete="postal-code"/);
  assert.match(html, /Billing ZIP \/ postal code/);
});
