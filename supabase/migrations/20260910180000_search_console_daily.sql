-- 20260910180000_search_console_daily.sql
-- ---------------------------------------------------------------------------
-- Search Console performance data: three tables, three grains, never one
-- figure. Built to what scripts/search-console-probe.mjs MEASURED on the live
-- property on 2026-09-10 (docs/ops/seo-project.md, "Step 2b"), which is why
-- 20260909180000 shipped the connection without them:
--
--   lag        newest FINAL day is 2 days back; 'all' reaches today but is
--              partial and restates upward -- ingestion ends today-2 Pacific
--              and requests dataState=final only
--   retention  498 final days (back to 2025-04-29) -- a backfill is feasible
--   row cap    25,000 per page and paging works -- these tables are COMPLETE
--              lists of what Google returns, not top-N slices
--   PAGE cut   recovered 102.8% of clicks -- complete on clicks. Over 100%
--              because one query showing two of our URLs is ONE site
--              impression and TWO page impressions: page-level impressions,
--              CTR and position are a different measure from site-level, not
--              a breakdown of it
--   QUERY cut  recovered 56.9% of clicks. The other 43.1% are ANONYMISED by
--              Google for privacy and belong to no query row, ever. A query
--              table looks complete and is not -- the shopify_landing_pages_
--              daily trap, and worse, because nothing on the rows says so
--   query x page  no better than query alone (58.2%) -- NOT ingested; it
--              adds no measurement and invites the exact "this query brought
--              traffic to this page" inference the withheld rows forbid
--
-- So the SITE table carries, per day, the clicks and impressions the page
-- and query cuts recovered, written by the same sync from the same fetch,
-- and the unattributed remainder is a GENERATED column beside the total. A
-- reader looking at a day's query rows has the 43% on the row above them
-- rather than in a doc they did not read.
--
-- Writes are service-role only (the sync). No client insert/update/delete
-- policy, same stance as every sync-owned table. Select is company-scoped.
-- ---------------------------------------------------------------------------

-- ── site-daily: the denominator ─────────────────────────────────────────────
create table if not exists public.search_console_site_daily (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null,
  connection_id uuid references public.ad_platform_connections(id) on delete set null,
  -- Verbatim sites.list identifier (URL-prefix or sc-domain:), never
  -- normalised: the two forms report different traffic.
  site_url text not null,
  day_date date not null,
  clicks bigint not null default 0,
  impressions bigint not null default 0,
  -- Google's own site-level rate and average position for the day. position
  -- is an AVERAGE: never sum it, and never average it again across days
  -- without weighting by impressions.
  ctr numeric(9,6),
  position numeric(9,3),
  -- What the detail cuts recovered for this day, from the SAME fetch that
  -- wrote the detail rows. NULL means never measured (a row written by
  -- something other than the sync); 0 means measured and nothing attributed.
  page_rows integer,
  page_attributed_clicks bigint,
  page_attributed_impressions bigint,
  query_rows integer,
  query_attributed_clicks bigint,
  query_attributed_impressions bigint,
  -- The number the probe existed to make statable. NULL when not measured,
  -- never 0 by default -- a default of 0 would claim full attribution.
  unattributed_query_clicks bigint generated always as (
    case when query_attributed_clicks is null then null
         else clicks - query_attributed_clicks end
  ) stored,
  unattributed_query_click_share numeric(6,4) generated always as (
    case when query_attributed_clicks is null or clicks = 0 then null
         else round((clicks - query_attributed_clicks)::numeric / clicks, 4) end
  ) stored,
  -- Only 'final' is ever written by the sync. The column exists so a row
  -- can say so, and so a future decision to ingest fresh days is a value,
  -- not a schema change.
  data_state text not null default 'final' check (data_state in ('final', 'all')),
  -- True when a cut hit the page guard for the window this row was fetched
  -- in: the detail tables for this day are then a prefix of what Google
  -- holds, and the attributed sums are sums of that prefix.
  is_truncated boolean not null default false,
  synced_at timestamptz not null default now(),
  sync_batch_id text,
  unique (company_entity_id, site_url, day_date)
);

create index if not exists search_console_site_daily_day_idx
  on public.search_console_site_daily (company_entity_id, day_date desc);

-- ── page-daily: complete on clicks ──────────────────────────────────────────
create table if not exists public.search_console_page_daily (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null,
  connection_id uuid references public.ad_platform_connections(id) on delete set null,
  site_url text not null,
  day_date date not null,
  -- The full URL as Google returns it (scheme + host + path + query string).
  page text not null,
  -- The path alone, for joining to Shopify's landing_page_path /
  -- shopify_collections.handle. A PATH join, page to page -- it never
  -- attributes sessions to search queries, which no join can do.
  page_path text generated always as (regexp_replace(page, '^https?://[^/]+', '')) stored,
  clicks bigint not null default 0,
  impressions bigint not null default 0,
  ctr numeric(9,6),
  position numeric(9,3),
  synced_at timestamptz not null default now(),
  sync_batch_id text,
  unique (company_entity_id, site_url, day_date, page)
);

create index if not exists search_console_page_daily_day_idx
  on public.search_console_page_daily (company_entity_id, day_date desc);
create index if not exists search_console_page_daily_path_idx
  on public.search_console_page_daily (company_entity_id, page_path, day_date desc);

-- ── query-daily: 57% of clicks, by construction ─────────────────────────────
create table if not exists public.search_console_query_daily (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null,
  connection_id uuid references public.ad_platform_connections(id) on delete set null,
  site_url text not null,
  day_date date not null,
  query text not null,
  clicks bigint not null default 0,
  impressions bigint not null default 0,
  ctr numeric(9,6),
  position numeric(9,3),
  synced_at timestamptz not null default now(),
  sync_batch_id text,
  unique (company_entity_id, site_url, day_date, query)
);

create index if not exists search_console_query_daily_day_idx
  on public.search_console_query_daily (company_entity_id, day_date desc);
create index if not exists search_console_query_daily_query_idx
  on public.search_console_query_daily (company_entity_id, query, day_date desc);

-- ── RLS: company-scoped reads, service-role writes ──────────────────────────
alter table public.search_console_site_daily enable row level security;
alter table public.search_console_page_daily enable row level security;
alter table public.search_console_query_daily enable row level security;

drop policy if exists search_console_site_daily_select on public.search_console_site_daily;
create policy search_console_site_daily_select on public.search_console_site_daily
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists search_console_page_daily_select on public.search_console_page_daily;
create policy search_console_page_daily_select on public.search_console_page_daily
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists search_console_query_daily_select on public.search_console_query_daily;
create policy search_console_query_daily_select on public.search_console_query_daily
  for select to authenticated
  using (company_entity_id = public.active_company_id());

revoke all on public.search_console_site_daily from anon;
revoke all on public.search_console_page_daily from anon;
revoke all on public.search_console_query_daily from anon;

-- The insert-stamp backstop. Every table created on 2026-09-09 shipped
-- without it (20260910130000); not repeating that.
select public.attach_stamp_company_entity_id_triggers();

-- ── sync_jobs.job_type: add 'search_console_daily' WITHOUT retyping the list ─
-- Every earlier extension re-typed the whole list from a migration file, and
-- the first attempt dropped four live values (20260827080000's note). This
-- one reads the CURRENT definition from pg_constraint and appends, so a
-- value that exists only in production survives. It refuses to proceed if
-- the constraint is not where it expects it -- inventing a list is exactly
-- the failure it exists to avoid.
do $$
declare
  cur text;
  members text;
begin
  select pg_get_constraintdef(oid) into cur
  from pg_constraint
  where conname = 'sync_jobs_job_type_check'
    and conrelid = 'public.sync_jobs'::regclass;

  if cur is null then
    raise exception 'sync_jobs_job_type_check not found; read the live job_type constraint before adding search_console_daily';
  end if;

  if cur like '%search_console_daily%' then
    return; -- already applied
  end if;

  -- pg_get_constraintdef renders it as
  --   CHECK ((job_type = ANY (ARRAY['a'::text, 'b'::text])))
  members := substring(cur from 'ARRAY\[(.*?)\]');
  if members is null or members = '' then
    raise exception 'sync_jobs_job_type_check has an unexpected shape (%); extend it by hand after reading it', cur;
  end if;

  execute 'alter table public.sync_jobs drop constraint sync_jobs_job_type_check';
  execute format(
    'alter table public.sync_jobs add constraint sync_jobs_job_type_check check (job_type = any (array[%s, %L::text]))',
    members, 'search_console_daily'
  );
end $$;

-- ── Ask SILO catalog: the numbers, on the rows the model reads ──────────────
-- Seeded as APPENDS guarded on a marker, never `set description = ...`
-- (20260910150000 is what happens otherwise). refresh_chat_schema_catalog()
-- may already have minted these rows with a null description; the upsert
-- fills them either way and leaves any later append alone.
insert into public.silo_chat_schema_catalog (relname, relkind, columns, description, keywords)
values
  ('search_console_site_daily', 'r', '[]'::jsonb,
   'Google Search Console SITE-level totals per day for one property '
   '(site_url, verbatim: https://www.baseballism.com/ is a URL-prefix property '
   'covering only that scheme+host). clicks/impressions/ctr/position are '
   'Google''s own daily totals, dataState=final, ending 2 days back (Pacific) '
   '-- yesterday and today are NOT here and are not zero. '
   'QUERY ATTRIBUTION IS PARTIAL BY CONSTRUCTION: Google anonymises rare '
   'queries, so search_console_query_daily holds only the clicks it will '
   'attribute to a query -- measured 56.9% of clicks over 28 days on '
   '2026-09-10, so 43.1% of search clicks belong to NO query row. This table '
   'stores that per day: query_attributed_clicks is what the query table '
   'recovered, unattributed_query_clicks and unattributed_query_click_share '
   'are the remainder (NULL = not measured, never 0). ALWAYS state the '
   'unattributed share next to any query-level finding, and NEVER claim "no '
   'query brings traffic to X" -- the missing 43% could. Page attribution is '
   'complete on clicks (page_attributed_clicks ~= clicks), but page '
   'impressions EXCEED site impressions because Google counts one page '
   'impression per URL shown and one site impression per query -- so '
   'page-level CTR/position are a different measure from site-level, not a '
   'breakdown. position is an average: never sum it. Use this table as the '
   'denominator for both detail tables and for any "share of search clicks" '
   'question. History begins 2025-04-29 (Google retains ~16 months); older '
   'comparisons are unmeasurable, not flat. Absent days before the first '
   'backfill are NOT ingested yet, not zero -- check max/min day_date first.',
   array['search console','gsc','google search','organic search','clicks','impressions','ctr','position','seo','search performance','unattributed']),
  ('search_console_page_daily', 'r', '[]'::jsonb,
   'Google Search Console performance per PAGE (URL) per day: clicks, '
   'impressions, ctr, position, dataState=final, ending 2 days back. COMPLETE '
   'on clicks (the page cut recovered 102.8% of site clicks when measured) '
   '-- so a page with no row on a day genuinely had no search clicks and no '
   'impressions that day, PROVIDED the day is inside the ingested range '
   '(check search_console_site_daily for the day first). page is the full '
   'URL; page_path is the path alone for joining to shopify_landing_pages_'
   'daily.landing_page_path or /collections/{handle} -- a page-to-page join, '
   'which never attributes on-site sessions to search queries. Impressions '
   'here are PAGE-level (one per URL shown) and sum to more than the site '
   'total; CTR and position are per page and not comparable to site-level. '
   'position is an average: never sum it, weight by impressions if combining '
   'days. This is the table for "which pages get search traffic" and for '
   'per-page baselines in seo_measurements (source search_console_page). '
   'Never join to search_console_query_daily to say which query brought '
   'traffic to which page -- that pair is not ingested because Google withholds '
   'it as heavily as queries alone, and the inference is unsupportable.',
   array['search console','gsc','page','url','landing page','clicks','impressions','ctr','position','seo','search performance']),
  ('search_console_query_daily', 'r', '[]'::jsonb,
   'Google Search Console performance per search QUERY per day: clicks, '
   'impressions, ctr, position, dataState=final, ending 2 days back. '
   'DELIBERATELY INCOMPLETE: Google anonymises rare queries for privacy, so '
   'this table holds only the clicks it will attribute to a query -- measured '
   '56.9% of site clicks (43.1% belong to no row here) over 28 days on '
   '2026-09-10. The exact share per day is on search_console_site_daily '
   '(unattributed_query_click_share); ALWAYS cite it beside any query-level '
   'number, and NEVER say a page or a topic gets "no search traffic" from the '
   'absence of a query here -- the missing 43% could carry it. Summing clicks '
   'here gives attributed clicks, not total search clicks; the total is on '
   'search_console_site_daily. Rankings ("we rank #3 for X") are position '
   'values here, which are AVERAGES over impressions -- never summed, and a '
   'query absent on a day was not necessarily unranked, it may be withheld. '
   'This is the table for "which queries bring people here" and for query '
   'baselines in seo_measurements (source search_console_query). Never join '
   'to search_console_page_daily to attribute a query to a page.',
   array['search console','gsc','query','keyword','search term','ranking','position','clicks','impressions','ctr','seo','anonymised'])
on conflict (relname) do update
  set description = case
        when coalesce(public.silo_chat_schema_catalog.description, '') like '%QUERY ATTRIBUTION IS PARTIAL%'
          or coalesce(public.silo_chat_schema_catalog.description, '') like '%COMPLETE on clicks%'
          or coalesce(public.silo_chat_schema_catalog.description, '') like '%DELIBERATELY INCOMPLETE%'
        then public.silo_chat_schema_catalog.description
        else coalesce(public.silo_chat_schema_catalog.description, '') || excluded.description
      end,
      keywords = coalesce(public.silo_chat_schema_catalog.keywords, excluded.keywords),
      updated_at = now();

-- Fill the column lists from pg_catalog (the seed above carries '[]').
-- Without this the model can name and describe the tables but not their
-- columns, and writes queries against guessed names.
select public.refresh_chat_schema_catalog();
