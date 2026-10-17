const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, LABS, SESSION_ID, TOKEN } = require('./support/embed-harness');

// The fake browser lives in test/support/embed-harness.js: it runs the card
// frame's real script with the fields, the parent window, location/history,
// fetch (session-validate), timers, Web Crypto and Accept.js.

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
