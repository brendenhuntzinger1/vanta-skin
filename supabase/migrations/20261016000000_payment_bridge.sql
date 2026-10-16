create extension if not exists pgcrypto;

create table if not exists public.payment_request_replays (
  hmac_key_id text not null,
  nonce text not null,
  request_hash text not null,
  received_at timestamptz not null default now(),
  primary key (hmac_key_id, nonce)
);

create table if not exists public.payment_idempotency (
  endpoint text not null,
  idempotency_key text not null,
  request_hash text not null,
  response_status integer not null,
  response_body jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (endpoint, idempotency_key)
);

create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),
  order_id text not null,
  origin_storefront text not null,
  action text not null check (action in ('charge', 'refund', 'void')),
  amount_cents integer,
  currency text not null,
  status text not null,
  authnet_transaction_id text,
  request_payload jsonb not null,
  response_payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists payment_events_order_id_idx on public.payment_events (order_id);
create index if not exists payment_events_authnet_trans_idx on public.payment_events (authnet_transaction_id);

create table if not exists public.authnet_webhook_events (
  event_id text primary key,
  event_type text not null,
  transaction_id text,
  reconciled_order_id text,
  reconciled_status text,
  payload jsonb not null,
  received_at timestamptz not null default now()
);

create index if not exists authnet_webhook_events_transaction_idx on public.authnet_webhook_events (transaction_id);

alter table public.payment_request_replays enable row level security;
alter table public.payment_idempotency enable row level security;
alter table public.payment_events enable row level security;
alter table public.authnet_webhook_events enable row level security;

create policy "service role full access payment_request_replays"
  on public.payment_request_replays
  as permissive
  for all
  to service_role
  using (true)
  with check (true);

create policy "service role full access payment_idempotency"
  on public.payment_idempotency
  as permissive
  for all
  to service_role
  using (true)
  with check (true);

create policy "service role full access payment_events"
  on public.payment_events
  as permissive
  for all
  to service_role
  using (true)
  with check (true);

create policy "service role full access authnet_webhook_events"
  on public.authnet_webhook_events
  as permissive
  for all
  to service_role
  using (true)
  with check (true);
