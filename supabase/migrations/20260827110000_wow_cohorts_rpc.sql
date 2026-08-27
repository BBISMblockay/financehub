-- Cohort retention for the WoW report, computed from shopify_orders.
--
-- ShopifyQL has no cohort dataset (its `customers` table exposes no cohort
-- columns), so this is derived from first-order dates instead.
--
-- The hard part is not the arithmetic. shopify_orders history is currently
-- PARTIAL, and partial order data does not make cohorts slightly wrong -- it
-- makes them confidently wrong in ONE direction: a repeat purchase landing in
-- an unsynced month is indistinguishable from a customer who never came back,
-- so retention reads LOW and looks like a real finding rather than a gap.
--
-- Measured 2026-08-27: only 2026-06, 2026-07 and 2026-08 had complete daily
-- coverage. 2025-11 had 10 of 30 days, 2025-12 five of 31. A naive query over
-- that returned 0.0% month-1 retention on a 7,347-customer cohort.
--
-- SCOPE: online only. The report states "POS, wholesale and draft orders are
-- excluded", and cohorts must measure the same population as everything else
-- on the page. The first version of this cohorted all 14 shops including
-- 55,645 POS orders across 12 retail stores, which understated online
-- retention by ~44% (June 2026 read 7.7% month-1 against a true 11.1%)
-- because retail-first customers rarely repeat online and diluted the rate.
-- It would also have broken under a backfill scoped to the online connection:
-- history online-only, recent months all-channel, so a retail-first customer
-- reads as brand new when they later buy online.
--
-- So every cell is gated on coverage of BOTH months involved -- the cohort's
-- own month and the month being measured. Anything not fully covered returns
-- null with the reason, never a number. As shopify-orders-backfill.yml fills
-- the gaps, cells turn from null into real values with no code change.
create or replace function public.wow_cohorts(p_months int default 12)
returns jsonb
language sql
stable
as $$
with bounds as (
  select date_trunc('month', current_date)::date as this_month,
         (date_trunc('month', current_date) - make_interval(months => greatest(coalesce(p_months,12),1)))::date as from_month
),
-- One definition of "online", used by coverage and cohorts alike so they can
-- never drift apart.
o_all as (
  select o.customer_id, o.shopify_created_at
  from public.shopify_orders o
  where o.company_entity_id = public.active_company_id()
    and coalesce(o.source_name,'') not in ('pos', 'faire', 'shopify_draft_order')
),
months as (
  select generate_series((select from_month from bounds), (select this_month from bounds), interval '1 month')::date as mon
),
cov as (
  select m.mon,
         count(distinct o.shopify_created_at::date) as days_present,
         -- The current month is only expected to have days up to today.
         case when m.mon = (select this_month from bounds)
              then extract(day from current_date)::int
              else extract(day from (m.mon + interval '1 month - 1 day'))::int end as days_expected
  from months m
  left join o_all o on date_trunc('month', o.shopify_created_at)::date = m.mon
  group by m.mon
),
covered as (
  -- One missing day is tolerated (a genuine zero-order day is possible);
  -- more than that and the month is not trustworthy for this purpose.
  select mon, days_present, days_expected,
         (days_present >= days_expected - 1) as ok
  from cov
),
firsts as (
  select customer_id, date_trunc('month', min(shopify_created_at))::date as cohort
  from o_all where customer_id is not null group by 1
),
acts as (
  select f.cohort, o.customer_id,
         ((extract(year from age(date_trunc('month', o.shopify_created_at), f.cohort)) * 12)
          + extract(month from age(date_trunc('month', o.shopify_created_at), f.cohort)))::int as m_off
  from o_all o join firsts f on f.customer_id = o.customer_id
  where o.customer_id is not null
),
sized as (
  select a.cohort, count(distinct a.customer_id) filter (where a.m_off = 0) as size,
         count(distinct a.customer_id) filter (where a.m_off = 1) as m1,
         count(distinct a.customer_id) filter (where a.m_off = 2) as m2,
         count(distinct a.customer_id) filter (where a.m_off = 3) as m3,
         count(distinct a.customer_id) filter (where a.m_off >= 4) as m4
  from acts a group by a.cohort
),
-- A retention cell is only reportable when the cohort month AND the measured
-- month are both fully covered.
rate as (
  select s.cohort, s.size,
         (select ok from covered where mon = s.cohort) as cohort_ok,
         case when (select ok from covered where mon = s.cohort)
               and (select ok from covered where mon = s.cohort + interval '1 month')
              then round(100.0 * s.m1 / nullif(s.size,0), 1) end as m1,
         case when (select ok from covered where mon = s.cohort)
               and (select ok from covered where mon = s.cohort + interval '2 months')
              then round(100.0 * s.m2 / nullif(s.size,0), 1) end as m2,
         case when (select ok from covered where mon = s.cohort)
               and (select ok from covered where mon = s.cohort + interval '3 months')
              then round(100.0 * s.m3 / nullif(s.size,0), 1) end as m3,
         case when (select ok from covered where mon = s.cohort)
               and not exists (select 1 from covered where mon > s.cohort + interval '3 months' and not ok)
              then round(100.0 * s.m4 / nullif(s.size,0), 1) end as m4
  from sized s
  where s.cohort >= (select from_month from bounds)
)
select jsonb_build_object(
  'scope', 'online',
  'months_requested', greatest(coalesce(p_months,12),1),
  'months_complete', (select count(*) from covered where ok),
  'months_total', (select count(*) from covered),
  'incomplete_months', (select coalesce(jsonb_agg(to_char(mon,'YYYY-MM') order by mon),'[]'::jsonb)
                        from covered where not ok),
  'rows', (select coalesce(jsonb_agg(jsonb_build_object(
              'cohort_month', to_char(r.cohort,'YYYY-MM'),
              'size', r.size,
              'cohort_complete', coalesce(r.cohort_ok,false),
              'm1', r.m1, 'm2', r.m2, 'm3', r.m3, 'm4plus', r.m4
            ) order by r.cohort desc),'[]'::jsonb) from rate r where coalesce(r.cohort_ok,false))
);
$$;

grant execute on function public.wow_cohorts(int) to authenticated;
