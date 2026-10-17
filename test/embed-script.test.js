const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { EMBED_SCRIPT } = require('../api/_lib/embed-page');

// Runs the card frame's real script against a minimal fake browser: the
// fields, the parent window, location/history, fetch (session-validate) and
// Accept.js. Each test drives it the way the Labs page and the shopper do.
//
// The fake Accept.js behaves like the live one: dispatchData is a stub that
// answers E_WC_03 until AcceptCore.js has announced itself (window.isReady).
// `accept` picks the starting state: 'ready' (loaded and ready), 'absent' (no
// script yet; h.loadScript() answers the frame's <script>), 'core-pending'
// (loaded, AcceptCore not ready until h.coreReady()) or 'silent' (ready, but
// dispatchData never calls back until h.answerLate()).

const TOKEN = `vps_${'b'.repeat(64)}`;
const SESSION_ID = 'c'.repeat(24);
const LABS = 'https://vantalabsresearch.com';

function harness({ url = `https://pay.vanta.skin/api/payments/embed#session=${TOKEN}`, acceptResult, accept = 'ready' } = {}) {
  const fields = {};
  const el = (id) => {
    if (!fields[id]) {
      fields[id] = { id, value: '', hidden: true, textContent: '', className: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
    }
    return fields[id];
  };
  const parent = { posted: [], postMessage(message, targetOrigin) { this.posted.push({ message, targetOrigin }); } };
  const windowListeners = {};
  const location = new URL(url);
  const replaced = [];
  const fetches = [];
  const dispatched = [];
  const scripts = [];
  const pendingCallbacks = [];
  const okResult = { messages: { resultCode: 'Ok', message: [] }, opaqueData: { dataDescriptor: 'COMMON.ACCEPT.INAPP.PAYMENT', dataValue: 'tok' } };
  const acceptLib = {
    dispatchData(request, cb) {
      if (win.isReady !== true) {
        cb({ messages: { resultCode: 'Error', message: [{ code: 'E_WC_03', text: 'Accept.js is not loaded correctly' }] } });
        return;
      }
      dispatched.push(request);
      if (accept === 'silent') { pendingCallbacks.push(cb); return; }
      cb(acceptResult || okResult);
    },
  };
  const win = {
    parent,
    location: { search: location.search, hash: location.hash, pathname: location.pathname },
    history: { replaceState(_s, _t, next) { replaced.push(next); } },
    addEventListener(type, fn) { windowListeners[type] = fn; },
  };
  if (accept !== 'absent') win.Accept = acceptLib;
  if (accept === 'ready' || accept === 'silent') win.isReady = true;
  const head = {
    appendChild(node) { node.parentNode = head; scripts.push(node); },
    removeChild(node) { node.parentNode = null; },
  };
  const context = {
    window: win,
    document: { getElementById: el, createElement: (tag) => ({ tag, parentNode: null }), head },
    URLSearchParams,
    history: win.history,
    location: win.location,
    fetch: async (path, init) => {
      fetches.push({ path, body: JSON.parse(init.body) });
      return {
        status: 200,
        json: async () => ({ ok: true, sessionId: SESSION_ID, embedOrigin: LABS, authnet: { apiLoginId: 'login', clientKey: 'client', sandbox: true } }),
      };
    },
    Promise,
    Error,
    // Late-bound so node:test mock timers, enabled after the harness is
    // built, still drive the frame's timers.
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (id) => clearTimeout(id),
    Date: { now: () => Date.now() },
  };
  vm.createContext(context);
  vm.runInContext(EMBED_SCRIPT, context);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    fields, parent, fetches, replaced, dispatched, scripts, settle,
    posted: (type) => parent.posted.filter((p) => p.message.type === type).map((p) => p.message),
    loadScript(index, ok = true) {
      const node = scripts[index];
      if (!ok) return node.onerror();
      win.Accept = acceptLib;
      if (accept !== 'core-pending') win.isReady = true;
      return node.onload();
    },
    coreReady() { win.isReady = true; },
    answerLate(result = okResult) { pendingCallbacks.shift()(result); },
    message: (data, { origin = LABS, source = parent } = {}) => windowListeners.message && windowListeners.message({ data, origin, source }),
    fill(card) {
      for (const [id, value] of Object.entries(card)) el(id).value = value;
    },
  };
}

const CARD = { 'card-number': '4111111111111111', 'card-exp-month': '12', 'card-exp-year': '2030', 'card-code': '123' };
const submit = { type: 'vanta:pay:submit', sessionId: SESSION_ID };

// The session token travels in the URL fragment: browsers never send a
// fragment to the server, so it stays out of Vercel's request logs and any
// Referer. The frame then drops it from its own address.
test('reads the session token from the URL fragment and removes it from the frame address', async () => {
  const h = harness();
  await h.settle();
  assert.deepEqual(h.fetches.map((f) => f.body.sessionToken), [TOKEN]);
  assert.deepEqual(h.replaced, ['/api/payments/embed']);
  assert.equal(h.parent.posted[0].message.type, 'vanta:pay:ready');
  assert.equal(h.parent.posted[0].targetOrigin, LABS);
});

test('still accepts a session token in the query string (links issued before the change)', async () => {
  const h = harness({ url: `https://pay.vanta.skin/api/payments/embed?session=${TOKEN}` });
  await h.settle();
  assert.deepEqual(h.fetches.map((f) => f.body.sessionToken), [TOKEN]);
});

test('a malformed token is refused before any request', async () => {
  const h = harness({ url: 'https://pay.vanta.skin/api/payments/embed#session=vps_nope' });
  await h.settle();
  assert.equal(h.fetches.length, 0);
});

// The origin check alone accepts any window of the Labs origin (another tab,
// a popup). Only the page that framed this card form may ask it to tokenize.
test('tokenizes only for the parent window at the approved origin, for this session', async () => {
  const h = harness();
  await h.settle();
  h.fill({ ...CARD, 'card-zip': '78701' });
  h.message(submit, { source: { postMessage() {} } }); // another Labs window
  h.message(submit, { origin: 'https://evil.example' });
  h.message({ ...submit, sessionId: 'd'.repeat(24) });
  await h.settle();
  assert.equal(h.dispatched.length, 0);
  h.message(submit);
  await h.settle();
  assert.equal(h.dispatched.length, 1);
  const tokenized = h.parent.posted.find((p) => p.message.type === 'vanta:pay:tokenized');
  assert.ok(tokenized);
  assert.equal(tokenized.targetOrigin, LABS);
  assert.equal(JSON.stringify(tokenized.message).includes('4111'), false);
});

test('US ZIP and Canadian postal codes are accepted, normalised for Authorize.Net', async () => {
  for (const [typed, sent] of [
    ['78701', '78701'],
    ['78701-1234', '78701-1234'],
    ['k1a 0b1', 'K1A 0B1'],
    ['K1A0B1', 'K1A 0B1'],
    ['  m5v-2t6 ', 'M5V 2T6'],
  ]) {
    const h = harness();
    await h.settle();
    h.fill({ ...CARD, 'card-zip': typed });
    h.message(submit);
    await h.settle();
    assert.equal(h.dispatched.length, 1, typed);
    assert.equal(h.dispatched[0].cardData.zip, sent, typed);
  }
});

test('an invalid billing postal code is refused in the frame, never sent to Accept.js', async () => {
  for (const typed of ['', '1234', '787011', 'ABCDE', 'D1A 0B1', '78701-12', 'K1A 0B']) {
    const h = harness();
    await h.settle();
    h.fill({ ...CARD, 'card-zip': typed });
    h.message(submit);
    await h.settle();
    assert.equal(h.dispatched.length, 0, typed);
    const error = h.parent.posted.find((p) => p.message.type === 'vanta:pay:error');
    assert.equal(error && error.message.code, 'VS_POSTAL', typed);
    assert.equal(h.fields['card-number'].value, CARD['card-number'], 'card details kept for correction');
  }
});

test('the card fields are cleared once Accept.js returns a token', async () => {
  const h = harness();
  await h.settle();
  h.fill({ ...CARD, 'card-zip': '78701' });
  h.message(submit);
  await h.settle();
  for (const id of ['card-number', 'card-exp-month', 'card-exp-year', 'card-code', 'card-zip']) {
    assert.equal(h.fields[id].value, '', id);
  }
});

// --- Accept.js loading, stalls and recovery ----------------------------------
//
// The live loader injects AcceptCore.js itself and only then replaces its
// E_WC_03 stub, after the loader's own onload has fired. Calling dispatchData
// at onload therefore failed every first press (seen in Chromium against the
// live files, sandbox and production alike).

test('Accept.js is loaded once the session is valid, before the first press', async () => {
  const h = harness({ accept: 'absent' });
  await h.settle();
  assert.equal(h.scripts.length, 1);
  assert.equal(h.scripts[0].src, 'https://jstest.authorize.net/v1/Accept.js');
});

// Merged with the frame contract (VS_* codes, ready only once Accept.js is
// usable): a press before AcceptCore is ready cannot happen from the Labs
// page, which enables Pay on ready; if one arrives anyway it is answered
// VS_SCRIPT_LOAD instead of reaching the E_WC_03 stub.
test('a press before AcceptCore is ready is answered VS_SCRIPT_LOAD, never the E_WC_03 stub; ready follows AcceptCore', async (t) => {
  const h = harness({ accept: 'core-pending' });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  await h.settle();
  h.fill({ ...CARD, 'card-zip': '78701' });
  h.message(submit);
  await h.settle();
  t.mock.timers.tick(500);
  await h.settle();
  assert.deepEqual(h.posted('vanta:pay:error').map((m) => m.code), ['VS_SCRIPT_LOAD'], 'no E_WC_03 while AcceptCore loads');
  assert.equal(h.posted('vanta:pay:ready').length, 0);
  h.coreReady();
  t.mock.timers.tick(50);
  await h.settle();
  assert.equal(h.posted('vanta:pay:ready').length, 1);
  h.message(submit);
  await h.settle();
  assert.equal(h.dispatched.length, 1);
  assert.equal(h.posted('vanta:pay:tokenized').length, 1);
});

test('Accept.js that fails to load is reported as failed VS_SCRIPT_LOAD, keeps the card, and the next press loads it again', async () => {
  const h = harness({ accept: 'absent' });
  await h.settle();
  h.loadScript(0, false); // the background load fails
  await h.settle();
  assert.deepEqual(h.posted('vanta:pay:failed').map((m) => m.code), ['VS_SCRIPT_LOAD']);
  assert.equal(h.posted('vanta:pay:ready').length, 0);
  assert.equal(h.scripts[0].parentNode, null, 'the failed <script> is removed');
  h.fill({ ...CARD, 'card-zip': '78701' });
  h.message(submit); // the press is answered, and tries the loader again…
  await h.settle();
  assert.deepEqual(h.posted('vanta:pay:error').map((m) => m.code), ['VS_SCRIPT_LOAD']);
  assert.equal(h.scripts.length, 2);
  h.loadScript(1, false); // …which fails too, reported once only
  await h.settle();
  assert.equal(h.posted('vanta:pay:failed').length, 1);
  assert.equal(h.fields['card-number'].value, CARD['card-number'], 'card details kept');
  h.message(submit); // the network is back
  await h.settle();
  assert.equal(h.scripts.length, 3);
  h.loadScript(2);
  await h.settle();
  assert.equal(h.posted('vanta:pay:ready').length, 1);
  h.message(submit);
  await h.settle();
  assert.equal(h.posted('vanta:pay:tokenized').length, 1);
});

test('AcceptCore that never becomes ready is reported as failed VS_SCRIPT_LOAD after 15 seconds', async (t) => {
  const h = harness({ accept: 'core-pending' });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  await h.settle();
  h.fill({ ...CARD, 'card-zip': '78701' });
  for (let ms = 0; ms < 15_100; ms += 100) {
    t.mock.timers.tick(100);
    await h.settle();
  }
  assert.deepEqual(h.posted('vanta:pay:failed').map((m) => m.code), ['VS_SCRIPT_LOAD']);
  assert.equal(h.dispatched.length, 0);
  // The half-loaded library is thrown away; the next press starts again
  // from the loader (which fetches AcceptCore.js anew) and the card stays.
  assert.equal(h.scripts.length, 0, 'the frame found Accept already defined and added no script');
  h.message(submit);
  await h.settle();
  assert.deepEqual(h.posted('vanta:pay:error').map((m) => m.code), ['VS_SCRIPT_LOAD']);
  assert.equal(h.scripts.length, 1, 'a fresh loader <script>');
  h.loadScript(0);
  h.coreReady();
  t.mock.timers.tick(50);
  await h.settle();
  assert.equal(h.posted('vanta:pay:ready').length, 1);
  h.message(submit);
  await h.settle();
  assert.equal(h.posted('vanta:pay:tokenized').length, 1);
  assert.equal(h.fields['card-number'].value, '', 'cleared only once tokenized');
});

test('an unanswered press gives the form back after 20 seconds; a late answer is dropped', async (t) => {
  const h = harness({ accept: 'silent' });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  await h.settle();
  h.fill({ ...CARD, 'card-zip': '78701' });
  h.message(submit);
  await h.settle();
  h.message(submit); // a second press while busy is ignored, as before
  await h.settle();
  assert.equal(h.dispatched.length, 1);
  t.mock.timers.tick(20_000);
  await h.settle();
  assert.deepEqual(h.posted('vanta:pay:error').map((m) => m.code), ['VS_TOKENIZE_TIMEOUT']);
  assert.equal(h.fields['card-number'].value, CARD['card-number'], 'card details kept');
  h.answerLate();
  await h.settle();
  assert.equal(h.posted('vanta:pay:tokenized').length, 0, 'no token for an abandoned press');
  assert.equal(h.fields['card-number'].value, CARD['card-number'], 'fields not cleared by a late answer');
  h.message(submit); // the form is usable again
  await h.settle();
  assert.equal(h.dispatched.length, 2);
});

test('an Accept.js error is passed to the parent by code and keeps the card details', async () => {
  const h = harness({ acceptResult: { messages: { resultCode: 'Error', message: [{ code: 'E_WC_05', text: 'bad card' }] } } });
  await h.settle();
  h.fill({ ...CARD, 'card-zip': '78701' });
  h.message(submit);
  await h.settle();
  assert.deepEqual(h.posted('vanta:pay:error').map((m) => m.code), ['E_WC_05']);
  assert.equal(h.fields['card-number'].value, CARD['card-number']);
});

test('the frame answers a press before the Labs page gives up on it (30 seconds)', () => {
  const ms = (name) => Number(new RegExp(`var ${name} = (\\d+);`).exec(EMBED_SCRIPT)[1]);
  assert.ok(ms('ACCEPT_READY_TIMEOUT_MS') < ms('TOKENIZE_TIMEOUT_MS'));
  assert.ok(ms('TOKENIZE_TIMEOUT_MS') < 30_000);
});
