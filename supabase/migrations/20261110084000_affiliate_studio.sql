-- =============================================================================
-- Affiliate Studio -- configure, discover, contact, onboard, track.
--
-- A SILO marketing module for any tenant: find creators who fit a brand,
-- recruit them, sign them up on the brand's terms, attach them to the codes
-- and links they will be paid on. The commission ledger and the payout
-- handoff are the next migration (20261110085000); this one is everything up
-- to and including "this affiliate owns this code from this date".
--
-- NOTHING HERE IS COMPANY-SPECIFIC. Niche, audience, terms, commission rate,
-- the discovery queries, the attribution window and the precedence rule are
-- per-program DATA. There is no brand, no vertical and no code convention in
-- this file.
--
-- ── WHAT AUTHORITY MEANS HERE ───────────────────────────────────────────────
--
-- `is_admin_user()` passes for nearly every profile in this schema, so it is
-- not the gate for anything in this module. Three authorities, deliberately
-- separate:
--
--   READ        -- any member of the active company. A prospect list and an
--                  affiliate's performance are operational marketing data.
--   MANAGE      -- can_manage_affiliate_programs(): sets commission rates,
--                  approves prospects and outreach, attaches codes. Owner,
--                  owner_admin, exec, or an explicit per-company grant
--                  (affiliate_program_managers) so a tenant can hand the
--                  module to the marketing person who actually runs it
--                  without making them an exec. Same grant-table shape as
--                  seo_approvers.
--   MONEY       -- can_approve_affiliate_commissions(), in the NEXT
--                  migration: approving what gets paid. The same population
--                  as can_manage_journal_entries() and a separate function
--                  for the same reason that one is separate from the AP gate:
--                  "may run the affiliate program" and "may release money"
--                  diverge, and the day they do, widening one must not widen
--                  the other.
--
-- ── WHAT THIS MODULE REFUSES TO DO ──────────────────────────────────────────
--
--   * It never writes to Shopify. SILO's Shopify scopes are read-only
--     (scripts/lib/shopify-auth-lib.mjs) and this module does not widen them.
--     An affiliate code is a code that ALREADY EXISTS in the merchant's
--     Shopify admin and is recorded here; `affiliate_codes.verified_at` says
--     whether SILO has ever SEEN that code on a real order, which is the only
--     confirmation available without a write scope.
--   * It never sends prospect outreach itself. Outreach is drafted, approved
--     and EXPORTED for a person to send from their own mailbox. Resend is
--     SILO's transactional sender and cold outreach is not transactional;
--     sending recruitment mail through it would put SILO's sending domain
--     behind mail the recipient never asked for. The three states --
--     approved, exported, sent -- are separate columns with separate actors,
--     and `sent` requires recorded evidence (enforced by trigger), because
--     SILO cannot observe a send it did not make.
--   * It never fabricates a metric or an address. Every prospect field that
--     did not come from a person comes with the URL it was read from and the
--     time it was read (affiliate_prospect_observations), and `confidence` is
--     a stored number with a stated basis, not a vibe.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Authority
-- ---------------------------------------------------------------------------

create table if not exists public.affiliate_program_managers (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  granted_by        uuid references auth.users(id) on delete set null,
  note              text,
  created_at        timestamptz not null default now()
);

create unique index if not exists affiliate_program_managers_identity
  on public.affiliate_program_managers (company_entity_id, user_id);

alter table public.affiliate_program_managers enable row level security;

-- A granted user sees their own row so a page can self-check; only exec/owner
-- sees or changes the whole list. Same shape as seo_approvers.
drop policy if exists affiliate_program_managers_select on public.affiliate_program_managers;
create policy affiliate_program_managers_select on public.affiliate_program_managers
  for select to authenticated
  using (company_entity_id = public.active_company_id()
         and (user_id = auth.uid() or public.is_exec_or_owner()));

drop policy if exists affiliate_program_managers_write on public.affiliate_program_managers;
create policy affiliate_program_managers_write on public.affiliate_program_managers
  for all to authenticated
  using (company_entity_id = public.active_company_id() and public.is_exec_or_owner())
  with check (company_entity_id = public.active_company_id() and public.is_exec_or_owner());

comment on table public.affiliate_program_managers is
  'Per-company grant: who may run Affiliate Studio without being an exec. Read: your own row, or exec/owner. Write: exec/owner. Nav visibility is UX only -- this table is read by can_manage_affiliate_programs(), which the RLS policies enforce.';

-- Company isolation is INSIDE the function, not left to the caller: the grant
-- counts only for the caller's ACTIVE company, so a manager at one tenant is
-- not a manager at another. DEFINER for the same reason can_approve_seo_tasks()
-- is -- it reads the caller's own rows and must not re-enter the policies on
-- the tables it reads.
create or replace function public.can_manage_affiliate_programs()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.is_exec_or_owner()
      or exists (
        select 1
        from public.affiliate_program_managers g
        join public.profiles p on p.id = g.user_id
        where g.user_id = auth.uid()
          and g.company_entity_id = public.active_company_id()
          and p.is_active = true
      );
$$;

comment on function public.can_manage_affiliate_programs() is
  'May the caller configure the active company''s affiliate programs: commission terms, prospect approval, outreach approval, code and link assignment. Exec/owner, or an active affiliate_program_managers grant for THAT company. Deliberately not is_admin_user() (which passes for nearly every profile) and deliberately not the money gate -- releasing a payout is can_approve_affiliate_commissions().';

revoke execute on function public.can_manage_affiliate_programs() from public, anon;
grant execute on function public.can_manage_affiliate_programs() to authenticated;

-- ---------------------------------------------------------------------------
-- 1. Programs -- the configuration every other table reads
-- ---------------------------------------------------------------------------

create table if not exists public.affiliate_programs (
  id                     uuid primary key default gen_random_uuid(),
  company_entity_id      uuid not null references public.entities(id) on delete cascade,
  name                   text not null check (btrim(name) <> ''),
  slug                   text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  status                 text not null default 'draft'
                           check (status in ('draft','active','paused','closed')),

  -- Who SILO is looking for. Free text and arrays on purpose: a niche is a
  -- sentence, not an enum, and the discovery sources read these as the
  -- operator's own words.
  niche                  text,
  audience_notes         text,
  geographies            text[],
  platforms              text[],

  intake_mode            text not null default 'invite_only'
                           check (intake_mode in ('invite_only','open')),

  -- Commission. percent_of_net is a percentage of the commissionable base
  -- (order subtotal after discounts and refunds, before tax and shipping);
  -- fixed_per_order is a flat amount per attributed order. Exactly one of the
  -- two numbers is required, which is a CHECK rather than two nullable
  -- columns nobody validates.
  commission_kind        text not null default 'percent_of_net'
                           check (commission_kind in ('percent_of_net','fixed_per_order')),
  commission_percent     numeric(6,3) check (commission_percent >= 0 and commission_percent <= 100),
  commission_fixed_cents integer check (commission_fixed_cents >= 0),

  -- The program's settlement currency. Commission is accrued ONLY on orders
  -- in this currency; an order in another currency is recorded as
  -- 'currency_mismatch' and left unaccrued rather than converted at a rate
  -- SILO does not hold. See the ledger migration.
  currency               text not null default 'USD'
                           check (currency ~ '^[A-Z]{3}$'),

  -- GRACE, not a click window. SILO attributes an order to an affiliate
  -- through the discount code the customer typed, and the code's own
  -- starts_on/ends_on is the campaign. This is how many days AFTER a code's
  -- end date an order may still be credited, because a customer who was sent
  -- a code on the last day of a campaign often orders a day later. Default 0:
  -- a non-zero default would silently extend every campaign nobody configured.
  attribution_window_days integer not null default 0
                           check (attribution_window_days between 0 and 365),

  -- How an order carrying SEVERAL discount codes is handled:
  --   first_affiliate_code -- the one code that maps to an affiliate wins; if
  --                           two affiliate codes are on one order it is
  --                           still ambiguous and is NOT attributed.
  --   single_code_only     -- an order with more than one code of any kind is
  --                           never attributed.
  -- Neither mode ever splits an order across two affiliates, and neither ever
  -- attributes the same order twice: the resolver's unique key is the order.
  code_precedence        text not null default 'first_affiliate_code'
                           check (code_precedence in ('first_affiliate_code','single_code_only')),

  -- Refund hold: how long after an order a commission stays unpayable, so a
  -- refund inside the return window reduces the accrual before money moves.
  refund_hold_days       integer not null default 30 check (refund_hold_days between 0 and 365),
  payout_minimum_cents   integer not null default 0 check (payout_minimum_cents >= 0),
  payout_method          text not null default 'manual'
                           check (payout_method in ('manual','stripe_connect_express')),

  -- The most one discovery run may spend on the SERP provider for this
  -- program, in USD, checked between queries against the provider's OWN
  -- reported cost. The same bound the SEO module puts on its SERP schedule.
  discovery_max_cost_usd numeric(8,4) not null default 0.50
                           check (discovery_max_cost_usd >= 0 and discovery_max_cost_usd <= 25),

  default_code_starts_on date,
  default_code_ends_on   date,
  constraint affiliate_programs_default_window
    check (default_code_ends_on is null or default_code_starts_on is null
           or default_code_ends_on >= default_code_starts_on),

  -- The designated employee: the human the affiliate's mail is answered by
  -- and whose name the outreach is signed with. A profile, so it follows the
  -- person rather than an address typed once.
  owner_user_id          uuid references public.profiles(id) on delete set null,

  terms_markdown         text,
  terms_version          integer not null default 1 check (terms_version >= 1),
  terms_updated_at       timestamptz,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  created_by             uuid references public.profiles(id),
  changed_by             uuid references public.profiles(id),

  constraint affiliate_programs_commission_configured check (
    (commission_kind = 'percent_of_net'  and commission_percent is not null)
    or (commission_kind = 'fixed_per_order' and commission_fixed_cents is not null)
  )
);

create unique index if not exists affiliate_programs_slug_identity
  on public.affiliate_programs (company_entity_id, slug);

alter table public.affiliate_programs enable row level security;

drop policy if exists affiliate_programs_select on public.affiliate_programs;
create policy affiliate_programs_select on public.affiliate_programs
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists affiliate_programs_write on public.affiliate_programs;
create policy affiliate_programs_write on public.affiliate_programs
  for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_programs())
  with check (company_entity_id = public.active_company_id() and public.can_manage_affiliate_programs());

comment on table public.affiliate_programs is
  'One affiliate program per brand/campaign, per company. Holds the whole configuration the rest of the module reads: niche and audience for discovery, commission terms, settlement currency, attribution window, multi-code precedence, refund hold, terms text and version, and the designated employee. Read: any member. Write: can_manage_affiliate_programs().';

-- Terms text and terms version move together, in the database. Editing the
-- text bumps the version, so an affiliate who accepted version N is never
-- shown as having accepted words that changed afterwards, and the portal's
-- stale-version refusal (40001) fires for anyone mid-signup. A UI rule would be
-- bypassed by the next writer; this cannot be. Inserts keep what they set.
create or replace function public.affiliate_programs_terms_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.terms_markdown is distinct from old.terms_markdown then
    new.terms_version := old.terms_version + 1;
    new.terms_updated_at := now();
  elsif new.terms_version is distinct from old.terms_version then
    -- The version is not a free-standing field: it only moves with the text.
    new.terms_version := old.terms_version;
    new.terms_updated_at := old.terms_updated_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.affiliate_programs_terms_guard() from public, anon, authenticated;

drop trigger if exists affiliate_programs_terms_guard_trg on public.affiliate_programs;
create trigger affiliate_programs_terms_guard_trg
  before update on public.affiliate_programs
  for each row execute function public.affiliate_programs_terms_guard();

comment on column public.affiliate_programs.code_precedence is
  'How an order carrying several discount codes is resolved. first_affiliate_code: the single code mapped to an affiliate wins, and two affiliate codes on one order are ambiguous and unattributed. single_code_only: any multi-code order is unattributed. Neither splits an order and neither attributes one twice.';

comment on column public.affiliate_programs.attribution_window_days is
  'Days after a code''s ends_on that an order may still be credited to it (trailing grace). It is NOT a click-to-order window: code attribution has no click, and SILO does not host a redirector. A code with no ends_on is open-ended and this value never applies to it.';

comment on column public.affiliate_programs.currency is
  'The program settles in this currency. An attributed order in a different currency is recorded with basis currency_mismatch and accrues NOTHING -- SILO holds no FX rate and will not invent one.';

-- ---------------------------------------------------------------------------
-- 2. Discovery -- sources, prospects, and the provenance of every field
-- ---------------------------------------------------------------------------

create table if not exists public.affiliate_prospect_sources (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  program_id        uuid not null references public.affiliate_programs(id) on delete cascade,
  kind              text not null check (kind in ('serp_query','manual_import')),
  -- The search SILO runs. The operator's own words, which is what keeps this
  -- generic: there is no built-in notion of what a creator looks like.
  query             text,
  -- DataForSEO's location/language coding, the SERP vendor SILO already uses
  -- for the SEO module. NULL means the provider default.
  location_code     integer,
  language_code     text,
  platform_hint     text,
  max_results       integer not null default 20 check (max_results between 1 and 100),
  enabled           boolean not null default true,
  last_run_at       timestamptz,
  last_run_results  integer,
  last_run_cost     numeric(10,4),
  last_error        text,
  created_at        timestamptz not null default now(),
  created_by        uuid references public.profiles(id),
  constraint affiliate_prospect_sources_query_required
    check (kind <> 'serp_query' or btrim(coalesce(query,'')) <> '')
);

create index if not exists affiliate_prospect_sources_program_idx
  on public.affiliate_prospect_sources (company_entity_id, program_id);

alter table public.affiliate_prospect_sources enable row level security;

drop policy if exists affiliate_prospect_sources_select on public.affiliate_prospect_sources;
create policy affiliate_prospect_sources_select on public.affiliate_prospect_sources
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists affiliate_prospect_sources_write on public.affiliate_prospect_sources;
create policy affiliate_prospect_sources_write on public.affiliate_prospect_sources
  for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_programs())
  with check (company_entity_id = public.active_company_id() and public.can_manage_affiliate_programs());

comment on table public.affiliate_prospect_sources is
  'The repeatable discovery inputs for a program: a search query SILO runs against the SERP provider it already uses for SEO, or a manual import lane. last_run_cost records what the run actually cost, so "is native discovery cheap enough" is a measurement and not a claim.';

-- One row per (run, source): what discovery actually returned, how much of it
-- was usable, and what it cost. This is the measurement behind any claim about
-- coverage -- "native discovery works for this brand" is a ratio over these
-- rows, not a sentence in a doc.
create table if not exists public.affiliate_discovery_runs (
  id                  uuid primary key default gen_random_uuid(),
  company_entity_id   uuid not null references public.entities(id) on delete cascade,
  program_id          uuid not null references public.affiliate_programs(id) on delete cascade,
  source_id           uuid references public.affiliate_prospect_sources(id) on delete set null,
  run_id              uuid not null,
  provider            text not null,
  query               text,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  dry_run             boolean not null default false,
  results_returned    integer,
  profiles_recognized integer,
  prospects_new       integer,
  prospects_updated   integer,
  suppressed_skipped  integer,
  emails_found        integer,
  cost_usd            numeric(10,4),
  status              text not null default 'running'
                        check (status in ('running','ok','skipped','error')),
  error               text
);

create index if not exists affiliate_discovery_runs_program_idx
  on public.affiliate_discovery_runs (company_entity_id, program_id, started_at desc);

alter table public.affiliate_discovery_runs enable row level security;

drop policy if exists affiliate_discovery_runs_select on public.affiliate_discovery_runs;
create policy affiliate_discovery_runs_select on public.affiliate_discovery_runs
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- Written only by the discovery job (service role). A hand-written run row
-- would be a fabricated measurement of coverage and cost.
revoke insert, update, delete on public.affiliate_discovery_runs from authenticated, anon;
grant all on public.affiliate_discovery_runs to service_role;

comment on table public.affiliate_discovery_runs is
  'One row per discovery run per source: results the provider returned, how many were recognisable creator profiles, new vs updated prospects, how many were skipped as suppressed, how many carried a publicly stated email, and the provider''s own reported cost. NULL counts mean the run did not get that far. Client-readable, written only by scripts/affiliate-discovery.mjs.';

create table if not exists public.affiliate_prospects (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  program_id        uuid not null references public.affiliate_programs(id) on delete cascade,

  display_name      text,
  platform          text not null default 'web'
                      check (platform in ('instagram','tiktok','youtube','twitch','x','pinterest','blog','web','other')),
  handle            text,
  -- Every URL column is http(s) only: these are shown to staff as links, and
  -- an application form writes them, so a javascript: URL must not be storable.
  profile_url       text check (profile_url is null or profile_url ~* '^\s*https?://\S+\s*$'),

  -- Contact details are only ever what a public page stated, with the URL it
  -- was read from. No inference, no pattern-guessed address: a NULL here is
  -- "not found", which is a legitimate and common answer.
  contact_email     text check (contact_email is null or position('@' in contact_email) > 1),
  contact_source_url text check (contact_source_url is null or contact_source_url ~* '^\s*https?://\S+\s*$'),

  source_id         uuid references public.affiliate_prospect_sources(id) on delete set null,
  source            text not null default 'manual'
                      check (source in ('serp','manual','csv_import','applied')),
  source_url        text check (source_url is null or source_url ~* '^\s*https?://\S+\s*$'),
  collected_at      timestamptz not null default now(),

  -- What was actually observed. Keys are whatever the collector recorded
  -- (title, snippet, domain, result position...). Never a metric SILO did not
  -- read somewhere: there is no follower count in here unless a page stated
  -- one and the observation row says which page.
  evidence          jsonb not null default '{}'::jsonb,

  -- 0..1 with a WRITTEN basis. A score with no basis is a number someone will
  -- later mistake for a measurement, so the basis is NOT NULL whenever the
  -- score is.
  confidence        numeric(4,3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  confidence_basis  text,

  status            text not null default 'new'
                      check (status in ('new','qualified','rejected','approved','invited','signed_up','suppressed')),
  reviewed_by       uuid references public.profiles(id),
  reviewed_at       timestamptz,
  review_note       text,

  affiliate_id      uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references public.profiles(id),
  changed_by        uuid references public.profiles(id),

  constraint affiliate_prospects_confidence_has_basis
    check (confidence is null or btrim(coalesce(confidence_basis,'')) <> ''),
  constraint affiliate_prospects_identifiable
    check (btrim(coalesce(profile_url,'')) <> '' or btrim(coalesce(handle,'')) <> '')
);

-- Identity for de-duplication. A discovery run that finds the same creator on
-- Monday and Thursday must UPDATE the row, not add a second one -- otherwise
-- an operator approves the same person twice and two signup links go out.
-- The key is the profile URL where there is one, folded, and otherwise the
-- platform handle; it is an expression index because neither column alone is
-- always present.
create unique index if not exists affiliate_prospects_identity
  on public.affiliate_prospects (
    company_entity_id, program_id,
    lower(coalesce(nullif(btrim(profile_url), ''), platform || ':' || btrim(handle)))
  );

create index if not exists affiliate_prospects_status_idx
  on public.affiliate_prospects (company_entity_id, program_id, status, collected_at desc);

alter table public.affiliate_prospects enable row level security;

drop policy if exists affiliate_prospects_select on public.affiliate_prospects;
create policy affiliate_prospects_select on public.affiliate_prospects
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists affiliate_prospects_write on public.affiliate_prospects;
create policy affiliate_prospects_write on public.affiliate_prospects
  for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_programs())
  with check (company_entity_id = public.active_company_id() and public.can_manage_affiliate_programs());

comment on table public.affiliate_prospects is
  'A discovered or imported creator SILO might recruit. Every field that did not come from a person carries source_url and collected_at, and the per-collection detail is in affiliate_prospect_observations. confidence is 0..1 and cannot be stored without a written basis (CHECK). contact_email is only ever an address a public page stated -- NULL means not found, never "guess one".';

create table if not exists public.affiliate_prospect_observations (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  prospect_id       uuid not null references public.affiliate_prospects(id) on delete cascade,
  source_id         uuid references public.affiliate_prospect_sources(id) on delete set null,
  collector         text not null,
  source_url        text check (source_url is null or source_url ~* '^\s*https?://\S+\s*$'),
  collected_at      timestamptz not null default now(),
  payload           jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists affiliate_prospect_observations_prospect_idx
  on public.affiliate_prospect_observations (company_entity_id, prospect_id, collected_at desc);

alter table public.affiliate_prospect_observations enable row level security;

drop policy if exists affiliate_prospect_observations_select on public.affiliate_prospect_observations;
create policy affiliate_prospect_observations_select on public.affiliate_prospect_observations
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- Append-only from the client's side: a manager may ADD an observation (a note
-- about where they found someone) but may not rewrite or delete the record of
-- what a collector saw. Provenance that can be edited is not provenance.
drop policy if exists affiliate_prospect_observations_insert on public.affiliate_prospect_observations;
create policy affiliate_prospect_observations_insert on public.affiliate_prospect_observations
  for insert to authenticated
  with check (company_entity_id = public.active_company_id() and public.can_manage_affiliate_programs());

revoke update, delete on public.affiliate_prospect_observations from authenticated;

comment on table public.affiliate_prospect_observations is
  'One row per collection event about a prospect: who collected it, from which URL, when, and the raw payload. Append-only for clients (no UPDATE or DELETE grant) because an editable provenance record is not evidence.';

-- ---------------------------------------------------------------------------
-- 3. Suppression -- the list that outweighs every other decision
-- ---------------------------------------------------------------------------

create table if not exists public.affiliate_suppressions (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  -- Program-wide by default: someone who asked not to be contacted asked the
  -- COMPANY, not one campaign. A program_id may narrow it where a tenant
  -- genuinely runs unrelated brands.
  program_id        uuid references public.affiliate_programs(id) on delete cascade,
  kind              text not null check (kind in ('email','domain','handle','profile_url')),
  value_normalized  text not null check (btrim(value_normalized) <> ''),
  reason            text not null default 'opted_out'
                      check (reason in ('opted_out','bounced','complained','manual','competitor','do_not_contact')),
  note              text,
  source            text,
  created_at        timestamptz not null default now(),
  created_by        uuid references public.profiles(id)
);

-- One row per value per scope. The coalesce makes the company-wide row and a
-- program-scoped row distinct entries rather than silently colliding.
create unique index if not exists affiliate_suppressions_identity
  on public.affiliate_suppressions (
    company_entity_id, coalesce(program_id, '00000000-0000-0000-0000-000000000000'::uuid),
    kind, lower(value_normalized)
  );

alter table public.affiliate_suppressions enable row level security;

drop policy if exists affiliate_suppressions_select on public.affiliate_suppressions;
create policy affiliate_suppressions_select on public.affiliate_suppressions
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- Adding a suppression is not a privileged act -- anyone on the team who
-- learns that someone does not want to be contacted must be able to record it
-- immediately. REMOVING one is: that is how a do-not-contact gets undone.
drop policy if exists affiliate_suppressions_insert on public.affiliate_suppressions;
create policy affiliate_suppressions_insert on public.affiliate_suppressions
  for insert to authenticated
  with check (company_entity_id = public.active_company_id());

drop policy if exists affiliate_suppressions_delete on public.affiliate_suppressions;
create policy affiliate_suppressions_delete on public.affiliate_suppressions
  for delete to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_programs());

revoke update on public.affiliate_suppressions from authenticated;

-- Every writer's value is normalised the same way the contact check reads it.
-- Without this, an opt-out typed as "@Pat " or "https://www.Site.com/" would be
-- stored, shown, and never match -- the worst failure this list can have.
create or replace function public.affiliate_suppressions_normalize()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.value_normalized := public.affiliate_normalize_contact(new.kind, new.value_normalized);
  if new.value_normalized is null then
    raise exception 'affiliate_suppressions: a % to suppress is required', new.kind using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.affiliate_suppressions_normalize() from public, anon, authenticated;

drop trigger if exists affiliate_suppressions_normalize_trg on public.affiliate_suppressions;
create trigger affiliate_suppressions_normalize_trg
  before insert on public.affiliate_suppressions
  for each row execute function public.affiliate_suppressions_normalize();

comment on table public.affiliate_suppressions is
  'Do-not-contact list for affiliate outreach, company-wide unless program_id narrows it. Any member may ADD one (recording an opt-out must never need permission); only can_manage_affiliate_programs() may delete one; nobody may edit one in place. affiliate_outreach_can_contact() checks it, and a suppressed value cannot be approved for outreach (trigger).';

-- email -> domain, handle -> @-less fold, url -> scheme/trailing-slash fold.
-- ONE place the normalisation is written, so the writer and the checker cannot
-- disagree about whether "Me@Example.com " is suppressed.
create or replace function public.affiliate_normalize_contact(p_kind text, p_value text)
returns text
language sql
immutable
as $$
  select case
    when p_value is null or btrim(p_value) = '' then null
    when p_kind = 'email'  then lower(btrim(p_value))
    when p_kind = 'domain' then lower(regexp_replace(btrim(p_value), '^(https?://)?(www\.)?', ''))
    when p_kind = 'handle' then lower(regexp_replace(btrim(p_value), '^@', ''))
    when p_kind = 'profile_url' then
      rtrim(lower(regexp_replace(btrim(p_value), '^(https?://)?(www\.)?', '')), '/')
    else lower(btrim(p_value))
  end;
$$;

comment on function public.affiliate_normalize_contact(text, text) is
  'The one normalisation used by both the suppression writer and the suppression checker. Changing it changes both, which is the point: two copies would disagree about whether a value is suppressed.';

revoke execute on function public.affiliate_normalize_contact(text, text) from public, anon;
grant execute on function public.affiliate_normalize_contact(text, text) to authenticated, service_role;

-- May this company contact this address/handle for this program?
--
-- SECURITY DEFINER with an explicit company argument and a membership
-- re-check: the edge function calls it with the service role (auth.uid() is
-- NULL, which is how resolve_notification_sender handles the same case), and
-- a signed-in caller may only ask about a company they belong to. Without
-- that re-check a granted-to-authenticated definer function taking a company
-- id is an RLS bypass -- the exact shape closed on PR #745.
create or replace function public.affiliate_outreach_can_contact(
  p_company_entity_id uuid,
  p_program_id uuid default null,
  p_email text default null,
  p_handle text default null,
  p_profile_url text default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_email  text := public.affiliate_normalize_contact('email', p_email);
  v_handle text := public.affiliate_normalize_contact('handle', p_handle);
  v_url    text := public.affiliate_normalize_contact('profile_url', p_profile_url);
  v_domain text := case when v_email is null then null
                        else split_part(v_email, '@', 2) end;
begin
  if p_company_entity_id is null then
    return false;
  end if;

  -- A browser session may only ask about its own companies. NULL auth.uid()
  -- is the service role, which is how the outreach export and the portal call
  -- this; narrowing that would break every edge function and protects nothing,
  -- since the service role bypasses RLS anyway.
  if auth.uid() is not null and not exists (
    select 1 from public.entity_memberships m
    where m.entity_id = p_company_entity_id and m.user_id = auth.uid()
  ) then
    raise exception 'affiliate_outreach_can_contact: not a member of company %', p_company_entity_id
      using errcode = '42501';
  end if;

  -- Nothing to check means nothing was supplied, and "no recipient" is not
  -- permission to contact.
  if v_email is null and v_handle is null and v_url is null then
    return false;
  end if;

  return not exists (
    select 1
    from public.affiliate_suppressions s
    where s.company_entity_id = p_company_entity_id
      -- A company-wide suppression (program_id IS NULL) applies to every
      -- program. A program-scoped one applies only to that program.
      and (s.program_id is null or s.program_id = p_program_id)
      and (
        (s.kind = 'email'       and v_email  is not null and lower(s.value_normalized) = v_email)
     or (s.kind = 'domain'      and v_domain is not null and lower(s.value_normalized) = v_domain)
     or (s.kind = 'handle'      and v_handle is not null and lower(s.value_normalized) = v_handle)
     or (s.kind = 'profile_url' and v_url    is not null and lower(s.value_normalized) = v_url)
      )
  );
end;
$$;

comment on function public.affiliate_outreach_can_contact(uuid, uuid, text, text, text) is
  'False when any of the supplied identifiers (or the email''s domain) is suppressed for this company and program, and false when NOTHING identifiable was supplied -- "no recipient" is not permission to contact. A signed-in caller may only ask about a company they belong to; the service role (auth.uid() NULL) may ask about any, as every mail-side function does.';

revoke execute on function public.affiliate_outreach_can_contact(uuid, uuid, text, text, text) from public, anon;
grant execute on function public.affiliate_outreach_can_contact(uuid, uuid, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Affiliates -- the partner record
-- ---------------------------------------------------------------------------

create table if not exists public.affiliates (
  id                 uuid primary key default gen_random_uuid(),
  company_entity_id  uuid not null references public.entities(id) on delete cascade,
  program_id         uuid not null references public.affiliate_programs(id) on delete cascade,

  display_name       text not null check (btrim(display_name) <> ''),
  contact_email      text not null check (position('@' in contact_email) > 1),
  contact_name       text,
  platform           text,
  handle             text,
  profile_url        text check (profile_url is null or profile_url ~* '^\s*https?://\S+\s*$'),

  -- invited        -- a signup link exists and has not been used
  -- pending_terms  -- opened the link, has not accepted the terms
  -- active         -- accepted the current terms; codes and links may earn
  -- paused         -- earns nothing new, keeps its history
  -- terminated     -- ended; history retained for the ledger
  status             text not null default 'invited'
                       check (status in ('invited','pending_terms','active','paused','terminated')),

  -- Terms acceptance is a fact about a VERSION. A program that revises its
  -- terms leaves every affiliate on the version they actually accepted, which
  -- is the only version anyone could hold them to.
  terms_version_accepted integer check (terms_version_accepted >= 1),
  terms_accepted_at      timestamptz,
  terms_acceptance        jsonb,

  -- Per-affiliate override of the program rate. NULL means "use the program".
  commission_kind        text check (commission_kind in ('percent_of_net','fixed_per_order')),
  commission_percent     numeric(6,3) check (commission_percent >= 0 and commission_percent <= 100),
  commission_fixed_cents integer check (commission_fixed_cents >= 0),

  from_prospect_id   uuid references public.affiliate_prospects(id) on delete set null,
  applied_at         timestamptz,
  approved_by        uuid references public.profiles(id),
  approved_at        timestamptz,
  note               text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references public.profiles(id),
  changed_by         uuid references public.profiles(id),

  -- An override must be complete or absent: a kind with no number silently
  -- falls back to the program's number of the WRONG kind.
  constraint affiliates_override_complete check (
    commission_kind is null
    or (commission_kind = 'percent_of_net'   and commission_percent is not null)
    or (commission_kind = 'fixed_per_order'  and commission_fixed_cents is not null)
  ),
  -- Accepted terms and the version accepted travel together.
  constraint affiliates_acceptance_complete check (
    (terms_accepted_at is null) = (terms_version_accepted is null)
  ),
  -- 'active' is the one status that earns, and it cannot be reached without
  -- an acceptance on record. This is a column-level invariant rather than a
  -- rule in the portal, because the portal is not the only writer.
  constraint affiliates_active_requires_terms check (
    status <> 'active' or terms_accepted_at is not null
  )
);

create unique index if not exists affiliates_identity
  on public.affiliates (company_entity_id, program_id, lower(btrim(contact_email)));

create index if not exists affiliates_status_idx
  on public.affiliates (company_entity_id, program_id, status);

alter table public.affiliates enable row level security;

drop policy if exists affiliates_select on public.affiliates;
create policy affiliates_select on public.affiliates
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists affiliates_write on public.affiliates;
create policy affiliates_write on public.affiliates
  for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_programs())
  with check (company_entity_id = public.active_company_id() and public.can_manage_affiliate_programs());

comment on table public.affiliates is
  'A recruited partner. status active is the only state that earns, and a CHECK makes it unreachable without a recorded terms acceptance. terms_version_accepted pins the version they actually accepted, so revising a program''s terms never retroactively rewrites what anyone agreed to. A per-affiliate commission override must be complete (kind + number) or absent. Read: any member. Write: can_manage_affiliate_programs(); the portal writes acceptance through the service role.';

-- The affiliate an outreach/prospect row became. Added after affiliates so
-- the reference can exist in both directions without a circular create.
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'affiliate_prospects_affiliate_fk'
  ) then
    alter table public.affiliate_prospects
      add constraint affiliate_prospects_affiliate_fk
      foreign key (affiliate_id) references public.affiliates(id) on delete set null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Access tokens -- how an affiliate gets in without a SILO login
-- ---------------------------------------------------------------------------
--
-- Same model as the public review portal (review_access_tokens): the token IS
-- the authorization, only its SHA-256 is stored, and it maps to exactly one
-- affiliate or prospect. An affiliate is never given a SILO account and never
-- becomes a workspace member -- that would put a third party inside the
-- tenant's workspace.

create table if not exists public.affiliate_access_tokens (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  program_id        uuid not null references public.affiliate_programs(id) on delete cascade,
  affiliate_id      uuid references public.affiliates(id) on delete cascade,
  prospect_id       uuid references public.affiliate_prospects(id) on delete cascade,
  purpose           text not null check (purpose in ('signup','portal')),
  token_hash        text not null,
  created_at        timestamptz not null default now(),
  created_by        uuid references public.profiles(id),
  -- NOT NULL on purpose. A nullable expiry read as "or expires_at is null" is
  -- a permanent grant one missing value away; this module refuses to have one.
  expires_at        timestamptz not null,
  first_used_at     timestamptz,
  last_used_at      timestamptz,
  used_count        integer not null default 0 check (used_count >= 0),
  revoked_at        timestamptz,
  revoked_by        uuid references public.profiles(id),
  constraint affiliate_access_tokens_subject
    check (affiliate_id is not null or prospect_id is not null)
);

create unique index if not exists affiliate_access_tokens_hash
  on public.affiliate_access_tokens (token_hash);

create index if not exists affiliate_access_tokens_subject_idx
  on public.affiliate_access_tokens (company_entity_id, affiliate_id, purpose);

alter table public.affiliate_access_tokens enable row level security;

-- NO client policy of any kind, and no client grants. A token hash is a
-- credential: a manager needs to know a link was issued and whether it has
-- been used, which is what affiliate_access_token_state_v exposes -- the hash
-- itself is never readable by a browser.
revoke all on public.affiliate_access_tokens from anon, authenticated;
grant all on public.affiliate_access_tokens to service_role;

comment on table public.affiliate_access_tokens is
  'SHA-256 hashes of affiliate signup and portal links. No client role has any privilege on this table: the browser reads affiliate_access_token_state_v instead, which shows that a link exists, when it expires and whether it has been used, and never the hash. expires_at is NOT NULL because a nullable expiry read permissively is a permanent grant.';

-- What a manager may see about a link: that it exists, its purpose, when it
-- expires, whether it has been used -- never the hash.
--
-- security_invoker = false is deliberate and is the ONLY way this view can
-- exist, because the base table grants `authenticated` nothing at all. The
-- rule that comes with a definer wrapper (supabase/CLAUDE.md) is honoured
-- literally: it filters company_entity_id = active_company_id() itself, and
-- it exposes only the columns named below.
create or replace view public.affiliate_access_token_state_v
  with (security_invoker = false) as
select
  t.id,
  t.company_entity_id,
  t.program_id,
  t.affiliate_id,
  t.prospect_id,
  t.purpose,
  t.created_at,
  t.expires_at,
  t.first_used_at,
  t.last_used_at,
  t.used_count,
  t.revoked_at,
  (t.revoked_at is null and t.expires_at > now()) as is_live
from public.affiliate_access_tokens t
where t.company_entity_id = public.active_company_id();

comment on view public.affiliate_access_token_state_v is
  'Definer wrapper over affiliate_access_tokens, which no client role may read. Carries its own company_entity_id = active_company_id() filter (the tenant boundary for this view) and deliberately omits token_hash. Columns are an allowlist, not select *.';

revoke all on public.affiliate_access_token_state_v from anon;
grant select on public.affiliate_access_token_state_v to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Codes and links -- what an affiliate is actually tracked by
-- ---------------------------------------------------------------------------

create table if not exists public.affiliate_codes (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  program_id        uuid not null references public.affiliate_programs(id) on delete cascade,
  affiliate_id      uuid not null references public.affiliates(id) on delete cascade,

  -- Folded to upper case by a trigger, because Shopify matches a code
  -- case-insensitively: `team50` and `TEAM50` are one code, and storing both
  -- would let two affiliates claim the same orders.
  code              text not null check (btrim(code) <> ''),

  -- The window the code earns for this affiliate. starts_on NOT NULL because
  -- "since forever" would hand an affiliate every historical order that ever
  -- used a code the merchant had already been running. ends_on NULL means
  -- open-ended.
  starts_on         date not null,
  ends_on           date,
  status            text not null default 'active' check (status in ('active','retired')),
  source            text not null default 'shopify_discount_code'
                      check (source in ('shopify_discount_code','manual')),

  -- Set by the resolver the first time SILO sees this code on a real order.
  -- SILO has no Shopify write scope and cannot create or confirm a code in the
  -- merchant's admin, so this is the only available evidence that the code
  -- exists at all -- and a code with a NULL here is "never seen", not "wrong".
  verified_at       timestamptz,
  first_seen_order_id text,

  note              text,
  created_at        timestamptz not null default now(),
  created_by        uuid references public.profiles(id),
  changed_by        uuid references public.profiles(id),
  constraint affiliate_codes_window check (ends_on is null or ends_on >= starts_on)
);

create index if not exists affiliate_codes_lookup_idx
  on public.affiliate_codes (company_entity_id, code, starts_on);

create index if not exists affiliate_codes_affiliate_idx
  on public.affiliate_codes (company_entity_id, affiliate_id);

alter table public.affiliate_codes enable row level security;

drop policy if exists affiliate_codes_select on public.affiliate_codes;
create policy affiliate_codes_select on public.affiliate_codes
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists affiliate_codes_write on public.affiliate_codes;
create policy affiliate_codes_write on public.affiliate_codes
  for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_programs())
  with check (company_entity_id = public.active_company_id() and public.can_manage_affiliate_programs());

comment on table public.affiliate_codes is
  'Which existing Shopify discount code earns for which affiliate, and between which dates. SILO never creates a code (its Shopify scopes are read-only): verified_at is stamped the first time the resolver sees the code on a real order, and NULL means never seen rather than invalid. Code text is folded to upper case by trigger because Shopify matches case-insensitively.';

-- Fold the code, and refuse a second owner for the same code over the same
-- dates. Two affiliates whose windows overlap on one code is not a data-entry
-- detail: it is two people being paid for the same orders, and no downstream
-- query can repair it. A trigger rather than an exclusion constraint so the
-- rule holds without btree_gist and can be tested on any Postgres.
create or replace function public.affiliate_codes_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.code := upper(btrim(new.code));
  if new.code = '' then
    raise exception 'affiliate_codes: code cannot be blank';
  end if;

  -- Retired rows keep their history but no longer reserve the window.
  if new.status = 'active' and exists (
    select 1 from public.affiliate_codes c
    where c.company_entity_id = new.company_entity_id
      and c.code = new.code
      and c.status = 'active'
      and c.id is distinct from new.id
      and c.affiliate_id is distinct from new.affiliate_id
      -- Half-open overlap: [starts_on, ends_on] inclusive on both ends,
      -- treating a NULL ends_on as open to the far future.
      and daterange(c.starts_on, coalesce(c.ends_on, 'infinity'::date), '[]')
          && daterange(new.starts_on, coalesce(new.ends_on, 'infinity'::date), '[]')
  ) then
    raise exception
      'affiliate_codes: % is already assigned to another affiliate over an overlapping date range', new.code
      using errcode = '23505';
  end if;

  return new;
end;
$$;

drop trigger if exists affiliate_codes_guard_trg on public.affiliate_codes;
create trigger affiliate_codes_guard_trg
  before insert or update on public.affiliate_codes
  for each row execute function public.affiliate_codes_guard();

revoke execute on function public.affiliate_codes_guard() from public, anon, authenticated;

create table if not exists public.affiliate_links (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  program_id        uuid not null references public.affiliate_programs(id) on delete cascade,
  affiliate_id      uuid not null references public.affiliates(id) on delete cascade,
  slug              text not null check (slug ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{2,62}$'),
  destination_url   text not null check (destination_url ~* '^https://'),
  utm_source        text,
  utm_medium        text,
  utm_campaign      text,
  starts_on         date not null,
  ends_on           date,
  status            text not null default 'active' check (status in ('active','retired')),
  created_at        timestamptz not null default now(),
  created_by        uuid references public.profiles(id),
  constraint affiliate_links_window check (ends_on is null or ends_on >= starts_on)
);

create unique index if not exists affiliate_links_slug_identity
  on public.affiliate_links (company_entity_id, lower(slug));

alter table public.affiliate_links enable row level security;

drop policy if exists affiliate_links_select on public.affiliate_links;
create policy affiliate_links_select on public.affiliate_links
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists affiliate_links_write on public.affiliate_links;
create policy affiliate_links_write on public.affiliate_links
  for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_programs())
  with check (company_entity_id = public.active_company_id() and public.can_manage_affiliate_programs());

comment on table public.affiliate_links is
  'A trackable destination for an affiliate: an https destination plus the UTM triple the affiliate should send traffic with. SILO does not host a redirector in this release, so a link is the string the affiliate is given and the UTM values the existing attribution journey already reads -- it is NOT a click counter. Nothing in the commission ledger is computed from a link.';

-- ---------------------------------------------------------------------------
-- 7. Outreach -- drafted, approved, exported, sent (four separate facts)
-- ---------------------------------------------------------------------------

create table if not exists public.affiliate_outreach_batches (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  program_id        uuid not null references public.affiliate_programs(id) on delete cascade,
  channel           text not null default 'email' check (channel in ('email','dm','other')),
  note              text,
  row_count         integer not null default 0 check (row_count >= 0),
  exported_at       timestamptz,
  exported_by       uuid references public.profiles(id),
  -- sha-256 of the exported rows, so "is this spreadsheet the batch SILO
  -- produced" is answerable later.
  fingerprint       text,
  created_at        timestamptz not null default now(),
  created_by        uuid references public.profiles(id)
);

create index if not exists affiliate_outreach_batches_program_idx
  on public.affiliate_outreach_batches (company_entity_id, program_id, created_at desc);

alter table public.affiliate_outreach_batches enable row level security;

drop policy if exists affiliate_outreach_batches_select on public.affiliate_outreach_batches;
create policy affiliate_outreach_batches_select on public.affiliate_outreach_batches
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists affiliate_outreach_batches_write on public.affiliate_outreach_batches;
create policy affiliate_outreach_batches_write on public.affiliate_outreach_batches
  for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_programs())
  with check (company_entity_id = public.active_company_id() and public.can_manage_affiliate_programs());

create table if not exists public.affiliate_outreach_drafts (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  program_id        uuid not null references public.affiliate_programs(id) on delete cascade,
  prospect_id       uuid not null references public.affiliate_prospects(id) on delete cascade,

  channel           text not null default 'email' check (channel in ('email','dm','other')),
  recipient_email   text,
  recipient_handle  text,
  subject           text,
  body              text,

  -- draft -> approved -> exported -> sent, plus the three terminal outcomes a
  -- human records. These are SEPARATE states, not one "sent" flag, because
  -- SILO can prove the first three and can never prove the fourth.
  state             text not null default 'draft'
                      check (state in ('draft','approved','exported','sent','replied','declined','bounced','signed_up')),

  approved_by       uuid references public.profiles(id),
  approved_at       timestamptz,
  batch_id          uuid references public.affiliate_outreach_batches(id) on delete set null,
  exported_at       timestamptz,
  -- Who says it was sent, and what they are citing. SILO did not send it.
  sent_marked_by    uuid references public.profiles(id),
  sent_marked_at    timestamptz,
  sent_evidence     text,
  outcome_note      text,

  -- The signup link offered in this message. The token row holds the hash;
  -- this is only the reference, so revoking the token kills the link.
  token_id          uuid references public.affiliate_access_tokens(id) on delete set null,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references public.profiles(id),
  changed_by        uuid references public.profiles(id),

  constraint affiliate_outreach_drafts_recipient check (
    btrim(coalesce(recipient_email,'')) <> '' or btrim(coalesce(recipient_handle,'')) <> ''
  ),
  constraint affiliate_outreach_drafts_approval_complete check (
    (approved_at is null) = (approved_by is null)
  ),
  -- The whole point of the four states: a message cannot be recorded as sent
  -- without a named person and a citation. A column default or a UI rule
  -- would be bypassed by the next writer; this cannot be.
  constraint affiliate_outreach_drafts_sent_has_evidence check (
    state not in ('sent','replied','declined','bounced')
    or (sent_marked_by is not null and sent_marked_at is not null
        and btrim(coalesce(sent_evidence,'')) <> '')
  ),
  constraint affiliate_outreach_drafts_exported_has_batch check (
    state <> 'exported' or (batch_id is not null and exported_at is not null)
  )
);

create unique index if not exists affiliate_outreach_drafts_one_live_per_prospect
  on public.affiliate_outreach_drafts (company_entity_id, prospect_id)
  where state in ('draft','approved','exported');

create index if not exists affiliate_outreach_drafts_state_idx
  on public.affiliate_outreach_drafts (company_entity_id, program_id, state, created_at desc);

alter table public.affiliate_outreach_drafts enable row level security;

drop policy if exists affiliate_outreach_drafts_select on public.affiliate_outreach_drafts;
create policy affiliate_outreach_drafts_select on public.affiliate_outreach_drafts
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists affiliate_outreach_drafts_write on public.affiliate_outreach_drafts;
create policy affiliate_outreach_drafts_write on public.affiliate_outreach_drafts
  for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_programs())
  with check (company_entity_id = public.active_company_id() and public.can_manage_affiliate_programs());

comment on table public.affiliate_outreach_drafts is
  'One live outreach message per prospect (partial unique index on the three live states). approved, exported and sent are separate facts with separate actors: SILO can prove approval and export, and cannot prove a send it did not make -- so sent/replied/declined/bounced all require a named marker and written evidence (CHECK). Nothing here is ever delivered by SILO.';

-- A draft may not be APPROVED for a recipient on the suppression list, and
-- may not be approved against a program that is not open for recruiting. Both
-- are checked at the moment of approval rather than at draft time: a draft is
-- a document, an approval is a decision to contact a person.
create or replace function public.affiliate_outreach_drafts_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prospect record;
begin
  if new.state in ('approved','exported','sent','replied','declined','bounced','signed_up')
     and (tg_op = 'INSERT' or old.state = 'draft' or old.state is distinct from new.state)
  then
    if not public.affiliate_outreach_can_contact(
         new.company_entity_id, new.program_id,
         new.recipient_email, new.recipient_handle, null)
    then
      raise exception 'affiliate_outreach_drafts: this recipient is on the suppression list for this program'
        using errcode = '42501';
    end if;
  end if;

  if new.state in ('approved','exported') then
    select p.status into v_prospect
      from public.affiliate_prospects p
     where p.id = new.prospect_id and p.company_entity_id = new.company_entity_id;
    if v_prospect.status = 'suppressed' then
      raise exception 'affiliate_outreach_drafts: the prospect is suppressed'
        using errcode = '42501';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists affiliate_outreach_drafts_guard_trg on public.affiliate_outreach_drafts;
create trigger affiliate_outreach_drafts_guard_trg
  before insert or update on public.affiliate_outreach_drafts
  for each row execute function public.affiliate_outreach_drafts_guard();

revoke execute on function public.affiliate_outreach_drafts_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. sync_jobs learns the discovery job type
-- ---------------------------------------------------------------------------
-- Appended to the LIVE constraint rather than restated, the same way
-- 20261109040000 added 'klaviyo': production's list has grown by hand, and a
-- restated list would silently drop whatever this file does not know about.
do $$
declare
  cur text;
  members text;
begin
  if to_regclass('public.sync_jobs') is null then
    return;
  end if;
  select pg_get_constraintdef(oid) into cur
  from pg_constraint
  where conname = 'sync_jobs_job_type_check'
    and conrelid = 'public.sync_jobs'::regclass;

  if cur is null then
    raise exception 'sync_jobs_job_type_check not found; read the live job_type constraint before adding affiliate_discovery';
  end if;
  if cur ~ '''affiliate_discovery''' then
    return;
  end if;

  members := substring(cur from 'ARRAY\[(.*?)\]');
  if members is null or members = '' then
    raise exception 'sync_jobs_job_type_check has an unexpected shape (%); extend it by hand after reading it', cur;
  end if;

  execute 'alter table public.sync_jobs drop constraint sync_jobs_job_type_check';
  execute format(
    'alter table public.sync_jobs add constraint sync_jobs_job_type_check check (job_type = any (array[%s, %L::text]))',
    members, 'affiliate_discovery'
  );
end $$;

-- ---------------------------------------------------------------------------
-- 9. Stamps and the chat catalog
-- ---------------------------------------------------------------------------

-- Nothing in this module is for the anon role: affiliates reach it only
-- through the affiliate-portal function (service role), never PostgREST.
-- Supabase's default privileges grant anon every table in public, and the
-- row policies (all "to authenticated") are then the only thing keeping anon
-- out. Take the grant away too, so a future policy written without "to
-- authenticated" cannot open a table to the internet.
do $$
declare r record;
begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r','v') and (c.relname = 'affiliates' or c.relname like 'affiliate\_%')
  loop
    execute format('revoke all on public.%I from anon', r.relname);
  end loop;
end $$;

select public.attach_stamp_company_entity_id_triggers();

do $$ begin
  if to_regprocedure('public.refresh_chat_schema_catalog()') is not null then
    perform public.refresh_chat_schema_catalog();
  end if;
end $$;
