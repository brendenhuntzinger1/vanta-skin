const { loadConfig } = require('./config');
const { createStore, createSupabase } = require('./supabase');
const { digestHex, safeEqualHex, verifyRequestSignature, verifyWebhookSignature } = require('./security');
const {
  cardLast4From,
  centsFromMoney,
  createGateway,
  invoiceNumberFor,
  normalizeRefundCardReference,
  refIdFor,
} = require('./authnet');
const {
  INLINE_GRACE_MS,
  assertLabsSyncConfigured,
  buildSyncEventKey,
  deliverSyncEvent,
  planNextDelivery,
  signedLabsPost,
} = require('./sync');

const CHARGE_ENDPOINT = '/api/payments/charge';
const REFUND_ENDPOINT = '/api/payments/refund';
const VOID_ENDPOINT = '/api/payments/void';

// Outcome vocabulary shared with Vanta Labs (contract §1) and the HTTP status
// each one is answered with (contract §3).
const OUTCOME_STATUS = Object.freeze({
  captured: 200,
  held: 202,
  declined: 402,
  rejected: 422,
  invalid: 400,
  in_progress: 409,
  conflict: 409,
  uncertain: 502,
});

const GATEWAY_OUTCOMES = new Set(['captured', 'declined', 'rejected', 'held']);

// Customer-safe text Labs may show as-is. Never a raw processor or internal
// error, never a configuration name, never this service's name.
const CUSTOMER_MESSAGES = Object.freeze({
  captured: null,
  declined: 'Your card was declined. Please check the details or use a different card.',
  rejected: "We couldn't process this card. No payment was taken.",
  held: "Your payment is under review. We'll email you once it's confirmed.",
  uncertain: "We're confirming your payment with the bank. Please don't pay again.",
  in_progress: "Your payment is already being processed. Please don't pay again.",
  conflict: "We're confirming your payment with the bank. Please don't pay again.",
  invalid: "We couldn't process this payment. No payment was taken.",
  unavailable: 'Card payments are temporarily unavailable. No payment was taken.',
});

// paymentStatus is kept for older Labs builds; Labs branches on `outcome`.
const CHARGE_PAYMENT_STATUS = Object.freeze({
  captured: 'captured',
  declined: 'declined',
  rejected: 'rejected',
  held: 'held',
  uncertain: 'uncertain',
  in_progress: 'uncertain',
  conflict: 'uncertain',
  invalid: 'rejected',
});

const REVERSAL_PAYMENT_STATUS = Object.freeze({
  refund: { captured: 'refunded', declined: 'refund_failed', rejected: 'refund_failed', invalid: 'refund_failed', held: 'refund_held', uncertain: 'refund_uncertain', in_progress: 'refund_uncertain', conflict: 'refund_uncertain' },
  void: { captured: 'voided', declined: 'void_failed', rejected: 'void_failed', invalid: 'void_failed', held: 'void_held', uncertain: 'void_uncertain', in_progress: 'void_uncertain', conflict: 'void_uncertain' },
});

class BridgeError extends Error {
  constructor({ statusCode, outcome, message, retryable = false, customerMessage }) {
    super(message);
    this.name = 'BridgeError';
    this.statusCode = statusCode;
    this.outcome = outcome;
    this.retryable = retryable;
    this.customerMessage = customerMessage === undefined ? CUSTOMER_MESSAGES[outcome] ?? null : customerMessage;
  }
}

function invalid(message) {
  return new BridgeError({ statusCode: 400, outcome: 'invalid', message });
}

// Refused before the gateway was contacted because a dependency is down.
// Definitively not charged; safe to retry.
function unavailable(message, { retryable = true } = {}) {
  return new BridgeError({ statusCode: 503, outcome: 'rejected', message, retryable, customerMessage: CUSTOMER_MESSAGES.unavailable });
}

function defaultLog(event, details = {}) {
  // Only codes and identifiers: never payloads, tokens or secrets.
  try {
    console.error(JSON.stringify({ service: 'payment-bridge', event, ...details }));
  } catch {
    // logging must never break a payment path
  }
}

function resolveDeps(deps = {}) {
  return {
    loadConfig: deps.loadConfig || loadConfig,
    createStore: deps.createStore || ((config) => createStore(createSupabase(config))),
    gateway: deps.gateway || createGateway(),
    postToLabs: deps.postToLabs || signedLabsPost,
    now: deps.now || (() => new Date()),
    log: deps.log || defaultLog,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function assertString(value, field, max = 255) {
  if (!value || typeof value !== 'string' || value.length > max) throw invalid(`Missing or invalid ${field}`);
}

function assertInteger(value, field) {
  if (!Number.isInteger(value) || value <= 0) throw invalid(`Missing or invalid ${field}`);
}

function assertAllowedStorefront(config, storefront) {
  const normalized = String(storefront || '').trim().toLowerCase();
  if (!config.bridge.allowedOriginStorefronts.includes(normalized)) {
    throw invalid('originStorefront is not approved');
  }
}

function assertNoSensitiveCardFields(payload) {
  const forbidden = ['cardNumber', 'cardCode', 'cvv', 'cvc', 'securityCode', 'pan'];
  for (const key of forbidden) {
    if (payload[key] !== undefined) {
      throw invalid(`Sensitive field ${key} is not allowed. Use Authorize.net opaqueData tokenization.`);
    }
  }
}

function assertNonNegativeCents(value, field) {
  if (value === undefined || value === null) return;
  if (!Number.isInteger(value) || value < 0) throw invalid(`Invalid ${field}`);
}

// Line items are accepted for older Labs builds, shape-checked, and never sent
// to Authorize.Net.
function assertChargeLineItems(payload) {
  assertNonNegativeCents(payload.shippingCents, 'shippingCents');
  assertNonNegativeCents(payload.taxCents, 'taxCents');
  if (payload.lineItems === undefined) return;
  if (!Array.isArray(payload.lineItems)) throw invalid('Invalid lineItems');
  for (const item of payload.lineItems) {
    const quantity = Number(item?.quantity);
    const unit = item?.unitPriceCents;
    if (!Number.isInteger(quantity) || quantity <= 0 || !Number.isInteger(unit) || unit < 0) {
      throw invalid('Invalid lineItems entry: quantity must be a positive integer and unitPriceCents a non-negative integer');
    }
  }
}

function assertOptionalObject(value, field) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid(`Invalid ${field}`);
}

function assertUsd(value, { required }) {
  if (value === undefined && !required) return;
  if (value !== 'USD') throw invalid('currency must be USD');
}

function idempotencyKeyFrom(req) {
  const key = req.headers['x-idempotency-key'];
  if (!key || typeof key !== 'string' || key.length > 255) throw invalid('Missing or invalid x-idempotency-key');
  return key;
}

function parsePayload(rawBody) {
  let payload;
  try {
    payload = rawBody && rawBody.trim() ? JSON.parse(rawBody) : {};
  } catch {
    throw invalid('Request body is not valid JSON');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid('Request body must be a JSON object');
  return payload;
}

// The Accept.js nonce is single-use and short-lived, but it is a payment
// credential all the same; it is not kept in payment_events.
function redactPaymentPayload(payload) {
  if (!payload?.opaqueData?.dataValue) return payload;
  return { ...payload, opaqueData: { ...payload.opaqueData, dataValue: '[redacted]' } };
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

async function authenticate(req, rawBody, d) {
  let config;
  try {
    config = d.loadConfig();
  } catch (error) {
    d.log('config_error', { code: error?.code || 'config_error' });
    throw unavailable('Payment service is not configured');
  }

  let signed;
  try {
    signed = verifyRequestSignature(config, req, rawBody);
  } catch (error) {
    throw new BridgeError({ statusCode: 401, outcome: 'invalid', message: error.message });
  }

  let store;
  let fresh;
  try {
    store = d.createStore(config);
    fresh = await store.recordReplayNonce(signed.keyId, signed.nonce, signed.requestHash);
  } catch (error) {
    d.log('nonce_store_error', { message: error?.message });
    throw unavailable('Payment records are temporarily unavailable');
  }
  if (!fresh) {
    throw new BridgeError({ statusCode: 409, outcome: 'invalid', message: 'Replay detected for nonce' });
  }
  return { config, store, signed };
}

// Live requested but not approved (see resolveAuthnetMode): refuse every
// money-moving call, before the gateway.
function assertGatewayModeUsable(config) {
  if (config.authnet.configError) {
    throw unavailable('Live processing is requested but not approved', { retryable: false });
  }
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

function genericBody(outcome, extra = {}) {
  return {
    ok: false,
    outcome,
    paymentStatus: CHARGE_PAYMENT_STATUS[outcome] || 'uncertain',
    retryable: false,
    // in_progress / conflict: another request owns the key; whether it
    // reached the gateway is not known here.
    gatewayContacted: outcome === 'uncertain' ? true : null,
    transactionId: null,
    message: outcome,
    customerMessage: CUSTOMER_MESSAGES[outcome] ?? null,
    ...extra,
  };
}

function replayExisting(existing, requestHash, bodyExtras) {
  if (existing.request_hash !== requestHash) {
    return { statusCode: OUTCOME_STATUS.conflict, body: genericBody('conflict', { ...bodyExtras, message: 'Idempotency key already used with a different payload' }), replayed: false };
  }
  if (existing.status === 'completed' && existing.response_body && existing.response_status) {
    return { statusCode: existing.response_status, body: existing.response_body, replayed: true };
  }
  if (existing.status === 'uncertain' || existing.status === 'completed') {
    return { statusCode: OUTCOME_STATUS.uncertain, body: existing.response_body || genericBody('uncertain', bodyExtras), replayed: true };
  }
  return { statusCode: OUTCOME_STATUS.in_progress, body: genericBody('in_progress', { ...bodyExtras, message: 'A request with this idempotency key is still in progress' }), replayed: false };
}

async function finishWithRetry(store, args, attempts = 2) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await store.finishIdempotency(args);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// 1. Claim the key with a plain INSERT (status in_progress) before the gateway.
//    Someone else's row → replay / in_progress / conflict / uncertain.
// 2. Run the gateway call. A throw or unknown answer is `uncertain`.
// 3. Persist the result to the claimed row FIRST. If that fails after money
//    may have moved (captured / held), answer 502 uncertain with the
//    transaction id — never a 4xx.
// Secondary writes (audit rows, outbox, callback) are the caller's, after.
async function withIdempotency(store, { endpoint, idempotencyKey, requestHash, bodyExtras = {}, log = defaultLog }, run, { uncertainFrom }) {
  let claim;
  try {
    claim = await store.claimIdempotency({ endpoint, idempotencyKey, requestHash });
  } catch (error) {
    log('idempotency_claim_error', { endpoint, message: error?.message });
    throw unavailable('Payment records are temporarily unavailable');
  }
  if (!claim.claimed) return { ...replayExisting(claim.existing, requestHash, bodyExtras), fresh: false };

  let result;
  try {
    result = await run();
  } catch (error) {
    log('gateway_stage_error', { endpoint, name: error?.name, message: error?.message });
    result = uncertainFrom(error);
  }

  const outcome = result.body.outcome;
  const rowStatus = outcome === 'uncertain' ? 'uncertain' : 'completed';
  try {
    await finishWithRetry(store, {
      endpoint,
      idempotencyKey,
      requestHash,
      status: rowStatus,
      responseStatus: result.statusCode,
      responseBody: result.body,
    });
    return { ...result, replayed: false, persisted: true, fresh: true };
  } catch (error) {
    log('idempotency_persist_error', { endpoint, outcome, message: error?.message });
    if (outcome === 'captured' || outcome === 'held') {
      return {
        ...result,
        statusCode: OUTCOME_STATUS.uncertain,
        body: {
          ...result.body,
          ok: false,
          outcome: 'uncertain',
          paymentStatus: bodyExtras.action === 'charge' || !bodyExtras.action ? 'uncertain' : REVERSAL_PAYMENT_STATUS[bodyExtras.action]?.uncertain || 'uncertain',
          retryable: false,
          message: `Result (${outcome}) could not be saved`,
          customerMessage: bodyExtras.action === 'charge' || !bodyExtras.action ? CUSTOMER_MESSAGES.uncertain : null,
        },
        replayed: false,
        persisted: false,
        fresh: true,
      };
    }
    return { ...result, replayed: false, persisted: false, fresh: true };
  }
}

// ---------------------------------------------------------------------------
// Outbox + callback
// ---------------------------------------------------------------------------

async function enqueueAndDeliver(d, config, store, event) {
  const configured = assertLabsSyncConfigured(config);
  let row = null;
  try {
    row = await store.insertSyncEvent({
      ...event,
      delivery_status: configured ? 'pending' : 'disabled',
      next_attempt_at: new Date(d.now().getTime() + INLINE_GRACE_MS).toISOString(),
    });
  } catch (error) {
    d.log('outbox_insert_error', { eventKey: event.event_key, message: error?.message });
  }
  if (!configured) return { delivered: false, skipped: true };
  if (row && (row.delivery_status === 'delivered' || row.delivery_status === 'dead' || row.delivery_status === 'disabled')) {
    return { delivered: row.delivery_status === 'delivered', skipped: true };
  }

  const attempt = await deliverSyncEvent(config, event.payload, {
    previousAttempts: Number(row?.delivery_attempt_count || 0),
    post: d.postToLabs,
  });
  if (row?.id) {
    try {
      await store.markSyncDeliveryAttempt(row.id, planNextDelivery(attempt, d.now()));
    } catch (error) {
      d.log('outbox_mark_error', { eventKey: event.event_key, message: error?.message });
    }
  }
  return attempt;
}

async function safely(d, label, fn) {
  try {
    return await fn();
  } catch (error) {
    d.log(label, { message: error?.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Error → response
// ---------------------------------------------------------------------------

// `operation` decides what an unexpected error means. For a money-moving call
// it cannot be proven that nothing was charged, so it is `uncertain` (502).
function toErrorResponse(error, { operation = 'charge' } = {}) {
  if (error instanceof BridgeError) {
    const body = {
      ok: false,
      action: operation,
      outcome: error.outcome,
      paymentStatus: operation === 'refund' || operation === 'void'
        ? REVERSAL_PAYMENT_STATUS[operation][error.outcome] || `${operation}_failed`
        : CHARGE_PAYMENT_STATUS[error.outcome] || 'rejected',
      retryable: error.retryable,
      gatewayContacted: false,
      transactionId: null,
      message: error.message,
      customerMessage: operation === 'charge' ? error.customerMessage : null,
    };
    return { statusCode: error.statusCode, body };
  }
  if (operation === 'webhook' || operation === 'reconcile' || operation === 'sync-retry') {
    return { statusCode: 500, body: { ok: false, outcome: operation === 'reconcile' ? 'pending' : undefined, message: 'internal_error' } };
  }
  return {
    statusCode: OUTCOME_STATUS.uncertain,
    body: {
      ok: false,
      action: operation,
      outcome: 'uncertain',
      paymentStatus: operation === 'charge' ? 'uncertain' : `${operation}_uncertain`,
      retryable: false,
      gatewayContacted: null,
      transactionId: null,
      message: 'internal_error',
      customerMessage: operation === 'charge' ? CUSTOMER_MESSAGES.uncertain : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Charge
// ---------------------------------------------------------------------------

function validateChargePayload(config, payload) {
  assertString(payload.orderId, 'orderId');
  assertInteger(payload.amountCents, 'amountCents');
  assertUsd(payload.currency, { required: true });
  assertString(payload.originStorefront, 'originStorefront');
  assertString(payload.opaqueData?.dataDescriptor, 'opaqueData.dataDescriptor');
  assertString(payload.opaqueData?.dataValue, 'opaqueData.dataValue', 8192);
  assertAllowedStorefront(config, payload.originStorefront);
  assertNoSensitiveCardFields(payload);
  assertChargeLineItems(payload);
  assertOptionalObject(payload.customer, 'customer');
  assertOptionalObject(payload.billTo, 'billTo');
  if (payload.orderNumber !== undefined && typeof payload.orderNumber !== 'string') throw invalid('Invalid orderNumber');
  if (payload.attemptNo !== undefined && !(Number.isInteger(payload.attemptNo) && payload.attemptNo > 0)) throw invalid('Invalid attemptNo');
  if (payload.capture === false) throw invalid('Authorization-only charges are not supported');
  if (payload.requireSandbox !== undefined && typeof payload.requireSandbox !== 'boolean') throw invalid('Invalid requireSandbox');
}

function chargeRetryable(outcome, gw) {
  if (outcome === 'declined') return true;
  // A "duplicate transaction" refusal means an identical charge was just
  // submitted; do not invite another one.
  if (outcome === 'rejected') return String(gw?.errorCode || '') !== '11';
  return false;
}

// Why a card was refused, in categories the customer can act on. Keyed on the
// Authorize.Net response reason code (developer.authorize.net response-code
// list). Anything not listed — generic bank declines (2, 3, 4), fraud-filter
// declines (250, 251, 254) — is 'generic': the customer is never told a
// fraud filter fired, and "insufficient funds" is not distinguishable here.
const DECLINE_CATEGORY_BY_REASON = Object.freeze({
  6: 'card_number', 37: 'card_number', 315: 'card_number',
  7: 'expiry', 8: 'expiry', 316: 'expiry', 317: 'expiry',
  44: 'cvv', 65: 'cvv', 78: 'cvv',
  27: 'billing', 127: 'billing',
  45: 'billing_and_cvv',
  11: 'duplicate',
});

function declineCategoryFor(outcome, gw) {
  if (outcome !== 'declined' && outcome !== 'rejected') return null;
  return DECLINE_CATEGORY_BY_REASON[Number(gw?.errorCode)] || 'generic';
}

function buildChargeBody({ config, payload, outcome, gw, refId, invoiceNumber }) {
  return {
    ok: outcome === 'captured',
    action: 'charge',
    orderId: payload.orderId,
    outcome,
    paymentStatus: CHARGE_PAYMENT_STATUS[outcome],
    retryable: chargeRetryable(outcome, gw),
    gatewayContacted: true,
    transactionId: gw?.transactionId || null,
    refId,
    invoiceNumber,
    authCode: gw?.authCode || null,
    cardLast4: gw?.cardLast4 || null,
    cardType: gw?.cardType || null,
    amountCents: payload.amountCents,
    currency: 'USD',
    sandbox: config.authnet.sandbox,
    processorCode: gw?.processorCode || null,
    message: gw?.message || null,
    customerMessage: CUSTOMER_MESSAGES[outcome] ?? null,
    declineCategory: declineCategoryFor(outcome, gw),
  };
}

async function handleCharge(req, rawBody, deps) {
  const d = resolveDeps(deps);
  const { config, store, signed } = await authenticate(req, rawBody, d);
  assertGatewayModeUsable(config);

  const payload = parsePayload(rawBody);
  const idempotencyKey = idempotencyKeyFrom(req);
  validateChargePayload(config, payload);

  if (payload.requireSandbox === true && !config.authnet.sandbox) {
    throw new BridgeError({ statusCode: OUTCOME_STATUS.rejected, outcome: 'rejected', message: 'Sandbox was required but this service is live', retryable: false });
  }

  const refId = refIdFor(idempotencyKey);
  const invoiceNumber = invoiceNumberFor(payload);
  const bodyExtras = { action: 'charge', orderId: payload.orderId, refId, amountCents: payload.amountCents, currency: 'USD', sandbox: config.authnet.sandbox };

  let gw = null;
  const result = await withIdempotency(
    store,
    { endpoint: CHARGE_ENDPOINT, idempotencyKey, requestHash: signed.requestHash, bodyExtras, log: d.log },
    async () => {
      gw = await d.gateway.charge(config, payload, { refId });
      const outcome = gw.outcome;
      return { statusCode: OUTCOME_STATUS[outcome], body: buildChargeBody({ config, payload, outcome, gw, refId, invoiceNumber }) };
    },
    {
      uncertainFrom: () => ({
        statusCode: OUTCOME_STATUS.uncertain,
        body: buildChargeBody({ config, payload, outcome: 'uncertain', gw: gw || { message: 'Gateway result unknown' }, refId, invoiceNumber }),
      }),
    },
  );

  if (result.fresh) {
    const gatewayOutcome = gw?.outcome || 'uncertain';
    await recordChargeSideEffects(d, config, store, { payload, idempotencyKey, refId, gw, gatewayOutcome, responseBody: result.body });
  }

  return { statusCode: result.statusCode, body: result.body, replayed: result.replayed };
}

async function recordChargeSideEffects(d, config, store, { payload, idempotencyKey, refId, gw, gatewayOutcome }) {
  const moneyMayHaveMoved = gatewayOutcome === 'captured' || gatewayOutcome === 'held';
  await safely(d, 'payment_event_error', () => store.recordPaymentEvent({
    order_id: payload.orderId,
    origin_storefront: payload.originStorefront,
    action: 'charge',
    amount_cents: payload.amountCents,
    auth_amount_cents: moneyMayHaveMoved ? payload.amountCents : null,
    currency: 'USD',
    status: CHARGE_PAYMENT_STATUS[gatewayOutcome],
    outcome: gatewayOutcome,
    authnet_transaction_id: gw?.transactionId || null,
    card_last4: gw?.cardLast4 || null,
    card_type: gw?.cardType || null,
    ref_id: refId,
    idempotency_key: idempotencyKey,
    request_payload: redactPaymentPayload(payload),
    response_payload: gw?.raw || { outcome: gatewayOutcome, reason: gw?.reason || null },
  }));

  // Labs is told about definitive gateway answers. An unknown answer is not
  // forwarded: Labs already holds the attempt as uncertain and reconciles.
  if (!GATEWAY_OUTCOMES.has(gatewayOutcome)) return;

  const eventKey = buildSyncEventKey({ source: 'bridge', action: 'charge', idempotencyKey, transactionId: gw?.transactionId, outcome: gatewayOutcome });
  const callback = {
    eventId: eventKey,
    source: 'vanta-skin-payment-bridge',
    action: 'charge',
    attemptKey: idempotencyKey,
    orderId: payload.orderId,
    originStorefront: payload.originStorefront,
    outcome: gatewayOutcome,
    paymentStatus: CHARGE_PAYMENT_STATUS[gatewayOutcome],
    transactionId: gw?.transactionId || null,
    amountCents: payload.amountCents,
    currency: 'USD',
    cardLast4: gw?.cardLast4 || null,
    cardType: gw?.cardType || null,
    sandbox: config.authnet.sandbox,
    processorCode: gw?.processorCode || null,
    message: gw?.message || null,
    occurredAt: d.now().toISOString(),
  };
  await safely(d, 'callback_error', () => enqueueAndDeliver(d, config, store, {
    event_key: eventKey,
    order_id: payload.orderId,
    origin_storefront: payload.originStorefront,
    event_type: 'payment.charge',
    payment_status: callback.paymentStatus,
    transaction_id: callback.transactionId,
    payload: callback,
  }));
}

// ---------------------------------------------------------------------------
// Refund / void
// ---------------------------------------------------------------------------

function buildReversalBody({ action, config, payload, outcome, gw, refId, amountCents }) {
  const transactionId = action === 'void'
    ? (gw?.transactionId || (outcome === 'captured' ? String(payload.transactionId) : null))
    : (gw?.transactionId || null);
  return {
    ok: outcome === 'captured',
    action,
    orderId: payload.orderId,
    outcome,
    paymentStatus: REVERSAL_PAYMENT_STATUS[action][outcome],
    retryable: outcome === 'declined' || outcome === 'rejected',
    gatewayContacted: true,
    transactionId,
    originalTransactionId: String(payload.transactionId),
    refId,
    amountCents,
    currency: 'USD',
    sandbox: config.authnet.sandbox,
    processorCode: gw?.processorCode || null,
    message: gw?.message || null,
    customerMessage: null,
  };
}

async function handleReversal(action, req, rawBody, deps) {
  const d = resolveDeps(deps);
  const { config, store, signed } = await authenticate(req, rawBody, d);
  assertGatewayModeUsable(config);

  const payload = parsePayload(rawBody);
  const idempotencyKey = idempotencyKeyFrom(req);

  assertString(payload.orderId, 'orderId');
  assertString(payload.originStorefront, 'originStorefront');
  assertString(payload.transactionId, 'transactionId', 64);
  assertAllowedStorefront(config, payload.originStorefront);
  assertUsd(payload.currency, { required: false });

  let amountCents;
  if (action === 'refund') {
    assertInteger(payload.amountCents, 'amountCents');
    if (typeof payload.cardNumberMasked !== 'string') throw invalid('cardNumberMasked (last 4 digits of the card) is required');
    try {
      normalizeRefundCardReference(payload.cardNumberMasked);
    } catch {
      throw invalid('cardNumberMasked must be the last 4 digits of the card');
    }
    amountCents = payload.amountCents;
  } else {
    if (payload.amountCents !== undefined) assertInteger(payload.amountCents, 'amountCents');
    amountCents = payload.amountCents;
    if (amountCents === undefined) {
      let charge;
      try {
        charge = await store.findPaymentEventByTransaction(payload.transactionId, ['charge']);
      } catch (error) {
        d.log('void_amount_lookup_error', { message: error?.message });
        throw unavailable('Payment records are temporarily unavailable');
      }
      if (!Number.isInteger(charge?.amount_cents)) throw invalid('amountCents is required: no recorded charge for transactionId');
      amountCents = charge.amount_cents;
    }
  }

  const endpoint = action === 'refund' ? REFUND_ENDPOINT : VOID_ENDPOINT;
  const refId = refIdFor(idempotencyKey);
  const bodyExtras = { action, orderId: payload.orderId, originalTransactionId: String(payload.transactionId), refId, amountCents, currency: 'USD', sandbox: config.authnet.sandbox };

  let gw = null;
  const result = await withIdempotency(
    store,
    { endpoint, idempotencyKey, requestHash: signed.requestHash, bodyExtras, log: d.log },
    async () => {
      gw = action === 'refund'
        ? await d.gateway.refund(config, payload, { refId })
        : await d.gateway.void(config, payload, { refId });
      return { statusCode: OUTCOME_STATUS[gw.outcome], body: buildReversalBody({ action, config, payload, outcome: gw.outcome, gw, refId, amountCents }) };
    },
    {
      uncertainFrom: () => ({
        statusCode: OUTCOME_STATUS.uncertain,
        body: buildReversalBody({ action, config, payload, outcome: 'uncertain', gw: gw || { message: 'Gateway result unknown' }, refId, amountCents }),
      }),
    },
  );

  if (result.fresh) {
    const outcome = gw?.outcome || 'uncertain';
    const body = buildReversalBody({ action, config, payload, outcome, gw, refId, amountCents });
    await safely(d, 'payment_event_error', () => store.recordPaymentEvent({
      order_id: payload.orderId,
      origin_storefront: payload.originStorefront,
      action,
      amount_cents: amountCents,
      currency: 'USD',
      status: body.paymentStatus,
      outcome,
      authnet_transaction_id: body.transactionId,
      original_transaction_id: String(payload.transactionId),
      card_last4: action === 'refund' ? cardLast4From(payload.cardNumberMasked) : null,
      ref_id: refId,
      idempotency_key: idempotencyKey,
      request_payload: payload,
      response_payload: gw?.raw || { outcome, reason: gw?.reason || null },
    }));

    if (GATEWAY_OUTCOMES.has(outcome)) {
      const eventKey = buildSyncEventKey({ source: 'bridge', action, idempotencyKey, transactionId: body.transactionId, outcome });
      const callback = {
        eventId: eventKey,
        source: 'vanta-skin-payment-bridge',
        action,
        attemptKey: idempotencyKey,
        orderId: payload.orderId,
        originStorefront: payload.originStorefront,
        outcome,
        paymentStatus: body.paymentStatus,
        transactionId: body.transactionId,
        originalTransactionId: String(payload.transactionId),
        amountCents,
        currency: 'USD',
        cardLast4: action === 'refund' ? cardLast4From(payload.cardNumberMasked) : null,
        cardType: null,
        sandbox: config.authnet.sandbox,
        processorCode: gw?.processorCode || null,
        message: gw?.message || null,
        occurredAt: d.now().toISOString(),
      };
      await safely(d, 'callback_error', () => enqueueAndDeliver(d, config, store, {
        event_key: eventKey,
        order_id: payload.orderId,
        origin_storefront: payload.originStorefront,
        event_type: `payment.${action}`,
        payment_status: body.paymentStatus,
        transaction_id: body.transactionId,
        payload: callback,
      }));
    }
  }

  return { statusCode: result.statusCode, body: result.body, replayed: result.replayed };
}

function handleRefund(req, rawBody, deps) {
  return handleReversal('refund', req, rawBody, deps);
}

function handleVoid(req, rawBody, deps) {
  return handleReversal('void', req, rawBody, deps);
}

// ---------------------------------------------------------------------------
// Authorize.Net webhook
// ---------------------------------------------------------------------------

const WEBHOOK_RULES = Object.freeze({
  'net.authorize.payment.authcapture.created': { action: 'charge', paymentStatus: 'paid' },
  'net.authorize.payment.capture.created': { action: 'charge', paymentStatus: 'paid' },
  'net.authorize.payment.refund.created': { action: 'refund', paymentStatus: 'refunded' },
  'net.authorize.payment.void.created': { action: 'void', paymentStatus: 'voided' },
});

function mapWebhookEventToOrderStatus(eventType) {
  return WEBHOOK_RULES[String(eventType || '').toLowerCase()]?.paymentStatus || null;
}

function extractWebhookTransactionId(payload) {
  const id = payload?.payload?.id ?? payload?.payload?.transId;
  return id === undefined || id === null || id === '' ? null : String(id);
}

// Rows written before the outcome column existed carry only `status`.
function recordedOutcome(row) {
  if (row?.outcome) return row.outcome;
  return ['captured', 'refunded', 'voided'].includes(row?.status) ? 'captured' : row?.status || null;
}

// An event name alone never makes anything paid. Forwarded only when the
// transaction is one this service recorded with outcome captured, the
// notification says approved (responseCode 1), and the gateway amount equals
// the recorded amount.
async function verifyWebhookPayment(store, payload, eventType) {
  const rule = WEBHOOK_RULES[eventType];
  if (!rule) return { verified: false, reason: 'ignored_event_type' };
  const transactionId = extractWebhookTransactionId(payload);
  if (!transactionId) return { verified: false, reason: 'missing_transaction_id' };
  if (Number(payload?.payload?.responseCode) !== 1) return { verified: false, reason: 'not_approved', transactionId };
  const gatewayCents = centsFromMoney(payload?.payload?.authAmount ?? payload?.payload?.settleAmount);
  if (gatewayCents === null) return { verified: false, reason: 'missing_amount', transactionId };

  const row = await store.findPaymentEventByTransaction(transactionId, [rule.action]);
  if (!row) return { verified: false, reason: 'unknown_transaction', transactionId };
  if (recordedOutcome(row) !== 'captured') return { verified: false, reason: 'recorded_outcome_not_captured', transactionId, row };
  if (Number(row.amount_cents) !== gatewayCents) return { verified: false, reason: 'amount_mismatch', transactionId, row };
  return { verified: true, reason: 'verified', transactionId, row, rule, amountCents: gatewayCents };
}

async function handleWebhook(rawBody, signatureHeader, deps) {
  const d = resolveDeps(deps);
  let config;
  try {
    config = d.loadConfig();
  } catch (error) {
    d.log('config_error', { code: error?.code || 'config_error' });
    throw unavailable('Payment service is not configured');
  }

  if (!verifyWebhookSignature(config.authnet.signatureKey, rawBody, signatureHeader)) {
    throw new BridgeError({ statusCode: 401, outcome: 'invalid', message: 'Invalid Authorize.net webhook signature' });
  }

  const payload = parsePayload(rawBody);
  // No notification id: a stable id from the body, so a redelivery dedupes.
  const eventId = String(payload.notificationId || payload.id || `sha256-${digestHex(rawBody)}`);
  const eventType = String(payload.eventType || 'unknown').toLowerCase();

  const store = d.createStore(config);
  const verification = await verifyWebhookPayment(store, payload, eventType);
  const row = verification.verified ? verification.row : null;

  const recorded = await store.recordWebhookEvent({
    event_id: eventId,
    event_type: eventType,
    payload,
    transaction_id: verification.transactionId || extractWebhookTransactionId(payload),
    reconciled_order_id: row?.order_id || null,
    reconciled_status: verification.verified ? verification.rule.paymentStatus : null,
    verification: verification.reason,
    received_at: d.now().toISOString(),
  });

  if (verification.verified) {
    const eventKey = buildSyncEventKey({ source: 'webhook', eventId });
    const isReversal = verification.rule.action !== 'charge';
    const callback = {
      eventId: eventKey,
      source: 'authorize-net-webhook',
      action: 'webhook_update',
      webhookEventType: eventType,
      attemptKey: row.idempotency_key || null,
      orderId: row.order_id,
      originStorefront: row.origin_storefront,
      outcome: 'captured',
      paymentStatus: verification.rule.paymentStatus,
      transactionId: verification.transactionId,
      originalTransactionId: isReversal ? row.original_transaction_id || null : null,
      amountCents: verification.amountCents,
      currency: row.currency || 'USD',
      cardLast4: row.card_last4 || null,
      cardType: row.card_type || null,
      sandbox: config.authnet.sandbox,
      processorCode: '1',
      message: eventType,
      occurredAt: typeof payload.eventDate === 'string' ? payload.eventDate : d.now().toISOString(),
    };
    // The outbox insert is idempotent by event key, so a redelivered
    // notification re-enqueues nothing that is already queued or delivered.
    await safely(d, 'callback_error', () => enqueueAndDeliver(d, config, store, {
      event_key: eventKey,
      order_id: row.order_id,
      origin_storefront: row.origin_storefront,
      event_type: 'payment.webhook',
      payment_status: verification.rule.paymentStatus,
      transaction_id: verification.transactionId,
      payload: callback,
    }));
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      message: 'Webhook accepted',
      duplicate: !recorded.inserted,
      forwarded: verification.verified,
      verification: verification.reason,
    },
  };
}

// ---------------------------------------------------------------------------
// Reconcile (no money moves)
// ---------------------------------------------------------------------------

const NOT_FOUND_AFTER_MS = 30 * 60 * 1000;
// Labs's clock and Authorize.Net's are not the same clock. A transaction
// submitted slightly "before" the attempt started is still matched rather than
// missed (a miss could become not_found and invite a second payment).
const RECONCILE_CLOCK_TOLERANCE_MS = 60 * 1000;

const TRANSACTION_STATUS_OUTCOME = Object.freeze({
  capturedPendingSettlement: 'captured',
  settledSuccessfully: 'captured',
  declined: 'declined',
  failedReview: 'declined',
  generalError: 'rejected',
  communicationError: 'rejected',
  expired: 'rejected',
  voided: 'rejected',
});
const OUTCOME_PRIORITY = { captured: 0, held: 1, declined: 2, rejected: 3 };

// Unknown or review states → held (an admin looks), never a guess either way.
function outcomeForTransactionStatus(status) {
  return TRANSACTION_STATUS_OUTCOME[status] || 'held';
}

const RECONCILE_OPERATIONS = new Set(['charge', 'refund', 'void']);

function validateReconcilePayload(payload) {
  if (payload.operation !== undefined && !RECONCILE_OPERATIONS.has(payload.operation)) throw invalid('Invalid operation');
  if (payload.operation === 'refund' || payload.operation === 'void') {
    assertString(payload.originalTransactionId, 'originalTransactionId', 64);
  }
  assertString(payload.orderId, 'orderId');
  assertString(payload.idempotencyKey, 'idempotencyKey');
  assertInteger(payload.amountCents, 'amountCents');
  if (typeof payload.attemptStartedAt !== 'string' || !Number.isFinite(Date.parse(payload.attemptStartedAt))) {
    throw invalid('Missing or invalid attemptStartedAt');
  }
  if (payload.invoiceNumber !== undefined && (typeof payload.invoiceNumber !== 'string' || payload.invoiceNumber.length > 20)) {
    throw invalid('Invalid invoiceNumber');
  }
  if (payload.knownTransactionIds !== undefined) {
    if (!Array.isArray(payload.knownTransactionIds) || payload.knownTransactionIds.length > 100) throw invalid('Invalid knownTransactionIds');
    for (const id of payload.knownTransactionIds) {
      if (typeof id !== 'string' && typeof id !== 'number') throw invalid('Invalid knownTransactionIds');
    }
  }
}

function fromSkinRecord({ outcome, transactionId, cardLast4, cardType, amountCents }) {
  return {
    outcome,
    transactionId: transactionId || null,
    cardLast4: cardLast4 || null,
    cardType: cardType || null,
    amountCents: Number.isInteger(amountCents) ? amountCents : null,
    source: 'skin_record',
  };
}

async function reconcileAttempt({ config, store, gateway, now }, payload) {
  const { orderId, idempotencyKey, amountCents } = payload;

  // 1. This service's own records for the attempt key.
  const row = await store.findIdempotency(CHARGE_ENDPOINT, idempotencyKey);
  const body = row?.response_body;
  if (row?.status === 'completed' && body && (!body.orderId || body.orderId === orderId)) {
    const outcome = body.outcome || (body.paymentStatus === 'captured' && body.transactionId ? 'captured' : null);
    if (GATEWAY_OUTCOMES.has(outcome)) {
      return fromSkinRecord({ outcome, transactionId: body.transactionId, cardLast4: body.cardLast4, cardType: body.cardType, amountCents: body.amountCents ?? amountCents });
    }
  }
  const event = await store.findChargeEventByIdempotencyKey(idempotencyKey);
  if (event && event.order_id === orderId && GATEWAY_OUTCOMES.has(event.outcome)) {
    return fromSkinRecord({ outcome: event.outcome, transactionId: event.authnet_transaction_id, cardLast4: event.card_last4, cardType: event.card_type, amountCents: event.amount_cents });
  }

  // 2. The gateway: unsettled first, then batches settled in the last 2 days.
  const invoiceNumber = payload.invoiceNumber || invoiceNumberFor({ orderId });
  const startedMs = Date.parse(payload.attemptStartedAt);
  const known = new Set((payload.knownTransactionIds || []).map(String));
  const matches = (tx) => {
    if (!tx) return false;
    if (String(tx.invoiceNumber || '') !== invoiceNumber) return false;
    if (centsFromMoney(tx.settleAmount ?? tx.authAmount) !== amountCents) return false;
    const submitted = Date.parse(tx.submitTimeUTC || tx.submitTimeLocal || '');
    if (!Number.isFinite(submitted) || submitted < startedMs - RECONCILE_CLOCK_TOLERANCE_MS) return false;
    return !known.has(String(tx.transId));
  };

  let lookupFailed = false;
  let candidates = [];
  try {
    candidates = (await gateway.getUnsettledTransactionList(config)).filter(matches);
  } catch {
    lookupFailed = true;
  }
  if (!candidates.length) {
    try {
      candidates = (await gateway.getRecentSettledTransactions(config, { now, days: 2 })).filter(matches);
    } catch {
      lookupFailed = true;
    }
  }

  if (candidates.length) {
    const ranked = candidates
      .map((tx) => ({ tx, outcome: outcomeForTransactionStatus(tx.transactionStatus) }))
      .sort((a, b) => OUTCOME_PRIORITY[a.outcome] - OUTCOME_PRIORITY[b.outcome]);
    const { tx } = ranked[0];
    let details = null;
    try {
      details = await gateway.getTransactionDetails(config, tx.transId);
    } catch {
      details = null;
    }
    const status = details?.transactionStatus || tx.transactionStatus;
    return {
      outcome: outcomeForTransactionStatus(status),
      transactionId: String(tx.transId),
      cardLast4: cardLast4From(details?.payment?.creditCard?.cardNumber || tx.accountNumber),
      cardType: details?.payment?.creditCard?.cardType || tx.accountType || null,
      amountCents: centsFromMoney(details?.authAmount ?? details?.settleAmount ?? tx.settleAmount) ?? amountCents,
      source: 'gateway_lookup',
    };
  }

  // 3. Nothing found. not_found only when the lookup worked and the attempt
  //    is old enough that a charge would be visible by now.
  const rowCreatedMs = Date.parse(row?.created_at || '');
  const referenceMs = Number.isFinite(rowCreatedMs) ? Math.max(startedMs, rowCreatedMs) : startedMs;
  const ageMs = now.getTime() - referenceMs;
  const outcome = !lookupFailed && ageMs >= NOT_FOUND_AFTER_MS ? 'not_found' : 'pending';
  return { outcome, transactionId: null, cardLast4: null, cardType: null, amountCents: null, source: 'gateway_lookup' };
}

// Refund and void reconciliation. A refund is its own transaction; it is
// matched only when the gateway's details name THIS order's charge as its
// refTransId. A void changes the charge itself, so the charge's status answers.
// As for charges: nothing found means not_found only once the lookups worked
// and enough time has passed; otherwise pending. A lookup never moves money.
const REFUND_TRANSACTION_STATUSES = new Set(['refundPendingSettlement', 'refundSettledSuccessfully']);
const SETTLED_CHARGE_STATUSES = new Set(['settledSuccessfully', 'refundSettledSuccessfully', 'refundPendingSettlement']);
const MAX_REFUND_DETAIL_LOOKUPS = 10;

async function reconcileReversal({ config, store, gateway, now }, payload) {
  const { operation, orderId, idempotencyKey, amountCents } = payload;
  const original = String(payload.originalTransactionId);
  const endpoint = operation === 'refund' ? REFUND_ENDPOINT : VOID_ENDPOINT;
  const answer = (outcome, extra = {}) => ({
    operation,
    outcome,
    transactionId: null,
    originalTransactionId: original,
    amountCents: null,
    source: 'gateway_lookup',
    ...extra,
  });

  // 1. This service's own records.
  const row = await store.findIdempotency(endpoint, idempotencyKey);
  const body = row?.response_body;
  if (row?.status === 'completed' && body && GATEWAY_OUTCOMES.has(body.outcome)
      && (!body.orderId || body.orderId === orderId) && String(body.originalTransactionId || '') === original) {
    return answer(body.outcome, { transactionId: body.transactionId || null, amountCents: Number.isInteger(body.amountCents) ? body.amountCents : null, source: 'skin_record' });
  }
  const event = await store.findPaymentEventByIdempotencyKey(operation, idempotencyKey);
  if (event && event.order_id === orderId && GATEWAY_OUTCOMES.has(event.outcome) && String(event.original_transaction_id || '') === original) {
    return answer(event.outcome, { transactionId: event.authnet_transaction_id || null, amountCents: Number.isInteger(event.amount_cents) ? event.amount_cents : null, source: 'skin_record' });
  }

  const startedMs = Date.parse(payload.attemptStartedAt);
  const rowCreatedMs = Date.parse(row?.created_at || '');
  const referenceMs = Number.isFinite(rowCreatedMs) ? Math.max(startedMs, rowCreatedMs) : startedMs;
  const oldEnough = now.getTime() - referenceMs >= NOT_FOUND_AFTER_MS;

  // 2a. Void: the charge's own status.
  if (operation === 'void') {
    let details;
    try {
      details = await gateway.getTransactionDetails(config, original);
    } catch {
      return answer('pending');
    }
    const status = details?.transactionStatus || null;
    if (status === 'voided') return answer('captured', { transactionId: original, amountCents });
    // A settled charge cannot be voided: the void certainly did not happen.
    if (SETTLED_CHARGE_STATUSES.has(status)) return answer('rejected');
    if (status && oldEnough) return answer('not_found');
    return answer('pending');
  }

  // 2b. Refund: refund transactions of this amount since the attempt began,
  //     confirmed against this charge through their details.
  const known = new Set((payload.knownTransactionIds || []).map(String));
  const isCandidate = (tx) => {
    if (!tx || !REFUND_TRANSACTION_STATUSES.has(tx.transactionStatus)) return false;
    if (centsFromMoney(tx.settleAmount ?? tx.authAmount) !== amountCents) return false;
    const submitted = Date.parse(tx.submitTimeUTC || tx.submitTimeLocal || '');
    if (!Number.isFinite(submitted) || submitted < startedMs - RECONCILE_CLOCK_TOLERANCE_MS) return false;
    return !known.has(String(tx.transId));
  };
  let lookupFailed = false;
  let candidates = [];
  try {
    candidates.push(...(await gateway.getUnsettledTransactionList(config)).filter(isCandidate));
  } catch {
    lookupFailed = true;
  }
  try {
    candidates.push(...(await gateway.getRecentSettledTransactions(config, { now, days: 2 })).filter(isCandidate));
  } catch {
    lookupFailed = true;
  }
  const seen = new Set();
  candidates = candidates.filter((tx) => !seen.has(String(tx.transId)) && seen.add(String(tx.transId)));

  for (const tx of candidates.slice(0, MAX_REFUND_DETAIL_LOOKUPS)) {
    let details;
    try {
      details = await gateway.getTransactionDetails(config, tx.transId);
    } catch {
      lookupFailed = true;
      continue;
    }
    if (String(details?.refTransId || '') !== original) continue;
    if (details?.transactionType && details.transactionType !== 'refundTransaction') continue;
    return answer('captured', { transactionId: String(tx.transId), amountCents: centsFromMoney(details?.settleAmount ?? tx.settleAmount) ?? amountCents });
  }
  if (candidates.length > MAX_REFUND_DETAIL_LOOKUPS) lookupFailed = true;

  return answer(!lookupFailed && oldEnough ? 'not_found' : 'pending');
}

async function handleReconcile(req, rawBody, deps) {
  const d = resolveDeps(deps);
  const { config, store } = await authenticate(req, rawBody, d);
  assertGatewayModeUsable(config);
  const payload = parsePayload(rawBody);
  validateReconcilePayload(payload);

  let result;
  try {
    const ctx = { config, store, gateway: d.gateway, now: d.now() };
    result = payload.operation === 'refund' || payload.operation === 'void'
      ? await reconcileReversal(ctx, payload)
      : await reconcileAttempt(ctx, payload);
  } catch (error) {
    d.log('reconcile_error', { message: error?.message });
    throw unavailable('Payment records are temporarily unavailable');
  }
  return { statusCode: 200, body: { ok: true, orderId: payload.orderId, ...result } };
}

// ---------------------------------------------------------------------------
// Outbox retry
// ---------------------------------------------------------------------------

async function retryPendingSyncDeliveries(authTokenFromRequest, deps) {
  const d = resolveDeps(deps);
  let config;
  try {
    config = d.loadConfig();
  } catch (error) {
    d.log('config_error', { code: error?.code || 'config_error' });
    throw unavailable('Payment service is not configured');
  }

  if (!config.labsSync.retryAuthToken) {
    throw new BridgeError({ statusCode: 503, outcome: 'invalid', message: 'Retry endpoint is not configured' });
  }
  if (!safeEqualHex(digestHex(String(authTokenFromRequest || '')), digestHex(config.labsSync.retryAuthToken))) {
    throw new BridgeError({ statusCode: 401, outcome: 'invalid', message: 'Unauthorized retry token' });
  }
  if (!assertLabsSyncConfigured(config)) {
    return { statusCode: 200, body: { ok: true, retried: 0, results: [], message: 'Labs callback is not configured' } };
  }

  const store = d.createStore(config);
  const due = await store.listDueSyncEvents({ limit: config.labsSync.retryBatchSize, now: d.now() });
  const results = [];
  for (const event of due) {
    const attempt = await deliverSyncEvent(config, event.payload, {
      previousAttempts: Number(event.delivery_attempt_count || 0),
      post: d.postToLabs,
    });
    const plan = planNextDelivery(attempt, d.now());
    await safely(d, 'outbox_mark_error', () => store.markSyncDeliveryAttempt(event.id, plan));
    results.push({
      id: event.id,
      eventKey: event.event_key,
      delivered: attempt.delivered,
      deliveryStatus: plan.delivery_status,
      nextAttemptAt: plan.next_attempt_at,
      httpStatus: attempt.httpStatus || null,
      error: attempt.error || null,
    });
  }

  return { statusCode: 200, body: { ok: true, retried: results.length, results } };
}

module.exports = {
  BridgeError,
  CHARGE_ENDPOINT,
  CUSTOMER_MESSAGES,
  NOT_FOUND_AFTER_MS,
  OUTCOME_STATUS,
  REFUND_ENDPOINT,
  VOID_ENDPOINT,
  assertChargeLineItems,
  assertNoSensitiveCardFields,
  handleCharge,
  handleReconcile,
  handleRefund,
  handleVoid,
  handleWebhook,
  mapWebhookEventToOrderStatus,
  outcomeForTransactionStatus,
  declineCategoryFor,
  reconcileAttempt,
  reconcileReversal,
  redactPaymentPayload,
  retryPendingSyncDeliveries,
  toErrorResponse,
  verifyWebhookPayment,
  withIdempotency,
};
