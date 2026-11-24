-- Your Customers "Find their social accounts": finds you can trust.
--
-- Blake, 2026-11-24, on the first pilot ("283 of 500 checked, 9 found"): "How
-- to trust finds I know a few are wrong like the Jenny one is an employee and
-- social found was wrong." Then, on the decision card: "Fix first, then finish
-- 500". A first-and-last-name match is what a namesake also has, so:
--
-- 1. affiliate_customer_social.match_basis -- WHY a profile is believed to be
--    this customer: 'email_handle' (the handle is their own email name),
--    'city' (their city is in the result), or 'name_only' (nothing else). The
--    page shows 'name_only' as a name match to check, never as a likely find.
--    Written by the affiliate-research function (lib/affiliate-customer-scan-
--    core.mjs matchBasis), never by a browser.
--
-- 2. status 'rejected' and affiliate_customer_social_reject(id) -- the "Not
--    them" button. A manager of the program marks a find wrong; the row keeps
--    its place under the per-program unique key, so that customer is never
--    searched (or paid for) again, and the profile is not offered again.
--    SECURITY DEFINER because browsers have no write grant on the table; it
--    checks the active company and can_manage_affiliate_program() itself, and
--    touches only status and checked_at.
--
-- 3. ONE-TIME cleanup of the pilot's results, run only on the apply that adds
--    match_basis (so a re-apply never deletes later scans' rows): every result
--    a profile was chosen for, every ambiguous search and every failed one is
--    removed, because each was judged by the rules this change replaces --
--    no team exclusion, Instagram's /popular/ directory read as a profile, off-
--    platform profiles counted, suffixes searched as surnames, and the model
--    step never ran. Those customers are then re-checked by the next press.
--    'none' (no profile carried the name) and 'pending' rows are kept. The
--    scan rows are kept: they are the record of what was searched.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'affiliate_customer_social' and column_name = 'match_basis'
  ) then
    alter table public.affiliate_customer_social add column match_basis text;
    delete from public.affiliate_customer_social
      where status in ('found', 'below', 'no_count', 'ambiguous', 'error');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'affiliate_customer_social_match_basis_check') then
    alter table public.affiliate_customer_social add constraint affiliate_customer_social_match_basis_check
      check (match_basis is null or match_basis in ('email_handle', 'city', 'name_only'));
  end if;
end $$;

alter table public.affiliate_customer_social drop constraint if exists affiliate_customer_social_status_check;
alter table public.affiliate_customer_social add constraint affiliate_customer_social_status_check
  check (status in ('pending', 'found', 'below', 'no_count', 'ambiguous', 'none', 'error', 'rejected'));

comment on column public.affiliate_customer_social.match_basis is
  'Why the profile is believed to be this customer: email_handle (handle is their email name), city (their city is in the result), name_only (nothing but the name). NULL when no profile was chosen.';

create or replace function public.affiliate_customer_social_reject(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_program uuid;
begin
  select program_id into v_program from public.affiliate_customer_social
    where id = p_id and company_entity_id = public.active_company_id();
  if v_program is null then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if not public.can_manage_affiliate_program(v_program) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.affiliate_customer_social
    set status = 'rejected', checked_at = now()
    where id = p_id and company_entity_id = public.active_company_id()
      and status in ('found', 'below', 'no_count', 'ambiguous');
end $$;

revoke all on function public.affiliate_customer_social_reject(uuid) from public, anon, authenticated;
grant execute on function public.affiliate_customer_social_reject(uuid) to authenticated;
comment on function public.affiliate_customer_social_reject(uuid) is
  'Your Customers "Not them": a program manager marks a social find wrong. The customer is never searched again for that program.';

select public.refresh_chat_schema_catalog();
