-- payment_sessions joins the other payment tables (20261017000000): only the
-- service role reads or writes it. RLS is already on with a service-role-only
-- policy; this also removes the table privileges Supabase grants anon and
-- authenticated by default. Idempotent. Rollback: not needed (re-granting is
-- never part of a rollback).
revoke all on table public.payment_sessions from anon, authenticated;

-- Spent and expired sessions are only kept for audit; this index lets a
-- cleanup job find them without a scan.
create index if not exists payment_sessions_consumed_at_idx on public.payment_sessions (consumed_at);
