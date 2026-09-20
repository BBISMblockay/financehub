-- =============================================================================
-- Make the stamp helper genuinely idempotent, and make check 6 able to fail.
--
-- Both findings are the independent review's on PR #736, and both were right.
-- They matter more together than apart: 20260920140000 put this helper into
-- CLAUDE.md's "Adding a new DB table" checklist, which turns a once-a-quarter
-- repair into a step on every future migration. A cost that was acceptable as
-- a one-off is not acceptable as a routine.
--
-- ── 1. The helper was not a no-op ───────────────────────────────────────────
--
-- It looped every eligible table and ran DROP TRIGGER IF EXISTS + CREATE
-- TRIGGER unconditionally -- 164 tables on production today. Each pair takes
-- an ACCESS EXCLUSIVE lock, and inside a migration transaction those locks are
-- held until COMMIT, not released per statement. So a future migration that
-- adds ONE table and follows the checklist would: take and hold exclusive
-- locks on 164 operational tables, then block on the first one whose long
-- transaction has not finished -- with every previously locked table's writers
-- queued behind it for the duration. 20260920140000's own comment called
-- re-running it "cost-free", which was wrong; running it off-hours reduced the
-- exposure of that one run and did nothing about the pattern.
--
-- It now enumerates only tables whose trigger is MISSING or WRONGLY BOUND, so
-- a re-run with nothing to do takes no DDL locks at all. "Wrongly bound" is
-- checked rather than assumed: right name, right function, BEFORE (tgtype bit
-- 1), INSERT (bit 4), FOR EACH ROW (bit 0), enabled. A trigger carrying the
-- right NAME and the wrong body is the failure a name-only check would wave
-- through, and it is the one worth catching -- so such a trigger is dropped
-- and recreated, which is the only case where this still issues a DROP.
--
-- Exclusions are UNCHANGED (inventory_on_hand, sales_by_day). Narrowing what
-- the helper covers is a policy decision about the plaid_* tables and
-- finance_audit_events, and it is not this migration's to make -- see below.
--
-- ── 2. Check 6 could read 'ok' with five required tables missing ────────────
--
-- It compared a COUNT of triggers against a COUNT of required tables. The
-- denominator excludes seven tables; the numerator counted triggers on ALL of
-- them. Five of those seven -- the four plaid_* and finance_audit_events --
-- do carry the trigger, so the numerator ran five ahead of the denominator
-- permanently.
--
-- MEASURED on production 2026-09-20: numerator 169, denominator 164, slack 5,
-- and the five surplus rows are exactly those five tables. So one through five
-- required tables could lose their trigger and check 6 would still read 'ok'.
-- That is not hypothetical -- it is why 20260919140000's six missing tables
-- were caught at all: six exceeded the slack by one. Five would have been
-- invisible, and a check that only fires past a threshold of six is worse than
-- no check, because it is credited as coverage.
--
-- The verifier's replacement is an anti-join that NAMES the tables it cannot
-- find a trigger for, in supabase/verify_v2_schema.sql. It keeps its own
-- seven-table exclusion set rather than adopting the helper's two: the two
-- sets disagree on purpose and the disagreement is benign in one direction
-- only -- verify does not REQUIRE a trigger on the five finance tables, while
-- the helper still maintains one if it goes missing. Unifying them would
-- either stop maintaining those triggers or start requiring them, and both are
-- decisions about service-owned finance records that belong in their own
-- change with their own reasoning.
-- =============================================================================

create or replace function public.attach_stamp_company_entity_id_triggers()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_attached int := 0;
  v_repaired int := 0;
begin
  for r in
    select c.table_name,
           -- A trigger that exists under the right name but is bound to
           -- something else has to go before the correct one can be created.
           exists (
             select 1
               from pg_trigger t
               join pg_class cl on cl.oid = t.tgrelid
               join pg_namespace n on n.oid = cl.relnamespace
              where n.nspname = 'public'
                and cl.relname = c.table_name
                and t.tgname = 'stamp_company_entity_id'
                and not t.tgisinternal
           ) as name_taken
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public'
       and c.column_name = 'company_entity_id'
       and t.table_type = 'BASE TABLE'
       and c.table_name not in ('inventory_on_hand', 'sales_by_day')
       -- The whole point: skip anything already bound CORRECTLY, so a re-run
       -- with nothing to do takes no locks.
       and not exists (
         select 1
           from pg_trigger tg
           join pg_class cl on cl.oid = tg.tgrelid
           join pg_namespace n on n.oid = cl.relnamespace
          where n.nspname = 'public'
            and cl.relname = c.table_name
            and tg.tgname = 'stamp_company_entity_id'
            and not tg.tgisinternal
            and tg.tgfoid = 'public.stamp_company_entity_id()'::regprocedure
            and tg.tgenabled <> 'D'
            and (tg.tgtype & 1) = 1    -- FOR EACH ROW
            and (tg.tgtype & 2) = 2    -- BEFORE
            and (tg.tgtype & 4) = 4    -- INSERT
       )
  loop
    if r.name_taken then
      execute format('drop trigger stamp_company_entity_id on public.%I', r.table_name);
      v_repaired := v_repaired + 1;
    else
      v_attached := v_attached + 1;
    end if;
    execute format(
      'create trigger stamp_company_entity_id
         before insert on public.%I
         for each row
         execute function public.stamp_company_entity_id()',
      r.table_name);
  end loop;

  -- A notice rather than a return value: the signature is called from
  -- migrations and from verify's own remediation line, and changing it would
  -- break both for the sake of a number nobody reads programmatically.
  raise notice 'stamp_company_entity_id: % attached, % repaired', v_attached, v_repaired;
end;
$$;

comment on function public.attach_stamp_company_entity_id_triggers() is
  'Attach the company stamp trigger to every company-scoped table that lacks a CORRECTLY BOUND one (right function, BEFORE INSERT, FOR EACH ROW, enabled). Skips tables already correct, so a re-run with nothing to do takes no ACCESS EXCLUSIVE locks -- which is what makes it safe as a routine step in every new-table migration. Excludes inventory_on_hand and sales_by_day.';

-- Safe to run here: after 20260920140000 every eligible table is already
-- correct, so this call now does nothing and proves it.
select public.attach_stamp_company_entity_id_triggers();
