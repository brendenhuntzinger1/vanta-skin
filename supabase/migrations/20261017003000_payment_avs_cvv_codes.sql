-- AVS and CVV result codes in their own columns (final readiness audit
-- 2026-10-17, A L6). NOT applied by the change that added it: apply with
-- `supabase db push` after review, staging first. Every statement is
-- idempotent, so a re-run is harmless.
--
-- The codes Authorize.Net returns for address and security-code checks were
-- kept only inside payment_events.response_payload (the gateway's raw answer).
-- They are the evidence for a dispute and for tuning the fraud filters, so
-- they get columns of their own: response_payload can then be trimmed by a
-- later retention change without losing them. No customer data is added; a
-- code is one or two letters or digits.
--
-- The code that writes these columns stores the event without them until this
-- migration is applied (api/_lib/supabase.js), so the order of deploy and
-- migration does not matter.

alter table public.payment_events
  add column if not exists avs_result_code text,
  add column if not exists cvv_result_code text;

alter table public.payment_events drop constraint if exists payment_events_avs_result_code_check;
alter table public.payment_events
  add constraint payment_events_avs_result_code_check
  check (avs_result_code is null or avs_result_code ~ '^[A-Z0-9]{1,2}$');

alter table public.payment_events drop constraint if exists payment_events_cvv_result_code_check;
alter table public.payment_events
  add constraint payment_events_cvv_result_code_check
  check (cvv_result_code is null or cvv_result_code ~ '^[A-Z0-9]{1,2}$');

-- Backfill charges already recorded, from the stored gateway answer. Only a
-- well-formed code is copied; anything else stays null.
update public.payment_events
set avs_result_code = upper(response_payload -> 'transactionResponse' ->> 'avsResultCode')
where avs_result_code is null
  and upper(coalesce(response_payload -> 'transactionResponse' ->> 'avsResultCode', '')) ~ '^[A-Z0-9]{1,2}$';

update public.payment_events
set cvv_result_code = upper(response_payload -> 'transactionResponse' ->> 'cvvResultCode')
where cvv_result_code is null
  and upper(coalesce(response_payload -> 'transactionResponse' ->> 'cvvResultCode', '')) ~ '^[A-Z0-9]{1,2}$';
