-- Ask SILO: teach the schema catalog about the pre-aggregated rollups.
--
-- Observed live: asked for a size curve and a store split, the model went
-- to shopify_order_lines (567 MB) and sales_by_day (2 GB) every time,
-- never to the rollups built for exactly those questions. Measured on the
-- same size-curve question:
--
--   sales_velocity_by_sku_location_v      96.7 ms   (1,805 buffers, all cached)
--   shopify_order_lines + shopify_orders  795.3 ms  (8,377 buffers, 1,334 disk reads)
--
-- 8x, and the slow path touches disk -- which on a colder cache or a
-- broader product match is how a query reaches the 10s statement timeout
-- and gets abandoned.
--
-- Root cause is in this table, not in the model. buildSchemaSection()
-- scores a relation by name (+5), keywords (+3) and description (+1). Five
-- of the six rollups had NO description and NO keywords, so they could
-- only ever match on their own name -- never surfacing for "size",
-- "channel", "velocity" or "sell-through". They fell through to the
-- one-line index, where their line renders effectively blank because it is
-- built from the description. The model was shown
-- "- sales_sku_location_rollup_mv (matview)" and nothing else, while
-- shopify_order_lines carried a rich keyworded entry. It picked the only
-- thing it could see described.
--
-- Two fixes here:
--   1. Hide the three _mv entries. `authenticated` has no SELECT on any
--      matview (correctly -- matviews cannot carry RLS, so direct access
--      would bypass tenant scoping). Advertising them can only produce a
--      permission error and a wasted tool round. The _v wrappers are the
--      supported path; they are security_invoker and filter on
--      active_company_id().
--   2. Give the _v rollups descriptions that say what grain they hold,
--      how fast they are, and when NOT to use them.
--
-- Deliberately honest about which are actually fast: only
-- sales_velocity_by_sku_location_v and sales_monthly_product_type_rollup_v
-- read from a materialized view. sales_sku_location_rollup_v and
-- sales_monthly_location_rollup_v aggregate live from sales_by_day despite
-- the matching _mv names (228 ms on an indexed SKU filter, worse
-- unfiltered) -- telling the model they are "fast rollups" would just
-- move the problem.

-- 1. Matviews are not client-selectable; keep them out of the model's index.
update public.silo_chat_schema_catalog set is_hidden = true
where relname in (
  'sales_velocity_by_sku_location_mv',
  'sales_sku_location_rollup_mv',
  'sales_monthly_product_type_rollup_mv',
  'inventory_on_hand_current_mv'
);

-- 2. The genuinely pre-computed paths.

update public.silo_chat_schema_catalog set
  keywords = array['velocity','sell-through','size','size curve','sizes','store','location','channel','split','90 days','fast','rollup'],
  description = $d$FASTEST path for "how fast does this sell" and "what did a comparable product do in its first 90 days" -- units are PRE-COMPUTED per variant SKU per location, so prefer this over grouping sales_by_day or shopify_order_lines yourself (measured 8x faster on a size-curve question, and it stays in cache instead of hitting disk). Columns: variant_sku, product_name, location_tag, qty_7d/qty_30d/qty_90d/qty_120d/qty_365d, matching avg_day_* rates, last_sold_date. qty_90d already IS the 90-day sell-through figure -- do not recompute it from raw sales. SIZE CURVE: variant_sku encodes size as its second dash-separated segment (01-M-CoopClassicBlack, 01-2XL-CoopClassicBlack, 12-L-CoopClassic-Youth), so split_part(variant_sku,'-',2) gives a size breakdown directly, with no need to touch order lines. STORE/CHANNEL SPLIT: group by location_tag. No day-level detail here -- if you genuinely need per-day movement, fall back to sales_by_day_verification_v.$d$
where relname = 'sales_velocity_by_sku_location_v';

update public.silo_chat_schema_catalog set
  keywords = array['monthly','seasonality','season','product type','category','channel','mix','trend','rollup','fast'],
  description = $d$Pre-computed monthly sales by location, channel and product_type: units, gross, discounts, refunds, net, total_sales, unique_skus, avg_net_per_unit, month_start/month_key. FASTEST path for seasonality by category ("when does this product type actually sell"), channel mix over time, and month-over-month movement -- prefer it over grouping sales_by_day yourself. Note this is real observed seasonality: when products_master has no peak_start_month/peak_end_month for a category, this view can still answer the timing question from what actually sold, rather than reporting the season as unknown.$d$
where relname = 'sales_monthly_product_type_rollup_v';

-- 3. The live-aggregating ones -- useful, but not the fast path. Saying so
--    explicitly matters: their _mv-sounding names imply otherwise.

update public.silo_chat_schema_catalog set
  keywords = array['sku','location','lifetime','totals','first sold','last sold'],
  description = $d$All-time units/gross/net per SKU per location, with first_sold_date and last_sold_date -- useful for lifetime totals and for finding when a product actually started selling (e.g. to bound a launch window). Aggregates LIVE from sales_by_day despite the name, so it is not pre-computed: filter it (sku/location) rather than scanning it whole. For velocity or a size curve prefer sales_velocity_by_sku_location_v, which is genuinely pre-computed.$d$
where relname = 'sales_sku_location_rollup_v';

update public.silo_chat_schema_catalog set
  keywords = array['monthly','location','store','totals','trend'],
  description = $d$Monthly units/gross/net per location. Aggregates LIVE from sales_by_day, so it is not pre-computed -- for category or channel seasonality prefer sales_monthly_product_type_rollup_v, which is.$d$
where relname = 'sales_monthly_location_rollup_v';

-- 4. Point the raw tables at the faster alternative, so the model has the
--    comparison in front of it at the moment it is choosing.

update public.silo_chat_schema_catalog set
  description = coalesce(description, '') || $d$ SPEED: this is the raw 567 MB line-item table. For a size curve, unit velocity or a store/channel split, sales_velocity_by_sku_location_v answers the same question from pre-computed figures roughly 8x faster -- come here only for genuinely basket-level questions (what was bought together, attach rate, per-order discounting) that no rollup can answer.$d$
where relname = 'shopify_order_lines'
  and coalesce(description, '') not like '%SPEED:%';

update public.silo_chat_schema_catalog set
  description = coalesce(description, '') || $d$ SPEED: 2 GB and day-grain. If you only need totals, velocity or a size curve, sales_velocity_by_sku_location_v is pre-computed and far faster; come here for per-day detail or for date ranges spanning the pre-API history.$d$
where relname = 'sales_by_day'
  and coalesce(description, '') not like '%SPEED:%';
