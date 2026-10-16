create table if not exists public.payment_order_sync_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  order_id text not null,
  origin_storefront text not null,
  event_type text not null,
  payment_status text not null,
  transaction_id text,
  payload jsonb not null,
  delivery_status text not null default 'pending' check (delivery_status in ('pending','failed','delivered','disabled')),
  delivery_attempt_count integer not null default 0,
  last_delivery_http_status integer,
  last_delivery_error text,
  last_delivery_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payment_order_sync_events_order_idx on public.payment_order_sync_events (order_id);
create index if not exists payment_order_sync_events_status_idx on public.payment_order_sync_events (delivery_status, created_at);

alter table public.payment_order_sync_events enable row level security;

create policy "service role full access payment_order_sync_events"
  on public.payment_order_sync_events
  as permissive
  for all
  to service_role
  using (true)
  with check (true);
