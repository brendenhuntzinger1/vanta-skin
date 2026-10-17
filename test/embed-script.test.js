const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { EMBED_SCRIPT } = require('../api/_lib/embed-page');

// Runs the card frame's real script against a minimal fake browser: the
// fields, the parent window, location/history, fetch (session-validate) and
// Accept.js. Each test drives it the way the Labs page and the shopper do.

const TOKEN = `vps_${'b'.repeat(64)}`;
const SESSION_ID = 'c'.repeat(24);
const LABS = 'https://vantalabsresearch.com';

function harness({ url = `https://pay.vanta.skin/api/payments/embed#session=${TOKEN}`, acceptResult } = {}) {
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
  const win = {
    parent,
    location: { search: location.search, hash: location.hash, pathname: location.pathname },
    history: { replaceState(_s, _t, next) { replaced.push(next); } },
    addEventListener(type, fn) { windowListeners[type] = fn; },
    Accept: {
      dispatchData(request, cb) {
        dispatched.push(request);
        cb(acceptResult || { messages: { resultCode: 'Ok', message: [] }, opaqueData: { dataDescriptor: 'COMMON.ACCEPT.INAPP.PAYMENT', dataValue: 'tok' } });
      },
    },
  };
  const context = {
    window: win,
    document: { getElementById: el, createElement: () => ({}), head: { appendChild() {} } },
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
  };
  vm.createContext(context);
  vm.runInContext(EMBED_SCRIPT, context);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    fields, parent, fetches, replaced, dispatched, settle,
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
