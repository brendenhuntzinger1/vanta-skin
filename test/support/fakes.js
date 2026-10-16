// Shared fakes for the payment-service tests. Nothing here touches the
// network: the real Authorize.Net SDK executor is replaced by one that throws,
// the database is an in-memory store, and Labs is a recorded function.
const { createHash } = require('node:crypto');
const authnet = require('../../api/_lib/authnet');
const { canonicalMessage, digestHex, signHmac } = require('../../api/_lib/security');

authnet.setDefaultExecutor(() => {
  throw new Error('The real Authorize.Net SDK must never be called from tests');
});

const BRIDGE_KEY_ID = 'labs-to-skin-1';
const BRIDGE_SECRET = 'bridge-secret-for-tests';
const SIGNATURE_KEY = 'webhook-signature-key';

function testConfig(overrides = {}) {
  const base = {
    authnet: {
      apiLoginId: 'login',
      transactionKey: 'txkey',
      signatureKey: SIGNATURE_KEY,
      sandbox: true,
      mode: 'sandbox',
      configError: null,
      merchantDescriptor: 'Vanta Skin',
      defaultCurrency: 'USD',
      timeoutMs: 20000,
    },
    hmac: { maxSkewSeconds: 300, secrets: { [BRIDGE_KEY_ID]: BRIDGE_SECRET } },
    bridge: { allowedOriginStorefronts: ['vantalabsresearch.com'] },
    supabase: { url: 'https://db.test', serviceRoleKey: 'srk' },
    labsSync: {
      endpointUrl: 'https://labs.test/api/webhooks/vanta-skin',
      outboundKeyId: 'labs-sync-1',
      outboundSharedSecret: 'sync-secret',
      timeoutMs: 4000,
      retryAuthToken: 'retry-token',
      retryBatchSize: 25,
      protectionBypass: '',
    },
  };
  return {
    ...base,
    ...overrides,
    authnet: { ...base.authnet, ...(overrides.authnet || {}) },
    labsSync: { ...base.labsSync, ...(overrides.labsSync || {}) },
  };
}

let nonceCounter = 0;
function signedRequest({ path = '/api/payments/charge', body = {}, idempotencyKey, secret = BRIDGE_SECRET, keyId = BRIDGE_KEY_ID, nonce, ts = Math.floor(Date.now() / 1000) } = {}) {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const n = nonce || `nonce-${++nonceCounter}-${Math.random()}`;
  const message = canonicalMessage({ method: 'POST', path, timestamp: ts, nonce: n, bodyHash: digestHex(rawBody) });
  const headers = {
    'content-type': 'application/json',
    'x-vanta-key-id': keyId,
    'x-vanta-timestamp': String(ts),
    'x-vanta-nonce': n,
    'x-vanta-signature': signHmac(secret, message),
  };
  if (idempotencyKey !== undefined) headers['x-idempotency-key'] = idempotencyKey;
  return { req: { method: 'POST', url: path, headers }, rawBody };
}

function chargeBody(overrides = {}) {
  return {
    orderId: 'order-2f5da385-b1b1-42be-a806-80adb74205f4',
    orderNumber: 'VL-10042',
    attemptNo: 1,
    originStorefront: 'vantalabsresearch.com',
    amountCents: 4604,
    currency: 'USD',
    capture: true,
    requireSandbox: true,
    opaqueData: { dataDescriptor: 'COMMON.ACCEPT.INAPP.PAYMENT', dataValue: 'accept-js-token-SECRET' },
    customer: { email: 'shopper@example.com', firstName: 'Ada', lastName: 'Lovelace', phone: '5125550100' },
    billTo: { firstName: 'Ada', lastName: 'Lovelace', address: '1 Main St', city: 'Austin', state: 'TX', zip: '78701', country: 'US' },
    shippingCents: 995,
    taxCents: 0,
    ...overrides,
  };
}

function createFakeStore() {
  const db = {
    nonces: new Set(),
    idempotency: new Map(),
    paymentEvents: [],
    webhooks: new Map(),
    outbox: [],
  };
  const fail = {};
  const log = [];
  const k = (endpoint, key) => `${endpoint}|${key}`;
  let nextId = 1;

  const maybeFail = (name) => {
    if (typeof fail[name] === 'function') {
      const err = fail[name]();
      if (err) throw err;
    } else if (fail[name]) {
      throw fail[name];
    }
  };

  const store = {
    db,
    fail,
    log,
    async recordReplayNonce(keyId, nonce) {
      log.push('recordReplayNonce');
      maybeFail('recordReplayNonce');
      const key = `${keyId}|${nonce}`;
      if (db.nonces.has(key)) return false;
      db.nonces.add(key);
      return true;
    },
    async findIdempotency(endpoint, key) {
      log.push('findIdempotency');
      maybeFail('findIdempotency');
      const row = db.idempotency.get(k(endpoint, key));
      return row ? { ...row } : null;
    },
    async claimIdempotency({ endpoint, idempotencyKey, requestHash }) {
      log.push('claimIdempotency');
      maybeFail('claimIdempotency');
      const existing = db.idempotency.get(k(endpoint, idempotencyKey));
      if (existing) return { claimed: false, existing: { ...existing } };
      db.idempotency.set(k(endpoint, idempotencyKey), {
        status: 'in_progress',
        request_hash: requestHash,
        response_status: null,
        response_body: null,
        created_at: new Date().toISOString(),
      });
      return { claimed: true, existing: null };
    },
    async finishIdempotency({ endpoint, idempotencyKey, requestHash, status, responseStatus, responseBody }) {
      log.push(`finishIdempotency:${status}`);
      maybeFail('finishIdempotency');
      const row = db.idempotency.get(k(endpoint, idempotencyKey));
      if (!row || row.status !== 'in_progress' || row.request_hash !== requestHash) throw new Error('claim row missing');
      Object.assign(row, { status, response_status: responseStatus, response_body: JSON.parse(JSON.stringify(responseBody)) });
    },
    async recordPaymentEvent(event) {
      log.push('recordPaymentEvent');
      maybeFail('recordPaymentEvent');
      if (event.action === 'charge' && event.idempotency_key && db.paymentEvents.some((e) => e.action === 'charge' && e.idempotency_key === event.idempotency_key)) {
        return { inserted: false };
      }
      db.paymentEvents.push({ ...JSON.parse(JSON.stringify(event)), created_at: new Date().toISOString() });
      return { inserted: true };
    },
    async findPaymentEventByTransaction(transactionId, actions) {
      log.push('findPaymentEventByTransaction');
      maybeFail('findPaymentEventByTransaction');
      const rows = db.paymentEvents.filter((e) => String(e.authnet_transaction_id) === String(transactionId) && (!actions || actions.includes(e.action)));
      return rows.length ? { ...rows[rows.length - 1] } : null;
    },
    async findPaymentEventByIdempotencyKey(action, key) {
      log.push('findPaymentEventByIdempotencyKey');
      maybeFail('findPaymentEventByIdempotencyKey');
      const rows = db.paymentEvents.filter((e) => e.action === action && e.idempotency_key === key);
      return rows.length ? { ...rows[rows.length - 1] } : null;
    },
    async findChargeEventByIdempotencyKey(key) {
      log.push('findChargeEventByIdempotencyKey');
      maybeFail('findChargeEventByIdempotencyKey');
      const row = db.paymentEvents.find((e) => e.action === 'charge' && e.idempotency_key === key);
      return row ? { ...row } : null;
    },
    async recordWebhookEvent(evt) {
      log.push('recordWebhookEvent');
      maybeFail('recordWebhookEvent');
      if (db.webhooks.has(evt.event_id)) return { inserted: false };
      db.webhooks.set(evt.event_id, JSON.parse(JSON.stringify(evt)));
      return { inserted: true };
    },
    async insertSyncEvent(event) {
      log.push('insertSyncEvent');
      maybeFail('insertSyncEvent');
      const existing = db.outbox.find((r) => r.event_key === event.event_key);
      if (existing) return { id: existing.id, event_key: existing.event_key, delivery_status: existing.delivery_status, delivery_attempt_count: existing.delivery_attempt_count, inserted: false };
      const row = { id: `sync-${nextId++}`, delivery_attempt_count: 0, ...JSON.parse(JSON.stringify(event)) };
      db.outbox.push(row);
      return { id: row.id, event_key: row.event_key, delivery_status: row.delivery_status, delivery_attempt_count: 0, inserted: true };
    },
    async markSyncDeliveryAttempt(id, plan) {
      log.push(`markSyncDeliveryAttempt:${plan.delivery_status}`);
      maybeFail('markSyncDeliveryAttempt');
      const row = db.outbox.find((r) => r.id === id);
      if (row) Object.assign(row, plan);
    },
    async listDueSyncEvents({ limit, now }) {
      log.push('listDueSyncEvents');
      maybeFail('listDueSyncEvents');
      return db.outbox
        .filter((r) => ['pending', 'failed'].includes(r.delivery_status) && Date.parse(r.next_attempt_at) <= new Date(now).getTime())
        .sort((a, b) => Date.parse(a.next_attempt_at) - Date.parse(b.next_attempt_at))
        .slice(0, limit)
        .map((r) => ({ ...r }));
    },
  };
  return store;
}

function gatewayResult(outcome, overrides = {}) {
  const byOutcome = {
    captured: { transactionId: '60212345678', authCode: 'ABC123', processorCode: '1', message: 'This transaction has been approved.' },
    declined: { transactionId: '60212345679', authCode: null, processorCode: '2', message: 'This transaction has been declined.' },
    rejected: { transactionId: null, authCode: null, processorCode: '3', message: 'The credit card has expired.', errorCode: '8' },
    held: { transactionId: '60212345680', authCode: 'HLD001', processorCode: '4', message: 'The transaction is under review.' },
    uncertain: { transactionId: null, authCode: null, processorCode: null, message: 'Gateway timeout', reason: 'timeout' },
  };
  return {
    outcome,
    cardLast4: outcome === 'uncertain' || outcome === 'rejected' ? null : '1111',
    cardType: outcome === 'uncertain' || outcome === 'rejected' ? null : 'Visa',
    errorCode: null,
    raw: outcome === 'uncertain' ? null : { messages: { resultCode: 'Ok' } },
    ...byOutcome[outcome],
    ...overrides,
  };
}

function createFakeGateway(handlers = {}) {
  const calls = [];
  const wrap = (name) => async (...args) => {
    calls.push({ name, args });
    if (!handlers[name]) throw new Error(`fake gateway: unexpected ${name}`);
    return handlers[name](...args);
  };
  return {
    calls,
    charge: wrap('charge'),
    refund: wrap('refund'),
    void: wrap('void'),
    getUnsettledTransactionList: wrap('getUnsettledTransactionList'),
    getRecentSettledTransactions: wrap('getRecentSettledTransactions'),
    getTransactionDetails: wrap('getTransactionDetails'),
  };
}

function fakeLabs(respond = () => ({ status: 200, body: { ok: true } })) {
  const calls = [];
  const post = async (labsSync, payload) => {
    calls.push(JSON.parse(JSON.stringify(payload)));
    return respond(payload, calls.length);
  };
  return { calls, post };
}

function makeDeps({ config = testConfig(), store = createFakeStore(), gateway = createFakeGateway(), labs = fakeLabs(), now } = {}) {
  const logs = [];
  return {
    config,
    store,
    gateway,
    labs,
    logs,
    deps: {
      loadConfig: () => config,
      createStore: () => store,
      gateway,
      postToLabs: labs.post,
      now: now || (() => new Date()),
      log: (event, details) => logs.push({ event, ...details }),
    },
  };
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

module.exports = {
  BRIDGE_KEY_ID,
  BRIDGE_SECRET,
  SIGNATURE_KEY,
  chargeBody,
  createFakeGateway,
  createFakeStore,
  fakeLabs,
  gatewayResult,
  makeDeps,
  sha256Hex,
  signedRequest,
  testConfig,
};
