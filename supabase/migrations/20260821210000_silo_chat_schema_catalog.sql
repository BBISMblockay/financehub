-- Ask SILO schema catalog + health view.
--
-- Why: every column-name failure this week (inventory_workboard_v's
-- "on_hand", launch_calendar's "launch_window_start", po_lines'
-- "sku"-vs-sku_snapshot, factories "name" vs factory_name) traced to the
-- same root cause -- the schema facts Ask SILO relies on were hand-typed
-- English inside silo-chat/index.ts's system prompt, and hand-typed facts
-- rot. Three different band-aids accumulated (more prompt notes, taught
-- notes, live error-text correction). This replaces the fact-maintenance
-- problem at the root:
--
--   silo_chat_schema_catalog -- one row per public table/view/matview.
--   Column names/types are AUTO-GENERATED from pg_catalog by
--   refresh_chat_schema_catalog() and cannot drift from reality; the
--   curated business-meaning fields (description/keywords, seeded below
--   from the prompt's existing cheat-sheet text so nothing is lost) are
--   preserved across refreshes. The silo-chat edge function reads this
--   per request and injects (a) a compact index of everything plus
--   (b) full column detail for the tables most relevant to the question.
--
-- Refresh cadence: run refresh_chat_schema_catalog() after applying any
-- migration that changes public tables/views (verify_v2_schema.sql now
-- flags staleness via a column-count spot check). The function is
-- service-role/postgres only -- clients can read the catalog, never
-- write it.
--
-- Also adds silo_chat_health_v: the per-day Ask SILO reliability
-- scoreboard over silo_chat_audit_log (questions, errors, forced finals,
-- round percentiles). security_invoker, so each caller sees stats over
-- exactly the audit rows their RLS lets them see.

create table if not exists public.silo_chat_schema_catalog (
  relname text primary key,
  relkind text not null,
  columns jsonb not null default '[]'::jsonb,
  description text,
  keywords text[],
  is_hidden boolean not null default false,
  auto_refreshed_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.silo_chat_schema_catalog enable row level security;

-- Read-only for signed-in users (the edge function reads with the caller's
-- JWT). Schema *names* are not secrets -- any authenticated user can
-- already enumerate them via information_schema through chat SQL; RLS on
-- the actual tables remains the data boundary. No insert/update/delete
-- policies: client writes are denied outright.
drop policy if exists silo_chat_schema_catalog_select on public.silo_chat_schema_catalog;
create policy silo_chat_schema_catalog_select on public.silo_chat_schema_catalog
  for select using (auth.role() = 'authenticated');

revoke all on public.silo_chat_schema_catalog from anon;
grant select on public.silo_chat_schema_catalog to authenticated;

create or replace function public.refresh_chat_schema_catalog()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into public.silo_chat_schema_catalog (relname, relkind, columns, auto_refreshed_at)
  select
    c.relname,
    case c.relkind when 'r' then 'table' when 'p' then 'table'
                   when 'v' then 'view' when 'm' then 'matview' end,
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', a.attname,
               'type', format_type(a.atttypid, a.atttypmod)
             ) order by a.attnum)
      from pg_attribute a
      where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    ), '[]'::jsonb),
    now()
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
  on conflict (relname) do update
    set relkind = excluded.relkind,
        columns = excluded.columns,
        auto_refreshed_at = excluded.auto_refreshed_at,
        updated_at = now();

  delete from public.silo_chat_schema_catalog s
  where not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = s.relname
      and c.relkind in ('r', 'p', 'v', 'm')
  );

  select count(*) into v_count from public.silo_chat_schema_catalog;
  return v_count;
end;
$$;

revoke execute on function public.refresh_chat_schema_catalog() from public, anon, authenticated;
grant execute on function public.refresh_chat_schema_catalog() to service_role;

select public.refresh_chat_schema_catalog();

-- Hide secret-carrying / token / internal-plumbing tables from the model's
-- index. This is noise reduction and not-advertising-secret-stores, NOT
-- security -- their RLS already denies or scopes reads regardless.
update public.silo_chat_schema_catalog set is_hidden = true
where relname in (
  'org_invites', 'review_access_tokens', 'ad_platform_oauth_states',
  'shopify_oauth_states', 'ad_platform_connections', 'shopify_connections',
  'redo_connections', 'job_sync_state', 'silo_chat_schema_catalog'
);

-- ---------------------------------------------------------------------------
-- Curated business meaning, ported VERBATIM from the cheat-sheet block that
-- lived in silo-chat/index.ts's BASE_SYSTEM_PROMPT (removed there in the
-- same PR). Preserved across refreshes; edit here (or directly in the
-- table) rather than in the edge function from now on.
-- ---------------------------------------------------------------------------

update public.silo_chat_schema_catalog set
  keywords = array['sales','revenue','sold','units','daily','net','gross','refunds'],
  description = $d$Daily sales rollup by location/SKU. One row per day x location x SKU. Prefer sales_by_day_verification_v (de-duped) for cross-source date ranges.$d$
where relname = 'sales_by_day';

update public.silo_chat_schema_catalog set
  keywords = array['sales','revenue','sold','units','daily','dedupe'],
  description = $d$De-duped view over sales_by_day (prefers shopify_api source). Use this rather than raw sales_by_day when a date range may span both Better Reports history and Shopify API rows.$d$
where relname = 'sales_by_day_verification_v';

update public.silo_chat_schema_catalog set
  keywords = array['velocity','sell-through','rollup','monthly'],
  description = $d$Pre-aggregated sales rollups (with sales_monthly_location_rollup_v / sales_monthly_product_type_rollup_v) -- faster than grouping sales_by_day yourself for monthly/SKU-level questions.$d$
where relname = 'sales_velocity_by_sku_location_v';

update public.silo_chat_schema_catalog set
  keywords = array['inventory','stock','on-hand','restock','oos','warehouse'],
  description = $d$Current inventory by SKU/location with sell-through metrics -- already the LATEST snapshot only (one row per variant_sku x location, no need to dedupe by snapshot_at). The SKU column is variant_sku, not sku. There is no on_hand or sell_through_rate column -- on-hand is total_available_quantity; compute sell-through from qty_sold_30d and total_available_quantity. Velocity windows: qty_7d/qty_30d/qty_90d/qty_365d and avg_day_7/avg_day_30/avg_day_90/avg_day_365, plus est_days_before_oos and last_sold_date. When computing velocity or days-of-supply for a recently launched product, bound the window at the product's first sale date -- a fixed lookback longer than the product's life makes new launches read as dead stock.$d$
where relname = 'inventory_workboard_v';

update public.silo_chat_schema_catalog set
  keywords = array['inventory','stock','snapshot','history'],
  description = $d$Raw inventory snapshots over time (large -- 3.5M+ rows). The SKU column is variant_sku. For "current inventory" questions use inventory_workboard_v or inventory_on_hand_current_v instead; only query this directly for snapshot history.$d$
where relname = 'inventory_on_hand';

update public.silo_chat_schema_catalog set
  keywords = array['catalog','product','sku','cost','msrp','lifecycle'],
  description = $d$Product catalog. The vendor column is vendor_original (not vendor); cost is unit_cost (not cost). category and product_type are always identical (fully redundant) -- use either, don't waste a round checking both. department is sparse (~7% populated) -- don't rely on it for filtering. category/product_type hold granular values (e.g. "Youth Cap", "Youth Jacket") -- match a broad group with ilike 'Youth%' rather than = 'Youth'. Exception: Women's product_type is the bare exact value 'Women' -- go straight to product_type = 'Women' and narrow with product_title.$d$
where relname = 'products_master';

update public.silo_chat_schema_catalog set
  keywords = array['purchase','order','po','factory','incoming','buy'],
  description = $d$Purchase order headers. po_lines joins on po_lines.po_header_id = po_headers.id (not po_id). See also v_po_header_summary / v_open_pos and incoming_shipments for inbound tracking.$d$
where relname = 'po_headers';

update public.silo_chat_schema_catalog set
  keywords = array['purchase','order','po','lines','sku','qty'],
  description = $d$PO line items. Joins to po_headers on po_header_id. The SKU column is sku_snapshot (there is no sku column); quantity is qty; the title columns are title_snapshot / variant_title_snapshot.$d$
where relname = 'po_lines';

update public.silo_chat_schema_catalog set
  keywords = array['supplier','factory','vendor'],
  description = $d$Supplier/factory directory. The name column is factory_name (not name).$d$
where relname = 'factories';

update public.silo_chat_schema_catalog set
  keywords = array['payables','ap','payment','request','invoice','reimbursement'],
  description = $d$AP payment/approval requests and status. Prefer payment_requests_v for names/enrichment.$d$
where relname = 'payment_requests';

update public.silo_chat_schema_catalog set
  keywords = array['receivables','ar','invoice','wholesale','aging','customer'],
  description = $d$Accounts receivable -- wholesale customer balances and aging (with ar_invoices / ar_customer_rollup_v).$d$
where relname = 'ar_customers';

update public.silo_chat_schema_catalog set
  keywords = array['marketing','ads','spend','campaign','google','meta','tiktok','ga4','roas'],
  description = $d$Daily ad spend/revenue by platform (google_ads, meta_ads, tiktok_ads, ga4), campaign-level. The authoritative ledger for real ad spend by platform/day.$d$
where relname = 'marketing_kpis_daily';

update public.silo_chat_schema_catalog set
  keywords = array['meta','facebook','ads','creative','cpm','cac','ad-level'],
  description = $d$Ad-level (not just campaign-level) Meta performance. Joins to meta_ad_creatives(ad_id, creative_id, thumbnail_url, body, title, object_type, effective_status) on ad_id for creative metadata. object_type observed values are SHARE (single image/link ad), VIDEO, and STATUS (text-only) -- not a literal image/video/carousel taxonomy. body is the ad copy, title is the headline. For actual visual design call view_ad_creative_image with the ad_id -- sparingly, only for the specific ads the question is about. Compute CPM as spend/impressions*1000 and CAC as spend/conversions.$d$
where relname = 'meta_ad_performance_daily';

update public.silo_chat_schema_catalog set
  keywords = array['mer','marketing','efficiency','spend','blended'],
  description = $d$Ad spend vs. Shopify online net sales by day. This view's spend column is ad_spend, but meta_ad_performance_daily's is just spend -- same concept, different name per table; don't assume a column name carries over between tables.$d$
where relname = 'v_marketing_mer_daily';

update public.silo_chat_schema_catalog set
  keywords = array['orders','shopify','channel','customer','aov','pos','order'],
  description = $d$One row per Shopify order -- the pre-aggregation counterpart to sales_by_day. Use this (not sales_by_day) for individual orders, sales channel/source, customer-level order history, or AOV by channel. source_name is Shopify's raw channel field ("web", "pos", or an app id/slug for TikTok/Faire/Instagram); resolved_channel_name is the human-readable name from shopify_channel_map when mapped. total_price is the order's full total (subtotal + shipping + tax, before refunds) -- NOT the same metric as sales_by_day's total_gross_sales (pre-discount merchandise only) or Shopify Analytics' "Total sales"/"Gross sales" cards; never call total_price "gross sales", describe it as "order total" and flag the difference when a user compares against a Shopify Analytics screenshot. Coverage caveat: rows before a store's first full backfill are sparse, not absent -- min(shopify_created_at) alone does NOT prove continuous coverage; check for gaps (count distinct order dates vs. calendar days in range) before trusting a range wider than a few months, and say so if coverage looks discontinuous. If a source_name shows up unmapped, say so and suggest adding it to shopify_channel_map rather than guessing.$d$
where relname = 'shopify_orders_v';

update public.silo_chat_schema_catalog set
  keywords = array['basket','line','items','attach','together','order'],
  description = $d$Per-SKU line items within each Shopify order (quantity, price, discount_allocated, tax_allocated, vendor, product_type) -- for basket-level questions (attach rate, what's bought together). title is the as-sold line-item title, reliable even where SKUs are shared across products.$d$
where relname = 'shopify_order_lines';

update public.silo_chat_schema_catalog set
  keywords = array['returns','exchanges','refund','redo','store-credit','reason'],
  description = $d$Returns/exchanges/store-credit data from Redo (refund_amount, exchange_amount, store_credit_amount, status, reason; line items in redo_return_items). Covers only a recent slice of total Shopify refund volume -- not complete returns history.$d$
where relname = 'redo_returns';

update public.silo_chat_schema_catalog set
  keywords = array['projection','plan','forecast','budget','revenue'],
  description = $d$Monthly revenue plan by location + type (history in revenue_projection_history).$d$
where relname = 'revenue_projections';

update public.silo_chat_schema_catalog set
  keywords = array['launch','marketing','campaign','drop','collab','brief','angle','audience'],
  description = $d$Marketing launch pipeline. The name column is title (not launch_name or name); date columns are launch_date and preview_start_date -- there is no launch_window_start/launch_window_end or start_date/end_date. Other real columns: product_sku, product_title, collection_name, expected_units, status, launch_type. Holds each launch's release brief -- design_intent, product_callouts, marketing_angle, audience_tags (text[] -- prefer over the free-text audience column for comparing/grouping, e.g. unnest(audience_tags)), audience, special_callouts, copy_dos/copy_donts, creative_dos/creative_donts -- plus budget/forecast (preview_marketing_budget, post_launch_budget, projected_revenue) and after-the-fact performance (actual_preview_spend, actual_post_launch_spend, actual_revenue, performance_comparison, overperformed_notes, underperformed_notes). The primary source for "what angle/audience has this brand actually used, and did it work" -- more authoritative than inferring strategy from sales data alone. Note: actual_preview_spend/actual_post_launch_spend are hand-typed estimates, NOT synced from ad platforms -- marketing_kpis_daily is the authoritative spend ledger; if a question is specifically about ad spend accuracy, prefer marketing_kpis_daily and say so if the two differ. Related: launch_tasks / launch_channel_items / launch_product_readiness.$d$
where relname = 'launch_calendar';

update public.silo_chat_schema_catalog set
  keywords = array['locations','stores','channels'],
  description = $d$Sales channels/store locations.$d$
where relname = 'locations';

update public.silo_chat_schema_catalog set
  keywords = array['mail','mailroom','queue'],
  description = $d$Mailroom queue (mail_items_v joins assignee/submitter names).$d$
where relname = 'mail_items';

update public.silo_chat_schema_catalog set
  keywords = array['tiktok','live','schedule','payout','host'],
  description = $d$TikTok Live schedule and payouts (live_sessions_v joins claimer name).$d$
where relname = 'live_sessions';

update public.silo_chat_schema_catalog set
  keywords = array['calendar','events','dates','deadline'],
  description = $d$Org calendar -- one time layer over launches, tasks, POs, AP, paydays, live slots and mail.$d$
where relname = 'calendar_events_v';

update public.silo_chat_schema_catalog set
  keywords = array['employees','reviews','roster','performance'],
  description = $d$Performance review roster (with reviews). Careful: private_notes and similar are RLS-gated to the author only, so zero rows can come back even with a correct query -- expected, not a bug.$d$
where relname = 'employees';

update public.silo_chat_schema_catalog set
  keywords = array['notes','taught','knowledge','corrections','brand'],
  description = $d$Everything the team has taught Ask SILO -- brand context and specific corrections (see the save_note tool). silo_chat_notes_v joins author names.$d$
where relname = 'silo_chat_notes';

update public.silo_chat_schema_catalog set
  keywords = array['concepts','product','draft','idea','brief'],
  description = $d$Ask SILO's Product Concepts drafts (parent/child collections, launch-plan brief fields, approval status). product_concepts_v joins parent title and resulting PO name.$d$
where relname = 'product_concepts';

-- ---------------------------------------------------------------------------
-- Ask SILO health scoreboard -- one row per day. security_invoker: each
-- caller sees stats over exactly the audit rows their RLS lets them see.
-- ---------------------------------------------------------------------------
create or replace view public.silo_chat_health_v
with (security_invoker = true) as
select
  date_trunc('day', created_at)::date as day,
  count(*) as questions,
  count(*) filter (where status = 'error') as errors,
  round(100.0 * count(*) filter (where status = 'error') / count(*), 1) as error_pct,
  count(*) filter (where error_message = 'forced final answer at round cap') as forced_finals,
  round(avg(tool_rounds), 1) as avg_rounds,
  (percentile_cont(0.9) within group (order by tool_rounds))::numeric(6,1) as p90_rounds,
  count(distinct created_by) as distinct_users
from public.silo_chat_audit_log
group by 1;

revoke all on public.silo_chat_health_v from anon;
grant select on public.silo_chat_health_v to authenticated;
