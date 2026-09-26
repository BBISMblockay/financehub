-- ─────────────────────────────────────────────────────────────────────────────
-- SEO competitor research, step 4b: the provider sync's two tables.
-- Provider: DataForSEO (chosen 2026-09-26). MEASURED that day by
-- .github/workflows/seo-serp-probe.yml (runs 36221338860, 36222764424):
--
--   * the live endpoint takes ONE task per request (40000 "You can set only
--     one task at a time"); the standard queue (task_post) takes a batch and
--     returned 4 tasks in 106-139 s. Live cost $0.002 (depth 10) / $0.004
--     (depth 20); queue $0.0012 per task at depth 20.
--   * depth is ABSOLUTE positions: depth 10 yielded 7-8 organic ranks once the
--     AI overview, People Also Ask, images and knowledge panel were counted;
--     depth 20 yielded 16-19. The default here is therefore 20.
--   * desktop and mobile differ materially (1/9 domains shared on the brand
--     term), and two fetches of the same identity minutes apart differed on
--     whether the brand's own site was in the top 20 at all. A stored
--     position is ONE snapshot; the schema already says so.
--
-- Two tables:
--
--   seo_serp_schedules       ONE row per company: is the weekly fetch on, for
--                            which devices, location, language, depth, and how
--                            many keywords at most. Cost is bounded BY
--                            CONSTRUCTION (keywords x devices x one task), not
--                            by a script remembering to be careful. OFF by
--                            default: it spends SILO's key on a tenant's behalf
--                            (card_sources.auto_prepare_coding's stance).
--   seo_serp_provider_tasks  The LEDGER of what was handed to the provider:
--                            one row per (run, keyword) with the provider's
--                            task id, written the moment the post is accepted
--                            and BEFORE any collection. It exists because a
--                            queued task is paid for when posted and answered
--                            later: a collection that times out (a GitHub job
--                            has a clock) or a crashed run must RESUME from the
--                            ledger, never re-post -- re-posting is paying
--                            twice, and it would also be a second observation
--                            of the same identity. A `failed` row records that
--                            we asked and the provider could not answer; no
--                            seo_serp_run_keywords row is written for it, so
--                            the keyword reads as NEVER OBSERVED in that run,
--                            which is the truth -- result_count 0 would claim a
--                            measurement that did not happen.
--
-- Writers: the sync (service role) only. Readers: any member of the company,
-- so the page can say "posted, waiting" rather than nothing.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── seo_serp_schedules ──────────────────────────────────────────────────────
create table if not exists public.seo_serp_schedules (
  id                    uuid primary key default gen_random_uuid(),
  company_entity_id     uuid not null references public.entities(id) on delete cascade,
  is_active             boolean not null default false,
  provider              text not null default 'dataforseo' check (provider = 'dataforseo'),
  location_code         integer not null default 2840 check (location_code > 0),
  location_name         text not null default 'United States',
  language_code         text not null default 'en',
  search_engine         text not null default 'google',
  devices               text[] not null default array['desktop', 'mobile'],
  depth                 integer not null default 20 check (depth between 10 and 100),
  -- The cost bound. Keywords beyond it (by priority, then age) are not asked
  -- about that week and read as never observed, never as unranked.
  max_keywords_per_run  integer not null default 300 check (max_keywords_per_run between 1 and 1000),
  -- A second bound on the provider's own reported cost: posting stops once
  -- the run's accepted tasks exceed it. Measured $0.0012 per task at depth 20.
  max_cost_per_run_usd  numeric(8, 4) not null default 2.0000 check (max_cost_per_run_usd > 0),
  -- DataForSEO priority: 1 normal, 2 high (about double the price).
  priority              integer not null default 1 check (priority in (1, 2)),
  last_run_on           date,
  note                  text,
  created_by            uuid references auth.users(id) on delete set null default auth.uid(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint seo_serp_schedules_one_per_company unique (company_entity_id),
  constraint seo_serp_schedules_location_not_blank check (btrim(location_name) <> ''),
  -- One or two DISTINCT devices from the two the schema knows. Written as a
  -- plain expression (a CHECK may not contain a subquery): with only two
  -- allowed values, "distinct" is "not the same value twice".
  constraint seo_serp_schedules_devices_valid check (
    cardinality(devices) between 1 and 2
    and devices <@ array['desktop', 'mobile']
    and (cardinality(devices) = 1 or devices[1] <> devices[2])
  )
);

alter table public.seo_serp_schedules enable row level security;

drop policy if exists seo_serp_schedules_select on public.seo_serp_schedules;
create policy seo_serp_schedules_select on public.seo_serp_schedules
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- Approver-only, like seo_competitor_domains: switching the fetch on commits
-- the company to a recurring provider spend.
drop policy if exists seo_serp_schedules_write on public.seo_serp_schedules;
create policy seo_serp_schedules_write on public.seo_serp_schedules
  for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_approve_seo_tasks())
  with check (company_entity_id = public.active_company_id() and public.can_approve_seo_tasks());

create or replace function public.seo_serp_schedules_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_seo_serp_schedules_touch on public.seo_serp_schedules;
create trigger trg_seo_serp_schedules_touch
  before update on public.seo_serp_schedules
  for each row execute function public.seo_serp_schedules_touch();

comment on table public.seo_serp_schedules is
  'One row per company: whether the weekly DataForSEO SERP fetch runs and its '
  'bounds (devices, location, language, depth, max keywords, max cost). OFF by '
  'default. Approver-only writes. Read by scripts/lib/seo-serp-sync-core.mjs.';

-- ── seo_serp_provider_tasks ─────────────────────────────────────────────────
create table if not exists public.seo_serp_provider_tasks (
  id                 uuid primary key default gen_random_uuid(),
  company_entity_id  uuid not null references public.entities(id) on delete cascade,
  run_id             uuid not null,
  keyword_id         uuid not null,
  provider           text not null default 'dataforseo' check (provider = 'dataforseo'),
  provider_task_id   text not null,
  status             text not null default 'posted' check (status in ('posted', 'collected', 'failed')),
  status_code        integer,
  status_message     text,
  post_cost_usd      numeric(10, 4),
  posted_at          timestamptz not null default now(),
  collected_at       timestamptz,
  -- Which SERP element types the provider returned for this keyword (organic,
  -- popular_products, ai_overview, ...). The observation rows hold organic
  -- positions only; this says what ELSE was on the page.
  item_types         text[],
  attempts           integer not null default 1 check (attempts >= 1),
  synced_at          timestamptz not null default now(),
  sync_batch_id      text,
  constraint seo_serp_provider_tasks_task_not_blank check (btrim(provider_task_id) <> ''),
  constraint seo_serp_provider_tasks_collected_consistent check (
    (status = 'collected') = (collected_at is not null)
  ),
  unique (run_id, keyword_id),
  unique (provider, provider_task_id),
  constraint seo_serp_provider_tasks_run_company_fkey
    foreign key (run_id, company_entity_id) references public.seo_serp_runs(id, company_entity_id) on delete cascade,
  constraint seo_serp_provider_tasks_keyword_company_fkey
    foreign key (keyword_id, company_entity_id) references public.seo_keyword_set(id, company_entity_id) on delete cascade
);

create index if not exists seo_serp_provider_tasks_pending
  on public.seo_serp_provider_tasks (run_id) where status = 'posted';

alter table public.seo_serp_provider_tasks enable row level security;

drop policy if exists seo_serp_provider_tasks_select on public.seo_serp_provider_tasks;
create policy seo_serp_provider_tasks_select on public.seo_serp_provider_tasks
  for select to authenticated
  using (company_entity_id = public.active_company_id());
-- No client write policy: the sync is the only writer.

comment on table public.seo_serp_provider_tasks is
  'Ledger of SERP tasks handed to DataForSEO: one row per (run, keyword), '
  'written when the post is accepted and before collection, so a timed-out or '
  'crashed collection resumes from here instead of re-posting (paying twice). '
  'failed = asked, provider could not answer: no seo_serp_run_keywords row is '
  'written, so the keyword reads as never observed in that run. Service-role '
  'writes only.';

-- ── The insert-stamp backstop ───────────────────────────────────────────────
select public.attach_stamp_company_entity_id_triggers();

-- ── Ask SILO catalog ────────────────────────────────────────────────────────
insert into public.silo_chat_schema_catalog (relname, relkind, columns, description, keywords, is_hidden)
values
  ('seo_serp_schedules', 'r', '[]'::jsonb,
   'Per-company configuration of the WEEKLY DataForSEO SERP fetch: is_active '
   '(off by default), devices, location, language, depth (20: absolute '
   'positions, so ~16-19 organic ranks), max_keywords_per_run and '
   'max_cost_per_run_usd. Configuration only -- it holds no ranking. '
   'last_run_on is the last date a run was started for the company.',
   array['seo','serp','schedule','weekly','dataforseo','fetch','configuration'],
   false),
  ('seo_serp_provider_tasks', 'r', '[]'::jsonb,
   'Operational ledger of tasks posted to DataForSEO per run and keyword: '
   'posted / collected / failed with the provider''s task id and cost. A '
   'failed row means the provider could not answer for that keyword in that '
   'run, so the keyword has no observation there (never observed, not '
   'unranked). Not a ranking source -- read seo_serp_observations_v.',
   array['seo','serp','provider','task','ledger','dataforseo'],
   true)
on conflict (relname) do update
  set description = case
        when coalesce(public.silo_chat_schema_catalog.description, '') like '%WEEKLY DataForSEO SERP fetch%'
          or coalesce(public.silo_chat_schema_catalog.description, '') like '%Operational ledger of tasks%'
        then public.silo_chat_schema_catalog.description
        else coalesce(public.silo_chat_schema_catalog.description, '') || excluded.description
      end,
      keywords = coalesce(public.silo_chat_schema_catalog.keywords, excluded.keywords),
      is_hidden = excluded.is_hidden,
      updated_at = now();

select public.refresh_chat_schema_catalog();
