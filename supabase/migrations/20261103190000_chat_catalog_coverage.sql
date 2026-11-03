-- Give the schema catalog business meaning for the relations bots actually ask
-- about, and hide the plumbing they should never see.
--
-- What this is NOT. It is not a fix for "column ... does not exist". That class
-- of failure was the renderer, not the content: the index line was built from
-- the description's first sentence alone and threw the column guidance away,
-- and the fix was to put the exact column names on every index line
-- (silo-chat/schema-map-lib.mjs, which documents the measurement). Do not
-- re-litigate it here.
--
-- What curated text still decides, on both AI surfaces:
--   * RANKING into the full cards. buildSchemaSection scores each relation
--     against the question: +5 name hit, +3 KEYWORD hit, +1 description hit,
--     and only the top 8 get a card with types and curated meaning. A relation
--     with no keywords can therefore win a card only when the question happens
--     to use its table name -- which is why the ledger, payroll, AR, AP,
--     landed-cost and reorder surface has effectively never had one.
--   * DISCOVERY over MCP. silo_api_describe_tables returns names only until a
--     bot searches or asks for a relation by name, and its search matches name,
--     description and column text -- so an undescribed relation is close to
--     unfindable for a connection that does not already know it exists.
--   * The TRAPS a column list cannot carry: that posting_type is title-cased
--     with positive amounts on both sides, that coded is not posted, that
--     payouts are cash and not sales, that attribution is in cents, that a
--     line x shipment grain double counts, and -- the one a bot has no other
--     way to learn -- that four of these feeds stopped months ago.
--
-- Measured 2026-11-03: 366 catalogued relations, 38 hidden, and only 134
-- carrying keywords -- 11 of those hidden, so 205 of the 328 visible relations
-- ranked on their name alone. Sixty of them are seeded here.
--
-- EVERY FIRST SENTENCE IS UNDER 140 CHARACTERS AND ENDS IN ". ". The index line
-- keeps `description.split('. ')[0]` truncated at MAX_INDEX_SUMMARY_CHARS (140,
-- schema-map-lib.mjs), so a description whose opening clause runs long is cut
-- mid-thought on every question that does not win a card. Column enumerations
-- therefore come after the opening sentence, never inside it. The test fails if
-- a seeded description breaks this.
--
-- This migration changes no business row. It is catalog text, plus is_hidden on
-- eleven internal tables.
--
-- Three rules it follows, each pinned by a test
-- (scripts/tests/chat-catalog-coverage-database.test.mjs):
--   1. keywords are always set for a seeded relation (none of them had any).
--   2. description is written ONLY where it is currently null, so a curated
--      description -- sync_jobs' skip/partial-failure warning, for one -- is
--      never clobbered, and a re-apply after a human edit is a no-op.
--   3. a seeded name that is not in the catalog raises. The failure mode this
--      replaces is an `update ... where relname = '<typo>'` that reports
--      success and lands nowhere, which is how this file could silently do
--      nothing at all.
--
-- The facts below were read from production on 2026-11-03: column names from
-- silo_chat_schema_catalog, status values by distinct scan, staleness by
-- max(date). Where a feed has stopped, the description says so with the date --
-- a bot cannot tell "no rows" from "nobody has imported this since May", and
-- payroll, AR, revenue projections and the product tag sheet are all in that
-- state today.

begin;

-- ── 1. Internal plumbing the model should not be offered ───────────────────
-- is_hidden is noise reduction AND, since 20261030110000, the query tool's
-- allowlist: a hidden relation cannot be named in a connection's SQL. These
-- eleven are install/claim/staging scaffolding and one credentials table. None
-- answers a business question; their RLS already denies or scopes reads, so
-- this is surface reduction, not a new boundary.
update public.silo_chat_schema_catalog set is_hidden = true, updated_at = now()
where relname in (
  'shopify_client_credentials', 'shopify_install_states', 'shopify_pending_installs',
  'billing_checkout_claims', 'stripe_connect_setup_claims', 'sample_notification_claims',
  'card_coding_preparation_claims', 'po_sequences', 'onboarding_interest_rate_buckets',
  'qbo_history_staging_sections', 'qbo_history_staging_lines'
) and not is_hidden;

-- ── 2. Business meaning for the relations that had none ────────────────────
-- The seed is a CTE inside the single statement that uses it, deliberately. An
-- earlier version of this file held it in a temp table declared `on commit
-- drop`, which is correct under psql (this file is one transaction) and wrong
-- everywhere else: a client that commits each statement separately drops the
-- table between the insert and the update and fails with `relation
-- "_catalog_seed" does not exist`. Blake hit exactly that applying it through
-- the SQL editor. A migration must not depend on state that survives only
-- inside one transaction, because the thing that applies it is not always psql.
with seed (relname, description, keywords) as (values

-- Ledger and accounting -----------------------------------------------------
('ledger_entries',
 $d$SILO's own double-entry ledger, one row per entry it recorded. source says what produced it ('card_transaction' or 'journal_adjustment') and source_id points at that record; kind is 'original' or 'reversal', and a reversal carries reverses_entry_id -- so never total entries without netting reversals out. entry_date is the accounting date; recorded_at is when SILO wrote the row. The amounts are in ledger_lines; for anything report-shaped read silo_ledger_lines_v instead, which joins both and adds signed_amount and whether the line reached QuickBooks.$d$,
 array['ledger','journal entry','double entry','books','general ledger','accounting','debit','credit']),

('ledger_lines',
 $d$One row per line of a ledger entry; entry_id joins ledger_entries.id and line_no orders them. posting_type is TITLE-CASED 'Debit' / 'Credit' (not lowercase, not dr/cr) and amount is always positive on both sides, so a signed figure has to be derived -- or read silo_ledger_lines_v.signed_amount, which already negates credits. qbo_account_id is the QuickBooks account (names in accounting_accounts), qbo_location_id its class/location, entity_qbo_id with entity_type the vendor or customer.$d$,
 array['ledger lines','journal lines','debit','credit','posting','account','gl lines']),

('silo_ledger_lines_v',
 $d$The books, flattened for reporting, and THE ONE TO USE for any "what do the books say" question. Every ledger line with its entry's date, kind, source and memo, plus signed_amount (credits negative, so it sums straight) and in_quickbooks / quickbooks_date for whether that line has actually been posted to QuickBooks. batch_id, transaction_id, adjustment_id and posting_id point back at the card batch, card transaction or journal adjustment behind the line. Coded in SILO and posted to QuickBooks are different things -- in_quickbooks is the one that answers "is it in QBO".$d$,
 array['books','ledger','general ledger','trial balance','journal','posted','quickbooks','accounting','debit','credit']),

('accounting_accounts',
 $d$The QuickBooks chart of accounts as SILO synced it, per QBO connection. qbo_account_id is the id that every coded card line and journal line references -- join on it, never on name. name and account_type are what to display; is_active says whether QuickBooks still offers the account. Configuration, no amounts.$d$,
 array['chart of accounts','coa','account','account name','account type','gl account','quickbooks account']),

('accounting_coa_map',
 $d$Which QuickBooks account SILO posts a given kind of thing to. One row per map_key per company, resolving to qbo_account_id / qbo_account_name. Configuration behind the posting logic, not transactions -- 9 rows, so do not mistake it for a chart of accounts (that is accounting_accounts).$d$,
 array['account mapping','coa map','posting account','configuration','quickbooks mapping']),

('accounting_journal_register',
 $d$Every journal-shaped record in one list, whatever created it. Kind is 'card_batch' or 'journal_adjustment', with entry_date, memo, status, posting_status ('posted' or null) and qbo_journal_entry_id once it reached QuickBooks. Use it for "what entries exist" and read the amounts from silo_ledger_lines_v -- there are no debit/credit columns here.$d$,
 array['journal register','journal entries','entries','posted','close','accounting']),

('journal_adjustments_v',
 $d$Manual journal adjustments, with creator and approver names resolved and line_count, debits and credits already totalled. The path is deliberately two-step -- a draft is created, then re-read and approved -- so status and approved_at matter: a draft that was never approved is NOT in the books. posting_status, qbo_journal_entry_id and qbo_doc_number say whether it reached QuickBooks. Lines are in journal_adjustment_lines.$d$,
 array['journal adjustment','journal entry','adjustment','je','manual entry','approval','accounting']),

('journal_adjustment_lines',
 $d$One row per line of a journal adjustment; adjustment_id joins journal_adjustments.id and line_no orders them. posting_type is TITLE-CASED 'Debit' / 'Credit' and amount is positive on both sides, so a balanced entry sums to twice the entry's value unless the sides are separated.$d$,
 array['journal adjustment lines','journal lines','debit','credit','adjustment','accounting']),

('schedule_items',
 $d$Prepaid and amortization schedules, one row per item being spread over time. Columns: schedule_type, label, vendor_name, the service_start..service_end window, method and status, optionally linked to the payment_request it came from. Observed values are schedule_type 'prepaid' and method 'straight_line'. SMALL BY DESIGN -- 2 rows on 2026-11-03, so an empty-looking answer here is genuinely an empty schedule, not a broken feed. Balances are in schedule_item_balances_v and the per-period split in schedule_item_amortization_v.$d$,
 array['prepaid','prepaids','amortization','schedule','deferred','accrual','accounting']),

('schedule_item_balances_v',
 $d$Where each prepaid or amortization schedule stands today. Columns: total_amount, recognized_to_date, remaining_balance, months and periods_elapsed per schedule item, with its account. Use this for "what is left on prepaids" rather than recomputing from schedule_items.$d$,
 array['prepaid balance','amortization','remaining','recognized','deferred','schedule']),

('fixed_asset_balances_v',
 $d$Fixed assets with their depreciation position, one row per asset. Columns: cost, depreciable_base, accumulated_depreciation, net_book_value and periods_elapsed, plus the depreciation_start..depreciation_end window and the asset account. Per-period detail is in fixed_asset_depreciation_v.$d$,
 array['fixed assets','depreciation','net book value','nbv','assets','capex','accounting']),

-- Card and bank coding ------------------------------------------------------
('card_transactions_v',
 $d$Bank and card transactions as the coding workspace sees them, one row per transaction. Columns: txn_date, description / merchant / clean_merchant, amount, cardholder and last4, the coded destination (qbo_account_id and name, qbo_location_id and name, vendor_name, entity_*), how it got there (coding_source, rule_id, confidence, ai_reasoning) and status -- 'uncoded', 'coded' or 'excluded'. origin and plaid_account_id distinguish a Plaid bank-feed row from an imported statement; batch_* carry the batch it posts in. CODED IS NOT SENT: status 'coded' only means somebody chose the account. For whether it reached QuickBooks read in_quickbooks on silo_ledger_lines_v. Where a transaction is split, its posting lines are in card_coding_effective_lines, not here.$d$,
 array['bank','card','transactions','coding','categorize','plaid','spend','merchant','uncoded','quickbooks']),

('card_coding_effective_lines',
 $d$The lines a card transaction will actually post as, after splits. One row per line, with line_no, amount, qbo_account_id, qbo_location_id, entity_* and memo, and is_split true where the transaction was split across accounts. Use this -- not card_transactions_v.amount -- when totalling what was coded to an account, because a split transaction's amount sits on one row while its accounts sit on several.$d$,
 array['card coding','splits','posting lines','coded amount','account','bank']),

('card_coding_suggestions_v',
 $d$The AI coding suggestion history, one row per attempt per transaction. Columns: outcome, review_status, the suggested account / location / vendor, confidence, reasoning, evidence, model and prompt_version, plus who decided and when, and stale_reason where the suggestion no longer matches the transaction. A SUGGESTION IS A PROPOSAL -- what was actually coded is on card_transactions_v. Counting suggestions is not counting coded transactions.$d$,
 array['ai coding','suggestions','confidence','review','card coding','bank']),

('card_coding_rules',
 $d$The deterministic coding rules that run before the AI. Each maps pattern plus match_type and match_field mapping to a destination account, location, vendor and entity, with priority, direction, accounting_treatment, hit_count, last_used_at and is_active. A matching rule beats an AI suggestion, so hit_count is the honest measure of how much coding is automated.$d$,
 array['coding rules','rules','automation','merchant pattern','card coding','bank']),

-- Payroll -------------------------------------------------------------------
('payroll_register_lines',
 $d$Imported payroll register detail, one row per employee per pay type per batch. Columns: (ee_code / ee_name, typecode / typedesc, register_type, amount, hours_units, wages, department and location codes, pay_period_start..pay_period_end). An adjusted row keeps its original_amount / original_hours_units / original_wages beside the corrected values, so summing both columns double counts. STALE: the newest pay period ends 2026-05-22 (checked 2026-11-03) -- nothing has been imported since, so payroll answers are historic and a "payroll cost this month" question has no data rather than a zero. Totals are easier from payroll_register_monthly_v, payroll_employee_cost_v and payroll_department_cost_v.$d$,
 array['payroll','wages','register','employee pay','hours','gross pay','taxes']),

('payroll_register_monthly_v',
 $d$Payroll by month, and the month-level answer for what payroll costs. Columns: employee_count, register_hours, gross_wages, employer_taxes, payroll_expense, net_pay, ee_taxes, deductions and wage_rate per month_start. The month-level answer for "what does payroll cost". Inherits payroll_register_lines' staleness -- nothing imported past the pay period ending 2026-05-22 as of 2026-11-03, so recent months are absent, not zero.$d$,
 array['payroll','monthly payroll','wages','payroll cost','gross wages','net pay','employer taxes']),

('payroll_employee_cost_v',
 $d$Payroll by employee within a pay period. Columns: gross_earnings, net_pay, employee_tax, employer_tax, total_hours and total_payroll_amount per ee_code per batch, with the pay period and check_date. Employee-level pay is sensitive; RLS is narrow by design. Same staleness as payroll_register_lines.$d$,
 array['payroll','employee cost','per employee','gross earnings','net pay','compensation']),

('payroll_department_cost_v',
 $d$Payroll by department and location within a pay period. Columns: employee_count, total_hours, total_payroll_amount, gross_earnings, net_pay, employee_tax, employer_tax and the time-allocation split (time_hours, register_hours, time_allocation_amount). Same staleness as payroll_register_lines.$d$,
 array['payroll','department cost','labor cost','by department','by location','headcount cost']),

-- Receivables ---------------------------------------------------------------
('ar_invoices',
 $d$Wholesale accounts receivable, one row per invoice or order from the AR sync. Columns: order_date, due_date, term_days, the amount breakdown (gross, discounts, refunds, shipping, taxes, sales_amount, open_amount, paid_amount), days_past_due, aging_bucket ('current', '1-30', '31-60', '61-90', '90+', 'paid'), settlement_class ('open', 'closed', 'paid') and is_open. FROZEN: the newest last_seen_at is 2026-10-12 (checked 2026-11-03) -- the sync was stopped and open AR now lives on the Wholesale Tracking dashboard, so treat every figure here as history and say so. Prefer ar_invoice_workbench_v, which adds the customer's workflow fields.$d$,
 array['ar','receivables','invoices','wholesale','aging','past due','open balance','terms']),

('ar_invoice_workbench_v',
 $d$The collections working view: ar_invoices with the customer's contact and workflow fields joined on. Columns: (effective_customer_name, effective_email, effective_term_days, contact_status, preferred_channel, workflow_priority, assigned_to, last_contacted_at, next_follow_up_at). The collections working view. Inherits ar_invoices' freeze at 2026-10-12.$d$,
 array['ar','collections','receivables','workbench','follow up','aging','past due']),

('ar_customer_rollup_v',
 $d$One row per wholesale customer with their AR position rolled up. Columns: current_open_balance, open_invoice_count, oldest_open_invoice_date, the aging ladder (current_amount, aging_1_30, aging_31_60, aging_61_90, aging_90_plus), total_sales, order counts and the collections workflow fields. The customer-level answer; ar_invoices is the invoice-level one. Same freeze at 2026-10-12.$d$,
 array['ar','customer balance','aging','receivables','wholesale customer','collections','open balance']),

('ar_contact_log',
 $d$Every collections contact sent or logged against a customer, statement or invoice. Columns: contact_type, channel, subject, message_body, sent_to, sent_at and the delivery signals (delivery_status, opened_at, clicked_at, replied_at). Use it for "have we chased them, and did they reply".$d$,
 array['collections','ar','contact','reminder','statement','dunning','email log']),

-- Payables and mail ---------------------------------------------------------
('payment_requests_v',
 $d$AP payment requests, with vendor and assignee names already resolved. Columns: amount_due, due_date, invoice_number, request_type, payment_type, location, the attached file, and workflow_status -- 'new', 'needs_info', 'paid', 'rejected' or 'cancelled'. completed / date_completed are the older completion flags, kept in step with workflow_status. melio_forwarded_at means it was forwarded for payment, NOT that it cleared the bank. Open AP is workflow_status in ('new','needs_info').$d$,
 array['ap','payables','payment request','bills','vendor','invoice','due','unpaid','approve']),

('payment_request_activity_v',
 $d$The audit trail of a payment request, one row per change. Columns: activity_type, field_name, old_value, new_value, message and the actor's name and email. The answer to "who changed, approved or paid this, and when" -- the request row itself carries only the current state.$d$,
 array['ap','audit trail','activity','history','who approved','payment request']),

('mail_items_v',
 $d$Physical mail logged for action. Columns: subject, sender, document_type, priority, received_date, due_date, action_needed, notes and status -- 'open', 'done' or 'archived' -- with the submitter, assignee and processor's names. Attachments are in mail_item_files and the trail in mail_item_activity.$d$,
 array['mail','post','documents','notices','action needed','office']),

-- Purchase orders, shipments, landed cost -----------------------------------
('v_po_header_summary',
 $d$Purchase orders with their totals and arrival picture already computed. Columns: total_units, total_retail_value, total_estimated_cost, current_eta, effective_arrival_date, arrival_variance_days, arrival_state and shipment_count, plus factory_name and date_bucket. PREFER THIS to po_headers for any PO list, total or arrival question -- the header table carries forecast dates only and no arrival column.$d$,
 array['purchase orders','po','open pos','po totals','factory','arrival','eta','units on order']),

('v_po_arrival',
 $d$The arrival picture per purchase order, forecast against actual. Columns: planned_arrival, current_eta, effective_arrival_date, arrival_variance_days, first_ship_date, first_received, last_received, shipment_count, booking_count and arrival_state -- 'not_shipped', 'in_transit', 'partially_received' or 'unknown'. status_conflicts_with_shipments flags a header status that disagrees with its shipments, which is the known gap between po_headers.status and the shipment rows: do not treat arrival_state 'unknown' as not arrived.$d$,
 array['po arrival','eta','late','on time','in transit','received','shipment','purchase order']),

('v_po_shipment_lines',
 $d$One row per PO line per shipment, with the shipment and freight booking joined on. Columns: assigned_qty, sku_snapshot, title_snapshot, status, ship_date, eta, received_date, tracking_number, carrier, container_ref and warehouse_location, and the freight booking's effective_ship_date / effective_eta / effective_arrived_date. THE GRAIN IS LINE x SHIPMENT, so summing line_qty across it double counts a line split over two shipments -- sum assigned_qty for units in transit.$d$,
 array['shipment lines','po lines','in transit','container','tracking','received','sku','freight']),

('incoming_shipment_lines',
 $d$Which PO line, and how many units, are on a shipment: shipment_id plus po_line_id plus qty. Join po_lines for the SKU, or use v_po_shipment_lines, which has already done it.$d$,
 array['shipment lines','units shipped','po line','container','inbound']),

('v_shipment_booking_summary',
 $d$Freight bookings, one row per booking. Columns: forwarder, carrier, mode, container_ref, origin_port, destination_port, etd, eta, ata and effective_eta, with status and the POs on the booking (po_count, po_names, shipment_count, assigned_units). ONE ROW PER BOOKING, AND A BOOKING CAN CARRY SEVERAL POs, so booking-level freight cost does not divide cleanly per PO.$d$,
 array['freight','booking','forwarder','container','etd','eta','ata','shipping','logistics']),

('v_po_costing_summary',
 $d$Landed cost per purchase order. Columns: factory_invoice_amount with its ref and date, freight_amount, duty_pct and duty_amount, misc_amount, alloc_method, fob_total and landed_total, with phase and cost_source saying how firm the numbers are and fob_locked_at / freight_applied_at when they were fixed. line_landed_sum is the sum of the costed lines and should match landed_total -- a gap means header and lines disagree. Freight on a multi-PO booking is not allocated per PO yet, so a landed_total is only as firm as phase says.$d$,
 array['landed cost','costing','freight','duty','fob','po cost','unit cost','margin']),

('product_lead_time_v',
 $d$Observed factory lead time per product_title, measured from the POs actually seen. Columns: median_lead_days and p75_lead_days from the POs actually seen (pos_observed), with the company-wide median as a fallback; lead_days_used and lead_time_source say which number was used and why. Measured from real POs, so a product with few pos_observed is a weak estimate -- read pos_observed before quoting a lead time. Feeds reorder_plan_v.$d$,
 array['lead time','factory','production time','po timing','reorder','planning']),

('reorder_plan_v',
 $d$The reorder recommendation per product_title. Columns: on_hand, on_order, next_arrival, on_order_past_due, velocity from units_90d (daily_velocity, weekly_velocity, days_with_sales, last_sold_date), lead_days with its source, days_of_cover, reorder_point, suggested_order_qty, order_by_date and status. not_planned_because says WHY a product was skipped rather than leaving it silently missing -- read it before concluding nothing needs ordering. velocity_days, review_days and safety_days are the assumptions behind the numbers.$d$,
 array['reorder','replenishment','buy plan','days of cover','stockout','suggested order','planning','on order']),

('demand_coverage_base_v',
 $d$Per product_type: units_12m, units_3m, on_hand and the has_sales_history / has_inventory flags. A coverage denominator for planning, not a forecast -- it holds no projection.$d$,
 array['demand','coverage','product type','units sold','on hand','planning']),

-- Sales, payouts, marketing -------------------------------------------------
('shopify_draft_orders',
 $d$Shopify draft orders: quotes and manual carts that are not orders yet. Columns: status, totals, customer, tags, invoice_sent_at, completed_at, and order_id once one converts. DO NOT COUNT THESE AS SALES; a draft that became an order is also in shopify_orders_v, so adding both double counts.$d$,
 array['draft orders','quotes','wholesale orders','shopify','pending orders']),

('shopify_payouts',
 $d$Shopify Payments payouts, one row per payout. Columns: payout_date, status, amount_net and the gross and fee breakdown (charges, refunds, adjustments, reserved funds, retried payouts). THIS IS CASH SETTLED TO THE BANK, NOT SALES -- it is net of fees and refunds and lands days after the orders it pays for, so it never ties to a day's net sales and should not be used to answer "how much did we sell".$d$,
 array['payouts','shopify payments','cash','deposits','fees','settlement','bank']),

('shopify_attribution_days',
 $d$The daily attribution snapshot ledger, one row per connection per day per ledger. Columns: net_cents and total_cents in the shop's own currency and shop_timezone, and extracted_at when it was captured. AMOUNTS ARE CENTS, not dollars. Coverage is per store and was backfilled in windows, so check which days are actually present before trusting a range -- a missing day is an unbuilt snapshot, not a day without sales.$d$,
 array['attribution','snapshot','shopify','channel revenue','cents','daily']),

('silo_attribution_campaigns_v',
 $d$The distinct campaign ids and names seen per platform, for naming and filtering campaigns. A lookup with no measures -- spend and revenue are in marketing_kpis_daily.$d$,
 array['campaigns','campaign names','attribution','platform','lookup']),

('search_console_query_rollup_v',
 $d$Google Search Console keywords rolled up over a window. Columns: clicks, impressions, position (impression-weighted, via position_weight), days_present and the window_start..window_end it covers. keyword_norm is the lowercased join key. SEARCH CONSOLE CAPS THE QUERIES IT RETURNS, so this is the head of the tail and never the whole of it -- totals here are lower bounds, and "we rank for nothing else" does not follow.$d$,
 array['seo','search console','keywords','queries','clicks','impressions','position','organic']),

('facebook_page_insights_daily',
 $d$Daily Facebook Page metrics: page_impressions, page_reach, page_engaged_users, page_post_engagements and page_fan_count per day_date. ORGANIC PAGE performance, not ads -- ad spend and ad revenue are in marketing_kpis_daily and meta_ad_performance_daily, and the two must not be added together.$d$,
 array['facebook','page','organic','reach','impressions','engagement','followers','social']),

('instagram_account_insights_daily',
 $d$Daily Instagram account reach per day_date. Reach is the ONLY metric Meta returns at account level here, so impressions, profile views and follower counts are absent rather than zero, and the series is short (37 days on 2026-11-03).$d$,
 array['instagram','reach','organic','social','account insights']),

('wow_sales_daily_type_v',
 $d$Daily sales by location_tag and product_type: total_sales, total_net_sales, total_refunds, total_gross_sales and total_quantity_sold. The input to the week-over-week report. total_net_sales is the sales number; total_gross_sales is pre-discount merchandise and is not Shopify Analytics' "Gross sales" card.$d$,
 array['sales','week over week','wow','product type','by location','net sales','daily sales']),

('sales_exception_summary_v',
 $d$Data-quality counts per location from the sales sync. Columns: refund_discrepancy_rows, blank_sku_rows, negative_net_rows, sync_batches and last_synced_at. READ THIS BEFORE TRUSTING A SALES TOTAL, and treat a stale last_synced_at as a sync that has not landed rather than a quiet period -- a missing day in sales is almost never a day with no sales.$d$,
 array['data quality','sales exceptions','sync','freshness','last synced','refunds','blank sku']),

('shopify_channel_map',
 $d$Maps Shopify's raw source_name to the display_name SILO shows, per company. An unmapped source_name means the channel has no name here, not that it is new or small -- say it is unmapped and suggest adding it rather than guessing what the slug means.$d$,
 array['channel','source name','shopify','channel names','mapping','lookup']),

('shopify_location_mappings',
 $d$Maps a Shopify location id to SILO's location_code, per connection, with is_sales_only for locations that sell but hold no stock. The join behind every per-store number; an unmapped Shopify location is why a store can show sales with no inventory or vice versa.$d$,
 array['locations','stores','location mapping','shopify location','location code','lookup']),

('product_tags',
 $d$The merchandising tag sheet per product_title. Columns: product_category, collection, type, primary_color, artwork_side, tag and sub_tag, indicator_group, and a current_inventory column that came in with the upload. UPLOADED IN BULK AND STALE -- the only upload was 2026-04-16 (checked 2026-11-03), so current_inventory is a snapshot of that spreadsheet and NOT live stock; use inventory_workboard_v for anything about on-hand. The tags themselves are still the merchandising taxonomy.$d$,
 array['tags','merchandising','collection','color','artwork','category','product attributes']),

('inventory_workboard_mv',
 $d$The materialized view behind inventory_workboard_v -- same columns, without RLS. READ THE VIEW, not this: the view is the supported surface and carries the tenant boundary.$d$,
 array['inventory','matview','internal','on hand']),

-- Work, people, platform ----------------------------------------------------
('tasks_v',
 $d$Tasks with their assignee and parent launch or initiative resolved. Columns: task_title, task_type, status ('open' or 'done'), priority, due_date, assigned_to_name, estimated_minutes, completed_at and completed_by, plus the launch or initiative they hang off (launch_title, launch_date, initiative_title, initiative_channel, parent_kind, parent_title). task_type IS FREE TEXT, not an enum -- observed values mix taxonomies ('creative', 'email', 'website', 'Attribution review', 'Lower Funnel'), so do not treat it as a closed list. is_private rows are visible only to those allowed to see them, so a count can legitimately differ between users.$d$,
 array['tasks','to do','open work','assigned','due','launch tasks','workload']),

('launch_tasks',
 $d$The base table behind tasks_v, keyed to launch_id and optionally channel_item_id. Prefer tasks_v, which resolves assignee names and the parent launch or initiative.$d$,
 array['tasks','launch tasks','base table','to do']),

('profiles',
 $d$One row per user account, across every company. Columns: name, email, role, department, is_active, active_company_id (the company their session is scoped to) and default_page. role and department here are the LEGACY GLOBAL fields -- the role that governs a company is in entity_memberships, and this table spans every company, so it is not a headcount of one. Nothing here grants access; RLS does.$d$,
 array['users','people','profiles','accounts','roles','department','who']),

('entity_memberships',
 $d$Which users belong to which company and with what role -- 'owner_admin', 'admin', 'member' or 'viewer'. entity_id is the company. THIS, not profiles.role, is the per-company role, and it is what every permission gate judges. For "who is on the team", count rows here for the company rather than rows in profiles.$d$,
 array['membership','team','roles','who has access','company users','permissions']),

('entities',
 $d$The generic object registry: module, entity_type, entity_key, title and meta, which comments and state attach to. Companies are entities too, which is why entity_memberships.entity_id is a company id. Plumbing for other features rather than a business table.$d$,
 array['entities','registry','companies','objects','internal']),

('comp_adjustment_requests_v',
 $d$Compensation and title change requests, with employee and reviewer names resolved. Columns: adjustment_type, current and proposed compensation, current and proposed title, effective_date, justification, status, finance_notes and the decision trail (reviewed_by, decided_at). A manager may file one for themselves by design. Individual pay is sensitive and RLS is deliberately narrow, so a count here can differ between users.$d$,
 array['compensation','raise','comp request','salary','title change','promotion','hr']),

('product_samples_v',
 $d$The sample tracker, one row per sample. Columns: sample_ref, product_title, factory_name, product_type, collection, bulk_eta, the per-stage dates (sent_at, received_at, warehouse_ready_at, picked_up_at, photo_received_at) and sample_status -- values seen on 2026-11-03 are 'pps_received', 'received', 'full_run_received', 'warehouse_ready' and 'picked_up'. size_requests, sizes_ready_warehouse and sizes_picked_up are the size-level detail, and photo_status / copy_status / live_status track the content work. Links to its launch and PO.$d$,
 array['samples','sample tracker','pps','photo','factory','product development','launch']),

('customer_accounts_v',
 $d$Wholesale customer account applications and their state. Columns: account_type, status ('invited', 'submitted', 'approved', 'rejected'), legal_name and dba_name, website, requested_payment_terms against approved_payment_terms, credit_limit, price_tier, the primary contact, and the decision trail. For payment method read has_card_on_file and card_is_invoice_default, not the raw card_setup_* columns -- those track the setup session, not whether a card is usable.$d$,
 array['wholesale','customer accounts','applications','onboarding','credit','terms','approved']),

('revenue_projection_history',
 $d$The audit trail of revenue_projections, one row per change. It carries action_type, changed_at, changed_by and the projected_units / projected_sales as of that change. HISTORY, NOT THE PLAN -- the current projection is in revenue_projections, which was last written 2026-09-22 (checked 2026-11-03), so projections are stale and should be dated in any answer.$d$,
 array['projections','forecast','revenue plan','history','audit trail','budget']),

('silo_report_tieouts',
 $d$The reconciliation checks attached to SILO's built-in reports, one row per check. Columns: report_id, kind, check_sql, tolerance, enabled and a note. THIS IS WHAT "VERIFIED" MEANS for a built-in report -- the nightly tie-out job runs these. A saved company report has no row here, which is why it is labelled unverified.$d$,
 array['tie out','reconciliation','verified','report checks','trust','data quality']),

('silo_chat_saved_reports_v',
 $d$Saved reports people built themselves, through Ask SILO or the report builder. Columns: title, description, the original question, the SQL that ran (queries_run), parameters, columns_metadata, visibility and row_estimate. THESE ARE NOT TIE-OUT VERIFIED -- they are somebody's saved working, so use one when it is asked for by name and prefer a built-in report otherwise. visibility decides who else can see it.$d$,
 array['saved reports','my reports','report builder','ask silo','shared reports']),

('sync_jobs',
 $d$$d$,
 array['sync','sync status','freshness','last sync','backfill','job','integration','stale','did it run'])
)

-- Rule 1: keywords always. Rule 2: description only where it is null, so a
-- curated one (sync_jobs' skip/partial-failure warning) survives. The empty
-- string in the seed above is the shape that rule needs for sync_jobs -- it
-- carries keywords only, and the case below leaves its description alone.
update public.silo_chat_schema_catalog k
   set keywords = s.keywords,
       description = case
         when k.description is not null and btrim(k.description) <> '' then k.description
         else nullif(btrim(s.description), '')
       end,
       updated_at = now()
  from seed s
 where k.relname = s.relname;

-- Rule 3: a name that is not in the catalog is a typo, not a no-op. The names
-- are repeated here rather than read back from the seed, because the seed lives
-- inside the statement above and nothing outside it can see it -- which is the
-- point: this block stands on its own, whatever applies the file.
do $$
declare
  v_missing text[];
begin
  select array_agg(r order by r) into v_missing
    from unnest(array[
    'ledger_entries', 'ledger_lines', 'silo_ledger_lines_v',
    'accounting_accounts', 'accounting_coa_map',
    'accounting_journal_register', 'journal_adjustments_v',
    'journal_adjustment_lines', 'schedule_items', 'schedule_item_balances_v',
    'fixed_asset_balances_v', 'card_transactions_v',
    'card_coding_effective_lines', 'card_coding_suggestions_v',
    'card_coding_rules', 'payroll_register_lines',
    'payroll_register_monthly_v', 'payroll_employee_cost_v',
    'payroll_department_cost_v', 'ar_invoices', 'ar_invoice_workbench_v',
    'ar_customer_rollup_v', 'ar_contact_log', 'payment_requests_v',
    'payment_request_activity_v', 'mail_items_v', 'v_po_header_summary',
    'v_po_arrival', 'v_po_shipment_lines', 'incoming_shipment_lines',
    'v_shipment_booking_summary', 'v_po_costing_summary',
    'product_lead_time_v', 'reorder_plan_v', 'demand_coverage_base_v',
    'shopify_draft_orders', 'shopify_payouts', 'shopify_attribution_days',
    'silo_attribution_campaigns_v', 'search_console_query_rollup_v',
    'facebook_page_insights_daily', 'instagram_account_insights_daily',
    'wow_sales_daily_type_v', 'sales_exception_summary_v',
    'shopify_channel_map', 'shopify_location_mappings', 'product_tags',
    'inventory_workboard_mv', 'tasks_v', 'launch_tasks', 'profiles',
    'entity_memberships', 'entities', 'comp_adjustment_requests_v',
    'product_samples_v', 'customer_accounts_v', 'revenue_projection_history',
    'silo_report_tieouts', 'silo_chat_saved_reports_v', 'sync_jobs'
    ]) r
   where not exists (
     select 1 from public.silo_chat_schema_catalog k where k.relname = r
   );
  if v_missing is not null then
    raise exception 'chat catalog seed names absent from silo_chat_schema_catalog: %',
      array_to_string(v_missing, ', ');
  end if;
end $$;

commit;
