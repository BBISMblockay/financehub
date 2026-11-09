-- Klaviyo audiences: the lists and segments a campaign was sent to.
--
-- Why this exists. SILO's Klaviyo OAuth has always requested `lists:read` and
-- `segments:read`, but no code called a list or a segment endpoint. An app that
-- asks for a permission it does not use is asking for more than it needs, and
-- Klaviyo's reviewers check requested scopes against the endpoints a submission
-- declares. Blake's call (2026-11-09) was to keep the scopes and put them to
-- real use rather than drop them.
--
-- What it adds. One table for both kinds of audience, because they differ only
-- in which endpoint returned them and a report wants them side by side: a
-- campaign's audience is a mix of lists and segments, and splitting them into
-- two tables would mean two reads and a union at every call site. `kind` says
-- which it is.
--
-- The campaign side is a column on klaviyo_messages rather than a join table:
-- Klaviyo returns the audience as part of the campaign, it is small, it is
-- replaced wholesale on every sync, and nothing queries "every campaign that
-- used list X" -- so a jsonb column is the shape of the data rather than a
-- normalisation waiting to be undone.
--
-- Idempotent, additive, and safe to re-run: no existing column changes type,
-- nothing is dropped, and a company with no Klaviyo sees an empty table.

-- ── the audiences themselves ───────────────────────────────────────────────
create table if not exists public.klaviyo_audiences (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id),
  connection_id uuid references public.klaviyo_connections(id) on delete cascade,
  -- 'list' or 'segment'. Part of the identity: the two id spaces are separate,
  -- so a list and a segment could in principle carry the same id.
  kind text not null check (kind in ('list', 'segment')),
  klaviyo_id text not null,
  name text,
  -- No profile count. Klaviyo's list and segment endpoints (revision
  -- 2026-10-15) expose no count field and no additional-fields parameter that
  -- would add one -- profiles are a relationship, not a number. A column that
  -- could only ever be NULL would read as "nobody is on this list", so it is
  -- not here. If a counting endpoint appears, it lands as its own column.
  created_at_remote timestamptz,
  updated_at_remote timestamptz,
  -- Whatever else the endpoint returned, kept whole so a later feature does not
  -- need a backfill to see a field this migration did not think of.
  attributes jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  sync_batch_id text
);

create unique index if not exists klaviyo_audiences_identity
  on public.klaviyo_audiences (company_entity_id, kind, klaviyo_id);
create index if not exists idx_klaviyo_audiences_company_kind
  on public.klaviyo_audiences (company_entity_id, kind);

comment on table public.klaviyo_audiences is
  'KLAVIYO: one row per list or segment in the connected account (kind says which), '
  'by name. Read-only mirror, refreshed by the Klaviyo sync. Klaviyo exposes no '
  'profile count on these endpoints, so there is none here. Join to the audience '
  'ids in klaviyo_messages.audiences to name a campaign''s audience.';

-- ── the campaign's own audience ────────────────────────────────────────────
-- Klaviyo returns a campaign's audience as a related `campaign-audience`
-- object whose definition carries `included` and `excluded` id arrays. The docs
-- call these "group IDs" and do not say whether a given id is a list or a
-- segment, so SILO stores them as returned and resolves each id against
-- klaviyo_audiences REGARDLESS of kind -- which is correct either way, and
-- shows the raw id rather than guessing when an id resolves to neither.
alter table public.klaviyo_messages
  add column if not exists audiences jsonb;

comment on column public.klaviyo_messages.audiences is
  'KLAVIYO: the campaign''s audience as Klaviyo returned it -- {name, included:[id,...], '
  'excluded:[id,...]}. Klaviyo calls the entries group ids and does not say whether '
  'each is a list or a segment, so resolve them against klaviyo_audiences on id alone. '
  'NULL for a flow message, which has no audience of its own.';

-- ── RLS and grants ─────────────────────────────────────────────────────────
-- Same rule as the other Klaviyo data tables: readable by anyone in the
-- company, writable only by the service role. Every row is Klaviyo's own
-- number, and a hand-authored row would be a figure Klaviyo never reported.
alter table public.klaviyo_audiences enable row level security;
revoke all on public.klaviyo_audiences from anon, authenticated;
grant select on public.klaviyo_audiences to authenticated;
grant all on public.klaviyo_audiences to service_role;
drop policy if exists klaviyo_audiences_active_select on public.klaviyo_audiences;
create policy klaviyo_audiences_active_select on public.klaviyo_audiences
  for select to authenticated
  using (company_entity_id = (select public.active_company_id()));


-- ── the account's own currency ─────────────────────────────────────────────
-- SILO also now requests `accounts:read`, so GET /api/accounts can be asked
-- for the account's `preferred_currency`. That matters for money: Klaviyo
-- reports SMS sending cost as a bare number with no currency anywhere in the
-- payload, so until now the attribution page took USD on faith and labelled
-- the figure "assumed USD". With this column the currency is Klaviyo's own
-- answer, and a company billed in another currency stops being quietly
-- counted as dollars.
--
-- Nullable on purpose, and NULL is not "USD": it means Klaviyo did not say.
-- A connection granted before the scope was requested, or a private API key
-- made without it, returns 403 from that endpoint -- the connection test
-- records the refusal and leaves this null, and the page goes back to saying
-- the currency is assumed. Klaviyo cannot widen an existing grant, so such a
-- connection fills this in only after a re-consent.
alter table public.klaviyo_connections
  add column if not exists account_currency text;

comment on column public.klaviyo_connections.account_currency is
  'KLAVIYO: the account''s preferred_currency from GET /api/accounts (needs accounts:read). '
  'The currency of klaviyo_flow_daily.text_message_spend and klaviyo_message_performance.'
  'text_message_spend, which Klaviyo reports without one. NULL means Klaviyo did not say '
  '-- NOT that the account is in USD.';

-- ── stamp trigger ──────────────────────────────────────────────────────────
-- The company stamp trigger is the backstop for any write that forgets it.
-- Last, so it sees every table this migration added.
select public.attach_stamp_company_entity_id_triggers();
