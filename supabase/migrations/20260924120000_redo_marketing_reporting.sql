-- 20260924120000_redo_marketing_reporting.sql
-- ---------------------------------------------------------------------------
-- Redo marketing reporting: campaigns and automations, email and SMS.
--
-- Source: Redo's Reporting API (GraphQL, POST /v3/account/{store}/graphql),
-- read with the SAME token already stored on redo_connections.api_secret for
-- the returns sync (its scopes were widened in Redo; confirmed 2026-09-24).
-- Written by scripts/redo-marketing-sync.mjs, service role only.
--
-- Built to what the live API MEASURED on 2026-09-24, not to the doc alone:
--
--   * Every rate is a count over DELIVERED: openRate = uniqueOpens/delivered,
--     clickThroughRate = uniqueClicks/delivered, conversionRate =
--     orders/delivered, unsubscribeRate = unsubscribes/delivered (checked to
--     the last digit on a live campaign). So this schema stores the COUNTS
--     and no rate at all. A per-day rate is not even well-formed here: orders
--     and clicks keep landing on days after the send, so a day with 85
--     deliveries and 258 clicks has a "click-through rate" of 303% (measured).
--     Pool the counts over the window, then divide.
--   * The day-by-day series summed per channel equals Redo's own window
--     totals exactly, for every one of the 24 active automations and the
--     sampled campaigns -- recipients included. So the daily grain loses
--     nothing and totals are always a SUM of these rows.
--   * Paused automations (enabled = false) still send and still attribute
--     revenue inside a window, so the sync never filters on `enabled`.
--
-- Semantics worth carrying to every reader (also in the Ask SILO catalog):
--   * revenue is ATTRIBUTED (Redo's attribution_window_days, 5 by default,
--     though see below), not incremental. It overlaps with what Meta,
--     Google and TikTok also claim and must never be added to Shopify sales.
--   * spend is Redo's MESSAGING cost (per email/SMS sent), always USD. It is
--     not an ad budget and does not belong in marketing_kpis_daily.
--   * Paused and months-old campaigns keep attributing: over 2026-08-24..
--     09-22, campaigns sent as early as 2026-07-14 carried 42 orders ($4,309)
--     -- far beyond the documented 5-day window. So the sync fetches every
--     campaign (no send-date filter) and the whole-window sums then equal
--     Redo's own totals to the cent (measured: 8,734,088 sends, 4,552 orders,
--     $461,517.46 for campaigns; 333,328 / 2,321 / $233,345.36 automations).
--   * Engagement lands on the send day; orders on the ORDER day. So recent
--     days restate upward for WEEKS, not 5 days; the nightly re-pulls a
--     trailing 60 days and overwrites.
--   * A day absent inside a synced window had no activity (Redo omits quiet
--     days). A day outside every synced window is NOT ingested, not zero.
-- ---------------------------------------------------------------------------

-- ── redo_marketing_messages: one row per campaign or automation ───────────
create table if not exists public.redo_marketing_messages (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  connection_id uuid references public.redo_connections(id) on delete set null,
  kind text not null check (kind in ('campaign', 'automation')),
  -- Redo's stable id for the life of the object -- the key. legacy_id is the
  -- id earlier Redo APIs used, kept for reconciling older pulls.
  redo_id text not null,
  legacy_id text,
  name text not null,
  -- Campaign-only. A campaign sends on ONE channel; an automation may send
  -- both, so its channel lives on the daily rows only.
  channel text check (channel is null or channel in ('EMAIL', 'SMS')),
  status text,
  sent_at timestamptz,
  scheduled_at timestamptz,
  tags text[] not null default '{}',
  -- emailVariants[0].template.subject. A split test has several subjects;
  -- all of them are in email_variants. Null when the template was deleted.
  subject text,
  preview_text text,
  email_variants jsonb not null default '[]'::jsonb,
  -- Automation-only.
  category text,
  enabled boolean,
  description text,
  redo_created_at timestamptz,
  redo_updated_at timestamptz,
  synced_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists redo_marketing_messages_identity
  on public.redo_marketing_messages (company_entity_id, kind, redo_id);

-- ── redo_marketing_daily: counts per message, per channel, per day ────────
create table if not exists public.redo_marketing_daily (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  connection_id uuid references public.redo_connections(id) on delete set null,
  kind text not null check (kind in ('campaign', 'automation')),
  redo_id text not null,
  channel text not null check (channel in ('EMAIL', 'SMS')),
  -- Redo's date, in the STORE's timezone.
  day_date date not null,
  recipients integer not null default 0,
  sends integer not null default 0,
  delivered integer not null default 0,
  failures integer not null default 0,
  unique_opens integer not null default 0,
  unique_clicks integer not null default 0,
  unsubscribes integer not null default 0,
  orders integer not null default 0,
  new_customer_orders integer not null default 0,
  returning_customer_orders integer not null default 0,
  -- Money arrives as an exact decimal string; stored as numeric, never float.
  -- revenue is in the STORE currency; spend is ALWAYS USD (Redo's rule).
  revenue numeric(14,2) not null default 0,
  new_customer_revenue numeric(14,2) not null default 0,
  returning_customer_revenue numeric(14,2) not null default 0,
  revenue_currency text,
  spend numeric(14,4) not null default 0,
  spend_currency text not null default 'USD',
  attribution_window_days integer not null default 5,
  synced_at timestamptz not null,
  created_at timestamptz not null default now()
);

create unique index if not exists redo_marketing_daily_identity
  on public.redo_marketing_daily (company_entity_id, kind, redo_id, channel, day_date);
create index if not exists redo_marketing_daily_company_day
  on public.redo_marketing_daily (company_entity_id, day_date);

-- ── The newest run wins ────────────────────────────────────────────────────
-- The nightly and a manual backfill can overlap. An upsert whose synced_at is
-- OLDER than the stored row's is dropped, so a slow older run cannot rewrite
-- a newer run's numbers. Equal passes (a retry inside one run). Same rule and
-- reasoning as search_console_reject_stale_write (20260914130000).
create or replace function public.redo_marketing_reject_stale_write()
returns trigger
language plpgsql
as $$
begin
  if new.synced_at < old.synced_at then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_redo_marketing_newest_run_wins on public.redo_marketing_messages;
create trigger trg_redo_marketing_newest_run_wins
  before update on public.redo_marketing_messages
  for each row execute function public.redo_marketing_reject_stale_write();

drop trigger if exists trg_redo_marketing_newest_run_wins on public.redo_marketing_daily;
create trigger trg_redo_marketing_newest_run_wins
  before update on public.redo_marketing_daily
  for each row execute function public.redo_marketing_reject_stale_write();

-- ── RLS: read your active company, write nothing ──────────────────────────
alter table public.redo_marketing_messages enable row level security;
alter table public.redo_marketing_daily enable row level security;
revoke all on public.redo_marketing_messages from anon;
revoke all on public.redo_marketing_daily from anon;

drop policy if exists redo_marketing_messages_select on public.redo_marketing_messages;
create policy redo_marketing_messages_select on public.redo_marketing_messages
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists redo_marketing_daily_select on public.redo_marketing_daily;
create policy redo_marketing_daily_select on public.redo_marketing_daily
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- ── The reading surface ────────────────────────────────────────────────────
-- Daily counts with the message's name and descriptors. security_invoker, so
-- both tables' RLS applies to whoever reads it. Deliberately NO rate columns:
-- a rate belongs to a window, and is sum(numerator)/sum(delivered) over it.
create or replace view public.redo_marketing_daily_v
with (security_invoker = true) as
select
  d.company_entity_id,
  d.kind,
  d.redo_id,
  m.name,
  d.channel,
  d.day_date,
  m.status,
  m.sent_at,
  m.subject,
  m.tags,
  m.category,
  m.enabled,
  d.recipients,
  d.sends,
  d.delivered,
  d.failures,
  d.unique_opens,
  d.unique_clicks,
  d.unsubscribes,
  d.orders,
  d.new_customer_orders,
  d.returning_customer_orders,
  d.revenue,
  d.new_customer_revenue,
  d.returning_customer_revenue,
  d.revenue_currency,
  d.spend,
  d.spend_currency,
  d.attribution_window_days,
  d.synced_at
from public.redo_marketing_daily d
left join public.redo_marketing_messages m
  on m.company_entity_id = d.company_entity_id
 and m.kind = d.kind
 and m.redo_id = d.redo_id;

revoke all on public.redo_marketing_daily_v from anon;
grant select on public.redo_marketing_daily_v to authenticated;

-- The insert-stamp backstop (CLAUDE.md, "Adding a new DB table" step 5).
select public.attach_stamp_company_entity_id_triggers();

-- ── sync_jobs.job_type: append 'redo_marketing' to the LIVE list ─────────
-- Read from pg_constraint and appended, never retyped -- same mechanism as
-- 20260910180000, so a value that exists only in production survives.
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
    raise exception 'sync_jobs_job_type_check not found; read the live job_type constraint before adding redo_marketing';
  end if;

  if cur like '%''redo_marketing''%' then
    return; -- already applied
  end if;

  members := substring(cur from 'ARRAY\[(.*?)\]');
  if members is null or members = '' then
    raise exception 'sync_jobs_job_type_check has an unexpected shape (%); extend it by hand after reading it', cur;
  end if;

  execute 'alter table public.sync_jobs drop constraint sync_jobs_job_type_check';
  execute format(
    'alter table public.sync_jobs add constraint sync_jobs_job_type_check check (job_type = any (array[%s, %L::text]))',
    members, 'redo_marketing'
  );
end $$;

-- ── Ask SILO catalog ───────────────────────────────────────────────────────
-- Appended under a marker, never `set description = ...` (20260910150000).
insert into public.silo_chat_schema_catalog (relname, relkind, columns, description, keywords)
values
  ('redo_marketing_daily_v', 'view', '[]'::jsonb,
   'REDO EMAIL/SMS MARKETING: Redo campaign and automation (flow) performance '
   'per message, per channel (EMAIL/SMS), per day. kind = campaign (one-off '
   'blast) or automation (always-on flow: welcome, abandoned cart, low '
   'inventory, order tracking...). Columns are COUNTS: recipients, sends, '
   'delivered, failures, unique_opens, unique_clicks, unsubscribes, orders, '
   'new/returning_customer_orders, revenue, new/returning_customer_revenue, '
   'spend. There are NO rate columns on purpose: open rate = sum(unique_opens) '
   '/ sum(delivered), click rate = sum(unique_clicks)/sum(delivered), '
   'conversion = sum(orders)/sum(delivered), unsubscribe rate = '
   'sum(unsubscribes)/sum(delivered), all over the window asked about -- never '
   'average daily rates (a single day can exceed 100% because clicks and '
   'orders land after the send day). SMS has no opens: report its open rate as '
   'not applicable, never 0%. revenue is ATTRIBUTED by Redo (an order within '
   'attribution_window_days of a message, default 5, measured to extend much '
   'longer in practice) -- NOT incremental, it '
   'overlaps with Meta/Google/TikTok claims, and must NEVER be added to '
   'Shopify sales or called "email revenue" without saying attributed. spend '
   'is Redo''s per-message sending cost in USD, not an ad budget; keep it out '
   'of ad-spend/MER/ROAS totals. An automation that sends both channels has '
   'one row per channel per day: sum across channel for the automation total. '
   'Engagement lands on the SEND day and orders on the ORDER day, and Redo '
   'keeps attributing orders to a message for weeks (July campaigns still '
   'earned late-August orders), so recent weeks are still rising and a '
   'campaign''s revenue is not final days after it sends. A day absent inside the synced range had no '
   'activity; check min/max day_date before calling earlier history zero.',
   array['redo','email','sms','text message','campaign','automation','flow','klaviyo','newsletter','open rate','click rate','unsubscribe','attributed revenue','email marketing','sms marketing']),
  ('redo_marketing_daily', 'table', '[]'::jsonb,
   'REDO EMAIL/SMS MARKETING: base table under redo_marketing_daily_v (which '
   'adds the campaign/automation name, subject, tags and category -- prefer '
   'the view). Grain: company x kind x redo_id x channel x day_date. Counts '
   'only; rates are sum(numerator)/sum(delivered) over a window. revenue is '
   'Redo-attributed, never incremental; spend is USD sending cost.',
   array['redo','email','sms','campaign','automation']),
  ('redo_marketing_messages', 'table', '[]'::jsonb,
   'REDO EMAIL/SMS MARKETING: one row per Redo campaign or automation (kind), '
   'keyed by redo_id -- name, channel and sent_at/status (campaigns), '
   'category/enabled (automations), subject (first email variant; all split '
   'test subjects in email_variants), tags (empty until campaigns are tagged '
   'in Redo). Join to redo_marketing_daily on (kind, redo_id). Every campaign '
   'Redo returns is here, drafts and scheduled ones included -- status says '
   'which (FINISHED = sent); a campaign with no daily rows had no activity in '
   'any synced window.',
   array['redo','email','sms','campaign','automation','subject line','flow'])
on conflict (relname) do update
  set description = case
        when coalesce(public.silo_chat_schema_catalog.description, '') like '%REDO EMAIL/SMS MARKETING%'
        then public.silo_chat_schema_catalog.description
        else coalesce(public.silo_chat_schema_catalog.description, '') || excluded.description
      end,
      keywords = coalesce(public.silo_chat_schema_catalog.keywords, excluded.keywords),
      updated_at = now();

select public.refresh_chat_schema_catalog();
