-- Shopify collections registry: what pages EXIST, as opposed to what got
-- traffic.
--
-- SILO has never stored this, and the absence has already produced a wrong
-- answer: on 2026-09-08 Ask SILO concluded eight collections "don't exist"
-- from shopify_landing_pages_daily, which is a top-250-per-day slice of
-- landing SESSIONS. A collection with no traffic is absent from that table
-- whether or not it exists, so no query over it can answer an existence
-- question. This table is the thing that can.
--
-- Field shapes verified 2026-09-09 against the live Admin GraphQL schema
-- (Collection, Publication), not recalled. Two of those facts drive the
-- column design and are easy to get wrong:
--
--   1. Collection.seo holds OVERRIDES ONLY -- "if the default SEO fields for
--      page title and description have been modified, contains the modified
--      information." A null therefore means "inheriting the collection
--      title/description", NOT "missing SEO". Storing it as seo_title would
--      make every un-customised collection read as a defect, which is the
--      same class of false finding this whole table exists to prevent, so
--      the columns are named *_override and the catalog description says so.
--
--   2. There is NO published boolean on Collection. Publication is
--      per-sales-channel (Collection.publishedOnPublication(publicationId),
--      Publication.hasCollection(id)), and collections are unpublished by
--      default. Resolving the Online Store publication is a separate call
--      that can fail on its own -- see published_to_online_store below.

-- ---------------------------------------------------------------------------
-- Sync runs. Exists so "this collection is gone" is only ever concluded from
-- a run that actually FINISHED.
--
-- A paginated sync that dies halfway returns a partial set. Without this
-- table the natural implementation -- upsert what came back, treat the rest
-- as deleted -- would mark every unfetched collection as removed on any
-- timeout, rate-limit or network blip. That is exactly the "absent from what
-- I fetched means not real" error at the ingestion layer instead of the
-- answer layer.
-- ---------------------------------------------------------------------------
create table if not exists public.shopify_collection_sync_runs (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  shop_domain text not null,
  started_at timestamptz not null default now(),
  -- Null until the run walked every page without error. Only a run with
  -- completed_at set may be used to infer that a collection disappeared.
  completed_at timestamptz,
  pages_fetched integer not null default 0,
  collections_seen integer not null default 0,
  memberships_seen integer not null default 0,
  -- Set when the run ended badly. A run with an error and no completed_at is
  -- a partial view of the store and must never drive a deletion.
  error text,
  sync_batch_id text
);

create index if not exists shopify_collection_sync_runs_company_idx
  on public.shopify_collection_sync_runs (company_entity_id, shop_domain, started_at desc);

-- ---------------------------------------------------------------------------
-- Collections.
--
-- IDENTITY IS (company, shop, shopify_collection_id). Handles change -- a
-- merchant renaming a collection keeps the id and gets a new handle -- so a
-- handle is a URL lookup key, never an identity key. It is indexed but
-- deliberately NOT unique: two shops legitimately share a handle, and a
-- handle freed by a rename can be reused by a different collection.
-- ---------------------------------------------------------------------------
create table if not exists public.shopify_collections (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  shop_domain text not null,

  -- Shopify's GID, e.g. gid://shopify/Collection/123. The identity column.
  shopify_collection_id text not null,
  -- Collection.legacyResourceId -- the numeric REST id, kept because other
  -- Shopify surfaces (and humans reading admin URLs) still speak in it.
  legacy_resource_id text,

  -- The URL segment: /collections/{handle}. Lookup key, not identity.
  handle text not null,
  title text,
  description text,

  -- Overrides only -- null means "inherits the collection title/description",
  -- not "no SEO". See the header note.
  seo_title_override text,
  seo_description_override text,

  -- null ruleSet on the API = a manual collection; set = a smart one.
  is_smart_collection boolean,
  sort_order text,
  template_suffix text,
  products_count integer,

  -- TRI-STATE ON PURPOSE: true = published to the Online Store publication,
  -- false = confirmed not published, NULL = UNKNOWN (the Online Store
  -- publication could not be resolved, or the per-collection publication
  -- lookup failed). Never write false as a stand-in for unknown -- an
  -- unpublished collection and an uncheckable one lead to opposite actions.
  published_to_online_store boolean,
  publication_checked_at timestamptz,
  -- Why the check failed, when it did. Present iff the boolean is null and a
  -- check was attempted.
  publication_error text,
  -- Every publication the collection is on, as returned. Kept raw so a later
  -- question about a non-Online-Store channel does not need a re-sync.
  publications jsonb not null default '[]'::jsonb,

  shopify_updated_at timestamptz,
  raw jsonb not null default '{}'::jsonb,

  -- Completeness bookkeeping. last_seen_run_id points at the run that last
  -- returned this collection; missing_since is set ONLY by a run with
  -- completed_at set that walked every page and did not see it. A partial
  -- run leaves both alone.
  last_seen_at timestamptz not null default now(),
  last_seen_run_id uuid references public.shopify_collection_sync_runs(id) on delete set null,
  missing_since timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_entity_id, shop_domain, shopify_collection_id)
);

create index if not exists shopify_collections_handle_idx
  on public.shopify_collections (company_entity_id, shop_domain, handle);
create index if not exists shopify_collections_present_idx
  on public.shopify_collections (company_entity_id, shop_domain)
  where missing_since is null;

-- ---------------------------------------------------------------------------
-- Collection -> product membership.
--
-- Same identity rule: keyed on Shopify ids, scoped by company+shop. Also
-- carries its own last_seen/missing bookkeeping, because membership can be
-- paginated separately from the collection list and can therefore be
-- partially fetched on its own.
-- ---------------------------------------------------------------------------
create table if not exists public.shopify_collection_products (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  shop_domain text not null,
  shopify_collection_id text not null,
  shopify_product_id text not null,
  position integer,

  last_seen_at timestamptz not null default now(),
  last_seen_run_id uuid references public.shopify_collection_sync_runs(id) on delete set null,
  missing_since timestamptz,

  created_at timestamptz not null default now(),
  unique (company_entity_id, shop_domain, shopify_collection_id, shopify_product_id)
);

create index if not exists shopify_collection_products_product_idx
  on public.shopify_collection_products (company_entity_id, shop_domain, shopify_product_id);

-- ---------------------------------------------------------------------------
-- products_master needs a Shopify identifier before membership can join to
-- it. It currently has NONE -- no product id, no handle, one row per
-- (company_entity_id, sku) -- so there is no way to get from a collection to
-- a product row today. Additive and nullable; the catalog sync fills them.
-- ---------------------------------------------------------------------------
alter table public.products_master
  add column if not exists shopify_product_id text,
  add column if not exists shopify_handle text;

create index if not exists products_master_shopify_product_id_idx
  on public.products_master (company_entity_id, shopify_product_id);

-- ---------------------------------------------------------------------------
-- RLS. Read for the active company; writes are service-role only (the sync),
-- same stance as every other sync-owned table.
-- ---------------------------------------------------------------------------
alter table public.shopify_collections enable row level security;
alter table public.shopify_collection_products enable row level security;
alter table public.shopify_collection_sync_runs enable row level security;

revoke all on public.shopify_collections from anon;
revoke all on public.shopify_collection_products from anon;
revoke all on public.shopify_collection_sync_runs from anon;

drop policy if exists shopify_collections_active_select on public.shopify_collections;
create policy shopify_collections_active_select on public.shopify_collections
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists shopify_collection_products_active_select on public.shopify_collection_products;
create policy shopify_collection_products_active_select on public.shopify_collection_products
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists shopify_collection_sync_runs_active_select on public.shopify_collection_sync_runs;
create policy shopify_collection_sync_runs_active_select on public.shopify_collection_sync_runs
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- ---------------------------------------------------------------------------
-- Extend the sync_jobs job_type CHECK. Read the constraint's current
-- definition before editing it -- a hand-written list dropped four existing
-- values the first time this was attempted and Postgres refused it. The list
-- below is pg_get_constraintdef() output as of 2026-09-09 plus one value.
-- ---------------------------------------------------------------------------
alter table public.sync_jobs drop constraint if exists sync_jobs_job_type_check;
alter table public.sync_jobs add constraint sync_jobs_job_type_check
  check (job_type = any (array[
    'test_connection','history_import','incremental_sales','inventory_snapshot',
    'catalog_sync','payouts_sync','draft_orders_sync','google_ads_kpis',
    'meta_ads_kpis','tiktok_ads_kpis','ga4_kpis','orders_backfill',
    'sessions_sync','landing_pages_sync','discount_codes_sync',
    'collections_sync'
  ]));

-- ---------------------------------------------------------------------------
-- Ask SILO catalog entries. The descriptions carry the two traps, because
-- the model reads schema meaning from here.
-- ---------------------------------------------------------------------------
insert into public.silo_chat_schema_catalog (relname, relkind, columns, description, keywords)
values
  ('shopify_collections', 'r', '[]'::jsonb,
   'THE REGISTRY OF WHICH SHOPIFY COLLECTION PAGES EXIST -- use this, never '
   'shopify_landing_pages_daily, to answer whether a collection or /collections/ '
   'URL exists. handle is the URL segment (/collections/{handle}); it is a lookup '
   'key, NOT identity, because a rename changes the handle and keeps the id -- '
   'join on shopify_collection_id scoped by company_entity_id + shop_domain. '
   'published_to_online_store is TRI-STATE: true = published, false = confirmed '
   'not published, NULL = UNKNOWN (publication could not be checked; see '
   'publication_error). Never read null as false. seo_title_override / '
   'seo_description_override hold OVERRIDES ONLY -- null means the collection '
   'inherits its title/description as the page SEO, which is normal and is NOT '
   'a missing-SEO defect. A row with missing_since set was not seen by a '
   'COMPLETED sync run; a row absent entirely may simply never have synced, so '
   'check shopify_collection_sync_runs for a run with completed_at before '
   'concluding anything from absence.',
   array['collection','collections','handle','url','page','seo','published','registry','landing page']),
  ('shopify_collection_products', 'r', '[]'::jsonb,
   'Which products belong to which Shopify collection. Keyed on Shopify ids and '
   'scoped by company_entity_id + shop_domain. Join to products_master via '
   'shopify_product_id (added 2026-09-09; null on rows not yet re-synced by the '
   'catalog sync). Same completeness rule as shopify_collections: missing_since '
   'is only set by a completed run.',
   array['collection','membership','products','collection products']),
  ('shopify_collection_sync_runs', 'r', '[]'::jsonb,
   'One row per collections sync attempt. completed_at is null unless the run '
   'walked every page without error -- absence of a collection or membership may '
   'only be treated as removal when a run with completed_at exists after that '
   'row''s last_seen_at. A run with error set and no completed_at saw only part '
   'of the store.',
   array['sync','collections','completeness','run'])
on conflict (relname) do update
  set description = excluded.description,
      keywords = excluded.keywords,
      updated_at = now();
