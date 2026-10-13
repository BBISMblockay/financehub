-- Shopify order facts are keyed PER COMPANY, so one store can sync into two.
--
-- shopify_orders (shop_domain, order_id), shopify_order_lines (shop_domain,
-- order_id, line_item_id), shopify_draft_orders (shop_domain, draft_order_id)
-- and shopify_payouts (payout_id) were unique WITHOUT company_entity_id. Every
-- sync upserts on those keys with the service role, so a second company's sync
-- of a store another company already syncs did not get its own copy: it
-- REWROTE the existing rows' company_entity_id and moved the orders between
-- tenants. PR #971 guarded against that by refusing the second company
-- (scripts/lib/shopify-tenant-guard.mjs); this is the real fix, after which the
-- same store connected under two companies (baseballismmlb under Baseballism
-- and BlockayOps, 2026-10-13) holds one copy of its order facts per company.
--
-- Each new key LEADS with the old one's columns and appends company_entity_id,
-- so lookups by shop_domain (the compliance webhook's redactions, the tenant
-- guard) stay index-backed. company_entity_id is NOT NULL on all four tables
-- with no NULL rows (checked live 2026-10-13), so the keys are real.
--
-- ORDER OF OPERATIONS: CODE FIRST. Merge the PR that adds
-- scripts/lib/shopify-order-fact-keys.mjs, deploy shopify-sync-run AND
-- ad-platform-sync-run, then apply this. That code upserts on the
-- per-company key and falls back to the old key while this is unapplied, so
-- it is safe before the migration. Code WITHOUT it upserts on the old key
-- only and fails (42P10) once this drops it -- a function still running the
-- old bundle would stop syncing orders. shopify_order_facts_keyed_by_company()
-- is how the tenant guard knows this has applied and stands aside.
--
-- Idempotent: each index and constraint is created only if missing, and the
-- old ones are dropped with IF EXISTS. Existing rows cannot violate the new
-- keys: each is the old (unique) key plus a column.
--
-- LOCKING: shopify_order_lines is ~2.3M rows / 1.9 GB and shopify_orders
-- ~720k / 500 MB (2026-10-13). Each new key is built as a plain unique index
-- first -- a SHARE lock, so reports and Ask SILO keep reading while it builds;
-- only writes (the sync) wait -- and then attached as the constraint, which is
-- instant. Apply outside the Shopify sync window (it runs from 08:00 UTC). To
-- avoid even the write wait, build the two large indexes beforehand, outside a
-- transaction:
--   create unique index concurrently shopify_order_lines_shop_order_line_company_key
--     on public.shopify_order_lines (shop_domain, order_id, line_item_id, company_entity_id);
--   create unique index concurrently shopify_orders_shop_order_company_key
--     on public.shopify_orders (shop_domain, order_id, company_entity_id);
-- and this migration adopts them by name. A failed concurrent build leaves an
-- INVALID index, which the attach below refuses loudly; drop it and rerun.
set statement_timeout = 0;

create unique index if not exists shopify_orders_shop_order_company_key
  on public.shopify_orders (shop_domain, order_id, company_entity_id);
create unique index if not exists shopify_order_lines_shop_order_line_company_key
  on public.shopify_order_lines (shop_domain, order_id, line_item_id, company_entity_id);
create unique index if not exists shopify_draft_orders_shop_draft_company_key
  on public.shopify_draft_orders (shop_domain, draft_order_id, company_entity_id);
create unique index if not exists shopify_payouts_payout_company_key
  on public.shopify_payouts (payout_id, company_entity_id);

do $$
declare
  k record;
begin
  for k in select * from (values
    ('shopify_orders', 'shopify_orders_shop_order_company_key'),
    ('shopify_order_lines', 'shopify_order_lines_shop_order_line_company_key'),
    ('shopify_draft_orders', 'shopify_draft_orders_shop_draft_company_key'),
    ('shopify_payouts', 'shopify_payouts_payout_company_key')) as v(tbl, name)
  loop
    if not exists (select 1 from pg_constraint
                   where conrelid = format('public.%I', k.tbl)::regclass and conname = k.name) then
      execute format('alter table public.%I add constraint %I unique using index %I', k.tbl, k.name, k.name);
    end if;
  end loop;
end $$;

-- The company-less keys go: while they stand, a second company's insert of an
-- order the first already holds is a unique violation, not a second copy.
alter table public.shopify_orders drop constraint if exists shopify_orders_shop_domain_order_id_key;
alter table public.shopify_order_lines drop constraint if exists shopify_order_lines_shop_domain_order_id_line_item_id_key;
alter table public.shopify_draft_orders drop constraint if exists shopify_draft_orders_shop_domain_draft_order_id_key;
alter table public.shopify_payouts drop constraint if exists shopify_payouts_payout_id_key;

-- Has this migration applied? Read by the tenant guard with the service role:
-- once true, a second company syncing the same store is safe and the guard
-- stands aside. True only when all four per-company keys exist AND none of the
-- company-less ones does, so a half-applied state keeps the guard on.
create or replace function public.shopify_order_facts_keyed_by_company()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- Matched on (table, name), so a same-named constraint elsewhere cannot
  -- make a half-applied state look applied.
  select
    (select count(*) from pg_constraint
      where (conrelid::regclass::text, conname) in (
        ('shopify_orders', 'shopify_orders_shop_order_company_key'),
        ('shopify_order_lines', 'shopify_order_lines_shop_order_line_company_key'),
        ('shopify_draft_orders', 'shopify_draft_orders_shop_draft_company_key'),
        ('shopify_payouts', 'shopify_payouts_payout_company_key'))
        and contype = 'u') = 4
    and not exists (select 1 from pg_constraint
      where (conrelid::regclass::text, conname) in (
        ('shopify_orders', 'shopify_orders_shop_domain_order_id_key'),
        ('shopify_order_lines', 'shopify_order_lines_shop_domain_order_id_line_item_id_key'),
        ('shopify_draft_orders', 'shopify_draft_orders_shop_domain_draft_order_id_key'),
        ('shopify_payouts', 'shopify_payouts_payout_id_key')))
$$;

comment on function public.shopify_order_facts_keyed_by_company() is
  'True once 20261013220000 has applied: shopify order facts are unique per company, so one store may sync into two companies. Read by scripts/lib/shopify-tenant-guard.mjs with the service role; not client-callable.';

-- Service role only. Supabase re-grants EXECUTE on new public functions to
-- anon and authenticated by default, so revoke from both explicitly.
revoke all on function public.shopify_order_facts_keyed_by_company() from public;
revoke all on function public.shopify_order_facts_keyed_by_company() from anon;
revoke all on function public.shopify_order_facts_keyed_by_company() from authenticated;
grant execute on function public.shopify_order_facts_keyed_by_company() to service_role;
