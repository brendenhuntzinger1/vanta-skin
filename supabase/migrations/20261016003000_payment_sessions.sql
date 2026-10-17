create table if not exists public.payment_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  order_id text not null,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'USD',
  origin_storefront text not null,
  parent_origin text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists payment_sessions_expires_at_idx on public.payment_sessions (expires_at);
create index if not exists payment_sessions_order_id_idx on public.payment_sessions (order_id);

alter table public.payment_sessions enable row level security;

create policy "service role full access payment_sessions"
  on public.payment_sessions
  as permissive
  for all
  to service_role
  using (true)
  with check (true);
