-- Page inspection: the allowlist, and where captures land.
--
-- Two tables and one rule: SILO may fetch a storefront page only from a host
-- SHOPIFY ITSELF vouches for, for a shop this company is OAuth-connected to.
-- Nobody types a domain into a config.
--
-- WHY AN ALLOWLIST AND NOT A FILTER. A tool that fetches a user-supplied URL
-- from inside our infrastructure is a server-side request forgery primitive:
-- it can reach anything the edge function can reach, including link-local
-- metadata endpoints and private ranges. The usual mitigation is a denylist of
-- private IP ranges, which is a filter you have to get exhaustively right
-- (IPv4 literals, decimal and octal forms, IPv6, IPv4-mapped IPv6, DNS names
-- pointing inward). An EXACT-MATCH host allowlist inverts that: the host must
-- equal a known storefront domain, so an IP literal in any notation simply is
-- not equal to 'www.baseballism.com' and never reaches the fetch. The
-- remaining vector is a REDIRECT to somewhere else, which is why the function
-- follows redirects manually and re-checks every hop against this same table
-- rather than letting fetch() follow them.
--
-- Verified against the live shop before building (2026-09-09): the main store
-- reports domain 'www.baseballism.com' alongside its myshopify domain, so both
-- forms are real and both belong here.

create table if not exists public.shopify_shop_domains (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  -- The connection this host was learned from (the *.myshopify.com identity).
  shop_domain       text not null,
  -- The host itself, lowercased, no scheme, no port, no trailing dot.
  host              text not null,
  -- 'myshopify'  — the shop's permanent domain, known from the OAuth grant
  -- 'primary'    — the custom storefront domain Shopify reports for the shop
  kind              text not null check (kind in ('myshopify', 'primary')),
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

-- One row per host per company. A host is either allowed for this company or
-- it is not; two shops legitimately sharing a host would be the same allowance.
create unique index if not exists shopify_shop_domains_identity
  on public.shopify_shop_domains (company_entity_id, host);

alter table public.shopify_shop_domains enable row level security;

drop policy if exists shopify_shop_domains_select on public.shopify_shop_domains;
create policy shopify_shop_domains_select on public.shopify_shop_domains
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- No client write policy, deliberately and importantly: this table IS the
-- security boundary for page-inspect. If an admin could insert a row here they
-- could point the fetcher at any host they liked, which is the whole attack
-- the allowlist exists to prevent. Only the sync (service role) writes it.

comment on table public.shopify_shop_domains is
  'Storefront hosts SILO is permitted to fetch, learned from Shopify itself '
  '(the shop object''s domain + myshopify_domain) for each connected shop. '
  'THIS IS A SECURITY BOUNDARY for the page-inspect edge function, not a '
  'convenience list: it has no client write policy on purpose, because a row '
  'here authorises an outbound fetch from our infrastructure.';

-- ── Captures ────────────────────────────────────────────────────────────────
-- One row per inspection. Kept rather than computed on demand so a baseline
-- can be captured BEFORE a change and compared with an equally-dated capture
-- after it, which is the whole point of recording a measurement rather than
-- describing one.
create table if not exists public.page_inspections (
  id                 uuid primary key default gen_random_uuid(),
  company_entity_id  uuid not null references public.entities(id) on delete cascade,

  requested_url      text not null,
  host               text not null,
  -- Where the request actually ENDED after redirects, and the hops it took.
  final_url          text,
  redirect_chain     jsonb not null default '[]'::jsonb,
  http_status        integer,

  -- On-page facts. Every one of these is what the PAGE SAYS about itself.
  title              text,
  title_length       integer,
  meta_description   text,
  meta_description_length integer,
  canonical_url      text,
  -- The page's own robots directive. This records an INSTRUCTION the page
  -- gives, and is NOT an observation of whether any search engine has indexed
  -- or ranked the page -- SILO holds no such data and must never claim it.
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

  -- Completeness and provenance, per the measurement rules: a capture with no
  -- capture time, no source and no truncation flag cannot be compared to
  -- another one honestly.
  content_bytes      integer,
  is_truncated       boolean not null default false,
  response_ms        integer,
  html_sha256        text,
  fetch_error        text,
  fetched_at         timestamptz not null default now(),
  fetched_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now()
);

create index if not exists page_inspections_company_url
  on public.page_inspections (company_entity_id, requested_url, fetched_at desc);
create index if not exists page_inspections_company_fetched
  on public.page_inspections (company_entity_id, fetched_at desc);

alter table public.page_inspections enable row level security;

drop policy if exists page_inspections_select on public.page_inspections;
create policy page_inspections_select on public.page_inspections
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- Written only by the page-inspect edge function (service role). A client
-- insert would let someone record a capture that never happened, which is
-- worse than having no capture: the row would look like evidence.

comment on table public.page_inspections is
  'Point-in-time captures of what a storefront page says about itself '
  '(title, meta description, canonical, headings, word count, structured '
  'data). Written by the page-inspect edge function against an allowlisted '
  'host. Every row is a MEASUREMENT: read fetched_at, is_truncated and '
  'fetch_error before comparing two captures. meta_robots is the page''s own '
  'directive, NOT evidence about indexing or ranking -- SILO holds no search '
  'engine data of any kind.';

insert into public.silo_chat_schema_catalog (relname, relkind, description, keywords, columns)
values
  ('shopify_shop_domains', 'r',
   'Storefront hosts SILO may fetch, learned from Shopify per connected shop '
   '(primary custom domain + myshopify domain). Security boundary for '
   'page-inspect; no client writes. Useful for answering which domain a store '
   'actually serves from.',
   array['shopify','domain','storefront','allowlist','host'],
   '[]'::jsonb),
  ('page_inspections', 'r',
   'Captures of what a storefront page SAYS ABOUT ITSELF at a moment in time: '
   'title, meta description, canonical, h1/h2, word count, images missing '
   'alt, JSON-LD types. ALWAYS read fetched_at (captures age), is_truncated '
   'and fetch_error before comparing rows -- a failed or truncated capture is '
   'not a page with no content. word_count measures the SERVER-RENDERED HTML, '
   'so content a theme injects with JavaScript is not counted: a low count is '
   'evidence about the HTML, not about what a visitor sees. meta_robots is '
   'the PAGE''S OWN DIRECTIVE and '
   'is NOT evidence that a page is or is not indexed or ranked: SILO holds no '
   'Search Console or search-engine data, so never infer indexing, ranking, '
   'impressions or queries from anything in this table.',
   array['seo','page','meta','title','canonical','inspection','content','audit'],
   '[]'::jsonb)
on conflict (relname) do update
  set description = excluded.description,
      keywords    = excluded.keywords,
      updated_at  = now();

select public.refresh_chat_schema_catalog();
