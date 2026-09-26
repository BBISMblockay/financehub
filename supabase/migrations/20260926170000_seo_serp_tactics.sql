-- ─────────────────────────────────────────────────────────────────────────────
-- SEO tactics, not just rankings (2026-09-26).
--
-- The first real run (151 keywords × desktop and mobile) showed the SAME
-- collection page on both sides of "baseball backpacks" -- theirs titled
-- "Baseball Backpacks & Bags | BL101" at #1, ours "Backpacks | Baseballism
-- Online" at #3 -- and a competitor blog post at #4 on "baseball gifts for
-- boys" where we send the query to the homepage at #12. Every one of those
-- facts was already in seo_serp_observations (url and title per rank); nothing
-- read them as tactics. Three additions, each reading what the provider
-- already returns or what a page already says about itself:
--
--   1. WHICH PAGE TYPE a domain ranks with (collection / product / article /
--      home / page / video / other), derived from the observation URL --
--      seo_serp_page_type() and seo_competitor_page_types_v. A competitor
--      winning on articles is running a content program; one winning on
--      collections has the keyword in a category page title.
--   2. WHAT ELSE WAS ON THE PAGE -- seo_serp_features. The provider returns
--      People Also Ask, AI overviews, product packs, videos and images in the
--      same response the sync already pays for, and until now they were
--      dropped (only their type names were kept on the ledger). They do not
--      fit seo_serp_observations, which requires a domain and a URL on every
--      row and is keyed on an organic rank: a PAA block has questions, not a
--      domain. So they are their own table, and "position" here is the
--      block's ABSOLUTE slot on the page, never an organic rank.
--   3. WHAT A COMPETITOR'S RANKING PAGE SAYS ABOUT ITSELF --
--      seo_competitor_page_inspections. page_inspections is cited by
--      seo_task_publications as evidence about OUR pages, so a competitor
--      capture must not land there or it could be read as own-store evidence.
--      Same columns, separate table, keyed to the observation that named the
--      URL: the fetch is only ever of a URL a results page returned, never
--      one a person typed.
--
-- URLs carry Google's srsltid tracking parameter, so two observations of one
-- page differ in their query string. seo_serp_page_path() strips it (and the
-- usual click ids) so pages can be grouped; the stored url stays verbatim.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Page path and page type, from the URL alone ─────────────────────────────
create or replace function public.seo_serp_page_path(p_url text)
returns text
language sql
immutable
strict
set search_path = public
as $$
  with s as (
    select regexp_replace(
             regexp_replace(
               regexp_replace(btrim(p_url), '^[a-z][a-z0-9+.-]*://[^/?#]*', '', 'i'),
               '[?&](srsltid|gclid|fbclid|msclkid|utm_[a-z]+|ref|ref_)=[^&#]*', '', 'g'),
             '#.*$', '') as path
  )
  select case
           when p = '' then '/'
           else p
         end
  from (
    select regexp_replace(regexp_replace(path, '^([^?]*)\?&', '\1?'), '\?$', '') as p from s
  ) x
$$;

comment on function public.seo_serp_page_path(text) is
  'The path-and-query of a URL with the host and the click/tracking parameters '
  '(srsltid, gclid, fbclid, msclkid, utm_*) removed, so two observations of one '
  'page can be grouped. The stored observation url is never altered.';

create or replace function public.seo_serp_page_type(p_url text)
returns text
language sql
immutable
strict
set search_path = public
as $$
  select case
    when p = '/' then 'home'
    when p ~* '^/(collections?|c|category|categories|shop|s|browse|b|sch|f|search|catalog|department)(/|$|\?)' then 'collection'
    when p ~* '^/(products?|p|itm|ip|pd|item)(/|$|\?)' or p ~* '(^|/)(dp|gp/product)/' then 'product'
    when p ~* '^/(blogs?|news|articles?|guides?|wiki|r|posts?|stories|magazine|journal)(/|$|\?)' then 'article'
    when p ~* '^/(watch|shorts|video|videos)(/|$|\?)' then 'video'
    when p ~* '^/pages?(/|$|\?)' then 'page'
    else 'other'
  end
  from (select regexp_replace(public.seo_serp_page_path(p_url), '\?.*$', '') as p) x
$$;

comment on function public.seo_serp_page_type(text) is
  'home / collection / product / article / video / page / other, from the path '
  'alone (Shopify conventions plus the common marketplace and media shapes). A '
  'classification of the URL, not of the page''s content: read '
  'seo_competitor_page_inspections for what a page actually says.';

-- ── Which page types each domain ranks with, latest completed run ───────────
drop view if exists public.seo_competitor_page_types_v;
create view public.seo_competitor_page_types_v
with (security_invoker = true) as
with latest_runs as (
  select distinct on (r.company_entity_id, r.provider, r.device, r.location_name, r.language_code, r.search_engine)
         r.id as run_id, r.company_entity_id, r.provider, r.device, r.location_name, r.language_code, r.search_engine, r.observed_on
  from public.seo_serp_runs r
  where r.completed_at is not null
  order by r.company_entity_id, r.provider, r.device, r.location_name, r.language_code, r.search_engine, r.observed_on desc, r.synced_at desc
)
select
  lr.company_entity_id,
  lr.provider,
  lr.device,
  lr.location_name,
  lr.language_code,
  lr.search_engine,
  lr.observed_on,
  lr.run_id,
  v.domain_norm,
  bool_or(v.is_own_domain)                                                    as is_own_domain,
  public.seo_serp_page_type(v.url)                                            as page_type,
  count(distinct v.keyword_id)                                                as keywords_in_top_10,
  count(distinct public.seo_serp_page_path(v.url))                            as distinct_pages,
  min(v.position)                                                             as best_position,
  (array_agg(public.seo_serp_page_path(v.url) order by v.position, v.keyword))[1] as example_path,
  (array_agg(v.keyword order by v.position, v.keyword))[1]                   as example_keyword
from latest_runs lr
join public.seo_serp_observations_v v
  on v.run_id = lr.run_id and v.result_type = 'organic' and v.position <= 10
group by lr.company_entity_id, lr.provider, lr.device, lr.location_name, lr.language_code, lr.search_engine,
         lr.observed_on, lr.run_id, v.domain_norm, public.seo_serp_page_type(v.url);

comment on view public.seo_competitor_page_types_v is
  'Per latest completed run (provider x device x location) and domain: how many '
  'of the run''s keywords the domain held a TOP-10 organic result for, split by '
  'the TYPE of page that ranked (home / collection / product / article / video '
  '/ page / other, classified from the URL path), with the count of distinct '
  'pages, the best position and one example path and keyword. A domain winning '
  'on articles is running content; one winning on collections has category '
  'pages titled for the term. Keyword counts are against the keywords that run '
  'observed, never the whole set; same denominator rule as '
  'seo_competitor_share_v.';

-- ── SERP features: what else was on the page ────────────────────────────────
create table if not exists public.seo_serp_features (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  run_id            uuid not null,
  keyword_id        uuid not null,
  provider          text not null check (provider in ('dataforseo', 'manual')),
  observed_on       date not null,
  location_name     text not null,
  language_code     text not null,
  device            text not null check (device in ('desktop', 'mobile')),
  search_engine     text not null,
  -- The provider's own item type, verbatim (people_also_ask, ai_overview,
  -- popular_products, images, video, featured_snippet, ...). Deliberately no
  -- CHECK: a feature Google introduces next month is recorded under its own
  -- name rather than dropped, and the page maps names to labels.
  feature_type      text not null,
  -- The block's ABSOLUTE slot on the page (rank_absolute). Never an organic
  -- rank: a PAA block at absolute 3 sits between organic #2 and #3.
  position          integer not null check (position >= 1),
  item_count        integer,
  -- Bounded extract of what the block held: questions, product titles and
  -- sellers, video titles and domains, AI-overview references. Never the
  -- provider's full payload.
  details           jsonb not null default '{}'::jsonb,
  synced_at         timestamptz not null default now(),
  sync_batch_id     text,
  created_at        timestamptz not null default now(),
  constraint seo_serp_features_type_not_blank check (btrim(feature_type) <> ''),
  unique (run_id, keyword_id, feature_type, position),
  constraint seo_serp_features_run_company_fkey
    foreign key (run_id, company_entity_id) references public.seo_serp_runs(id, company_entity_id) on delete cascade,
  constraint seo_serp_features_keyword_company_fkey
    foreign key (keyword_id, company_entity_id) references public.seo_keyword_set(id, company_entity_id) on delete cascade,
  -- A feature belongs to a keyword the run ASKED about, same as an observation.
  constraint seo_serp_features_requested_keyword_fkey
    foreign key (run_id, keyword_id) references public.seo_serp_run_keywords(run_id, keyword_id) on delete cascade
);

create index if not exists seo_serp_features_keyword_day
  on public.seo_serp_features (company_entity_id, keyword_id, observed_on desc);
create index if not exists seo_serp_features_run
  on public.seo_serp_features (run_id, keyword_id);

alter table public.seo_serp_features enable row level security;

drop policy if exists seo_serp_features_select on public.seo_serp_features;
create policy seo_serp_features_select on public.seo_serp_features
  for select to authenticated
  using (company_entity_id = public.active_company_id());

revoke all on public.seo_serp_features from anon;

-- Newest completed run wins, for features too. The function names the
-- tables it guards, so it is re-declared with the fourth one.
create or replace function public.seo_serp_reject_stale_write()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if new.synced_at < old.synced_at then
      return null;  -- an older run's write loses to the stored, newer row
    end if;
    return new;
  end if;

  -- INSERT of a keyword request, an observation or a feature: refused if the
  -- run it cites was completed by a newer writer. The run row itself has
  -- nothing above it to consult.
  if tg_table_name in ('seo_serp_run_keywords', 'seo_serp_observations', 'seo_serp_features') then
    if exists (
      select 1 from public.seo_serp_runs r
      where r.id = new.run_id
        and r.completed_at is not null
        and r.synced_at > new.synced_at
    ) then
      return null;
    end if;
  end if;
  return new;
end;
$$;

comment on function public.seo_serp_reject_stale_write() is
  'BEFORE INSERT OR UPDATE on seo_serp_runs / seo_serp_run_keywords / '
  'seo_serp_observations / seo_serp_features: an update whose synced_at is '
  'older than the stored row is dropped, and a keyword-request, observation or '
  'feature insert into a run a newer writer already completed is dropped. '
  'Equal timestamps pass (a retry within one run). Same guarantee as '
  'search_console_reject_stale_write().';

drop trigger if exists trg_seo_serp_newest_run_wins on public.seo_serp_features;
create trigger trg_seo_serp_newest_run_wins
  before insert or update on public.seo_serp_features
  for each row execute function public.seo_serp_reject_stale_write();

drop view if exists public.seo_serp_features_v;
create view public.seo_serp_features_v
with (security_invoker = true) as
select
  f.id,
  f.company_entity_id,
  f.run_id,
  f.keyword_id,
  k.keyword,
  k.keyword_norm,
  f.provider,
  f.observed_on,
  f.location_name,
  f.language_code,
  f.device,
  f.search_engine,
  f.feature_type,
  f.position,
  f.item_count,
  f.details,
  f.synced_at
from public.seo_serp_features f
join public.seo_keyword_set k on k.id = f.keyword_id;

comment on view public.seo_serp_features_v is
  'One row per non-organic block observed on a results page: People Also Ask '
  '(details.entries[].title are the questions Google showed), ai_overview '
  '(entries are its cited references; asynchronous = generated after load), '
  'popular_products / shopping (product titles and sellers), video, images, '
  'featured_snippet, local_pack and whatever else the provider named. position '
  'is the block''s ABSOLUTE slot, not an organic rank. A keyword with no row '
  'for a run had no such block in that fetch; a keyword with no run at all was '
  'never observed. Questions here are what Google associates with the query on '
  'one date, never a search volume.';

-- ── Competitor page captures: what THEIR ranking page says about itself ─────
-- Keyed to the observation that returned the URL. The edge function
-- (page-inspect, {observation_id}) admits exactly that URL's host, so the only
-- pages this table can ever hold are ones a results page returned for a
-- keyword this company tracks.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'seo_serp_observations_id_company_key') then
    alter table public.seo_serp_observations
      add constraint seo_serp_observations_id_company_key unique (id, company_entity_id);
  end if;
end $$;

create table if not exists public.seo_competitor_page_inspections (
  id                 uuid primary key default gen_random_uuid(),
  company_entity_id  uuid not null references public.entities(id) on delete cascade,
  observation_id     uuid not null,
  keyword_id         uuid not null,
  domain_norm        text not null,

  requested_url      text not null,
  host               text not null,
  final_url          text,
  redirect_chain     jsonb not null default '[]'::jsonb,
  http_status        integer,

  -- The same on-page facts page_inspections records for our own pages, so a
  -- comparison is like for like: what the PAGE SAYS about itself.
  title              text,
  title_length       integer,
  meta_description   text,
  meta_description_length integer,
  canonical_url      text,
  meta_robots        text,
  og_title           text,
  og_description     text,
  h1                 text[],
  h1_count           integer,
  h2_count           integer,
  word_count         integer,
  image_count        integer,
  images_missing_alt integer,
  jsonld_types       text[],

  content_bytes      integer,
  is_truncated       boolean not null default false,
  response_ms        integer,
  html_sha256        text,
  fetch_error        text,
  fetched_at         timestamptz not null default now(),
  fetched_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  constraint seo_competitor_page_inspections_observation_company_fkey
    foreign key (observation_id, company_entity_id) references public.seo_serp_observations(id, company_entity_id) on delete cascade,
  constraint seo_competitor_page_inspections_keyword_company_fkey
    foreign key (keyword_id, company_entity_id) references public.seo_keyword_set(id, company_entity_id) on delete cascade
);

create index if not exists seo_competitor_page_inspections_observation
  on public.seo_competitor_page_inspections (company_entity_id, observation_id, fetched_at desc);
create index if not exists seo_competitor_page_inspections_company_fetched
  on public.seo_competitor_page_inspections (company_entity_id, fetched_at desc);

alter table public.seo_competitor_page_inspections enable row level security;

drop policy if exists seo_competitor_page_inspections_select on public.seo_competitor_page_inspections;
create policy seo_competitor_page_inspections_select on public.seo_competitor_page_inspections
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- Written only by the page-inspect edge function (service role). No client
-- write policy: a row here is a claim that our infrastructure fetched a page
-- at a time, and a client-authored one would be a capture that never happened.
revoke all on public.seo_competitor_page_inspections from anon;

comment on table public.seo_competitor_page_inspections is
  'What a COMPETITOR''s ranking page said about itself when SILO fetched it: '
  'title, meta description, H1s, heading and word counts, images, JSON-LD '
  'types. Keyed to the seo_serp_observations row that returned the URL, so '
  'only URLs a results page returned are ever fetched. Same columns as '
  'page_inspections (our own pages) so the two compare like for like, but a '
  'SEPARATE table: page_inspections is cited as evidence about OUR pages by '
  'the SEO task workflow. Nothing here is evidence about search: meta_robots '
  'is a directive the page states, not an observation of indexing.';

select public.attach_stamp_company_entity_id_triggers();

-- ── Ask SILO catalog ────────────────────────────────────────────────────────
insert into public.silo_chat_schema_catalog (relname, relkind, columns, description, keywords, is_hidden)
values
  ('seo_serp_features', 'r', '[]'::jsonb,
   'The NON-ORGANIC blocks observed on a results page per run and keyword: '
   'feature_type is the provider''s own name (people_also_ask, ai_overview, '
   'popular_products, images, video, featured_snippet, local_pack, ...), '
   'position is the block''s ABSOLUTE slot on the page (never an organic rank), '
   'details.entries holds what the block contained (PAA questions as title; '
   'product titles with source; AI-overview references with domain and url). '
   'Read through seo_serp_features_v. A keyword with no row for a run had no '
   'such block in that fetch. PAA questions are what Google associated with the '
   'query on one date -- a content brief, never a search volume or a demand '
   'figure. Never join a feature''s position to organic positions as if they '
   'were one scale.',
   array['seo','serp','features','people also ask','paa','ai overview','shopping','products','video','images'],
   false),
  ('seo_serp_features_v', 'v', '[]'::jsonb,
   'seo_serp_features with the keyword joined. One row per block per run per '
   'keyword; position is the ABSOLUTE slot, never an organic rank. '
   'details.entries[].title carries PAA questions / product titles / video '
   'titles; .domain and .url where the block cited a page. Absence of a row is '
   '"no such block in that fetch", not "the feature does not exist".',
   array['seo','serp','features','people also ask','ai overview','products','video'],
   false),
  ('seo_competitor_page_types_v', 'v', '[]'::jsonb,
   'Per latest completed run and domain: how many observed keywords the domain '
   'held a TOP-10 organic result for, SPLIT BY THE TYPE OF PAGE that ranked '
   '(home / collection / product / article / video / page / other, classified '
   'from the URL path by seo_serp_page_type()), plus distinct_pages, '
   'best_position and one example_path / example_keyword. Says HOW a domain '
   'ranks (category pages vs articles vs the homepage), where '
   'seo_competitor_share_v says how often. Counts are against the keywords '
   'that run observed. A page type is a classification of the URL, not a '
   'reading of the page.',
   array['seo','serp','competitor','page type','collection','article','blog','tactics'],
   false),
  ('seo_competitor_page_inspections', 'r', '[]'::jsonb,
   'What a competitor''s RANKING PAGE said about itself when SILO fetched it '
   '(title, meta_description, h1, h2_count, word_count, image_count, '
   'jsonld_types), keyed by observation_id to the seo_serp_observations row '
   'that returned the URL. Compare with page_inspections (our own pages) on the '
   'same columns. A capture is dated (fetched_at); fetch_error not null means '
   'the page could not be read at that time, not that it is empty. Nothing here '
   'is evidence about indexing or ranking; the rank is in seo_serp_observations.',
   array['seo','competitor','page','inspection','title','meta description','h1','word count','on-page'],
   false)
on conflict (relname) do update
  set description = case
        when coalesce(public.silo_chat_schema_catalog.description, '') like '%NON-ORGANIC blocks observed%'
          or coalesce(public.silo_chat_schema_catalog.description, '') like '%seo_serp_features with the keyword joined%'
          or coalesce(public.silo_chat_schema_catalog.description, '') like '%SPLIT BY THE TYPE OF PAGE%'
          or coalesce(public.silo_chat_schema_catalog.description, '') like '%RANKING PAGE said about itself%'
        then public.silo_chat_schema_catalog.description
        else coalesce(public.silo_chat_schema_catalog.description, '') || excluded.description
      end,
      keywords = coalesce(public.silo_chat_schema_catalog.keywords, excluded.keywords),
      is_hidden = excluded.is_hidden,
      updated_at = now();

select public.refresh_chat_schema_catalog();
