-- Make the online-domain lookup cheap enough to call from an RPC.
--
-- The version shipped in 20260827160000 scanned all of sales_by_day for the
-- company with no date bound. Measured on prod:
--
--   Parallel Seq Scan on sales_by_day (570,044 rows)
--   Sort Method: external merge  Disk: 8440kB
--   Execution Time: 3115 ms
--
-- Called inside an IN subquery by wow_funnel, wow_landing_pages and
-- wow_discount_codes, that blew the statement timeout and all three RPCs
-- failed -- so the funnel, landing pages and affiliate codes rendered empty
-- on a page whose data was completely fine.
--
-- Worth naming the second failure: the page reports an RPC error exactly like
-- an empty result, so a total outage of three cards read as "no data yet".
-- Correct-looking emptiness is the worst failure mode this report has, and it
-- has now happened twice (the sessions sync reported success having written
-- nothing).
--
-- A 60-day bound lets the planner use sales_by_day_company_day_idx:
--
--   Index Scan using sales_by_day_company_day_idx
--   Execution Time: 184 ms          (17x faster)
--
-- It also returns a better answer -- the domain currently taking online
-- orders, not every domain that ever did. The old unbounded version dragged
-- in 'baseballism.com' from the retired Better Reports import.
create or replace function public.wow_online_shop_domains()
returns table (shop_domain text)
language sql
stable
as $$
  select distinct s.shop_domain
  from public.sales_by_day s
  where s.company_entity_id = public.active_company_id()
    -- Bounded so the index applies. Any store taking online orders has rows
    -- well inside this window; without it the planner falls back to a full
    -- scan of the largest table in the database.
    and s.day_date > current_date - 60
    and lower(btrim(s.location_tag)) = 'online'
    and s.shop_domain is not null;
$$;

grant execute on function public.wow_online_shop_domains() to authenticated;
