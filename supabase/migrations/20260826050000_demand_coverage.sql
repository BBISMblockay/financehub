-- Unit-based demand coverage. Context for planning, never a gate.
--
-- Deliberately UNIT-based, not dollar-based: qty is recorded on 2,471 of
-- 2,471 PO lines, while unit_cost is present on only ~45% (and just 41% of
-- lines on POs already Sent to Factory -- 148,890 units with no cost). A
-- dollar view would confidently report about half of real commitment,
-- which is the silent-wrong-number failure this codebase keeps designing
-- against. Money can multiply in later wherever cost exists.
--
-- DESIGNED AGAINST A RATCHET. A planner grounded only in history converges
-- on the historical mean: a new category has no sales, so it reads as zero
-- demand and always loses to a restock of a proven seller. That system
-- politely argues its owner out of growth. Three properties keep this one
-- honest:
--
--   1. Nothing is silently dropped. Categories are unioned from all three
--      legs, so one that exists only on POs (a first buy into a new
--      category) still appears -- with null demand, which reads as
--      "unproven", NOT as zero. has_sales_history distinguishes those two.
--   2. Signals are symmetric. weeks_of_cover shows over-commitment;
--      momentum_pct and a null/low cover show under-investment. A view
--      that could only ever argue "buy less" would be a stagnation engine.
--   3. There is no target and no budget here on purpose. Coverage and
--      momentum are useful with nothing to be measured against, and
--      nothing to be measured against is nothing to be locked to. A stated
--      intent, if one is ever wanted, belongs somewhere it can be restated
--      freely -- not baked in here.
--
-- Grain is the PO buying vocabulary (29 categories), because that is what
-- purchasing decisions are actually made in; sales carries a finer 116-type
-- vocabulary. 24 of 29 PO types match sales and 25 of 29 match inventory --
-- the rest surface as rows with missing legs rather than disappearing.
--
-- Built on pre-aggregated sources. Deriving categories from a 365-day scan
-- of sales_by_day measured 6,888 ms -- close enough to the 10s statement
-- timeout that Ask SILO would fail on it under load. Reading
-- sales_monthly_product_type_rollup_mv instead measures 98 ms, a 70x
-- difference, which is the same lesson already written into the schema
-- catalog: prefer the rollup.
--
-- The CURRENT month is excluded from both windows. It is partial by
-- definition, and including it would drag the recent run rate below the
-- 12-month average every time, manufacturing a decline signal on the 25th
-- of every month.

create or replace view public.demand_coverage_by_type_v
with (security_invoker = true) as
with co as (select public.active_company_id() as id),
bounds as (select date_trunc('month', current_date)::date as this_month_start),
sold as (
  select r.product_type,
         sum(r.units) filter (where r.month_start >= (select this_month_start from bounds) - interval '12 months') as units_12m,
         sum(r.units) filter (where r.month_start >= (select this_month_start from bounds) - interval '3 months')  as units_3m
  from public.sales_monthly_product_type_rollup_mv r, co
  where r.company_entity_id = co.id
    and nullif(r.product_type, '') is not null
    and r.month_start < (select this_month_start from bounds)
  group by r.product_type
),
onhand as (
  select i.product_type, sum(i.total_available_quantity) as on_hand
  from public.inventory_on_hand_current_mv i, co
  where i.company_entity_id = co.id and nullif(i.product_type, '') is not null
  group by i.product_type
),
onorder as (
  select pl.product_type_snapshot as product_type,
         sum(pl.qty) filter (where h.status in ('Confirmed','Sent to Factory','In Production','In Transit')) as on_order,
         sum(pl.qty) filter (where h.status = 'Draft') as on_order_draft
  from public.po_lines pl
  join public.po_headers h on h.id = pl.po_header_id, co
  where pl.company_entity_id = co.id and nullif(pl.product_type_snapshot, '') is not null
  group by pl.product_type_snapshot
),
types as (
  select product_type from sold
  union select product_type from onhand
  union select product_type from onorder
)
select
  t.product_type,

  -- which legs actually contributed. has_sales_history is the one that
  -- matters most: false means UNPROVEN, not zero demand.
  (s.product_type is not null) as has_sales_history,
  (oh.product_type is not null) as has_inventory,
  (oo.product_type is not null) as has_purchase_history,

  coalesce(oh.on_hand, 0)::numeric        as units_on_hand,
  coalesce(oo.on_order, 0)::numeric       as units_on_order,
  coalesce(oo.on_order_draft, 0)::numeric as units_on_order_draft,
  (coalesce(oh.on_hand,0) + coalesce(oo.on_order,0))::numeric as units_available_committed,

  s.units_12m,
  s.units_3m,
  round(s.units_12m / 52.0, 1) as units_per_week_12m,
  round(s.units_3m  / 13.0, 1) as units_per_week_3m,

  -- coverage: how long what you hold plus what is inbound would last at the
  -- trailing-year rate. Null when there is no sales history -- "cannot be
  -- computed", never "infinite" and never zero.
  case when s.units_12m > 0
       then round((coalesce(oh.on_hand,0) + coalesce(oo.on_order,0)) / (s.units_12m / 52.0), 1)
  end as weeks_of_cover,

  -- momentum: recent run rate vs the trailing year. This is the growth
  -- signal -- a category accelerating while thinly covered is an argument
  -- to buy MORE, which is the half a history-only planner forgets.
  case when s.units_12m > 0 and s.units_3m is not null
       then round(((s.units_3m / 13.0) / (s.units_12m / 52.0) - 1) * 100, 1)
  end as momentum_pct
from types t
left join sold    s  on s.product_type  = t.product_type
left join onhand  oh on oh.product_type = t.product_type
left join onorder oo on oo.product_type = t.product_type;

revoke all on public.demand_coverage_by_type_v from anon;
grant select on public.demand_coverage_by_type_v to authenticated;

select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog set
  keywords = array['demand','coverage','weeks of cover','on hand','on order','gap','planning','overstock','understock','momentum','buy more','category'],
  description = $d$Unit-based demand coverage per product category -- the fastest way to answer "do we need more of this, and how much is already coming". Per product_type: units_on_hand, units_on_order (Confirmed/Sent to Factory/In Production/In Transit) and units_on_order_draft separately, trailing units_12m/units_3m, per-week run rates, weeks_of_cover, and momentum_pct (recent run rate vs the trailing year). UNITS only -- deliberately no dollars, because unit_cost is missing on ~55% of PO lines while qty is complete.

READ IT SYMMETRICALLY. High weeks_of_cover argues against another buy; low or null cover with positive momentum_pct argues FOR one. Reporting only the first would make this a stagnation engine.

has_sales_history = false means the category is UNPROVEN, NOT that demand is zero: a first buy into a new category has no sales yet by definition, and must never be scored as a failure for that. weeks_of_cover is null in that case -- "cannot be computed", not "infinite" and not zero. The current partial month is excluded from both windows so the recent run rate is not artificially depressed. Grain is the PO buying vocabulary (29 categories); sales uses a finer 116-type vocabulary, so a handful of categories appear with some legs missing rather than being dropped.$d$
where relname = 'demand_coverage_by_type_v';
