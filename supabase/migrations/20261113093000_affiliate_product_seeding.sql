-- Affiliate Studio: product seeding.
--
-- Blake, 2026-11-13: "product seeding: ... 50% off -- (select items to get
-- reimbursed if goal hit) half off, hit 3x of that in sales, receive the half
-- off item back on specific products or pushes", and on the open questions:
-- "refund has a 14 day window not forever, seeding order does not count
-- towards goal, has to be on that shared product or private request ...
-- product codes have to be approved so they can request as many as they'd
-- like, product 50% are one time use."
--
-- THE DEAL. An affiliate buys a product at a discount (program setting,
-- default 50%) with a one-use code locked to them. When sales of THAT product
-- on their own affiliate code reach a multiple of what they paid (default 3x),
-- what they paid comes back to them -- as an ordinary ledger line, so it rides
-- the existing balance -> payout -> approval rails. No new money path.
--
-- THE RULES, each enforced here:
--   * The affiliate asks (a product the brand shared, or a private request by
--     name); a program manager APPROVES each request before any code exists.
--   * A seed code is NOT an affiliate code. It lives on the claim, never in
--     affiliate_codes, so the commission resolver cannot see it: buying at half
--     price on your own code earns no commission, by construction.
--   * One use, this product only, this affiliate's email only -- written into
--     the instructions the brand's own AI follows to create it in Shopify
--     (silo_api_codes_to_create, 20261113094000). SILO writes nothing to Shopify.
--   * The seed order never counts toward the goal.
--   * A sale counts toward the goal only once its refund window (default 14
--     days) has passed, net of what was refunded. After the payback is earned
--     nothing is clawed back.
--   * The payback is written ONCE: reimbursement_ledger_id is unique, the claim
--     row is locked, and the program's money lock is held while it is written.

-- ── 1. Program settings ───────────────────────────────────────────────────
alter table public.affiliate_programs
  add column if not exists seeding_enabled boolean not null default true,
  add column if not exists seed_discount_percent numeric not null default 50,
  add column if not exists seed_multiple numeric not null default 3,
  add column if not exists seed_refund_days integer not null default 14,
  add column if not exists seed_goal_days integer not null default 90;

alter table public.affiliate_programs drop constraint if exists affiliate_programs_seed_terms;
alter table public.affiliate_programs add constraint affiliate_programs_seed_terms check (
  seed_discount_percent > 0 and seed_discount_percent <= 100
  and seed_multiple >= 1 and seed_multiple <= 20
  and seed_refund_days between 0 and 90
  and seed_goal_days between 7 and 365);

comment on column public.affiliate_programs.seeding_enabled is
  'Affiliates may ask for a product at the seeding discount. Every request still needs a manager''s approval. 20261113093000.';
comment on column public.affiliate_programs.seed_discount_percent is
  'Percent off a seeded product (one-use code). 20261113093000.';
comment on column public.affiliate_programs.seed_multiple is
  'Sales of the seeded product on the affiliate''s own code needed to earn back what they paid, as a multiple of it. 20261113093000.';
comment on column public.affiliate_programs.seed_refund_days is
  'A sale counts toward a seeding goal only once this many days have passed since the order, net of refunds. 20261113093000.';
comment on column public.affiliate_programs.seed_goal_days is
  'Days after the seed purchase to reach the goal; after that the claim expires and nothing is paid back. 20261113093000.';

-- ── 2. Claims ─────────────────────────────────────────────────────────────
create table if not exists public.affiliate_seed_claims (
  id                 uuid primary key default gen_random_uuid(),
  company_entity_id  uuid not null references public.entities(id) on delete cascade,
  program_id         uuid not null references public.affiliate_programs(id) on delete cascade,
  affiliate_id       uuid not null references public.affiliates(id) on delete cascade,
  -- The shared product it was asked from; NULL for a private request. The
  -- title and path are snapshots, so unsharing the product later does not
  -- change what was agreed.
  feed_item_id       uuid references public.affiliate_feed_items(id) on delete set null,
  product_title      text not null,
  product_path       text,
  note               text,
  state              text not null default 'requested',
  -- The terms, frozen at request time.
  discount_percent   numeric not null,
  multiple           numeric not null,
  refund_days        integer not null,
  goal_days          integer not null,
  -- The one-use code, made on approval. customer_email is who the brand's AI
  -- locks it to: the affiliate's payout email, which is also where the payback
  -- goes, else their contact email.
  code               text,
  customer_email     text,
  shopify_discount_id text,
  code_created_at    timestamptz,
  code_created_by_grant_id uuid,      -- silo_api_grants.id of the connection that recorded it
  code_created_via_app text,
  -- The purchase, and the goal it sets.
  seed_order_id      text,
  seed_order_number  text,
  seed_order_day     date,
  currency           text,
  seed_paid_cents    bigint,
  goal_cents         bigint,
  goal_by            date,
  progress_cents     bigint not null default 0,
  progress_as_of     timestamptz,
  earned_at          timestamptz,
  reimbursement_ledger_id uuid references public.affiliate_commission_ledger(id),
  requested_at       timestamptz not null default now(),
  decided_at         timestamptz,
  decided_by         uuid references public.profiles(id),
  constraint affiliate_seed_claims_state check (state in
    ('requested', 'approved', 'code_ready', 'purchased', 'earned', 'expired', 'declined', 'cancelled')),
  constraint affiliate_seed_claims_title check (length(btrim(product_title)) between 1 and 200),
  constraint affiliate_seed_claims_note check (note is null or length(note) <= 500),
  constraint affiliate_seed_claims_path check (product_path is null or (product_path ~ '^/[A-Za-z0-9/_.~%-]*$' and product_path !~ '^//' and length(product_path) <= 300)),
  constraint affiliate_seed_claims_terms check (discount_percent > 0 and discount_percent <= 100 and multiple >= 1 and refund_days >= 0 and goal_days >= 1),
  constraint affiliate_seed_claims_code check (code is null or code ~ '^[A-Z0-9]{4,30}$'),
  constraint affiliate_seed_claims_code_when check (state in ('requested', 'declined', 'cancelled') or code is not null),
  constraint affiliate_seed_claims_paid check (seed_paid_cents is null or seed_paid_cents >= 0),
  constraint affiliate_seed_claims_currency check (currency is null or currency ~ '^[A-Z]{3}$'),
  constraint affiliate_seed_claims_discount_id check (shopify_discount_id is null or shopify_discount_id ~ '^gid://shopify/DiscountCodeNode/[0-9]{1,20}$'),
  -- Earned means paid back, and paid back means earned: the two never part.
  constraint affiliate_seed_claims_earned check ((state = 'earned') = (reimbursement_ledger_id is not null)),
  constraint affiliate_seed_claims_id_company_key unique (id, company_entity_id)
);

-- Once, whatever re-runs: one ledger line can pay back one claim.
create unique index if not exists affiliate_seed_claims_payback_once
  on public.affiliate_seed_claims (reimbursement_ledger_id) where reimbursement_ledger_id is not null;
-- A code names one claim in its company.
create unique index if not exists affiliate_seed_claims_code_once
  on public.affiliate_seed_claims (company_entity_id, code) where code is not null;
-- One seed order buys one claim.
create unique index if not exists affiliate_seed_claims_order_once
  on public.affiliate_seed_claims (company_entity_id, seed_order_id) where seed_order_id is not null;
create index if not exists affiliate_seed_claims_open
  on public.affiliate_seed_claims (company_entity_id, program_id, state);
create index if not exists affiliate_seed_claims_affiliate
  on public.affiliate_seed_claims (company_entity_id, affiliate_id, requested_at desc);

alter table public.affiliate_seed_claims enable row level security;

drop policy if exists affiliate_seed_claims_select on public.affiliate_seed_claims;
create policy affiliate_seed_claims_select on public.affiliate_seed_claims
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- No write policy: every change goes through a function below, which judges
-- the caller. A client role reads, and only reads.
revoke all on public.affiliate_seed_claims from anon, authenticated;
grant select on public.affiliate_seed_claims to authenticated;

comment on table public.affiliate_seed_claims is
  'Product seeding: an affiliate asked for a product at the seeding discount (a shared product or a private request). A manager approves it, which makes a one-use code locked to the affiliate and the product; the brand''s own AI creates it in Shopify. When sales of that product on the affiliate''s own code reach the multiple of what they paid (refund window passed, seed order excluded), what they paid is written back once as a manual_adjustment on affiliate_commission_ledger and paid through the normal payout approval. A seed code is never an affiliate code and earns no commission. 20261113093000.';

-- ── 3. The affiliate asks (portal, service role) ──────────────────────────
create or replace function public.affiliate_portal_seed_request(
  p_token_hash text, p_feed_item_id uuid, p_title text, p_note text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_tok   record;
  v_prog  record;
  v_item_id   uuid;
  v_item_path text;
  v_title text;
  v_open  integer;
  v_id    uuid;
begin
  select t.company_entity_id, t.program_id, t.affiliate_id into v_tok
    from public.affiliate_access_tokens t
    join public.affiliates a
      on a.id = t.affiliate_id and a.company_entity_id = t.company_entity_id and a.program_id = t.program_id
   where t.token_hash = p_token_hash
     and t.purpose = 'portal'
     and t.revoked_at is null
     and t.expires_at > now()
     and a.status = 'active';
  if not found then
    raise exception 'affiliate_portal_seed_request: link is not valid' using errcode = '42501';
  end if;

  select p.* into v_prog from public.affiliate_programs p
   where p.id = v_tok.program_id and p.company_entity_id = v_tok.company_entity_id;
  if not v_prog.seeding_enabled or v_prog.status <> 'active' then
    raise exception 'affiliate_portal_seed_request: this program is not offering products right now' using errcode = '22023';
  end if;

  if p_feed_item_id is not null then
    select f.id, f.title, f.product_path into v_item_id, v_title, v_item_path
      from public.affiliate_feed_items f
     where f.id = p_feed_item_id
       and f.company_entity_id = v_tok.company_entity_id
       and f.program_id = v_tok.program_id
       and f.kind = 'product';
    if not found then
      raise exception 'affiliate_portal_seed_request: no such product' using errcode = '42501';
    end if;
  else
    v_title := left(btrim(coalesce(p_title, '')), 200);
    if v_title = '' then
      raise exception 'affiliate_portal_seed_request: name the product you want' using errcode = '22023';
    end if;
  end if;

  -- As many as they like (Blake), but not a flood: a person approves each.
  select count(*) into v_open from public.affiliate_seed_claims c
   where c.company_entity_id = v_tok.company_entity_id and c.affiliate_id = v_tok.affiliate_id
     and c.state = 'requested';
  if v_open >= 25 then
    raise exception 'affiliate_portal_seed_request: you have 25 requests waiting; wait for the brand to answer' using errcode = '22023';
  end if;

  -- The same shared product asked twice while still open is the same request.
  if v_item_id is not null then
    select c.id into v_id from public.affiliate_seed_claims c
     where c.company_entity_id = v_tok.company_entity_id and c.affiliate_id = v_tok.affiliate_id
       and c.feed_item_id = v_item_id and c.state in ('requested', 'approved', 'code_ready');
    if v_id is not null then
      return jsonb_build_object('id', v_id, 'state', (select state from public.affiliate_seed_claims where id = v_id), 'replayed', true);
    end if;
  end if;

  insert into public.affiliate_seed_claims
    (company_entity_id, program_id, affiliate_id, feed_item_id, product_title, product_path, note,
     discount_percent, multiple, refund_days, goal_days)
  values (v_tok.company_entity_id, v_tok.program_id, v_tok.affiliate_id, v_item_id, v_title,
          v_item_path,
          nullif(left(btrim(coalesce(p_note, '')), 500), ''),
          v_prog.seed_discount_percent, v_prog.seed_multiple, v_prog.seed_refund_days, v_prog.seed_goal_days)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'state', 'requested', 'replayed', false);
end;
$$;

revoke all on function public.affiliate_portal_seed_request(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.affiliate_portal_seed_request(text, uuid, text, text) to service_role;

-- The affiliate's own claims and the program's terms, for the portal.
create or replace function public.affiliate_portal_seeds(p_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tok  record;
  v_prog record;
begin
  select t.company_entity_id, t.program_id, t.affiliate_id into v_tok
    from public.affiliate_access_tokens t
    join public.affiliates a
      on a.id = t.affiliate_id and a.company_entity_id = t.company_entity_id and a.program_id = t.program_id
   where t.token_hash = p_token_hash
     and t.purpose = 'portal'
     and t.revoked_at is null
     and t.expires_at > now()
     and a.status in ('active', 'paused');
  if not found then
    return null;
  end if;
  select p.seeding_enabled, p.status, p.seed_discount_percent, p.seed_multiple, p.seed_refund_days, p.seed_goal_days
    into v_prog
    from public.affiliate_programs p where p.id = v_tok.program_id and p.company_entity_id = v_tok.company_entity_id;

  return jsonb_build_object(
    'offer', jsonb_build_object(
      'enabled', v_prog.seeding_enabled and v_prog.status = 'active',
      'percent', v_prog.seed_discount_percent, 'multiple', v_prog.seed_multiple,
      'refund_days', v_prog.seed_refund_days, 'goal_days', v_prog.seed_goal_days),
    'claims', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'feed_item_id', c.feed_item_id, 'title', c.product_title, 'state', c.state,
               'percent', c.discount_percent, 'multiple', c.multiple,
               -- The code only once it is real in the shop, and only while it
               -- is still theirs to use.
               'code', case when c.state = 'code_ready' then c.code end,
               'email', case when c.state in ('approved', 'code_ready') then c.customer_email end,
               'currency', c.currency, 'paid_cents', c.seed_paid_cents, 'goal_cents', c.goal_cents,
               'progress_cents', c.progress_cents, 'goal_by', c.goal_by, 'earned_at', c.earned_at,
               'requested_at', c.requested_at)
             order by c.requested_at desc)
        from public.affiliate_seed_claims c
       where c.company_entity_id = v_tok.company_entity_id and c.affiliate_id = v_tok.affiliate_id
         and c.program_id = v_tok.program_id), '[]'::jsonb));
end;
$$;

revoke all on function public.affiliate_portal_seeds(text) from public, anon, authenticated;
grant execute on function public.affiliate_portal_seeds(text) to service_role;

-- ── 4. A manager decides ─────────────────────────────────────────────────
-- Several at once, so "Approve all" is one press. Approving makes the code.
create or replace function public.affiliate_seed_decide(p_claims uuid[], p_approve boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid := public.active_company_id();
  v_c       record;
  v_code    text;
  v_email   text;
  v_stem    text;
  v_tries   integer;
  v_done    integer := 0;
  v_skipped integer := 0;
begin
  if v_company is null or not public.can_manage_affiliate_programs() then
    raise exception 'affiliate_seed_decide: only an Affiliate Studio manager can answer a product request' using errcode = '42501';
  end if;

  for v_c in
    select c.*, a.display_name, a.contact_email
      from public.affiliate_seed_claims c
      join public.affiliates a on a.id = c.affiliate_id and a.company_entity_id = c.company_entity_id
     where c.id = any(coalesce(p_claims, '{}'::uuid[]))
       and c.company_entity_id = v_company
     for update of c
  loop
    if v_c.state <> 'requested' then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    if not coalesce(p_approve, false) then
      update public.affiliate_seed_claims
         set state = 'declined', decided_at = now(), decided_by = auth.uid()
       where id = v_c.id;
      v_done := v_done + 1;
      continue;
    end if;

    select nullif(btrim(pa.payout_email), '') into v_email
      from public.affiliate_payout_accounts pa
     where pa.affiliate_id = v_c.affiliate_id and pa.company_entity_id = v_company
       and nullif(btrim(pa.payout_email), '') is not null
     order by pa.created_at desc limit 1;
    v_email := lower(coalesce(v_email, nullif(btrim(v_c.contact_email), '')));
    if v_email is null then
      -- Nobody to lock the code to: leave it waiting rather than make a
      -- code anyone could use.
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_stem := left(upper(regexp_replace(coalesce(v_c.display_name, ''), '[^A-Za-z0-9]', '', 'g')), 10);
    v_tries := 0;
    loop
      v_code := v_stem || 'SEED' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 5));
      exit when not exists (select 1 from public.affiliate_seed_claims s where s.company_entity_id = v_company and s.code = v_code)
            and not exists (select 1 from public.affiliate_codes ac where ac.company_entity_id = v_company and ac.code = v_code);
      v_tries := v_tries + 1;
      if v_tries > 5 then
        raise exception 'affiliate_seed_decide: could not make a unique code' using errcode = '23505';
      end if;
    end loop;

    update public.affiliate_seed_claims
       set state = 'approved', code = v_code, customer_email = v_email,
           decided_at = now(), decided_by = auth.uid()
     where id = v_c.id;
    v_done := v_done + 1;
  end loop;

  return jsonb_build_object('decided', v_done, 'skipped', v_skipped);
end;
$$;

revoke all on function public.affiliate_seed_decide(uuid[], boolean) from public, anon;
grant execute on function public.affiliate_seed_decide(uuid[], boolean) to authenticated;

-- A manager may withdraw a claim that has not been paid back.
create or replace function public.affiliate_seed_cancel(p_claim uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid := public.active_company_id();
  v_n integer;
begin
  if v_company is null or not public.can_manage_affiliate_programs() then
    raise exception 'affiliate_seed_cancel: only an Affiliate Studio manager can cancel' using errcode = '42501';
  end if;
  update public.affiliate_seed_claims
     set state = 'cancelled', decided_at = coalesce(decided_at, now()), decided_by = coalesce(decided_by, auth.uid())
   where id = p_claim and company_entity_id = v_company
     and state in ('requested', 'approved', 'code_ready', 'purchased');
  get diagnostics v_n = row_count;
  return jsonb_build_object('cancelled', v_n = 1);
end;
$$;

revoke all on function public.affiliate_seed_cancel(uuid) from public, anon;
grant execute on function public.affiliate_seed_cancel(uuid) to authenticated;

-- ── 5. The sweep: purchase, progress, payback, expiry ─────────────────────
-- Called for each active program right after commissions are accrued
-- (scripts/lib/affiliate-commissions-core.mjs), with the service role.
-- Idempotent: every step re-derives from orders and is guarded by state.
create or replace function public.affiliate_seed_sweep(p_program uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_prog     record;
  v_today    date;
  v_c        record;
  v_o        record;
  v_paid     numeric;
  v_minor    integer;
  v_progress bigint;
  v_ledger   uuid;
  v_bought   integer := 0;
  v_earned   integer := 0;
  v_expired  integer := 0;
begin
  select p.id, p.company_entity_id into v_prog from public.affiliate_programs p where p.id = p_program;
  if not found then
    return jsonb_build_object('error', 'no such program');
  end if;
  v_today := (now() at time zone public.silo_company_timezone(v_prog.company_entity_id))::date;

  -- a. The seed purchase: the first uncancelled order carrying the claim's
  --    code, placed after it was approved. What they PAID for the product is
  --    the basis -- not its list price.
  for v_c in
    select c.* from public.affiliate_seed_claims c
     where c.program_id = p_program and c.company_entity_id = v_prog.company_entity_id
       and c.state in ('approved', 'code_ready') and c.code is not null
     for update
  loop
    select o.order_id, o.order_number, o.currency, o.subtotal_price,
           (o.shopify_created_at at time zone public.silo_company_timezone(o.company_entity_id))::date as order_day
      into v_o
      from public.shopify_orders o
     where o.company_entity_id = v_prog.company_entity_id
       and o.cancelled_at is null
       and o.discount_codes is not null
       and o.shopify_created_at >= coalesce(v_c.decided_at, v_c.requested_at) - interval '1 day'
       and exists (select 1 from jsonb_array_elements_text(o.discount_codes) d(v) where upper(btrim(d.v)) = v_c.code)
       and not exists (select 1 from public.affiliate_seed_claims s
                        where s.company_entity_id = o.company_entity_id and s.seed_order_id = o.order_id)
     order by o.shopify_created_at
     limit 1;
    continue when v_o.order_id is null;

    v_minor := public.affiliate_currency_minor_units(v_o.currency);
    -- The product's own line(s): what the rep paid for THAT item. Never
    -- the order: other things in the same cart are theirs.
    select sum(l.price * l.quantity - coalesce(l.discount_allocated, 0))
      into v_paid
      from public.shopify_order_lines l
     where l.company_entity_id = v_prog.company_entity_id and l.order_id = v_o.order_id
       and lower(btrim(l.title)) = lower(btrim(v_c.product_title));
    -- A product renamed in the shop: the discounted line(s) are the one the
    -- one-product code applied to.
    if v_paid is null then
      select sum(l.price * l.quantity - coalesce(l.discount_allocated, 0))
        into v_paid
        from public.shopify_order_lines l
       where l.company_entity_id = v_prog.company_entity_id and l.order_id = v_o.order_id
         and coalesce(l.discount_allocated, 0) > 0;
    end if;
    -- No line to stand behind: leave it and look again tomorrow.
    continue when v_paid is null;
    v_paid := greatest(v_paid, 0);

    update public.affiliate_seed_claims
       set state = 'purchased', seed_order_id = v_o.order_id, seed_order_number = v_o.order_number,
           seed_order_day = v_o.order_day, currency = upper(v_o.currency),
           seed_paid_cents = round(v_paid * v_minor)::bigint,
           -- Sell the multiple of what they PAID (Blake: a $20 item takes $60 of
           -- sales to get the $20 back).
           goal_cents = round(v_paid * v_minor * v_c.multiple)::bigint,
           goal_by = v_o.order_day + v_c.goal_days
     where id = v_c.id;
    v_bought := v_bought + 1;
  end loop;

  -- b. Progress, then the payback. Sales of THIS product on orders credited
  --    to this affiliate's own code, after the seed order, in its currency,
  --    once the refund window has passed, net of the refunded share. The seed
  --    order itself never counts.
  for v_c in
    select c.* from public.affiliate_seed_claims c
     where c.program_id = p_program and c.company_entity_id = v_prog.company_entity_id
       and c.state = 'purchased'
     for update
  loop
    v_minor := public.affiliate_currency_minor_units(v_c.currency);
    select coalesce(round(sum(
             (l.price * l.quantity - coalesce(l.discount_allocated, 0))
             * case when coalesce(o.subtotal_price, 0) > 0
                    then greatest(0, 1 - coalesce(o.refunded_subtotal, 0) / o.subtotal_price) else 1 end
           ) * v_minor), 0)::bigint
      into v_progress
      from public.affiliate_attributions at
      join public.shopify_orders o
        on o.company_entity_id = at.company_entity_id and o.order_id = at.order_id and o.shop_domain = at.shop_domain
      join public.shopify_order_lines l
        on l.company_entity_id = o.company_entity_id and l.order_id = o.order_id
     where at.company_entity_id = v_c.company_entity_id
       and at.program_id = v_c.program_id
       and at.affiliate_id = v_c.affiliate_id
       and at.basis in ('single_affiliate_code', 'first_affiliate_code')
       and at.order_id <> v_c.seed_order_id
       and at.order_day >= v_c.seed_order_day
       and at.order_day <= least(v_today - v_c.refund_days, v_c.goal_by)
       and o.cancelled_at is null
       and upper(o.currency) = v_c.currency
       and lower(btrim(l.title)) = lower(btrim(v_c.product_title));

    update public.affiliate_seed_claims
       set progress_cents = v_progress, progress_as_of = now()
     where id = v_c.id;

    if v_progress >= v_c.goal_cents and v_c.seed_paid_cents > 0 then
      perform public.affiliate_lock_program_money(v_c.program_id);
      insert into public.affiliate_commission_ledger
        (company_entity_id, program_id, affiliate_id, kind, amount_cents, currency, source, memo)
      -- No order_id and no order_day: it is not an order (so it is not in the
      -- affiliate's order list), and the refund window it would wait out has
      -- already passed for every sale that earned it.
      values (v_c.company_entity_id, v_c.program_id, v_c.affiliate_id, 'manual_adjustment', v_c.seed_paid_cents,
              v_c.currency, 'manual',
              left('Product seeding paid back: ' || v_c.product_title || ' (claim ' || v_c.id || ')', 500))
      returning id into v_ledger;
      update public.affiliate_seed_claims
         set state = 'earned', earned_at = now(), reimbursement_ledger_id = v_ledger
       where id = v_c.id and state = 'purchased';
      v_earned := v_earned + 1;
    elsif v_today > v_c.goal_by + v_c.refund_days then
      -- The last sale that could count has passed its refund window.
      update public.affiliate_seed_claims set state = 'expired' where id = v_c.id and state = 'purchased';
      v_expired := v_expired + 1;
    end if;
  end loop;

  return jsonb_build_object('purchased', v_bought, 'earned', v_earned, 'expired', v_expired);
end;
$$;

revoke all on function public.affiliate_seed_sweep(uuid) from public, anon, authenticated;
grant execute on function public.affiliate_seed_sweep(uuid) to service_role;

comment on function public.affiliate_seed_sweep(uuid) is
  'Product seeding, for one program: records each approved claim''s seed purchase (first order carrying its code), measures progress (that product''s sales on the affiliate''s own credited orders after the seed order, refund window passed, net of refunds), writes the payback ONCE as a manual_adjustment ledger line when the goal is met, and expires claims past their goal date. Service role only; run after commissions accrue. 20261113093000.';

-- ── 7. The portal's feed: each product under a launch carries its id ─────
-- So a rep can ask for a launch's product at the seeding price, the same as a
-- product shared on its own. The body is 20261113070000's, with only 'id'
-- added to each pushed product.
create or replace function public.affiliate_portal_feed(p_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tok   record;
  v_today date;
  v_store text;
begin
  select t.company_entity_id, t.program_id, t.affiliate_id into v_tok
    from public.affiliate_access_tokens t
    join public.affiliates a
      on a.id = t.affiliate_id and a.company_entity_id = t.company_entity_id and a.program_id = t.program_id
   where t.token_hash = p_token_hash
     and t.purpose = 'portal'
     and t.revoked_at is null
     and t.expires_at > now()
     and a.status in ('active', 'paused');
  if not found then
    return null;
  end if;

  v_today := (now() at time zone public.silo_company_timezone(v_tok.company_entity_id))::date;

  select coalesce(p.store_url,
           (select 'https://' || lower(sc.shop_domain)
              from public.shopify_connections sc
             where sc.company_entity_id = v_tok.company_entity_id and coalesce(sc.is_active, true)
               and sc.shop_domain ~ '^[A-Za-z0-9.-]+$'
             order by sc.created_at limit 1))
    into v_store
    from public.affiliate_programs p
   where p.id = v_tok.program_id and p.company_entity_id = v_tok.company_entity_id;

  return jsonb_build_object(
    'store_url', v_store,
    'codes', (
      select coalesce(jsonb_agg(c.code order by c.starts_on desc, c.code), '[]'::jsonb)
        from public.affiliate_codes c
       where c.company_entity_id = v_tok.company_entity_id
         and c.affiliate_id = v_tok.affiliate_id
         and c.status = 'active'
         and c.starts_on <= v_today
         and (c.ends_on is null or c.ends_on >= v_today)),
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', f.id,
               'kind', f.kind, 'title', f.title, 'note', f.note, 'image_url', f.image_url,
               'product_path', f.product_path, 'event_on', f.event_on, 'shared_at', f.shared_at,
               -- A launch the affiliate has claimed, and what it asks them to
               -- push. Products shared UNDER a launch are not loose feed
               -- cards: they belong to that launch's row.
               'claimed', f.kind = 'launch' and exists (
                  select 1 from public.affiliate_launch_claims k
                   where k.feed_item_id = f.id and k.affiliate_id = v_tok.affiliate_id),
               'push', case when f.kind = 'launch' then (
                  select coalesce(jsonb_agg(jsonb_build_object(
                           'id', g.id, 'title', g.title, 'image_url', g.image_url, 'product_path', g.product_path)
                         order by g.title), '[]'::jsonb)
                    from public.affiliate_feed_items g
                   where g.company_entity_id = f.company_entity_id
                     and g.program_id = f.program_id
                     and g.parent_source_id = f.source_id) end)
             order by case f.kind when 'launch' then 0 when 'product' then 1 else 2 end,
                      f.event_on nulls last, f.shared_at desc), '[]'::jsonb)
        from (select * from public.affiliate_feed_items f
               where f.company_entity_id = v_tok.company_entity_id
                 and f.program_id = v_tok.program_id
                 -- A product shared under a launch is shown on that launch.
                 and f.parent_source_id is null
                 -- A launch that has passed drops out of "upcoming" by itself.
                 and not (f.kind = 'launch' and f.event_on is not null and f.event_on < v_today)
               order by f.shared_at desc
               limit 60) f));
end;
$$;

comment on function public.affiliate_portal_feed(text) is
  'For the affiliate-portal function: the feed of a valid portal link of an active or paused affiliate -- the items its program shared (each with its id, whether this affiliate claimed it, and for a launch the products shared under it), the store address, and the affiliate''s codes in effect today. NULL for anything else. Service role only. 20261110150000, claims 20261113070000, pushed product ids 20261113093000.';

revoke all on function public.affiliate_portal_feed(text) from public, anon, authenticated;
grant execute on function public.affiliate_portal_feed(text) to service_role;

select public.attach_stamp_company_entity_id_triggers();
select public.attach_affiliate_same_company_twins();
select public.refresh_chat_schema_catalog();
