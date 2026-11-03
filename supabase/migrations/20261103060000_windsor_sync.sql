-- Windsor sync: store what each company's Windsor accounts report, so SILO's
-- reports, Ask SILO and the MCP can read it. Builds on 20261102220000 (the
-- tenant broker that maps every Windsor account to ONE company).
--
-- Written only by scripts/windsor-sync.mjs (GitHub Actions, service role).
-- That script reads windsor_linked_accounts and, for each row, reads Windsor
-- for THAT account only (select_accounts) and keeps only rows whose account_id
-- is that account's; company_entity_id is copied from the mapping row, never
-- from Windsor's payload.
--
--   TikTok Ads -> public.marketing_kpis_daily (platform 'tiktok_ads',
--                 source 'windsor', connection_id NULL). Existing table, no
--                 schema change: every report reading it picks TikTok up.
--   Klaviyo    -> public.klaviyo_performance_daily (new), one row per
--                 company x account x report x object x day:
--                   report 'account'  the account's daily totals
--                   report 'campaign' one campaign's numbers that day
--                   report 'flow'     one flow message's numbers that day
--
-- windsor_linked_accounts gains sync bookkeeping (how far history has been
-- pulled, last outcome) so a run resumes where the last one stopped.
--
-- Applying this turns nothing on: the workflow needs the WINDSOR_API_KEY repo
-- secret and runs only on its schedule or by hand.

-- ── Sync bookkeeping on the mapping table ───────────────────────────────────
alter table public.windsor_linked_accounts
  add column if not exists history_from date,
  add column if not exists synced_through date,
  add column if not exists last_synced_at timestamptz,
  add column if not exists last_sync_status text,
  add column if not exists last_sync_error text;

alter table public.windsor_linked_accounts
  drop constraint if exists windsor_linked_accounts_sync_status_check;
alter table public.windsor_linked_accounts
  add constraint windsor_linked_accounts_sync_status_check
  check (last_sync_status is null or last_sync_status in ('success', 'partial', 'error', 'unsupported'));

-- ── Klaviyo ─────────────────────────────────────────────────────────────────
create table if not exists public.klaviyo_performance_daily (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  account_id text not null,
  account_name text,
  report text not null,
  day_date date not null,
  object_id text not null default '',
  object_name text,
  parent_id text,
  parent_name text,
  channel text,
  -- Counts and money as Klaviyo reports them through Windsor. NULL = not
  -- reported for this report type, never zero.
  recipients bigint,
  delivered bigint,
  opens bigint,
  opens_unique bigint,
  clicks bigint,
  clicks_unique bigint,
  conversions numeric,
  revenue numeric,
  unsubscribes bigint,
  bounced bigint,
  spam_complaints bigint,
  -- Every other numeric field Windsor returned for the row, by field id.
  metrics jsonb not null default '{}'::jsonb,
  -- Descriptive fields (subject, status, sent_at, trigger type ...).
  attributes jsonb not null default '{}'::jsonb,
  source text not null default 'windsor',
  row_hash text not null,
  synced_at timestamptz not null default now(),
  sync_batch_id text,
  constraint klaviyo_performance_daily_row_hash_key unique (row_hash),
  constraint klaviyo_performance_daily_report_check check (report in ('account', 'campaign', 'flow'))
);

create index if not exists idx_klaviyo_performance_daily_company_day
  on public.klaviyo_performance_daily (company_entity_id, day_date);
create index if not exists idx_klaviyo_performance_daily_company_report
  on public.klaviyo_performance_daily (company_entity_id, report, object_id);

alter table public.klaviyo_performance_daily enable row level security;

revoke all on public.klaviyo_performance_daily from anon, authenticated;
grant select on public.klaviyo_performance_daily to authenticated;
grant all on public.klaviyo_performance_daily to service_role;

-- Same shape as marketing_kpis_daily_active_select.
drop policy if exists klaviyo_performance_daily_active_select on public.klaviyo_performance_daily;
create policy klaviyo_performance_daily_active_select on public.klaviyo_performance_daily
  for select to authenticated
  using (company_entity_id = (select public.active_company_id()));

-- ── sync_jobs.job_type: append 'windsor_sync' to the LIVE list ──────────────
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
    raise exception 'sync_jobs_job_type_check not found; read the live job_type constraint before adding windsor_sync';
  end if;

  if cur like '%windsor_sync%' then
    return;
  end if;

  members := substring(cur from 'ARRAY\[(.*?)\]');
  if members is null or members = '' then
    raise exception 'sync_jobs_job_type_check has an unexpected shape (%); extend it by hand after reading it', cur;
  end if;

  execute 'alter table public.sync_jobs drop constraint sync_jobs_job_type_check';
  execute format(
    'alter table public.sync_jobs add constraint sync_jobs_job_type_check check (job_type = any (array[%s, %L::text]))',
    members, 'windsor_sync'
  );
end $$;

-- ── The insert-stamp backstop ───────────────────────────────────────────────
select public.attach_stamp_company_entity_id_triggers();

-- ── Ask SILO catalog ────────────────────────────────────────────────────────
insert into public.silo_chat_schema_catalog (relname, relkind, columns, description, keywords)
values
  ('klaviyo_performance_daily', 'r', '[]'::jsonb,
   'Klaviyo email and SMS performance, pulled nightly through Windsor.ai. One row '
   'per account x report x object x day. report = ''account'' (the account''s '
   'daily totals: object_id is empty), ''campaign'' (object = campaign) or '
   '''flow'' (object = flow message, parent = flow). NEVER add the three reports '
   'together: campaign and flow rows are parts of the account total. revenue is '
   'what Klaviyo ATTRIBUTES to email/SMS: it overlaps net sales and ad-platform '
   'revenue, so never add it to either. NULL means not reported, not zero. '
   'metrics and attributes hold every other field Windsor returned, by field id.',
   array['klaviyo','email','sms','campaign','flow','opens','clicks','email revenue','windsor'])
on conflict (relname) do nothing;
