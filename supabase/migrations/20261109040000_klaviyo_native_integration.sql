-- 20261109040000_klaviyo_native_integration.sql
-- ---------------------------------------------------------------------------
-- Klaviyo as a native SILO integration pillar: a direct connection to
-- Klaviyo's own API, alongside Shopify, the ad platforms and Redo, instead of
-- only through Windsor.ai.
--
-- Written to Klaviyo's published API contract as read on 2026-11-09
-- (developers.klaviyo.com). Plan:
-- /mnt/project-files/specs/klaviyo-native-integration-2026-11-09.md
--
-- Applying this turns NOTHING on. Every table is empty, the sync reads only
-- rows where klaviyo_connections.sync_enabled is explicitly true, and no such
-- row can exist until an admin connects an account in Integrations.
--
-- ── What Klaviyo gives, and what that forces on this schema ────────────────
--
--  * EVERY request carries a `revision` date header and an
--    `Authorization: Klaviyo-API-Key pk_...` (private key) or
--    `Authorization: Bearer ...` (OAuth) header. Both auth modes live on the
--    same connection row, so adding OAuth later needs no migration.
--
--  * THERE IS NO CAMPAIGN SERIES ENDPOINT. `POST /api/campaign-values-reports/`
--    returns WINDOW TOTALS per campaign message; only flows, forms and
--    segments have an `interval: daily` series. So campaign performance is
--    stored at one row per (message, channel, TIMEFRAME) carrying the window's
--    own bounds -- NOT per day. A campaign has a single send time, so a daily
--    rollup can still attribute it to `klaviyo_messages.send_time`, but the
--    stored grain must not pretend to be daily. Flows get a true daily table.
--
--  * NO RATE IS STORED, for the same reason as Redo (20260924120000): every
--    Klaviyo rate is a count over another count, Klaviyo returns them as
--    fractions in [0.0, 1.0], and a per-day rate is malformed because clicks
--    and conversions land on days after the send. Store counts, pool over the
--    window, then divide.
--
--  * `conversion_metric_id` IS REQUIRED on every values and series report and
--    is chosen per account (normally "Placed Order"). It is therefore stamped
--    on every stored performance row: two rows measured against different
--    conversion metrics are not the same number and must never be summed.
--    Only `conversions`, `conversion_uniques`, `conversion_value`,
--    `average_order_value` and `revenue_per_recipient` depend on it; opens,
--    clicks and deliveries do not.
--
--  * conversion_value is ATTRIBUTED revenue, never incremental. It overlaps
--    net sales and what Meta/Google/TikTok claim, and must never be added to
--    either. text_message_spend is Klaviyo's SMS sending cost, not ad spend,
--    and does not belong in marketing_kpis_daily.
--
--  * NULL MEANS NOT REPORTED, NEVER ZERO. Klaviyo returns null for SMS
--    statistics before 2025-10-01 and on contracted plans, and omits
--    statistics a caller did not ask for.
--
--  * Reporting timeframes are capped at ONE YEAR per request, a custom range's
--    UTC offset is ignored in favour of the ACCOUNT's timezone, and the `end`
--    rounds up to the current hour -- so a whole final day needs 23:59:59.
--    `timeframe_start` / `timeframe_end` record what was actually asked for.
--
--  * How far Klaviyo restates conversions is UNDOCUMENTED. The sync re-pulls a
--    trailing window (60 days, Redo's measured answer) and overwrites, and the
--    real figure is an empirical question for the first weeks of runs.
--
-- ── Not double counting Windsor ────────────────────────────────────────────
--
-- public.klaviyo_performance_daily already holds Klaviyo rows pulled through
-- Windsor (20261103060000, source = 'windsor'). It is untouched here and the
-- native sync NEVER writes to it: the grains differ (Windsor's campaign rows
-- are daily, Klaviyo's own are not), so a union would both double count and
-- mix two meanings. scripts/lib/windsor-sync-core.mjs instead skips Klaviyo
-- for a company that has an active native connection, recording
-- `superseded_by_native` -- the same precedence Windsor already applies to
-- Google, Meta and GA4, and it keeps the Windsor path generic for any source.
-- ---------------------------------------------------------------------------

-- ── klaviyo_connections: one row per company ────────────────────────────────
-- One row per company, like redo_connections: a Klaviyo private key is issued
-- per account, and a company running two Klaviyo accounts is not a shape
-- anybody has asked for. A unique constraint says so rather than leaving two
-- rows to fight over the same tables.
create table if not exists public.klaviyo_connections (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  display_name text,

  -- Auth, mode 1: a private API key the admin pastes (prefix `pk_`). Klaviyo
  -- cannot edit a key's scopes after creation, so a key missing a scope is a
  -- CONFIGURATION state (403 on that endpoint), not an outage -- the sync
  -- records `skipped`, as Redo's does for a missing scope.
  api_key text,

  -- Auth, mode 2: OAuth. Access tokens last about an hour (trust the
  -- `expires_in` the token endpoint returns, not a constant) and cannot be
  -- revoked; refresh tokens live until the app is uninstalled but die after 90
  -- days unused, and `400 invalid_grant` on refresh means the install is gone.
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  oauth_scope text,
  -- Set when a refresh came back invalid_grant: the connection needs
  -- reconnecting and the sync must stop asking rather than burn the 10/min
  -- refresh budget. Cleared by a successful reconnect.
  reauth_required_at timestamptz,
  auth_mode text not null default 'api_key'
    check (auth_mode in ('api_key', 'oauth')),

  -- The account this key or grant belongs to, read back from Klaviyo on test.
  klaviyo_account_id text,
  klaviyo_account_name text,
  -- Klaviyo's own timezone for the account. Custom reporting ranges are
  -- interpreted in it regardless of the offset sent, so a window computed in
  -- any other zone silently asks for different days.
  account_timezone text,

  -- The metric conversions and attributed revenue are measured against,
  -- required on every report. Resolved from /api/metrics on test (Klaviyo's
  -- "Placed Order" where it exists) and overridable by an admin.
  conversion_metric_id text,
  conversion_metric_name text,

  is_active boolean not null default true,
  -- Explicitly true before anything is fetched, like ad_platform_connections
  -- and windsor_linked_accounts: connecting an account is not consent to sync
  -- it.
  sync_enabled boolean not null default false,
  days_back integer not null default 60,

  last_tested_at timestamptz,
  last_test_success boolean,
  last_test_error text,
  last_synced_at timestamptz,

  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  constraint klaviyo_connections_company_key unique (company_entity_id)
);

-- ── klaviyo_messages: one row per campaign message or flow message ─────────
-- Both kinds share a table because both are "a message that went out on a
-- channel" and every performance row points at one of them. `kind` keeps them
-- apart; a flow message additionally carries its flow as the parent.
create table if not exists public.klaviyo_messages (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  connection_id uuid references public.klaviyo_connections(id) on delete set null,
  kind text not null check (kind in ('campaign', 'flow_message')),
  -- Klaviyo's own id for the message: a campaign-message id, or a
  -- flow-message id. The key, together with the company.
  klaviyo_id text not null,
  -- The campaign or flow the message belongs to. For a campaign these are the
  -- campaign's id and name (one campaign may hold several messages, e.g. an
  -- A/B test); for a flow message they are the flow's.
  parent_id text,
  parent_name text,
  name text,
  subject text,
  -- Klaviyo's send_channel values, lowercased. push-notification and whatsapp
  -- are accepted rather than rejected: a channel SILO has no reports for is
  -- still data Klaviyo returned, and dropping it would silently lose sends.
  channel text check (channel is null or channel in ('email', 'sms', 'push-notification', 'whatsapp')),
  status text,
  -- Campaigns only: when it sent. A campaign's performance has no daily
  -- grain, so this is what a daily rollup attributes its numbers to.
  send_time timestamptz,
  -- Flow messages only: the flow's trigger type (Added to List, Metric, ...).
  trigger_type text,
  archived boolean,
  created_at_remote timestamptz,
  updated_at_remote timestamptz,
  tags jsonb not null default '[]'::jsonb,
  -- Every other descriptive field Klaviyo returned for the message.
  attributes jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  sync_batch_id text,
  constraint klaviyo_messages_company_kind_id_key unique (company_entity_id, kind, klaviyo_id)
);

create index if not exists idx_klaviyo_messages_company_kind
  on public.klaviyo_messages (company_entity_id, kind);
create index if not exists idx_klaviyo_messages_company_send_time
  on public.klaviyo_messages (company_entity_id, send_time);
create index if not exists idx_klaviyo_messages_company_parent
  on public.klaviyo_messages (company_entity_id, parent_id);

-- ── klaviyo_message_performance: the values reports ────────────────────────
-- One row per (company, kind, message, channel, timeframe). This is the only
-- grain Klaviyo offers for campaigns, so the window's bounds are part of the
-- key: two different windows over the same campaign are two different
-- measurements, not a conflict.
--
-- Flows land here too, at whatever window the run asked for, so a flow's
-- window totals never have to be re-derived by summing its daily rows.
create table if not exists public.klaviyo_message_performance (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  connection_id uuid references public.klaviyo_connections(id) on delete set null,
  kind text not null check (kind in ('campaign', 'flow_message')),
  klaviyo_id text not null,
  -- NOT NULL with an empty-string default, exactly like klaviyo_flow_daily, and
  -- for a reason worth stating: `channel` is part of the unique key, and
  -- Postgres treats NULLs in a unique index as DISTINCT -- so a nullable column
  -- here would let the same message, window and channel be inserted again on
  -- every run instead of being updated, silently multiplying one measurement.
  -- The sync writes '' when a report came back without a send_channel, and the
  -- view falls back to the message's own channel for display.
  channel text not null default '',
  timeframe_start timestamptz not null,
  timeframe_end timestamptz not null,
  -- Which metric the conversion columns were measured against. Part of no key,
  -- but stamped on every row: rows carrying different values measure
  -- different things.
  conversion_metric_id text,

  -- Klaviyo's campaign/flow statistics, by their own names. NULL = not
  -- reported for this row, never zero.
  recipients bigint,
  delivered bigint,
  opens bigint,
  opens_unique bigint,
  clicks bigint,
  clicks_unique bigint,
  conversions numeric,
  conversion_uniques numeric,
  conversion_value numeric,
  average_order_value numeric,
  revenue_per_recipient numeric,
  unsubscribes bigint,
  unsubscribe_uniques bigint,
  bounced bigint,
  bounced_or_failed bigint,
  failed bigint,
  spam_complaints bigint,
  -- SMS only, and null before 2025-10-01 or on a contracted plan.
  text_message_spend numeric,
  text_message_credit_usage_amount numeric,
  message_segment_count_sum numeric,

  -- Every other statistic the run asked for, by Klaviyo's own name. Rates
  -- Klaviyo computed are deliberately NOT promoted to columns -- the counts
  -- above are the source of truth and a rate is derived after pooling.
  metrics jsonb not null default '{}'::jsonb,

  source text not null default 'klaviyo',
  synced_at timestamptz not null default now(),
  sync_batch_id text,
  constraint klaviyo_message_performance_grain_key
    unique (company_entity_id, kind, klaviyo_id, channel, timeframe_start, timeframe_end),
  constraint klaviyo_message_performance_timeframe_check
    check (timeframe_end >= timeframe_start)
);

create index if not exists idx_klaviyo_message_performance_company_window
  on public.klaviyo_message_performance (company_entity_id, timeframe_start, timeframe_end);
create index if not exists idx_klaviyo_message_performance_company_kind
  on public.klaviyo_message_performance (company_entity_id, kind, klaviyo_id);

-- ── klaviyo_flow_daily: the flow series report at interval = daily ────────
-- The true daily grain. One row per (company, flow message, channel, day).
create table if not exists public.klaviyo_flow_daily (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  connection_id uuid references public.klaviyo_connections(id) on delete set null,
  klaviyo_id text not null,
  channel text not null default '',
  day_date date not null,
  conversion_metric_id text,

  recipients bigint,
  delivered bigint,
  opens bigint,
  opens_unique bigint,
  clicks bigint,
  clicks_unique bigint,
  conversions numeric,
  conversion_uniques numeric,
  conversion_value numeric,
  average_order_value numeric,
  revenue_per_recipient numeric,
  unsubscribes bigint,
  unsubscribe_uniques bigint,
  bounced bigint,
  bounced_or_failed bigint,
  failed bigint,
  spam_complaints bigint,
  text_message_spend numeric,
  text_message_credit_usage_amount numeric,
  message_segment_count_sum numeric,

  metrics jsonb not null default '{}'::jsonb,
  source text not null default 'klaviyo',
  synced_at timestamptz not null default now(),
  sync_batch_id text,
  constraint klaviyo_flow_daily_grain_key
    unique (company_entity_id, klaviyo_id, channel, day_date)
);

create index if not exists idx_klaviyo_flow_daily_company_day
  on public.klaviyo_flow_daily (company_entity_id, day_date);

-- ── klaviyo_oauth_states: the OAuth CSRF + PKCE handshake ─────────────────
-- Single-use, 10-minute rows, the same shape as ad_platform_oauth_states and
-- shopify_oauth_states. The PKCE verifier is kept here and nowhere else:
-- Klaviyo requires PKCE for confidential clients too, a fresh verifier is
-- needed per authorization request, and the browser must never see it.
-- Klaviyo expires the authorization code after 5 minutes, so a 10-minute row
-- always outlives the code it is waiting for.
create table if not exists public.klaviyo_oauth_states (
  nonce text primary key,
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  code_verifier text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes')
);

-- ── Views: read these, never the base tables ──────────────────────────────
-- security_invoker = true, so the SELECT policies above apply through them,
-- exactly like redo_marketing_daily_v. They add the message's name, channel
-- and parent so a report does not have to join by hand.
create or replace view public.klaviyo_message_performance_v
with (security_invoker = true) as
select
  p.id,
  p.company_entity_id,
  p.connection_id,
  p.kind,
  p.klaviyo_id,
  -- The performance row's own channel is what the report was grouped by; the
  -- message's is what Klaviyo says the message is. They agree in practice, and
  -- where a row came back without one the message still names it.
  coalesce(nullif(p.channel, ''), m.channel) as channel,
  m.name as message_name,
  m.subject,
  m.parent_id,
  m.parent_name,
  m.status,
  m.send_time,
  m.trigger_type,
  m.archived,
  p.timeframe_start,
  p.timeframe_end,
  p.conversion_metric_id,
  p.recipients,
  p.delivered,
  p.opens,
  p.opens_unique,
  p.clicks,
  p.clicks_unique,
  p.conversions,
  p.conversion_uniques,
  p.conversion_value,
  p.average_order_value,
  p.revenue_per_recipient,
  p.unsubscribes,
  p.unsubscribe_uniques,
  p.bounced,
  p.bounced_or_failed,
  p.failed,
  p.spam_complaints,
  p.text_message_spend,
  p.text_message_credit_usage_amount,
  p.message_segment_count_sum,
  p.metrics,
  p.source,
  p.synced_at
from public.klaviyo_message_performance p
left join public.klaviyo_messages m
  on m.company_entity_id = p.company_entity_id
 and m.kind = p.kind
 and m.klaviyo_id = p.klaviyo_id;

create or replace view public.klaviyo_flow_daily_v
with (security_invoker = true) as
select
  d.id,
  d.company_entity_id,
  d.connection_id,
  d.klaviyo_id,
  coalesce(nullif(d.channel, ''), m.channel) as channel,
  d.day_date,
  m.name as message_name,
  m.parent_id as flow_id,
  m.parent_name as flow_name,
  m.status,
  m.trigger_type,
  d.conversion_metric_id,
  d.recipients,
  d.delivered,
  d.opens,
  d.opens_unique,
  d.clicks,
  d.clicks_unique,
  d.conversions,
  d.conversion_uniques,
  d.conversion_value,
  d.average_order_value,
  d.revenue_per_recipient,
  d.unsubscribes,
  d.unsubscribe_uniques,
  d.bounced,
  d.bounced_or_failed,
  d.failed,
  d.spam_complaints,
  d.text_message_spend,
  d.text_message_credit_usage_amount,
  d.message_segment_count_sum,
  d.metrics,
  d.source,
  d.synced_at
from public.klaviyo_flow_daily d
left join public.klaviyo_messages m
  on m.company_entity_id = d.company_entity_id
 and m.kind = 'flow_message'
 and m.klaviyo_id = d.klaviyo_id;

-- ── RLS and grants ────────────────────────────────────────────────────────
alter table public.klaviyo_connections enable row level security;
alter table public.klaviyo_messages enable row level security;
alter table public.klaviyo_message_performance enable row level security;
alter table public.klaviyo_flow_daily enable row level security;
alter table public.klaviyo_oauth_states enable row level security;

-- The connection row carries a live credential (an API key, or OAuth tokens),
-- so even READING it is admin-only -- the same treatment as
-- ad_platform_connections and redo_connections.api_secret. Edge functions and
-- the sync use the service-role key and are unaffected.
revoke all on public.klaviyo_connections from anon, authenticated;
grant select, insert, update, delete on public.klaviyo_connections to authenticated;
grant all on public.klaviyo_connections to service_role;

drop policy if exists klaviyo_connections_admin_select on public.klaviyo_connections;
create policy klaviyo_connections_admin_select on public.klaviyo_connections
  for select to authenticated
  using (company_entity_id = (select public.active_company_id()) and public.is_admin_user());

drop policy if exists klaviyo_connections_admin_write on public.klaviyo_connections;
create policy klaviyo_connections_admin_write on public.klaviyo_connections
  for all to authenticated
  using (company_entity_id = (select public.active_company_id()) and public.is_admin_user())
  with check (company_entity_id = (select public.active_company_id()) and public.is_admin_user());

-- The data tables are readable by anyone in the company and writable only by
-- the service role: every row is Klaviyo's own number, and a hand-authored row
-- would be a figure Klaviyo has never reported. Same rule as the Stripe
-- mirrors and redo_marketing_daily.
do $$
declare t text;
begin
  foreach t in array array['klaviyo_messages', 'klaviyo_message_performance', 'klaviyo_flow_daily']
  loop
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('drop policy if exists %I on public.%I', t || '_active_select', t);
    execute format(
      'create policy %I on public.%I for select to authenticated '
      'using (company_entity_id = (select public.active_company_id()))',
      t || '_active_select', t);
  end loop;
end $$;

-- The views inherit their base tables' policies (security_invoker), so they
-- need the select grant and nothing else.
revoke all on public.klaviyo_message_performance_v from anon, authenticated;
revoke all on public.klaviyo_flow_daily_v from anon, authenticated;
grant select on public.klaviyo_message_performance_v to authenticated;
grant select on public.klaviyo_flow_daily_v to authenticated;
grant select on public.klaviyo_message_performance_v to service_role;
grant select on public.klaviyo_flow_daily_v to service_role;

-- The handshake table is service-role only, with no policy for anybody else:
-- it holds a PKCE verifier, and the browser that started the flow has no
-- reason to read it back. Same as shopify_oauth_states.
revoke all on public.klaviyo_oauth_states from anon, authenticated;
grant all on public.klaviyo_oauth_states to service_role;

drop trigger if exists stamp_created_by on public.klaviyo_connections;
create trigger stamp_created_by
  before insert on public.klaviyo_connections
  for each row execute function public.stamp_created_by();

-- ── integration_bootstrap_jobs.integration: append 'klaviyo' ──────────────
-- The first-sync queue refuses an integration it does not know, deliberately:
-- an unknown value must fail at enqueue rather than sit in the queue as a row
-- no drainer claims. Klaviyo now has a plan (BOOTSTRAP_PLANS in
-- scripts/lib/integration-bootstrap-core.mjs) and a connection source in the
-- drainer, so it belongs in the list. Read live and idempotent, as above.
do $$
declare
  cname text;
  cur text;
  members text;
begin
  select conname, pg_get_constraintdef(oid) into cname, cur
  from pg_constraint
  where conrelid = 'public.integration_bootstrap_jobs'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%integration%'
    and pg_get_constraintdef(oid) like '%shopify%'
  limit 1;

  if cname is null then
    raise exception 'no integration CHECK found on integration_bootstrap_jobs; read the live constraint before adding klaviyo';
  end if;

  if cur ~ '''klaviyo''' then
    return;
  end if;

  members := substring(cur from 'ARRAY\[(.*?)\]');
  if members is null or members = '' then
    raise exception 'the integration CHECK has an unexpected shape (%); extend it by hand after reading it', cur;
  end if;

  execute format('alter table public.integration_bootstrap_jobs drop constraint %I', cname);
  execute format(
    'alter table public.integration_bootstrap_jobs add constraint %I check (integration = any (array[%s, %L::text]))',
    cname, members, 'klaviyo'
  );
end $$;

-- ── sync_jobs.job_type: append 'klaviyo' to the LIVE list ─────────────────
-- The constraint is read from the database rather than from migration files,
-- because production carries hand-applied objects and the file list is not
-- authoritative. Idempotent, and it refuses to guess: an unexpected shape
-- raises instead of replacing a constraint nobody has read.
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
    raise exception 'sync_jobs_job_type_check not found; read the live job_type constraint before adding klaviyo';
  end if;

  -- Word-bounded: 'klaviyo_something' already in the list must not be read as
  -- this value being present.
  if cur ~ '''klaviyo''' then
    return;
  end if;

  members := substring(cur from 'ARRAY\[(.*?)\]');
  if members is null or members = '' then
    raise exception 'sync_jobs_job_type_check has an unexpected shape (%); extend it by hand after reading it', cur;
  end if;

  execute 'alter table public.sync_jobs drop constraint sync_jobs_job_type_check';
  execute format(
    'alter table public.sync_jobs add constraint sync_jobs_job_type_check check (job_type = any (array[%s, %L::text]))',
    members, 'klaviyo'
  );
end $$;

-- ── The insert-stamp backstop ─────────────────────────────────────────────
select public.attach_stamp_company_entity_id_triggers();

-- ── Ask SILO / MCP catalog ────────────────────────────────────────────────
insert into public.silo_chat_schema_catalog (relname, relkind, columns, description, keywords)
values
  ('klaviyo_message_performance_v', 'v', '[]'::jsonb,
   'Klaviyo email and SMS performance per message, straight from Klaviyo''s own '
   'API. One row per message x channel x REPORTING WINDOW (timeframe_start, '
   'timeframe_end) -- NOT per day, because Klaviyo publishes no daily series '
   'for campaigns. kind = ''campaign'' or ''flow_message''; send_time is when a '
   'campaign went out, and parent_name is the campaign or the flow. NEVER sum '
   'rows from different windows: overlapping windows measure the same sends '
   'twice. No rate is stored -- divide counts after pooling, because Klaviyo''s '
   'rates are counts over counts. conversion_value is revenue Klaviyo '
   'ATTRIBUTES to email/SMS: it overlaps net sales and ad-platform revenue, so '
   'never add it to either, and it is only comparable across rows sharing one '
   'conversion_metric_id. text_message_spend is SMS sending cost, not ad spend. '
   'NULL means not reported, not zero (SMS statistics are null before '
   '2025-10-01). For a company that syncs Klaviyo directly, prefer this over '
   'klaviyo_performance_daily, which is the Windsor.ai copy.',
   array['klaviyo','email','sms','campaign','flow','opens','clicks','email revenue','marketing']),
  ('klaviyo_flow_daily_v', 'v', '[]'::jsonb,
   'Klaviyo FLOW (automation) performance per day, straight from Klaviyo''s own '
   'API -- the daily grain campaigns do not have. One row per flow message x '
   'channel x day_date, with flow_name and message_name joined in. Counts only, '
   'no rates: pool over the window, then divide. conversion_value is '
   'Klaviyo-ATTRIBUTED revenue, overlapping net sales and ad-platform revenue, '
   'and comparable only across rows sharing one conversion_metric_id. NULL '
   'means not reported, not zero. A day absent inside a synced window had no '
   'activity; a day outside every synced window was never ingested, which is '
   'not the same as zero. Campaign numbers are in '
   'klaviyo_message_performance_v.',
   array['klaviyo','flow','automation','email','sms','daily','opens','clicks','marketing'])
on conflict (relname) do nothing;
