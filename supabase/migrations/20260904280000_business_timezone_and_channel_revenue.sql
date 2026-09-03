-- Two accuracy fixes found by checking the Ownership board rather than
-- trusting it, plus the helper that makes the first one hard to repeat.

-- ── 1. current_date is UTC. The business is Pacific. ────────────────
-- From 17:00 Pacific (00:00 UTC) onward the two disagree, so
-- `current_date - 1` stops meaning yesterday and starts meaning TODAY --
-- a day that is still being sold. Measured at 2026-09-03 00:06 UTC,
-- which is 2026-09-02 17:06 Pacific:
--
--   current_date                                -> 2026-09-03
--   current_date - 1                            -> 2026-09-02  (today, partial)
--   (now() at 'America/Los_Angeles')::date - 1  -> 2026-09-01  (correct)
--
-- So for the last seven hours of every working day the board would have
-- headlined a half-finished day as "yesterday" and shown a collapse --
-- exactly when someone checks the numbers before going home. It also
-- explains a $10,220 reconciliation gap between the sales rollup and the
-- base table: the UTC window reached into a day the matview had not
-- covered yet. With the Pacific anchor the two agree to the cent
-- (22,851,113.56 both sides).
--
-- The rest of SILO already knew this. refresh_sales_verification_store_comp_summary
-- anchors its comps to `(now() at time zone 'America/Los_Angeles')::date`,
-- and shopify-sync.yml must not run before 08:00 UTC because that is before
-- Pacific midnight. This puts the rule in one callable place instead of a
-- timezone literal copied into a dozen reports.
--
-- Pacific is hardcoded and that is a known limit: a tenant in another
-- timezone needs this to read from their company record. Baseballism is
-- Pacific, and a wrong-timezone answer is worse than a hardcoded right one.
create or replace function public.silo_business_today()
returns date language sql stable
as $$ select (now() at time zone 'America/Los_Angeles')::date $$;

create or replace function public.silo_business_yesterday()
returns date language sql stable
as $$ select (now() at time zone 'America/Los_Angeles')::date - 1 $$;

comment on function public.silo_business_today() is
  'Today in the business timezone (Pacific), not UTC. current_date is UTC and runs a day ahead from 17:00 Pacific, which would make a dashboard call a partial day "yesterday" every evening.';
comment on function public.silo_business_yesterday() is
  'The last COMPLETE selling day in the business timezone (Pacific). Use this, never current_date - 1, as the anchor for any period a person reads as "yesterday".';

grant execute on function public.silo_business_today() to authenticated;
grant execute on function public.silo_business_yesterday() to authenticated;

-- Repoint every seeded Ownership and Logistics report onto the helpers.
update public.silo_chat_saved_reports
   set queries_run = array[
         replace(
           replace(queries_run[1], 'current_date - 1', 'silo_business_yesterday()'),
           'current_date', 'silo_business_today()')
       ]
 where source = 'system'
   and (title like 'Ownership%' or title like 'Logistics%')
   and queries_run[1] like '%current_date%';

-- ── 2. Two revenue definitions on one board ─────────────────────────
-- The channel tile summed shopify_orders.total_price, which INCLUDES tax
-- and shipping: $2,248,031 over 28 days against the board's own
-- $1,948,215 of net sales, sitting one tile apart and never tying
-- ($115,439 tax + $109,778 shipping). That is precisely the failure
-- CLAUDE.md records for the three Marketing pages, repeated on a new board.
--
-- subtotal_price is merchandise only and is already net of discounts. It
-- lands within ~4% of net sales, the remainder being refunds -- which are
-- separate transactions in shopify_orders and so cannot be netted here.
-- Named merch_revenue rather than revenue so nobody expects it to tie.
update public.silo_chat_saved_reports set
  description = 'Orders and merchandise revenue by Shopify sales channel. Merchandise revenue is the order subtotal — before tax, shipping and refunds — so it will not tie exactly to net sales.',
  queries_run = array[$q$
select resolved_channel_name          as channel,
       count(*)                       as orders,
       round(sum(subtotal_price))     as merch_revenue,
       round(avg(subtotal_price), 2)  as aov
  from shopify_orders_v
 where shopify_processed_at >= {{date_from}}::timestamptz
   and shopify_processed_at <  silo_business_today()::timestamptz
   and cancelled_at is null
 group by 1
 order by 3 desc
$q$],
  columns_metadata = '{"channel":{"semantic":"category"},"orders":{"semantic":"count"},
    "merch_revenue":{"semantic":"currency","label":"Merch Revenue"},
    "aov":{"semantic":"currency","label":"AOV"}}'::jsonb
 where id = 'c3000000-0000-4000-a000-000000000003';

-- ── 3. Say out loud that year-over-year is DATE aligned ─────────────
-- Sep 1 2026 is a Tuesday; Sep 1 2025 was a Monday. Yesterday's +474% is
-- the Sonic The Hedgehog launch measured against an ordinary day -- the
-- surrounding two-week daily average is +12% YoY, not +474%. The number is
-- arithmetically right and rhetorically misleading, so the section says so.
update public.dashboard_widgets
   set visual_config = visual_config || jsonb_build_object('note',
     'Periods are compared to the same DATES a year ago, so a single day can land on a different weekday. A launch day measured against an ordinary one will read as an enormous swing.')
 where id = 'c4000000-0000-4000-a000-000000000001';
