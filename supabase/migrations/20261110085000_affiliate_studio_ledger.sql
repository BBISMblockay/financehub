-- =============================================================================
-- Affiliate Studio -- attribution, the commission ledger, and the payout
-- handoff. Needs 20261110083000 (order-level codes and refunds) and
-- 20261110084000 (programs, affiliates, codes).
--
-- ── THE FOUR THINGS THIS FILE REFUSES TO DO ─────────────────────────────────
--
-- 1. It never attributes one order twice. affiliate_attributions is UNIQUE on
--    (company, shop_domain, order_id) -- not per program, not per code. An
--    order carrying two affiliate codes is recorded ONCE with basis
--    'ambiguous_multiple_affiliate_codes' and earns nothing, because paying
--    two people for one order is worse than paying neither and asking.
--
-- 2. It never guesses money. An order in a currency the program does not
--    settle in is recorded and NOT accrued (SILO holds no FX rate). An order
--    whose refunds were never measured -- synced before 20261110083000 -- has
--    an UNKNOWN commissionable base and is likewise recorded and not accrued.
--    Both are visible and counted, so "why is this affiliate's number lower
--    than the storefront's" has an answer on the page.
--
-- 3. It never rewrites history. affiliate_commission_ledger is append-only
--    (no UPDATE or DELETE grant, and a trigger that refuses both even for a
--    writer that has them). A refund discovered after payout appends a
--    NEGATIVE row; it does not edit the accrual it corrects. This is the same
--    stance ledger_entries already takes in the finance module.
--
-- 4. It never moves money. Every payout in this release is a MANUAL handoff:
--    SILO computes what is owed, a money-authority human approves it, SILO
--    produces an export with a fingerprint, and a human records the payment
--    reference and evidence afterwards. affiliate_payout_accounts exists as
--    the mirror a Stripe Express integration would fill, and
--    affiliate_mark_payout_paid() refuses any method other than 'manual'
--    until that integration is actually built and approved. Nothing here
--    calls Stripe.
--
-- ── WHAT "COMMISSIONABLE" MEANS, EXACTLY ────────────────────────────────────
--
--   commissionable = order subtotal_price - refunded_subtotal
--
-- subtotal_price is Shopify's merchandise subtotal AFTER line discounts
-- (including the affiliate's own code), and refunded_subtotal is the sum of
-- refunded line subtotals, also after discounts. Tax and shipping are in
-- neither. That is "after discounts and refunds, before tax and shipping".
-- Either value being NULL makes the whole base NULL, never zero.
--
-- ── MONEY AUTHORITY ─────────────────────────────────────────────────────────
--
-- can_manage_affiliate_programs() may resolve attributions, accrue, open a
-- period and BUILD a draft payout -- all reversible, all describing money
-- rather than releasing it. can_approve_affiliate_commissions() is required
-- to approve a period, approve a payout and mark one paid. It is a separate
-- function with the same population as can_manage_journal_entries() for the
-- reason stated in 20260919120000: these authorities diverge, and the day
-- they do, widening one must not widen the other.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. The money gate
-- ---------------------------------------------------------------------------

create or replace function public.can_approve_affiliate_commissions()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid()
      and p.is_active = true
      and (
        case when em.role is not null
             then em.role = 'owner_admin'
             else p.role::text = 'owner'
        end
        or p.department in ('finance','exec')
      )
  );
$$;

comment on function public.can_approve_affiliate_commissions() is
  'May the caller approve an affiliate commission period, approve a payout, or record one as paid. Same population as can_manage_journal_entries() (membership owner_admin, profile owner, or department finance/exec) and a SEPARATE function on purpose: running an affiliate program and releasing money to a third party are different authorities. Never widen this to is_admin_user(), which passes for nearly every profile.';

revoke execute on function public.can_approve_affiliate_commissions() from public, anon;
grant execute on function public.can_approve_affiliate_commissions() to authenticated;

-- ---------------------------------------------------------------------------
-- 1. Attributions -- one row per coded order, attributed or explained
-- ---------------------------------------------------------------------------

create table if not exists public.affiliate_attributions (
  id                  uuid primary key default gen_random_uuid(),
  company_entity_id   uuid not null references public.entities(id) on delete cascade,
  program_id          uuid not null references public.affiliate_programs(id) on delete cascade,

  -- NULL whenever the basis is a refusal: the order is recorded so it can be
  -- explained, not credited.
  affiliate_id        uuid references public.affiliates(id) on delete set null,
  affiliate_code_id   uuid references public.affiliate_codes(id) on delete set null,

  shop_domain         text not null,
  order_id            text not null,
  order_number        text,
  order_day           date not null,
  order_currency      text,

  codes_on_order      integer not null check (codes_on_order >= 1),
  matched_code        text,

  --   single_affiliate_code  -- one code on the order, and it is an affiliate's
  --   first_affiliate_code   -- several codes, exactly one of them an affiliate's
  --   ambiguous_multiple_affiliate_codes -- two affiliates' codes on one order
  --   multiple_codes_refused -- program is single_code_only and the order had more
  --   code_outside_window    -- the code is an affiliate's, the order is not in its dates
  --   currency_mismatch      -- attributed, but not in the program's settlement currency
  --   refunds_not_measured   -- attributed, but the commissionable base is unknown
  --   order_cancelled        -- the affiliate's order was cancelled: a KNOWN zero
  --                             base, so anything accrued on it is reversed
  basis               text not null check (basis in (
                        'single_affiliate_code','first_affiliate_code',
                        'ambiguous_multiple_affiliate_codes','multiple_codes_refused',
                        'code_outside_window','currency_mismatch','refunds_not_measured',
                        'order_cancelled')),

  gross_subtotal_cents    bigint,
  refunded_subtotal_cents bigint,
  -- NULL means UNKNOWN, which is why nothing coalesces it. Zero is a real and
  -- different answer: a fully refunded order.
  commissionable_cents    bigint,

  -- Only the three earning bases may carry an affiliate AND a base; the four
  -- refusals must carry neither an earning base nor (for the ambiguous ones)
  -- an affiliate. Written as a CHECK because the resolver is not guaranteed to
  -- be the only writer forever.
  constraint affiliate_attributions_basis_shape check (
    case basis
      when 'single_affiliate_code' then affiliate_id is not null
      when 'first_affiliate_code'  then affiliate_id is not null
      when 'currency_mismatch'     then affiliate_id is not null and commissionable_cents is null
      when 'refunds_not_measured'  then affiliate_id is not null and commissionable_cents is null
      when 'order_cancelled'       then affiliate_id is not null and commissionable_cents = 0
      when 'ambiguous_multiple_affiliate_codes' then affiliate_id is null and commissionable_cents is null
      when 'multiple_codes_refused'             then affiliate_id is null and commissionable_cents is null
      when 'code_outside_window'                then affiliate_id is null and commissionable_cents is null
      else false
    end
  ),

  resolver_version    integer not null default 1,
  run_id              uuid,
  attributed_at       timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- THE no-double-pay key: one attribution per order per store, across every
-- program in the company. Deliberately not keyed by program or by code.
create unique index if not exists affiliate_attributions_order_identity
  on public.affiliate_attributions (company_entity_id, shop_domain, order_id);

create index if not exists affiliate_attributions_affiliate_idx
  on public.affiliate_attributions (company_entity_id, affiliate_id, order_day);

create index if not exists affiliate_attributions_program_day_idx
  on public.affiliate_attributions (company_entity_id, program_id, order_day);

alter table public.affiliate_attributions enable row level security;

drop policy if exists affiliate_attributions_select on public.affiliate_attributions;
create policy affiliate_attributions_select on public.affiliate_attributions
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- No client write policy and no client write grant: every row is a derived
-- measurement produced by affiliate_resolve_attributions(). A hand-authored
-- attribution is a hand-authored commission.
revoke insert, update, delete on public.affiliate_attributions from authenticated, anon;
grant all on public.affiliate_attributions to service_role;

comment on table public.affiliate_attributions is
  'One row per Shopify order that carried a code known to this company''s affiliate programs -- attributed, or recorded with the reason it was not. UNIQUE on (company, shop_domain, order_id) across ALL programs, which is what makes paying twice for one order impossible. commissionable_cents NULL means unknown (unmeasured refunds, or a currency the program does not settle in), never zero. Client-readable, never client-writable: affiliate_resolve_attributions() is the only writer.';

-- ---------------------------------------------------------------------------
-- 2. Periods -- the brand's review gate before anything is paid
-- ---------------------------------------------------------------------------

create table if not exists public.affiliate_commission_periods (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  program_id        uuid not null references public.affiliate_programs(id) on delete cascade,
  period_start      date not null,
  period_end        date not null,
  status            text not null default 'open'
                      check (status in ('open','under_review','approved','paid','void')),
  submitted_by      uuid references public.profiles(id),
  submitted_at      timestamptz,
  approved_by       uuid references public.profiles(id),
  approved_at       timestamptz,
  note              text,
  created_at        timestamptz not null default now(),
  created_by        uuid references public.profiles(id),
  constraint affiliate_commission_periods_range check (period_end >= period_start),
  constraint affiliate_commission_periods_approval check (
    (approved_at is null) = (approved_by is null)
  ),
  constraint affiliate_commission_periods_approved_has_approval check (
    status not in ('approved','paid') or approved_at is not null
  )
);

create unique index if not exists affiliate_commission_periods_identity
  on public.affiliate_commission_periods (company_entity_id, program_id, period_start, period_end);

alter table public.affiliate_commission_periods enable row level security;

drop policy if exists affiliate_commission_periods_select on public.affiliate_commission_periods;
create policy affiliate_commission_periods_select on public.affiliate_commission_periods
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- Opening and submitting a period is program management; APPROVING it is the
-- money gate, and that transition happens only through
-- affiliate_approve_period(), never by a direct UPDATE. The policy below lets
-- a manager create and submit, and the trigger refuses an approval that did
-- not come from the gated function.
drop policy if exists affiliate_commission_periods_write on public.affiliate_commission_periods;
create policy affiliate_commission_periods_write on public.affiliate_commission_periods
  for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_affiliate_programs())
  with check (company_entity_id = public.active_company_id() and public.can_manage_affiliate_programs());

-- A row-level policy says which ROWS you may touch, never which COLUMNS: the
-- write policy above would otherwise let a program manager set status
-- 'approved' themselves. A BEFORE trigger is the right place for a
-- column-level rule because it holds for EVERY writer, including the definer
-- functions below and whatever a later screen does.
create or replace function public.affiliate_periods_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_gated boolean := coalesce(current_setting('silo.affiliate_period_approval', true), '') = coalesce(new.id::text, '');
begin
  if v_gated then
    return new;
  end if;

  -- A period is born open and unapproved. Without this a manager could
  -- INSERT one already 'approved' with their own name on it, which satisfies
  -- every CHECK and skips the money gate entirely (review cycle 1, P2).
  if tg_op = 'INSERT' then
    if new.status <> 'open' or new.approved_by is not null or new.approved_at is not null
       or new.submitted_by is not null or new.submitted_at is not null then
      raise exception 'affiliate_commission_periods: a period starts open; submit it with affiliate_submit_period() and approve it with affiliate_approve_period()'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if (new.status is distinct from old.status and new.status in ('approved','paid'))
     or new.approved_by is distinct from old.approved_by
     or new.approved_at is distinct from old.approved_at then
    raise exception 'affiliate_commission_periods: approve through affiliate_approve_period(), which requires can_approve_affiliate_commissions()'
      using errcode = '42501';
  end if;

  -- What somebody signed off stays signed off: an approved or paid period
  -- cannot be reopened, re-dated or moved by a plain UPDATE. Its note can
  -- still be edited.
  if old.status in ('approved','paid')
     and (new.status is distinct from old.status
          or new.period_start is distinct from old.period_start
          or new.period_end is distinct from old.period_end
          or new.program_id is distinct from old.program_id
          or new.company_entity_id is distinct from old.company_entity_id
          or new.submitted_by is distinct from old.submitted_by
          or new.submitted_at is distinct from old.submitted_at) then
    raise exception 'affiliate_commission_periods: an approved period cannot be reopened or changed'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists affiliate_periods_guard_trg on public.affiliate_commission_periods;
create trigger affiliate_periods_guard_trg
  before insert or update on public.affiliate_commission_periods
  for each row execute function public.affiliate_periods_guard();

revoke execute on function public.affiliate_periods_guard() from public, anon, authenticated;

comment on table public.affiliate_commission_periods is
  'The review gate between "SILO computed it" and "we are paying it". A program manager may open and submit a period; only affiliate_approve_period() (money gate) can move it to approved, enforced by a BEFORE trigger rather than by the row policy, because a row policy cannot restrict a column.';

-- ---------------------------------------------------------------------------
-- 3. The ledger -- append-only
-- ---------------------------------------------------------------------------

create table if not exists public.affiliate_commission_ledger (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  program_id        uuid not null references public.affiliate_programs(id) on delete cascade,
  affiliate_id      uuid not null references public.affiliates(id) on delete restrict,
  period_id         uuid references public.affiliate_commission_periods(id) on delete set null,
  attribution_id    uuid references public.affiliate_attributions(id) on delete set null,

  kind              text not null check (kind in
                      ('accrual','refund_adjustment','manual_adjustment')),

  -- Positive is owed TO the affiliate; negative reduces what is owed. A
  -- refund found after a payout therefore leaves a negative balance, which is
  -- the honest answer and is exactly what the payout screen must show.
  amount_cents      bigint not null,
  currency          text not null check (currency ~ '^[A-Z]{3}$'),

  -- What produced the number, kept so a statement line is auditable without
  -- re-deriving it from a changed configuration.
  rate_kind         text check (rate_kind in ('percent_of_net','fixed_per_order')),
  rate_value        numeric(12,4),
  basis_cents       bigint,

  order_id          text,
  order_day         date,
  source            text not null default 'resolver'
                      check (source in ('resolver','manual')),
  memo              text,
  run_id            uuid,
  created_at        timestamptz not null default now(),
  created_by        uuid references public.profiles(id),

  -- A manual adjustment with no explanation is an unexplained payment.
  constraint affiliate_commission_ledger_manual_has_memo check (
    kind <> 'manual_adjustment' or btrim(coalesce(memo,'')) <> ''
  ),
  constraint affiliate_commission_ledger_nonzero check (amount_cents <> 0)
);

create index if not exists affiliate_commission_ledger_affiliate_idx
  on public.affiliate_commission_ledger (company_entity_id, affiliate_id, created_at);

create index if not exists affiliate_commission_ledger_attribution_idx
  on public.affiliate_commission_ledger (company_entity_id, attribution_id);

create index if not exists affiliate_commission_ledger_period_idx
  on public.affiliate_commission_ledger (company_entity_id, period_id);

alter table public.affiliate_commission_ledger enable row level security;

drop policy if exists affiliate_commission_ledger_select on public.affiliate_commission_ledger;
create policy affiliate_commission_ledger_select on public.affiliate_commission_ledger
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- A manual adjustment is a money decision, so it is the money gate -- and it
-- is INSERT only. There is no UPDATE or DELETE policy and no grant for
-- either; the trigger below is the backstop for a writer that bypasses RLS
-- entirely (the service role does).
drop policy if exists affiliate_commission_ledger_insert on public.affiliate_commission_ledger;
create policy affiliate_commission_ledger_insert on public.affiliate_commission_ledger
  for insert to authenticated
  with check (
    company_entity_id = public.active_company_id()
    and public.can_approve_affiliate_commissions()
    and kind = 'manual_adjustment'
    and source = 'manual'
  );

revoke update, delete on public.affiliate_commission_ledger from authenticated, anon;
grant all on public.affiliate_commission_ledger to service_role;

create or replace function public.affiliate_ledger_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'affiliate_commission_ledger is append-only: correct an entry by appending its reversal'
    using errcode = '42501';
end;
$$;

drop trigger if exists affiliate_ledger_append_only_trg on public.affiliate_commission_ledger;
create trigger affiliate_ledger_append_only_trg
  before update or delete on public.affiliate_commission_ledger
  for each row execute function public.affiliate_ledger_append_only();

revoke execute on function public.affiliate_ledger_append_only() from public, anon, authenticated;

comment on table public.affiliate_commission_ledger is
  'Append-only commission ledger. Positive amount_cents is owed to the affiliate, negative reduces it; a refund discovered after a payout appends a negative row rather than editing the accrual, so a negative balance is a real and displayable state. No UPDATE or DELETE is possible by any role -- a trigger refuses both even for the service role, which bypasses RLS. Clients may INSERT only a manual_adjustment, only with can_approve_affiliate_commissions(), and only with a memo.';

-- ---------------------------------------------------------------------------
-- 4. Payouts -- the manual handoff, and the mirror a provider would fill
-- ---------------------------------------------------------------------------

create table if not exists public.affiliate_payout_accounts (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  affiliate_id      uuid not null references public.affiliates(id) on delete cascade,
  provider          text not null default 'stripe_express'
                      check (provider in ('stripe_express')),
  -- The provider's own vocabulary, so NO CHECK: a provider that adds a status
  -- would otherwise freeze this mirror on the previous state, which is worse
  -- than an unknown string (the reason stripe_invoices.status has no CHECK).
  provider_status   text,
  stripe_account_id text,
  payouts_enabled   boolean,
  details_submitted boolean,
  requirements      jsonb,
  provider_synced_at timestamptz,
  created_at        timestamptz not null default now()
);

create unique index if not exists affiliate_payout_accounts_identity
  on public.affiliate_payout_accounts (company_entity_id, affiliate_id, provider);

alter table public.affiliate_payout_accounts enable row level security;

drop policy if exists affiliate_payout_accounts_select on public.affiliate_payout_accounts;
create policy affiliate_payout_accounts_select on public.affiliate_payout_accounts
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- Mirror discipline, exactly as the Stripe tables already here: no client
-- write of any kind. A row appears only when a provider has confirmed it.
revoke insert, update, delete on public.affiliate_payout_accounts from authenticated, anon;
grant all on public.affiliate_payout_accounts to service_role;

comment on table public.affiliate_payout_accounts is
  'UNCONFIGURED IN THIS RELEASE. The mirror a Stripe Express (or equivalent) affiliate-payee integration would fill, shaped like the existing Stripe mirrors: provider is the system of record, SILO holds no row the provider has not confirmed, provider_status carries the provider''s own vocabulary with no CHECK, and no client role may write. Nothing in this repository creates, reads or funds such an account yet -- affiliate_mark_payout_paid() refuses any method but manual. See docs/ops/affiliate-studio.md for the open questions (payee model, funding source, capabilities, webhooks, tax reporting).';

create table if not exists public.affiliate_payouts (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  program_id        uuid not null references public.affiliate_programs(id) on delete cascade,
  affiliate_id      uuid not null references public.affiliates(id) on delete restrict,
  currency          text not null check (currency ~ '^[A-Z]{3}$'),
  amount_cents      bigint not null check (amount_cents > 0),
  method            text not null default 'manual'
                      check (method in ('manual','stripe_connect_express')),
  status            text not null default 'draft'
                      check (status in ('draft','approved','exported','marked_paid','void')),
  approved_by       uuid references public.profiles(id),
  approved_at       timestamptz,
  exported_by       uuid references public.profiles(id),
  exported_at       timestamptz,
  export_fingerprint text,
  -- One id per export, so the file a person pays from can be downloaded
  -- again exactly as it was confirmed.
  export_batch_id   uuid,
  marked_paid_by    uuid references public.profiles(id),
  marked_paid_at    timestamptz,
  external_reference text,
  paid_evidence     text,
  void_reason       text,
  note              text,
  created_at        timestamptz not null default now(),
  created_by        uuid references public.profiles(id),

  constraint affiliate_payouts_approval check ((approved_at is null) = (approved_by is null)),
  constraint affiliate_payouts_states_in_order check (
    status not in ('approved','exported','marked_paid') or approved_at is not null
  ),
  -- SILO did not make the payment. Recording one as paid therefore needs a
  -- named person, an external reference and written evidence -- the same
  -- stance the outreach table takes about a send SILO did not make.
  constraint affiliate_payouts_paid_has_evidence check (
    status <> 'marked_paid'
    or (marked_paid_by is not null and marked_paid_at is not null
        and btrim(coalesce(external_reference,'')) <> ''
        and btrim(coalesce(paid_evidence,'')) <> '')
  ),
  constraint affiliate_payouts_void_has_reason check (
    status <> 'void' or btrim(coalesce(void_reason,'')) <> ''
  )
);

create index if not exists affiliate_payouts_affiliate_idx
  on public.affiliate_payouts (company_entity_id, affiliate_id, created_at desc);

alter table public.affiliate_payouts enable row level security;

drop policy if exists affiliate_payouts_select on public.affiliate_payouts;
create policy affiliate_payouts_select on public.affiliate_payouts
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- Every state transition goes through a gated function. No client write
-- policy at all: a payout row is a claim about money owed, and the functions
-- below are what make it one.
revoke insert, update, delete on public.affiliate_payouts from authenticated, anon;
grant all on public.affiliate_payouts to service_role;

create table if not exists public.affiliate_payout_items (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  payout_id         uuid not null references public.affiliate_payouts(id) on delete cascade,
  ledger_entry_id   uuid not null references public.affiliate_commission_ledger(id) on delete restrict,
  amount_cents      bigint not null,
  created_at        timestamptz not null default now()
);

-- A ledger entry may be paid ONCE. This single index is what makes the
-- balance arithmetic sound: balance = sum(every entry) - sum(entries claimed
-- by a payout that is not void). Without it, two draft payouts built a minute
-- apart would both claim the same accrual.
create unique index if not exists affiliate_payout_items_entry_once
  on public.affiliate_payout_items (ledger_entry_id);

create index if not exists affiliate_payout_items_payout_idx
  on public.affiliate_payout_items (company_entity_id, payout_id);

alter table public.affiliate_payout_items enable row level security;

drop policy if exists affiliate_payout_items_select on public.affiliate_payout_items;
create policy affiliate_payout_items_select on public.affiliate_payout_items
  for select to authenticated
  using (company_entity_id = public.active_company_id());

revoke insert, update, delete on public.affiliate_payout_items from authenticated, anon;
grant all on public.affiliate_payout_items to service_role;

comment on table public.affiliate_payout_items is
  'Which ledger entries a payout claims. UNIQUE on ledger_entry_id -- an entry can be paid once -- which is what makes "balance = all entries minus entries claimed by a non-void payout" correct even with two drafts built concurrently. Voiding a payout releases its entries (the items are deleted by affiliate_void_payout()).';

-- ---------------------------------------------------------------------------
-- 5. Money helpers
-- ---------------------------------------------------------------------------

-- Minor units per major unit. Shopify returns order money as a decimal string
-- in the shop currency, and for a zero-decimal currency "500" means 500 of
-- them, not 5.00 -- multiplying by 100 there overstates every amount by 100x.
-- The zero-decimal set is the one every processor uses; a currency not listed
-- is two-decimal, which is the overwhelmingly common case and the safe
-- default because it is what the existing cents columns already assume.
create or replace function public.affiliate_currency_minor_units(p_currency text)
returns integer
language sql
immutable
as $$
  select case when upper(coalesce(p_currency, '')) in (
      'BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF',
      'UGX','VND','VUV','XAF','XOF','XPF'
    ) then 1 else 100 end;
$$;

comment on function public.affiliate_currency_minor_units(text) is
  'Minor units per major unit for a currency code: 1 for the zero-decimal currencies, 100 otherwise. Used to convert Shopify''s decimal order amounts into the integer minor units every money column in this module stores. An unlisted currency is treated as two-decimal.';

revoke execute on function public.affiliate_currency_minor_units(text) from public, anon;
grant execute on function public.affiliate_currency_minor_units(text) to authenticated, service_role;

-- The rate that applies to an affiliate: their own override if it is complete,
-- otherwise the program's. ONE place this precedence is written, so the
-- accrual and the UI cannot disagree about what someone is on.
create or replace function public.affiliate_effective_rate(p_affiliate_id uuid)
returns table (commission_kind text, commission_percent numeric, commission_fixed_cents integer, source text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    coalesce(a.commission_kind, p.commission_kind),
    case when a.commission_kind is null then p.commission_percent else a.commission_percent end,
    case when a.commission_kind is null then p.commission_fixed_cents else a.commission_fixed_cents end,
    case when a.commission_kind is null then 'program' else 'affiliate' end
  from public.affiliates a
  join public.affiliate_programs p on p.id = a.program_id
  where a.id = p_affiliate_id
    and a.company_entity_id = public.active_company_id();
$$;

comment on function public.affiliate_effective_rate(uuid) is
  'The commission terms actually applying to one affiliate: their complete override, else the program''s. Scoped to the caller''s active company, and returns SETOF so no row means "no such affiliate here" -- a composite-returning resolver would hand back one all-NULL row, which reads as a configured rate of nothing.';

revoke execute on function public.affiliate_effective_rate(uuid) from public, anon;
grant execute on function public.affiliate_effective_rate(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. The resolver -- orders in, attributions out
-- ---------------------------------------------------------------------------
--
-- PRECEDENCE, in the order it is decided (each step only reached if the one
-- above did not refuse):
--
--   1. program.code_precedence = 'single_code_only' and the order carried more
--      than one code of any kind              -> multiple_codes_refused
--   2. no matching code is in its date window -> code_outside_window
--   3. two DIFFERENT affiliates' codes are in window
--                                             -> ambiguous_multiple_affiliate_codes
--   4. the order is not in the program's settlement currency
--                                             -> currency_mismatch   (recorded, unaccrued)
--   5. subtotal or refunds were never measured for that order
--                                             -> refunds_not_measured (recorded, unaccrued)
--   6. one code on the order                  -> single_affiliate_code
--   7. several codes, one affiliate            -> first_affiliate_code
--
-- Two codes belonging to the SAME affiliate are not ambiguous; the winner is
-- the alphabetically first of them, which is arbitrary but deterministic, and
-- matters only for which code_id is cited on the row.
--
-- The window is [code.starts_on, code.ends_on + program.attribution_window_days],
-- and a code with no ends_on is open-ended.
--
-- An order already attributed to a DIFFERENT program is left alone and
-- counted as conflict_other_program: the unique key is the order, and one
-- program's run must never take an order another program already owns.
-- The program's money lock: accrual, payout build and payout approval take it
-- for the rest of their transaction, so none of them reads a ledger another
-- is half-way through changing.
create or replace function public.affiliate_lock_program_money(p_program uuid)
returns void
language sql
volatile
set search_path = public, pg_temp
as $$
  select pg_advisory_xact_lock(hashtextextended('affiliate_money:' || p_program::text, 0))
$$;

revoke execute on function public.affiliate_lock_program_money(uuid) from public, anon, authenticated;

create or replace function public.affiliate_resolve_attributions(
  p_program uuid,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prog     public.affiliate_programs;
  v_company  uuid;
  v_tz       text;
  v_run      uuid := gen_random_uuid();
  v_written   integer := 0;
  v_attempted integer := 0;
  v_conflict  integer := 0;
  v_counts   jsonb;
begin
  if p_program is null or p_from is null or p_to is null then
    raise exception 'affiliate_resolve_attributions: program and date range are required';
  end if;
  if p_to < p_from then
    raise exception 'affiliate_resolve_attributions: p_to is before p_from';
  end if;
  -- Bounded on purpose: `authenticated` has an 8s statement timeout, and a
  -- resolver asked for five years would simply time out halfway and look
  -- broken. A backfill runs it window by window.
  if (p_to - p_from) > 400 then
    raise exception 'affiliate_resolve_attributions: range is % days; resolve at most 400 at a time',
      (p_to - p_from);
  end if;

  select * into v_prog from public.affiliate_programs where id = p_program;
  if not found then
    raise exception 'affiliate_resolve_attributions: no such program';
  end if;
  v_company := v_prog.company_entity_id;

  -- A DEFINER function that takes an id must re-check the caller itself, or it
  -- is an RLS bypass. The program must belong to the caller's ACTIVE company
  -- and the caller must be a manager of it.
  if v_company is distinct from public.active_company_id()
     or not public.can_manage_affiliate_programs() then
    raise exception 'affiliate_resolve_attributions: not permitted for this company'
      using errcode = '42501';
  end if;

  v_tz := public.silo_company_timezone(v_company);

  with ords as (
    select
      o.shop_domain, o.order_id, o.order_number, o.currency,
      o.subtotal_price, o.refunded_subtotal, o.discount_codes,
      (o.shopify_created_at at time zone v_tz)::date as order_day,
      jsonb_array_length(o.discount_codes) as codes_on_order,
      -- Cancelled orders are READ, not skipped: an order credited before it
      -- was cancelled must come back as a known zero so accrual appends the
      -- reversal. Skipping them left the old positive attribution in place
      -- and the commission payable (review cycle 1, P1).
      (o.cancelled_at is not null) as cancelled
    from public.shopify_orders o
    where o.company_entity_id = v_company
      and o.discount_codes is not null
      and jsonb_array_length(o.discount_codes) > 0
      -- Indexed on (company_entity_id, shopify_created_at). Widened by three
      -- days so no timezone can push a boundary day out of the scan, then
      -- narrowed to the business day below.
      and o.shopify_created_at >= (p_from - 3)::timestamptz
      and o.shopify_created_at <  (p_to + 4)::timestamptz
  ),
  windowed as (
    select * from ords where order_day between p_from and p_to
  ),
  exploded as (
    select w.*, upper(btrim(c.value)) as code
    from windowed w
    cross join lateral jsonb_array_elements_text(w.discount_codes) as c(value)
    where btrim(c.value) <> ''
  ),
  matched as (
    select
      e.*,
      ac.id as code_id,
      ac.affiliate_id,
      (e.order_day >= ac.starts_on
       and e.order_day <= coalesce(ac.ends_on + v_prog.attribution_window_days, 'infinity'::date))
        as in_window
    from exploded e
    join public.affiliate_codes ac
      on ac.company_entity_id = v_company
     and ac.program_id = p_program
     and ac.status = 'active'
     and ac.code = e.code
  ),
  agg as (
    select
      m.shop_domain, m.order_id, m.order_number, m.currency,
      m.subtotal_price, m.refunded_subtotal, m.order_day, m.codes_on_order, m.cancelled,
      count(*) filter (where m.in_window)                        as in_window_codes,
      count(distinct m.affiliate_id) filter (where m.in_window)   as in_window_affiliates,
      (array_agg(m.code      order by m.code) filter (where m.in_window))[1] as win_code,
      (array_agg(m.code_id   order by m.code) filter (where m.in_window))[1] as win_code_id,
      (array_agg(m.affiliate_id order by m.code) filter (where m.in_window))[1] as win_affiliate
    from matched m
    group by 1,2,3,4,5,6,7,8,9
  ),
  decided as (
    select
      a.*,
      case
        when v_prog.code_precedence = 'single_code_only' and a.codes_on_order > 1
          then 'multiple_codes_refused'
        when a.in_window_affiliates = 0 then 'code_outside_window'
        when a.in_window_affiliates > 1 then 'ambiguous_multiple_affiliate_codes'
        when a.cancelled then 'order_cancelled'
        when upper(coalesce(a.currency, '')) <> v_prog.currency then 'currency_mismatch'
        when a.subtotal_price is null or a.refunded_subtotal is null then 'refunds_not_measured'
        when a.codes_on_order = 1 then 'single_affiliate_code'
        else 'first_affiliate_code'
      end as basis
    from agg a
  ),
  shaped as (
    select
      d.*,
      d.basis in ('single_affiliate_code','first_affiliate_code') as earns,
      public.affiliate_currency_minor_units(d.currency) as minor
    from decided d
  ),
  upserted as (
    insert into public.affiliate_attributions (
      company_entity_id, program_id, affiliate_id, affiliate_code_id,
      shop_domain, order_id, order_number, order_day, order_currency,
      codes_on_order, matched_code, basis,
      gross_subtotal_cents, refunded_subtotal_cents, commissionable_cents,
      run_id, attributed_at, updated_at
    )
    select
      v_company, p_program,
      case when s.basis in ('ambiguous_multiple_affiliate_codes',
                            'multiple_codes_refused','code_outside_window')
           then null else s.win_affiliate end,
      case when s.basis in ('ambiguous_multiple_affiliate_codes',
                            'multiple_codes_refused','code_outside_window')
           then null else s.win_code_id end,
      s.shop_domain, s.order_id, s.order_number, s.order_day, upper(nullif(s.currency, '')),
      s.codes_on_order,
      case when s.basis in ('ambiguous_multiple_affiliate_codes',
                            'multiple_codes_refused','code_outside_window')
           then null else s.win_code end,
      s.basis,
      case when s.subtotal_price    is null then null
           else round(s.subtotal_price * s.minor)::bigint end,
      case when s.refunded_subtotal is null then null
           else round(s.refunded_subtotal * s.minor)::bigint end,
      -- Clamped at zero: a refund larger than the merchandise subtotal
      -- (shipping refunded alongside it, say) must not create a NEGATIVE
      -- commissionable base, which would claw back more than was ever earned.
      case when s.basis = 'order_cancelled' then 0::bigint
           when s.earns
            and s.subtotal_price is not null
            and s.refunded_subtotal is not null
           then greatest(round((s.subtotal_price - s.refunded_subtotal) * s.minor)::bigint, 0)
           else null end,
      v_run, now(), now()
    from shaped s
    on conflict (company_entity_id, shop_domain, order_id) do update
      set program_id              = excluded.program_id,
          affiliate_id            = excluded.affiliate_id,
          affiliate_code_id       = excluded.affiliate_code_id,
          order_number            = excluded.order_number,
          order_day               = excluded.order_day,
          order_currency          = excluded.order_currency,
          codes_on_order          = excluded.codes_on_order,
          matched_code            = excluded.matched_code,
          basis                   = excluded.basis,
          gross_subtotal_cents    = excluded.gross_subtotal_cents,
          refunded_subtotal_cents = excluded.refunded_subtotal_cents,
          commissionable_cents    = excluded.commissionable_cents,
          run_id                  = excluded.run_id,
          updated_at              = now()
      -- An order another program already owns is NOT taken over. The unique
      -- key is the order, so without this a second program's run would
      -- silently move an attributed order (and, after the next accrual, the
      -- money) from one affiliate to another.
      where affiliate_attributions.program_id = excluded.program_id
    returning 1
  )
  -- Every shaped row either inserts, or updates and returns 1, or is filtered
  -- out by the DO UPDATE ... WHERE above -- which happens for exactly one
  -- reason: the order already belongs to another program. So the difference
  -- IS the cross-program conflict count, with no second pass over the orders.
  select (select count(*) from upserted), (select count(*) from shaped)
    into v_written, v_attempted;

  v_conflict := v_attempted - v_written;

  -- Stamp the codes SILO has now actually SEEN on a real order. With no
  -- Shopify write scope this is the only confirmation available that a code
  -- recorded here exists in the merchant's admin at all.
  update public.affiliate_codes ac
     set verified_at = coalesce(ac.verified_at, now()),
         first_seen_order_id = coalesce(ac.first_seen_order_id, seen.order_id)
    from (
      select a.affiliate_code_id, min(a.order_id) as order_id
        from public.affiliate_attributions a
       where a.company_entity_id = v_company
         and a.program_id = p_program
         and a.affiliate_code_id is not null
       group by 1
    ) seen
   where ac.id = seen.affiliate_code_id
     and ac.company_entity_id = v_company
     and ac.verified_at is null;

  select jsonb_object_agg(basis, n) into v_counts
    from (
      select basis, count(*) as n
        from public.affiliate_attributions
       where company_entity_id = v_company
         and program_id = p_program
         and order_day between p_from and p_to
       group by 1
    ) t;

  return jsonb_build_object(
    'run_id', v_run,
    'program_id', p_program,
    'from', p_from,
    'to', p_to,
    'timezone', v_tz,
    'rows_written', v_written,
    'conflict_other_program', v_conflict,
    'by_basis', coalesce(v_counts, '{}'::jsonb)
  );
end;
$$;

comment on function public.affiliate_resolve_attributions(uuid, date, date) is
  'Resolves one program''s coded Shopify orders in a date range into affiliate_attributions: at most one row per order per store across all programs, every refusal recorded with its reason rather than dropped, and an order another program already owns left untouched (counted as conflict_other_program). Re-running is idempotent. Caller must be can_manage_affiliate_programs() for the program''s company, which is re-checked inside because this is SECURITY DEFINER. Range is capped at 400 days for the 8s statement timeout. Also stamps affiliate_codes.verified_at the first time a code is seen on a real order.';

revoke execute on function public.affiliate_resolve_attributions(uuid, date, date) from public, anon;
grant execute on function public.affiliate_resolve_attributions(uuid, date, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Accrual -- the ledger catches up with the attributions
-- ---------------------------------------------------------------------------
--
-- SELF-CORRECTING BY CONSTRUCTION. For each attribution the function computes
-- what the affiliate is entitled to NOW, compares it with the sum the ledger
-- already holds for that attribution, and appends the DIFFERENCE. So:
--
--   * running it twice appends nothing the second time (difference is zero);
--   * a refund that arrives later appends a negative row, leaving the original
--     accrual intact and auditable;
--   * a refund that arrives AFTER the payout still appends the negative row,
--     which is unclaimed by any payout and therefore reduces the next one (or
--     leaves a negative balance the page shows as owed back);
--   * a rate corrected on the program appends the delta rather than rewriting
--     history, and the memo says which run did it.
--
-- Only affiliates whose status is 'active' accrue NEW commission. A paused or
-- terminated affiliate keeps every entry they earned and earns nothing new,
-- which is what those statuses mean -- but a refund or cancellation on what
-- they already earned is still reversed, because otherwise it stays payable.
-- The return value counts what was skipped so the page can say so.
create or replace function public.affiliate_accrue_commissions(
  p_program uuid,
  p_from date,
  p_to date,
  p_period uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prog     public.affiliate_programs;
  v_company  uuid;
  v_run      uuid := gen_random_uuid();
  v_actor    uuid := auth.uid();
  v_accrued  integer := 0;
  v_reduced  integer := 0;
  v_unchanged integer := 0;
  v_skipped_inactive integer := 0;
  v_skipped_unknown  integer := 0;
  v_total    bigint := 0;
  r          record;
  v_entitled bigint;
  v_existing bigint;
  v_delta    bigint;
  v_period   uuid;
begin
  if p_program is null or p_from is null or p_to is null then
    raise exception 'affiliate_accrue_commissions: program and date range are required';
  end if;
  if p_to < p_from then
    raise exception 'affiliate_accrue_commissions: p_to is before p_from';
  end if;

  select * into v_prog from public.affiliate_programs where id = p_program;
  if not found then
    raise exception 'affiliate_accrue_commissions: no such program';
  end if;
  v_company := v_prog.company_entity_id;

  if v_company is distinct from public.active_company_id()
     or not public.can_manage_affiliate_programs() then
    raise exception 'affiliate_accrue_commissions: not permitted for this company'
      using errcode = '42501';
  end if;

  -- One accrual per program at a time. Each attribution's delta is "what is
  -- owed now minus what the ledger holds", so two overlapping runs could both
  -- read $0 held and both append the full $10 (review cycle 1, P1). The same
  -- program lock is taken by building and approving a payout, so a payout is
  -- never assembled from a ledger an accrual is half-way through.
  perform public.affiliate_lock_program_money(p_program);

  if p_period is not null then
    perform 1 from public.affiliate_commission_periods
      where id = p_period and company_entity_id = v_company and program_id = p_program;
    if not found then
      raise exception 'affiliate_accrue_commissions: period does not belong to this program';
    end if;
    -- An approved or paid period is closed. Appending to it after the money
    -- was released would change a number somebody signed off; the entry
    -- belongs to whichever period now contains its order day, or to none.
    perform 1 from public.affiliate_commission_periods
      where id = p_period and status in ('approved','paid');
    if found then
      raise exception 'affiliate_accrue_commissions: period % is already %, so it cannot take new entries',
        p_period, (select status from public.affiliate_commission_periods where id = p_period);
    end if;
  end if;

  for r in
    select
      a.id as attribution_id, a.affiliate_id, a.order_id, a.order_day,
      a.commissionable_cents, a.order_currency,
      af.status as affiliate_status,
      coalesce(af.commission_kind, v_prog.commission_kind) as kind,
      case when af.commission_kind is null then v_prog.commission_percent
           else af.commission_percent end as pct,
      case when af.commission_kind is null then v_prog.commission_fixed_cents
           else af.commission_fixed_cents end as fixed
    from public.affiliate_attributions a
    join public.affiliates af
      on af.id = a.affiliate_id and af.company_entity_id = v_company
    where a.company_entity_id = v_company
      and a.program_id = p_program
      and a.order_day between p_from and p_to
      and a.affiliate_id is not null
    order by a.order_day, a.order_id
  loop
    if r.commissionable_cents is null then
      -- currency_mismatch or refunds_not_measured: the base is UNKNOWN, and
      -- an unknown base accrues nothing. Counted, never guessed.
      v_skipped_unknown := v_skipped_unknown + 1;
      continue;
    end if;

    v_entitled := case r.kind
      when 'percent_of_net' then round(r.commissionable_cents * coalesce(r.pct, 0) / 100.0)::bigint
      -- A fully refunded order earns no flat fee either: the fee is per
      -- SALE, and a sale that came back is not one.
      when 'fixed_per_order' then case when r.commissionable_cents > 0
                                       then coalesce(r.fixed, 0)::bigint else 0::bigint end
      else 0::bigint
    end;

    select coalesce(sum(l.amount_cents), 0) into v_existing
      from public.affiliate_commission_ledger l
     where l.company_entity_id = v_company
       and l.attribution_id = r.attribution_id
       and l.kind in ('accrual','refund_adjustment');

    v_delta := v_entitled - v_existing;

    -- A paused or terminated affiliate earns nothing NEW, but a refund or
    -- cancellation on what they already earned is still taken back:
    -- skipping them entirely left the old commission payable (review cycle 1).
    if r.affiliate_status <> 'active' and v_delta > 0 then
      v_skipped_inactive := v_skipped_inactive + 1;
      continue;
    end if;

    if v_delta = 0 then
      v_unchanged := v_unchanged + 1;
      continue;
    end if;

    v_period := p_period;
    if v_period is null then
      select pr.id into v_period
        from public.affiliate_commission_periods pr
       where pr.company_entity_id = v_company
         and pr.program_id = p_program
         and pr.status in ('open','under_review')
         and r.order_day between pr.period_start and pr.period_end
       order by pr.period_start desc
       limit 1;
    end if;

    insert into public.affiliate_commission_ledger (
      company_entity_id, program_id, affiliate_id, period_id, attribution_id,
      kind, amount_cents, currency, rate_kind, rate_value, basis_cents,
      order_id, order_day, source, memo, run_id, created_by
    ) values (
      v_company, p_program, r.affiliate_id, v_period, r.attribution_id,
      case when v_delta < 0 then 'refund_adjustment' else 'accrual' end,
      v_delta, v_prog.currency, r.kind,
      case when r.kind = 'percent_of_net' then r.pct else r.fixed end,
      r.commissionable_cents,
      r.order_id, r.order_day, 'resolver',
      case when v_delta < 0
           then 'commissionable base fell to ' || r.commissionable_cents || ' minor units'
           else null end,
      v_run, v_actor
    );

    v_total := v_total + v_delta;
    if v_delta < 0 then v_reduced := v_reduced + 1; else v_accrued := v_accrued + 1; end if;
  end loop;

  return jsonb_build_object(
    'run_id', v_run,
    'program_id', p_program,
    'from', p_from, 'to', p_to,
    'currency', v_prog.currency,
    'entries_accrued', v_accrued,
    'entries_reduced', v_reduced,
    'unchanged', v_unchanged,
    'skipped_inactive_affiliate', v_skipped_inactive,
    'skipped_unknown_base', v_skipped_unknown,
    'net_amount_cents', v_total
  );
end;
$$;

comment on function public.affiliate_accrue_commissions(uuid, date, date, uuid) is
  'Appends the DIFFERENCE between what each attributed order now entitles its affiliate to and what the ledger already holds for it. Idempotent (a second run appends nothing), refund-correcting (a later refund appends a negative row, including after payout), and never guessing: an attribution with an unknown base accrues nothing and is counted as skipped_unknown_base. Only status=active affiliates accrue. Manager gate, re-checked inside because this is SECURITY DEFINER. Will not append to an approved or paid period.';

revoke execute on function public.affiliate_accrue_commissions(uuid, date, date, uuid) from public, anon;
grant execute on function public.affiliate_accrue_commissions(uuid, date, date, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Period review
-- ---------------------------------------------------------------------------

create or replace function public.affiliate_submit_period(p_period uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_company uuid;
begin
  select company_entity_id into v_company
    from public.affiliate_commission_periods where id = p_period;
  if not found then raise exception 'affiliate_submit_period: no such period'; end if;
  if v_company is distinct from public.active_company_id()
     or not public.can_manage_affiliate_programs() then
    raise exception 'affiliate_submit_period: not permitted' using errcode = '42501';
  end if;

  update public.affiliate_commission_periods
     set status = 'under_review', submitted_by = auth.uid(), submitted_at = now()
   where id = p_period and status = 'open';
  -- An RLS- or predicate-refused UPDATE succeeds with zero rows rather than
  -- erroring, so the caller is told by name instead of being left to assume.
  if not found then
    raise exception 'affiliate_submit_period: period is not open';
  end if;
end;
$$;

revoke execute on function public.affiliate_submit_period(uuid) from public, anon;
grant execute on function public.affiliate_submit_period(uuid) to authenticated;

create or replace function public.affiliate_approve_period(p_period uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_company uuid;
begin
  select company_entity_id into v_company
    from public.affiliate_commission_periods where id = p_period;
  if not found then raise exception 'affiliate_approve_period: no such period'; end if;
  if v_company is distinct from public.active_company_id()
     or not public.can_approve_affiliate_commissions() then
    raise exception 'affiliate_approve_period: approving a commission period needs can_approve_affiliate_commissions()'
      using errcode = '42501';
  end if;

  -- The one key the BEFORE trigger accepts, set for this statement only. The
  -- trigger is what stops a program manager approving a period with a plain
  -- UPDATE through the write policy, which a row policy cannot prevent.
  perform set_config('silo.affiliate_period_approval', p_period::text, true);

  update public.affiliate_commission_periods
     set status = 'approved', approved_by = auth.uid(), approved_at = now(),
         note = coalesce(p_note, note)
   where id = p_period and status in ('open','under_review');
  if not found then
    raise exception 'affiliate_approve_period: period is not open or under review';
  end if;

  perform set_config('silo.affiliate_period_approval', '', true);
end;
$$;

revoke execute on function public.affiliate_approve_period(uuid, text) from public, anon;
grant execute on function public.affiliate_approve_period(uuid, text) to authenticated;

comment on function public.affiliate_approve_period(uuid, text) is
  'Moves a commission period to approved. Requires can_approve_affiliate_commissions() -- the money gate, not the program-management gate -- and is the only path the affiliate_periods_guard trigger accepts for that transition.';

-- ---------------------------------------------------------------------------
-- 9. Payout lifecycle -- draft, approve, export, record paid
-- ---------------------------------------------------------------------------
--
-- NOTHING IN THIS SECTION MOVES MONEY. The sequence is:
--
--   build   (manager)        -- collect unclaimed, hold-expired ledger entries
--   approve (money gate)     -- a human with journal-entry-level authority
--   export  (manager)        -- produce the file a person pays from, fingerprinted
--   paid    (money gate)     -- record the reference and the evidence AFTER
--                               the payment was made elsewhere
--
-- A payout can be voided at any point before it is marked paid, which
-- releases its entries back to the next build.

create or replace function public.affiliate_build_payout(
  p_affiliate uuid,
  p_through date default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_aff      public.affiliates;
  v_prog     public.affiliate_programs;
  v_company  uuid;
  v_through  date;
  v_payout   uuid;
  v_sum      bigint;
begin
  select * into v_aff from public.affiliates where id = p_affiliate;
  if not found then raise exception 'affiliate_build_payout: no such affiliate'; end if;
  v_company := v_aff.company_entity_id;

  if v_company is distinct from public.active_company_id()
     or not public.can_manage_affiliate_programs() then
    raise exception 'affiliate_build_payout: not permitted' using errcode = '42501';
  end if;

  select * into v_prog from public.affiliate_programs where id = v_aff.program_id;
  perform public.affiliate_lock_program_money(v_aff.program_id);
  v_through := coalesce(p_through, (now() at time zone public.silo_company_timezone(v_company))::date);

  create temporary table if not exists affiliate_payout_candidates (
    ledger_entry_id uuid primary key, amount_cents bigint
  ) on commit drop;
  -- pg_safeupdate (production) refuses a DELETE with no WHERE clause.
  delete from affiliate_payout_candidates where true;

  insert into affiliate_payout_candidates (ledger_entry_id, amount_cents)
  select l.id, l.amount_cents
    from public.affiliate_commission_ledger l
   where l.company_entity_id = v_company
     and l.affiliate_id = p_affiliate
     and l.currency = v_prog.currency
     -- Not already claimed by a payout. The unique index on
     -- affiliate_payout_items.ledger_entry_id is the real guarantee; this is
     -- the query that respects it.
     and not exists (
       select 1 from public.affiliate_payout_items i where i.ledger_entry_id = l.id
     )
     and (
       -- A reduction is payable immediately -- it reduces what we owe, and
       -- holding it back would mean paying out money we already know came
       -- back. Only POSITIVE entries wait out the program's refund hold.
       l.amount_cents < 0
       or l.order_day is null
       or (l.order_day + v_prog.refund_hold_days) <= v_through
     )
     -- An entry whose period exists and is not yet approved is not payable:
     -- the review gate is the point.
     and (
       l.period_id is null
       or exists (
         select 1 from public.affiliate_commission_periods pr
          where pr.id = l.period_id and pr.status in ('approved','paid')
       )
     );

  select coalesce(sum(amount_cents), 0) into v_sum from affiliate_payout_candidates;

  if v_sum <= 0 then
    raise exception 'affiliate_build_payout: nothing payable (balance would be % minor units)', v_sum;
  end if;
  if v_sum < v_prog.payout_minimum_cents then
    raise exception 'affiliate_build_payout: % is below the program minimum of %',
      v_sum, v_prog.payout_minimum_cents;
  end if;

  insert into public.affiliate_payouts (
    company_entity_id, program_id, affiliate_id, currency, amount_cents,
    method, status, created_by
  ) values (
    v_company, v_aff.program_id, p_affiliate, v_prog.currency, v_sum,
    v_prog.payout_method, 'draft', auth.uid()
  ) returning id into v_payout;

  insert into public.affiliate_payout_items (company_entity_id, payout_id, ledger_entry_id, amount_cents)
  select v_company, v_payout, c.ledger_entry_id, c.amount_cents
    from affiliate_payout_candidates c;

  return v_payout;
end;
$$;

comment on function public.affiliate_build_payout(uuid, date) is
  'Builds a DRAFT payout from this affiliate''s unclaimed ledger entries: positive entries only once the program''s refund hold has expired, negative entries always (money already known to have come back must not be paid out), and nothing from a period that exists and has not been approved. Refuses a non-positive total and a total under the program minimum. Manager gate; approving it is the money gate. Moves no money.';

revoke execute on function public.affiliate_build_payout(uuid, date) from public, anon;
grant execute on function public.affiliate_build_payout(uuid, date) to authenticated;

create or replace function public.affiliate_approve_payout(p_payout uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_company uuid; v_amount bigint; v_claimed bigint; v_program uuid; v_affiliate uuid;
  v_currency text; v_newer bigint;
begin
  select company_entity_id, amount_cents, program_id, affiliate_id, currency
    into v_company, v_amount, v_program, v_affiliate, v_currency
    from public.affiliate_payouts where id = p_payout;
  if not found then raise exception 'affiliate_approve_payout: no such payout'; end if;
  if v_company is distinct from public.active_company_id()
     or not public.can_approve_affiliate_commissions() then
    raise exception 'affiliate_approve_payout: approving a payout needs can_approve_affiliate_commissions()'
      using errcode = '42501';
  end if;

  perform public.affiliate_lock_program_money(v_program);

  -- A reduction that landed AFTER the draft was built (a refund, a
  -- cancellation, a negative manual adjustment) is money already known to
  -- have come back. Approving the old total would pay it anyway, so the
  -- draft must be rebuilt first (review cycle 1, P1). Approved amounts are
  -- never edited in place.
  select coalesce(sum(l.amount_cents), 0) into v_newer
    from public.affiliate_commission_ledger l
   where l.company_entity_id = v_company
     and l.affiliate_id = v_affiliate
     and l.currency = v_currency
     and l.amount_cents < 0
     and not exists (select 1 from public.affiliate_payout_items i where i.ledger_entry_id = l.id);
  if v_newer < 0 then
    raise exception 'affiliate_approve_payout: % minor units of refunds or reductions arrived after this draft was built -- void it and build again',
      -v_newer;
  end if;

  -- The stored total must still equal the entries it claims. A draft built
  -- before a refund landed would otherwise be approved for the old number
  -- while the ledger says something else, and the approval is the signature.
  select coalesce(sum(amount_cents), 0) into v_claimed
    from public.affiliate_payout_items where payout_id = p_payout;
  if v_claimed <> v_amount then
    raise exception 'affiliate_approve_payout: the ledger entries now total % but the payout says % -- void it and build again',
      v_claimed, v_amount;
  end if;

  update public.affiliate_payouts
     set status = 'approved', approved_by = auth.uid(), approved_at = now()
   where id = p_payout and status = 'draft';
  if not found then raise exception 'affiliate_approve_payout: payout is not a draft'; end if;
end;
$$;

revoke execute on function public.affiliate_approve_payout(uuid) from public, anon;
grant execute on function public.affiliate_approve_payout(uuid) to authenticated;

create or replace function public.affiliate_mark_payout_exported(p_payout uuid, p_fingerprint text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_company uuid;
begin
  select company_entity_id into v_company from public.affiliate_payouts where id = p_payout;
  if not found then raise exception 'affiliate_mark_payout_exported: no such payout'; end if;
  if v_company is distinct from public.active_company_id()
     or not public.can_manage_affiliate_programs() then
    raise exception 'affiliate_mark_payout_exported: not permitted' using errcode = '42501';
  end if;
  if btrim(coalesce(p_fingerprint, '')) = '' then
    raise exception 'affiliate_mark_payout_exported: a fingerprint of the exported file is required';
  end if;

  update public.affiliate_payouts
     set status = 'exported', exported_by = auth.uid(), exported_at = now(),
         export_fingerprint = p_fingerprint
   where id = p_payout and status = 'approved';
  if not found then raise exception 'affiliate_mark_payout_exported: payout is not approved'; end if;
end;
$$;

revoke execute on function public.affiliate_mark_payout_exported(uuid, text) from public, anon;
grant execute on function public.affiliate_mark_payout_exported(uuid, text) to authenticated;

-- The payment handoff, CONFIRMED BEFORE the file exists. The page used to
-- build the CSV from its own cached list and download it, then ask the
-- database to mark each row exported -- so a payout somebody else had
-- already voided or paid was still in the file a person pays from (review
-- cycle 1, P1). Now the database moves the still-approved rows to exported
-- under one batch id and returns exactly those; the page builds the file
-- from what came back. With p_batch it returns that batch again, unchanged,
-- so a lost file is downloaded again rather than re-exported.
create or replace function public.affiliate_claim_payout_export(
  p_program uuid,
  p_payouts uuid[] default null,
  p_batch uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid;
  v_batch   uuid := p_batch;
  v_rows    jsonb;
begin
  select company_entity_id into v_company from public.affiliate_programs where id = p_program;
  if v_company is null
     or v_company is distinct from public.active_company_id()
     or not public.can_manage_affiliate_programs() then
    raise exception 'affiliate_claim_payout_export: not permitted' using errcode = '42501';
  end if;
  perform public.affiliate_lock_program_money(p_program);

  if v_batch is null then
    if coalesce(array_length(p_payouts, 1), 0) = 0 then
      raise exception 'affiliate_claim_payout_export: no payouts were chosen';
    end if;
    v_batch := gen_random_uuid();
    update public.affiliate_payouts
       set status = 'exported', exported_by = auth.uid(), exported_at = now(), export_batch_id = v_batch
     where id = any(p_payouts)
       and company_entity_id = v_company
       and program_id = p_program
       and status = 'approved';
    if not found then
      raise exception 'affiliate_claim_payout_export: none of those payouts is still approved -- reload the page';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'affiliate_id', p.affiliate_id, 'amount_cents', p.amount_cents,
           'currency', p.currency, 'approved_at', p.approved_at, 'status', p.status,
           'item_count', (select count(*) from public.affiliate_payout_items i where i.payout_id = p.id))
         order by p.created_at, p.id), '[]'::jsonb)
    into v_rows
    from public.affiliate_payouts p
   where p.company_entity_id = v_company
     and p.program_id = p_program
     and p.export_batch_id = v_batch
     and p.status = 'exported';

  if p_batch is not null and v_rows = '[]'::jsonb then
    raise exception 'affiliate_claim_payout_export: nothing in that export is still waiting to be paid';
  end if;

  return jsonb_build_object('batch_id', v_batch, 'payouts', v_rows,
    'skipped', coalesce((select jsonb_agg(x) from unnest(coalesce(p_payouts, '{}'::uuid[])) x
                          where p_batch is null
                            and not exists (select 1 from public.affiliate_payouts q
                                             where q.id = x and q.export_batch_id = v_batch)), '[]'::jsonb));
end;
$$;

comment on function public.affiliate_claim_payout_export(uuid, uuid[], uuid) is
  'Moves the chosen payouts that are STILL approved to exported under one batch id and returns exactly those rows, so the payment file is built from confirmed rows only; with p_batch, returns that batch again for a re-download. Manager gate, program money lock. Moves no money.';

revoke execute on function public.affiliate_claim_payout_export(uuid, uuid[], uuid) from public, anon;
grant execute on function public.affiliate_claim_payout_export(uuid, uuid[], uuid) to authenticated;

-- The fingerprint of the file built from a confirmed batch, stored once.
create or replace function public.affiliate_set_payout_export_fingerprint(p_batch uuid, p_fingerprint text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_n integer;
begin
  if btrim(coalesce(p_fingerprint, '')) = '' then
    raise exception 'affiliate_set_payout_export_fingerprint: a fingerprint is required';
  end if;
  if not public.can_manage_affiliate_programs() then
    raise exception 'affiliate_set_payout_export_fingerprint: not permitted' using errcode = '42501';
  end if;
  update public.affiliate_payouts
     set export_fingerprint = p_fingerprint
   where export_batch_id = p_batch
     and company_entity_id = public.active_company_id()
     and export_fingerprint is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke execute on function public.affiliate_set_payout_export_fingerprint(uuid, text) from public, anon;
grant execute on function public.affiliate_set_payout_export_fingerprint(uuid, text) to authenticated;

create or replace function public.affiliate_mark_payout_paid(
  p_payout uuid,
  p_external_reference text,
  p_evidence text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_company uuid; v_method text;
begin
  select company_entity_id, method into v_company, v_method
    from public.affiliate_payouts where id = p_payout;
  if not found then raise exception 'affiliate_mark_payout_paid: no such payout'; end if;
  if v_company is distinct from public.active_company_id()
     or not public.can_approve_affiliate_commissions() then
    raise exception 'affiliate_mark_payout_paid: recording a payment needs can_approve_affiliate_commissions()'
      using errcode = '42501';
  end if;

  -- THE SAFEGUARD. No automated affiliate payout exists in this release: no
  -- payee account is created, no funding source is established, no provider
  -- webhook is handled. A payout whose method says otherwise must not be
  -- recordable as paid, because there is nothing that could have paid it.
  if v_method <> 'manual' then
    raise exception 'affiliate_mark_payout_paid: method % is not implemented. Affiliate payouts in this release are a manual handoff; set the program''s payout_method to manual, pay outside SILO, and record the reference here.', v_method
      using errcode = '0A000';
  end if;

  if btrim(coalesce(p_external_reference, '')) = '' or btrim(coalesce(p_evidence, '')) = '' then
    raise exception 'affiliate_mark_payout_paid: SILO did not make this payment, so a reference AND evidence are required';
  end if;

  update public.affiliate_payouts
     set status = 'marked_paid', marked_paid_by = auth.uid(), marked_paid_at = now(),
         external_reference = p_external_reference, paid_evidence = p_evidence
   where id = p_payout and status in ('approved','exported');
  if not found then
    raise exception 'affiliate_mark_payout_paid: payout is not approved or exported';
  end if;
end;
$$;

comment on function public.affiliate_mark_payout_paid(uuid, text, text) is
  'Records that a payout was paid OUTSIDE SILO. Money gate, and it refuses any method other than manual with a 0A000 (feature not supported): no provider integration exists in this release, so nothing could have paid a non-manual payout. A reference and written evidence are both required, because SILO did not make the payment and cannot observe it.';

revoke execute on function public.affiliate_mark_payout_paid(uuid, text, text) from public, anon;
grant execute on function public.affiliate_mark_payout_paid(uuid, text, text) to authenticated;

create or replace function public.affiliate_void_payout(p_payout uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_company uuid;
begin
  select company_entity_id into v_company from public.affiliate_payouts where id = p_payout;
  if not found then raise exception 'affiliate_void_payout: no such payout'; end if;
  if v_company is distinct from public.active_company_id()
     or not public.can_approve_affiliate_commissions() then
    raise exception 'affiliate_void_payout: voiding a payout needs can_approve_affiliate_commissions()'
      using errcode = '42501';
  end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'affiliate_void_payout: a reason is required';
  end if;

  -- A payout recorded as paid is history. Correcting one is a negative
  -- manual_adjustment on the ledger, not a void that silently frees entries
  -- somebody has already been paid for.
  update public.affiliate_payouts
     set status = 'void', void_reason = p_reason
   where id = p_payout and status in ('draft','approved','exported');
  if not found then
    raise exception 'affiliate_void_payout: only a draft, approved or exported payout can be voided';
  end if;

  -- Releasing the claims is the whole point of a void: those entries must be
  -- available to the next build.
  delete from public.affiliate_payout_items where payout_id = p_payout;
end;
$$;

revoke execute on function public.affiliate_void_payout(uuid, text) from public, anon;
grant execute on function public.affiliate_void_payout(uuid, text) to authenticated;

-- Re-resolving after a code was REASSIGNED to another program needs the old
-- row out of the way first: the unique key is the order, and the resolver
-- deliberately refuses to take over an order another program owns. This is
-- the one way to release one -- and it refuses any attribution the ledger has
-- already cited, because deleting that would orphan a commission entry and
-- leave a statement line pointing at nothing.
create or replace function public.affiliate_clear_attributions(
  p_program uuid,
  p_from date,
  p_to date
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_company uuid; v_cited integer; v_deleted integer;
begin
  select company_entity_id into v_company from public.affiliate_programs where id = p_program;
  if not found then raise exception 'affiliate_clear_attributions: no such program'; end if;
  if v_company is distinct from public.active_company_id()
     or not public.can_manage_affiliate_programs() then
    raise exception 'affiliate_clear_attributions: not permitted' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'affiliate_clear_attributions: a valid date range is required';
  end if;

  select count(*) into v_cited
    from public.affiliate_attributions a
   where a.company_entity_id = v_company and a.program_id = p_program
     and a.order_day between p_from and p_to
     and exists (select 1 from public.affiliate_commission_ledger l
                  where l.attribution_id = a.id);
  if v_cited > 0 then
    raise exception 'affiliate_clear_attributions: % of these attributions are cited by ledger entries. Reverse the commission with a manual_adjustment instead; the ledger is append-only and must keep pointing at something real.', v_cited;
  end if;

  delete from public.affiliate_attributions a
   where a.company_entity_id = v_company and a.program_id = p_program
     and a.order_day between p_from and p_to;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function public.affiliate_clear_attributions(uuid, date, date) from public, anon;
grant execute on function public.affiliate_clear_attributions(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. Reading surfaces
-- ---------------------------------------------------------------------------

-- Earned, claimed, paid and balance per affiliate. security_invoker, so RLS
-- on the ledger is what scopes it.
-- Each period's complete total, computed by the database. The page used to
-- add up the newest 300 ledger lines it had loaded for the whole program, so
-- a busy period showed less than it held and an older one showed $0 -- beside
-- the button that approves it (review cycle 1, P2). security_invoker: the
-- ledger's own RLS scopes it.
create or replace view public.affiliate_period_totals_v
  with (security_invoker = true) as
select
  l.company_entity_id,
  l.program_id,
  l.period_id,
  l.currency,
  sum(l.amount_cents)::bigint as amount_cents,
  count(*)::integer as entry_count
from public.affiliate_commission_ledger l
where l.period_id is not null
group by 1, 2, 3, 4;

comment on view public.affiliate_period_totals_v is
  'The full total and line count of each commission review period, per currency. security_invoker, so the ledger''s RLS applies. What the page shows beside "Approve".';

revoke all on public.affiliate_period_totals_v from anon;
grant select on public.affiliate_period_totals_v to authenticated, service_role;

create or replace view public.affiliate_balances_v
  with (security_invoker = true) as
select
  l.company_entity_id,
  l.program_id,
  l.affiliate_id,
  l.currency,
  sum(l.amount_cents)                                          as earned_cents,
  sum(l.amount_cents) filter (where l.kind = 'accrual')         as accrued_cents,
  sum(l.amount_cents) filter (where l.kind = 'refund_adjustment') as refund_adjustment_cents,
  sum(l.amount_cents) filter (where l.kind = 'manual_adjustment') as manual_adjustment_cents,
  coalesce(sum(claimed.amount_cents), 0)                        as claimed_cents,
  coalesce(sum(paid.amount_cents), 0)                           as paid_cents,
  sum(l.amount_cents) - coalesce(sum(claimed.amount_cents), 0)  as unclaimed_cents
from public.affiliate_commission_ledger l
left join lateral (
  select i.amount_cents
    from public.affiliate_payout_items i
    join public.affiliate_payouts p on p.id = i.payout_id and p.status <> 'void'
   where i.ledger_entry_id = l.id
) claimed on true
left join lateral (
  select i.amount_cents
    from public.affiliate_payout_items i
    join public.affiliate_payouts p on p.id = i.payout_id and p.status = 'marked_paid'
   where i.ledger_entry_id = l.id
) paid on true
group by 1,2,3,4;

comment on view public.affiliate_balances_v is
  'Per affiliate and currency: earned (the whole ledger), the three kinds separately, how much is claimed by a non-void payout, how much has actually been recorded as paid, and what is still unclaimed. unclaimed_cents can be NEGATIVE -- a refund found after a payout -- and that is a real state the payout screen must show rather than clamp.';

revoke all on public.affiliate_balances_v from anon;
grant select on public.affiliate_balances_v to authenticated, service_role;

-- What an affiliate drove, next to what they earned. The order counts are
-- over DISTINCT orders, because one order can never be more than one
-- attribution -- but saying so in the query means a later change to the
-- unique key cannot quietly double a revenue figure.
create or replace view public.affiliate_performance_v
  with (security_invoker = true) as
select
  a.company_entity_id,
  a.program_id,
  a.affiliate_id,
  min(a.order_day)                                              as first_order_day,
  max(a.order_day)                                              as last_order_day,
  count(distinct a.order_id)                                    as attributed_orders,
  count(distinct a.order_id) filter (where a.commissionable_cents is null) as orders_with_unknown_base,
  sum(a.gross_subtotal_cents)                                   as gross_subtotal_cents,
  sum(a.refunded_subtotal_cents)                                as refunded_subtotal_cents,
  sum(a.commissionable_cents)                                   as commissionable_cents,
  max(a.order_currency)                                         as order_currency,
  count(distinct a.order_currency)                              as distinct_currencies
from public.affiliate_attributions a
where a.affiliate_id is not null
  and a.basis in ('single_affiliate_code','first_affiliate_code')
group by 1,2,3;

comment on view public.affiliate_performance_v is
  'Per affiliate, over EARNING attributions only: orders, gross and refunded merchandise subtotal, commissionable base, and how many of those orders have an unknown base. distinct_currencies > 1 means the affiliate drove orders in more than one currency, which is a thing to look at rather than to sum. A code-attributed sale is not a proven incremental sale -- see docs/ops/affiliate-studio.md.';

revoke all on public.affiliate_performance_v from anon;
grant select on public.affiliate_performance_v to authenticated, service_role;

-- Why the module's numbers are what they are, in one row per program: the
-- funnel, and every refusal the resolver recorded.
create or replace view public.affiliate_program_health_v
  with (security_invoker = true) as
select
  p.company_entity_id,
  p.id as program_id,
  p.name,
  p.status,
  (select count(*) from public.affiliate_prospects x
    where x.program_id = p.id and x.status = 'new')        as prospects_new,
  (select count(*) from public.affiliate_prospects x
    where x.program_id = p.id and x.status = 'approved')   as prospects_approved,
  (select count(*) from public.affiliate_outreach_drafts d
    where d.program_id = p.id and d.state = 'approved')    as outreach_approved,
  (select count(*) from public.affiliate_outreach_drafts d
    where d.program_id = p.id and d.state = 'exported')    as outreach_exported,
  (select count(*) from public.affiliate_outreach_drafts d
    where d.program_id = p.id and d.state in ('sent','replied','declined','bounced'))
                                                           as outreach_marked_sent,
  (select count(*) from public.affiliates a
    where a.program_id = p.id and a.status = 'active')     as affiliates_active,
  (select count(*) from public.affiliates a
    where a.program_id = p.id and a.status in ('invited','pending_terms'))
                                                           as affiliates_pending,
  (select count(*) from public.affiliate_codes c
    where c.program_id = p.id and c.status = 'active')     as codes_active,
  (select count(*) from public.affiliate_codes c
    where c.program_id = p.id and c.status = 'active' and c.verified_at is null)
                                                           as codes_never_seen,
  (select count(*) from public.affiliate_attributions t
    where t.program_id = p.id and t.basis in ('single_affiliate_code','first_affiliate_code'))
                                                           as attributions_earning,
  (select count(*) from public.affiliate_attributions t
    where t.program_id = p.id and t.basis = 'ambiguous_multiple_affiliate_codes')
                                                           as attributions_ambiguous,
  (select count(*) from public.affiliate_attributions t
    where t.program_id = p.id and t.basis = 'multiple_codes_refused')
                                                           as attributions_multi_code_refused,
  (select count(*) from public.affiliate_attributions t
    where t.program_id = p.id and t.basis = 'code_outside_window')
                                                           as attributions_outside_window,
  (select count(*) from public.affiliate_attributions t
    where t.program_id = p.id and t.basis = 'currency_mismatch')
                                                           as attributions_currency_mismatch,
  (select count(*) from public.affiliate_attributions t
    where t.program_id = p.id and t.basis = 'refunds_not_measured')
                                                           as attributions_refunds_unmeasured
from public.affiliate_programs p;

comment on view public.affiliate_program_health_v is
  'One row per program: the recruiting funnel, and every attribution refusal the resolver recorded. The refusal counts exist so a page can explain a gap between coded sales and commissioned sales instead of leaving one.';

revoke all on public.affiliate_program_health_v from anon;
grant select on public.affiliate_program_health_v to authenticated, service_role;

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
