const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertPaymentSessionTokenShape,
  assertSessionMatchesCharge,
  buildFrameAncestors,
  buildPublicSessionPayload,
  generatePaymentSessionToken,
  hashPaymentSessionToken,
  isAllowedEmbedOrigin,
  isValidEmbedMessage,
  normalizeOrigin,
  paymentSessionIdFromToken,
} = require('../api/_lib/payment-session');
const { EMBED_SCRIPT, EMBED_STYLE, buildEmbedCsp, renderEmbedPage } = require('../api/_lib/embed-page');
const { createHash } = require('node:crypto');

// --- Token handling -------------------------------------------------------

test('generatePaymentSessionToken returns 256-bit tokens with the vps_ prefix', () => {
  const a = generatePaymentSessionToken();
  const b = generatePaymentSessionToken();
  assert.match(a, /^vps_[0-9a-f]{64}$/);
  assert.match(b, /^vps_[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('assertPaymentSessionTokenShape rejects malformed tokens', () => {
  for (const bad of ['', 'vps_', 'vps_xyz', 'abc123', 42, null, undefined, 'vps_' + 'g'.repeat(64)]) {
    assert.throws(() => assertPaymentSessionTokenShape(bad), /Invalid payment session token/);
  }
  assert.doesNotThrow(() => assertPaymentSessionTokenShape(generatePaymentSessionToken()));
});

test('hashPaymentSessionToken is deterministic and never stores raw tokens', () => {
  const token = generatePaymentSessionToken();
  const hash = hashPaymentSessionToken(token);
  assert.equal(hash, createHash('sha256').update(token, 'utf8').digest('hex'));
  assert.equal(hash.includes(token), false);
});

test('paymentSessionIdFromToken derives a stable non-secret session handle', () => {
  const token = generatePaymentSessionToken();
  const id = paymentSessionIdFromToken(token);
  assert.match(id, /^[0-9a-f]{24}$/);
  assert.equal(id, hashPaymentSessionToken(token).slice(0, 24));
});

// --- Origin allowlist -----------------------------------------------------

test('normalizeOrigin accepts only clean https origins', () => {
  assert.equal(normalizeOrigin('https://vantalabsresearch.com'), 'https://vantalabsresearch.com');
  assert.equal(normalizeOrigin('  HTTPS://VantaLabsResearch.com '), 'https://vantalabsresearch.com');
  assert.equal(normalizeOrigin('https://preview-abc.vercel.app'), 'https://preview-abc.vercel.app');

  for (const bad of [
    'http://vantalabsresearch.com',          // plain http
    'https://vantalabsresearch.com/path',    // paths are not origins
    'https://vantalabsresearch.com?q=1',
    'https://vantalabsresearch.com#frag',
    'https://user:pass@vantalabsresearch.com',
    'vantalabsresearch.com',
    '',
    null,
    'javascript:alert(1)',
  ]) {
    assert.equal(normalizeOrigin(bad), null, bad);
  }
});

test('isAllowedEmbedOrigin requires an exact allowlist match', () => {
  const allowed = ['https://vantalabsresearch.com'];
  assert.equal(isAllowedEmbedOrigin(allowed, 'https://vantalabsresearch.com'), true);

  for (const attack of [
    'https://evilvantalabsresearch.com',
    'https://vantalabsresearch.com.evil.test',
    'https://evil.test#vantalabsresearch.com',
    'https://evil.test?vantalabsresearch.com',
    'http://vantalabsresearch.com',
    'https://vantalabsresearch.com:8443',
  ]) {
    assert.equal(isAllowedEmbedOrigin(allowed, attack), false, attack);
  }
});

test('buildFrameAncestors locks framing to the allowlist or nobody', () => {
  assert.equal(buildFrameAncestors([]), "frame-ancestors 'none'");
  assert.equal(
    buildFrameAncestors(['https://vantalabsresearch.com', 'https://preview-abc.vercel.app']),
    'frame-ancestors https://vantalabsresearch.com https://preview-abc.vercel.app',
  );
  // Invalid entries can never widen the policy.
  assert.equal(buildFrameAncestors(['http://insecure.test']), "frame-ancestors 'none'");
});

// --- Session-to-charge binding --------------------------------------------

function validRecord(overrides = {}) {
  return {
    token_hash: 'a'.repeat(64),
    order_id: 'labs-order-123',
    amount_cents: 12995,
    currency: 'USD',
    origin_storefront: 'vantalabsresearch.com',
    parent_origin: 'https://vantalabsresearch.com',
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    consumed_at: null,
    ...overrides,
  };
}

const charge = { orderId: 'labs-order-123', amountCents: 12995, originStorefront: 'vantalabsresearch.com' };

test('assertSessionMatchesCharge accepts a matching live session', () => {
  assert.equal(assertSessionMatchesCharge(validRecord(), charge).order_id, 'labs-order-123');
});

test('assertSessionMatchesCharge rejects unknown, used and expired sessions', () => {
  assert.throws(() => assertSessionMatchesCharge(null, charge), /Unknown payment session/);

  assert.throws(
    () => assertSessionMatchesCharge(validRecord({ consumed_at: new Date().toISOString() }), charge),
    /already been used/,
  );
  try {
    assertSessionMatchesCharge(validRecord({ consumed_at: new Date().toISOString() }), charge);
  } catch (err) {
    assert.equal(err.statusCode, 409);
  }

  assert.throws(
    () => assertSessionMatchesCharge(validRecord({ expires_at: new Date(Date.now() - 1000).toISOString() }), charge),
    /expired/,
  );
});

test('assertSessionMatchesCharge rejects order, amount and storefront drift', () => {
  assert.throws(() => assertSessionMatchesCharge(validRecord(), { ...charge, orderId: 'other' }), /order mismatch/);
  assert.throws(() => assertSessionMatchesCharge(validRecord(), { ...charge, amountCents: 1 }), /amount mismatch/);
  assert.throws(
    () => assertSessionMatchesCharge(validRecord(), { ...charge, originStorefront: 'evil.test' }),
    /storefront mismatch/,
  );
});

// --- postMessage protocol ---------------------------------------------------

const sid = paymentSessionIdFromToken(generatePaymentSessionToken());

test('isValidEmbedMessage accepts only the exact type and session', () => {
  assert.equal(isValidEmbedMessage({ type: 'vanta:pay:submit', sessionId: sid }, { type: 'vanta:pay:submit', sessionId: sid }), true);

  for (const bad of [
    { type: 'vanta:pay:submit', sessionId: 'b'.repeat(24) },       // wrong session
    { type: 'vanta:pay:tokenized', sessionId: sid },               // wrong type for this check
    { type: 'vanta:pay:submit' },                                  // missing sessionId
    { type: 'vanta:pay:submit', sessionId: sid.toUpperCase() },    // case-normalization attack
    'vanta:pay:submit',
    null,
    [{ type: 'vanta:pay:submit', sessionId: sid }],
  ]) {
    assert.equal(isValidEmbedMessage(bad, { type: 'vanta:pay:submit', sessionId: sid }), false, JSON.stringify(bad));
  }
});

// --- Browser payload can never leak secrets ---------------------------------

test('buildPublicSessionPayload exposes only public per-session fields', () => {
  const authnetConfig = {
    apiLoginId: 'public-login',
    transactionKey: 'SUPER-SECRET-TRANSACTION-KEY',
    signatureKey: 'SUPER-SECRET-SIGNATURE-KEY',
    sandbox: true,
  };
  const payload = buildPublicSessionPayload(validRecord(), authnetConfig, 'public-client-key');
  const serialized = JSON.stringify(payload);

  assert.equal(serialized.includes('SUPER-SECRET-TRANSACTION-KEY'), false);
  assert.equal(serialized.includes('SUPER-SECRET-SIGNATURE-KEY'), false);
  assert.deepEqual(Object.keys(payload.authnet).sort(), ['apiLoginId', 'clientKey', 'sandbox']);
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['authnet', 'embedOrigin', 'ok', 'sessionId'],
  );
  // The raw token is never returned; the sessionId is a truncated hash.
  assert.equal(payload.sessionId, validRecord().token_hash.slice(0, 24));
});

// --- Hosted component page and CSP ------------------------------------------

test('buildEmbedCsp restricts framing, scripts and connections', () => {
  const csp = buildEmbedCsp(['https://vantalabsresearch.com']);

  assert.match(csp, /frame-ancestors https:\/\/vantalabsresearch\.com/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'sha256-[A-Za-z0-9+/=]+' https:\/\/jstest\.authorize\.net https:\/\/js\.authorize\.net/);
  assert.match(csp, /connect-src 'self' https:\/\/apitest\.authorize\.net https:\/\/api\.authorize\.net https:\/\/api2\.authorize\.net/);
  // No unsafe-inline anywhere: inline script/style are hash-locked.
  assert.equal(csp.includes('unsafe-inline'), false);
  assert.equal(csp.includes('*'), false);
});

test('buildEmbedCsp script hash matches the exact inline script', () => {
  const expected = `'sha256-${createHash('sha256').update(EMBED_SCRIPT, 'utf8').digest('base64')}'`;
  assert.ok(buildEmbedCsp(['https://vantalabsresearch.com']).includes(expected));
  const styleHash = `'sha256-${createHash('sha256').update(EMBED_STYLE, 'utf8').digest('base64')}'`;
  assert.ok(buildEmbedCsp(['https://vantalabsresearch.com']).includes(styleHash));
});

test('renderEmbedPage contains no secrets, tokens or interpolable values', () => {
  const html = renderEmbedPage();
  const sampleToken = generatePaymentSessionToken();
  assert.equal(html.includes(sampleToken), false);             // no session token baked in
  assert.equal(html.includes('TRANSACTION_KEY'), false);
  assert.equal(html.includes('${'), false);                    // no template placeholders
  // The inline script must not break out of its script block.
  const scriptBody = html.split('<script>')[1].split('<\/script>')[0];
  assert.equal(scriptBody.includes('</script'), false);
  // Strict messaging baked into the component: no broadcast postMessage.
  assert.equal(scriptBody.includes(`'*'`), false);
  assert.equal(scriptBody.includes('"*"'), false);
  assert.match(scriptBody, /event\.origin !== cfg\.embedOrigin/);
  assert.match(scriptBody, /postMessage\(message, cfg\.embedOrigin\)/);
});

test('embed script validates messages against origin, type and session', () => {
  assert.match(EMBED_SCRIPT, /data\.type !== 'vanta:pay:submit'/);
  assert.match(EMBED_SCRIPT, /data\.sessionId !== cfg\.sessionId/);
  // Raw card values are cleared before the token is posted to the parent.
  assert.match(EMBED_SCRIPT, /clearCard\(\)/);
});
