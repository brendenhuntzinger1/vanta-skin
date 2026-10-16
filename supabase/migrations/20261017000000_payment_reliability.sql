-- Payment reliability (2026-10-17). NOT applied by the change that added it:
-- apply with `supabase db push` BEFORE deploying the code that depends on it.
-- Every statement is idempotent, so a re-run is harmless.
-- Reverse with ROLLBACK-20261017000000_payment_reliability.sql (manual).

-- ---------------------------------------------------------------------------
-- payment_idempotency: the key is claimed (in_progress) before the gateway is
-- called, then moved to completed or uncertain. Existing rows were written
-- only after a result, so they are completed. The column default stays
-- 'completed' so code from before this change (which writes after the result)
-- still produces correct rows during a rolling deploy; new code always sets
-- the status explicitly.
-- ---------------------------------------------------------------------------
alter table public.payment_idempotency
  add column if not exists status text not null default 'completed',
  add column if not exists updated_at timestamptz not null default now();

alter table public.payment_idempotency alter column response_status drop not null;
alter table public.payment_idempotency alter column response_body drop not null;

alter table public.payment_idempotency drop constraint if exists payment_idempotency_status_check;
alter table public.payment_idempotency
  add constraint payment_idempotency_status_check check (status in ('in_progress', 'completed', 'uncertain'));

alter table public.payment_idempotency drop constraint if exists payment_idempotency_completed_has_response;
alter table public.payment_idempotency
  add constraint payment_idempotency_completed_has_response
  check (status <> 'completed' or (response_status is not null and response_body is not null));

create index if not exists payment_idempotency_status_idx on public.payment_idempotency (status, created_at);

-- ---------------------------------------------------------------------------
-- payment_events: card data, outcome and the keys reconciliation needs.
-- ---------------------------------------------------------------------------
alter table public.payment_events
  add column if not exists outcome text,
  add column if not exists card_last4 text,
  add column if not exists card_type text,
  add column if not exists ref_id text,
  add column if not exists idempotency_key text,
  add column if not exists auth_amount_cents integer,
  add column if not exists original_transaction_id text;

alter table public.payment_events drop constraint if exists payment_events_outcome_check;
alter table public.payment_events
  add constraint payment_events_outcome_check
  check (outcome is null or outcome in ('captured', 'declined', 'rejected', 'held', 'uncertain'));

alter table public.payment_events drop constraint if exists payment_events_card_last4_check;
alter table public.payment_events
  add constraint payment_events_card_last4_check check (card_last4 is null or card_last4 ~ '^[0-9]{4}$');

-- One charge row per attempt key.
create unique index if not exists payment_events_charge_idempotency_key_uidx
  on public.payment_events (idempotency_key)
  where action = 'charge' and idempotency_key is not null;

create index if not exists payment_events_trans_action_idx on public.payment_events (authnet_transaction_id, action);

-- ---------------------------------------------------------------------------
-- authnet_webhook_events: why a notification was or was not forwarded.
-- ---------------------------------------------------------------------------
alter table public.authnet_webhook_events
  add column if not exists verification text;

-- ---------------------------------------------------------------------------
-- payment_order_sync_events: scheduled retries with backoff and a dead letter.
-- Existing rows become due immediately.
-- ---------------------------------------------------------------------------
alter table public.payment_order_sync_events
  add column if not exists next_attempt_at timestamptz not null default now();

alter table public.payment_order_sync_events drop constraint if exists payment_order_sync_events_delivery_status_check;
alter table public.payment_order_sync_events
  add constraint payment_order_sync_events_delivery_status_check
  check (delivery_status in ('pending', 'failed', 'delivered', 'disabled', 'dead'));

create index if not exists payment_order_sync_events_due_idx
  on public.payment_order_sync_events (delivery_status, next_attempt_at);

-- ---------------------------------------------------------------------------
-- Only the service role reads or writes payment tables. RLS is already on;
-- this also removes the table privileges Supabase grants by default.
-- ---------------------------------------------------------------------------
revoke all on table
  public.payment_request_replays,
  public.payment_idempotency,
  public.payment_events,
  public.authnet_webhook_events,
  public.payment_order_sync_events
from anon, authenticated;
