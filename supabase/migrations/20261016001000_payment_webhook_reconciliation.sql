alter table public.authnet_webhook_events
  add column if not exists transaction_id text,
  add column if not exists reconciled_order_id text,
  add column if not exists reconciled_status text;

create index if not exists authnet_webhook_events_transaction_idx on public.authnet_webhook_events (transaction_id);
