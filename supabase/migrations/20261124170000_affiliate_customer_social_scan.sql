-- "Find their social accounts" on Affiliate Studio's Your Customers tab.
--
-- Blake, 2026-11-24: "how do we now scan their social pull and presence scan
-- without doing too many" -- then, on the decision card, "Build it, pilot 500".
-- The plan is /mnt/project-files/affiliates/customer-seeded-discovery-plan-2026-11-24.md.
--
-- The job is the affiliate-research edge function's `customer_scan` action
-- (lib/affiliate-customer-scan-core.mjs): one search per customer, through the
-- provider Discovery already pays for, and a model only where the search
-- showed two or more profiles carrying the name. This migration is where its
-- work lives:
--
-- 1. affiliate_customer_scans -- one row per press. It is the progress the
--    page shows ("Scanning... 240 of 500 checked, 6 found"), and the one-at-
--    a-time guard: a partial unique index allows ONE running scan per program,
--    so two presses at the same instant join one scan rather than paying
--    twice. Spend (cost_usd) is recorded for SILO and NOT readable by the
--    page: Blake, 2026-11-24, no cost, spend or budget anywhere in the UI.
--
-- 2. affiliate_customer_social -- one row per customer PER PROGRAM: the
--    queue, then the answer. A press writes its customers as 'pending' BEFORE
--    any search runs, so a run that hits its time limit leaves a queue the
--    next press finishes rather than losing its place, and a customer already
--    scanned for this program is never searched (or paid for) twice -- the
--    unique key is what makes that true rather than hoped for.
--
-- 3. affiliate_programs.customer_scan_min_followers -- the follower bar, per
--    program, 750 by default. Company DATA, never a constant in code.
--
-- Both tables are written ONLY by the service role (the edge function, after
-- its caller-token gate). Browsers read them under RLS, scoped exactly like
-- affiliate_prospects: the active company, and a program the caller may see.
-- No browser can insert, update or delete a row, so nobody can mark a
-- customer "found" by hand or wipe the record of who was searched.
--
-- What is NOT here, deliberately: no follower count from anywhere but a
-- search result's own text (the code re-reads it), no profile page fetched,
-- no customer who unsubscribed from marketing (they are never queued -- the
-- function's filter, and `status` has no value for them), and no write into
-- affiliate_prospects. A customer becomes a prospect only when a person
-- ticks them and presses Add to outreach, which is the path #1362 built.

-- 1 ── The bar, per program.
alter table public.affiliate_programs
  add column if not exists customer_scan_min_followers integer not null default 750;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'affiliate_programs_customer_scan_min_followers_check') then
    alter table public.affiliate_programs add constraint affiliate_programs_customer_scan_min_followers_check
      check (customer_scan_min_followers between 0 and 100000000);
  end if;
end $$;
comment on column public.affiliate_programs.customer_scan_min_followers is
  'Your Customers "Find their social accounts": a customer whose own profile states at least this many followers is "found". Per program; 750 unless a brand sets otherwise.';

-- 2 ── One row per press.
create table if not exists public.affiliate_customer_scans (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  program_id uuid not null references public.affiliate_programs(id) on delete cascade,
  created_by uuid,
  status text not null default 'running' check (status in ('running', 'done', 'stopped', 'error')),
  requested integer not null default 0 check (requested >= 0),
  checked integer not null default 0 check (checked >= 0),
  found integer not null default 0 check (found >= 0),
  below integer not null default 0 check (below >= 0),
  no_count integer not null default 0 check (no_count >= 0),
  ambiguous integer not null default 0 check (ambiguous >= 0),
  not_found integer not null default 0 check (not_found >= 0),
  failed integer not null default 0 check (failed >= 0),
  min_followers integer,
  filters jsonb not null default '{}'::jsonb,
  -- What a run that stopped or failed says about it. Never a stack trace.
  -- (`failed` above counts customers whose own search failed.)
  error_message text,
  cost_usd numeric(12, 4),
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists affiliate_customer_scans_program_idx
  on public.affiliate_customer_scans (company_entity_id, program_id, started_at desc);
create unique index if not exists affiliate_customer_scans_one_running
  on public.affiliate_customer_scans (company_entity_id, program_id) where status = 'running';

-- 3 ── One row per customer per program.
create table if not exists public.affiliate_customer_social (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  program_id uuid not null references public.affiliate_programs(id) on delete cascade,
  scan_id uuid references public.affiliate_customer_scans(id) on delete set null,
  customer_key text not null,
  email_lc text,
  display_name text,
  city text,
  status text not null default 'pending'
    check (status in ('pending', 'found', 'below', 'no_count', 'ambiguous', 'none', 'error')),
  decided_by text check (decided_by in ('search', 'ai')),
  query text,
  platform text,
  handle text,
  profile_url text,
  -- NULL means no result stated a count, never zero followers.
  followers integer check (followers is null or followers >= 0),
  followers_approx boolean,
  -- The words the count was read from, exactly as the result printed them.
  followers_quote text,
  source_url text,
  -- The profiles a search showed when more than one carried the name.
  candidates jsonb,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (company_entity_id, program_id, customer_key),
  -- A found or below-the-bar row names the profile its count came from.
  constraint affiliate_customer_social_found_has_profile
    check (status not in ('found', 'below') or (profile_url is not null and followers is not null and followers_quote is not null))
);
create index if not exists affiliate_customer_social_queue_idx
  on public.affiliate_customer_social (company_entity_id, program_id, status, created_at);
create index if not exists affiliate_customer_social_scan_idx
  on public.affiliate_customer_social (scan_id, status);
create index if not exists affiliate_customer_social_found_idx
  on public.affiliate_customer_social (company_entity_id, program_id, followers desc nulls last)
  where status in ('found', 'below', 'no_count');

-- 4 ── Read under RLS, written only by the service role.
alter table public.affiliate_customer_scans enable row level security;
alter table public.affiliate_customer_social enable row level security;

drop policy if exists affiliate_customer_scans_select on public.affiliate_customer_scans;
create policy affiliate_customer_scans_select on public.affiliate_customer_scans
  for select to authenticated
  using (company_entity_id = public.active_company_id() and public.affiliate_visible_program(program_id));

drop policy if exists affiliate_customer_social_select on public.affiliate_customer_social;
create policy affiliate_customer_social_select on public.affiliate_customer_social
  for select to authenticated
  using (company_entity_id = public.active_company_id() and public.affiliate_visible_program(program_id));

revoke all on public.affiliate_customer_scans from anon, authenticated;
revoke all on public.affiliate_customer_social from anon, authenticated;
-- The page reads progress, never spend: every column but cost_usd.
grant select (id, company_entity_id, program_id, created_by, status, requested, checked, found, below, no_count,
  ambiguous, not_found, failed, min_followers, filters, error_message, started_at, heartbeat_at, finished_at, created_at)
  on public.affiliate_customer_scans to authenticated;
grant select on public.affiliate_customer_social to authenticated;
grant all on public.affiliate_customer_scans to service_role;
grant all on public.affiliate_customer_social to service_role;

comment on table public.affiliate_customer_scans is
  'Your Customers "Find their social accounts": one row per press -- its progress, and the one-running-scan-per-program guard. Written only by the affiliate-research function. cost_usd is not readable by browsers.';
comment on table public.affiliate_customer_social is
  'Your Customers "Find their social accounts": one row per customer per program -- the queue, then what one search (and, for ambiguous searches only, a model) found. Followers only as a result''s own text stated them; NULL is not zero. Written only by the affiliate-research function.';

select public.attach_stamp_company_entity_id_triggers();
select public.refresh_chat_schema_catalog();
