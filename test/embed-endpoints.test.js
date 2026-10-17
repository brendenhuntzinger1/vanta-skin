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

// The live loaders name their tokenization endpoint in `encryptEndPoint`:
// https://js.authorize.net/v1/Accept.js posts to api2.authorize.net and
// https://jstest.authorize.net/v1/Accept.js to apitest.authorize.net
// (checked 2026-10-17; the loader is dated 2019-09-13). Without api2 the
// browser refuses every production card before it leaves the frame.
test('embed CSP: framed only by the approved Labs origins, Accept.js hosts reachable for load, integrity check and tokenization', () => {
  const csp = buildEmbedCsp(['https://vantalabsresearch.com']);
  assert.match(csp, /frame-ancestors https:\/\/vantalabsresearch\.com(;|$)/);
  const connect = csp.split('; ').find((d) => d.startsWith('connect-src'));
  assert.deepEqual(connect.split(' ').slice(1).sort(), [
    "'self'",
    'https://api.authorize.net',
    'https://api2.authorize.net',
    'https://apitest.authorize.net',
    'https://js.authorize.net',
    'https://jstest.authorize.net',
  ]);
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

function runErrorScript(html, { url, origins }) {
  const vm = require('node:vm');
  const { webcrypto } = require('node:crypto');
  const { metaFrom } = require('./support/embed-harness');
  const metas = metaFrom(html);
  const posted = [];
  const location = new URL(url);
  const win = {
    location: { hash: location.hash, search: location.search, pathname: location.pathname },
    history: { replaceState() {} },
    crypto: webcrypto,
    parent: { postMessage(message, targetOrigin) { posted.push({ message: structuredClone(message), targetOrigin }); } },
  };
  const context = {
    window: win,
    document: {
      querySelector(selector) {
        const name = /^meta\[name="([^"]+)"\]$/.exec(selector)[1];
        return name in metas ? { getAttribute: () => metas[name] } : null;
      },
    },
    URLSearchParams,
    TextEncoder,
  };
  vm.createContext(context);
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return new Promise((resolve) => setTimeout(() => resolve(posted), 20)).then((p) => {
    assert.deepEqual(p.map((x) => x.targetOrigin), origins);
    return p;
  });
}

// An iframe that gets raw JSON shows the shopper `{"ok":false,…}`. The embed
// answers its errors with a short page instead, and tells the Labs page.
test('embed errors are a small HTML page that tells the parent, never JSON or the reason', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { createHash } = require('node:crypto');
  const { EMBED_ERROR_SCRIPT } = require('../api/_lib/embed-page');
  const saved = { ...process.env };
  try {
    // Configuration the service cannot load (no HMAC secret, no database),
    // with a valid origin allowlist.
    for (const k of ['VANTA_HMAC_KEY_ID', 'VANTA_HMAC_SHARED_SECRET', 'VANTA_HMAC_KEYS_JSON', 'SUPABASE_URL']) delete process.env[k];
    process.env.VANTA_EMBED_ALLOWED_ORIGINS = 'https://vantalabsresearch.com';
    const r = res();
    await embed(req({ method: 'GET', url: '/api/payments/embed' }), r);
    assert.equal(r.statusCode, 503);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.doesNotMatch(r.text, /"ok"|HMAC|SUPABASE|configured/i);
    assert.match(r.text, /Secure card entry is temporarily unavailable\./);
    assert.match(r.text, /Your card was not charged/);
    const csp = r.headers['content-security-policy'];
    assert.match(csp, /frame-ancestors https:\/\/vantalabsresearch\.com(;|$)/);
    assert.ok(csp.includes(`'sha256-${createHash('sha256').update(EMBED_ERROR_SCRIPT, 'utf8').digest('base64')}'`));
    assert.doesNotMatch(csp, /unsafe-/);
    assert.doesNotMatch(csp, /connect-src/);
    const token = `vps_${'e'.repeat(64)}`;
    const posted = await runErrorScript(r.text, { url: `https://pay.vanta.skin/api/payments/embed#session=${token}`, origins: ['https://vantalabsresearch.com'] });
    assert.deepEqual(posted[0].message, {
      type: 'vanta:pay:failed',
      sessionId: createHash('sha256').update(token).digest('hex').slice(0, 24),
      code: 'VS_UNAVAILABLE',
    });

    // A malformed legacy query token: the same page, as a session problem.
    process.env.VANTA_EMBED_ALLOWED_ORIGINS = 'https://vantalabsresearch.com';
    const bad = res();
    await embed(req({ method: 'GET', url: '/api/payments/embed?session=vps_nope' }), bad);
    assert.equal(bad.statusCode, 400);
    assert.match(bad.headers['content-type'], /^text\/html/);
    assert.match(bad.text, /This secure payment link is no longer valid\./);
    const sessionPosts = await runErrorScript(bad.text, { url: 'https://pay.vanta.skin/api/payments/embed?session=vps_nope', origins: ['https://vantalabsresearch.com'] });
    assert.equal(sessionPosts[0].message.code, 'VS_SESSION');

    // An allowlist that cannot be read frames for no one, and posts to no one.
    process.env.VANTA_EMBED_ALLOWED_ORIGINS = 'not-an-origin';
    const none = res();
    await embed(req({ method: 'GET', url: '/api/payments/embed' }), none);
    assert.equal(none.statusCode, 503);
    assert.match(none.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.doesNotMatch(none.text, /not-an-origin/);
    await runErrorScript(none.text, { url: `https://pay.vanta.skin/api/payments/embed#session=${token}`, origins: [] });
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('session-validate keeps answering generic JSON', async () => {
  const r = res();
  await sessionValidate(req({ body: JSON.stringify({ sessionToken: 'nope' }) }), r);
  assert.match(r.headers['content-type'], /^application\/json/);
  assert.deepEqual(JSON.parse(r.text), { ok: false, error: 'Invalid or expired payment session' });
});

// Production Accept.js posts card data to api2.authorize.net (the sandbox to
// apitest). The policy is otherwise as strict as before.
test('embed CSP: production Accept.js host, and nothing loosened', () => {
  const csp = buildEmbedCsp(['https://vantalabsresearch.com']);
  const directives = Object.fromEntries(csp.split('; ').map((d) => [d.split(' ')[0], d]));
  assert.ok(directives['connect-src'].split(' ').includes('https://api2.authorize.net'));
  assert.equal(directives['img-src'], "img-src 'none'");
  assert.equal(directives['default-src'], "default-src 'none'");
  assert.doesNotMatch(csp, /unsafe-|\*|data:|blob:/);
  assert.equal(directives['script-src'].split(' ').length, 4, 'one hash and the two Accept.js hosts');
});

test('card inputs: length limits, numeric keyboards and card autofill; 16px text', () => {
  const html = renderEmbedPage(['https://vantalabsresearch.com']);
  const input = (id) => html.match(new RegExp(`<input id="${id}"[^>]*>`))[0];
  assert.match(input('card-number'), /maxlength="23"/, '19 digits typed in groups of four');
  assert.match(input('card-code'), /maxlength="4"/);
  for (const [id, ac] of [['card-number', 'cc-number'], ['card-exp-month', 'cc-exp-month'], ['card-exp-year', 'cc-exp-year'], ['card-code', 'cc-csc']]) {
    assert.match(input(id), new RegExp(`autocomplete="${ac}"`), id);
    assert.match(input(id), /inputmode="numeric"/, id);
  }
  assert.match(input('card-zip'), /maxlength="10"/);
  // A nameless form can never put card data in a URL by a native submit.
  assert.doesNotMatch(html, /<input[^>]* name=/);
  assert.match(html, /font-size:16px/);
});

// The inline scripts are template literals: a backslash escape such as \d is
// consumed by Node before the browser sees it (a past bug broke a regex that
// way). They are written without backslashes at all.
test('the inline frame scripts contain no backslash escapes', () => {
  const { EMBED_ERROR_SCRIPT } = require('../api/_lib/embed-page');
  for (const source of [EMBED_SCRIPT, EMBED_ERROR_SCRIPT]) {
    assert.equal(source.includes('\\'), false);
    assert.doesNotThrow(() => new Function(source));
  }
});
