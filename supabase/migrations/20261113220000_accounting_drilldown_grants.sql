-- 20261113220000 — take the default grants back off the three drill-down views
--
-- 20261113200000 created `accounting_journal_lines_v`,
-- `accounting_journal_sources_v` and `accounting_ledger_v` and granted SELECT
-- to `authenticated`. That grant was not the problem; what it did not do was
-- REVOKE. Supabase's `alter default privileges` hands every new object in
-- `public` the full `arwdDxtm` set to BOTH `anon` and `authenticated`, so the
-- views landed on production readable by `anon` -- which is exactly what
-- `verify_v2_schema.sql`'s own journal_drilldown_view check calls CRITICAL,
-- and what `supabase/CLAUDE.md` says to revoke explicitly from both roles.
-- The rule was already written down; this migration is it being followed.
--
-- The database tests did not catch it because pglite has no such default
-- privileges: a fresh view there starts with no grants at all, so `grant
-- select to authenticated` produced the intended end state and the check
-- passed. The suite now grants the Supabase default to both roles FIRST and
-- then asserts this migration takes it back, so the fixture reproduces
-- production rather than a friendlier version of it.
--
-- Nothing was exposed. All three views are `security_invoker`, so a read runs
-- under the caller's RLS: `anon` has no `active_company_id()` and every
-- underlying table's policy requires a membership, so an anonymous select
-- returned zero rows. This is the grant state being wrong, not data having
-- leaked -- but a privilege nobody needs is not one to leave standing, and
-- the drift check would report it every day until it is gone.
--
-- Shape copied from `accounting_journal_register` (20260912231606), the
-- tightest comparable view: `authenticated=r` and nothing else.
begin;

revoke all on public.accounting_journal_lines_v   from public, anon, authenticated;
revoke all on public.accounting_journal_sources_v from public, anon, authenticated;
revoke all on public.accounting_ledger_v          from public, anon, authenticated;

grant select on public.accounting_journal_lines_v   to authenticated;
grant select on public.accounting_journal_sources_v to authenticated;
grant select on public.accounting_ledger_v          to authenticated;

-- Fail the apply rather than leave a view half-fixed: this is a privilege
-- check, and a silent partial result is the one outcome worth refusing.
do $$
declare v_bad text[];
begin
  select array_agg(c.relname order by c.relname) into v_bad
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('accounting_journal_lines_v', 'accounting_journal_sources_v',
                       'accounting_ledger_v')
     and (has_table_privilege('anon', c.oid, 'SELECT')
          or has_table_privilege('authenticated', c.oid, 'INSERT, UPDATE, DELETE')
          or not has_table_privilege('authenticated', c.oid, 'SELECT'));
  if v_bad is not null then
    raise exception 'drill-down view grants are still wrong: %', array_to_string(v_bad, ', ');
  end if;
end $$;

commit;
