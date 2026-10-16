const { createClient } = require('@supabase/supabase-js');

function createSupabase(config) {
  return createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: { persistSession: false },
  });
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

async function findLatestPaymentEventByTransaction(supabase, transactionId) {
  if (!transactionId) return null;
  const { data, error } = await supabase
    .from('payment_events')
    .select('order_id, status, origin_storefront')
    .eq('authnet_transaction_id', String(transactionId))
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Unable to lookup payment event by transaction ${transactionId}: ${error.message}`);
  return data || null;
}

async function upsertPaymentSyncEvent(supabase, event) {
  const payload = {
    event_key: event.event_key,
    order_id: event.order_id,
    origin_storefront: event.origin_storefront,
    event_type: event.event_type,
    payment_status: event.payment_status,
    transaction_id: event.transaction_id,
    payload: event.payload,
    delivery_status: event.delivery_status || 'pending',
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('payment_order_sync_events')
    .upsert(payload, { onConflict: 'event_key' })
    .select('id, event_key, delivery_status, delivery_attempt_count')
    .single();

  if (error) throw new Error(`Unable to upsert payment sync event: ${error.message}`);
  return data;
}

async function markPaymentSyncDeliveryAttempt(supabase, syncEventId, attemptResult) {
  const payload = {
    delivery_status: attemptResult.delivered ? 'delivered' : 'failed',
    delivery_attempt_count: attemptResult.deliveryAttemptCount,
    last_delivery_http_status: attemptResult.httpStatus || null,
    last_delivery_error: attemptResult.error || null,
    last_delivery_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (attemptResult.delivered) {
    payload.delivered_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from('payment_order_sync_events')
    .update(payload)
    .eq('id', syncEventId);

  if (error) throw new Error(`Unable to update payment sync delivery attempt: ${error.message}`);
}

async function listPendingPaymentSyncEvents(supabase, limit = 25) {
  const { data, error } = await supabase
    .from('payment_order_sync_events')
    .select('id, event_key, order_id, origin_storefront, event_type, payment_status, transaction_id, payload, delivery_attempt_count')
    .in('delivery_status', ['pending', 'failed'])
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`Unable to list pending sync events: ${error.message}`);
  return data || [];
}

module.exports = {
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
};
