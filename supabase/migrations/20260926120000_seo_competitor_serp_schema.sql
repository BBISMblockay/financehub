-- SEO competitor research: the keyword set, the competitor-domain registry and
-- dated SERP observations. Provider-independent -- the schema step 4 of the
-- sequence in docs/ops/seo-project.md, built to docs/ops/seo-competitors.md.
--
-- WHAT IS AND IS NOT HERE. Until this migration SILO held no SERP data of any
-- kind, and Ask SILO's prompt said so in three places. After it, SILO holds
-- OBSERVATIONS: one row per keyword x date x location x device x source x
-- result position, each recording which domain and URL sat at that position
-- on that day. Nothing here is a ranking "index" and nothing here is
-- continuous: a keyword has a position on the dates somebody looked and no
-- position on the dates nobody did. The three kinds of number the doc keeps
-- apart stay apart -- a measured position lives here, an estimated search
-- volume (when a provider supplies one) will live in its own table with its
-- own source label, and an editorial judgment lives in seo_tasks.rationale.
--
-- THE TWO FACTS THIS SCHEMA EXISTS TO KEEP DISTINGUISHABLE
--
-- 1. NEVER OBSERVED is not NOT RANKING. A keyword with no observation row was
--    not looked at; a keyword that WAS looked at and returned no row for our
--    domain was observed outside the captured depth. Those are different
--    facts and the table shape has to carry the difference, which is why
--    seo_serp_run_keywords exists: a run records every keyword it ASKED
--    about, so "asked, nothing returned" (result_count 0) is a stored
--    measurement and "never asked" is the absence of that row. The landscape
--    view renders the first as 0 and the second as NULL.
--
-- 2. AN OBSERVED SERP POSITION IS NOT A SEARCH CONSOLE POSITION. The first is
--    one dated snapshot of who appeared where for one query, location and
--    device. The second (search_console_query_daily.position) is Google's
--    impression-weighted AVERAGE of where our pages showed across every
--    search that day. seo_keyword_landscape_v puts both on one row, under
--    different column names, so a reader can compare them without ever
--    being handed one as the other.
--
-- WRITERS. seo_serp_runs / seo_serp_run_keywords / seo_serp_observations have
-- a select policy and NO client write policy at all -- the same stance as
-- seo_task_revisions and the search_console_* tables. The provider sync
-- (service role, docs/ops/seo-competitors.md's step 5, not in this PR) and
-- seo_import_manual_serp_observations() (SECURITY DEFINER, for a person
-- recording a dated manual SERP check) are the only writers. Observations are
-- append-only: no update or delete policy exists, and a correction is a newer
-- run, never an edit.
--
-- NEWEST RUN WINS, by construction. Same trigger shape as
-- 20260914130000_search_console_newest_run_wins.sql: a run row is written
-- first (its id is what observations cite), its keyword requests and
-- observations follow, and completed_at is stamped LAST. An UPDATE carrying
-- an older synced_at than the stored row is dropped, and an INSERT into a run
-- a newer writer has already completed is dropped. So a weekly run and a
-- manual re-run that overlap cannot leave a snapshot no single fetch produced.
--
-- The location, device, date and source columns on every observation are NOT
-- NULL and CHECKed, not notes: the doc's cost model is "1 keyword x 1 location
-- x 1 device x 1 date", and a row that cannot say which of those it is cannot
-- be compared with anything.

-- ── The keyword set ─────────────────────────────────────────────────────────
-- One row per keyword per company. keyword_norm is the identity: "Baseball
-- Dad Hat " and "baseball dad hat" are one keyword, and it is also the join
-- key to search_console_query_daily.query, which is stored verbatim as Google
-- returns it (no normalisation there, on purpose -- see 20260910180000).
create table if not exists public.seo_keyword_set (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  keyword           text not null,
  keyword_norm      text generated always as (lower(btrim(regexp_replace(keyword, '\s+', ' ', 'g')))) stored,
  -- Which of the four sources in docs/ops/seo-competitors.md put it here.
  source            text not null check (source in (
                      'search_console_clicks', 'search_console_opportunity',
                      'collection', 'product_type', 'launch', 'manual'
                    )),
  -- Stock and launch context: "out of stock until October", "ties to the
  -- Opening Day drop". Editorial, and kept as text on purpose.
  commercial_note   text,
  priority          integer,
  is_active         boolean not null default true,
  created_by        uuid references auth.users(id) on delete set null default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint seo_keyword_set_not_blank check (btrim(keyword) <> ''),
  unique (id, company_entity_id)
);

create unique index if not exists seo_keyword_set_company_keyword
  on public.seo_keyword_set (company_entity_id, keyword_norm);

alter table public.seo_keyword_set enable row level security;

drop policy if exists seo_keyword_set_select on public.seo_keyword_set;
create policy seo_keyword_set_select on public.seo_keyword_set
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- Any member may propose a keyword; the person who added it or an approver
-- edits or removes it. Same creator-or-approver rule as seo_tasks.
drop policy if exists seo_keyword_set_insert on public.seo_keyword_set;
create policy seo_keyword_set_insert on public.seo_keyword_set
  for insert to authenticated
  with check (company_entity_id = public.active_company_id());

drop policy if exists seo_keyword_set_update on public.seo_keyword_set;
create policy seo_keyword_set_update on public.seo_keyword_set
  for update to authenticated
  using (company_entity_id = public.active_company_id()
         and (created_by = auth.uid() or public.can_approve_seo_tasks()))
  with check (company_entity_id = public.active_company_id()
              and (created_by = auth.uid() or public.can_approve_seo_tasks()));

drop policy if exists seo_keyword_set_delete on public.seo_keyword_set;
create policy seo_keyword_set_delete on public.seo_keyword_set
  for delete to authenticated
  using (company_entity_id = public.active_company_id()
         and (created_by = auth.uid() or public.can_approve_seo_tasks()));

revoke all on public.seo_keyword_set from anon;

drop trigger if exists trg_seo_keyword_set_updated_at on public.seo_keyword_set;
create trigger trg_seo_keyword_set_updated_at
  before update on public.seo_keyword_set
  for each row execute function public.set_updated_at();

-- ── The competitor-domain registry ──────────────────────────────────────────
-- The CURATED list. A search competitor is whoever the observations show on
-- the SERP; that list is DERIVED (seo_competitor_share_v) and is never
-- silently merged into this one. relationship says why a domain is listed:
-- commercial (sells to the same customer), search (appears on our SERPs),
-- both. Approver-only writes -- naming a competitor is a judgment, and the
-- doc asks for it to be exec-approved.
create table if not exists public.seo_competitor_domains (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  domain            text not null,
  domain_norm       text generated always as (regexp_replace(lower(btrim(domain)), '^www\.', '')) stored,
  relationship      text not null check (relationship in ('commercial', 'search', 'both')),
  note              text,
  added_by          uuid references auth.users(id) on delete set null default auth.uid(),
  created_at        timestamptz not null default now(),
  constraint seo_competitor_domains_not_blank check (btrim(domain) <> '')
);

create unique index if not exists seo_competitor_domains_company_domain
  on public.seo_competitor_domains (company_entity_id, domain_norm);

alter table public.seo_competitor_domains enable row level security;

drop policy if exists seo_competitor_domains_select on public.seo_competitor_domains;
create policy seo_competitor_domains_select on public.seo_competitor_domains
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists seo_competitor_domains_write on public.seo_competitor_domains;
create policy seo_competitor_domains_write on public.seo_competitor_domains
  for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_approve_seo_tasks())
  with check (company_entity_id = public.active_company_id() and public.can_approve_seo_tasks());

revoke all on public.seo_competitor_domains from anon;

-- ── Runs: one fetch identity, the parent row ────────────────────────────────
-- Identity is (company, provider, date, location, language, device, engine):
-- the doc's "same query, location, device and depth on a schedule". A
-- provider run and a manual run on the same date are two runs, never pooled.
create table if not exists public.seo_serp_runs (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  provider          text not null check (provider in ('dataforseo', 'manual')),
  observed_on       date not null,
  -- DataForSEO's numeric location code (2840 = United States); null for a
  -- manual run, which names the location in words only.
  location_code     integer,
  location_name     text not null,
  language_code     text not null default 'en',
  device            text not null check (device in ('desktop', 'mobile')),
  search_engine     text not null default 'google',
  depth             integer not null default 10 check (depth between 1 and 100),
  keyword_count     integer,
  result_count      integer,
  cost_usd          numeric(10, 4),
  requested_at      timestamptz,
  -- Stamped LAST by every writer. A run with completed_at null is in flight
  -- or abandoned; the landscape and share views read completed runs only.
  completed_at      timestamptz,
  synced_at         timestamptz not null default now(),
  sync_batch_id     text,
  -- The person, for a manual run. Null for the provider.
  recorded_by       uuid references auth.users(id) on delete set null,
  note              text,
  created_at        timestamptz not null default now(),
  constraint seo_serp_runs_location_not_blank check (btrim(location_name) <> ''),
  unique (id, company_entity_id),
  unique (company_entity_id, provider, observed_on, location_name, language_code, device, search_engine)
);

create index if not exists seo_serp_runs_company_latest
  on public.seo_serp_runs (company_entity_id, provider, device, observed_on desc)
  where completed_at is not null;

alter table public.seo_serp_runs enable row level security;

drop policy if exists seo_serp_runs_select on public.seo_serp_runs;
create policy seo_serp_runs_select on public.seo_serp_runs
  for select to authenticated
  using (company_entity_id = public.active_company_id());

revoke all on public.seo_serp_runs from anon;

-- ── Which keywords a run ASKED about ────────────────────────────────────────
-- Fact 1 above. result_count 0 is "asked, nothing returned within depth";
-- the absence of a row is "never asked". provider_request_id and cost are
-- per keyword because that is the unit the provider bills.
create table if not exists public.seo_serp_run_keywords (
  id                  uuid primary key default gen_random_uuid(),
  company_entity_id   uuid not null references public.entities(id) on delete cascade,
  run_id              uuid not null,
  keyword_id          uuid not null,
  result_count        integer not null default 0 check (result_count >= 0),
  provider_request_id text,
  cost_usd            numeric(10, 4),
  synced_at           timestamptz not null default now(),
  sync_batch_id       text,
  unique (run_id, keyword_id),
  constraint seo_serp_run_keywords_run_company_fkey
    foreign key (run_id, company_entity_id) references public.seo_serp_runs(id, company_entity_id) on delete cascade,
  constraint seo_serp_run_keywords_keyword_company_fkey
    foreign key (keyword_id, company_entity_id) references public.seo_keyword_set(id, company_entity_id) on delete cascade
);

create index if not exists seo_serp_run_keywords_keyword
  on public.seo_serp_run_keywords (keyword_id, run_id);

alter table public.seo_serp_run_keywords enable row level security;

drop policy if exists seo_serp_run_keywords_select on public.seo_serp_run_keywords;
create policy seo_serp_run_keywords_select on public.seo_serp_run_keywords
  for select to authenticated
  using (company_entity_id = public.active_company_id());

revoke all on public.seo_serp_run_keywords from anon;

-- ── Observations: append-only ───────────────────────────────────────────────
-- provider / observed_on / location_name / language_code / device /
-- search_engine are DENORMALISED from the run and NOT NULL here, so a row is
-- self-describing and the constraint is on the row a reader gets, not on a
-- join they may forget.
create table if not exists public.seo_serp_observations (
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
  result_type       text not null default 'organic'
                    check (result_type in ('organic', 'shopping', 'paa', 'video', 'local', 'other')),
  position          integer not null check (position >= 1),
  domain            text not null,
  domain_norm       text generated always as (regexp_replace(lower(btrim(domain)), '^www\.', '')) stored,
  url               text not null,
  title             text,
  synced_at         timestamptz not null default now(),
  sync_batch_id     text,
  created_at        timestamptz not null default now(),
  constraint seo_serp_observations_domain_not_blank check (btrim(domain) <> ''),
  constraint seo_serp_observations_url_not_blank check (btrim(url) <> ''),
  unique (run_id, keyword_id, result_type, position),
  constraint seo_serp_observations_run_company_fkey
    foreign key (run_id, company_entity_id) references public.seo_serp_runs(id, company_entity_id) on delete cascade,
  constraint seo_serp_observations_keyword_company_fkey
    foreign key (keyword_id, company_entity_id) references public.seo_keyword_set(id, company_entity_id) on delete cascade
);

create index if not exists seo_serp_observations_keyword_day
  on public.seo_serp_observations (company_entity_id, keyword_id, observed_on desc);
create index if not exists seo_serp_observations_domain
  on public.seo_serp_observations (company_entity_id, domain_norm, observed_on desc);

alter table public.seo_serp_observations enable row level security;

drop policy if exists seo_serp_observations_select on public.seo_serp_observations;
create policy seo_serp_observations_select on public.seo_serp_observations
  for select to authenticated
  using (company_entity_id = public.active_company_id());

revoke all on public.seo_serp_observations from anon;

-- ── Newest completed run wins ───────────────────────────────────────────────
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

  -- INSERT of a keyword request or an observation: refused if the run it
  -- cites was completed by a newer writer. The run row itself has nothing
  -- above it to consult.
  if tg_table_name in ('seo_serp_run_keywords', 'seo_serp_observations') then
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
  'seo_serp_observations: an update whose synced_at is older than the stored '
  'row is dropped, and a keyword-request or observation insert into a run a '
  'newer writer already completed is dropped. Equal timestamps pass (a retry '
  'within one run). Same guarantee as search_console_reject_stale_write().';

drop trigger if exists trg_seo_serp_newest_run_wins on public.seo_serp_runs;
create trigger trg_seo_serp_newest_run_wins
  before insert or update on public.seo_serp_runs
  for each row execute function public.seo_serp_reject_stale_write();

drop trigger if exists trg_seo_serp_newest_run_wins on public.seo_serp_run_keywords;
create trigger trg_seo_serp_newest_run_wins
  before insert or update on public.seo_serp_run_keywords
  for each row execute function public.seo_serp_reject_stale_write();

drop trigger if exists trg_seo_serp_newest_run_wins on public.seo_serp_observations;
create trigger trg_seo_serp_newest_run_wins
  before insert or update on public.seo_serp_observations
  for each row execute function public.seo_serp_reject_stale_write();

-- ── The manual import: the one client-side writer ───────────────────────────
-- A person ran the SERP check themselves (docs/ops/seo-competitors.md, "What a
-- manual pilot can and cannot be") and is recording what they saw. Any active
-- member may, attributed -- the seo_task_publications stance: a statement of
-- fact by the person who did the work, not a permission. It is DEFINER
-- because the observation tables carry no insert policy on purpose, and it
-- scopes every keyword lookup to the CALLER'S ACTIVE COMPANY by hand.
--
-- p_rows: [{keyword_id | keyword, position, domain, url, title?, result_type?}]
-- One call = one date x location x device. Re-calling for the same identity
-- APPENDS keywords not yet recorded on it and REFUSES a keyword already
-- recorded there -- an observation is never edited into a different one.
create or replace function public.seo_import_manual_serp_observations(
  p_rows          jsonb,
  p_observed_on   date,
  p_location_name text,
  p_device        text,
  p_note          text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company   uuid := public.active_company_id();
  v_user      uuid := auth.uid();
  v_run       uuid;
  v_row       jsonb;
  v_keyword   uuid;
  v_norm      text;
  v_position  integer;
  v_type      text;
  v_written   integer := 0;
  v_keywords  uuid[] := '{}';
  v_resolved  uuid[] := '{}';
  v_counts    jsonb := '{}'::jsonb;
begin
  if v_user is null or v_company is null then
    raise exception 'no active company for the caller' using errcode = 'insufficient_privilege';
  end if;
  if p_device is null or p_device not in ('desktop', 'mobile') then
    raise exception 'device must be desktop or mobile (got %)', coalesce(p_device, 'null') using errcode = 'check_violation';
  end if;
  if p_observed_on is null then
    raise exception 'observed_on is required' using errcode = 'check_violation';
  end if;
  if p_observed_on > public.silo_business_today() then
    raise exception 'observed_on % is in the future', p_observed_on using errcode = 'check_violation';
  end if;
  if p_location_name is null or btrim(p_location_name) = '' then
    raise exception 'location_name is required (e.g. United States)' using errcode = 'check_violation';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'no rows to import' using errcode = 'check_violation';
  end if;

  -- Resolve every keyword FIRST, so a bad row leaves nothing behind and the
  -- "already recorded" check sees the whole payload at once.
  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_keyword := null;
    if v_row ? 'keyword_id' and nullif(v_row ->> 'keyword_id', '') is not null then
      select k.id into v_keyword
      from public.seo_keyword_set k
      where k.id = (v_row ->> 'keyword_id')::uuid
        and k.company_entity_id = v_company;
    elsif nullif(btrim(coalesce(v_row ->> 'keyword', '')), '') is not null then
      v_norm := lower(btrim(regexp_replace(v_row ->> 'keyword', '\s+', ' ', 'g')));
      select k.id into v_keyword
      from public.seo_keyword_set k
      where k.keyword_norm = v_norm
        and k.company_entity_id = v_company;
    end if;
    if v_keyword is null then
      raise exception 'keyword % is not in this company''s keyword set -- add it to seo_keyword_set first',
        coalesce(v_row ->> 'keyword', v_row ->> 'keyword_id', '(missing)') using errcode = 'check_violation';
    end if;
    v_resolved := v_resolved || v_keyword;

    v_position := case when jsonb_typeof(v_row -> 'position') = 'number' then (v_row ->> 'position')::integer else null end;
    if v_position is null or v_position < 1 then
      raise exception 'position must be a positive integer (keyword %)', v_row ->> 'keyword' using errcode = 'check_violation';
    end if;
    if nullif(btrim(coalesce(v_row ->> 'domain', '')), '') is null then
      raise exception 'domain is required on every row (keyword %, position %)', coalesce(v_row ->> 'keyword', v_row ->> 'keyword_id'), v_position using errcode = 'check_violation';
    end if;
    if nullif(btrim(coalesce(v_row ->> 'url', '')), '') is null then
      raise exception 'url is required on every row (keyword %, position %)', coalesce(v_row ->> 'keyword', v_row ->> 'keyword_id'), v_position using errcode = 'check_violation';
    end if;
    v_type := coalesce(nullif(btrim(v_row ->> 'result_type'), ''), 'organic');
    if v_type not in ('organic', 'shopping', 'paa', 'video', 'local', 'other') then
      raise exception 'result_type must be one of organic, shopping, paa, video, local, other (got %)', v_type using errcode = 'check_violation';
    end if;
  end loop;

  select array_agg(distinct k) into v_keywords from unnest(v_resolved) as k;

  insert into public.seo_serp_runs (company_entity_id, provider, observed_on, location_name, language_code, device, search_engine, depth,
                                    requested_at, synced_at, recorded_by, note)
  values (v_company, 'manual', p_observed_on, btrim(p_location_name), 'en', p_device, 'google', 10, now(), now(), v_user, p_note)
  on conflict (company_entity_id, provider, observed_on, location_name, language_code, device, search_engine)
  do update set synced_at = now(),
                note      = coalesce(public.seo_serp_runs.note, excluded.note)
  returning id into v_run;

  if exists (select 1 from public.seo_serp_run_keywords rk where rk.run_id = v_run and rk.keyword_id = any (v_keywords)) then
    raise exception 'a keyword in this payload is already recorded for % / % / % -- a manual observation is never overwritten; record a new date instead',
      p_observed_on, btrim(p_location_name), p_device using errcode = 'unique_violation';
  end if;

  insert into public.seo_serp_run_keywords (company_entity_id, run_id, keyword_id, result_count, synced_at)
  select v_company, v_run, k, 0, now() from unnest(v_keywords) as k;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    if v_row ? 'keyword_id' and nullif(v_row ->> 'keyword_id', '') is not null then
      select k.id into v_keyword from public.seo_keyword_set k
      where k.id = (v_row ->> 'keyword_id')::uuid and k.company_entity_id = v_company;
    else
      v_norm := lower(btrim(regexp_replace(v_row ->> 'keyword', '\s+', ' ', 'g')));
      select k.id into v_keyword from public.seo_keyword_set k
      where k.keyword_norm = v_norm and k.company_entity_id = v_company;
    end if;
    v_type := coalesce(nullif(btrim(v_row ->> 'result_type'), ''), 'organic');
    insert into public.seo_serp_observations (company_entity_id, run_id, keyword_id, provider, observed_on, location_name, language_code, device,
                                              search_engine, result_type, position, domain, url, title, synced_at)
    values (v_company, v_run, v_keyword, 'manual', p_observed_on, btrim(p_location_name), 'en', p_device,
            'google', v_type, (v_row ->> 'position')::integer, btrim(v_row ->> 'domain'), btrim(v_row ->> 'url'),
            nullif(btrim(v_row ->> 'title'), ''), now());
    v_written := v_written + 1;
  end loop;

  update public.seo_serp_run_keywords rk
  set result_count = (select count(*) from public.seo_serp_observations o where o.run_id = rk.run_id and o.keyword_id = rk.keyword_id)
  where rk.run_id = v_run and rk.keyword_id = any (v_keywords);

  update public.seo_serp_runs r
  set completed_at  = now(),
      synced_at     = now(),
      keyword_count = (select count(*) from public.seo_serp_run_keywords rk where rk.run_id = r.id),
      result_count  = (select count(*) from public.seo_serp_observations o where o.run_id = r.id)
  where r.id = v_run;

  return jsonb_build_object(
    'run_id', v_run,
    'rows_written', v_written,
    'keywords', array_length(v_keywords, 1),
    'observed_on', p_observed_on,
    'location_name', btrim(p_location_name),
    'device', p_device,
    'provider', 'manual'
  );
end;
$$;

revoke all on function public.seo_import_manual_serp_observations(jsonb, date, text, text, text) from public, anon;
grant execute on function public.seo_import_manual_serp_observations(jsonb, date, text, text, text) to authenticated;

comment on function public.seo_import_manual_serp_observations(jsonb, date, text, text, text) is
  'Records a person''s own dated SERP check as provider=manual observations for '
  'the caller''s active company: one call is one date x location x device; every '
  'row names a keyword already in seo_keyword_set, a position, a domain and a '
  'URL. Appends keywords not yet on that manual run and refuses one already '
  'recorded there. The only client-side writer of seo_serp_observations.';

-- ── Own-domain resolution ───────────────────────────────────────────────────
-- "Our" position in a SERP is our storefront host at some position. The hosts
-- are the ones Shopify vouches for (shopify_shop_domains), normalised the way
-- observation domains are, so www. and bare match each other.
drop view if exists public.seo_competitor_share_v;
drop view if exists public.seo_keyword_landscape_v;
drop view if exists public.seo_serp_observations_v;

create view public.seo_serp_observations_v
with (security_invoker = true) as
select
  o.id,
  o.company_entity_id,
  o.run_id,
  o.keyword_id,
  k.keyword,
  k.keyword_norm,
  o.provider,
  o.observed_on,
  o.location_name,
  o.language_code,
  o.device,
  o.search_engine,
  o.result_type,
  o.position,
  o.domain,
  o.domain_norm,
  o.url,
  o.title,
  exists (
    select 1 from public.shopify_shop_domains d
    where d.company_entity_id = o.company_entity_id
      and regexp_replace(lower(d.host), '^www\.', '') = o.domain_norm
  ) as is_own_domain,
  c.relationship,
  o.synced_at,
  o.sync_batch_id
from public.seo_serp_observations o
join public.seo_keyword_set k on k.id = o.keyword_id
left join public.seo_competitor_domains c
  on c.company_entity_id = o.company_entity_id and c.domain_norm = o.domain_norm;

comment on view public.seo_serp_observations_v is
  'One row per observed SERP result: keyword, date, location, device, source, '
  'position, domain and URL, with is_own_domain (matches the company''s verified '
  'storefront hosts) and the registry relationship where the domain is curated. '
  'A row is one dated observation; absence is never zero.';

-- ── The landscape: every keyword, whatever was or was not observed ──────────
-- Grain: keyword x run identity (provider, device, location, language,
-- engine) for every identity the company has completed a run under. A
-- company with no runs still lists its keywords, once, with null identity.
create view public.seo_keyword_landscape_v
with (security_invoker = true) as
with identities as (
  select distinct r.company_entity_id, r.provider, r.device, r.location_name, r.language_code, r.search_engine
  from public.seo_serp_runs r
  where r.completed_at is not null
),
gsc_window as (
  select s.company_entity_id, max(s.day_date) as window_end, max(s.day_date) - 27 as window_start
  from public.search_console_site_daily s
  group by s.company_entity_id
),
gsc as (
  select q.company_entity_id,
         lower(btrim(regexp_replace(q.query, '\s+', ' ', 'g'))) as keyword_norm,
         sum(q.clicks) as clicks,
         sum(q.impressions) as impressions,
         case when sum(q.impressions) > 0
              then round(sum(q.position * q.impressions)::numeric / sum(q.impressions), 2) end as position,
         min(w.window_start) as window_start,
         min(w.window_end) as window_end
  from public.search_console_query_daily q
  join gsc_window w on w.company_entity_id = q.company_entity_id
  where q.day_date between w.window_start and w.window_end
  group by q.company_entity_id, lower(btrim(regexp_replace(q.query, '\s+', ' ', 'g')))
)
select
  k.id                       as keyword_id,
  k.company_entity_id,
  k.keyword,
  k.keyword_norm,
  k.source,
  k.priority,
  k.is_active,
  k.commercial_note,
  i.provider,
  i.device,
  i.location_name,
  i.language_code,
  i.search_engine,
  coalesce(runs.observation_runs, 0)::integer as observation_runs,
  latest.observed_on         as latest_observed_on,
  latest.run_id              as latest_run_id,
  case when latest.run_id is not null then coalesce(latest_results.n, 0) end as results_in_latest_run,
  case when latest.run_id is not null then coalesce(latest_results.results, '[]'::jsonb) end as latest_top_results,
  latest_results.our_position as our_serp_position,
  previous.observed_on       as previous_observed_on,
  previous_results.our_position as our_previous_serp_position,
  case when latest_results.our_position is not null and previous_results.our_position is not null
       then previous_results.our_position - latest_results.our_position end as our_serp_movement,
  g.position                 as search_console_avg_position_28d,
  g.clicks                   as search_console_clicks_28d,
  g.impressions              as search_console_impressions_28d,
  g.window_start             as search_console_window_start,
  g.window_end               as search_console_window_end
from public.seo_keyword_set k
left join identities i on i.company_entity_id = k.company_entity_id
left join lateral (
  select count(*) as observation_runs
  from public.seo_serp_run_keywords rk
  join public.seo_serp_runs r on r.id = rk.run_id
  where rk.keyword_id = k.id and r.completed_at is not null
    and i.provider is not null
    and r.provider = i.provider and r.device = i.device and r.location_name = i.location_name
    and r.language_code = i.language_code and r.search_engine = i.search_engine
) runs on true
left join lateral (
  select r.id as run_id, r.observed_on
  from public.seo_serp_run_keywords rk
  join public.seo_serp_runs r on r.id = rk.run_id
  where rk.keyword_id = k.id and r.completed_at is not null
    and i.provider is not null
    and r.provider = i.provider and r.device = i.device and r.location_name = i.location_name
    and r.language_code = i.language_code and r.search_engine = i.search_engine
  order by r.observed_on desc, r.synced_at desc
  limit 1
) latest on true
left join lateral (
  select r.id as run_id, r.observed_on
  from public.seo_serp_run_keywords rk
  join public.seo_serp_runs r on r.id = rk.run_id
  where rk.keyword_id = k.id and r.completed_at is not null
    and latest.run_id is not null and r.id <> latest.run_id
    and r.observed_on < latest.observed_on
    and r.provider = i.provider and r.device = i.device and r.location_name = i.location_name
    and r.language_code = i.language_code and r.search_engine = i.search_engine
  order by r.observed_on desc, r.synced_at desc
  limit 1
) previous on true
left join lateral (
  select count(*) as n,
         jsonb_agg(jsonb_build_object(
           'position', v.position, 'domain', v.domain, 'url', v.url, 'title', v.title,
           'result_type', v.result_type, 'relationship', v.relationship, 'is_own_domain', v.is_own_domain
         ) order by v.position) as results,
         min(v.position) filter (where v.is_own_domain and v.result_type = 'organic') as our_position
  from public.seo_serp_observations_v v
  where v.run_id = latest.run_id and v.keyword_id = k.id
) latest_results on true
left join lateral (
  select min(v.position) filter (where v.is_own_domain and v.result_type = 'organic') as our_position
  from public.seo_serp_observations_v v
  where v.run_id = previous.run_id and v.keyword_id = k.id
) previous_results on true
left join gsc g on g.company_entity_id = k.company_entity_id and g.keyword_norm = k.keyword_norm;

comment on view public.seo_keyword_landscape_v is
  'Every keyword in seo_keyword_set, per run identity (provider x device x '
  'location), with the LATEST observed SERP and our position in it, the '
  'previous run''s position, the movement between them, and -- as two different '
  'measures on one row -- our Search Console impression-weighted average '
  'position over the last 28 ingested days. results_in_latest_run 0 means the '
  'run asked and nothing came back within depth; NULL means never observed. '
  'our_serp_position NULL means our storefront was not in the observed results.';

-- ── Derived search competitors: who appears, counted against what was asked ─
create view public.seo_competitor_share_v
with (security_invoker = true) as
with latest_runs as (
  select distinct on (r.company_entity_id, r.provider, r.device, r.location_name, r.language_code, r.search_engine)
         r.id as run_id, r.company_entity_id, r.provider, r.device, r.location_name, r.language_code, r.search_engine, r.observed_on
  from public.seo_serp_runs r
  where r.completed_at is not null
  order by r.company_entity_id, r.provider, r.device, r.location_name, r.language_code, r.search_engine, r.observed_on desc, r.synced_at desc
),
asked as (
  select rk.run_id, count(*) as keywords_observed
  from public.seo_serp_run_keywords rk
  group by rk.run_id
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
  bool_or(v.is_own_domain)                                         as is_own_domain,
  max(v.relationship)                                              as relationship,
  a.keywords_observed,
  count(distinct v.keyword_id) filter (where v.position <= 10)     as keywords_in_top_10,
  count(distinct v.keyword_id) filter (where v.position <= 3)      as keywords_in_top_3,
  min(v.position)                                                  as best_position,
  round(avg(v.position), 2)                                        as avg_position
from latest_runs lr
join asked a on a.run_id = lr.run_id
join public.seo_serp_observations_v v on v.run_id = lr.run_id and v.result_type = 'organic'
group by lr.company_entity_id, lr.provider, lr.device, lr.location_name, lr.language_code, lr.search_engine,
         lr.observed_on, lr.run_id, v.domain_norm, a.keywords_observed;

comment on view public.seo_competitor_share_v is
  'Search competitors DERIVED from the latest completed run per provider x device '
  'x location: for each domain observed in organic results, how many of the '
  'keywords that run ASKED ABOUT (keywords_observed, the only valid denominator) '
  'it appeared in the top 10 and top 3 of, its best and average position, and '
  'whether it is our own storefront or a curated competitor. No percentage is '
  'stored: divide by keywords_observed and say so.';

-- ── Keyword candidates: the four-source list, provider-free ─────────────────
-- The selection rule from docs/ops/seo-competitors.md, as a reviewable list
-- rather than an auto-insert: a person reads it and adds what belongs.
-- INVOKER so every registry it reads is under the caller's own RLS.
create or replace function public.seo_derive_keyword_candidates(p_days integer default 90)
returns table (
  company_entity_id uuid,
  keyword           text,
  keyword_norm      text,
  source            text,
  clicks            bigint,
  impressions       bigint,
  our_position      numeric,
  evidence          jsonb,
  already_in_set    boolean,
  coverage_note     text
)
language sql
stable
as $$
with co as (
  select public.active_company_id() as id
),
w as (
  select s.company_entity_id,
         max(s.day_date) as window_end,
         max(s.day_date) - (greatest(coalesce(p_days, 90), 1) - 1) as window_start
  from public.search_console_site_daily s, co
  where s.company_entity_id = co.id
  group by s.company_entity_id
),
coverage as (
  select s.company_entity_id,
         sum(s.clicks) as clicks,
         sum(s.unattributed_query_clicks) as unattributed,
         case when sum(s.clicks) > 0 and bool_and(s.unattributed_query_clicks is not null)
              then round(100.0 * sum(s.unattributed_query_clicks) / sum(s.clicks), 1) end as unattributed_pct,
         min(w.window_start) as window_start, min(w.window_end) as window_end
  from public.search_console_site_daily s
  join w on w.company_entity_id = s.company_entity_id
  where s.day_date between w.window_start and w.window_end
  group by s.company_entity_id
),
note as (
  select c.company_entity_id,
         case when c.unattributed_pct is null
              then format('Search Console window %s to %s: unattributed query share NOT MEASURED for every day, so a query absent here may still bring traffic', c.window_start, c.window_end)
              else format('Search Console window %s to %s: %s%% of clicks belong to no returned query row (unattributed), so a query absent here may still bring traffic', c.window_start, c.window_end, c.unattributed_pct)
         end as coverage_note
  from coverage c
),
q as (
  select q.company_entity_id,
         lower(btrim(regexp_replace(q.query, '\s+', ' ', 'g'))) as keyword_norm,
         min(q.query) as keyword,
         sum(q.clicks) as clicks,
         sum(q.impressions) as impressions,
         case when sum(q.impressions) > 0
              then round(sum(q.position * q.impressions)::numeric / sum(q.impressions), 2) end as position,
         count(distinct q.day_date) as days_present
  from public.search_console_query_daily q
  join w on w.company_entity_id = q.company_entity_id
  where q.day_date between w.window_start and w.window_end
  group by q.company_entity_id, lower(btrim(regexp_replace(q.query, '\s+', ' ', 'g')))
),
-- Click leaders are queries we already rank on page one for (position <= 10,
-- or unmeasured); a query at position 14 with a trickle of clicks is an
-- OPPORTUNITY, not a leader, and the doc's two groups would otherwise fight
-- over it in a small set.
g1 as (
  select q.*, 'search_console_clicks'::text as source
  from q
  where q.position is null or q.position <= 10
  order by q.clicks desc, q.impressions desc
  limit 60
),
g2 as (
  select q.*, 'search_console_opportunity'::text as source
  from q
  where q.position > 10
    and q.keyword_norm not in (select keyword_norm from g1)
  order by q.impressions desc
  limit 30
),
g3_raw as (
  select co.id as company_entity_id,
         lower(btrim(regexp_replace(c.collection_title, '\s+', ' ', 'g'))) as keyword_norm,
         c.collection_title as keyword,
         'collection'::text as source,
         jsonb_build_object('collection_handle', c.collection_handle, 'sessions', c.sessions, 'products_count', c.products_count) as evidence
  from co, public.seo_collection_candidates(greatest(coalesce(p_days, 90), 1)) c
  where c.candidate_status = 'reviewable'
    and nullif(btrim(coalesce(c.collection_title, '')), '') is not null
  union all
  select pm.company_entity_id,
         lower(btrim(regexp_replace(pm.product_type, '\s+', ' ', 'g'))),
         min(pm.product_type),
         'product_type'::text,
         jsonb_build_object('live_skus', count(*))
  from public.products_master pm, co
  where pm.company_entity_id = co.id
    and pm.shopify_status = 'active'
    and pm.online_published_at is not null
    and nullif(btrim(coalesce(pm.product_type, '')), '') is not null
  group by pm.company_entity_id, lower(btrim(regexp_replace(pm.product_type, '\s+', ' ', 'g')))
),
g3 as (
  select distinct on (r.keyword_norm) r.*
  from g3_raw r
  where r.keyword_norm not in (select keyword_norm from g1 union select keyword_norm from g2)
  order by r.keyword_norm, r.source
  limit 40
),
g4 as (
  select lc.company_entity_id,
         lower(btrim(regexp_replace(lc.title, '\s+', ' ', 'g'))) as keyword_norm,
         min(lc.title) as keyword,
         'launch'::text as source,
         jsonb_build_object('launch_date', min(lc.launch_date)) as evidence
  from public.launch_calendar lc, co
  where lc.company_entity_id = co.id
    and lc.launch_date between public.silo_business_today() and public.silo_business_today() + 183
    and nullif(btrim(coalesce(lc.title, '')), '') is not null
    and lower(btrim(regexp_replace(lc.title, '\s+', ' ', 'g'))) not in (
      select keyword_norm from g1 union select keyword_norm from g2 union select keyword_norm from g3)
  group by lc.company_entity_id, lower(btrim(regexp_replace(lc.title, '\s+', ' ', 'g')))
  order by min(lc.launch_date)
  limit 20
),
candidates as (
  select company_entity_id, keyword, keyword_norm, source,
         jsonb_build_object('days_present', days_present) as evidence
  from g1
  union all
  select company_entity_id, keyword, keyword_norm, source,
         jsonb_build_object('days_present', days_present)
  from g2
  union all
  select company_entity_id, keyword, keyword_norm, source, evidence from g3
  union all
  select company_entity_id, keyword, keyword_norm, source, evidence from g4
)
select
  c.company_entity_id,
  c.keyword,
  c.keyword_norm,
  c.source,
  q.clicks::bigint,
  q.impressions::bigint,
  q.position as our_position,
  c.evidence,
  exists (select 1 from public.seo_keyword_set k
          where k.company_entity_id = c.company_entity_id and k.keyword_norm = c.keyword_norm) as already_in_set,
  case when c.source like 'search_console%' then n.coverage_note end as coverage_note
from candidates c
left join q on q.company_entity_id = c.company_entity_id and q.keyword_norm = c.keyword_norm
left join note n on n.company_entity_id = c.company_entity_id
order by case c.source
           when 'search_console_clicks' then 1
           when 'search_console_opportunity' then 2
           when 'collection' then 3
           when 'product_type' then 4
           else 5 end,
         q.clicks desc nulls last, c.keyword_norm;
$$;

revoke all on function public.seo_derive_keyword_candidates(integer) from public, anon;
grant execute on function public.seo_derive_keyword_candidates(integer) to authenticated;

comment on function public.seo_derive_keyword_candidates(integer) is
  'The bounded keyword-set candidates from docs/ops/seo-competitors.md, for the '
  'caller''s active company: up to 60 Search Console queries by clicks, 30 by '
  'impressions with position worse than 10, 40 collection and live product-type '
  'head terms, 20 upcoming launches. A reviewable list, never an auto-insert. '
  'our_position is the Search Console impression-weighted average where the '
  'term is a returned query; NULL otherwise, never 0. coverage_note carries the '
  'window''s unattributed share beside every Search Console-derived row.';

-- ── sync_jobs.job_type: append 'seo_serp_weekly' to the LIVE list ───────────
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
    raise exception 'sync_jobs_job_type_check not found; read the live job_type constraint before adding seo_serp_weekly';
  end if;

  if cur like '%seo_serp_weekly%' then
    return;
  end if;

  members := substring(cur from 'ARRAY\[(.*?)\]');
  if members is null or members = '' then
    raise exception 'sync_jobs_job_type_check has an unexpected shape (%); extend it by hand after reading it', cur;
  end if;

  execute 'alter table public.sync_jobs drop constraint sync_jobs_job_type_check';
  execute format(
    'alter table public.sync_jobs add constraint sync_jobs_job_type_check check (job_type = any (array[%s, %L::text]))',
    members, 'seo_serp_weekly'
  );
end $$;

-- ── The insert-stamp backstop ───────────────────────────────────────────────
select public.attach_stamp_company_entity_id_triggers();

-- ── Ask SILO catalog ────────────────────────────────────────────────────────
-- Guarded appends keyed on a marker phrase, the 20260910180000 style, so a
-- re-run of apply_all_post_merge.sql never doubles a paragraph and a later
-- correction is never overwritten.
insert into public.silo_chat_schema_catalog (relname, relkind, columns, description, keywords)
values
  ('seo_keyword_set', 'r', '[]'::jsonb,
   'The company''s bounded SEO keyword set: one row per keyword, identified by '
   'keyword_norm (lowercased, trimmed) which is also the join key to '
   'search_console_query_daily.query (normalise that side the same way). source '
   'says which of the four derivations put it here; commercial_note carries '
   'stock/launch context. A keyword being here says nothing about rankings -- '
   'read seo_keyword_landscape_v for what was observed.',
   array['seo','keyword','keyword set','search term','target keyword']),
  ('seo_competitor_domains', 'r', '[]'::jsonb,
   'The CURATED competitor list: domain, relationship (commercial = sells to '
   'the same customer; search = appears on our SERPs; both) and a note, '
   'approver-maintained. Search competitors are DERIVED from observations in '
   'seo_competitor_share_v and are not merged into this list -- a marketplace '
   'or media site that outranks us is a search competitor without being a '
   'commercial one.',
   array['seo','competitor','competitors','rival','domain']),
  ('seo_serp_runs', 'r', '[]'::jsonb,
   'One SERP observation RUN ROW: provider (dataforseo or manual), observed_on, '
   'location_name, language_code, device (desktop/mobile), search_engine and '
   'depth, with cost and counts. completed_at NULL means the run never '
   'finished -- read completed runs only. A provider run and a manual run on '
   'the same date are different runs and are never pooled.',
   array['seo','serp','run','observation','dataforseo','manual pilot']),
  ('seo_serp_run_keywords', 'r', '[]'::jsonb,
   'Which keywords each SERP run ASKED ABOUT, with the number of results it '
   'got back (result_count 0 = asked, nothing within depth) and the provider '
   'request id. This is what separates "observed, not in the top results" from '
   '"never observed": a keyword with no row here for a run was not looked at '
   'in that run.',
   array['seo','serp','run','keyword','requested','asked']),
  ('seo_serp_observations', 'r', '[]'::jsonb,
   'Dated SERP observations: one row per keyword x observed_on x location_name '
   'x device x provider x result position, recording the domain, URL and title '
   'at that position that day. APPEND-ONLY, written by the provider sync or a '
   'person''s manual check (provider column says which). A keyword with no row '
   'was NEVER OBSERVED -- it is not unranked and nobody is "not ranking" for '
   'it; and our own domain absent from a keyword''s rows means we were outside '
   'the observed depth on that date, never that we have no page. NEVER pool '
   'desktop and mobile, two locations, or provider and manual rows into one '
   'position; never average a position across keywords. This is a measured '
   'position; search_console_query_daily.position is an impression-weighted '
   'AVERAGE -- different measures, name which one. Prefer '
   'seo_serp_observations_v (adds keyword text, is_own_domain, relationship).',
   array['seo','serp','ranking','rank','position','competitor','who ranks','observation','dataforseo']),
  ('seo_serp_observations_v', 'v', '[]'::jsonb,
   'seo_serp_observations with the keyword text, is_own_domain (the company''s '
   'verified storefront hosts, www. and bare matched) and the curated '
   'relationship where the domain is in seo_competitor_domains. Same rules as '
   'the table: a row is one dated observation, absence is NEVER OBSERVED.',
   array['seo','serp','ranking','position','competitor','own domain']),
  ('seo_keyword_landscape_v', 'v', '[]'::jsonb,
   'THE table for "where do we and competitors stand for keyword X": every '
   'keyword in the set, per provider x device x location, with the latest '
   'observed top results (latest_top_results, ordered by position, each '
   'flagged is_own_domain / relationship), our_serp_position in that run, the '
   'previous run''s position and our_serp_movement (previous minus current: '
   'positive = moved up). Beside it, two different measures on one row: '
   'search_console_avg_position_28d / _clicks_28d / _impressions_28d are '
   'Google''s impression-weighted AVERAGE over the last 28 ingested days, not '
   'an observed rank -- never present one as the other. results_in_latest_run '
   '0 = asked, nothing returned; NULL = never observed. our_serp_position NULL '
   '= our storefront was not in the observed results. Filter on provider and '
   'device before reading a position.',
   array['seo','keyword','landscape','ranking','rank','position','competitor','movement','serp','who ranks']),
  ('seo_competitor_share_v', 'v', '[]'::jsonb,
   'Search competitors DERIVED from the latest completed run per provider x '
   'device x location: per domain, keywords_in_top_10, keywords_in_top_3, '
   'best_position, avg_position, whether it is our own storefront, and the '
   'curated relationship if any. keywords_observed is the number of keywords '
   'that run ASKED ABOUT and is the ONLY valid denominator -- never the size '
   'of the keyword set. No percentage is stored: divide and say "of the N '
   'keywords observed on <date>".',
   array['seo','competitor','competitors','share','share of voice','top 10','who ranks','serp'])
on conflict (relname) do update
  set description = case
        when coalesce(public.silo_chat_schema_catalog.description, '') like '%keyword_norm%'
          or coalesce(public.silo_chat_schema_catalog.description, '') like '%DERIVED from observations%'
          or coalesce(public.silo_chat_schema_catalog.description, '') like '%RUN ROW%'
          or coalesce(public.silo_chat_schema_catalog.description, '') like '%ASKED ABOUT%'
          or coalesce(public.silo_chat_schema_catalog.description, '') like '%NEVER OBSERVED%'
          or coalesce(public.silo_chat_schema_catalog.description, '') like '%two different measures%'
          or coalesce(public.silo_chat_schema_catalog.description, '') like '%keywords_observed%'
        then public.silo_chat_schema_catalog.description
        else coalesce(public.silo_chat_schema_catalog.description, '') || excluded.description
      end,
      keywords = coalesce(public.silo_chat_schema_catalog.keywords, excluded.keywords),
      updated_at = now();

select public.refresh_chat_schema_catalog();
