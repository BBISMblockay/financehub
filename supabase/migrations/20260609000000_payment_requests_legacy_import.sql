-- Legacy Jotform / WPV Portal payment request import support.
-- Safe to re-run.

alter table public.payment_requests
  add column if not exists legacy_source text,
  add column if not exists legacy_url text,
  add column if not exists legacy_external_id text,
  add column if not exists imported_at timestamptz;

comment on column public.payment_requests.legacy_source is
  'Origin system for imported rows (e.g. jotform_wpv_export).';
comment on column public.payment_requests.legacy_url is
  'Link to the original Jotform edit/grid page or WPV portal submission.';
comment on column public.payment_requests.legacy_external_id is
  'Stable dedupe key: Jotform submission id when present, else import hash.';
comment on column public.payment_requests.imported_at is
  'When this row was imported from a legacy export.';

create unique index if not exists payment_requests_legacy_dedupe_uidx
  on public.payment_requests (legacy_source, legacy_external_id)
  where legacy_source is not null
    and legacy_external_id is not null
    and btrim(legacy_external_id) <> '';
