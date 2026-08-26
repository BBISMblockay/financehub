-- The written half of the Week over Week report.
--
-- wow_report() returns everything SILO can measure. This holds everything it
-- cannot: the four genuinely manual sections (Competition, Kimonix,
-- Affiliate, Redo messaging) plus per-section commentary -- which is the
-- actual output of the weekly meeting. Without it the page is a dashboard
-- someone reads, not a report they produce.
--
-- One row per company per report date, so last week's report still exists and
-- this week's survives a reload.
--
-- sections is jsonb rather than a column per field on purpose: the report's
-- shape is still settling and adding "one more box" should not need a
-- migration. Shape is { commentary: {...}, manual: {...} }.
--
-- Measured figures are deliberately NOT stored. They re-query live from
-- wow_report(), so nobody can save a stale number over a real one and
-- reopening an old report shows what the data says today.

create table if not exists public.wow_report_entries (
  id                 uuid primary key default gen_random_uuid(),
  company_entity_id  uuid not null default active_company_id(),
  report_date        date not null,
  sections           jsonb not null default '{}'::jsonb,
  created_by         uuid default auth.uid(),
  updated_by         uuid default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (company_entity_id, report_date)
);

create index if not exists wow_report_entries_co_date_idx
  on public.wow_report_entries (company_entity_id, report_date desc);

alter table public.wow_report_entries enable row level security;

-- Same stance as the mailroom: no narrower role gate. Anyone who can see the
-- company's data can write the week's commentary; the report is a shared
-- artefact, not a restricted one.
drop policy if exists wow_report_entries_active_select on public.wow_report_entries;
create policy wow_report_entries_active_select
  on public.wow_report_entries for select
  using (company_entity_id = active_company_id());

drop policy if exists wow_report_entries_active_insert on public.wow_report_entries;
create policy wow_report_entries_active_insert
  on public.wow_report_entries for insert
  with check (company_entity_id = active_company_id());

drop policy if exists wow_report_entries_active_update on public.wow_report_entries;
create policy wow_report_entries_active_update
  on public.wow_report_entries for update
  using (company_entity_id = active_company_id())
  with check (company_entity_id = active_company_id());

create or replace function public.touch_wow_report_entry()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;

drop trigger if exists trg_touch_wow_report_entry on public.wow_report_entries;
create trigger trg_touch_wow_report_entry
  before update on public.wow_report_entries
  for each row execute function public.touch_wow_report_entry();

comment on table public.wow_report_entries is
  'The written half of the Week over Week report: the manual sections SILO has no source for (Competition, Kimonix, Affiliate, Redo messaging, landing pages, Meta organic) plus per-section commentary. One row per company per report_date. Measured figures are NOT stored here -- they re-query live from wow_report(), so an old report always shows what the data says today rather than a stale snapshot. sections is jsonb so adding a field needs no migration; shape is { commentary: {...}, manual: {...} }.';
