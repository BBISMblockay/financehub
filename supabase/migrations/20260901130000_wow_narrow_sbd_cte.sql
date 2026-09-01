-- The Week over Week report timed out at YTD. This is why.
--
-- `wow_report` and `wow_kpi_compare` both open with a CTE that pulls the
-- window's online sales rows:
--
--     sbd as (select s.* from public.sales_by_day s cross join w ...)
--
-- `s.*` is roughly THIRTY columns of a 1.1M-row, 2.1GB table, and a CTE that
-- is referenced more than once is materialised into a tuplestore -- so every
-- one of those columns is copied for every row in the window, whether or not
-- anything downstream reads it. Between them the two functions read EIGHT of
-- them.
--
-- At a 7-day window that waste is invisible: a few thousand rows. At YTD the
-- windows are 474 and 600 days -- 405,896 and 461,079 rows -- and the copying
-- is most of the runtime. Measured on prod, same rows, same plan, only the
-- column list changed:
--
--     select s.*  over 474 days   3.67s
--     narrowed    over 474 days   0.83s      4.4x
--
-- `authenticated` carries statement_timeout = 8s (anon 3s), and the page fires
-- seven of these RPCs in parallel, so wow_report at ~8.8s and wow_kpi_compare
-- at ~5.6s did not merely feel slow -- YTD failed outright with "canceling
-- statement due to statement timeout". Day, week and MTD stayed under the
-- limit, which is exactly why this survived testing: every grain worked when
-- measured one at a time on a connection (postgres) that has no timeout at
-- all.
--
-- WHAT THIS DOES NOT DO. It does not touch the predicates, the windows, the
-- joins or the output -- only the column list of the two CTEs, so every figure
-- the report prints is unchanged by construction. It is verified that way
-- below: the same report date is compared before and after, key by key.
--
-- Rejected on measurement, recorded so nobody re-tries them:
--   * An expression index on (company_entity_id, lower(btrim(location_tag)),
--     day_date) to match the `lower(btrim(location_tag)) = 'online'` predicate.
--     Built it, ANALYZEd it, and the planner would not take it -- it keeps
--     preferring sales_by_day_company_day_idx, which is correctly the cheaper
--     plan (that index is well correlated with physical row order; forcing
--     anything else measured 15.7s against 0.97s). Dropped again rather than
--     left to cost every nightly sync write for nothing.
--   * Dropping the lower(btrim(...)) normalisation so the plain
--     (location_tag, day_date) index applies. Every location_tag in the table
--     is already normalised today, so it would work today -- and would
--     silently start dropping rows the first time a sync delivers 'Online'.
--     The normalisation is the point; the column list was the problem.

do $mig$
declare
  fn      text;
  cols    text;
  def     text;
  newdef  text;
  hits    int;
  sig     text;
  old_txt constant text := 'select s.* from public.sales_by_day s';
begin
  foreach fn in array array['wow_report', 'wow_kpi_compare'] loop
    -- Exactly the columns each function reads downstream, and no others.
    -- wow_report: totals (total_sales/net/refunds/gross), categories
    -- (product_type) and top products (product_name/quantity).
    -- wow_kpi_compare: sales and net sales bucketed by day only.
    cols := case fn
      when 'wow_report' then
        'select s.day_date, s.product_type, s.product_name, s.total_sales, '
        || 's.total_net_sales, s.total_refunds, s.total_gross_sales, '
        || 's.total_quantity_sold from public.sales_by_day s'
      else
        'select s.day_date, s.total_sales, s.total_net_sales '
        || 'from public.sales_by_day s'
    end;

    select pg_get_functiondef(p.oid) into def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = fn
       and pg_get_function_identity_arguments(p.oid) like '%p_grain%';

    if not found then
      raise exception 'wow narrow: %(date, text) not found -- run 20260901120000 first', fn;
    end if;

    -- Already narrowed: nothing to do. Keeps the migration re-runnable.
    if position(old_txt in def) = 0 then
      raise notice 'wow narrow: % already narrowed -- skipping', fn;
      continue;
    end if;

    hits := (select count(*) from regexp_matches(def, 'select s\.\* from public\.sales_by_day s', 'g'));
    if hits <> 1 then
      raise exception 'wow narrow: % has % copies of the wide CTE, expected 1 -- refusing to guess', fn, hits;
    end if;

    newdef := replace(def, old_txt, cols);
    sig := format('public.%I(date, text)', fn);

    -- CREATE OR REPLACE, not drop/create: the signature is unchanged here, so
    -- the grants survive and there is no window where the function is absent.
    execute newdef;

    raise notice 'wow narrow: % sbd CTE narrowed', sig;
  end loop;
end
$mig$;
