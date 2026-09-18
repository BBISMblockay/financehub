-- =============================================================================
-- Guided company onboarding: founding a NEW tenant, invite-controlled.
--
-- Inviting someone into Test Company exercises JOINING an existing tenant.
-- Nothing until now exercised STARTING one from zero except the login page's
-- "Create account" box, and that path is the reason this migration leads with a
-- revocation rather than a feature.
--
-- ── 1. WHY handle_new_user LOSES ITS org_name BRANCH ─────────────────────────
--
-- 20260714190000 taught handle_new_user to provision an entire organization --
-- entities row, `owner` profile, `owner_admin` membership, active_company_id --
-- from a single `org_name` key in the signup's auth metadata. `pages/login.html`
-- is the intended caller, but it is not the only possible one: `signUp` is a
-- public Supabase Auth endpoint and the anon key ships in `pages/config.js` by
-- design, so ANY caller could post
--
--     { email, password, data: { org_name: 'anything' } }
--
-- and be an `owner` of a brand-new SILO tenant. That is the door this PR was
-- asked to make invite-controlled, so removing the org-name field from the
-- signup form would have been theatre: the form is not the boundary, this
-- trigger is. The branch is deleted here, and founding now runs through
-- `redeem_platform_invite` below, which requires a token Blake minted.
--
-- A signup with no invite therefore lands exactly where an invited teammate's
-- does: a bare profile, is_active defaulting as it always has, no membership,
-- no company. `active_company_id()` returns NULL for that profile and every
-- company-scoped RLS policy reads `company_entity_id = active_company_id()`,
-- so such an account sees nothing at all until somebody authorizes it. That is
-- the pre-existing behaviour for the invited path, not new surface.
--
-- ── 2. WHY A SEPARATE platform_admins TABLE ─────────────────────────────────
--
-- The obvious gate is "an owner_admin may mint a create-company invite". It is
-- the wrong one here: 34 of Baseballism's profiles are membership 'admin' and
-- the owner_admin set is not a list of people who should be able to found
-- further tenants on this project's Anthropic key and Supabase quota. Founding
-- is a PLATFORM act, not a company one, and the two need different lists --
-- the same reasoning that gave `silo_chat_managers` its own table rather than
-- widening `profiles.role` (promoting someone to `executive` to let them teach
-- Ask SILO also hands them review templates and the whole roster).
--
-- Seeded with blake@baseballism.com and nobody else. Adding a row is a
-- deliberate act, and there is no RPC that adds one -- it is a migration or a
-- service-role write, so a compromised browser session cannot grant it.
--
-- ── 3. WHY THE REDEEM IS IDEMPOTENT RATHER THAN MERELY ATOMIC ───────────────
--
-- Atomic is free: one SECURITY DEFINER function, one transaction, entity +
-- profile + membership + settings all commit or none do. The failure that
-- atomicity does NOT cover is the one that actually happens -- the browser
-- sends the redeem, the row commits, and the RESPONSE is lost (a dropped
-- connection, a closed laptop, a reloaded tab). The user presses the button
-- again. With a plain "create", they now own two companies with the same name
-- and land in whichever the picker sorts first, having been told nothing.
--
-- So the invite records `created_company_id` when it is consumed, and a redeem
-- of an already-accepted invite BY THE SAME USER returns that company with
-- `repeated = true` instead of raising or creating a second one. A redeem of
-- someone else's accepted invite is still refused. The token is the idempotency
-- key, which is what makes the retry safe by construction rather than by the
-- caller remembering to check first.
--
-- TWO SIMULTANEOUS redeems of one token are handled by the same mechanism plus
-- `select ... for update` on the invite row: the second waits, and under READ
-- COMMITTED re-evaluates its qualification against the row the first COMMITTED
-- -- which now reads `accepted` -- so it takes the idempotent branch and
-- returns the company the first one made. Not covered by the regression suite,
-- which is single-connection (PGlite); it is a property of the lock and the
-- isolation level, recorded here rather than claimed as tested.
--
-- ── 4. WHY TIMEZONE IS REFUSED RATHER THAN STORED AND IGNORED ───────────────
--
-- `silo_business_today()` / `_yesterday()` are taught below to read the
-- company's own timezone instead of the hardcoded Pacific literal they carried
-- since 20260904280000. That covers the report anchors routed through them, and
-- it is genuinely the majority of what a person reads as "a day".
--
-- It is NOT everything. Measured on production on 2026-09-18: 10 further
-- functions in the public schema still embed 'America/Los_Angeles' in their own
-- bodies, and 7 files under scripts/ and v2/ do the same, including the Shopify
-- sync core and the sales-freshness check. `shopify-sync.yml`'s cron is pinned
-- to a UTC hour chosen because it falls after Pacific midnight.
--
-- Accepting an Eastern timezone here would store a setting that those 17 sites
-- do not honour, and a stored-but-ignored setting is worse than a refused one:
-- it reads as configured. Every report the new tenant opened would anchor to
-- Pacific while their settings page said otherwise, and the discrepancy would
-- surface as numbers that are wrong for three hours a day rather than as an
-- error anybody could act on.
--
-- So `redeem_platform_invite` refuses a non-Pacific timezone AND NAMES WHY.
-- The allowlist is a table (`supported_business_timezones`) rather than a CHECK
-- constraint precisely so that finishing the sweep is an INSERT plus a test,
-- not a migration that has to re-derive which sites were fixed.
--
-- ── 5. WHY CURRENCY IS NOT WRITTEN TO accounting_settings ───────────────────
--
-- `accounting_settings.base_currency` looks like the obvious home and is the
-- wrong one, for two independent reasons found by reading the column rather
-- than its name. First, `accounting_settings.qbo_connection_id` is NOT NULL --
-- the row cannot exist before a QuickBooks realm is connected, which at
-- onboarding is hours or weeks away. Second, and more important:
-- `seed_accounting_opening_balances` DERIVES `base_currency` from the currency
-- on QuickBooks' own trial-balance report. It is a MEASURED fact about a
-- connected realm, not a preference somebody picked.
--
-- What onboarding collects is a different fact: the currency this company
-- intends to report in, declared before any books exist. Storing both is
-- correct; letting them silently disagree is not, and that is exactly the
-- two-definitions-of-one-number failure this codebase keeps recording (three
-- Marketing pages, the Accounting Export tie-out). So the books-seed path gets
-- a guard: if a company has declared a currency and QuickBooks reports a
-- different one, seeding RAISES and names both values, rather than quietly
-- leaving the company's settings page saying one thing and its ledger another.
--
-- ── 6. create_entity_with_owner IS DROPPED ──────────────────────────────────
--
-- It is the closest thing to a pre-existing company-creation RPC and leaving it
-- beside the new one would be a second definition of founding a tenant. It also
-- does not work. Measured on production, 2026-09-18, called as an authenticated
-- Test Company user with a probe entity key:
--
--     FAILED 23514 :: new row for relation "entity_memberships"
--                     violates check constraint "entity_memberships_role_check"
--
-- It inserts membership role 'owner'; the CHECK has allowed only
-- ('owner_admin','admin','member','viewer') since the multi-tenant work. Every
-- call raises, and the raise rolls back the `entities` insert with it, so it
-- has been incapable of creating anything for as long as that constraint has
-- existed. It additionally holds EXECUTE for `anon` -- 20260625150000 revoked
-- that, and a later `create or replace` silently restored it from Supabase's
-- schema default, the same mechanism documented at length in 20260917210000.
-- It is refused for anon by its own `auth.uid() is null` guard, so this is
-- drift to remove rather than an open hole, and its allowlist entry in
-- verify_v2_schema.sql goes with it.
--
-- Note 20260625150000 and 20260625160000 REVOKE/ALTER this function by name and
-- would error on a literal replay after this drop. That is not the documented
-- rebuild path -- `apply_all_post_merge.sql` does not carry either statement
-- (checked: it mentions the function only in a comment) -- and both files have
-- long been applied.
-- =============================================================================

-- ── Supported business timezones ────────────────────────────────────────────
-- One row per timezone SILO's day-boundary logic actually honours end to end.
-- Deliberately a table: the Pacific sweep finishes by inserting rows here after
-- the remaining 17 sites are fixed, and the onboarding page reads this list, so
-- the UI cannot drift from what the RPC will accept.

create table if not exists public.supported_business_timezones (
  tz_name      text primary key,
  label        text not null,
  is_supported boolean not null default true,
  note         text,
  created_at   timestamptz not null default now()
);

comment on table public.supported_business_timezones is
  'Timezones SILO honours for day boundaries end to end. A timezone absent from this table (or present with is_supported = false) is REFUSED at company creation rather than stored and ignored -- see the header of 20260918120000. Finishing the Pacific sweep means inserting rows here, not editing a CHECK.';

insert into public.supported_business_timezones (tz_name, label, is_supported, note)
values ('America/Los_Angeles', 'Pacific Time (US & Canada)', true,
        'The only timezone honoured by every day-boundary site as of 2026-09-18.')
on conflict (tz_name) do nothing;

alter table public.supported_business_timezones enable row level security;

drop policy if exists supported_timezones_select on public.supported_business_timezones;
create policy supported_timezones_select on public.supported_business_timezones
  for select to authenticated using (true);

-- No write policy and no write grant. This is configuration that describes what
-- the CODE supports; a browser session changing it would not make the code
-- support anything.
revoke insert, update, delete on public.supported_business_timezones from authenticated, anon;

-- ── Company settings ────────────────────────────────────────────────────────

-- Membership-level owner_admin for the caller's ACTIVE company. profiles.role
-- is the legacy global role and says nothing about which company you own, so
-- is_admin_user() is not the right gate for editing a company's own settings.
create or replace function public.is_owner_admin_of_active_company()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.entity_memberships em
    where em.user_id = auth.uid()
      and em.entity_id = public.active_company_id()
      and em.role = 'owner_admin'
  );
$$;

revoke execute on function public.is_owner_admin_of_active_company() from public, anon;
grant execute on function public.is_owner_admin_of_active_company() to authenticated;


create table if not exists public.company_settings (
  company_entity_id uuid primary key references public.entities(id) on delete cascade,
  business_timezone text not null references public.supported_business_timezones(tz_name),
  default_currency  text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint company_settings_currency_shape check (default_currency ~ '^[A-Z]{3}$')
);

comment on table public.company_settings is
  'Per-company operating settings established at onboarding. business_timezone is what silo_business_today()/_yesterday() anchor to. default_currency is the currency the company DECLARES it reports in -- distinct from accounting_settings.base_currency, which is measured from a connected QuickBooks realm''s trial balance and cannot exist before that realm does. The two are reconciled at books-seed time, not merged.';

comment on column public.company_settings.default_currency is
  'Declared reporting currency, chosen at company creation. seed_accounting_opening_balances raises if QuickBooks later reports a different currency, rather than letting the settings page and the ledger disagree.';

alter table public.company_settings enable row level security;

drop policy if exists company_settings_select on public.company_settings;
create policy company_settings_select on public.company_settings
  for select to authenticated
  using (company_entity_id = public.active_company_id());

drop policy if exists company_settings_update on public.company_settings;
create policy company_settings_update on public.company_settings
  for update to authenticated
  using (company_entity_id = public.active_company_id() and public.is_owner_admin_of_active_company())
  with check (company_entity_id = public.active_company_id() and public.is_owner_admin_of_active_company());

-- INSERT and DELETE are deliberately absent: the row is created by
-- redeem_platform_invite alongside the company itself, and a company without
-- settings has no day boundary, so deleting one is never a thing to offer.
revoke insert, delete on public.company_settings from authenticated, anon;
grant select, update on public.company_settings to authenticated;


create or replace function public.touch_company_settings()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;

drop trigger if exists trg_touch_company_settings on public.company_settings;
create trigger trg_touch_company_settings before update on public.company_settings
  for each row execute function public.touch_company_settings();

-- ── Platform admins: who may authorize a NEW company ────────────────────────

create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  note       text,
  created_at timestamptz not null default now()
);

comment on table public.platform_admins is
  'Who may mint an invite that founds a NEW company. Deliberately not "any owner_admin": founding is a platform act that spends this project''s Supabase and Anthropic quota, and the owner_admin set is not a list of people who should be able to do that. No RPC adds a row -- it is a migration or a service-role write -- so a compromised browser session cannot grant it. Same separation-of-lists reasoning as silo_chat_managers.';

alter table public.platform_admins enable row level security;

drop policy if exists platform_admins_select_self on public.platform_admins;
create policy platform_admins_select_self on public.platform_admins
  for select to authenticated using (user_id = auth.uid());

revoke insert, update, delete on public.platform_admins from authenticated, anon;

insert into public.platform_admins (user_id, note)
select p.id, 'Seeded with 20260918120000.'
from public.profiles p
where lower(p.email) = 'blake@baseballism.com'
on conflict (user_id) do nothing;

create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid());
$$;

revoke execute on function public.is_platform_admin() from public, anon;
grant execute on function public.is_platform_admin() to authenticated;

-- ── Platform invites ────────────────────────────────────────────────────────
-- Shaped after org_invites on purpose: sha256-hashed token, email-bound,
-- 14-day expiry, RLS deny-all with RPC-only access. The difference is what
-- redeeming one DOES -- org_invites add you to an existing company, these
-- create one.

create table if not exists public.platform_invites (
  id                 uuid primary key default gen_random_uuid(),
  email              text not null,
  suggested_company  text,
  token_hash         text not null unique,
  status             text not null default 'pending'
                     check (status in ('pending', 'accepted', 'revoked', 'expired')),
  invited_by         uuid references auth.users(id),
  accepted_by        uuid references auth.users(id),
  created_company_id uuid references public.entities(id) on delete set null,
  expires_at         timestamptz not null default (now() + interval '14 days'),
  created_at         timestamptz not null default now(),
  accepted_at        timestamptz
);

comment on table public.platform_invites is
  'Tokens that authorize founding a NEW company. RLS deny-all, reachable only through the RPCs below. created_company_id is what makes redemption idempotent: a repeated redeem of an accepted invite by the same user returns the company it already made instead of making a second one -- see the header of 20260918120000.';

comment on column public.platform_invites.created_company_id is
  'The company this invite produced. Set in the same transaction that creates it, so a lost HTTP response cannot result in two companies for one invite.';

create index if not exists platform_invites_email_idx
  on public.platform_invites (lower(email), status);

alter table public.platform_invites enable row level security;

-- Deny-all: no policy at all, plus no grant. Every read and write goes through
-- the SECURITY DEFINER RPCs, exactly as org_invites does.
revoke all on public.platform_invites from authenticated, anon;

-- ── create_platform_invite ──────────────────────────────────────────────────

create or replace function public.create_platform_invite(p_email text, p_company_name text default null)
returns json language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_email  text;
  v_token  text;
  v_invite public.platform_invites%rowtype;
begin
  if not public.is_platform_admin() then
    raise exception 'not authorized';
  end if;

  v_email := lower(trim(coalesce(p_email, '')));
  if v_email = '' or position('@' in v_email) = 0 then
    raise exception 'valid email required';
  end if;

  -- Supersede any outstanding invite for this address rather than leaving two
  -- live tokens that would found two companies. Same stance as
  -- create_org_invite.
  update public.platform_invites
     set status = 'revoked'
   where lower(email) = v_email and status = 'pending';

  v_token := encode(extensions.gen_random_bytes(24), 'hex');

  insert into public.platform_invites (email, suggested_company, token_hash, invited_by)
  values (v_email, nullif(trim(coalesce(p_company_name, '')), ''),
          encode(extensions.digest(v_token, 'sha256'), 'hex'), auth.uid())
  returning * into v_invite;

  return json_build_object(
    'ok', true,
    'invite_id', v_invite.id,
    'email', v_invite.email,
    'suggested_company', v_invite.suggested_company,
    'expires_at', v_invite.expires_at,
    'token', v_token
  );
end;
$$;

revoke execute on function public.create_platform_invite(text, text) from public, anon;
grant execute on function public.create_platform_invite(text, text) to authenticated;

-- ── peek_platform_invite ────────────────────────────────────────────────────
-- What the onboarding page shows before the user commits: which address the
-- invite is for, and any company name Blake suggested. Returns no row for a
-- token that is not live, so a wrong or expired token cannot be distinguished
-- from a never-existed one by probing.

create or replace function public.peek_platform_invite(p_token text)
returns json language plpgsql security definer set search_path = public, pg_temp as $$
declare v_invite public.platform_invites%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into v_invite from public.platform_invites
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');

  if not found or v_invite.status = 'revoked'
     or (v_invite.status = 'pending' and v_invite.expires_at < now()) then
    return json_build_object('ok', false);
  end if;

  return json_build_object(
    'ok', true,
    'email', v_invite.email,
    'suggested_company', v_invite.suggested_company,
    'status', v_invite.status,
    'expires_at', v_invite.expires_at,
    'already_redeemed', v_invite.status = 'accepted'
  );
end;
$$;

revoke execute on function public.peek_platform_invite(text) from public, anon;
grant execute on function public.peek_platform_invite(text) to authenticated;

-- ── redeem_platform_invite: the atomic founding ─────────────────────────────

create or replace function public.redeem_platform_invite(
  p_token     text,
  p_company   text,
  p_timezone  text,
  p_currency  text
) returns json language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_invite   public.platform_invites%rowtype;
  v_email    text;
  v_name     text;
  v_company  text;
  v_tz       text;
  v_currency text;
  v_key      text;
  v_entity   uuid;
  v_supported boolean;
  v_has_other_org boolean;
  v_is_active boolean;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into v_invite from public.platform_invites
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
   for update;

  if not found then
    raise exception 'invite not found or no longer valid';
  end if;

  select lower(email), name into v_email, v_name from public.profiles where id = auth.uid();
  if v_email is null then
    raise exception 'profile not found';
  end if;
  if v_email <> lower(v_invite.email) then
    raise exception 'this invite was issued for a different email address';
  end if;

  -- A disabled account gets ONE answer from this RPC, so the check sits here --
  -- above the idempotent-retry branch, not below it. Placed lower it was
  -- bypassed by a retry, which returned a company and switched the caller's
  -- active_company_id; no escalation, since every helper gates on is_active,
  -- but "disabled, and yet this succeeded" is the kind of inconsistency
  -- somebody later reasons from.
  --
  -- FOR UPDATE because the read and the write below are otherwise a
  -- time-of-check/time-of-use pair: `admin_update_profile(..., is_active =>
  -- false)` committing in between would be undone by the upsert's `else true`
  -- arm. Unclaimed profiles -- no membership anywhere -- are exactly what any
  -- admin may edit, and exactly the branch that takes that arm. Locking the
  -- caller's own row makes the check authoritative for the rest of the
  -- transaction; a concurrent disable waits and then applies last, which is
  -- the right order.
  select is_active into v_is_active
    from public.profiles where id = auth.uid()
    for update;
  if v_is_active is not null and not v_is_active then
    raise exception 'This account is disabled. An administrator has to reactivate it before it can create a company.';
  end if;

  -- The retry path. A lost response, a reloaded tab, a double-clicked button:
  -- the invite is already accepted and already names the company it made, so
  -- hand that back rather than founding a second one. Still refused for anyone
  -- who is not the accepting user, which the email check above has established.
  if v_invite.status = 'accepted' then
    if v_invite.created_company_id is null then
      raise exception 'invite was already redeemed but no company was recorded -- contact support';
    end if;
    perform public.set_active_company(v_invite.created_company_id);
    -- Same KEYS as the fresh path below, deliberately. The caller caches the
    -- company from this response, and `entity_key` decides which nav profile
    -- the first page paints with (v2/nav-config.js resolveNavProfile). Omitting
    -- it here left the RETRY path -- the one this branch exists to serve, and
    -- so the one a flaky demo connection actually hits -- caching a company
    -- with `entity_key: undefined`. It resolves to the standard menu either
    -- way today, which is right for a new tenant by luck rather than by
    -- construction; two success paths of one function should not return two
    -- shapes.
    return json_build_object(
      'ok', true,
      'repeated', true,
      'entity_id', v_invite.created_company_id,
      'entity_key', (select entity_key from public.entities where id = v_invite.created_company_id),
      'company', (select title from public.entities where id = v_invite.created_company_id),
      'business_timezone', (select business_timezone from public.company_settings
                             where company_entity_id = v_invite.created_company_id),
      'default_currency', (select default_currency from public.company_settings
                            where company_entity_id = v_invite.created_company_id)
    );
  end if;

  if v_invite.status = 'revoked' then
    raise exception 'this invite has been revoked';
  end if;
  if v_invite.expires_at < now() then
    -- No `update ... set status = 'expired'` here: the raise on the next line
    -- aborts the transaction and takes the write with it, so it never
    -- persisted. It read like bookkeeping and did nothing. Expiry is derived
    -- from expires_at wherever it is shown -- list_platform_invites computes it
    -- at read time, and peek_platform_invite refuses on it -- so the stored
    -- value was redundant as well as unreachable.
    raise exception 'this invite has expired -- ask for a new one';
  end if;

  v_company := nullif(trim(coalesce(p_company, '')), '');
  if v_company is null then
    raise exception 'company name is required';
  end if;

  v_currency := upper(nullif(trim(coalesce(p_currency, '')), ''));
  if v_currency is null or v_currency !~ '^[A-Z]{3}$' then
    raise exception 'currency must be a three-letter code, e.g. USD';
  end if;

  -- The refusal that keeps a stored setting from lying. See section 4 of the
  -- header: the message names what does not honour the setting yet, because
  -- "unsupported" alone reads as arbitrary.
  v_tz := nullif(trim(coalesce(p_timezone, '')), '');
  if v_tz is null then
    raise exception 'business timezone is required';
  end if;
  select is_supported into v_supported
    from public.supported_business_timezones where tz_name = v_tz;
  if v_supported is null or not v_supported then
    raise exception 'SILO cannot yet anchor daily reporting to %. Ten database functions and seven sync scripts still compute the day boundary in Pacific time, and the nightly Shopify sync is scheduled against it, so storing % would leave every daily figure anchored to Pacific while this setting claimed otherwise. Pick Pacific for now; the remaining work is tracked as the timezone sweep.', v_tz, v_tz;
  end if;

  -- entity_key: slug, de-collided against existing companies. The LOOK-UP is
  -- advisory only -- `entities_unique_key` is UNIQUE (module, entity_type,
  -- entity_key), so two people founding a same-named company in the same
  -- instant would both see no collision and the loser would get a raw 23505
  -- in the middle of signing up. Catching the violation and retrying with a
  -- suffix turns that race into the right answer instead of an error message
  -- nobody can act on. One retry is enough: the suffix is random.
  v_key := trim(both '-' from regexp_replace(lower(v_company), '[^a-z0-9]+', '-', 'g'));
  if v_key = '' then v_key := 'org'; end if;
  if exists (select 1 from public.entities e
              where e.entity_type = 'company' and e.entity_key = v_key) then
    v_key := v_key || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
  end if;

  begin
    insert into public.entities (module, entity_type, entity_key, source, title, meta, created_by)
    values ('finance_hub', 'company', v_key, 'platform_invite', v_company,
            jsonb_build_object('platform_invite', true, 'invite_id', v_invite.id), auth.uid())
    returning id into v_entity;
  exception when unique_violation then
    v_key := v_key || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    insert into public.entities (module, entity_type, entity_key, source, title, meta, created_by)
    values ('finance_hub', 'company', v_key, 'platform_invite', v_company,
            jsonb_build_object('platform_invite', true, 'invite_id', v_invite.id), auth.uid())
    returning id into v_entity;
  end;

  -- Does this user already belong to some OTHER company? Asked before the new
  -- membership is inserted, so any row here is another org.
  select exists (
    select 1 from public.entity_memberships em where em.user_id = auth.uid()
  ) into v_has_other_org;

  -- `profiles.is_active` is GLOBAL, exactly like role and department -- one
  -- column for the whole platform, not one per company. The first correction
  -- preserved role and department for a multi-org user and went on writing
  -- `is_active = true` unconditionally, which left the same escalation intact
  -- in its most direct form: an account DISABLED by company A could hold a
  -- still-valid session, redeem a legitimate company-B founding invite, and
  -- have A's deactivation silently undone. The membership in A is untouched by
  -- deactivation, so switching back needs nothing else, and every authorization
  -- helper gates on `p.is_active` -- which is now true again.
  --
  -- So a disabled account cannot found a company at all. Refusing is the right
  -- answer rather than founding-but-not-reactivating: an account somebody
  -- disabled should not be quietly acquiring new tenants either, and a silent
  -- half-success is the harder state to reason about later. Reactivation is a
  -- deliberate act by an admin of the org that disabled them.

  -- `profiles.role` and `profiles.department` are the LEGACY GLOBAL fields --
  -- they are not per-company, and several gates still read them directly.
  -- `can_manage_journal_entries()` admits `p.department in ('finance','exec')`
  -- on its own, independently of membership role, and the comp-request gate
  -- carries the same branch. So writing `department = 'exec'` here for a user
  -- who is a member or viewer of company A would hand them journal-entry
  -- authority in A -- granted by founding B, which A never agreed to. The
  -- unconditional `role = 'owner'` is the same hazard pointing the other way:
  -- it would DEMOTE an existing `executive`.
  --
  -- The convention already exists and is documented in CLAUDE.md: invites and
  -- backend role grants "only touch the global profile role/department when the
  -- user belongs to no other org", which is exactly what `accept_org_invite`
  -- does with this same flag. Founding a company is no different, and this
  -- missed it. Authority over the NEW company comes from the `owner_admin`
  -- membership below, which is per-company and sufficient.
  insert into public.profiles (id, email, name, role, department, is_active, active_company_id)
  values (auth.uid(), v_email, v_name, 'owner'::app_role, 'exec', true, v_entity)
  on conflict (id) do update
    set role = case when v_has_other_org then profiles.role
                    else excluded.role end,
        department = case when v_has_other_org then profiles.department
                          else coalesce(profiles.department, excluded.department) end,
        -- Preserved for a multi-org user for the same reason as role and
        -- department: it is a GLOBAL flag, and founding here must not write
        -- authority there. The refusal above already means this branch can only
        -- be reached by an active profile, so this is defence in depth -- but
        -- if the refusal were ever removed, an unconditional `true` here would
        -- silently restore the escalation.
        is_active = case when v_has_other_org then profiles.is_active else true end,
        active_company_id = excluded.active_company_id,
        updated_at = now();

  insert into public.entity_memberships (entity_id, user_id, role)
  values (v_entity, auth.uid(), 'owner_admin')
  on conflict (entity_id, user_id) do update set role = excluded.role;

  insert into public.company_settings (company_entity_id, business_timezone, default_currency)
  values (v_entity, v_tz, v_currency);

  update public.platform_invites
     set status = 'accepted',
         accepted_by = auth.uid(),
         accepted_at = now(),
         created_company_id = v_entity
   where id = v_invite.id;

  return json_build_object(
    'ok', true,
    'repeated', false,
    'entity_id', v_entity,
    'entity_key', v_key,
    'company', v_company,
    'business_timezone', v_tz,
    'default_currency', v_currency
  );
end;
$$;

revoke execute on function public.redeem_platform_invite(text, text, text, text) from public, anon;
grant execute on function public.redeem_platform_invite(text, text, text, text) to authenticated;

-- ── list / revoke, for the platform admin ───────────────────────────────────

create or replace function public.list_platform_invites()
returns table (
  id uuid, email text, suggested_company text, status text,
  created_company_id uuid, company_title text,
  expires_at timestamptz, created_at timestamptz, accepted_at timestamptz
) language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_platform_admin() then
    raise exception 'not authorized';
  end if;
  return query
    select i.id, i.email, i.suggested_company,
           case when i.status = 'pending' and i.expires_at < now() then 'expired' else i.status end,
           i.created_company_id, e.title, i.expires_at, i.created_at, i.accepted_at
      from public.platform_invites i
      left join public.entities e on e.id = i.created_company_id
     order by i.created_at desc;
end;
$$;

revoke execute on function public.list_platform_invites() from public, anon;
grant execute on function public.list_platform_invites() to authenticated;

create or replace function public.revoke_platform_invite(p_invite_id uuid)
returns json language plpgsql security definer set search_path = public, pg_temp as $$
declare v_status text;
begin
  if not public.is_platform_admin() then
    raise exception 'not authorized';
  end if;
  update public.platform_invites set status = 'revoked'
   where id = p_invite_id and status = 'pending'
   returning status into v_status;
  if v_status is null then
    raise exception 'invite not found or not pending';
  end if;
  return json_build_object('ok', true);
end;
$$;

revoke execute on function public.revoke_platform_invite(uuid) from public, anon;
grant execute on function public.revoke_platform_invite(uuid) to authenticated;

-- ── handle_new_user loses the org_name branch ───────────────────────────────
-- Section 1 of the header. Every signup now produces a bare profile; founding
-- runs through redeem_platform_invite.

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = 'public' as $$
begin
  -- Founding a company from signup metadata was removed on 2026-09-18. `signUp`
  -- is a public endpoint and the anon key is published by design, so an
  -- `org_name` key in raw_user_meta_data is caller-controlled input, not a
  -- decision SILO made. Company creation is invite-gated -- see
  -- redeem_platform_invite. Any org_name still posted here is IGNORED, not an
  -- error: an old cached copy of the login page should sign the user up, not
  -- fail at them.
  insert into public.profiles (id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', null))
  on conflict (id) do update
    set email = excluded.email;
  return new;
end;
$$;

alter function public.handle_new_user() set search_path = public;

-- ── Company-aware day boundaries ────────────────────────────────────────────
-- 20260904280000 put the Pacific rule in one callable place and noted the
-- limit: "a tenant in another timezone needs this to read from their company
-- record." This is that change. The zero-argument signatures, their return
-- types and their volatility are unchanged, so the 19 files and every seeded
-- report calling them are untouched.
--
-- Resolution order: the ACTIVE company's setting, then Pacific. The fallback is
-- not a guess -- a service-role sync has no active company by design, and
-- Pacific is what those callers have always meant. Because the only supported
-- timezone is Pacific today (section 4), this function returns exactly what it
-- returned before for every existing caller; the change is that it will keep
-- being right when that stops being true.

create or replace function public.silo_business_timezone()
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select cs.business_timezone from public.company_settings cs
      where cs.company_entity_id = public.active_company_id()),
    'America/Los_Angeles');
$$;

comment on function public.silo_business_timezone() is
  'The active company''s business timezone, falling back to Pacific for callers with no active company (every service-role sync). SECURITY DEFINER so it can read company_settings for a caller whose RLS would allow it anyway -- the row it reads is the caller''s own company by construction.';

revoke execute on function public.silo_business_timezone() from public, anon;
grant execute on function public.silo_business_timezone() to authenticated, service_role;

-- These two stay SECURITY INVOKER, exactly as 20260904280000 left them. Only
-- `silo_business_timezone()` above needs definer rights (it reads
-- company_settings); a plain invoker function calling it is fine.
--
-- Getting this wrong is not theoretical: `create or replace` RETAINS existing
-- grants, and production grants anon EXECUTE on both (measured 2026-09-18,
-- `prosecdef = false`, anon `can_exec = true`). An earlier version of this
-- migration marked them `security definer`, which would have produced two
-- SECURITY DEFINER functions reachable by anon -- and this migration's OWN new
-- "Definer functions reachable by anon" check would then have reported CRITICAL
-- the moment it was applied.
--
-- The anon grant is revoked as well. Nothing anonymous calls a business-day
-- helper: every caller is an authenticated report, a service-role sync, or a
-- seeded `system` report running through chat_run_readonly_query as the caller.
-- Leaving it would also break them for anon anyway, since silo_business_timezone()
-- is revoked from anon.
create or replace function public.silo_business_today()
returns date language sql stable set search_path = public, pg_temp as $$
  select (now() at time zone public.silo_business_timezone())::date
$$;

create or replace function public.silo_business_yesterday()
returns date language sql stable set search_path = public, pg_temp as $$
  select (now() at time zone public.silo_business_timezone())::date - 1
$$;

revoke execute on function public.silo_business_today() from public, anon;
revoke execute on function public.silo_business_yesterday() from public, anon;

comment on function public.silo_business_today() is
  'Today in the ACTIVE COMPANY''S business timezone, not UTC. current_date is UTC and runs a day ahead from 17:00 Pacific, which would make a dashboard call a partial day "yesterday" every evening. Reads company_settings since 20260918120000; falls back to Pacific with no active company.';
comment on function public.silo_business_yesterday() is
  'The last COMPLETE selling day in the ACTIVE COMPANY''S business timezone. Use this, never current_date - 1, as the anchor for any period a person reads as "yesterday".';

grant execute on function public.silo_business_today() to authenticated, service_role;
grant execute on function public.silo_business_yesterday() to authenticated, service_role;

-- ── Reconcile the declared currency against QuickBooks' ─────────────────────
-- Section 5 of the header. Rather than re-stating the whole of
-- seed_accounting_opening_balances, a BEFORE trigger on accounting_settings
-- refuses a base_currency that contradicts what the company declared. This
-- catches every writer of that column, present and future, instead of one.

-- Both currency guards are SECURITY DEFINER, and that is load-bearing rather
-- than incidental: each one reads the OTHER table to decide whether to raise,
-- so as INVOKER each would depend on the writer's RLS admitting them there.
-- `accounting_settings` is readable only by `can_manage_journal_entries() OR
-- is_exec_or_owner()`. An `owner_admin` passes that today, so the guard works
-- today -- but a guard that silently stops guarding if an unrelated policy
-- narrows is not a guard. Same reasoning as `is_employee_manager()` and
-- `employee_has_open_comp_request()`: bypass RLS to ANSWER A QUESTION, grant
-- nothing. Neither function runs dynamic SQL; each reads one column and either
-- raises or returns.
--
-- EXECUTE is revoked from public/anon on both. PostgreSQL checks EXECUTE on a
-- trigger function when the TRIGGER IS CREATED, not each time it fires, so the
-- revoke does not stop them firing -- asserted in the regression suite rather
-- than assumed, because "the trigger silently stopped running" is the failure
-- that would make every currency test pass while protecting nothing.
-- Both guards take a per-company transaction lock BEFORE reading the other
-- table. Without it the pair is not an invariant at all, only two independent
-- checks: starting from declared USD and no books, one transaction can move the
-- declaration to CAD and see "no books yet" while another concurrently inserts
-- USD books and sees the still-committed USD declaration. Both BEFORE triggers
-- pass, both commit, and the result is declared CAD over USD books -- which is
-- precisely the state these triggers exist to make impossible, reached by the
-- connect-and-edit overlap onboarding actually produces.
--
-- One lock, taken by both sides on the same key, serialises them. The read that
-- follows sees the other transaction's committed row because a volatile
-- PL/pgSQL function takes a fresh snapshot per statement in READ COMMITTED, so
-- the blocked side re-reads after the winner commits rather than reusing the
-- snapshot it entered with.
--
-- NOT DEMONSTRATED BY THE SUITE: PGlite is single-connection, so the
-- interleaving cannot be forced here. The suite asserts both functions still
-- take the lock -- which stops it being dropped silently -- and this note is
-- the honest statement of what is argued rather than measured, the same stance
-- taken for concurrent invite redemption above.
create or replace function public.check_accounting_currency_matches_declared()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_declared text;
begin
  -- hashtextextended(..., 0) -> bigint, matching 20260912052930's Plaid locks.
  -- `hashtext` returns int4, which widens into the same one advisory-lock space
  -- the Plaid keys already occupy while spanning a quarter of its width -- a
  -- needless collision risk (spurious blocking, not corruption) and a gratuitous
  -- second convention.
  perform pg_advisory_xact_lock(
    hashtextextended('silo-company-currency|' || new.company_entity_id::text, 0));

  select default_currency into v_declared
    from public.company_settings where company_entity_id = new.company_entity_id;

  if v_declared is not null and new.base_currency is not null
     and upper(new.base_currency) <> upper(v_declared) then
    raise exception
      'QuickBooks reports this company''s books in % but the company is set up to report in %. Correct the company currency in Settings, or connect the QuickBooks realm that matches, before seeding opening balances -- SILO will not carry two currencies for one company.',
      upper(new.base_currency), upper(v_declared);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_accounting_currency_matches_declared on public.accounting_settings;
create trigger trg_accounting_currency_matches_declared
  before insert or update of base_currency on public.accounting_settings
  for each row execute function public.check_accounting_currency_matches_declared();

-- ...and the same guard from the OTHER side. The trigger above only fires when
-- `accounting_settings` is written, so once books are seeded in USD an owner
-- could edit `company_settings.default_currency` to CAD and nothing would run:
-- the settings page and the checklist would then say CAD while the ledger said
-- USD, which is precisely the two-definitions-of-one-number state the pair
-- exists to prevent. A one-sided invariant is not an invariant.
create or replace function public.check_declared_currency_matches_books()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_booked text;
begin
  -- TG_OP, not just a change test: fired only on UPDATE, this guard missed the
  -- INSERT entirely -- and an INSERT contradicting existing books is not
  -- hypothetical. EVERY company that predates this migration is in exactly
  -- that state: accounting_settings already carries a currency, company_settings
  -- has no row, and this migration deliberately backfills none. The first write
  -- of a declaration for such a company is an INSERT, which is the one path the
  -- invariant was not watching.
  if TG_OP = 'INSERT' or new.default_currency is distinct from old.default_currency then
    perform pg_advisory_xact_lock(
      hashtextextended('silo-company-currency|' || new.company_entity_id::text, 0));

    select base_currency into v_booked
      from public.accounting_settings where company_entity_id = new.company_entity_id;

    if v_booked is not null and upper(v_booked) <> upper(new.default_currency) then
      raise exception
        'This company''s books are already seeded in % from QuickBooks, so its reporting currency cannot be changed to %. Connect the QuickBooks realm that reports in %, or re-seed the books -- SILO will not carry two currencies for one company.',
        upper(v_booked), upper(new.default_currency), upper(new.default_currency);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_declared_currency_matches_books on public.company_settings;
create trigger trg_declared_currency_matches_books
  before insert or update of default_currency on public.company_settings
  for each row execute function public.check_declared_currency_matches_books();

revoke execute on function public.check_accounting_currency_matches_declared() from public, anon;
revoke execute on function public.check_declared_currency_matches_books() from public, anon;

-- ── Ask SILO usage, attributed per company from day one ─────────────────────
-- silo_chat_audit_log already carries company_entity_id, and the edge function
-- stamps it EXPLICITLY from the company read at the start of the request rather
-- than relying on active_company_id() at write time (a mid-request company
-- switch would otherwise misattribute the row). So attribution is not the gap;
-- a readable rollup is. Billing is a separate PR -- this meters nothing and
-- limits nothing, it just means that PR is a UI job rather than an archaeology
-- one.
--
-- security_invoker, so a company sees its own usage and no one else's, through
-- the audit log's existing policies.

create or replace view public.silo_chat_usage_by_company_v
with (security_invoker = true) as
select l.company_entity_id,
       date_trunc('month', l.created_at)::date     as month,
       count(*)                                    as questions,
       count(distinct l.created_by)                as distinct_users,
       count(*) filter (where l.status = 'error')  as errors,
       sum(coalesce(l.tool_rounds, 0))             as tool_rounds,
       min(l.created_at)                           as first_question_at,
       max(l.created_at)                           as last_question_at
  from public.silo_chat_audit_log l
 group by 1, 2;

comment on view public.silo_chat_usage_by_company_v is
  'Ask SILO usage per company per month. security_invoker, so each caller sees only their own company''s rows through silo_chat_audit_log''s own policies. "errors" is status = ''error'', character-for-character what silo_chat_health_v already counts -- the two views must never disagree about what a failed question is. Counts questions and rounds; it does not price them, and nothing here meters or limits anything. Billing is deliberately a separate change; this exists so that change is a UI job rather than an archaeology one.';

grant select on public.silo_chat_usage_by_company_v to authenticated;

-- ── Drop the dead company-creation function ─────────────────────────────────
-- Section 6 of the header. Measured failing on production before removal.

drop function if exists public.create_entity_with_owner(text, text, text, text, text, jsonb);

-- ── Keep Ask SILO's schema map current ──────────────────────────────────────
select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog set
  description = 'Per-company operating settings chosen at company creation: business_timezone (what silo_business_today()/_yesterday() anchor to) and default_currency (the DECLARED reporting currency, distinct from accounting_settings.base_currency, which is measured from a connected QuickBooks realm).',
  keywords = array['company','settings','timezone','currency','onboarding']
where relname = 'company_settings';

update public.silo_chat_schema_catalog set is_hidden = true
where relname in ('platform_invites', 'platform_admins');
