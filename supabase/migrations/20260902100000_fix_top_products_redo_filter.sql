-- Fix the seeded "Top Products" definition: it was still ranking x-redo #1.
--
-- The seed (20260828150000) excluded Redo's Package Protection line item by
-- title, guessing the title read "Package Protection". Verified against prod
-- the moment the seed landed: it does not. products_master genuinely carries
-- `product_title = 'x-redo'` -- the SKU is also the title, and
-- `title_source = 'products_master'`, so this is not the view falling back to
-- sales_by_day.product_name. The filter matched nothing and x-redo sat at the
-- top of the list with 8,209 units, ahead of every real product.
--
-- Exactly the failure the seed's own comment predicted ("if Redo's line item
-- is ever renamed this filter stops matching -- a visible wrong entry at the
-- top of a list, not a silent error"). It was wrong from the start rather
-- than drifting, but the property that made it safe held: the wrong row was
-- the most visible row on the report.
--
-- Both filters are kept. The title match is the fact today; the ilike stays
-- as cheap insurance if the line item is ever renamed to something readable.
--
-- An explicit UPDATE rather than a re-seed, because 20260828150000 uses
-- `on conflict (id) do nothing` precisely so a rebuild cannot clobber a
-- correction. Changing a shipped definition is its own migration -- this one.
update public.silo_chat_saved_reports
   set queries_run = array[$q$
     select product_title,
            sum(units_sold) as units_sold,
            sum(net_sales)  as net_sales,
            sum(orders)     as orders
       from sales_by_product_title_daily_v
      where day_date >= current_date - 30
        and lower(product_title) <> 'x-redo'
        and product_title not ilike '%package protection%'
      group by product_title
      order by units_sold desc
      limit 50
   $q$],
       description = 'Best-selling products by units over the last 30 days. Excludes x-redo (Redo''s Package Protection checkout line item), which is not merchandise.'
 where id = '5110de50-0000-4000-a000-000000000002'
   and source = 'system';
