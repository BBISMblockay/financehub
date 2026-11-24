-- Your Customers "Find their social accounts" belongs to the COMPANY, not to a
-- program.
--
-- Blake, 2026-11-24: "I feel like people come before program in n hierarchy
-- of studio" -- then "Yes" to moving the list and the scan results to company
-- level, with a program chosen only at Add to outreach. The customer list was
-- already company-wide (company_customer_profiles); the scan was not: one scan
-- per program, the follower bar on the program, results keyed per program, so
-- the same customer was searched -- and paid for -- again under a second
-- program, and a find disappeared when you switched programs.
--
-- After this migration:
--
-- 1. affiliate_customer_social is keyed (company_entity_id, customer_key). One
--    answer per customer per company, whatever program is open. Existing rows
--    are kept; where a company somehow has the same customer under two
--    programs, ONE row survives: a person's "Not them" first (a human
--    judgement outranks a search), then a find, then the newest check. Nobody
--    is re-searched to rebuild what is already known.
-- 2. program_id on both tables is no longer part of any key and is nullable.
--    New rows carry NULL. Old rows keep the program they were scanned under
--    (history only; nothing reads it). Its foreign key becomes ON DELETE SET
--    NULL: deleting a program must never delete what SILO learned about the
--    company's customers.
-- 3. One running scan per COMPANY (was per program), so two people pressing
--    in two programs join one scan rather than paying twice. Any extra
--    running row is closed as stopped first, or the index could not be built.
-- 4. Reads: the active company only -- the same boundary as the customer list
--    the results sit beside (company_customer_profiles). The program-visibility
--    check is gone because there is no program to check.
-- 5. "Not them" (affiliate_customer_social_reject) is gated on
--    can_manage_affiliate_programs() for the active company, not on one
--    program.
-- 6. The follower bar is company DATA: entities.meta.affiliate_customer_scan_min_followers,
--    750 when unset, read by the affiliate-research function.
--    affiliate_programs.customer_scan_min_followers stays (additive only) and
--    is no longer read.
-- 7. Once, on the apply that drops the per-program key: results judged by the
--    pre-trust code (a chosen profile with no match_basis), and every
--    ambiguous or failed row, are cleared so the next press re-checks them
--    under the current rules. See the comment at the delete.
--
-- Writes stay service-role only (the affiliate-research function, after its
-- caller-token gate). Idempotent: every step checks before it changes.

-- 1 ── One row per customer per company.
with ranked as (
  select id, row_number() over (
    partition by company_entity_id, customer_key
    order by case status when 'rejected' then 0 when 'found' then 1 when 'below' then 2 when 'no_count' then 3
                         when 'ambiguous' then 4 when 'none' then 5 when 'error' then 6 else 7 end,
             checked_at desc nulls last, created_at desc, id
  ) as rn
  from public.affiliate_customer_social
)
delete from public.affiliate_customer_social s using ranked r where s.id = r.id and r.rn > 1;

-- The old per-program unique key, found by its columns rather than by the
-- name Postgres generated, so this works on any database.
do $$
declare c record;
begin
  for c in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.affiliate_customer_social'::regclass and con.contype = 'u'
      and (select array_agg(a.attname::text order by a.attname) from unnest(con.conkey) k join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k)
          = array['company_entity_id', 'customer_key', 'program_id']
  loop
    execute format('alter table public.affiliate_customer_social drop constraint %I', c.conname);
    -- ONE time, on the apply that drops the old key: rows the pre-trust code
    -- judged are cleared so the next press re-checks them. On production the
    -- second pilot press (2026-11-24 05:03Z) started two minutes BEFORE the
    -- trust deploy (05:05Z), so its whole run used the old rules: no team
    -- exclusion, no username search, no model step (all 59 ambiguous rows
    -- left unjudged). Its chosen profiles carry no match_basis, which the
    -- current code always writes; its ambiguous and failed rows are cleared
    -- with them. 'none' and 'pending' rows, a person's 'rejected', and the
    -- scan rows are kept.
    delete from public.affiliate_customer_social
      where (status in ('found', 'below', 'no_count') and match_basis is null)
         or status in ('ambiguous', 'error');
  end loop;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'affiliate_customer_social_company_customer_key') then
    alter table public.affiliate_customer_social add constraint affiliate_customer_social_company_customer_key
      unique (company_entity_id, customer_key);
  end if;
end $$;

-- 2 ── program_id: not a key, nullable, and a deleted program keeps the results.
alter table public.affiliate_customer_social alter column program_id drop not null;
alter table public.affiliate_customer_scans alter column program_id drop not null;

do $$
declare t text; c record;
begin
  foreach t in array array['affiliate_customer_social', 'affiliate_customer_scans'] loop
    for c in
      select con.conname from pg_constraint con
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
      where con.conrelid = format('public.%I', t)::regclass and con.contype = 'f'
        and array_length(con.conkey, 1) = 1 and a.attname = 'program_id'
        and con.confdeltype <> 'n'   -- 'n' = SET NULL already
    loop
      execute format('alter table public.%I drop constraint %I', t, c.conname);
    end loop;
    if not exists (
      select 1 from pg_constraint con join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
      where con.conrelid = format('public.%I', t)::regclass and con.contype = 'f' and a.attname = 'program_id'
    ) then
      execute format('alter table public.%I add constraint %I foreign key (program_id) references public.affiliate_programs(id) on delete set null',
        t, t || '_program_id_fkey');
    end if;
  end loop;
end $$;

comment on column public.affiliate_customer_social.program_id is
  'History only: the program open when an older row was scanned. NULL for rows written since the scan moved to company level (20261124210000). Not a key; nothing reads it.';
comment on column public.affiliate_customer_scans.program_id is
  'History only: the program open when an older scan ran. NULL since the scan moved to company level (20261124210000).';

-- 3 ── One running scan per company.
update public.affiliate_customer_scans s
  set status = 'stopped', finished_at = coalesce(s.finished_at, now()),
      error_message = coalesce(s.error_message, 'Stopped early. More to check.')
  where s.status = 'running'
    and exists (select 1 from public.affiliate_customer_scans n
                where n.company_entity_id = s.company_entity_id and n.status = 'running'
                  and (n.started_at, n.id) > (s.started_at, s.id));
drop index if exists public.affiliate_customer_scans_one_running;
create unique index if not exists affiliate_customer_scans_one_running_company
  on public.affiliate_customer_scans (company_entity_id) where status = 'running';
drop index if exists public.affiliate_customer_scans_program_idx;
create index if not exists affiliate_customer_scans_company_idx
  on public.affiliate_customer_scans (company_entity_id, started_at desc);

drop index if exists public.affiliate_customer_social_queue_idx;
create index if not exists affiliate_customer_social_company_queue_idx
  on public.affiliate_customer_social (company_entity_id, status, created_at);
drop index if exists public.affiliate_customer_social_found_idx;
create index if not exists affiliate_customer_social_company_found_idx
  on public.affiliate_customer_social (company_entity_id, followers desc nulls last)
  where status in ('found', 'below', 'no_count');

-- 4 ── Reads: the active company, like the customer list beside them.
drop policy if exists affiliate_customer_scans_select on public.affiliate_customer_scans;
create policy affiliate_customer_scans_select on public.affiliate_customer_scans
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists affiliate_customer_social_select on public.affiliate_customer_social;
create policy affiliate_customer_social_select on public.affiliate_customer_social
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- 5 ── "Not them", for the company's affiliate managers.
create or replace function public.affiliate_customer_social_reject(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.affiliate_customer_social
                 where id = p_id and company_entity_id = public.active_company_id()) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if not public.can_manage_affiliate_programs() then
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
  'Your Customers "Not them": an affiliate manager marks a social find wrong. The customer is never searched again for this company.';

comment on table public.affiliate_customer_scans is
  'Your Customers "Find their social accounts": one row per press -- its progress, and the one-running-scan-per-company guard. Written only by the affiliate-research function. cost_usd is not readable by browsers.';
comment on table public.affiliate_customer_social is
  'Your Customers "Find their social accounts": one row per customer per company -- the queue, then what one search (and, for ambiguous searches only, a model) found. Followers only as a result''s own text stated them; NULL is not zero. Written only by the affiliate-research function.';
comment on column public.affiliate_programs.customer_scan_min_followers is
  'No longer read (20261124210000): the follower bar is company data, entities.meta.affiliate_customer_scan_min_followers, 750 when unset.';

select public.refresh_chat_schema_catalog();
