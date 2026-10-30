-- Make SILO reports fast through the MCP server and the developer API, and
-- stop parallel calls from timing out on a lock.
--
-- WHAT WAS WRONG (measured on production 2026-10-30, read-only)
--
-- 1. Per-row company checks. Almost every RLS policy reads
--    `company_entity_id = active_company_id()`. Written bare, Postgres calls
--    the function once per row it filters, not once per query. In the app
--    that is a profile lookup and mostly survives: Sales by Channel over 28
--    days took 2.6s. Through MCP, active_company_id() resolves the
--    connection's grant (silo_api_grant(): claims parsed four times, a grant
--    lookup, a membership check), and the same report took 20.4s, past the
--    integration role's 15s limit. The plan showed it plainly: a filter on
--    active_company_id() executed 26,736 times inside the order-lines loop.
--    Written as `(select active_company_id())`, the planner evaluates it ONCE
--    as an InitPlan and reuses the value; the same query took 0.3s.
--
--    That rewrite does not change what any policy means. Every function
--    wrapped here is STABLE (checked live: provolatile = 's'), so within one
--    statement it already returns one value; the subselect only stops
--    Postgres re-computing it. It is the form Supabase's own RLS guidance
--    recommends. Indexes still apply: an InitPlan value is a parameter, and
--    the measured plan still used shopify_orders_co_processed_idx.
--
--    Scope, on purpose: only the policies on the tables SILO's system
--    reports read (resolved through their views), plus the six the
--    work-queue reports read. That is what MCP users hit today. The same
--    rewrite for every other table is a follow-up, before an ad hoc query
--    tool ships. current_user_can_manage_payment_requests() is VOLATILE, so
--    it is left exactly as it is.
--
-- 2. A lock held for a whole report. silo_api_run_report() first records the
--    connection's last use (silo_api_touch_grant(), at most once an hour),
--    then runs the report. The UPDATE's row lock lasts until the transaction
--    ends, i.e. until the report finishes. A second call in parallel tried
--    the same UPDATE, waited on that lock, and failed at authenticator's
--    lock_timeout of 8s. Now the touch takes the lock with SKIP LOCKED: if
--    another call already holds the row it is recording the same use, so
--    this one skips the write instead of waiting. The idle window is 30
--    days and the touch is hourly, so a skipped touch changes nothing.
--
-- 3. The integration role's statement_timeout goes from 15s to 30s. Blake's
--    call: MCP limits can be generous because the caller's own model pays for
--    the tokens, and the only cost is database time. authenticated (the app)
--    keeps its 8s.
--
-- Idempotent: a policy already in subselect form is matched by nothing, the
-- function is create-or-replace, and the role setting is absolute.

-- ---------------------------------------------------------------------------
-- 1. Evaluate the company and role checks once per query, not once per row
-- ---------------------------------------------------------------------------
do $$
declare
  t      text;
  p      record;
  q      text;
  c      text;
  fns    constant text[] := array['active_company_id', 'is_admin_user', 'is_exec_or_owner',
                                  'can_manage_journal_entries', 'current_user_can_manage_comp_requests'];
  f      text;
  tables constant text[] := array[
    -- read by the system reports, directly or through their views
    'search_console_query_daily', 'search_console_page_daily', 'search_console_site_daily',
    'shopify_order_lines', 'shopify_orders', 'shopify_channel_map', 'sales_by_day',
    'inventory_on_hand', 'products_master', 'locations', 'factories',
    'meta_ad_performance_daily', 'meta_ad_creatives', 'marketing_kpis_daily',
    'redo_marketing_daily', 'redo_marketing_messages',
    'po_headers', 'po_lines', 'incoming_shipments', 'shipment_bookings',
    -- read by the work-queue reports (20261030060000)
    'launch_tasks', 'launch_calendar', 'launch_channel_items', 'payment_requests',
    'card_transactions', 'card_import_batches', 'journal_adjustments'];
begin
  -- pg_get_expr prints names relative to the search path; pin it so the
  -- printed text, the patterns below and the re-parsed policy all agree.
  perform set_config('search_path', 'public', true);

  foreach t in array tables loop
    if to_regclass('public.' || t) is null then
      continue;   -- not every install has every source table
    end if;
    for p in
      select pol.polname,
             pg_get_expr(pol.polqual, pol.polrelid)      as qual,
             pg_get_expr(pol.polwithcheck, pol.polrelid) as wcheck
        from pg_policy pol
       where pol.polrelid = ('public.' || t)::regclass
    loop
      q := p.qual;
      c := p.wcheck;
      -- A bare call is one not already inside "( SELECT f() AS f)" and not
      -- the tail of a longer name or a qualified call.
      foreach f in array fns loop
        q := regexp_replace(q, '(?<!SELECT )(?<![A-Za-z0-9_.])' || f || '\(\)', '(SELECT ' || f || '())', 'g');
        c := regexp_replace(c, '(?<!SELECT )(?<![A-Za-z0-9_.])' || f || '\(\)', '(SELECT ' || f || '())', 'g');
      end loop;
      q := regexp_replace(q, '(?<!SELECT )(?<![A-Za-z0-9_])auth\.uid\(\)', '(SELECT auth.uid())', 'g');
      c := regexp_replace(c, '(?<!SELECT )(?<![A-Za-z0-9_])auth\.uid\(\)', '(SELECT auth.uid())', 'g');

      if q is distinct from p.qual then
        execute format('alter policy %I on public.%I using (%s)', p.polname, t, q);
      end if;
      if c is distinct from p.wcheck then
        execute format('alter policy %I on public.%I with check (%s)', p.polname, t, c);
      end if;
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Recording a connection's use never waits on another call
-- ---------------------------------------------------------------------------
-- Same row, same hourly floor, same columns as 20261028070000. The only
-- change is SKIP LOCKED: the grant row is locked only by another request on
-- this same connection doing this same write, so skipping it loses nothing.
create or replace function public.silo_api_touch_grant()
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.silo_api_grants g
     set last_used_at = now(),
         updated_at = now()
   where g.id = (select x.id
                   from public.silo_api_grants x
                  where x.id = (select id from public.silo_api_grant())
                    and (x.last_used_at is null or x.last_used_at < now() - interval '1 hour')
                  for update skip locked);
$$;

comment on function public.silo_api_touch_grant() is
  'Records that this request''s connection was used, which is what the idle window measures. Writes at most one row -- the grant silo_api_grant() already resolved to, so an unusable grant cannot touch itself back into use -- at most once an hour per grant, and with SKIP LOCKED, so a parallel request on the same connection never waits on the row lock (20261030070000; was a plain UPDATE that waited until the other request''s whole report finished). Called by silo_api_run_report(). 20261028070000.';

revoke all on function public.silo_api_touch_grant() from public, anon, authenticated, silo_integration, silo_revoked;
grant execute on function public.silo_api_touch_grant() to silo_api_exec;

-- ---------------------------------------------------------------------------
-- 3. More room for a report run through MCP or the API
-- ---------------------------------------------------------------------------
alter role silo_integration set statement_timeout = '30s';
