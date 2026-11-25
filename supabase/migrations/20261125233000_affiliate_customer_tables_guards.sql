-- 20261125233000: the customer-find tables get the guards every other
-- affiliate table has, and two trigger functions lose their client grants.
--
-- Found by the drift check (verify_v2_schema.sql #212, #352, #357), red since
-- 20261124170000 / 20261121230000 / 20261124000000 merged:
--   * affiliate_customer_scans.program_id, affiliate_customer_social.program_id
--     and affiliate_customer_social.scan_id had no same-company twin, so a
--     definer path could point a row at another company's program or scan.
--   * affiliate_payout_account_mirror() and affiliate_person_email_follows()
--     kept Supabase's default EXECUTE for anon and authenticated.
--
-- The program-scope triggers are deliberately NOT put on the two customer
-- tables. Customers are company-level (20261124210000): program_id there is
-- history only, NULL on new rows, and affiliate_customer_social_reject()
-- authorises company-wide. The guard reads affiliate_visible_program(NULL) as
-- false, so attaching it would refuse "Not them" for a program-scoped manager
-- (review of #1412). The sweep now skips them by name, and the drift check
-- reads them as company-level instead of "missing a guard".
--
-- Production rows were checked before writing this: no cross-company
-- reference exists, so the new foreign keys validate. If one ever did, the
-- whole file rolls back and nothing changes.

select public.attach_affiliate_same_company_twins();

-- The scope sweep, unchanged except for the company-level skip list.
create or replace function public.attach_affiliate_program_scope_triggers()
returns void
language plpgsql
as $fn$
declare
  r record;
begin
  for r in
    select c.relname as tbl
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and (c.relname = 'affiliates' or c.relname like 'affiliate\_%')
       -- Company-level tables whose program_id is history only.
       and c.relname not in ('affiliate_customer_scans', 'affiliate_customer_social')
       and exists (select 1 from pg_attribute a
                    where a.attrelid = c.oid and a.attname = 'program_id' and not a.attisdropped)
     order by 1
  loop
    if not exists (select 1 from pg_trigger
                    where tgrelid = ('public.' || r.tbl)::regclass
                      and tgname = r.tbl || '_program_scope_ins') then
      execute format($q$create trigger %I after insert on public.%I
        referencing new table as new_rows
        for each statement execute function public.affiliate_program_scope_guard()$q$,
        r.tbl || '_program_scope_ins', r.tbl);
    end if;
    if not exists (select 1 from pg_trigger
                    where tgrelid = ('public.' || r.tbl)::regclass
                      and tgname = r.tbl || '_program_scope_upd') then
      execute format($q$create trigger %I after update on public.%I
        referencing old table as old_rows new table as new_rows
        for each statement execute function public.affiliate_program_scope_guard()$q$,
        r.tbl || '_program_scope_upd', r.tbl);
    end if;
    if not exists (select 1 from pg_trigger
                    where tgrelid = ('public.' || r.tbl)::regclass
                      and tgname = r.tbl || '_program_scope_del') then
      execute format($q$create trigger %I after delete on public.%I
        referencing old table as old_rows
        for each statement execute function public.affiliate_program_scope_guard()$q$,
        r.tbl || '_program_scope_del', r.tbl);
    end if;
  end loop;
end $fn$;

revoke all on function public.attach_affiliate_program_scope_triggers() from public, anon, authenticated;

-- apply_all_post_merge.sql re-runs 20261121210000 first, whose older sweep
-- would attach them; take them off again so a re-run ends in the same state.
drop trigger if exists affiliate_customer_scans_program_scope_ins on public.affiliate_customer_scans;
drop trigger if exists affiliate_customer_scans_program_scope_upd on public.affiliate_customer_scans;
drop trigger if exists affiliate_customer_scans_program_scope_del on public.affiliate_customer_scans;
drop trigger if exists affiliate_customer_social_program_scope_ins on public.affiliate_customer_social;
drop trigger if exists affiliate_customer_social_program_scope_upd on public.affiliate_customer_social;
drop trigger if exists affiliate_customer_social_program_scope_del on public.affiliate_customer_social;

-- Trigger functions: a trigger fires regardless of EXECUTE, so nothing that
-- works today needs these grants.
revoke all on function public.affiliate_payout_account_mirror() from public, anon, authenticated;
revoke all on function public.affiliate_person_email_follows() from public, anon, authenticated;
