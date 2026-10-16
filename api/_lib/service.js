const { loadConfig } = require('./config');
const {
  createSupabase,
  findLatestPaymentEventByTransaction,
  findIdempotency,
  listPendingPaymentSyncEvents,
  markPaymentSyncDeliveryAttempt,
  recordPaymentEvent,
  recordReplayNonce,
  recordWebhookEvent,
  saveIdempotency,
  upsertPaymentSyncEvent,
} = require('./supabase');
const { verifyRequestSignature, verifyWebhookSignature } = require('./security');
const { chargeOpaqueData, normalizeRefundCardReference, refundTransaction, voidTransaction } = require('./authnet');
const { assertLabsSyncConfigured, buildSyncEventKey, deliverSyncEvent } = require('./sync');

function assertString(value, field) {
  if (!value || typeof value !== 'string') throw new Error(`Missing or invalid ${field}`);
}

function assertInteger(value, field) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Missing or invalid ${field}`);
}

function assertAllowedStorefront(config, storefront) {
  const normalized = String(storefront || '').trim().toLowerCase();
  if (!config.bridge.allowedOriginStorefronts.includes(normalized)) {
    throw new Error(`originStorefront is not approved: ${storefront}`);
  }
}

function assertNoSensitiveCardFields(payload) {
  const forbidden = ['cardNumber', 'cardCode', 'cvv', 'cvc', 'securityCode', 'pan'];
  for (const key of forbidden) {
    if (payload[key] !== undefined) {
      throw new Error(`Sensitive field ${key} is not allowed. Use Authorize.net opaqueData tokenization.`);
    }
  }
}

function assertChargeLineItemsAmount(payload) {
  if (!Array.isArray(payload.lineItems) || payload.lineItems.length === 0) return;
  const sum = payload.lineItems.reduce((acc, item) => {
    const qty = Number(item?.quantity || 0);
    const unit = Number(item?.unitPriceCents || 0);
    return acc + Math.round(qty * unit);
  }, 0);

  if (sum !== Number(payload.amountCents)) {
    throw new Error(`lineItems amount total (${sum}) does not match amountCents (${payload.amountCents})`);
  }
}

function mapWebhookEventToOrderStatus(eventType) {
  const map = {
    'net.authorize.payment.authcapture.created': 'paid',
    'net.authorize.payment.capture.created': 'paid',
    'net.authorize.payment.authorization.created': 'authorized',
    'net.authorize.payment.refund.created': 'refunded',
    'net.authorize.payment.void.created': 'voided',
  };
  return map[String(eventType || '').toLowerCase()] || null;
}

function extractWebhookTransactionId(payload) {
  return payload?.payload?.id || payload?.payload?.transId || null;
}

async function authenticateBridgeRequest(req, rawBody) {
  const config = loadConfig();
  const supabase = createSupabase(config);
  const signed = verifyRequestSignature(config, req, rawBody);
  const persisted = await recordReplayNonce(supabase, signed.keyId, signed.nonce, signed.requestHash);
  if (!persisted) {
    const err = new Error('Replay detected for nonce');
    err.statusCode = 409;
    throw err;
  }

  return { config, supabase, signed };
}

async function withIdempotency(supabase, endpoint, idempotencyKey, requestHash, execute) {
  if (!idempotencyKey) {
    const err = new Error('Missing idempotency key');
    err.statusCode = 400;
    throw err;
  }

  const existing = await findIdempotency(supabase, endpoint, idempotencyKey);
  if (existing) {
    if (existing.request_hash !== requestHash) {
      const err = new Error('Idempotency key already used with different payload');
      err.statusCode = 409;
      throw err;
    }
    return {
      statusCode: existing.response_status,
      body: existing.response_body,
      replayed: true,
    };
  }

  const result = await execute();
  await saveIdempotency(supabase, endpoint, idempotencyKey, requestHash, result.statusCode, result.body);
  return { ...result, replayed: false };
}

async function handleCharge(req, rawBody, payload) {
  const { config, supabase, signed } = await authenticateBridgeRequest(req, rawBody);

  assertString(payload.orderId, 'orderId');
  assertInteger(payload.amountCents, 'amountCents');
  assertString(payload.originStorefront, 'originStorefront');
  assertString(payload.opaqueData?.dataDescriptor, 'opaqueData.dataDescriptor');
  assertString(payload.opaqueData?.dataValue, 'opaqueData.dataValue');
  assertAllowedStorefront(config, payload.originStorefront);
  assertNoSensitiveCardFields(payload);
  assertChargeLineItemsAmount(payload);

  const endpoint = '/api/payments/charge';
  return withIdempotency(supabase, endpoint, req.headers['x-idempotency-key'], signed.requestHash, async () => {
    const result = await chargeOpaqueData(config, payload);
    const paymentStatus = result.ok ? 'captured' : 'declined';

    await recordPaymentEvent(supabase, {
      order_id: payload.orderId,
      origin_storefront: payload.originStorefront,
      action: 'charge',
      amount_cents: payload.amountCents,
      currency: payload.currency || config.authnet.defaultCurrency,
      status: paymentStatus,
      authnet_transaction_id: result.transactionId,
      request_payload: payload,
      response_payload: result.raw,
    });

    const syncPayload = {
      eventId: buildSyncEventKey({
        source: 'bridge',
        action: 'charge',
        idempotencyKey: req.headers['x-idempotency-key'],
        orderId: payload.orderId,
        transactionId: result.transactionId,
        paymentStatus,
      }),
      source: 'vanta-skin-payment-bridge',
      action: 'charge',
      orderId: payload.orderId,
      originStorefront: payload.originStorefront,
      amountCents: payload.amountCents,
      currency: payload.currency || config.authnet.defaultCurrency,
      transactionId: result.transactionId,
      paymentStatus,
      processorCode: result.statusCode,
      message: result.message,
      sandbox: config.authnet.sandbox,
      occurredAt: new Date().toISOString(),
      deliveryAttemptCount: 0,
    };
    const syncEvent = await upsertPaymentSyncEvent(supabase, {
      event_key: syncPayload.eventId,
      order_id: payload.orderId,
      origin_storefront: payload.originStorefront,
      event_type: 'payment.charge',
      payment_status: paymentStatus,
      transaction_id: result.transactionId,
      payload: syncPayload,
      delivery_status: assertLabsSyncConfigured(config) ? 'pending' : 'disabled',
    });

    if (assertLabsSyncConfigured(config) && syncEvent.delivery_status !== 'delivered') {
      const attempt = await deliverSyncEvent(config, syncPayload);
      await markPaymentSyncDeliveryAttempt(supabase, syncEvent.id, attempt);
    }

    const statusCode = result.ok ? 200 : 402;
    return {
      statusCode,
      body: {
        ok: result.ok,
        action: 'charge',
        orderId: payload.orderId,
        transactionId: result.transactionId,
        paymentStatus,
        processorCode: result.statusCode,
        message: result.message,
        sandbox: config.authnet.sandbox,
      },
    };
  });
}

async function handleVoid(req, rawBody, payload) {
  const { config, supabase, signed } = await authenticateBridgeRequest(req, rawBody);

  assertString(payload.orderId, 'orderId');
  assertString(payload.originStorefront, 'originStorefront');
  assertString(payload.transactionId, 'transactionId');
  assertAllowedStorefront(config, payload.originStorefront);

  const endpoint = '/api/payments/void';
  return withIdempotency(supabase, endpoint, req.headers['x-idempotency-key'], signed.requestHash, async () => {
    const result = await voidTransaction(config, payload.transactionId);
    const paymentStatus = result.ok ? 'voided' : 'void_failed';

    await recordPaymentEvent(supabase, {
      order_id: payload.orderId,
      origin_storefront: payload.originStorefront,
      action: 'void',
      amount_cents: payload.amountCents || null,
      currency: payload.currency || config.authnet.defaultCurrency,
      status: paymentStatus,
      authnet_transaction_id: result.transactionId || payload.transactionId,
      request_payload: payload,
      response_payload: result.raw,
    });

    const syncPayload = {
      eventId: buildSyncEventKey({
        source: 'bridge',
        action: 'void',
        idempotencyKey: req.headers['x-idempotency-key'],
        orderId: payload.orderId,
        transactionId: result.transactionId || payload.transactionId,
        paymentStatus,
      }),
      source: 'vanta-skin-payment-bridge',
      action: 'void',
      orderId: payload.orderId,
      originStorefront: payload.originStorefront,
      amountCents: payload.amountCents || null,
      currency: payload.currency || config.authnet.defaultCurrency,
      transactionId: result.transactionId || payload.transactionId,
      paymentStatus,
      processorCode: result.statusCode,
      message: result.message,
      sandbox: config.authnet.sandbox,
      occurredAt: new Date().toISOString(),
      deliveryAttemptCount: 0,
    };
    const syncEvent = await upsertPaymentSyncEvent(supabase, {
      event_key: syncPayload.eventId,
      order_id: payload.orderId,
      origin_storefront: payload.originStorefront,
      event_type: 'payment.void',
      payment_status: paymentStatus,
      transaction_id: result.transactionId || payload.transactionId,
      payload: syncPayload,
      delivery_status: assertLabsSyncConfigured(config) ? 'pending' : 'disabled',
    });

    if (assertLabsSyncConfigured(config) && syncEvent.delivery_status !== 'delivered') {
      const attempt = await deliverSyncEvent(config, syncPayload);
      await markPaymentSyncDeliveryAttempt(supabase, syncEvent.id, attempt);
    }

    const statusCode = result.ok ? 200 : 402;
    return {
      statusCode,
      body: {
        ok: result.ok,
        action: 'void',
        orderId: payload.orderId,
        transactionId: result.transactionId || payload.transactionId,
        paymentStatus,
        processorCode: result.statusCode,
        message: result.message,
        sandbox: config.authnet.sandbox,
      },
    };
  });
}

async function handleRefund(req, rawBody, payload) {
  const { config, supabase, signed } = await authenticateBridgeRequest(req, rawBody);

  assertString(payload.orderId, 'orderId');
  assertString(payload.originStorefront, 'originStorefront');
  assertString(payload.transactionId, 'transactionId');
  assertInteger(payload.amountCents, 'amountCents');
  assertString(payload.cardNumberMasked, 'cardNumberMasked');
  assertAllowedStorefront(config, payload.originStorefront);
  normalizeRefundCardReference(payload.cardNumberMasked);

  const endpoint = '/api/payments/refund';
  return withIdempotency(supabase, endpoint, req.headers['x-idempotency-key'], signed.requestHash, async () => {
    const result = await refundTransaction(config, payload);
    const paymentStatus = result.ok ? 'refunded' : 'refund_failed';

    await recordPaymentEvent(supabase, {
      order_id: payload.orderId,
      origin_storefront: payload.originStorefront,
      action: 'refund',
      amount_cents: payload.amountCents,
      currency: payload.currency || config.authnet.defaultCurrency,
      status: paymentStatus,
      authnet_transaction_id: result.transactionId || payload.transactionId,
      request_payload: payload,
      response_payload: result.raw,
    });

    const syncPayload = {
      eventId: buildSyncEventKey({
        source: 'bridge',
        action: 'refund',
        idempotencyKey: req.headers['x-idempotency-key'],
        orderId: payload.orderId,
        transactionId: result.transactionId || payload.transactionId,
        paymentStatus,
      }),
      source: 'vanta-skin-payment-bridge',
      action: 'refund',
      orderId: payload.orderId,
      originStorefront: payload.originStorefront,
      amountCents: payload.amountCents,
      currency: payload.currency || config.authnet.defaultCurrency,
      transactionId: result.transactionId || payload.transactionId,
      paymentStatus,
      processorCode: result.statusCode,
      message: result.message,
      sandbox: config.authnet.sandbox,
      occurredAt: new Date().toISOString(),
      deliveryAttemptCount: 0,
    };
    const syncEvent = await upsertPaymentSyncEvent(supabase, {
      event_key: syncPayload.eventId,
      order_id: payload.orderId,
      origin_storefront: payload.originStorefront,
      event_type: 'payment.refund',
      payment_status: paymentStatus,
      transaction_id: result.transactionId || payload.transactionId,
      payload: syncPayload,
      delivery_status: assertLabsSyncConfigured(config) ? 'pending' : 'disabled',
    });

    if (assertLabsSyncConfigured(config) && syncEvent.delivery_status !== 'delivered') {
      const attempt = await deliverSyncEvent(config, syncPayload);
      await markPaymentSyncDeliveryAttempt(supabase, syncEvent.id, attempt);
    }

    const statusCode = result.ok ? 200 : 402;
    return {
      statusCode,
      body: {
        ok: result.ok,
        action: 'refund',
        orderId: payload.orderId,
        transactionId: result.transactionId || payload.transactionId,
        paymentStatus,
        processorCode: result.statusCode,
        message: result.message,
        sandbox: config.authnet.sandbox,
      },
    };
  });
}

async function handleWebhook(rawBody, signatureHeader) {
  const config = loadConfig();
  const supabase = createSupabase(config);

  if (!verifyWebhookSignature(config.authnet.signatureKey, rawBody, signatureHeader)) {
    const err = new Error('Invalid Authorize.net webhook signature');
    err.statusCode = 401;
    throw err;
  }

  const payload = JSON.parse(rawBody || '{}');
  const eventId = payload?.notificationId || payload?.id;
  const eventType = String(payload?.eventType || 'unknown');
  const transactionId = extractWebhookTransactionId(payload);
  const reconciledStatus = mapWebhookEventToOrderStatus(eventType);
  let reconciledOrderId = null;
  let reconciledOriginStorefront = null;

  if (transactionId && reconciledStatus) {
    const paymentEvent = await findLatestPaymentEventByTransaction(supabase, transactionId);
    if (paymentEvent?.order_id) {
      reconciledOrderId = paymentEvent.order_id;
      reconciledOriginStorefront = paymentEvent.origin_storefront || null;
    }
  }

  await recordWebhookEvent(supabase, {
    event_id: String(eventId || `unknown-${Date.now()}`),
    event_type: eventType,
    payload,
    transaction_id: transactionId,
    reconciled_order_id: reconciledOrderId,
    reconciled_status: reconciledStatus,
    received_at: new Date().toISOString(),
  });

  if (reconciledOrderId && reconciledStatus) {
    const syncPayload = {
      eventId: buildSyncEventKey({
        source: 'webhook',
        eventId: String(eventId || ''),
      }),
      source: 'authorize-net-webhook',
      action: 'webhook_update',
      orderId: reconciledOrderId,
      originStorefront: reconciledOriginStorefront || 'unknown',
      amountCents: null,
      currency: null,
      transactionId,
      paymentStatus: reconciledStatus,
      processorCode: null,
      message: eventType,
      sandbox: config.authnet.sandbox,
      occurredAt: new Date().toISOString(),
      deliveryAttemptCount: 0,
    };
    const syncEvent = await upsertPaymentSyncEvent(supabase, {
      event_key: syncPayload.eventId,
      order_id: reconciledOrderId,
      origin_storefront: syncPayload.originStorefront,
      event_type: 'payment.webhook',
      payment_status: reconciledStatus,
      transaction_id: transactionId,
      payload: syncPayload,
      delivery_status: assertLabsSyncConfigured(config) ? 'pending' : 'disabled',
    });
    if (assertLabsSyncConfigured(config) && syncEvent.delivery_status !== 'delivered') {
      const attempt = await deliverSyncEvent(config, syncPayload);
      await markPaymentSyncDeliveryAttempt(supabase, syncEvent.id, attempt);
    }
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      message: 'Webhook accepted',
      reconciled: !!reconciledOrderId,
      reconciledOrderId,
      reconciledStatus,
    },
  };
}

async function retryPendingSyncDeliveries(authTokenFromRequest) {
  const config = loadConfig();
  const supabase = createSupabase(config);

  if (!config.labsSync.retryAuthToken) {
    throw new Error('VANTA_SYNC_RETRY_TOKEN is not configured');
  }
  if (authTokenFromRequest !== config.labsSync.retryAuthToken) {
    const err = new Error('Unauthorized retry token');
    err.statusCode = 401;
    throw err;
  }

  const pending = await listPendingPaymentSyncEvents(supabase, config.labsSync.retryBatchSize);
  const results = [];
  for (const event of pending) {
    const payload = {
      ...event.payload,
      deliveryAttemptCount: Number(event.delivery_attempt_count || 0),
    };
    const attempt = await deliverSyncEvent(config, payload);
    await markPaymentSyncDeliveryAttempt(supabase, event.id, attempt);
    results.push({
      id: event.id,
      eventKey: event.event_key,
      delivered: attempt.delivered,
      httpStatus: attempt.httpStatus || null,
      error: attempt.error || null,
    });
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      retried: results.length,
      results,
    },
  };
}

module.exports = {
  assertChargeLineItemsAmount,
  assertNoSensitiveCardFields,
  mapWebhookEventToOrderStatus,
  handleCharge,
  handleRefund,
  retryPendingSyncDeliveries,
  handleVoid,
  handleWebhook,
};
