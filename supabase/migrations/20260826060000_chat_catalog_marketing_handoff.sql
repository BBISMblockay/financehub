-- Close the marketing-side gaps in Ask SILO's schema catalog, ahead of
-- handing SILO's marketing tables to an outside analyst.
--
-- Audited the catalog against live data on 2026-08-25. Most of it held up:
-- launch_calendar already carries its measured fill rates, launch_actuals_v
-- already says sku_source = null means NOT MEASURABLE, and shopify_orders_v
-- already covers the total_price vs gross-sales trap. Four marketing
-- relations had NO description at all, and one structural trap was
-- undocumented anywhere.
--
-- WHAT GOES WHERE. silo_chat_schema_catalog has no company_entity_id: one
-- global row per relation, read by every tenant. 20260826030000 exists
-- purely to undo one company's measured facts having been written there as
-- universal rules, so this migration keeps that line carefully:
--
--   catalog  -> structural truths that hold for any install (how GA4 and
--               the ad platforms differ, which column is the order date,
--               what joins to what)
--   notes    -> measured state of THIS company's data, which is data entry
--               and changes (see the silo_chat_notes insert at the bottom)
--
-- Descriptions and keywords are curated columns and survive
-- refresh_chat_schema_catalog(), which only regenerates `columns`. No
-- public table or view changes here, so no refresh is required.
--
-- Follows the precedent of 20260825170000 / 20260825230000 / 20260826030000:
-- content-only catalog migrations are not mirrored into
-- apply_all_post_merge.sql or verify_v2_schema.sql, which track DDL.

-- ---------------------------------------------------------------------
-- 1. marketing_kpis_daily -- the GA4 mixing trap.
--
-- Verified on live data (last 30 days): ga4 conversion_value $1,312,742,
-- meta_ads $1,234,018, google_ads $229,658. GA4 measures site-wide revenue
-- while each ad platform measures only what it claims; they overlap almost
-- entirely, so summing across platforms roughly doubles revenue. This is a
-- property of the platforms, not of any one store, so it belongs here.
-- Existing coverage guidance is preserved verbatim.
-- ---------------------------------------------------------------------
update public.silo_chat_schema_catalog set
  description = $d$Daily ad spend/revenue by platform (google_ads, meta_ads, tiktok_ads, ga4), campaign-level. The authoritative ledger for real ad spend by platform/day. COVERAGE: data begins 2025-08-14 (about 12 months, 3 platforms). There is NO ad data before that date, so a product launched earlier than roughly Aug 2025 has no spend/CAC/MER history for its launch -- say so plainly rather than treating the absence as a finding about the product.

PLATFORM MIXING -- the most common way to get a wrong answer from this table: ga4 rows sit alongside the ad platforms but measure something different in kind. GA4 reports SITE-WIDE revenue and sessions; each ad platform reports only the revenue IT claims to have driven. Those overlap heavily, so SUM(conversion_value) across all platforms double counts revenue and produces a meaningless ROAS. Filter to the ad platforms (platform in ('google_ads','meta_ads','tiktok_ads')) for any spend/ROAS/CAC question, and treat ga4 as a separate site-wide series rather than a fourth ad channel. Two mechanical consequences worth knowing before writing the query: ga4 rows carry spend = 0, and ga4 rows carry campaign_id = NULL, so any GROUP BY campaign_id silently drops every GA4 row rather than erroring.

The four platform values are what the schema SUPPORTS, not what is populated. Check for rows per platform before reporting that a platform is or is not running -- a platform with zero rows may mean it is not connected, not that it is not spending.

ATTRIBUTION CEILING: nothing in this schema ties an individual order back to the campaign that produced it. There is no UTM capture, click id, or session-to-order stitch anywhere in SILO, so spend and sales can only be related on day_date, at a blended level. When asked which campaign or ad drove specific orders or a specific product's sales, say plainly that the data cannot support it rather than implying a join exists or inferring causation from same-day movement.$d$,
  keywords = array['marketing','ads','spend','campaign','google','meta','tiktok','ga4','roas','cac','mer','attribution']
where relname = 'marketing_kpis_daily';

-- ---------------------------------------------------------------------
-- 2. shopify_orders -- had no description. The view is the better default,
--    and created_at vs shopify_created_at is a silent-wrong-answer trap:
--    created_at is the SILO insert timestamp, so using it collapses the
--    whole order history into the sync window.
-- ---------------------------------------------------------------------
update public.silo_chat_schema_catalog set
  description = $d$Base table behind shopify_orders_v -- one row per Shopify order. PREFER shopify_orders_v for nearly every question: it is this table plus resolved_channel_name joined in from shopify_channel_map, and source_name here is frequently an opaque app id rather than a readable channel. Come to the base table only when you deliberately do not want that join.

ORDER DATE: use shopify_created_at (or shopify_processed_at for accounting-aligned timing). created_at is the row's SILO insert timestamp, NOT the order date -- using it compresses the entire order history into whenever the sync last ran, which looks like a plausible result and is wrong. shopify_updated_at reflects later edits.

Key is (shop_domain, order_id). Per-SKU detail lives in shopify_order_lines, keyed (shop_domain, order_id, line_item_id). Rows are plain upserts reflecting current state, not a delta feed, so a cancelled or refunded order shows its CURRENT financial_status rather than its history -- check financial_status and cancelled_at before counting an order as a sale. The total_price vs gross-sales caveat documented on shopify_orders_v applies identically here.$d$,
  keywords = array['orders','shopify','order','channel','customer','order date','financial status']
where relname = 'shopify_orders';

-- ---------------------------------------------------------------------
-- 3. meta_ad_creatives -- had no description. This is the only path from
--    performance back to what the ad actually said.
-- ---------------------------------------------------------------------
update public.silo_chat_schema_catalog set
  description = $d$Creative metadata for Meta ads -- the copy and asset behind a performing or failing ad. NOT a time series: one row per ad, no date column, no metrics. Join to meta_ad_performance_daily on ad_id to pair what an ad SAID with how it DID; that pairing is the reason this table exists and is the only route from a spend number back to a creative.

Columns: ad_id, ad_name, campaign_id, adset_id, effective_status (active/paused/etc.), body and title (the ad copy), object_type (creative format), thumbnail_url and creative_id (for creative-image lookups).

Meta only. There is no Google or TikTok equivalent, so creative-level analysis is available for Meta and simply not possible for the other platforms -- say that rather than substituting campaign names as a proxy for creative. Note also that creative-level work is bounded by meta_ad_performance_daily's window, which is materially shorter than marketing_kpis_daily's history; check that view's coverage before promising a long-run creative trend.$d$,
  keywords = array['creative','ad copy','meta','facebook','instagram','thumbnail','ad name','which ad']
where relname = 'meta_ad_creatives';

-- ---------------------------------------------------------------------
-- 4. shopify_channel_map -- had no description. Small table, but the
--    cross-tenant join hazard is real: the same app id can mean different
--    things in different stores.
-- ---------------------------------------------------------------------
update public.silo_chat_schema_catalog set
  description = $d$Per-company lookup turning Shopify's raw source_name into a readable sales channel. Exists because Shopify reports third-party channels as opaque app ids or slugs rather than names, so this mapping is maintained by hand and cannot be inferred from the id. Columns: source_name, display_name, company_entity_id.

Join on BOTH source_name AND company_entity_id. The same app id can map to different channels in different stores, so joining on source_name alone crosses tenants and mislabels channels.

Usually you do not query this directly -- shopify_orders_v already applies it as resolved_channel_name and falls back to the raw source_name when a value is unmapped. Query it directly to audit coverage. An unmapped source_name appearing in orders means a new channel needs adding: report it as unmapped and suggest adding it rather than guessing what the id represents, because a guessed channel name is indistinguishable from a real one in the answer.$d$,
  keywords = array['channel','source name','sales channel','mapping','tiktok','faire','pos','online store']
where relname = 'shopify_channel_map';

-- ---------------------------------------------------------------------
-- 5. v_launch_po_product_lookup -- had no description. The launch-side
--    join depends on linked_po_id, so an empty result must be read as
--    UNLINKED rather than as "no product".
-- ---------------------------------------------------------------------
update public.silo_chat_schema_catalog set
  description = $d$PO-to-product rollup: one row per PO x product with po_header_id, po_name, factory_name, product_title, total_units, total_retail_value, total_estimated_cost and a unit price range. Use it to answer what was bought, from which factory, at what retail value.

Reached from a launch via launch_calendar.linked_po_id = po_header_id, so a launch can show the product and buy behind it. That join only works where linked_po_id is populated. Where launches have not been linked to POs it returns nothing, and an empty result means UNLINKED, not that the launch has no product behind it -- check whether linked_po_id is populated before drawing any conclusion from an empty join, and report the gap as a data-entry state rather than as a finding about the launch.

Independently queryable with no launch involved, which is the more reliable use while launch linking is incomplete.$d$,
  keywords = array['po','purchase order','factory','product','units','retail value','buy','what did we order']
where relname = 'v_launch_po_product_lookup';

-- ---------------------------------------------------------------------
-- 6. Measured state of THIS company's data -> silo_chat_notes, not the
--    catalog. These are data-entry states that change as launches get
--    linked and platforms get connected; every one is re-checkable with a
--    single query, and the note says so.
--
--    company_entity_id is set explicitly because this runs as service role,
--    where active_company_id() is null. created_by is left null for the
--    same reason -- matching how the syncs write.
-- ---------------------------------------------------------------------
insert into public.silo_chat_notes (company_entity_id, category, note)
select
  '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid,
  'general',
  $n$Marketing/launch data state, measured 2026-08-25 -- these are data-entry states, not schema facts, so re-check them before relying on them and say when you have:

(1) launch_calendar.linked_po_id is empty on all 51 launches. Because launch_actuals_v measures only through linked_po_id, it currently returns sku_source = null and no units for EVERY launch. Launch performance is NOT MEASURABLE here today -- that is different from a launch having sold nothing, and must never be reported as zero sales. For launch-adjacent questions, fall back to sales_by_day or sales_velocity_by_sku_location_v scoped to the launch date range, and state that the figure is date-scoped rather than SKU-attributed to the launch.

(2) launch_calendar.launch_end_date is empty on all 51 rows, so no launch is currently stored as a period. Multi-day promotions appear as a start row plus a separate row titled "... End" (launch_type 'Promotion End'), which measure as two independent point drops until merged. Pair them by hand before reporting on a sale window, and note that merging them in the app is a human decision because it discards whatever was typed on the losing row.

(3) marketing_kpis_daily has no tiktok_ads rows, despite tiktok_ads being a supported platform. TikTok Shop ORDERS do exist, in shopify_orders_v under source_name 'tiktok'. So on this company's data "TikTok" is a sales channel and not an ad channel -- do not read the absent ad spend as TikTok underperforming.$n$
where not exists (
  select 1 from public.silo_chat_notes
  where company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'::uuid
    and note like 'Marketing/launch data state, measured 2026-08-25%'
);
