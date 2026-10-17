-- ---------------------------------------------------------------------------
-- Payment bridge data minimisation and retention (data-exposure audit
-- 2026-10-17, M2).
--
-- 1. payment_events.request_payload keeps an allowlist of fields from now on
--    (api/_lib/service.js redactPaymentPayload). This strips the customer
--    details already stored by earlier code: Labs is the system of record for
--    the customer, and Authorize.Net holds the billing details it was sent.
--    The columns reconciliation, refunds and disputes read (order, amounts,
--    transaction ids, card last 4 and type, ref id, idempotency key, the
--    gateway's response) are untouched.
--
-- 2. purge_payment_bridge_data() deletes working data once nothing can need
--    it. Run daily by Vercel Cron (GET /api/payments/maintenance).
--
--      payment_request_replays   1 day     nonces are refused outside a
--                                          300-second window anyway
--      payment_sessions          1 day     after expiry (15-minute TTL); a
--                                          session is never read once expired
--      payment_idempotency       180 days  completed rows only; reconciliation
--                                          reads them (Labs flags an attempt
--                                          for review at 48 hours)
--      payment_order_sync_events 90 days   delivered callbacks only; 'dead'
--                                          and undelivered rows wait for a
--                                          person
--      authnet_webhook_events    180 days  dedupe of Authorize.Net redelivery
--
--    payment_events is never purged here: it is the financial record of every
--    charge, refund and void, and after step 1 it holds no customer PII. How
--    long to keep it is a records-retention decision for the owner.
--
-- Not applied anywhere yet. Apply to staging first, after review.
-- ---------------------------------------------------------------------------

update public.payment_events pe
set request_payload = (
  select coalesce(jsonb_object_agg(kv.key, kv.value), '{}'::jsonb)
  from jsonb_each(pe.request_payload) as kv
  where kv.key in (
    'orderId', 'attemptNo', 'originStorefront', 'transactionId', 'amountCents', 'currency',
    'capture', 'requireSandbox', 'shippingCents', 'taxCents',
    'opaqueData', 'paymentSession', 'lineItemCount', 'sentCustomerFields'
  )
)
where pe.request_payload ?| array['customer', 'billTo', 'orderNumber', 'lineItems', 'cardNumberMasked'];

create or replace function public.purge_payment_bridge_data(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_replays integer;
  v_sessions integer;
  v_idempotency integer;
  v_outbox integer;
  v_webhooks integer;
begin
  delete from public.payment_request_replays
    where received_at < p_now - interval '1 day';
  get diagnostics v_replays = row_count;

  delete from public.payment_sessions
    where expires_at < p_now - interval '1 day';
  get diagnostics v_sessions = row_count;

  delete from public.payment_idempotency
    where status = 'completed'
      and updated_at < p_now - interval '180 days';
  get diagnostics v_idempotency = row_count;

  delete from public.payment_order_sync_events
    where delivery_status = 'delivered'
      and coalesce(delivered_at, updated_at) < p_now - interval '90 days';
  get diagnostics v_outbox = row_count;

  delete from public.authnet_webhook_events
    where received_at < p_now - interval '180 days';
  get diagnostics v_webhooks = row_count;

  return jsonb_build_object(
    'replays', v_replays,
    'sessions', v_sessions,
    'idempotency', v_idempotency,
    'outbox', v_outbox,
    'webhooks', v_webhooks
  );
end;
$$;

revoke all on function public.purge_payment_bridge_data(timestamptz) from public, anon, authenticated;
grant execute on function public.purge_payment_bridge_data(timestamptz) to service_role;
