-- Affiliate Studio: badge a discovered prospect who has already bought.
--
-- Blake 2026-11-23: "Without muddying up or showing a lot of info on this,
-- we'd give a badge to the prospect, showing they have ordered in past".
-- So this adds ONE thing to the product: a past-customer flag on a prospect,
-- with the order count, last order and lifetime spend behind it. No new tab,
-- no queue, no hold on an outreach draft, nothing excluded automatically.
--
-- Two pieces, both generic (any company, any program):
--
-- 1. public.company_customer_profiles -- a precomputed, indexed, lowercased
--    customer lookup, one row per customer per company, built from
--    shopify_orders. It exists for SPEED: name search straight on the orders
--    table is what made the first hand-written query time out (and the
--    discount_codes detoast lesson of 20261112220000 is the same shape).
--    Every caller shares the 8s API statement timeout, so the refresh takes a
--    WINDOW of order dates and recomputes only the customers who ordered in
--    it -- totals are always recomputed from that customer's whole history, so
--    a partial window still stores a correct lifetime figure, and a re-run
--    changes nothing.
--
--    MEASURED on production 2026-11-23 before shipping this: written as one
--    aggregate joined to the window's customers, it plans a SEQ SCAN of the
--    company's whole order history (727,177 rows for Baseballism) and ran in
--    7.32s cold -- inside the 8s timeout by a quarter of a second, and growing
--    with every order taken. So the all-history side is a LATERAL per customer
--    instead, which the (company, customer key) index below drives, and the
--    cost then scales with how many customers ordered IN THE WINDOW rather
--    than with how many orders the company has ever taken. The nightly job
--    also halves a window that fails and retries each half once.
--
-- 2. public.affiliate_match_prospect_customers() -- matches the PROSPECTS of
--    one program against that lookup. It never scans the customer base
--    looking for creators; the prospect list is the driver, which is both the
--    cheap direction and the one Blake asked for.
--
-- Scoring is Blake's, verbatim: email ~0.95; exact name plus a supporting
-- signal 0.7-0.8; exact name alone ~0.5, reduced when that name is common in
-- that company's own customer base; surname-only or first-name-only does NOT
-- flag; a brand or channel name is recorded as "can't match". Orders inside 24
-- months count in full, older ones weaker. Where the company's own order
-- history does not reach back 24 months the score is capped and the basis says
-- so, because a miss there is not evidence of anything.
--
-- shopify_orders stores no city or state, so "same city or state" is not an
-- available supporting signal; the handle is.

-- ---------------------------------------------------------------- helpers

-- A comparable name: lowercased, accents left alone (unaccent is not
-- installed), punctuation dropped, whitespace collapsed. IMMUTABLE so it can
-- be read by an index and a generated comparison.
create or replace function public.silo_name_key(p_name text)
returns text language sql immutable as $$
  select nullif(btrim(regexp_replace(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9''\- ]+', ' ', 'g'), '\s+', ' ', 'g')), '')
$$;

-- Does this read as a person's name, as opposed to a brand, channel or shop?
-- Two or more alphabetic tokens and no trade marker. A single token ("Bougie")
-- is exactly the surname-only case Blake rejected by hand, so it is not a
-- person name for matching purposes either.
--
-- The marker list is generic trade vocabulary, not any one company's words.
create or replace function public.silo_looks_like_person_name(p_name text)
returns boolean language sql immutable as $$
  with k as (select public.silo_name_key(p_name) as v),
  t as (select regexp_split_to_array((select v from k), ' ') as parts)
  select case
    when (select v from k) is null then false
    when length((select v from k)) > 60 then false
    when array_length((select parts from t), 1) < 2 then false
    when exists (
      select 1 from unnest((select parts from t)) w
      where w !~ '^[a-z][a-z''\-]*$' or length(w) < 2
    ) then false
    when exists (
      select 1 from unnest((select parts from t)) w
      where w = any (array[
        'llc','inc','ltd','co','corp','company','store','stores','shop','shops','official',
        'tv','media','network','podcast','channel','team','club','academy','apparel','brand',
        'brands','studio','studios','gear','supply','supplies','clothing','outfitters','group',
        'collective','agency','productions','sports','shoppe','merch','threads','prints','designs'
      ])
    ) then false
    else true
  end
$$;

-- ---------------------------------------------- the customer lookup table

create table if not exists public.company_customer_profiles (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,

  -- One row per customer. The key is the lowercased email where there is one,
  -- otherwise the store's own customer id -- a guest checkout with no account
  -- still has an email, and an account with no email still has an id.
  customer_key      text not null,
  customer_id       text,
  email_lc          text,

  -- Comparison forms, stored so a match is an index lookup and never a scan.
  name_lc           text,
  first_name_lc     text,
  last_name_lc      text,

  order_count       integer not null default 0,
  orders_recent     integer not null default 0,   -- inside the recency window
  first_order_at    timestamptz,
  last_order_at     timestamptz,
  lifetime_spend    numeric not null default 0,

  source            text not null default 'shopify',
  updated_at        timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  unique (company_entity_id, customer_key)
);

create index if not exists company_customer_profiles_email_idx
  on public.company_customer_profiles (company_entity_id, email_lc) where email_lc is not null;
create index if not exists company_customer_profiles_name_idx
  on public.company_customer_profiles (company_entity_id, name_lc) where name_lc is not null;

alter table public.company_customer_profiles enable row level security;

-- The company's own customer facts, which the same people can already read
-- straight off shopify_orders. Reads only: every write is the refresh
-- function below, running as its owner.
drop policy if exists company_customer_profiles_active_select on public.company_customer_profiles;
create policy company_customer_profiles_active_select
  on public.company_customer_profiles for select to authenticated
  using (company_entity_id = public.active_company_id());

-- Reads only, and never by anon: Supabase's own default privileges grant every
-- client role everything on a new table, so what must be withheld is revoked
-- here. The lookup is written by the refresh function alone.
revoke all on public.company_customer_profiles from anon;
revoke insert, update, delete on public.company_customer_profiles from authenticated;
grant all on public.company_customer_profiles to service_role;

-- How far back the lookup has been built for a company. The frontier is state,
-- not a derived number: a customer touched by a recent window can have a
-- first order years earlier, so min(first_order_at) would read as coverage
-- the build never did.
create table if not exists public.company_customer_profile_state (
  company_entity_id uuid primary key references public.entities(id) on delete cascade,
  covered_from      timestamptz,
  last_refreshed_at timestamptz,
  customers         integer not null default 0
);

alter table public.company_customer_profile_state enable row level security;

drop policy if exists company_customer_profile_state_active_select on public.company_customer_profile_state;
create policy company_customer_profile_state_active_select
  on public.company_customer_profile_state for select to authenticated
  using (company_entity_id = public.active_company_id());

revoke all on public.company_customer_profile_state from anon;
revoke insert, update, delete on public.company_customer_profile_state from authenticated;
grant all on public.company_customer_profile_state to service_role;

-- The orders-side indexes the refresh needs. The customer-key expression here
-- must stay IDENTICAL to the one in refresh_company_customer_profiles(), or
-- the planner silently stops using it and the refresh goes back to scanning
-- (the 20261112220000 lesson).
create index if not exists shopify_orders_co_customer_key_idx
  on public.shopify_orders (
    company_entity_id,
    (coalesce(nullif(lower(btrim(customer_email)), ''), 'cid:' || customer_id))
  )
  where customer_email is not null or customer_id is not null;

-- ------------------------------------------------- the prospect's own flag

alter table public.affiliate_prospects
  add column if not exists customer_match_status text not null default 'unknown',
  add column if not exists customer_match_score numeric(4,3),
  add column if not exists customer_match_basis text,
  add column if not exists customer_match_key text,
  add column if not exists customer_match_customer_id text,
  add column if not exists customer_order_count integer,
  add column if not exists customer_last_order_at timestamptz,
  add column if not exists customer_lifetime_spend numeric,
  add column if not exists customer_matched_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'affiliate_prospects_customer_match_status_chk') then
    alter table public.affiliate_prospects
      add constraint affiliate_prospects_customer_match_status_chk
      check (customer_match_status in ('unknown','none','possible','likely','confirmed','not_matchable'));
  end if;
  -- A score with no written basis is a number someone will later mistake for a
  -- measurement, the same rule the confidence column already carries.
  if not exists (select 1 from pg_constraint where conname = 'affiliate_prospects_customer_match_basis_chk') then
    alter table public.affiliate_prospects
      add constraint affiliate_prospects_customer_match_basis_chk
      check (customer_match_score is null or customer_match_basis is not null);
  end if;
end $$;

comment on column public.affiliate_prospects.customer_match_status is
  'Has this prospect already bought? unknown = not looked at yet, not_matchable = a brand or channel name, confirmed = a person said so. Written by affiliate_match_prospect_customers().';

-- --------------------------------------------------------- the refresh

-- Rebuild the lookup for the customers who ordered inside [p_since, p_until).
-- Totals come from each touched customer's WHOLE history, so the window only
-- decides whose row is rewritten.
create or replace function public.refresh_company_customer_profiles(
  p_company uuid,
  p_since   timestamptz,
  p_until   timestamptz default null,
  p_recent_months integer default 24
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_until  timestamptz := coalesce(p_until, now() + interval '1 day');
  v_recent timestamptz := now() - make_interval(months => greatest(coalesce(p_recent_months, 24), 1));
  v_rows   integer := 0;
  v_total  integer := 0;
begin
  if p_company is null or p_since is null then
    raise exception 'refresh_company_customer_profiles: company and since are required';
  end if;

  with touched as (
    select distinct coalesce(nullif(lower(btrim(o.customer_email)), ''), 'cid:' || o.customer_id) as customer_key
      from public.shopify_orders o
     where o.company_entity_id = p_company
       and o.shopify_created_at >= p_since
       and o.shopify_created_at <  v_until
       and o.cancelled_at is null
       and (o.customer_email is not null or o.customer_id is not null)
  ),
  -- One index-driven pass per customer the window touched, NOT one aggregate
  -- over the company's whole order history: see the measurement in the header.
  -- The key expression here is the one shopify_orders_co_customer_key_idx
  -- carries; they must stay identical.
  agg as (
    select t.customer_key, a.customer_id, a.email_lc, a.customer_name,
           a.order_count, a.orders_recent, a.first_order_at, a.last_order_at, a.lifetime_spend
      from touched t
      cross join lateral (
        select (array_agg(nullif(btrim(o.customer_id), '') order by o.shopify_created_at desc nulls last))[1] as customer_id,
               (array_agg(nullif(lower(btrim(o.customer_email)), '') order by o.shopify_created_at desc nulls last))[1] as email_lc,
               (array_agg(nullif(btrim(o.customer_name), '') order by o.shopify_created_at desc nulls last))[1] as customer_name,
               count(*)::int as order_count,
               count(*) filter (where o.shopify_created_at >= v_recent)::int as orders_recent,
               min(o.shopify_created_at) as first_order_at,
               max(o.shopify_created_at) as last_order_at,
               coalesce(sum(o.total_price), 0) as lifetime_spend
          from public.shopify_orders o
         where o.company_entity_id = p_company
           and o.cancelled_at is null
           and coalesce(nullif(lower(btrim(o.customer_email)), ''), 'cid:' || o.customer_id) = t.customer_key
      ) a
     where a.order_count > 0
  )
  insert into public.company_customer_profiles as t (
    company_entity_id, customer_key, customer_id, email_lc,
    name_lc, first_name_lc, last_name_lc,
    order_count, orders_recent, first_order_at, last_order_at, lifetime_spend, source, updated_at
  )
  select p_company, a.customer_key, a.customer_id, a.email_lc,
         public.silo_name_key(a.customer_name),
         nullif(split_part(public.silo_name_key(a.customer_name), ' ', 1), ''),
         nullif(regexp_replace(coalesce(public.silo_name_key(a.customer_name), ''), '^.* ', ''), ''),
         a.order_count, a.orders_recent, a.first_order_at, a.last_order_at, a.lifetime_spend,
         'shopify', now()
    from agg a
  on conflict (company_entity_id, customer_key) do update
    set customer_id    = coalesce(excluded.customer_id, t.customer_id),
        email_lc       = coalesce(excluded.email_lc, t.email_lc),
        name_lc        = coalesce(excluded.name_lc, t.name_lc),
        first_name_lc  = coalesce(excluded.first_name_lc, t.first_name_lc),
        last_name_lc   = coalesce(excluded.last_name_lc, t.last_name_lc),
        order_count    = excluded.order_count,
        orders_recent  = excluded.orders_recent,
        first_order_at = excluded.first_order_at,
        last_order_at  = excluded.last_order_at,
        lifetime_spend = excluded.lifetime_spend,
        updated_at     = now();
  get diagnostics v_rows = row_count;

  select count(*)::int into v_total
    from public.company_customer_profiles where company_entity_id = p_company;

  insert into public.company_customer_profile_state (company_entity_id, covered_from, last_refreshed_at, customers)
  values (p_company, p_since, now(), v_total)
  on conflict (company_entity_id) do update
    set covered_from      = least(coalesce(company_customer_profile_state.covered_from, excluded.covered_from), excluded.covered_from),
        last_refreshed_at = now(),
        customers         = excluded.customers;

  return jsonb_build_object(
    'company_entity_id', p_company,
    'since', p_since, 'until', v_until,
    'customers_written', v_rows,
    'customers_total', v_total
  );
end $$;

revoke all on function public.refresh_company_customer_profiles(uuid, timestamptz, timestamptz, integer) from public, anon, authenticated;
-- The nightly job is the caller, so the grant is explicit rather than left to
-- whatever Supabase's default privileges happen to be.
grant execute on function public.refresh_company_customer_profiles(uuid, timestamptz, timestamptz, integer) to service_role;

-- --------------------------------------------------------- the matcher

-- Match one program's prospects against the lookup. Driven by the prospect
-- list, capped, and idempotent: a prospect whose name, handle and email have
-- not changed gets the same answer, and a human 'confirmed' is never
-- overwritten.
create or replace function public.affiliate_match_prospect_customers(
  p_program uuid,
  p_limit   integer default 500,
  p_recheck_after interval default interval '7 days'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company       uuid;
  v_recent        timestamptz := now() - interval '24 months';
  v_history_from  timestamptz;
  v_history_short boolean := false;
  r               record;
  m               public.company_customer_profiles;
  v_namesakes     integer;
  v_handle        text;
  v_name          text;
  v_first         text;
  v_last          text;
  v_score         numeric;
  v_basis         text;
  v_status        text;
  v_checked       integer := 0;
  v_likely        integer := 0;
  v_possible      integer := 0;
begin
  select company_entity_id into v_company from public.affiliate_programs where id = p_program;
  if v_company is null then
    raise exception 'affiliate_match_prospect_customers: unknown program %', p_program;
  end if;

  -- How far the company's own order history actually reaches. Nothing can be
  -- read into a miss before this date, and a short history caps every score.
  select min(first_order_at) into v_history_from
    from public.company_customer_profiles where company_entity_id = v_company;
  v_history_short := v_history_from is null or v_history_from > v_recent;

  for r in
    select p.id, p.display_name, p.handle, p.contact_email, p.customer_match_status
      from public.affiliate_prospects p
     where p.program_id = p_program
       and p.company_entity_id = v_company
       and p.status in ('new', 'qualified', 'approved', 'invited')
       and p.customer_match_status <> 'confirmed'
       and (p.customer_matched_at is null or p.customer_matched_at < now() - p_recheck_after)
     -- Never-matched first: with a cap, a program that keeps adding creators
     -- must not starve the ones that have never been looked at.
     order by p.customer_matched_at asc nulls first, p.collected_at desc
     limit greatest(coalesce(p_limit, 500), 1)
  loop
    v_checked := v_checked + 1;
    v_score := null; v_basis := null; v_status := 'none';
    v_name := public.silo_name_key(r.display_name);
    v_handle := public.silo_name_key(replace(replace(coalesce(r.handle, ''), '@', ' '), '_', ' '));
    v_first := nullif(split_part(coalesce(v_name, ''), ' ', 1), '');
    v_last  := nullif(regexp_replace(coalesce(v_name, ''), '^.* ', ''), '');

    -- 1. The email, when the prospect has one. The only strong signal, and
    --    most discovered creators have no public address at all.
    m := null;
    if r.contact_email is not null then
      select * into m from public.company_customer_profiles c
       where c.company_entity_id = v_company
         and c.email_lc = lower(btrim(r.contact_email))
       order by c.last_order_at desc nulls last limit 1;
      if m.id is not null then
        v_score := 0.95;
        v_basis := 'their public email address is a customer of yours';
      end if;
    end if;

    -- 2. Otherwise the name -- but only a name that reads as a person's.
    if m.id is null and v_name is not null then
      if not public.silo_looks_like_person_name(r.display_name) then
        -- One token is the surname-only (or first-name-only) case Blake
        -- rejected by hand: it is not evidence either way, so it says nothing
        -- rather than claiming the name is a brand.
        if array_length(regexp_split_to_array(v_name, ' '), 1) < 2 then
          v_status := 'none';
        else
          v_status := 'not_matchable';
          v_basis  := 'this is a brand or channel name, so it cannot be matched to a customer';
        end if;
      else
        select count(*)::int into v_namesakes
          from public.company_customer_profiles c
         where c.company_entity_id = v_company and c.name_lc = v_name;

        if v_namesakes > 0 then
          select * into m from public.company_customer_profiles c
           where c.company_entity_id = v_company and c.name_lc = v_name
           order by c.last_order_at desc nulls last limit 1;

          -- A supporting signal: the handle carries the name too.
          if v_handle is not null and v_first is not null and v_last is not null
             and replace(v_handle, ' ', '') like '%' || v_first || v_last || '%' then
            v_score := 0.80;
            v_basis := 'exact name match, and their handle carries the same name';
          elsif v_handle is not null and (
                (length(coalesce(v_last, '')) >= 4 and replace(v_handle, ' ', '') like '%' || v_last || '%')
             or (length(coalesce(v_first, '')) >= 4 and replace(v_handle, ' ', '') like '%' || v_first || '%')) then
            v_score := 0.72;
            v_basis := 'exact name match, with the name in their handle too';
          elsif v_namesakes = 1 then
            v_score := 0.50;
            v_basis := 'exact name match on one customer, name only';
          elsif v_namesakes <= 3 then
            v_score := 0.40;
            v_basis := format('exact name match, but %s customers share that name', v_namesakes);
          else
            v_score := 0.30;
            v_basis := format('exact name match, but %s customers share that name', v_namesakes);
          end if;
        end if;
      end if;
    end if;

    -- 3. Recency. Orders inside 24 months count in full; an older last order
    --    is a weaker signal, not a disqualifying one.
    if v_score is not null and m.id is not null and (m.last_order_at is null or m.last_order_at < v_recent) then
      v_score := round(v_score * 0.8, 3);
      v_basis := v_basis || '; last order over 2 years ago';
    end if;

    -- 4. A short order history caps the confidence either way.
    if v_score is not null and v_history_short then
      if v_score > 0.60 then v_score := 0.60; end if;
      v_basis := v_basis || '; history incomplete, your orders do not reach back 2 years';
    end if;

    if v_status <> 'not_matchable' then
      v_status := case
        when v_score is null then 'none'
        when v_score >= 0.70 then 'likely'
        when v_score >= 0.30 then 'possible'
        else 'none' end;
    end if;
    if v_status = 'likely' then v_likely := v_likely + 1;
    elsif v_status = 'possible' then v_possible := v_possible + 1; end if;

    update public.affiliate_prospects p
       set customer_match_status = v_status,
           customer_match_score  = case when v_status in ('possible','likely') then v_score else null end,
           customer_match_basis  = case when v_status in ('possible','likely','not_matchable') then v_basis else null end,
           customer_match_key    = case when v_status in ('possible','likely') then m.customer_key else null end,
           customer_match_customer_id = case when v_status in ('possible','likely') then m.customer_id else null end,
           customer_order_count  = case when v_status in ('possible','likely') then m.order_count else null end,
           customer_last_order_at = case when v_status in ('possible','likely') then m.last_order_at else null end,
           customer_lifetime_spend = case when v_status in ('possible','likely') then m.lifetime_spend else null end,
           customer_matched_at   = now()
     where p.id = r.id;
  end loop;

  return jsonb_build_object(
    'program_id', p_program,
    'prospects_checked', v_checked,
    'likely', v_likely,
    'possible', v_possible,
    'history_from', v_history_from,
    'history_incomplete', v_history_short
  );
end $$;

revoke all on function public.affiliate_match_prospect_customers(uuid, integer, interval) from public, anon, authenticated;
grant execute on function public.affiliate_match_prospect_customers(uuid, integer, interval) to service_role;

select public.attach_stamp_company_entity_id_triggers();
-- Ask SILO's schema map, since this adds public tables and columns.
select public.refresh_chat_schema_catalog();
