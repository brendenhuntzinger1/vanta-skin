const { createClient } = require('@supabase/supabase-js');

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error) {
  return !!error && String(error.code) === UNIQUE_VIOLATION;
}

function createSupabase(config) {
  return createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: { persistSession: false },
  });
}

const PAYMENT_EVENT_COLUMNS = [
  'order_id',
  'origin_storefront',
  'action',
  'status',
  'outcome',
  'amount_cents',
  'auth_amount_cents',
  'currency',
  'authnet_transaction_id',
  'original_transaction_id',
  'card_last4',
  'card_type',
  'idempotency_key',
  'ref_id',
  'created_at',
].join(', ');

// Every database operation the payment service performs, over one Supabase
// client. Service code depends on this interface only, so tests swap in an
// in-memory store.
function createStore(client) {
  return {
    async recordReplayNonce(keyId, nonce, requestHash) {
      const { error } = await client
        .from('payment_request_replays')
        .insert({ hmac_key_id: keyId, nonce, request_hash: requestHash });
      if (error) {
        if (isUniqueViolation(error)) return false;
        throw new Error(`Unable to persist nonce replay key: ${error.message}`);
      }
      return true;
    },

    async findIdempotency(endpoint, idempotencyKey) {
      const { data, error } = await client
        .from('payment_idempotency')
        .select('status, request_hash, response_status, response_body, created_at, updated_at')
        .eq('endpoint', endpoint)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      if (error) throw new Error(`Unable to lookup idempotency key: ${error.message}`);
      return data || null;
    },

    // Plain INSERT: the primary key (endpoint, idempotency_key) makes exactly
    // one caller the owner. Never an upsert — an upsert would let a second
    // request overwrite the first one's claim or stored result.
    async claimIdempotency({ endpoint, idempotencyKey, requestHash }) {
      const now = new Date().toISOString();
      const { error } = await client.from('payment_idempotency').insert({
        endpoint,
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
        status: 'in_progress',
        response_status: null,
        response_body: null,
        created_at: now,
        updated_at: now,
      });
      if (!error) return { claimed: true, existing: null };
      if (!isUniqueViolation(error)) throw new Error(`Unable to claim idempotency key: ${error.message}`);
      const existing = await this.findIdempotency(endpoint, idempotencyKey);
      return { claimed: false, existing: existing || { status: 'in_progress', request_hash: requestHash } };
    },

    // Moves the caller's own in_progress claim to completed / uncertain. The
    // filters mean it can never touch a row it did not claim. Throws unless
    // exactly that row was updated.
    async finishIdempotency({ endpoint, idempotencyKey, requestHash, status, responseStatus, responseBody }) {
      const { data, error } = await client
        .from('payment_idempotency')
        .update({
          status,
          response_status: responseStatus,
          response_body: responseBody,
          updated_at: new Date().toISOString(),
        })
        .eq('endpoint', endpoint)
        .eq('idempotency_key', idempotencyKey)
        .eq('request_hash', requestHash)
        .eq('status', 'in_progress')
        .select('idempotency_key');
      if (error) throw new Error(`Unable to save idempotency result: ${error.message}`);
      if (!Array.isArray(data) || data.length !== 1) throw new Error('Idempotency result was not saved (claim row missing)');
    },

    // Duplicate charge rows (same idempotency_key) are ignored.
    async recordPaymentEvent(event) {
      const { error } = await client.from('payment_events').insert(event);
      if (error) {
        if (isUniqueViolation(error)) return { inserted: false };
        throw new Error(`Unable to store payment event: ${error.message}`);
      }
      return { inserted: true };
    },

    async findPaymentEventByTransaction(transactionId, actions) {
      if (!transactionId) return null;
      let query = client
        .from('payment_events')
        .select(PAYMENT_EVENT_COLUMNS)
        .eq('authnet_transaction_id', String(transactionId));
      if (Array.isArray(actions) && actions.length) query = query.in('action', actions);
      const { data, error } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error(`Unable to lookup payment event by transaction: ${error.message}`);
      return data || null;
    },

    async findPaymentEventByIdempotencyKey(action, idempotencyKey) {
      if (!idempotencyKey || !action) return null;
      const { data, error } = await client
        .from('payment_events')
        .select(PAYMENT_EVENT_COLUMNS)
        .eq('action', String(action))
        .eq('idempotency_key', String(idempotencyKey))
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`Unable to lookup payment event by idempotency key: ${error.message}`);
      return data || null;
    },

    async findChargeEventByIdempotencyKey(idempotencyKey) {
      if (!idempotencyKey) return null;
      const { data, error } = await client
        .from('payment_events')
        .select(PAYMENT_EVENT_COLUMNS)
        .eq('action', 'charge')
        .eq('idempotency_key', String(idempotencyKey))
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`Unable to lookup charge by idempotency key: ${error.message}`);
      return data || null;
    },

    // First write wins; a redelivered notification is reported as a duplicate.
    async recordWebhookEvent(webhookEvent) {
      const { error } = await client.from('authnet_webhook_events').insert(webhookEvent);
      if (error) {
        if (isUniqueViolation(error)) return { inserted: false };
        throw new Error(`Unable to store webhook event: ${error.message}`);
      }
      return { inserted: true };
    },

    // Insert-once by event_key. An existing row is returned untouched, so a
    // delivered or dead event is never reset to pending.
    async insertSyncEvent(event) {
      const now = new Date().toISOString();
      const row = {
        event_key: event.event_key,
        order_id: event.order_id,
        origin_storefront: event.origin_storefront,
        event_type: event.event_type,
        payment_status: event.payment_status,
        transaction_id: event.transaction_id,
        payload: event.payload,
        delivery_status: event.delivery_status || 'pending',
        next_attempt_at: event.next_attempt_at || now,
        created_at: now,
        updated_at: now,
      };
      const { data, error } = await client
        .from('payment_order_sync_events')
        .insert(row)
        .select('id, event_key, delivery_status, delivery_attempt_count')
        .single();
      if (!error) return { ...data, inserted: true };
      if (!isUniqueViolation(error)) throw new Error(`Unable to insert payment sync event: ${error.message}`);
      const existing = await client
        .from('payment_order_sync_events')
        .select('id, event_key, delivery_status, delivery_attempt_count')
        .eq('event_key', event.event_key)
        .maybeSingle();
      if (existing.error) throw new Error(`Unable to read payment sync event: ${existing.error.message}`);
      return { ...existing.data, inserted: false };
    },

    async markSyncDeliveryAttempt(syncEventId, plan) {
      const now = new Date().toISOString();
      const patch = {
        delivery_status: plan.delivery_status,
        delivery_attempt_count: plan.delivery_attempt_count,
        next_attempt_at: plan.next_attempt_at,
        last_delivery_http_status: plan.last_delivery_http_status ?? null,
        last_delivery_error: plan.last_delivery_error ?? null,
        last_delivery_at: now,
        updated_at: now,
      };
      if (plan.delivery_status === 'delivered') patch.delivered_at = now;
      const { error } = await client.from('payment_order_sync_events').update(patch).eq('id', syncEventId);
      if (error) throw new Error(`Unable to update payment sync delivery attempt: ${error.message}`);
    },

    // Only rows that are due, oldest due first.
    async listDueSyncEvents({ limit = 25, now = new Date() } = {}) {
      const { data, error } = await client
        .from('payment_order_sync_events')
        .select('id, event_key, order_id, origin_storefront, event_type, payment_status, transaction_id, payload, delivery_status, delivery_attempt_count, next_attempt_at')
        .in('delivery_status', ['pending', 'failed'])
        .lte('next_attempt_at', new Date(now).toISOString())
        .order('next_attempt_at', { ascending: true })
        .limit(limit);
      if (error) throw new Error(`Unable to list due sync events: ${error.message}`);
      return data || [];
    },

    // Embedded-checkout payment sessions. Only token SHA-256 hashes are
    // stored; the raw token is returned to the Labs backend exactly once.
    async createPaymentSession(record) {
      const { error } = await client.from('payment_sessions').insert(record);
      if (error) throw new Error(`Unable to create payment session: ${error.message}`);
    },

    async findPaymentSessionByTokenHash(tokenHash) {
      const { data, error } = await client
        .from('payment_sessions')
        .select('token_hash, order_id, amount_cents, currency, origin_storefront, parent_origin, expires_at, consumed_at')
        .eq('token_hash', tokenHash)
        .maybeSingle();
      if (error) throw new Error(`Unable to lookup payment session: ${error.message}`);
      return data || null;
    },

    // Atomic single-use consumption: the update only lands while consumed_at
    // is still null, so two racing charges can never both spend a session.
    async consumePaymentSession(tokenHash) {
      const { data, error } = await client
        .from('payment_sessions')
        .update({ consumed_at: new Date().toISOString() })
        .eq('token_hash', tokenHash)
        .is('consumed_at', null)
        .select('token_hash');
      if (error) throw new Error(`Unable to consume payment session: ${error.message}`);
      return Array.isArray(data) ? data.length : 0;
    },

    // The retention policy lives in SQL (purge_payment_bridge_data, migration
    // 20261017002000) so it runs in one transaction and is reviewed in one place.
    async purgeExpiredPaymentData(now = new Date()) {
      const { data, error } = await client.rpc('purge_payment_bridge_data', { p_now: now.toISOString() });
      if (error) throw new Error(`Unable to purge expired payment data: ${error.message}`);
      return data;
    },
  };
}

module.exports = {
  createStore,
  createSupabase,
  isUniqueViolation,
};
