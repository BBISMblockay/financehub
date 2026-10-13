-- 20261013060000_integration_bootstrap_jobs.sql
--
-- First-connect auto sync: the durable half.
--
-- WHAT WAS WRONG. Connecting an integration left its data to a button or to a
-- nightly. Shopify's own history import is browser-driven in 7-day chunks and
-- the Integrations page literally says "Keep this tab open" -- so the moment
-- somebody connects a store and clicks away to look around, the import stops
-- where it was. Measured on production 2026-10-12: hhoutfitter.myshopify.com
-- was connected and had 2,996 sales rows but zero inventory rows, and
-- i09sb0-6m had 52 "successful" snapshots and no inventory at all. The ad
-- platforms fare no better (one short KPI window on connect, the rest
-- nightly), and Search Console and Redo get nothing until a nightly runs.
--
-- WHAT THIS IS. One queue row per integration a company has just connected,
-- claimed under a lease by scripts/integration-bootstrap.mjs (the
-- "Integration bootstrap" workflow), which runs the SAME sync cores the
-- nightlies use. The row carries per-stage progress, so a drainer that dies
-- mid-run resumes at the next stage instead of re-importing what already
-- landed, and the Integrations page can show "setting up, 4 of 9" rather than
-- asking anyone to wait with a tab open.
--
-- WHY A LEASE AND NOT A STATUS FLAG. Two drainers overlap whenever a run goes
-- long (the schedule is short on purpose) and GitHub also fires schedules
-- late and in bursts. `status = 'running'` alone cannot tell a live run from
-- one whose runner was killed: the first is a reason to leave the row alone,
-- the second a reason to pick it up. A lease distinguishes them by expiry,
-- and claim_integration_bootstrap_jobs() takes it inside one UPDATE ...
-- RETURNING, so two simultaneous claims cannot both get the same row.
-- `skip locked` is deliberately NOT used: a row whose lease has expired must
-- be claimable by the next drainer, and a locked row is one another
-- transaction is mid-claim on, which the lease predicate already excludes.
--
-- WHY attempts IS CAPPED IN THE ROW. A credential that will never work (an
-- account picked in the wrong workspace, a revoked token) would otherwise be
-- retried every few minutes for ever, and each attempt is a paid API call on
-- some of these platforms. The drainer stops at BOOTSTRAP_MAX_ATTEMPTS and
-- the row keeps its last error, which is also what the page shows.
--
-- IDEMPOTENCY. `if not exists` / `create or replace` throughout, so a re-run
-- of apply_all_post_merge.sql is a no-op. The partial unique index is what
-- keeps a double-click, a reconnect, or an enqueue retried after a network
-- blip from queueing the same work twice.

-- ── 1. The queue ───────────────────────────────────────────────────────────
create table if not exists public.integration_bootstrap_jobs (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  -- Which integration, in the vocabulary the sync scripts already use. A new
  -- integration extends this CHECK and the drainer's stage table together;
  -- an unknown value must fail loudly at enqueue rather than sit in the queue
  -- as a row no drainer claims.
  integration text not null check (integration in (
    'shopify', 'google_ads', 'ga4', 'meta_ads', 'tiktok_ads',
    'search_console', 'redo'
  )),
  -- The row in that integration's OWN connection table
  -- (shopify_connections, ad_platform_connections, redo_connections). No
  -- foreign key: the target table differs per integration, and a dangling id
  -- is handled by the drainer (the connection is gone -> the job is
  -- cancelled), not by refusing the insert.
  connection_id uuid,
  status text not null default 'pending' check (status in (
    'pending', 'running', 'done', 'partial', 'error', 'cancelled'
  )),
  -- stage name -> { status, at, detail }. 'partial' is a real outcome and is
  -- distinct from 'error': some stages landed, which is why the drainer must
  -- not start again from the first one.
  stages jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  lease_until timestamptz,
  last_error text,
  requested_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

-- One OPEN job per connection. A finished job stays as the record of what was
-- imported, so this index deliberately covers only the open states.
create unique index if not exists integration_bootstrap_jobs_open_uniq
  on public.integration_bootstrap_jobs (
    company_entity_id,
    integration,
    coalesce(connection_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where status in ('pending', 'running');

-- The drainer's own read: the oldest claimable row.
create index if not exists integration_bootstrap_jobs_claimable_idx
  on public.integration_bootstrap_jobs (status, lease_until, created_at)
  where status in ('pending', 'running');

create index if not exists integration_bootstrap_jobs_company_idx
  on public.integration_bootstrap_jobs (company_entity_id, created_at desc);

-- ── 2. RLS ─────────────────────────────────────────────────────────────────
-- Enqueueing is an admin act on the admin's OWN company: it reads nothing it
-- could not already read and spends only that company's own API quota, so
-- is_admin_user() is the right gate here rather than one of the narrower
-- money/people gates. It is NOT a write to anybody's books.
alter table public.integration_bootstrap_jobs enable row level security;

drop policy if exists integration_bootstrap_jobs_select on public.integration_bootstrap_jobs;
create policy integration_bootstrap_jobs_select
  on public.integration_bootstrap_jobs
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists integration_bootstrap_jobs_insert on public.integration_bootstrap_jobs;
create policy integration_bootstrap_jobs_insert
  on public.integration_bootstrap_jobs
  for insert to authenticated
  with check (
    company_entity_id = public.active_company_id()
    and public.is_admin_user()
  );

-- An admin may cancel their own company's queued job (the page's "Stop"), and
-- nothing else: status and lease belong to the drainer. A client UPDATE that
-- RLS refuses succeeds with zero rows rather than erroring, so the page must
-- re-read, which renderBootstrap() does.
drop policy if exists integration_bootstrap_jobs_cancel on public.integration_bootstrap_jobs;
create policy integration_bootstrap_jobs_cancel
  on public.integration_bootstrap_jobs
  for update to authenticated
  using (
    company_entity_id = public.active_company_id()
    and public.is_admin_user()
    and status in ('pending', 'running')
  )
  with check (
    company_entity_id = public.active_company_id()
    and status = 'cancelled'
  );

-- ── 3. The claim ───────────────────────────────────────────────────────────
-- SECURITY DEFINER because the drainer runs as service_role, which already
-- bypasses RLS -- the definer-ness is for the lease arithmetic being one
-- statement, not for privilege. Explicitly revoked from anon and
-- authenticated: a browser that could claim a job would take work the drainer
-- then never does. Supabase re-grants EXECUTE on every new public function to
-- both roles, so the revokes below are required, and `create or replace`
-- keeps existing grants.
create or replace function public.claim_integration_bootstrap_jobs(
  p_limit integer default 5,
  p_lease_seconds integer default 900,
  p_max_attempts integer default 5
)
returns setof public.integration_bootstrap_jobs
language sql
security definer
set search_path to 'public'
as $function$
  update public.integration_bootstrap_jobs j
     set status = 'running',
         attempts = j.attempts + 1,
         lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 60)),
         started_at = coalesce(j.started_at, now()),
         updated_at = now()
   where j.id in (
     select c.id
       from public.integration_bootstrap_jobs c
      where c.status in ('pending', 'running')
        -- A live lease means another drainer has it. An expired one means its
        -- runner is gone, and the row is work again.
        and (c.lease_until is null or c.lease_until < now())
        and c.attempts < greatest(p_max_attempts, 1)
      order by c.created_at
      limit greatest(p_limit, 1)
   )
  returning j.*;
$function$;

revoke all on function public.claim_integration_bootstrap_jobs(integer, integer, integer) from anon;
revoke all on function public.claim_integration_bootstrap_jobs(integer, integer, integer) from authenticated;
revoke all on function public.claim_integration_bootstrap_jobs(integer, integer, integer) from public;
grant execute on function public.claim_integration_bootstrap_jobs(integer, integer, integer) to service_role;

-- ── 4. The company stamp backstop ──────────────────────────────────────────
-- Not automatic. The insert policy already requires the active company, but
-- the trigger is what makes a service-role or script insert carry the right
-- tenant, and check 6 of verify_v2_schema.sql fails without it.
select public.attach_stamp_company_entity_id_triggers();

-- ── 5. Ask SILO's schema map ───────────────────────────────────────────────
select public.refresh_chat_schema_catalog();
