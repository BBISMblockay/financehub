-- The customer lookup's history pass carries its index's predicate.
-- Found reviewing #1355 (20261123210000), the past-customer badge.
--
-- `refresh_company_customer_profiles()` (20261123210000) filters its
-- per-customer history pass by company and by the indexed key expression,
-- but omits the predicate of the partial index that carries that
-- expression (`where customer_email is not null or customer_id is not
-- null`). PostgreSQL cannot prove a partial index applies from a matching
-- key alone, so on a big store each customer lookup can fall back to a
-- scan of the company's orders -- the 8s statement timeout every caller
-- shares, for a step that is meant to be index-driven. The predicate is
-- also a no-op on the rows themselves: a row with neither column is not in
-- `touched`, because the key expression it is matched against is built
-- from the same two columns.
--
-- `create or replace` on one existing function: no table, policy or grant
-- changes, and re-running the file changes nothing. The other two fixes from
-- the same review are 20261124000000.

begin;

-- The customer history pass carries its index's predicate

create or replace function public.refresh_company_customer_profiles(
  p_company uuid,
  p_since   timestamptz,
  p_until   timestamptz default null,
  p_recent_months integer default 24
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_until  timestamptz := coalesce(p_until, now() + interval '1 day');
  v_recent timestamptz := now() - make_interval(months => greatest(coalesce(p_recent_months, 24), 1));
  v_rows   integer := 0;
  v_total  integer := 0;
begin
  if p_company is null or p_since is null then
    raise exception 'refresh_company_customer_profiles: company and since are required';
  end if;

  with touched as (
    select distinct coalesce(nullif(lower(btrim(o.customer_email)), ''), 'cid:' || o.customer_id) as customer_key
      from public.shopify_orders o
     where o.company_entity_id = p_company
       and o.shopify_created_at >= p_since
       and o.shopify_created_at <  v_until
       and o.cancelled_at is null
       and (o.customer_email is not null or o.customer_id is not null)
  ),
  -- One index-driven pass per customer the window touched, NOT one aggregate
  -- over the company's whole order history: see the measurement in the header.
  -- The key expression here is the one shopify_orders_co_customer_key_idx
  -- carries; they must stay identical, AND so must the index's PREDICATE --
  -- without it in the query the planner cannot prove the partial index covers
  -- these rows and falls back to scanning the company's orders, once per
  -- customer (20261124000000). It excludes no row that `touched` can produce:
  -- the key it matches is built from the same two columns.
  agg as (
    select t.customer_key, a.customer_id, a.email_lc, a.customer_name,
           a.order_count, a.orders_recent, a.first_order_at, a.last_order_at, a.lifetime_spend
      from touched t
      cross join lateral (
        select (array_agg(nullif(btrim(o.customer_id), '') order by o.shopify_created_at desc nulls last))[1] as customer_id,
               (array_agg(nullif(lower(btrim(o.customer_email)), '') order by o.shopify_created_at desc nulls last))[1] as email_lc,
               (array_agg(nullif(btrim(o.customer_name), '') order by o.shopify_created_at desc nulls last))[1] as customer_name,
               count(*)::int as order_count,
               count(*) filter (where o.shopify_created_at >= v_recent)::int as orders_recent,
               min(o.shopify_created_at) as first_order_at,
               max(o.shopify_created_at) as last_order_at,
               coalesce(sum(o.total_price), 0) as lifetime_spend
          from public.shopify_orders o
         where o.company_entity_id = p_company
           and (o.customer_email is not null or o.customer_id is not null)
           and o.cancelled_at is null
           and coalesce(nullif(lower(btrim(o.customer_email)), ''), 'cid:' || o.customer_id) = t.customer_key
      ) a
     where a.order_count > 0
  )
  insert into public.company_customer_profiles as t (
    company_entity_id, customer_key, customer_id, email_lc,
    name_lc, first_name_lc, last_name_lc,
    order_count, orders_recent, first_order_at, last_order_at, lifetime_spend, source, updated_at
  )
  select p_company, a.customer_key, a.customer_id, a.email_lc,
         public.silo_name_key(a.customer_name),
         nullif(split_part(public.silo_name_key(a.customer_name), ' ', 1), ''),
         nullif(regexp_replace(coalesce(public.silo_name_key(a.customer_name), ''), '^.* ', ''), ''),
         a.order_count, a.orders_recent, a.first_order_at, a.last_order_at, a.lifetime_spend,
         'shopify', now()
    from agg a
  on conflict (company_entity_id, customer_key) do update
    set customer_id    = coalesce(excluded.customer_id, t.customer_id),
        email_lc       = coalesce(excluded.email_lc, t.email_lc),
        name_lc        = coalesce(excluded.name_lc, t.name_lc),
        first_name_lc  = coalesce(excluded.first_name_lc, t.first_name_lc),
        last_name_lc   = coalesce(excluded.last_name_lc, t.last_name_lc),
        order_count    = excluded.order_count,
        orders_recent  = excluded.orders_recent,
        first_order_at = excluded.first_order_at,
        last_order_at  = excluded.last_order_at,
        lifetime_spend = excluded.lifetime_spend,
        updated_at     = now();
  get diagnostics v_rows = row_count;

  select count(*)::int into v_total
    from public.company_customer_profiles where company_entity_id = p_company;

  -- covered_from only ever moves BACKWARD (least), and the caller only ever
  -- asks for a window that abuts what is already covered -- newest half
  -- first when a window is split, so a half that fails leaves the frontier at
  -- the edge of what really landed (scripts/lib/affiliate-commissions-core.mjs,
  -- 20261124000000).
  insert into public.company_customer_profile_state (company_entity_id, covered_from, last_refreshed_at, customers)
  values (p_company, p_since, now(), v_total)
  on conflict (company_entity_id) do update
    set covered_from      = least(coalesce(company_customer_profile_state.covered_from, excluded.covered_from), excluded.covered_from),
        last_refreshed_at = now(),
        customers         = excluded.customers;

  return jsonb_build_object(
    'company_entity_id', p_company,
    'since', p_since, 'until', v_until,
    'customers_written', v_rows,
    'customers_total', v_total
  );
end $$;

revoke all on function public.refresh_company_customer_profiles(uuid, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.refresh_company_customer_profiles(uuid, timestamptz, timestamptz, integer) to service_role;

commit;
