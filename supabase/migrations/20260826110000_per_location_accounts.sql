-- Per-location revenue and refund accounts, replacing the {location} name
-- templates in accounting_coa_map.
--
-- WHY THE TEMPLATES CANNOT WORK. accounting_coa_map.revenue_template and
-- refunds_template expand "{location}" into an account NAME. That assumes one
-- naming convention. Baseballism's CPA-approved chart of accounts has at least
-- three, verified against the live QuickBooks company 2026-08-26:
--
--   In Store Retail Revenue - Shopify (Atlanta)        <- convention A
--   In Store Retail Sales Revenue - Shopify (Texas)    <- convention B ("Sales")
--   In Store Retail Revenue - (Shopify Hohokam)        <- parens misplaced
--
-- Refunds are worse: "Sales Refunds - (Texas)", "Sales Refund (Texas)" and
-- "Sales Refunds - Shopify (Goodyear)" all coexist. Measured against the real
-- file, a single template resolved for only 13 of 21 mapped locations -- the
-- misses included Field of Dreams, Texas, Sacramento, Goodyear and Allen,
-- roughly $2.6M of 2026 revenue that would have posted to account names that do
-- not exist.
--
-- The fix is the same one used for the accounts themselves: bind to QuickBooks
-- account IDs per location and stop deriving names. An id does not care what
-- the account is called or which convention it was created under.
--
-- accounting_location_map already holds exactly one row per sales location, so
-- these belong there rather than in a new table.

alter table public.accounting_location_map
  add column if not exists qbo_revenue_account_id   text,
  add column if not exists qbo_revenue_account_name text,
  add column if not exists qbo_refunds_account_id   text,
  add column if not exists qbo_refunds_account_name text;

comment on column public.accounting_location_map.qbo_revenue_account_id is
  'QBO Account.Id this location''s sales revenue posts to. Replaces accounting_coa_map.revenue_template, whose {location} name expansion cannot survive three competing naming conventions in the real chart of accounts.';

comment on column public.accounting_location_map.qbo_refunds_account_id is
  'QBO Account.Id this location''s refunds post to. Replaces accounting_coa_map.refunds_template, for the same reason.';

select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog set
  keywords = array['location mapping','store mapping','location tag','qbo location',
                   'revenue account by location','refund account by location','accounting export locations'],
  description = $d$Maps a SILO sales location (sales_by_day.location_tag, the key accounting_sales_buckets() emits) to a QuickBooks location id AND to that location's own revenue and refund account ids. Keyed on location_tag rather than locations.location_code, which is inconsistently formatted -- only 10 of 19 tags match it exactly, so routing through the locations table would silently drop real revenue locations. The per-location account columns exist because Baseballism's chart of accounts uses at least three naming conventions for store revenue accounts ("In Store Retail Revenue - Shopify (X)", "In Store Retail Sales Revenue - Shopify (X)", and a parens-misplaced variant), so a name template resolved for only 13 of 21 locations. Binding to account ids removes the naming problem entirely.$d$
where relname = 'accounting_location_map';
