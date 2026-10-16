const { createClient } = require('@supabase/supabase-js');

function createSupabase(config) {
  return createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: { persistSession: false },
  });
}

async function assertOrderMatches(supabase, config, { orderId, amountCents, currency }) {
  const table = config.supabase.ordersTable;
  const idCol = config.supabase.orderIdColumn;
  const amountCol = config.supabase.orderAmountColumn;
  const currencyCol = config.supabase.orderCurrencyColumn;

  const { data, error } = await supabase
    .from(table)
    .select(`${idCol}, ${amountCol}, ${currencyCol}`)
    .eq(idCol, orderId)
    .single();

  if (error || !data) {
    throw new Error(`Unable to validate order ${orderId}: ${error?.message || 'not found'}`);
  }

  if (amountCents !== undefined && Number(data[amountCol]) !== Number(amountCents)) {
    throw new Error(`Order amount mismatch for ${orderId}`);
  }

  if (currency && data[currencyCol] && String(data[currencyCol]).toUpperCase() !== String(currency).toUpperCase()) {
    throw new Error(`Order currency mismatch for ${orderId}`);
  }

  return data;
}

async function markOrderPayment(supabase, config, orderId, paymentStatus, transactionId) {
  const table = config.supabase.ordersTable;
  const idCol = config.supabase.orderIdColumn;
  const payload = {
    [config.supabase.orderStatusColumn]: paymentStatus,
    [config.supabase.orderTransactionColumn]: transactionId,
    [config.supabase.orderUpdatedAtColumn]: new Date().toISOString(),
  };

  const { error } = await supabase
    .from(table)
    .update(payload)
    .eq(idCol, orderId);

  if (error) {
    throw new Error(`Unable to update order ${orderId}: ${error.message}`);
  }
}

async function recordReplayNonce(supabase, keyId, nonce, requestHash) {
  const { error } = await supabase
    .from('payment_request_replays')
    .insert({
      hmac_key_id: keyId,
      nonce,
      request_hash: requestHash,
    });

  if (error) {
    if (String(error.code) === '23505') return false;
    throw new Error(`Unable to persist nonce replay key: ${error.message}`);
  }

  return true;
}

async function findIdempotency(supabase, endpoint, idempotencyKey) {
  const { data, error } = await supabase
    .from('payment_idempotency')
    .select('request_hash, response_status, response_body')
    .eq('endpoint', endpoint)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (error) throw new Error(`Unable to lookup idempotency key: ${error.message}`);
  return data;
}

async function saveIdempotency(supabase, endpoint, idempotencyKey, requestHash, status, body) {
  const payload = {
    endpoint,
    idempotency_key: idempotencyKey,
    request_hash: requestHash,
    response_status: status,
    response_body: body,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from('payment_idempotency').upsert(payload);
  if (error) throw new Error(`Unable to save idempotency result: ${error.message}`);
}

async function recordPaymentEvent(supabase, event) {
  const { error } = await supabase.from('payment_events').insert(event);
  if (error) throw new Error(`Unable to store payment event: ${error.message}`);
}

async function recordWebhookEvent(supabase, webhookEvent) {
  const { error } = await supabase.from('authnet_webhook_events').upsert(webhookEvent, {
    onConflict: 'event_id',
  });

  if (error) throw new Error(`Unable to store webhook event: ${error.message}`);
}

module.exports = {
  assertOrderMatches,
  createSupabase,
  findIdempotency,
  markOrderPayment,
  recordPaymentEvent,
  recordReplayNonce,
  recordWebhookEvent,
  saveIdempotency,
};
