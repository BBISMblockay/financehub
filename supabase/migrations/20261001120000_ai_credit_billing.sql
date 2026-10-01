-- AI credit billing: the connection between measured AI usage and what a
-- tenant pays.
--
-- Approved model (Blake, 2026-10-01): a monthly SILO subscription that
-- includes a monthly allowance of CUSTOMER-PRICED AI credit, extra credit
-- bought as one-off top-ups, failed or timed-out operations free, and retries
-- never charged twice. Customer price = provider cost x a private multiplier.
--
-- ── WHAT IS DELIBERATELY NOT IN THIS FILE ──────────────────────────────────
-- No pricing. The provider rates (ai_provider_rates), the customer multiplier
-- and the on/off switch (ai_billing_settings), each plan's included credit
-- (billing_plans.included_ai_credit_micros) and the top-up packs
-- (ai_credit_packs) are all INSERTED AT ROLLOUT by service role, never
-- committed. The repo is the wrong place for a margin. With no settings row
-- the whole feature is `off` and every AI entry point behaves exactly as it
-- did before this migration -- see docs/ops/ai-credits.md.
--
-- ── UNITS ──────────────────────────────────────────────────────────────────
-- Every money column is an integer number of MICROS (millionths of a US
-- dollar) and every one is CUSTOMER dollars, except the two columns that say
-- `provider` in their name. Provider cost never leaves the server: no client
-- grant, no view, no RPC result carries it.
--
-- ── THE INVARIANTS ─────────────────────────────────────────────────────────
-- 1. ai_credit_ledger is the record; ai_credit_accounts is its running total,
--    updated in the same transaction and checked by ai_credit_reconcile().
-- 2. Nothing is charged that was not first HELD, and nothing is held that is
--    not available: held_micros <= included + purchased is a CHECK, and every
--    hold is taken under the account's row lock. Concurrent requests therefore
--    cannot spend the same balance. A charge is capped at what was held, so
--    an estimate that undershoots costs SILO, never the customer's balance.
-- 3. Only a SUCCEEDED operation charges. Failed, timed out, cancelled and
--    interrupted ones settle at zero (provider cost is still recorded).
-- 4. Every grant and every charge carries a UNIQUE idempotency key, so a
--    duplicate webhook, a replayed request or a second settle is a no-op.
-- 5. A grant is only ever made from an object re-fetched from Stripe and
--    passed in by a webhook or a server-side sync -- never from a redirect.

-- ---------------------------------------------------------------------------
-- 1. Private configuration (service role only, no rows committed)
-- ---------------------------------------------------------------------------

create table if not exists public.ai_billing_settings (
  id                       boolean primary key default true check (id),
  -- off:     no metering at all (the pre-migration behaviour)
  -- shadow:  usage is priced and recorded, nothing is held or deducted
  -- enforce: holds are taken and charges deducted; an empty balance refuses
  mode                     text not null default 'off'
                             check (mode in ('off','shadow','enforce')),
  customer_multiplier_bps  integer not null
                             check (customer_multiplier_bps between 10000 and 100000),
  updated_at               timestamptz not null default now(),
  note                     text
);

create table if not exists public.ai_provider_rates (
  id                               uuid primary key default gen_random_uuid(),
  model                            text not null,
  effective_from                   timestamptz not null default now(),
  -- micro-USD per token / per request, as the provider bills them
  input_micros_per_token           numeric not null check (input_micros_per_token >= 0),
  output_micros_per_token          numeric not null check (output_micros_per_token >= 0),
  cache_read_micros_per_token      numeric not null check (cache_read_micros_per_token >= 0),
  cache_write_5m_micros_per_token  numeric not null check (cache_write_5m_micros_per_token >= 0),
  cache_write_1h_micros_per_token  numeric not null check (cache_write_1h_micros_per_token >= 0),
  web_search_micros_per_request    numeric not null default 0 check (web_search_micros_per_request >= 0),
  note                             text,
  created_at                       timestamptz not null default now(),
  unique (model, effective_from)
);

-- A rate a charge was computed from must stay what it was: history has to be
-- explainable. A price change is a NEW row with a later effective_from.
create or replace function public.ai_rates_immutable()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  raise exception 'ai_provider_rates rows are immutable; insert a new row with a later effective_from';
end $$;
drop trigger if exists trg_ai_rates_immutable on public.ai_provider_rates;
create trigger trg_ai_rates_immutable before update or delete on public.ai_provider_rates
  for each row execute function public.ai_rates_immutable();

-- ---------------------------------------------------------------------------
-- 2. Customer-facing configuration (readable, not client-writable)
-- ---------------------------------------------------------------------------

-- Null = not configured (the page says so); 0 = configured as none.
alter table public.billing_plans
  add column if not exists included_ai_credit_micros bigint
    check (included_ai_credit_micros is null or included_ai_credit_micros >= 0);
comment on column public.billing_plans.included_ai_credit_micros is
  'Customer-priced AI credit granted once per PAID subscription period on this plan, in micro-USD. Null = not configured. Set at rollout by service role, never committed. Write-once: a different allowance is a different Stripe Price / plan row.';

-- What a period invoice grants is decided by the plan row its Stripe Price
-- names, read when the webhook lands. If the allowance could be edited, a
-- delayed webhook would grant terms other than the ones sold. So once set it
-- is frozen; a different allowance is a new price and a new plan row.
create or replace function public.billing_plans_allowance_frozen()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  if old.included_ai_credit_micros is not null
     and new.included_ai_credit_micros is distinct from old.included_ai_credit_micros then
    raise exception 'billing_plans.included_ai_credit_micros is write-once (plan %); create a new price and plan row instead', old.plan_key;
  end if;
  if old.included_ai_credit_micros is not null and new.stripe_price_id is distinct from old.stripe_price_id then
    raise exception 'billing_plans.stripe_price_id cannot change once the plan grants AI credit (plan %)', old.plan_key;
  end if;
  return new;
end $$;
drop trigger if exists trg_billing_plans_allowance_frozen on public.billing_plans;
create trigger trg_billing_plans_allowance_frozen before update on public.billing_plans
  for each row execute function public.billing_plans_allowance_frozen();

create table if not exists public.ai_credit_packs (
  id                 uuid primary key default gen_random_uuid(),
  pack_key           text not null unique,
  title              text not null,
  stripe_price_id    text not null unique,
  -- what the customer pays, in minor units of `currency`. Checked against the
  -- paid Checkout Session before anything is granted.
  unit_amount_cents  bigint not null check (unit_amount_cents > 0),
  currency           text not null default 'usd' check (currency = 'usd'),
  -- what the customer receives
  credit_micros      bigint not null check (credit_micros > 0),
  is_active          boolean not null default true,
  sort_order         integer not null default 0,
  created_at         timestamptz not null default now()
);

-- A pack is a sold product: its price and what it credits are frozen, so a
-- webhook landing after an edit still grants what was sold. Retire a pack
-- (is_active = false) and add a new one to change terms; title, sort order
-- and is_active stay editable. Packs are never deleted (ledger rows name them).
create or replace function public.ai_credit_packs_frozen()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ai_credit_packs rows are never deleted; set is_active = false';
  end if;
  if (new.pack_key, new.stripe_price_id, new.unit_amount_cents, new.currency, new.credit_micros)
     is distinct from (old.pack_key, old.stripe_price_id, old.unit_amount_cents, old.currency, old.credit_micros) then
    raise exception 'ai_credit_packs terms are frozen (pack %); retire it and add a new pack', old.pack_key;
  end if;
  return new;
end $$;
drop trigger if exists trg_ai_credit_packs_frozen on public.ai_credit_packs;
create trigger trg_ai_credit_packs_frozen before update or delete on public.ai_credit_packs
  for each row execute function public.ai_credit_packs_frozen();

-- ---------------------------------------------------------------------------
-- 3. Balances, holds, ledger
-- ---------------------------------------------------------------------------

create table if not exists public.ai_credit_accounts (
  company_entity_id  uuid primary key references public.entities(id) on delete cascade,
  included_micros    bigint not null default 0 check (included_micros >= 0),
  purchased_micros   bigint not null default 0 check (purchased_micros >= 0),
  held_micros        bigint not null default 0 check (held_micros >= 0),
  updated_at         timestamptz not null default now(),
  constraint ai_credit_never_overheld
    check (held_micros <= included_micros + purchased_micros)
);

-- One row per metered operation, keyed by the operation's own request id.
create table if not exists public.ai_credit_reservations (
  id                          uuid primary key,
  company_entity_id           uuid not null references public.entities(id) on delete cascade,
  user_id                     uuid,
  feature                     text not null check (feature in ('ask_silo','on_deck','card_coding','payment_request_extract')),
  source_ref                  text,
  model                       text not null,
  status                      text not null default 'held'
                                check (status in ('held','settled')),
  enforced                    boolean not null,
  outcome                     text check (outcome in
                                ('succeeded','failed','timed_out','cancelled','interrupted')),
  error_code                  text,
  rate_id                     uuid references public.ai_provider_rates(id),
  multiplier_bps              integer,
  held_micros                 bigint not null default 0 check (held_micros >= 0),
  usage                       jsonb not null default '{}'::jsonb,
  provider_cost_micros        numeric,
  computed_charge_micros      bigint,
  charged_micros              bigint not null default 0 check (charged_micros >= 0),
  created_at                  timestamptz not null default now(),
  last_activity_at            timestamptz not null default now(),
  settled_at                  timestamptz,
  constraint ai_credit_charge_within_hold
    check (not enforced or charged_micros <= held_micros),
  constraint ai_credit_only_success_charges
    check (charged_micros = 0 or outcome = 'succeeded')
);
create index if not exists ai_credit_reservations_company_idx
  on public.ai_credit_reservations (company_entity_id, settled_at desc);
create index if not exists ai_credit_reservations_open_idx
  on public.ai_credit_reservations (company_entity_id, last_activity_at)
  where status = 'held';

create table if not exists public.ai_credit_ledger (
  id                          uuid primary key default gen_random_uuid(),
  company_entity_id           uuid not null references public.entities(id) on delete cascade,
  entry_type                  text not null check (entry_type in
                                ('included_grant','purchase_grant','usage_charge','included_expiry')),
  bucket                      text not null check (bucket in ('included','purchased')),
  amount_micros               bigint not null check (amount_micros <> 0),
  idempotency_key             text not null unique,
  reservation_id              uuid references public.ai_credit_reservations(id),
  plan_key                    text,
  pack_key                    text,
  stripe_invoice_id           text,
  stripe_subscription_id      text,
  stripe_checkout_session_id  text,
  stripe_payment_intent_id    text,
  period_start                timestamptz,
  period_end                  timestamptz,
  created_at                  timestamptz not null default now(),
  constraint ai_credit_ledger_sign check (
    (entry_type in ('included_grant','purchase_grant') and amount_micros > 0)
    or (entry_type in ('usage_charge','included_expiry') and amount_micros < 0)),
  constraint ai_credit_ledger_bucket check (
    (entry_type in ('included_grant','included_expiry') and bucket = 'included')
    or (entry_type = 'purchase_grant' and bucket = 'purchased')
    or entry_type = 'usage_charge')
);
create index if not exists ai_credit_ledger_company_idx
  on public.ai_credit_ledger (company_entity_id, created_at desc);
-- A payment intent credits once, whatever key a caller invents.
create unique index if not exists ai_credit_ledger_one_grant_per_payment
  on public.ai_credit_ledger (stripe_payment_intent_id) where entry_type = 'purchase_grant';

-- Included credit is tracked PER GRANT, because it expires per period: an
-- aggregate balance cannot say which part belongs to an ended period once a
-- renewal has added the next one. Spending included credit draws the oldest
-- grant first; expiry removes what is left of ended grants. The account's
-- included_micros always equals the sum of remaining_micros here
-- (ai_credit_reconcile checks it).
create table if not exists public.ai_credit_included_grants (
  ledger_id          uuid primary key references public.ai_credit_ledger(id),
  company_entity_id  uuid not null references public.entities(id) on delete cascade,
  period_start       timestamptz not null,
  period_end         timestamptz not null check (period_end > period_start),
  granted_micros     bigint not null check (granted_micros > 0),
  remaining_micros   bigint not null check (remaining_micros >= 0 and remaining_micros <= granted_micros),
  created_at         timestamptz not null default now()
);
create index if not exists ai_credit_included_grants_company_idx
  on public.ai_credit_included_grants (company_entity_id, period_end);

create or replace function public.ai_credit_ledger_append_only()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  raise exception 'ai_credit_ledger is append-only';
end $$;
drop trigger if exists trg_ai_credit_ledger_append_only on public.ai_credit_ledger;
create trigger trg_ai_credit_ledger_append_only before update or delete on public.ai_credit_ledger
  for each row execute function public.ai_credit_ledger_append_only();

-- ---------------------------------------------------------------------------
-- 4. Grants: closed to clients. Supabase's default privileges hand every new
--    table to anon and authenticated, so the revoke is the boundary.
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['ai_billing_settings','ai_provider_rates','ai_credit_packs',
                           'ai_credit_accounts','ai_credit_reservations','ai_credit_ledger',
                           'ai_credit_included_grants'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- Packs are a public catalogue, like billing_plans: read-only to members.
grant select on public.ai_credit_packs to authenticated;
drop policy if exists ai_credit_packs_read on public.ai_credit_packs;
create policy ai_credit_packs_read on public.ai_credit_packs
  for select to authenticated using (is_active);

-- ---------------------------------------------------------------------------
-- 5. Pricing arithmetic (internal)
-- ---------------------------------------------------------------------------

-- Usage keys, all non-negative integers, missing = 0:
--   input, output, cache_read, cache_write (total), cache_write_5m,
--   cache_write_1h, web_search
create or replace function public.ai_credit_usage_valid(p_usage jsonb)
returns boolean language sql immutable set search_path to 'public' as $$
  select jsonb_typeof(coalesce(p_usage, '{}'::jsonb)) = 'object'
     and not exists (
       select 1 from jsonb_each(case when jsonb_typeof(p_usage) = 'object' then p_usage
                                     else '{}'::jsonb end) e
        where e.key in ('input','output','cache_read','cache_write','cache_write_5m','cache_write_1h','web_search')
          and case when jsonb_typeof(e.value) <> 'number' then true
                   else (e.value #>> '{}')::numeric < 0
                     or (e.value #>> '{}')::numeric <> trunc((e.value #>> '{}')::numeric) end);
$$;

create or replace function public.ai_credit_provider_cost(p_rate public.ai_provider_rates, p_usage jsonb)
returns numeric language plpgsql immutable set search_path to 'public' as $$
declare
  u jsonb := coalesce(p_usage, '{}'::jsonb);
  f_in  numeric := coalesce((u->>'input')::numeric, 0);
  f_out numeric := coalesce((u->>'output')::numeric, 0);
  f_cr  numeric := coalesce((u->>'cache_read')::numeric, 0);
  f_cw  numeric := coalesce((u->>'cache_write')::numeric, 0);
  f_5m  numeric := coalesce((u->>'cache_write_5m')::numeric, 0);
  f_1h  numeric := coalesce((u->>'cache_write_1h')::numeric, 0);
  f_ws  numeric := coalesce((u->>'web_search')::numeric, 0);
  -- Cache writes the provider did not break down are priced at the 5-minute
  -- rate: the measured default, never a guess upward.
  f_rest numeric := greatest(f_cw - f_5m - f_1h, 0);
begin
  if p_rate.id is null then return null; end if;
  return f_in  * p_rate.input_micros_per_token
       + f_out * p_rate.output_micros_per_token
       + f_cr  * p_rate.cache_read_micros_per_token
       + (f_5m + f_rest) * p_rate.cache_write_5m_micros_per_token
       + f_1h  * p_rate.cache_write_1h_micros_per_token
       + f_ws  * p_rate.web_search_micros_per_request;
end $$;

-- Customer micros, rounded UP to the whole micro (one rule, applied once to
-- the operation's total -- never summed from rounded per-call values).
create or replace function public.ai_credit_customer_micros(p_provider numeric, p_bps integer)
returns bigint language sql immutable set search_path to 'public' as $$
  select case when p_provider is null or p_bps is null then null
              else ceil(p_provider * p_bps / 10000.0)::bigint end;
$$;

-- The worst a single model call can cost the customer: every input token at
-- the dearest input-side rate, the full output allowance, every web search.
create or replace function public.ai_credit_call_worst(
  p_rate public.ai_provider_rates, p_bps integer,
  p_est_input bigint, p_max_output bigint, p_max_web integer)
returns bigint language sql immutable set search_path to 'public' as $$
  select public.ai_credit_customer_micros(
    greatest(coalesce(p_est_input,0),0) * greatest(p_rate.input_micros_per_token,
                                 p_rate.cache_write_5m_micros_per_token,
                                 p_rate.cache_write_1h_micros_per_token)
    + greatest(coalesce(p_max_output,0),0) * p_rate.output_micros_per_token
    + greatest(coalesce(p_max_web,0),0) * p_rate.web_search_micros_per_request,
    p_bps);
$$;

-- ---------------------------------------------------------------------------
-- 6. Metering RPCs (service role only)
-- ---------------------------------------------------------------------------

-- Close one held reservation. The ONLY place a hold becomes a charge.
-- Idempotent: a reservation already settled returns what it settled as.
create or replace function public.ai_credit_settle(
  p_request uuid, p_usage jsonb, p_outcome text, p_error text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  r     public.ai_credit_reservations;
  rate  public.ai_provider_rates;
  v_usage jsonb;
  provider numeric;
  computed bigint;
  charge bigint := 0;
  from_included bigint := 0;
  from_purchased bigint := 0;
  acct public.ai_credit_accounts;
begin
  if p_outcome not in ('succeeded','failed','timed_out','cancelled','interrupted') then
    raise exception 'ai_credit_settle: unknown outcome %', p_outcome;
  end if;
  select * into r from public.ai_credit_reservations where id = p_request;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_request'); end if;
  -- Lock order everywhere: the company's account row, then the reservation.
  if r.enforced then
    select * into acct from public.ai_credit_accounts
      where company_entity_id = r.company_entity_id for update;
  end if;
  select * into r from public.ai_credit_reservations where id = p_request for update;
  if r.status = 'settled' then
    return jsonb_build_object('ok', true, 'repeated', true, 'outcome', r.outcome,
      'enforced', r.enforced, 'charged_micros', r.charged_micros,
      'customer_cost_micros', r.computed_charge_micros);
  end if;

  -- The newer usage wins; an absent one keeps what step() last recorded.
  v_usage := case when p_usage is null or p_usage = '{}'::jsonb then r.usage else p_usage end;
  if not public.ai_credit_usage_valid(v_usage) then
    raise exception 'ai_credit_settle: invalid usage';
  end if;
  if r.rate_id is not null then
    select * into rate from public.ai_provider_rates where id = r.rate_id;
    provider := public.ai_credit_provider_cost(rate, v_usage);
    computed := public.ai_credit_customer_micros(provider, r.multiplier_bps);
  end if;

  if r.enforced then
    if p_outcome = 'succeeded' then
      charge := least(coalesce(computed, 0), r.held_micros);
    end if;
    from_included  := least(charge, acct.included_micros);
    from_purchased := charge - from_included;
    perform public.ai_credit_take_included(r.company_entity_id, from_included);
    update public.ai_credit_accounts
       set held_micros      = held_micros - r.held_micros,
           included_micros  = included_micros - from_included,
           purchased_micros = purchased_micros - from_purchased,
           updated_at       = now()
     where company_entity_id = r.company_entity_id;
    if from_included > 0 then
      insert into public.ai_credit_ledger
        (company_entity_id, entry_type, bucket, amount_micros, idempotency_key, reservation_id)
      values (r.company_entity_id, 'usage_charge', 'included', -from_included,
              'usage:' || r.id || ':included', r.id);
    end if;
    if from_purchased > 0 then
      insert into public.ai_credit_ledger
        (company_entity_id, entry_type, bucket, amount_micros, idempotency_key, reservation_id)
      values (r.company_entity_id, 'usage_charge', 'purchased', -from_purchased,
              'usage:' || r.id || ':purchased', r.id);
    end if;
  end if;

  update public.ai_credit_reservations
     set status = 'settled', outcome = p_outcome, error_code = left(p_error, 200),
         usage = v_usage, provider_cost_micros = provider,
         computed_charge_micros = computed, charged_micros = charge,
         settled_at = now(), last_activity_at = now()
   where id = r.id;
  -- An ended period's credit kept only to back this hold goes now.
  if r.enforced then perform public.ai_credit_expire_included(r.company_entity_id); end if;

  return jsonb_build_object('ok', true, 'repeated', false, 'outcome', p_outcome,
    'enforced', r.enforced, 'charged_micros', charge,
    -- Customer-priced, for display in shadow mode. Never the provider cost.
    'customer_cost_micros', case when p_outcome = 'succeeded' then computed else 0 end);
end $$;

-- Release holds left by an operation that never reported back (a worker
-- killed by the platform). Free to the customer: nothing was delivered.
create or replace function public.ai_credit_sweep(
  p_company uuid default null, p_stale interval default interval '15 minutes')
returns integer language plpgsql security definer set search_path to 'public' as $$
declare r record; n integer := 0;
begin
  for r in select id from public.ai_credit_reservations
            where status = 'held'
              and (p_company is null or company_entity_id = p_company)
              and last_activity_at < now() - p_stale
            order by created_at
  loop
    perform public.ai_credit_settle(r.id, null, 'interrupted', 'swept');
    n := n + 1;
  end loop;
  return n;
end $$;

-- Start a metered operation. Takes the first hold BEFORE any model call.
--   p_calls_to_hold: how many worst-case calls to hold up front. Ask SILO
--   holds two (the first call, plus the forced final answer it may need).
create or replace function public.ai_credit_open(
  p_request      uuid,
  p_company      uuid,
  p_user         uuid,
  p_feature      text,
  p_model        text,
  p_est_input    bigint,
  p_max_output   bigint,
  p_max_web      integer default 0,
  p_calls_to_hold integer default 1,
  p_source_ref   text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  s     public.ai_billing_settings;
  rate  public.ai_provider_rates;
  acct  public.ai_credit_accounts;
  need  bigint;
  avail bigint;
  existing public.ai_credit_reservations;
begin
  if p_request is null then
    raise exception 'ai_credit_open: request id is required';
  end if;
  select * into s from public.ai_billing_settings where id;
  if not found or s.mode = 'off' then
    return jsonb_build_object('ok', true, 'mode', 'off');
  end if;
  -- No company, nobody to charge: refused rather than run unmetered.
  if p_company is null then
    return jsonb_build_object('ok', false, 'mode', s.mode, 'reason', 'no_company');
  end if;
  -- Close this company's abandoned operations first (free), in every mode,
  -- then let a lapsed period's included credit go.
  perform public.ai_credit_sweep(p_company);
  if s.mode = 'enforce' then perform public.ai_credit_expire_included(p_company); end if;

  -- Service role bypasses RLS, so the caller's standing is checked here.
  if p_user is not null and not exists (
      select 1 from public.profiles p
        join public.entity_memberships m on m.user_id = p.id and m.entity_id = p_company
       where p.id = p_user and p.is_active) then
    return jsonb_build_object('ok', false, 'mode', s.mode, 'reason', 'not_a_member');
  end if;

  select * into existing from public.ai_credit_reservations where id = p_request;
  if found then
    return jsonb_build_object('ok', false, 'mode', s.mode, 'reason', 'duplicate',
                              'status', existing.status);
  end if;

  select * into rate from public.ai_provider_rates
   where model = p_model and effective_from <= now()
   order by effective_from desc limit 1;
  if not found then
    if s.mode = 'enforce' then
      return jsonb_build_object('ok', false, 'mode', s.mode, 'reason', 'unpriced_model');
    end if;
    insert into public.ai_credit_reservations
      (id, company_entity_id, user_id, feature, source_ref, model, enforced)
    values (p_request, p_company, p_user, p_feature, p_source_ref, p_model, false);
    return jsonb_build_object('ok', true, 'mode', s.mode, 'priced', false);
  end if;

  if s.mode = 'shadow' then
    insert into public.ai_credit_reservations
      (id, company_entity_id, user_id, feature, source_ref, model, enforced, rate_id, multiplier_bps)
    values (p_request, p_company, p_user, p_feature, p_source_ref, p_model, false,
            rate.id, s.customer_multiplier_bps);
    return jsonb_build_object('ok', true, 'mode', s.mode, 'priced', true);
  end if;

  -- enforce
  insert into public.ai_credit_accounts (company_entity_id) values (p_company)
    on conflict (company_entity_id) do nothing;
  select * into acct from public.ai_credit_accounts
   where company_entity_id = p_company for update;

  need := greatest(coalesce(p_calls_to_hold, 1), 1)
          * public.ai_credit_call_worst(rate, s.customer_multiplier_bps,
                                        p_est_input, p_max_output, p_max_web);
  avail := acct.included_micros + acct.purchased_micros - acct.held_micros;
  if avail < need then
    return jsonb_build_object('ok', false, 'mode', s.mode, 'reason', 'insufficient_credit',
                              'available_micros', greatest(avail, 0), 'needed_micros', need);
  end if;

  update public.ai_credit_accounts set held_micros = held_micros + need, updated_at = now()
   where company_entity_id = p_company;
  insert into public.ai_credit_reservations
    (id, company_entity_id, user_id, feature, source_ref, model, enforced,
     rate_id, multiplier_bps, held_micros)
  values (p_request, p_company, p_user, p_feature, p_source_ref, p_model, true,
          rate.id, s.customer_multiplier_bps, need);
  return jsonb_build_object('ok', true, 'mode', s.mode, 'priced', true,
                            'held_micros', need, 'available_micros', avail - need);
end $$;

-- Before each LATER model call: record usage so far and make sure the hold
-- still covers it plus this call and one forced final call. A refusal keeps
-- the existing hold, which the caller may spend on a final answer.
create or replace function public.ai_credit_step(
  p_request uuid, p_usage jsonb, p_est_input bigint, p_max_output bigint,
  p_max_web integer default 0)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  r     public.ai_credit_reservations;
  rate  public.ai_provider_rates;
  acct  public.ai_credit_accounts;
  spent bigint;
  target bigint;
  grow  bigint;
begin
  if not public.ai_credit_usage_valid(p_usage) then
    raise exception 'ai_credit_step: invalid usage';
  end if;
  select * into r from public.ai_credit_reservations where id = p_request;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_request'); end if;
  if r.status <> 'held' then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;

  if not r.enforced or r.rate_id is null then
    update public.ai_credit_reservations
       set usage = coalesce(p_usage, usage), last_activity_at = now() where id = r.id;
    return jsonb_build_object('ok', true, 'enforced', false);
  end if;

  -- Lock order: account first, then reservation -- the same order as open and
  -- settle, so two steps on one company cannot deadlock.
  select * into acct from public.ai_credit_accounts
   where company_entity_id = r.company_entity_id for update;
  select * into r from public.ai_credit_reservations where id = p_request for update;
  if r.status <> 'held' then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  select * into rate from public.ai_provider_rates where id = r.rate_id;

  spent := coalesce(public.ai_credit_customer_micros(
             public.ai_credit_provider_cost(rate, p_usage), r.multiplier_bps), 0);
  target := spent + 2 * public.ai_credit_call_worst(rate, r.multiplier_bps,
                                                   p_est_input, p_max_output, p_max_web);
  grow := target - r.held_micros;

  update public.ai_credit_reservations
     set usage = coalesce(p_usage, usage), last_activity_at = now() where id = r.id;

  if grow <= 0 then
    return jsonb_build_object('ok', true, 'enforced', true, 'held_micros', r.held_micros);
  end if;
  if acct.included_micros + acct.purchased_micros - acct.held_micros < grow then
    return jsonb_build_object('ok', false, 'enforced', true, 'reason', 'insufficient_credit',
                              'held_micros', r.held_micros);
  end if;
  update public.ai_credit_accounts set held_micros = held_micros + grow, updated_at = now()
   where company_entity_id = r.company_entity_id;
  update public.ai_credit_reservations set held_micros = held_micros + grow where id = r.id;
  return jsonb_build_object('ok', true, 'enforced', true, 'held_micros', r.held_micros + grow);
end $$;

-- ---------------------------------------------------------------------------
-- 7. Grants of credit, from Stripe objects (service role only)
-- ---------------------------------------------------------------------------

create or replace function public.ai_credit_add(
  p_company uuid, p_type text, p_amount bigint, p_key text,
  p_plan text default null, p_pack text default null,
  p_invoice text default null, p_subscription text default null,
  p_session text default null, p_payment_intent text default null,
  p_period_start timestamptz default null, p_period_end timestamptz default null)
returns boolean language plpgsql security definer set search_path to 'public' as $$
declare v_bucket text := case when p_type = 'included_grant' then 'included' else 'purchased' end;
        v_id uuid := gen_random_uuid();
begin
  if p_amount is null or p_amount <= 0 then return false; end if;
  if v_bucket = 'included' and (p_period_start is null or p_period_end is null) then
    raise exception 'ai_credit_add: an included grant needs its period';
  end if;
  insert into public.ai_credit_ledger
    (id, company_entity_id, entry_type, bucket, amount_micros, idempotency_key, plan_key, pack_key,
     stripe_invoice_id, stripe_subscription_id, stripe_checkout_session_id,
     stripe_payment_intent_id, period_start, period_end)
  values (v_id, p_company, p_type, v_bucket, p_amount, p_key, p_plan, p_pack, p_invoice,
          p_subscription, p_session, p_payment_intent, p_period_start, p_period_end)
  on conflict do nothing;
  if not found then return false; end if;   -- duplicate: already credited
  if v_bucket = 'included' then
    insert into public.ai_credit_included_grants
      (ledger_id, company_entity_id, period_start, period_end, granted_micros, remaining_micros)
    values (v_id, p_company, p_period_start, p_period_end, p_amount, p_amount);
  end if;
  insert into public.ai_credit_accounts (company_entity_id) values (p_company)
    on conflict (company_entity_id) do nothing;
  update public.ai_credit_accounts
     set included_micros  = included_micros  + case when v_bucket = 'included'  then p_amount else 0 end,
         purchased_micros = purchased_micros + case when v_bucket = 'purchased' then p_amount else 0 end,
         updated_at = now()
   where company_entity_id = p_company;
  return true;
end $$;

-- ── Included credit does not roll over; purchased credit does ──────────────
-- (Blake, 2026-10-01.) The plan allowance is good for the period it was
-- granted for. Once that period has ended, whatever is left of THAT GRANT is
-- removed with an `included_expiry` ledger entry; top-up credit is never
-- touched. Tracked per grant (ai_credit_included_grants), so a renewal can
-- never make an older period's leftover look current.
--
-- Lock order, everywhere: the company's account row FIRST, then grants and
-- reservations. Every function below takes it before reading any grant, so
-- two deliveries of the same renewal serialise instead of one acting on what
-- the other has already changed.

-- Spend included credit, oldest grant first (ended grants kept only to back a
-- hold go before current ones). Caller holds the account lock.
create or replace function public.ai_credit_take_included(p_company uuid, p_amount bigint)
returns void language plpgsql security definer set search_path to 'public' as $$
declare g record; v_left bigint := coalesce(p_amount, 0); v_take bigint;
begin
  if v_left <= 0 then return; end if;
  for g in select ledger_id, remaining_micros from public.ai_credit_included_grants
            where company_entity_id = p_company and remaining_micros > 0
            order by period_end, created_at, ledger_id for update
  loop
    v_take := least(v_left, g.remaining_micros);
    update public.ai_credit_included_grants set remaining_micros = remaining_micros - v_take
     where ledger_id = g.ledger_id;
    v_left := v_left - v_take;
    exit when v_left = 0;
  end loop;
  if v_left > 0 then
    raise exception 'ai_credit_take_included: grants hold % less than the account says', v_left;
  end if;
end $$;

-- Expire what is left of every grant whose period has ended as of p_as_of.
-- What can expire is what is not spoken for: open holds are backed first by
-- purchased credit and current grants, and only the shortfall keeps ended
-- credit alive -- the `held <= included + purchased` CHECK would refuse
-- anything else. Settling those holds calls this again, which expires the
-- rest (the key carries a sequence number, so a second, smaller expiry of
-- the same grant is a new entry, not a no-op). Returns the amount expired.
create or replace function public.ai_credit_expire_included(p_company uuid, p_as_of timestamptz default now())
returns bigint language plpgsql security definer set search_path to 'public' as $$
declare
  acct    public.ai_credit_accounts;
  g       record;
  v_live  bigint;
  v_ended bigint;
  v_left  bigint;
  v_take  bigint;
  v_total bigint;
  seq     integer;
begin
  select * into acct from public.ai_credit_accounts where company_entity_id = p_company for update;
  if not found then return 0; end if;
  select coalesce(sum(remaining_micros) filter (where period_end >  p_as_of), 0),
         coalesce(sum(remaining_micros) filter (where period_end <= p_as_of), 0)
    into v_live, v_ended
    from public.ai_credit_included_grants where company_entity_id = p_company;
  v_total := greatest(0, v_ended - greatest(0, acct.held_micros - acct.purchased_micros - v_live));
  if v_total <= 0 then return 0; end if;
  v_left := v_total;
  for g in select * from public.ai_credit_included_grants
            where company_entity_id = p_company and period_end <= p_as_of and remaining_micros > 0
            order by period_end, created_at, ledger_id for update
  loop
    v_take := least(v_left, g.remaining_micros);
    update public.ai_credit_included_grants set remaining_micros = remaining_micros - v_take
     where ledger_id = g.ledger_id;
    select count(*) into seq from public.ai_credit_ledger
     where company_entity_id = p_company and entry_type = 'included_expiry'
       and idempotency_key like 'expire:' || g.ledger_id || ':%';
    insert into public.ai_credit_ledger
      (company_entity_id, entry_type, bucket, amount_micros, idempotency_key,
       plan_key, stripe_subscription_id, period_start, period_end)
    select p_company, 'included_expiry', 'included', -v_take, 'expire:' || g.ledger_id || ':' || seq,
           l.plan_key, l.stripe_subscription_id, g.period_start, g.period_end
      from public.ai_credit_ledger l where l.id = g.ledger_id;
    v_left := v_left - v_take;
    exit when v_left = 0;
  end loop;
  update public.ai_credit_accounts
     set included_micros = included_micros - v_total, updated_at = now()
   where company_entity_id = p_company;
  return v_total;
end $$;

-- Monthly included credit. Granted once per (subscription, billing period),
-- only from a PAID invoice that opened or renewed that period, and only while
-- that period is still running: an invoice delivered after its period ended
-- (a delayed or replayed webhook) grants nothing, since the allowance would
-- already have expired. A proration, a manual invoice (a top-up's receipt),
-- an unpaid or a zero-amount invoice grants nothing. Accepts both Stripe
-- invoice shapes (pre- and post-basil). The amount is the plan row's frozen
-- allowance (billing_plans_allowance_frozen), so it is the one that was sold.
create or replace function public.ai_credit_grant_included(p_company uuid, p_invoice jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_customer text := coalesce(p_invoice->>'customer', p_invoice->'customer'->>'id');
  v_sub      text;
  v_line     jsonb;
  v_price    text;
  v_plan     public.billing_plans;
  v_start    timestamptz;
  v_end      timestamptz;
  v_granted  boolean;
begin
  if p_company is null or p_invoice->>'id' is null then
    raise exception 'ai_credit_grant_included: company and invoice are required';
  end if;
  if not exists (select 1 from public.billing_subscriptions
                  where company_entity_id = p_company and stripe_customer_id = v_customer) then
    raise exception 'ai_credit_grant_included: invoice customer % is not this company''s', v_customer;
  end if;
  if p_invoice->>'status' is distinct from 'paid' then
    return jsonb_build_object('granted', false, 'reason', 'not_paid');
  end if;
  if coalesce(nullif(p_invoice->>'amount_paid','')::bigint, 0) <= 0 then
    return jsonb_build_object('granted', false, 'reason', 'zero_amount');
  end if;
  if coalesce(p_invoice->>'billing_reason','') not in ('subscription_create','subscription_cycle') then
    return jsonb_build_object('granted', false, 'reason', 'not_a_period_invoice');
  end if;

  -- The account lock before anything is read (see "Lock order" above).
  insert into public.ai_credit_accounts (company_entity_id) values (p_company)
    on conflict (company_entity_id) do nothing;
  perform 1 from public.ai_credit_accounts where company_entity_id = p_company for update;

  v_sub := coalesce(
    case when jsonb_typeof(p_invoice->'subscription') = 'string' then p_invoice->>'subscription' end,
    p_invoice->'subscription'->>'id',
    p_invoice->'parent'->'subscription_details'->>'subscription');

  for v_line in select l from jsonb_array_elements(coalesce(p_invoice->'lines'->'data','[]'::jsonb)) l loop
    v_price := coalesce(v_line->'price'->>'id',
                        case when jsonb_typeof(v_line->'price') = 'string' then v_line->>'price' end,
                        v_line->'pricing'->'price_details'->>'price');
    select * into v_plan from public.billing_plans where stripe_price_id = v_price;
    if found and coalesce(v_plan.included_ai_credit_micros, 0) > 0 then
      v_start := public.stripe_epoch(nullif(v_line->'period'->>'start','')::bigint);
      v_end   := public.stripe_epoch(nullif(v_line->'period'->>'end','')::bigint);
      v_sub := coalesce(v_sub, v_line->>'subscription',
                        v_line->'parent'->'subscription_item_details'->>'subscription');
      if v_sub is null or v_start is null or v_end is null then
        return jsonb_build_object('granted', false, 'reason', 'no_period');
      end if;
      if v_end <= now() then
        return jsonb_build_object('granted', false, 'reason', 'period_ended');
      end if;
      v_granted := public.ai_credit_add(p_company, 'included_grant', v_plan.included_ai_credit_micros,
        'included:' || v_sub || ':' || extract(epoch from v_start)::bigint,
        p_plan => v_plan.plan_key, p_invoice => p_invoice->>'id', p_subscription => v_sub,
        p_period_start => v_start, p_period_end => v_end);
      -- Last period's leftover goes now (no rollover): every grant that ended
      -- by the time this period starts is expired. This grant is current.
      perform public.ai_credit_expire_included(p_company, greatest(now(), v_start));
      return jsonb_build_object('granted', v_granted,
                                'reason', case when v_granted then 'granted' else 'already_granted' end);
    end if;
  end loop;
  return jsonb_build_object('granted', false, 'reason', 'no_plan_with_included_credit');
end $$;

-- A top-up. Granted once per PaymentIntent, only from a Checkout Session that
-- SILO created for this purpose, for this company, that Stripe reports paid,
-- for exactly the pack's price. The credit comes from ai_credit_packs, never
-- from the session; packs are frozen (ai_credit_packs_frozen), so the pack a
-- session names is the one that was sold, and the paid amount and currency
-- are checked against it before anything is credited.
create or replace function public.ai_credit_grant_purchase(p_company uuid, p_session jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_customer text := coalesce(p_session->>'customer', p_session->'customer'->>'id');
  v_pi       text := coalesce(
                       case when jsonb_typeof(p_session->'payment_intent') = 'string'
                            then p_session->>'payment_intent' end,
                       p_session->'payment_intent'->>'id');
  v_pack     public.ai_credit_packs;
  v_granted  boolean;
begin
  if p_company is null or p_session->>'id' is null then
    raise exception 'ai_credit_grant_purchase: company and session are required';
  end if;
  if p_session->>'mode' is distinct from 'payment'
     or p_session->'metadata'->>'silo_purpose' is distinct from 'ai_credit_topup' then
    return jsonb_build_object('granted', false, 'reason', 'not_a_topup');
  end if;
  if p_session->'metadata'->>'silo_company_entity_id' is distinct from p_company::text then
    raise exception 'ai_credit_grant_purchase: session % names another company', p_session->>'id';
  end if;
  if not exists (select 1 from public.billing_subscriptions
                  where company_entity_id = p_company and stripe_customer_id = v_customer) then
    raise exception 'ai_credit_grant_purchase: session customer % is not this company''s', v_customer;
  end if;
  if p_session->>'payment_status' is distinct from 'paid' then
    return jsonb_build_object('granted', false, 'reason', 'not_paid');
  end if;
  if v_pi is null then
    return jsonb_build_object('granted', false, 'reason', 'no_payment_intent');
  end if;
  select * into v_pack from public.ai_credit_packs
   where pack_key = p_session->'metadata'->>'silo_credit_pack';
  if not found then
    raise exception 'ai_credit_grant_purchase: unknown pack %', p_session->'metadata'->>'silo_credit_pack';
  end if;
  -- What was paid must be what the pack sells. amount_subtotal is before tax,
  -- so a tax line does not read as a mismatch. A mismatch is RAISED, not
  -- skipped: it is money taken for terms SILO cannot honour automatically,
  -- and the webhook's retry ledger keeps it visible until a person resolves it.
  if lower(coalesce(p_session->>'currency','')) is distinct from v_pack.currency
     or nullif(p_session->>'amount_subtotal','')::bigint is distinct from v_pack.unit_amount_cents then
    raise exception 'ai_credit_grant_purchase: session % paid % % but pack % sells % %',
      p_session->>'id', p_session->>'amount_subtotal', p_session->>'currency',
      v_pack.pack_key, v_pack.unit_amount_cents, v_pack.currency;
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_session->'line_items'->'data','[]'::jsonb)) li
              where coalesce(li->'price'->>'id', li->>'price') is distinct from v_pack.stripe_price_id) then
    raise exception 'ai_credit_grant_purchase: session % is not for pack % price', p_session->>'id', v_pack.pack_key;
  end if;
  insert into public.ai_credit_accounts (company_entity_id) values (p_company)
    on conflict (company_entity_id) do nothing;
  perform 1 from public.ai_credit_accounts where company_entity_id = p_company for update;
  v_granted := public.ai_credit_add(p_company, 'purchase_grant', v_pack.credit_micros,
    'purchase:' || v_pi, p_pack => v_pack.pack_key,
    p_session => p_session->>'id', p_payment_intent => v_pi);
  return jsonb_build_object('granted', v_granted,
                            'reason', case when v_granted then 'granted' else 'already_granted' end);
end $$;

-- Ledger vs running total vs open holds, per company. Every column pair must
-- agree; verify_v2_schema.sql goes CRITICAL when one does not.
create or replace function public.ai_credit_reconcile(p_company uuid default null)
returns table (company_entity_id uuid, included_micros bigint, ledger_included bigint,
               grants_remaining bigint,
               purchased_micros bigint, ledger_purchased bigint,
               held_micros bigint, open_holds bigint, ok boolean)
language sql stable security definer set search_path to 'public' as $$
  select a.company_entity_id, a.included_micros, coalesce(l.inc, 0), coalesce(g.rem, 0),
         a.purchased_micros, coalesce(l.pur, 0), a.held_micros, coalesce(h.held, 0),
         a.included_micros = coalesce(l.inc, 0) and a.included_micros = coalesce(g.rem, 0)
           and a.purchased_micros = coalesce(l.pur, 0)
           and a.held_micros = coalesce(h.held, 0)
    from public.ai_credit_accounts a
    left join (select company_entity_id,
                      sum(amount_micros) filter (where bucket = 'included')::bigint inc,
                      sum(amount_micros) filter (where bucket = 'purchased')::bigint pur
                 from public.ai_credit_ledger group by 1) l using (company_entity_id)
    left join (select company_entity_id, sum(remaining_micros)::bigint rem
                 from public.ai_credit_included_grants group by 1) g using (company_entity_id)
    left join (select company_entity_id, sum(held_micros)::bigint held
                 from public.ai_credit_reservations
                where status = 'held' and enforced group by 1) h using (company_entity_id)
   where p_company is null or a.company_entity_id = p_company;
$$;

-- ---------------------------------------------------------------------------
-- 8. The one customer read path
-- ---------------------------------------------------------------------------

-- No company argument: the active company, for an active member of it.
-- Members get the balance and state (Ask SILO shows it); company admins also
-- get usage, grants and purchases (Billing shows them). Customer dollars
-- only -- never provider cost, multiplier or rates.
create or replace function public.ai_credit_summary()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_co     uuid := public.active_company_id();
  v_uid    uuid := auth.uid();
  s        public.ai_billing_settings;
  sub      public.billing_subscriptions;
  acct     public.ai_credit_accounts;
  v_state  text;
  v_start  timestamptz;
  v_end    timestamptz;
  v_period_source text;
  v_plan_included bigint;
  v_admin  boolean;
  -- Usage is reported for the CURRENT mode only: preview (shadow) figures
  -- were never deducted and must not be added to real charges.
  v_enforced boolean;
  v_live   bigint := 0;
  v_ended  bigint := 0;
  v_live_until timestamptz;
  v_pending_expiry bigint := 0;
  result   jsonb;
begin
  if v_uid is null or v_co is null or not exists (
      select 1 from public.profiles p
        join public.entity_memberships m on m.user_id = p.id and m.entity_id = v_co
       where p.id = v_uid and p.is_active) then
    raise exception 'Active company membership required' using errcode = '42501';
  end if;
  v_admin := coalesce(public.is_admin_user(), false);

  select * into s from public.ai_billing_settings where id;
  v_state := case when not found or s.mode = 'off' then 'unconfigured'
                  when s.mode = 'shadow' then 'preview'
                  else 'active' end;
  v_enforced := (v_state = 'active');

  select * into sub from public.billing_subscriptions where company_entity_id = v_co;
  if sub.current_period_start is not null and sub.current_period_end is not null then
    v_start := sub.current_period_start; v_end := sub.current_period_end;
    v_period_source := 'subscription';
  else
    v_start := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
    v_end   := (date_trunc('month', now() at time zone 'UTC') + interval '1 month') at time zone 'UTC';
    v_period_source := 'calendar_month';
  end if;
  select included_ai_credit_micros into v_plan_included
    from public.billing_plans where plan_key = sub.plan_key;

  select * into acct from public.ai_credit_accounts where company_entity_id = v_co;
  -- The summary is read-only, so an allowance whose period has ended but has
  -- not been expired yet (no AI request since) is SHOWN as expired: it can no
  -- longer be spent, and the next request removes it from the ledger.
  -- Same arithmetic as ai_credit_expire_included, without writing.
  select coalesce(sum(remaining_micros) filter (where period_end >  now()), 0),
         coalesce(sum(remaining_micros) filter (where period_end <= now()), 0),
         min(period_end) filter (where period_end > now() and remaining_micros > 0)
    into v_live, v_ended, v_live_until
    from public.ai_credit_included_grants where company_entity_id = v_co;
  if acct.company_entity_id is not null then
    v_pending_expiry := greatest(0, v_ended - greatest(0, acct.held_micros - acct.purchased_micros - v_live));
  end if;

  result := jsonb_build_object(
    'state', v_state,
    'account_exists', acct.company_entity_id is not null,
    'available_micros', case when acct.company_entity_id is null then null
                             else acct.included_micros + acct.purchased_micros - acct.held_micros
                                  - v_pending_expiry end,
    'included_micros', acct.included_micros - v_pending_expiry,
    -- When the included allowance stops being spendable. Top-ups never expire.
    'included_expires_at', case when acct.included_micros - v_pending_expiry > 0 then v_live_until end,
    'purchased_micros', acct.purchased_micros,
    'pending_micros', acct.held_micros,
    'plan_included_micros', v_plan_included,
    'plan_key', sub.plan_key,
    'is_admin', v_admin,
    'can_top_up', coalesce(public.is_owner_admin_of_active_company(), false),
    'packs_configured', exists (select 1 from public.ai_credit_packs where is_active));

  if not v_admin then return result; end if;

  result := result || jsonb_build_object(
    'period', jsonb_build_object('start', v_start, 'end', v_end, 'source', v_period_source),
    'included_granted_this_period', (
      select sum(amount_micros) from public.ai_credit_ledger
       where company_entity_id = v_co and entry_type = 'included_grant'
         and period_start >= v_start and period_start < v_end),
    'used_this_period_micros', (
      select coalesce(sum(case when enforced then charged_micros
                               else coalesce(computed_charge_micros, 0) end), 0)
        from public.ai_credit_reservations
       where company_entity_id = v_co and status = 'settled' and outcome = 'succeeded'
         and enforced = v_enforced
         and settled_at >= v_start and settled_at < v_end),
    'usage_by_feature', coalesce((
      select jsonb_agg(jsonb_build_object(
               'feature', f.feature,
               'charged_micros', f.charged, 'succeeded', f.ok,
               'free_failures', f.failed, 'pending', f.pending, 'unpriced', f.unpriced)
             order by f.feature)
        from (select feature,
                     coalesce(sum(case when enforced then charged_micros
                                       else coalesce(computed_charge_micros,0) end)
                              filter (where status = 'settled' and outcome = 'succeeded'), 0) charged,
                     count(*) filter (where status = 'settled' and outcome = 'succeeded') ok,
                     count(*) filter (where status = 'settled' and outcome <> 'succeeded') failed,
                     count(*) filter (where status = 'held') pending,
                     count(*) filter (where rate_id is null) unpriced
                from public.ai_credit_reservations
               where company_entity_id = v_co and enforced = v_enforced
                 and (status = 'held' or (settled_at >= v_start and settled_at < v_end))
               group by feature) f), '[]'::jsonb),
    'purchases', coalesce((
      select jsonb_agg(jsonb_build_object('at', l.created_at, 'credit_micros', l.amount_micros,
                                          'pack', coalesce(p.title, l.pack_key))
                       order by l.created_at desc)
        from (select * from public.ai_credit_ledger
               where company_entity_id = v_co and entry_type = 'purchase_grant'
               order by created_at desc limit 12) l
        left join public.ai_credit_packs p on p.pack_key = l.pack_key), '[]'::jsonb));

  -- On Deck's tables are a separate migration; without them there is no card,
  -- and the rest of the summary must still be returned.
  begin
    result := result || jsonb_build_object('on_deck', (
      select jsonb_build_object(
               'enabled', o.enabled,
               -- The cap is an OPERATIONAL limit in provider dollars; showing
               -- it beside customer-priced credit would publish the multiplier.
               -- So only its state is returned here, never an amount.
               'cap_state', case
                  when o.monthly_cap_usd <= 0 then 'paused'
                  when spent.usd + 0.25 > o.monthly_cap_usd then 'paused'
                  when spent.usd >= 0.8 * o.monthly_cap_usd then 'near'
                  else 'within' end,
               'attempts_this_month', spent.n)
        from public.on_deck_settings o,
             lateral (select coalesce(sum(coalesce(a.cost_usd, a.reserved_usd)), 0) usd, count(*) n
                        from public.on_deck_attempts a
                       where a.company_entity_id = v_co
                         and a.created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC') spent
       where o.company_entity_id = v_co));
  exception when undefined_table then
    null;
  end;
  return result;
end $$;

-- ---------------------------------------------------------------------------
-- 9. Function privileges. Supabase re-grants EXECUTE on new public functions
--    to anon and authenticated by default; this is the boundary.
-- ---------------------------------------------------------------------------

do $$
declare f text;
begin
  foreach f in array array[
    'ai_credit_open(uuid,uuid,uuid,text,text,bigint,bigint,integer,integer,text)',
    'ai_credit_step(uuid,jsonb,bigint,bigint,integer)',
    'ai_credit_settle(uuid,jsonb,text,text)',
    'ai_credit_sweep(uuid,interval)',
    'ai_credit_add(uuid,text,bigint,text,text,text,text,text,text,text,timestamptz,timestamptz)',
    'ai_credit_grant_included(uuid,jsonb)',
    'ai_credit_grant_purchase(uuid,jsonb)',
    'ai_credit_reconcile(uuid)',
    'ai_credit_provider_cost(public.ai_provider_rates,jsonb)',
    'ai_credit_call_worst(public.ai_provider_rates,integer,bigint,bigint,integer)',
    'ai_credit_customer_micros(numeric,integer)',
    'ai_credit_usage_valid(jsonb)',
    'ai_credit_expire_included(uuid,timestamptz)',
    'ai_credit_take_included(uuid,bigint)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

revoke all on function public.ai_credit_summary() from public, anon;
grant execute on function public.ai_credit_summary() to authenticated, service_role;

-- Company stamp backstop (CLAUDE.md: required for any company_entity_id table).
select public.attach_stamp_company_entity_id_triggers();

-- Ask SILO's catalogue: these are SILO's billing plumbing, not business data.
insert into public.silo_chat_schema_catalog (relname, description, keywords, is_hidden)
values
  ('ai_credit_ledger', 'SILO AI-credit ledger (billing plumbing). Not readable by clients.', array['billing','internal'], true),
  ('ai_credit_accounts', 'SILO AI-credit balances (billing plumbing). Not readable by clients.', array['billing','internal'], true),
  ('ai_credit_reservations', 'SILO AI-credit holds and charges (billing plumbing). Not readable by clients.', array['billing','internal'], true),
  ('ai_credit_included_grants', 'SILO AI-credit included allowance per billing period (billing plumbing). Not readable by clients.', array['billing','internal'], true),
  ('ai_credit_packs', 'AI-credit top-up packs SILO sells. Global catalogue.', array['billing','internal'], true),
  ('ai_provider_rates', 'Private pricing configuration. Not readable by clients.', array['internal'], true),
  ('ai_billing_settings', 'Private billing configuration. Not readable by clients.', array['internal'], true)
on conflict (relname) do update
  set description = excluded.description, keywords = excluded.keywords, is_hidden = true;

select public.refresh_chat_schema_catalog();
