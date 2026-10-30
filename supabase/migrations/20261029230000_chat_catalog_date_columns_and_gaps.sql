-- Ask SILO: name the real date column, and fill the catalog gaps that the
-- measured column failures land on.
--
-- Companion to the schema-map change of the same date (schema-map-lib.mjs),
-- which puts every relation's EXACT column names on its index line. That
-- removes most column guessing, but it makes ONE class of mistake easier
-- rather than harder, and this migration is the other half of that change.
--
-- The hazard: a column that exists, is named what the model expects, and means
-- something else. `shopify_orders.created_at` and
-- `shopify_order_lines.created_at` are the row's INSERT time in SILO, not the
-- order's date. Measured 2026-10-29 on production:
--
--   * Of 2,752 logged statements, 29 filtered one of these tables on bare
--     `created_at`. NINETEEN of those 29 -- two in three -- died on the 8s
--     statement timeout.
--   * The reason they are slow is the reason they are also wrong. The oldest
--     300 order lines all carry created_at within 1.5 seconds of each other
--     (2026-08-18 05:11:28): that is when the backfill ran. So
--     `created_at >= '2026-08-01'` matches an estimated 2,213,145 of 2,432,347
--     rows -- 91% of the table -- and the planner reads the whole company
--     partition of a 2 GB table to answer "the last 90 days".
--   * For orders synced live it looks fine (1,885 of the most recent 2,000 rows
--     have created_at on the same day as shopify_created_at), which is exactly
--     what makes it dangerous: it is plausible on recent data and silently
--     wrong on anything backfilled.
--
-- `shopify_orders` has the right columns -- shopify_created_at and
-- shopify_processed_at -- and the logs show the model usually finds them (187
-- of 239 statements touching these tables use one). `shopify_order_lines` has
-- NO order-date column at all, so a date window there has to come from a join.
-- Neither fact was written down anywhere the model could read it.
--
-- The rest of this migration is the content gap the schema-map change does not
-- cover: 215 of 322 visible relations carry no keywords, so they can never be
-- scored into the 8-relation detail slice, and the ones below are the relations
-- Ask SILO actually queries and actually fails on. Counts are statements
-- queried / statements failed, from the same 529 diagnosed requests:
--
--   launch_product_readiness       40 / 12      qbo_history_lines     18 / 11
--   v_po_incoming_lines            29 / 10      meta_ad_creatives     47 /  7
--   silo_attribution_ledger_v      35 /  8      v_po_incoming_rollup  28 /  3
--   card_transactions              19 /  3      instagram_media       18 /  3
--   shopify_attribution_orders     20 /  3      product_tracker        6 /  3
--
-- Every column name asserted below was read from the live catalog on
-- 2026-10-29, not from memory. Idempotent: data-only updates keyed by relname,
-- re-runnable, no DDL, no policy or grant change. refresh_chat_schema_catalog()
-- updates only relkind/columns/auto_refreshed_at, so curated description and
-- keywords survive the nightly refresh.
--
-- The first sentence of each description matters twice: v3/js/report-builder-ui.js
-- shows it alone as the source lede in the report builder, so it is written to
-- read as a plain summary for a person, with the traps after it.

-- 1. The date-column trap, on both tables that carry it.

update public.silo_chat_schema_catalog set
  description = coalesce(description, '') || $d$ DATE COLUMN -- READ THIS BEFORE FILTERING BY DATE: created_at is the timestamp SILO INSERTED the row, not when the order was placed. Rows loaded by a backfill all share that run's timestamp, so a window on created_at matches ~91% of the table and both scans forever and selects the wrong orders. The order's own dates are shopify_created_at (placed) and shopify_processed_at (processed); use one of those for every "last N days", month or year question, and use created_at only when the question is genuinely about when SILO synced a row.$d$
where relname = 'shopify_orders'
  and coalesce(description, '') not like '%DATE COLUMN -- READ THIS%';

update public.silo_chat_schema_catalog set
  description = coalesce(description, '') || $d$ NO ORDER DATE HERE: this table has no column for when the order was placed -- created_at is SILO's row-insert time (shared by every row of a backfill, so a window on it matches most of the table and scans 2 GB), and synced_at is the sync. To bound line items by order date, join shopify_orders on (order_id, company_entity_id) and filter o.shopify_created_at or o.shopify_processed_at.$d$
where relname = 'shopify_order_lines'
  and coalesce(description, '') not like '%NO ORDER DATE HERE%';

-- 2. The relations with no keywords and no description that the logs show
--    Ask SILO reaching for anyway. Each names the columns it was guessed as,
--    because that guess is the measured failure.

update public.silo_chat_schema_catalog set
  keywords = array['launch readiness','readiness','launch prep','sizes','product shot','copy status','website status','go live','launch products'],
  description = $d$Per-product readiness checklist for a launch: one row per product attached to a launch, tracking whether it is physically and editorially ready. Columns: launch_id, product_title, product_type, collection_name, manufacturer, po_number, vendor_name, bulk_eta, expected_units, expected_retail_value, on_hand_status, size_requests, sizes_ready, sizes_picked_up, product_shot_status, copy_status, website_status, live_status, readiness_status, notes, product_tracker_id, factory_id. Product identity here is product_title -- there is no resolved_product_id or is_resolved column (those belong to launch_product_actuals, which is the "what did it sell" counterpart). Paired one-to-one with product_tracker (the Products page Pipeline tab) via product_tracker_id, so the same product can be read from either side; this is the launch-side view. Join launches through launch_id to launch_calendar, whose name column is title.$d$
where relname = 'launch_product_readiness';

update public.silo_chat_schema_catalog set
  keywords = array['incoming','on order','po lines','purchase order','inbound','arriving','eta','open po'],
  description = $d$Open purchase-order lines that have not arrived yet -- what is on order and when it is expected, one row per PO line. Columns: po_header_id, po_name, factory_id, factory_name, status, order_date, req_ship_date, expected_arrival_date, date_bucket, wholesale_triggered, is_new_product_po, po_created_at, po_line_id, product_master_id, product_type, product_title, variant_title, sku, upc, qty, retail_price, unit_cost, retail_value, estimated_cost, line_notes. NAMES THAT TRIP PEOPLE UP: the PO's human identifier is po_name, NOT po_number; the quantity is qty, NOT qty_ordered or incoming_qty; the SKU is sku, NOT variant_sku or sku_snapshot. Arrival dates are expected_arrival_date (and effective_arrival_date on the logistics reports, which prefers a booked shipment's date when one exists).$d$
where relname = 'v_po_incoming_lines';

update public.silo_chat_schema_catalog set
  keywords = array['incoming','on order','inbound','rollup','by product','arriving','units on order'],
  description = $d$Incoming purchase-order quantities already rolled up per product -- the fast way to answer "how much of this is on order". Columns: product_type, product_title, sku_count, variant_count, po_count, total_units, total_retail_value, total_estimated_cost, avg_unit_cost, first_expected_arrival, last_expected_arrival. ROLLED UP, so there is NO sku column here (only sku_count) and no PO-level detail: for a specific SKU, a specific PO or a line's own quantity, use v_po_incoming_lines.$d$
where relname = 'v_po_incoming_product_rollup';

update public.silo_chat_schema_catalog set
  keywords = array['quickbooks history','imported ledger','gl lines','general ledger','account history','pre-silo','historical books'],
  description = $d$Imported QuickBooks general-ledger history: one row per line of a bulk import, for periods whose books were kept in QBO rather than in SILO. Columns: import_id, row_no, row_kind, qbo_account_id, account_name, account_type, transaction_date, qbo_transaction_id, transaction_type, document_number, counterparty, memo, split_account_id, split_account_name, natural_amount, natural_balance, raw_row. The date column is transaction_date -- NOT txn_date, which is the name card_transactions uses for the same idea; the two tables genuinely disagree, so check which one you are in. natural_amount/natural_balance are in the account's natural sign. This is imported history, not SILO's own journal: for entries SILO posted, use the accounting journal tables.$d$
where relname = 'qbo_history_lines';

update public.silo_chat_schema_catalog set
  keywords = array['card','credit card','spend','coding','merchant','statement','transactions','bank feed'],
  description = $d$Credit-card transactions awaiting or carrying an accounting code -- the rows behind the bank/card coding workflow. Key columns: txn_date, description, merchant, clean_merchant, amount, currency, cardholder, card_name, last4, qbo_account_id, qbo_account_name, qbo_location_name, vendor_name, memo, coding_source, confidence, ai_reasoning, rule_id, status, exclude_reason, accounting_treatment, origin, plaid_account_id. NAMES: the date is txn_date (NOT transaction_date -- qbo_history_lines uses that one) and the merchant is merchant or clean_merchant, NOT merchant_name. status drives the workflow, so filter it rather than assuming every row is coded or posted; a coded row is not necessarily sent to QuickBooks.$d$
where relname = 'card_transactions';

update public.silo_chat_schema_catalog set
  keywords = array['ad creative','creative','ad copy','headline','image','thumbnail','meta ads','ad text','landing url'],
  description = coalesce(nullif(description, ''), 'Creative content for each Meta ad.') || $d$ COLUMNS: ad_id, ad_name, account_id, campaign_id, adset_id, effective_status, creative_id, body, title, object_type, thumbnail_url, link_url, link_path, link_url_tags, preview_shareable_link, image_* (stored image metadata). This table is the creative TEXT AND IMAGERY only -- the ad copy headline is title (NOT headline), and it carries campaign_id but NO campaign_name and NO performance columns at all. Spend, reach, impressions, purchases and CPM live in meta_ad_performance_daily / meta_ad_performance_v; join on ad_id (and campaign_id for names) rather than looking for them here.$d$
where relname = 'meta_ad_creatives'
  and coalesce(description, '') not like '%creative TEXT AND IMAGERY only%';

update public.silo_chat_schema_catalog set
  keywords = array['instagram','organic social','posts','reels','engagement','likes','comments','saves','reach'],
  description = $d$Per-post Instagram performance for the connected account -- ORGANIC social, not paid. Columns: media_id, media_type, caption, permalink, thumbnail_url, posted_at, views, reach, likes, comments, shares, saved, synced_at. The post's own date is posted_at (NOT timestamp or created_at). There is no campaign, ad or spend column here and there should not be: this is not an ads table, so a question about paid Instagram placements belongs in the meta_ad_* relations.$d$
where relname = 'instagram_media_insights';

update public.silo_chat_schema_catalog set
  keywords = array['attribution','channel','allocation','attributed revenue','marketing attribution','window','order channel'],
  description = $d$Shopify order revenue allocated to a marketing channel, one row per order PER ATTRIBUTION WINDOW. Columns: day, order_id, order_name, channel, net_cents, total_cents, window_days, allocation, currency, shop_timezone, discount_codes, discount_code, connection_id, extracted_at, evidence_fetched_at. DOUBLE-COUNTING HAZARD: window_days takes the values 7, 14, 30 and 60, and the same order appears once for EACH, so any sum of net_cents or total_cents without `where window_days = <one value>` is roughly four times the real figure. Amounts are in CENTS (divide by 100). The date column is day. channel is 'Unattributed' where no allocation was found -- that is a real bucket, not a null to drop. Coverage is limited to the days that have attribution snapshots, so check the range before reading a trend.$d$
where relname = 'silo_attribution_ledger_v';

update public.silo_chat_schema_catalog set
  keywords = array['attribution evidence','order evidence','attribution raw','snapshot'],
  description = $d$Raw per-order attribution evidence as fetched from Shopify, one row per order: company_entity_id, connection_id, order_id, evidence (jsonb), fetched_at. The evidence blob is the source the attribution views unpack -- for channel, allocation, amounts or discount codes read silo_attribution_ledger_v instead of parsing this by hand. There are no money or channel columns here.$d$
where relname = 'shopify_attribution_orders';

update public.silo_chat_schema_catalog set
  keywords = array['pipeline','product pipeline','in development','tracker','product status','sizes ready'],
  description = $d$The Products page Pipeline tab: products in development, one row each, tracking manufacturing and go-live status. Columns: product_title, product_title_snapshot, manufacturer, factory_id, product_type, collection, launch_id, product_master_id, po_header_id, bulk_eta, on_hand, size_requests, sizes_ready_warehouse, sizes_picked_up, photo_complete, copy_complete, is_live, expected_units, notes. Paired one-to-one with launch_product_readiness via its product_tracker_id, which is the launch-side view of the same product. Join launches through launch_id to launch_calendar, whose name column is title -- not launch_name.$d$
where relname = 'product_tracker';
