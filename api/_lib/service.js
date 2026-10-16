const { loadConfig } = require('./config');
const {
  assertOrderMatches,
  createSupabase,
  findIdempotency,
  markOrderPayment,
  recordPaymentEvent,
  recordReplayNonce,
  recordWebhookEvent,
  saveIdempotency,
} = require('./supabase');
const { verifyRequestSignature, verifyWebhookSignature } = require('./security');
const { chargeOpaqueData, refundTransaction, voidTransaction } = require('./authnet');

function assertString(value, field) {
  if (!value || typeof value !== 'string') throw new Error(`Missing or invalid ${field}`);
}

function assertInteger(value, field) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Missing or invalid ${field}`);
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

  const endpoint = '/api/payments/charge';
  return withIdempotency(supabase, endpoint, req.headers['x-idempotency-key'], signed.requestHash, async () => {
    await assertOrderMatches(supabase, config, {
      orderId: payload.orderId,
      amountCents: payload.amountCents,
      currency: payload.currency || config.authnet.defaultCurrency,
    });

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

    if (result.ok) {
      await markOrderPayment(supabase, config, payload.orderId, 'paid', result.transactionId);
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

    if (result.ok) {
      await markOrderPayment(supabase, config, payload.orderId, 'voided', result.transactionId || payload.transactionId);
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

    if (result.ok) {
      await markOrderPayment(supabase, config, payload.orderId, 'refunded', result.transactionId || payload.transactionId);
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

  await recordWebhookEvent(supabase, {
    event_id: String(eventId || `unknown-${Date.now()}`),
    event_type: payload?.eventType || 'unknown',
    payload,
    received_at: new Date().toISOString(),
  });

  return {
    statusCode: 200,
    body: {
      ok: true,
      message: 'Webhook accepted',
    },
  };
}

module.exports = {
  handleCharge,
  handleRefund,
  handleVoid,
  handleWebhook,
};
