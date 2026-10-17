const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
require('./support/fakes');
const embed = require('../api/payments/embed');
const { EMBED_SCRIPT } = require('../api/_lib/embed-page');
const { harness, LABS, OK_TOKEN, SESSION_ID, TOKEN } = require('./support/embed-harness');

// The frame ↔ Labs pay page contract (scratchpad/ws/CONTRACT.md, "Cross-repo
// message contract"). Labs enables Pay on `ready`, shows "the secure card form
// couldn't load" on `failed` VS_SCRIPT_LOAD / VS_UNAVAILABLE, opens a new
// session on `failed` VS_SESSION, and keeps Pay enabled on `error`
// VS_TOKENIZE_TIMEOUT. Each path below is driven through the real script.

const WWW = 'https://www.vantalabsresearch.com';
const CARD = { 'card-number': '4111 1111 1111 1111', 'card-exp-month': '12', 'card-exp-year': '2030', 'card-code': '123', 'card-zip': '78701' };
const submit = { type: 'vanta:pay:submit', sessionId: SESSION_ID };

// Every message any test in this file sees is checked once more at the end:
// no card data, no session token, no internal reason text, ever.
const everything = [];
function track(h) {
  everything.push(h);
  return h;
}

test('Accept.js is preloaded right after session-validate, and ready waits for dispatchData', async () => {
  const h = track(harness({ accept: 'load' }));
  await h.settle();
  assert.equal(h.scripts.length, 1, 'loaded before any submit');
  assert.equal(h.scripts[0].src, 'https://jstest.authorize.net/v1/Accept.js');
  const ready = h.posted('vanta:pay:ready');
  assert.equal(ready.length, 1);
  assert.deepEqual(ready[0], { message: { type: 'vanta:pay:ready', sessionId: SESSION_ID }, targetOrigin: LABS });
  assert.equal(h.fields['pay-form'].hidden, false);
});

test('no ready while Accept.js is still loading; a load that never finishes fails after 15 s', async () => {
  const h = track(harness({ accept: 'hang' }));
  await h.settle();
  assert.equal(h.scripts.length, 1);
  assert.equal(h.posted('vanta:pay:ready').length, 0);
  await h.advance(14999);
  assert.equal(h.posted('vanta:pay:failed').length, 0);
  await h.advance(1);
  assert.deepEqual(h.posted('vanta:pay:failed'), [
    { message: { type: 'vanta:pay:failed', sessionId: SESSION_ID, code: 'VS_SCRIPT_LOAD' }, targetOrigin: LABS },
  ]);
  // A script that turns up late does not revive a frame Labs has given up on.
  h.scripts[0].onload && h.scripts[0].onload();
  await h.advance(1000);
  assert.equal(h.posted('vanta:pay:ready').length, 0);
  assert.equal(h.posted('vanta:pay:failed').length, 1);
});

test('a blocked or failed Accept.js load posts failed VS_SCRIPT_LOAD, never a card error', async () => {
  const h = track(harness({ accept: 'error' }));
  await h.settle();
  assert.deepEqual(h.posted('vanta:pay:failed').map((p) => [p.message.code, p.targetOrigin]), [['VS_SCRIPT_LOAD', LABS]]);
  assert.equal(h.posted('vanta:pay:ready').length, 0);
  assert.equal(h.fields['pay-form'].hidden, true, 'no card fields to type into');
  // Labs keeps Pay off, but a stray submit still gets the load code.
  h.message(submit);
  await h.settle();
  assert.deepEqual(h.posted('vanta:pay:error').map((p) => p.message.code), ['VS_SCRIPT_LOAD']);
  // The timer for the abandoned load does not fire a second failure.
  await h.advance(20000);
  assert.equal(h.posted('vanta:pay:failed').length, 1);
});

// The live loader defines Accept.dispatchData at once, but as a stub that
// answers E_WC_03 until AcceptCore.js sets window.isReady (after the
// loader's own onload). ready before that failed every first press.
test('no ready while window.isReady is false even though dispatchData exists; the first press after ready tokenizes', async () => {
  const h = track(harness({ accept: 'core-pending' }));
  await h.settle();
  assert.equal(typeof h.win.Accept.dispatchData, 'function');
  await h.advance(5000);
  assert.equal(h.posted('vanta:pay:ready').length, 0);
  h.fill(CARD);
  h.message(submit);
  await h.settle();
  assert.deepEqual(h.posted('vanta:pay:error').map((p) => p.message.code), ['VS_SCRIPT_LOAD']);
  assert.equal(h.stubCalls.length, 0, 'the E_WC_03 stub is never called');
  h.coreReady();
  await h.advance(50);
  assert.equal(h.posted('vanta:pay:ready').length, 1);
  h.message(submit);
  await h.settle();
  assert.equal(h.stubCalls.length, 0);
  assert.equal(h.dispatched.length, 1);
  assert.equal(h.posted('vanta:pay:tokenized').length, 1);
  assert.deepEqual(h.posted('vanta:pay:error').map((p) => p.message.code), ['VS_SCRIPT_LOAD'], 'no E_WC_03');
  assert.equal(h.posted('vanta:pay:failed').length, 0);
});

test('a script that loads without Accept.dispatchData is a load failure', async () => {
  const h = track(harness({ accept: 'no-dispatch' }));
  await h.settle();
  assert.equal(h.posted('vanta:pay:ready').length, 0);
  await h.advance(15000);
  assert.deepEqual(h.posted('vanta:pay:failed').map((p) => p.message.code), ['VS_SCRIPT_LOAD']);
});

test('submit before Accept.js is ready answers VS_SCRIPT_LOAD and sends nothing to Accept.js', async () => {
  const h = track(harness({ accept: 'hang' }));
  await h.settle();
  h.fill(CARD);
  h.message(submit);
  await h.settle();
  assert.equal(h.dispatched.length, 0);
  assert.deepEqual(h.posted('vanta:pay:error'), [
    { message: { type: 'vanta:pay:error', sessionId: SESSION_ID, code: 'VS_SCRIPT_LOAD' }, targetOrigin: LABS },
  ]);
  assert.equal(h.fields['card-number'].value, CARD['card-number'], 'card kept');
});

test('session-validate refusal posts failed VS_SESSION once to each approved parent origin', async () => {
  const h = track(harness({ validate: { status: 400, json: { ok: false, error: 'Invalid or expired payment session' } } }));
  await h.settle();
  const failed = h.posted('vanta:pay:failed');
  assert.deepEqual(failed.map((p) => p.targetOrigin), [LABS, WWW]);
  for (const p of failed) assert.deepEqual(p.message, { type: 'vanta:pay:failed', sessionId: SESSION_ID, code: 'VS_SESSION' });
  assert.equal(h.posted('vanta:pay:ready').length, 0);
  assert.equal(h.scripts.length, 0, 'Accept.js is not loaded for a dead session');
  assert.doesNotMatch(h.fields['pay-status'].textContent, /Invalid or expired/, 'no server text in the frame');
  assert.equal(h.fields['pay-form'].hidden, true);
});

test('session-validate 5xx or a network error posts failed VS_UNAVAILABLE', async () => {
  for (const validate of [
    { status: 503, json: { ok: false, error: 'Secure card entry is temporarily unavailable' } },
    { status: 502, json: undefined },
    'network',
  ]) {
    const h = track(harness({ validate }));
    await h.settle();
    const failed = h.posted('vanta:pay:failed');
    assert.deepEqual(failed.map((p) => [p.message.code, p.targetOrigin]), [['VS_UNAVAILABLE', LABS], ['VS_UNAVAILABLE', WWW]], JSON.stringify(validate));
    assert.equal(failed[0].message.sessionId, SESSION_ID);
  }
});

test('a validate answer without a usable session is treated as unavailable', async () => {
  const h = track(harness({ validate: { status: 200, json: { ok: true, sessionId: 'nope', embedOrigin: LABS } } }));
  await h.settle();
  assert.deepEqual(h.posted('vanta:pay:failed').map((p) => p.message.code), ['VS_UNAVAILABLE', 'VS_UNAVAILABLE']);
  assert.equal(h.posted('vanta:pay:ready').length, 0);
});

test('a malformed session token fails as VS_SESSION; a missing one posts nothing it could not bind', async () => {
  const bad = 'vps_nope';
  const h = track(harness({ url: `https://pay.vanta.skin/api/payments/embed#session=${bad}` }));
  await h.settle();
  assert.equal(h.fetches.length, 0);
  const expected = createHash('sha256').update(bad).digest('hex').slice(0, 24);
  assert.deepEqual(h.posted('vanta:pay:failed').map((p) => [p.message.sessionId, p.message.code]), [[expected, 'VS_SESSION'], [expected, 'VS_SESSION']]);

  const none = track(harness({ url: 'https://pay.vanta.skin/api/payments/embed' }));
  await none.settle();
  assert.equal(none.parent.posted.length, 0);
});

test('without Web Crypto the frame still starts, using the session id from validate', async () => {
  const ok = track(harness({ crypto: null }));
  await ok.settle();
  assert.deepEqual(ok.posted('vanta:pay:ready').map((p) => p.message.sessionId), [SESSION_ID]);

  // A failure it cannot bind to a session is not posted (Labs' own load timer
  // covers it), and nothing throws.
  const failed = track(harness({ crypto: null, validate: { status: 400, json: { ok: false } } }));
  await failed.settle();
  assert.equal(failed.parent.posted.length, 0);
  assert.notEqual(failed.fields['pay-status'].textContent, '');
});

test('dispatchData that never calls back: VS_TOKENIZE_TIMEOUT after 20 s, busy reset, card kept', async () => {
  const h = track(harness({ dispatch: 'hang' }));
  await h.settle();
  h.fill(CARD);
  h.message(submit);
  await h.settle();
  assert.equal(h.dispatched.length, 1);
  h.message(submit); // a second press while the first is in flight is ignored
  await h.advance(19999);
  assert.equal(h.dispatched.length, 1);
  assert.equal(h.posted('vanta:pay:error').length, 0);
  await h.advance(1);
  assert.deepEqual(h.posted('vanta:pay:error'), [
    { message: { type: 'vanta:pay:error', sessionId: SESSION_ID, code: 'VS_TOKENIZE_TIMEOUT' }, targetOrigin: LABS },
  ]);
  for (const id of Object.keys(CARD)) assert.equal(h.fields[id].value, CARD[id], `${id} kept for retry`);

  // A late answer to the abandoned attempt is dropped: Labs has already told
  // the shopper to try again, and only the retry's token may be charged.
  h.pendingDispatch[0]({ messages: { resultCode: 'Ok', message: [] }, opaqueData: OK_TOKEN });
  await h.settle();
  assert.equal(h.posted('vanta:pay:tokenized').length, 0);

  // busy was reset: the retry reaches Accept.js again.
  h.message(submit);
  await h.settle();
  assert.equal(h.dispatched.length, 2);
  h.pendingDispatch[1]({ messages: { resultCode: 'Ok', message: [] }, opaqueData: OK_TOKEN });
  await h.settle();
  assert.equal(h.posted('vanta:pay:tokenized').length, 1);
  // The guard of the finished attempt does not fire afterwards.
  await h.advance(30000);
  assert.equal(h.posted('vanta:pay:error').length, 1);
});

test('Accept.js card errors keep their own code; a throwing library is a load problem', async () => {
  const h = track(harness({ dispatch: 'error' }));
  await h.settle();
  h.fill(CARD);
  h.message(submit);
  await h.settle();
  assert.deepEqual(h.posted('vanta:pay:error').map((p) => p.message.code), ['E_WC_05']);

  const t = track(harness({ dispatch: 'throw' }));
  await t.settle();
  t.fill(CARD);
  t.message(submit);
  await t.settle();
  assert.deepEqual(t.posted('vanta:pay:error').map((p) => p.message.code), ['VS_SCRIPT_LOAD']);
  t.message(submit);
  await t.settle();
  assert.equal(t.dispatched.length, 2, 'busy reset after the throw');
});

test('spaces in the card number are removed before Accept.js', async () => {
  const h = track(harness());
  await h.settle();
  h.fill(CARD);
  h.message(submit);
  await h.settle();
  assert.equal(h.dispatched[0].cardData.cardNumber, '4111111111111111');
  assert.deepEqual(h.posted('vanta:pay:tokenized')[0].message, { type: 'vanta:pay:tokenized', sessionId: SESSION_ID, opaqueData: OK_TOKEN });
});

test('no message in any path carries card data, the session token or internal text', () => {
  assert.ok(everything.length >= 10);
  const allowedKeys = new Set(['type', 'sessionId', 'code', 'opaqueData']);
  for (const h of everything) {
    for (const { message, targetOrigin } of h.parent.posted) {
      assert.notEqual(targetOrigin, '*');
      for (const key of Object.keys(message)) assert.ok(allowedKeys.has(key), key);
      const text = JSON.stringify(message);
      for (const secret of ['4111', TOKEN, 'vps_', '2030', '"123"', '78701', 'Invalid or expired', 'unavailable', 'library broken']) {
        assert.equal(text.includes(secret), false, `${secret} in ${text}`);
      }
    }
  }
});

function req(url) {
  const stream = Readable.from([Buffer.from('')]);
  stream.method = 'GET';
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

const ENV = {
  VANTA_EMBED_ALLOWED_ORIGINS: `${LABS},${WWW}`,
  AUTHNET_API_LOGIN_ID: 'login', AUTHNET_TRANSACTION_KEY: 'txkey',
  SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'srk',
  VANTA_HMAC_KEY_ID: 'k', VANTA_HMAC_SHARED_SECRET: 's',
};

async function served() {
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
  try {
    const r = res();
    await embed(req('/api/payments/embed'), r);
    return r;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('the served page: CSP hash matches the inline script, parent origins sit outside it', async () => {
  const r = await served();
  assert.equal(r.statusCode, 200);
  const csp = r.headers['content-security-policy'];
  const scripts = [...r.text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0], EMBED_SCRIPT);
  const hash = `'sha256-${createHash('sha256').update(scripts[0], 'utf8').digest('base64')}'`;
  const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src '));
  assert.ok(scriptSrc.includes(hash), 'served inline script is the hashed one');
  assert.equal(r.text.match(/<meta name="vanta-parent-origins" content='([^']*)'>/)[1], JSON.stringify([LABS, WWW]).replace(/"/g, '&quot;'));
  assert.ok(r.text.indexOf('vanta-parent-origins') < r.text.indexOf('<script>'));
  assert.match(csp, /frame-ancestors https:\/\/vantalabsresearch\.com https:\/\/www\.vantalabsresearch\.com(;|$)/);
});

test('the served page runs end to end in the harness with its own meta origins', async () => {
  const r = await served();
  const h = track(harness({ html: r.text, validate: { status: 400, json: { ok: false } } }));
  await h.settle();
  assert.deepEqual(h.posted('vanta:pay:failed').map((p) => p.targetOrigin), [LABS, WWW]);
});
