-- Vendor name suggestions for the Payment Request form, as company DATA.
--
-- WHY. v2/purchase_request.html carried 195 vendor and ambassador names as a
-- literal JS array, merged into the form's datalist only when
-- entity_key = 'baseballism'. Two problems with that, and only the second is
-- the one that matters:
--
--   1. It is a company-specific fact in shared code, which the project rule
--      forbids: one tenant's convenience list cannot live in a page every
--      tenant loads.
--   2. The gate was never a boundary. A static array ships to EVERY browser
--      that loads the page, whatever company the reader is in, and the repo
--      is public -- so 195 vendor and ambassador names were readable in
--      devtools and on GitHub by anyone. Blake, 2026-11-13: "yes move to
--      baseballism own so can't be found with f12 lol."
--
-- WHAT CHANGES. The names move into this table, read under RLS scoped to the
-- active company, so a browser only ever receives its own company's list and
-- the repo carries none of them. This migration creates the table EMPTY on
-- purpose: seeding it is a data load run against production, deliberately not
-- committed, or the names would simply move from one public file to another.
--
-- Behaviour is unchanged for everyone. The form already learns suggestions
-- from a company's own prior payment requests (fetchPriorVendors, newest
-- 1,000); this table is the same kind of hint for names that have not been
-- used yet, or that have aged out of that window. Nothing here gates a
-- submission, and an empty table or a failed read is not an error -- the
-- datalist simply holds fewer suggestions.
begin;

create table if not exists public.payment_request_vendor_suggestions (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  vendor_name       text not null,
  created_by        uuid default auth.uid(),
  created_at        timestamptz not null default now(),
  constraint payment_request_vendor_suggestions_name
    check (length(btrim(vendor_name)) between 1 and 200),
  constraint payment_request_vendor_suggestions_name_not_blank
    check (vendor_name = btrim(vendor_name))
);

-- One company, one spelling. The name is stored exactly as a person typed it,
-- but uniqueness is judged on the folded form, because "Acme Co" and "acme co"
-- are one entry in a datalist and two rows here would show the same supplier
-- twice. An expression index rather than a plain constraint for that reason;
-- `on conflict` must name the same expression (the seed load does).
create unique index if not exists payment_request_vendor_suggestions_once
  on public.payment_request_vendor_suggestions (company_entity_id, lower(btrim(vendor_name)));

create index if not exists payment_request_vendor_suggestions_company
  on public.payment_request_vendor_suggestions (company_entity_id, vendor_name);

alter table public.payment_request_vendor_suggestions enable row level security;

-- Anyone in the company may READ the list: every employee submits payment
-- requests, and the form's whole purpose is to suggest a name they will type
-- anyway. This is the line that makes the list unreachable from another
-- tenant's devtools, which the static array never was.
drop policy if exists payment_request_vendor_suggestions_select
  on public.payment_request_vendor_suggestions;
create policy payment_request_vendor_suggestions_select
  on public.payment_request_vendor_suggestions
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- Curating the list is an admin act, in the admin's OWN company only.
drop policy if exists payment_request_vendor_suggestions_write
  on public.payment_request_vendor_suggestions;
create policy payment_request_vendor_suggestions_write
  on public.payment_request_vendor_suggestions
  for all to authenticated
  using (company_entity_id = public.active_company_id() and public.is_admin_user())
  with check (company_entity_id = public.active_company_id() and public.is_admin_user());

revoke all on public.payment_request_vendor_suggestions from anon;
grant select, insert, update, delete on public.payment_request_vendor_suggestions to authenticated;

comment on table public.payment_request_vendor_suggestions is
  'Vendor name hints for the Payment Request form''s datalist, per company. Suggestions only: nothing here authorizes, routes or validates a payment request, and the form also suggests names from the company''s own prior requests. Replaces a 195-name array that shipped inside v2/purchase_request.html to every tenant''s browser. Seeded by a production data load, never from the repo. 20261113030000.';

select public.attach_stamp_company_entity_id_triggers();

commit;
