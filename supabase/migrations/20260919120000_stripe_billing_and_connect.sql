-- =============================================================================
-- Stripe, twice: SILO's own subscription revenue, and its clients' invoicing.
--
-- These are two different businesses wearing one vendor's name, and the whole
-- shape of this migration is the refusal to let them share a table, a webhook
-- endpoint, a gate or a resolution path.
--
--   A. BILLING   -- SILO is the merchant, a tenant company is the customer.
--                   Money moves to SILO's own Stripe account. One subscription
--                   per company. Nothing here is per-tenant credentials: the
--                   platform secret key is SILO's and is never company-scoped.
--
--   B. CONNECT   -- the tenant is the merchant, THEIR customer is the customer.
--                   Money moves to the tenant's own Stripe balance and never
--                   touches SILO's. SILO holds no key for them at all: every
--                   call is the platform key plus a `Stripe-Account` header.
--
-- ── WHY STANDARD CONNECT, NOT EXPRESS OR CUSTOM ─────────────────────────────
--
-- Standard means the client owns the Stripe account, keeps their own Stripe
-- dashboard, and carries their own liability for disputes and negative
-- balances. Express and Custom shift the onboarding UI -- and the liability --
-- onto the platform, which for SILO would mean underwriting a client's
-- chargebacks with no mechanism to fund them. `account_type` exists so that is
-- a decision a later migration can revisit per company; nothing in the code
-- below assumes Standard beyond the onboarding link shape.
--
-- The consequence worth stating: there is NO per-tenant secret at rest
-- anywhere in this file. That is deliberate and it is why these tables do not
-- copy `redo_connections`' admin-only SELECT for their whole surface --
-- `redo_connections` guards a stored `webhook_secret`, and there is nothing
-- equivalent here. What IS guarded is money data (amounts owed, customer
-- lists, requirement gaps), on its own merits.
--
-- ── WHY STRIPE IS THE SYSTEM OF RECORD AND THESE TABLES ARE A MIRROR ────────
--
-- Same stance QuickBooks already has here: SILO computes and stages, the
-- external system holds the truth, and SILO must never display a state the
-- external system does not have. So:
--
--   * No client-writable row in any mirror table. Not one INSERT/UPDATE/DELETE
--     policy on stripe_invoices, stripe_invoice_lines, stripe_invoice_customers,
--     billing_subscriptions, billing_invoices or stripe_connect_accounts. Every
--     write lands through a SECURITY DEFINER sync function called by an edge
--     function AFTER Stripe has confirmed, from the object Stripe returned.
--     A locally-drafted invoice that Stripe rejected would otherwise sit in the
--     list looking sent.
--   * Every mutation re-FETCHES the object and syncs what came back, rather
--     than patching the columns the caller believes it changed.
--
-- ── WHY A MONOTONIC GUARD RATHER THAN LAST-WRITE-WINS ───────────────────────
--
-- Stripe webhooks are not ordered. `invoice.finalized` and `invoice.paid` for
-- one invoice arrive in whichever order the network delivers them, and a retry
-- of a 3-minute-old event arrives after the current state. Last-write-wins
-- therefore reverts a paid invoice to open at random.
--
-- Because every write re-fetches, `stripe_synced_at` is the time OF THE FETCH,
-- not of the event, so it orders correctly across out-of-order deliveries. The
-- sync functions compare it and return early; a BEFORE UPDATE trigger repeats
-- the comparison as a backstop for any writer that bypasses them (the service
-- role bypasses RLS, so a policy cannot be that backstop). Same "newest
-- completed run wins" mechanism the search_console_*_daily tables already use.
--
-- ── WHY THE IDEMPOTENCY LEDGER ──────────────────────────────────────────────
--
-- Stripe's own `Idempotency-Key` header covers 24 hours and only if the retry
-- carries the same key -- which a browser that lost the response and re-posted
-- a fresh uuid does not. This is the platform_invites.created_company_id lesson
-- verbatim: the failure atomicity does not cover is the LOST RESPONSE. So the
-- page mints a request_id, `stripe_invoice_requests` records it BEFORE Stripe
-- is called, and a second attempt with that id returns the invoice the first
-- one made rather than billing the client's customer twice.
--
-- ── WHY STRIPE'S OWN STATUS VOCABULARIES ARE NOT CHECK-CONSTRAINED ──────────
--
-- Every other status column in this schema carries a CHECK, and that is right
-- for a vocabulary SILO owns. `stripe_invoices.status` is not one: Stripe can
-- add a value at any time, and a CHECK would then REFUSE the sync -- leaving
-- the mirror frozen on the previous state while Stripe moved on. A stale
-- mirror that looks current is the failure mode this whole file is arranged
-- against. SILO-owned vocabularies (billing_plans.billing_interval,
-- stripe_webhook_events.status, stripe_invoice_requests.action) keep their
-- CHECKs.
--
-- ── WHY AMOUNTS ARE INTEGER CENTS ───────────────────────────────────────────
--
-- Stripe's API is minor units. Converting to numeric(14,2) at the boundary
-- means every read and write crosses a rounding step for no gain, and is
-- simply WRONG for zero-decimal currencies (JPY: `amount: 500` is ¥500, not
-- ¥5.00). Cents plus the currency code, formatted at the edge. `quantity` is
-- the one numeric -- Stripe allows fractional quantities.
--
-- ── WHY A GATE NARROWER THAN is_admin_user() ────────────────────────────────
--
-- 28 of 29 Baseballism profiles are membership 'admin'. Reusing is_admin_user()
-- would let nearly the whole company issue invoices to real customers in the
-- company's name and read every amount owed. `can_manage_client_invoices()` is
-- therefore the same population as `can_manage_journal_entries()` --
-- owner_admin, or profile owner, or department finance/exec -- and is a
-- SEPARATE function rather than a reuse, because "may post to the general
-- ledger" and "may bill a customer" are different authorities that will
-- diverge (exactly as current_user_can_manage_comp_requests() diverged from
-- the AP gate it was copied from).
--
-- Committing the COMPANY to a paid SILO plan is narrower still: the checkout
-- and portal edge functions require is_owner_admin_of_active_company().
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Helpers
-- ---------------------------------------------------------------------------

-- Who may bill this company's customers, and read what they owe. See the
-- header: deliberately NOT is_admin_user().
create or replace function public.can_manage_client_invoices()
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

comment on function public.can_manage_client_invoices() is
  'May the caller issue invoices to their active company''s customers through Stripe Connect, and read the amounts owed. Same population as can_manage_journal_entries() (membership owner_admin, profile owner, or department finance/exec) and deliberately not is_admin_user(), which passes for any membership admin -- 28 of 29 Baseballism profiles are membership admin. A separate function because billing a customer and posting a journal entry are different authorities.';

revoke execute on function public.can_manage_client_invoices() from public, anon;
grant execute on function public.can_manage_client_invoices() to authenticated;

-- Stripe timestamps are epoch seconds. Null in, null out -- a missing
-- `paid_at` must stay missing rather than become 1970.
create or replace function public.stripe_epoch(p_seconds bigint)
returns timestamptz
language sql
immutable
as $$
  select case when p_seconds is null then null
              else to_timestamp(p_seconds) end;
$$;

-- jsonb -> bigint that treats an absent key and an explicit JSON null alike,
-- and refuses a non-numeric rather than silently zeroing it (a zeroed
-- amount_due reads as "nothing owed").
create or replace function public.stripe_cents(p_payload jsonb, p_key text)
returns bigint
language plpgsql
immutable
as $$
declare v jsonb := p_payload -> p_key;
begin
  if v is null or jsonb_typeof(v) = 'null' then return null; end if;
  if jsonb_typeof(v) <> 'number' then
    raise exception 'stripe_cents: % is %, not a number', p_key, jsonb_typeof(v);
  end if;
  return (v #>> '{}')::bigint;
end;
$$;

-- The PERMISSIVE sibling of stripe_cents, and the difference is deliberate.
--
-- stripe_cents guards a figure the mirror publishes as fact: an absent key is
-- null (unknown), and anything non-numeric RAISES, because a zeroed
-- amount_due reads as "nothing owed". That strictness is right there and
-- catastrophic here. `unit_amount_excluding_tax` arrives as a DECIMAL STRING,
-- not a number, so passing it to stripe_cents raised -- and it is read inside
-- stripe_sync_invoice's line loop, so one invoice line without an inline
-- `price.unit_amount` (a metered or tiered price, or an item added in the
-- Stripe dashboard) aborted the whole sync. The webhook then answered 500 and
-- Stripe retried for three days against a row that would never land.
--
-- So this one never raises. It accepts a number or a numeric string, and
-- returns NULL for anything it cannot represent exactly as an integer minor
-- unit -- including a fractional one. Null here means "this line's unit price
-- is not resolved", which is true and harmless: the line's `amount` is carried
-- separately and is what the invoice totals from.
create or replace function public.stripe_decimal_cents(p_payload jsonb, p_key text)
returns bigint
language plpgsql
immutable
as $$
declare
  v jsonb := p_payload -> p_key;
  t text;
  n numeric;
begin
  if v is null or jsonb_typeof(v) = 'null' then return null; end if;
  t := v #>> '{}';
  if t is null or t !~ '^-?[0-9]+(\.[0-9]+)?$' then return null; end if;
  n := t::numeric;
  if n <> trunc(n) then return null; end if;
  return n::bigint;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. A. SILO subscription billing (platform Stripe account)
-- ---------------------------------------------------------------------------

-- The plan catalogue. GLOBAL: no company_entity_id at all, one definition
-- reused by every tenant, same stance as a `system` saved report. A client
-- cannot write it -- there is a SELECT policy and no write policy whatsoever,
-- so adding a plan is a migration or a service-role write. Price is Stripe's;
-- unit_amount_cents here is a DISPLAY copy and is explicitly allowed to be
-- null rather than guessed.
create table if not exists public.billing_plans (
  id                 uuid primary key default gen_random_uuid(),
  plan_key           text not null unique,
  title              text not null,
  description        text,
  stripe_price_id    text not null unique,
  unit_amount_cents  bigint,
  currency           text not null default 'usd',
  billing_interval   text not null default 'month'
                       check (billing_interval in ('month','year')),
  seat_based         boolean not null default false,
  is_active          boolean not null default true,
  sort_order         integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.billing_plans is
  'SILO subscription plan catalogue, mapping a SILO plan key to a Stripe price on the PLATFORM account. Global (no company column) -- one definition every tenant reads, like a system saved report. No client write policy: a plan is a migration or a service-role write. unit_amount_cents is a display copy; the authoritative price is Stripe''s.';

-- One SILO subscription per company, keyed BY the company. stripe_customer_id
-- is written when checkout begins, not when it completes: it is what
-- stripe_resolve_event_company() uses to attribute a platform webhook, and a
-- webhook can arrive before the browser returns from Stripe.
create table if not exists public.billing_subscriptions (
  company_entity_id      uuid primary key references public.entities(id) on delete cascade,
  stripe_customer_id     text not null unique,
  stripe_subscription_id text unique,
  plan_key               text references public.billing_plans(plan_key),
  stripe_price_id        text,
  status                 text,
  quantity               integer,
  currency               text,
  unit_amount_cents      bigint,
  current_period_start   timestamptz,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  canceled_at            timestamptz,
  trial_end              timestamptz,
  collection_issue       text,
  stripe_synced_at       timestamptz not null default now(),
  raw                    jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table public.billing_subscriptions is
  'One row per company: what that tenant pays SILO. Written only by stripe_sync_subscription() / stripe_begin_checkout() (SECURITY DEFINER, service-role) from the object Stripe returned -- no client write policy. status carries Stripe''s own vocabulary uncoerced and uncheck-constrained on purpose (a new Stripe status must not freeze the mirror). collection_issue is SILO''s one-word summary of why money is not arriving (past_due / unpaid / incomplete), null when nothing is wrong.';

-- SILO's invoices TO the tenant. Kept locally rather than fetched live so the
-- billing page renders without a Stripe round trip and so a lapsed tenant can
-- still see what they were charged.
create table if not exists public.billing_invoices (
  id                 uuid primary key default gen_random_uuid(),
  company_entity_id  uuid not null references public.entities(id) on delete cascade,
  stripe_invoice_id  text not null unique,
  stripe_customer_id text,
  number             text,
  status             text,
  currency           text,
  amount_due_cents   bigint,
  amount_paid_cents  bigint,
  period_start       timestamptz,
  period_end         timestamptz,
  due_date           timestamptz,
  paid_at            timestamptz,
  hosted_invoice_url text,
  invoice_pdf_url    text,
  stripe_synced_at   timestamptz not null default now(),
  raw                jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_billing_invoices_company
  on public.billing_invoices (company_entity_id, period_start desc);

comment on table public.billing_invoices is
  'What SILO charged a tenant, mirrored from the platform Stripe account. Read-only to clients; hosted_invoice_url / invoice_pdf_url are Stripe-hosted and are the receipt.';

-- ---------------------------------------------------------------------------
-- 2. B. Stripe Connect -- the tenant's own merchant account
-- ---------------------------------------------------------------------------

create table if not exists public.stripe_connect_accounts (
  company_entity_id       uuid primary key references public.entities(id) on delete cascade,
  stripe_account_id       text not null unique,
  account_type            text not null default 'standard'
                            check (account_type in ('standard','express')),
  country                 text,
  default_currency        text,
  business_name           text,
  charges_enabled         boolean not null default false,
  payouts_enabled         boolean not null default false,
  details_submitted       boolean not null default false,
  disabled_reason         text,
  requirements            jsonb not null default '{}'::jsonb,
  onboarding_started_at   timestamptz,
  onboarding_completed_at timestamptz,
  stripe_synced_at        timestamptz not null default now(),
  raw                     jsonb not null default '{}'::jsonb,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid references auth.users(id) on delete set null
);

comment on table public.stripe_connect_accounts is
  'The tenant''s OWN Stripe account (Connect Standard), one per company. SILO stores no key for it -- every call is the platform secret key plus a Stripe-Account header, so the only credential-shaped thing here is the account id, which is useless without the platform key. charges_enabled / payouts_enabled / details_submitted are Stripe''s, re-fetched on every touch; never infer "onboarded" from onboarding_completed_at alone, which only records when SILO last saw the return redirect.';

-- The pair a child row points at. Not merely an index: the composite FK below
-- is what makes it impossible for an invoice row to name company A and the
-- Stripe account of company B, which is the one cross-tenant mistake a bug in
-- an edge function could otherwise make silently.
create unique index if not exists idx_stripe_connect_company_account
  on public.stripe_connect_accounts (company_entity_id, stripe_account_id);

-- What a non-finance member of the company may know: whether invoicing works
-- at all. SECURITY DEFINER (security_invoker = false) with its own explicit
-- tenant filter, because the base table's SELECT is finance-gated and an
-- invoker view over it would show such a member nothing -- leaving the
-- invoicing page unable to say "your company has not finished Stripe
-- onboarding" to the person looking at the empty screen. Same layering as
-- wow_sales_daily_type_v: no RLS underneath, so the WHERE clause is the tenant
-- boundary, and the column list is the disclosure boundary -- `requirements`,
-- `raw` and the account id are deliberately absent.
drop view if exists public.stripe_connect_status_v;
create view public.stripe_connect_status_v
with (security_invoker = false) as
  select
    a.company_entity_id,
    a.charges_enabled,
    a.payouts_enabled,
    a.details_submitted,
    a.default_currency,
    (a.disabled_reason is not null) as is_restricted,
    a.onboarding_completed_at
  from public.stripe_connect_accounts a
  where a.company_entity_id = public.active_company_id();

-- Supabase's default privileges GRANT ALL on a newly created view, and this
-- one is SECURITY DEFINER over an RLS-protected table -- a simple view is
-- auto-updatable in Postgres, so the default grant would let any authenticated
-- user UPDATE through it with RLS bypassed. Found by verify_v2_schema.sql's own
-- Stripe grant check while it was being written.
revoke all on public.stripe_connect_status_v from anon, authenticated;
grant select on public.stripe_connect_status_v to authenticated;

comment on view public.stripe_connect_status_v is
  'Can this company invoice yet -- readable by any member, unlike the finance-gated table underneath. security_invoker = false with an explicit active_company_id() filter: that filter IS the tenant boundary here, so do not remove it and do not widen the column list (the account id, the requirements payload and raw are withheld on purpose).';

-- The tenant's customers, mirrored from THEIR Stripe account. A row here is
-- never authored in SILO -- it is what Stripe returned after a create.
create table if not exists public.stripe_invoice_customers (
  id                 uuid primary key default gen_random_uuid(),
  company_entity_id  uuid not null references public.entities(id) on delete cascade,
  stripe_account_id  text not null,
  stripe_customer_id text not null,
  name               text,
  email              text,
  phone              text,
  currency           text,
  address            jsonb,
  metadata           jsonb not null default '{}'::jsonb,
  delinquent         boolean not null default false,
  stripe_synced_at   timestamptz not null default now(),
  raw                jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references auth.users(id) on delete set null,
  constraint stripe_invoice_customers_unique unique (company_entity_id, stripe_customer_id),
  constraint stripe_invoice_customers_account_fk
    foreign key (company_entity_id, stripe_account_id)
    references public.stripe_connect_accounts (company_entity_id, stripe_account_id)
    on delete cascade
);

create index if not exists idx_stripe_invoice_customers_name
  on public.stripe_invoice_customers (company_entity_id, lower(coalesce(name, email)));

create table if not exists public.stripe_invoices (
  id                     uuid primary key default gen_random_uuid(),
  company_entity_id      uuid not null references public.entities(id) on delete cascade,
  stripe_account_id      text not null,
  stripe_invoice_id      text not null,
  stripe_customer_id     text,
  customer_name          text,
  customer_email         text,
  number                 text,
  status                 text not null default 'draft',
  currency               text not null default 'usd',
  subtotal_cents         bigint not null default 0,
  tax_cents              bigint,
  total_cents            bigint not null default 0,
  amount_due_cents       bigint not null default 0,
  amount_paid_cents      bigint not null default 0,
  amount_remaining_cents bigint not null default 0,
  collection_method      text,
  description            text,
  footer                 text,
  due_date               timestamptz,
  finalized_at           timestamptz,
  paid_at                timestamptz,
  voided_at              timestamptz,
  marked_uncollectible_at timestamptz,
  hosted_invoice_url     text,
  invoice_pdf_url        text,
  request_id             uuid,
  stripe_synced_at       timestamptz not null default now(),
  raw                    jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  created_by             uuid references auth.users(id) on delete set null,
  constraint stripe_invoices_unique unique (company_entity_id, stripe_invoice_id),
  constraint stripe_invoices_account_fk
    foreign key (company_entity_id, stripe_account_id)
    references public.stripe_connect_accounts (company_entity_id, stripe_account_id)
    on delete cascade
);

create index if not exists idx_stripe_invoices_company_status
  on public.stripe_invoices (company_entity_id, status, created_at desc);

comment on table public.stripe_invoices is
  'Invoices a TENANT issued to ITS OWN customers through Stripe Connect -- not SILO''s invoices to the tenant (that is billing_invoices). Mirror only: no client write policy, every row written by stripe_sync_invoice() from the object Stripe returned. The composite FK to (company_entity_id, stripe_account_id) makes an invoice that names one company and another company''s Stripe account unrepresentable. Amounts are integer MINOR UNITS with the currency beside them, exactly as Stripe sends them.';

create table if not exists public.stripe_invoice_lines (
  id                 uuid primary key default gen_random_uuid(),
  company_entity_id  uuid not null references public.entities(id) on delete cascade,
  invoice_id         uuid not null references public.stripe_invoices(id) on delete cascade,
  stripe_line_id     text not null,
  description        text,
  quantity           numeric,
  unit_amount_cents  bigint,
  amount_cents       bigint not null default 0,
  currency           text,
  period_start       timestamptz,
  period_end         timestamptz,
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  constraint stripe_invoice_lines_unique unique (invoice_id, stripe_line_id)
);

comment on table public.stripe_invoice_lines is
  'Line detail per stripe_invoices row, REPLACED wholesale on every sync (delete then insert, like redo_return_items) rather than upserted per line -- an edited Stripe invoice can drop a line, and an upsert would leave the removed line behind, so the mirror would show a total its own lines do not add up to.';

-- The idempotency ledger. See the header: Stripe's Idempotency-Key does not
-- cover a browser that lost the response and retried with a fresh uuid, which
-- is the retry that actually happens.
create table if not exists public.stripe_invoice_requests (
  request_id           uuid primary key,
  company_entity_id    uuid not null references public.entities(id) on delete cascade,
  stripe_account_id    text not null,
  action               text not null check (action in ('create_customer','create_invoice')),
  status               text not null default 'pending'
                         -- `ambiguous` is the state that makes the Stripe
                         -- idempotency key usable: the create call failed
                         -- without telling us whether Stripe committed (a
                         -- timeout, a reset), so the caller must retry with
                         -- the SAME request id -- which is what the Stripe key
                         -- is derived from, so Stripe collapses it onto the
                         -- original invoice. Recorded as `failed` instead, the
                         -- browser read it as "nothing was created", minted a
                         -- fresh uuid, and therefore a fresh Stripe key.
                         check (status in ('pending','succeeded','failed','ambiguous')),
  stripe_object_id     text,
  error_message        text,
  payload_fingerprint  text,
  created_by           uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  completed_at         timestamptz
);

comment on table public.stripe_invoice_requests is
  'One row per attempt to create something billable in a tenant''s Stripe account, written BEFORE Stripe is called. A retry carrying the same request_id returns the object the first attempt made instead of creating a second one -- the platform_invites.created_company_id mechanism, for the same reason: the failure atomicity does not cover is the lost response, and here the cost of a double-create is a real customer invoiced twice.';

-- ---------------------------------------------------------------------------
-- 3. Webhook deliveries
-- ---------------------------------------------------------------------------

-- Insert-first, before any handling: the PK is the idempotency guard against
-- Stripe's own retries. `unresolved` is a real, recorded outcome -- an event
-- for an account SILO does not know must leave a trace, not be dropped.
create table if not exists public.stripe_webhook_events (
  stripe_event_id    text primary key,
  endpoint           text not null check (endpoint in ('platform','connect')),
  event_type         text not null,
  stripe_account_id  text,
  company_entity_id  uuid references public.entities(id) on delete set null,
  event_created_at   timestamptz,
  status             text not null default 'received'
                       check (status in ('received','processed','ignored','unresolved','error')),
  error_message      text,
  received_at        timestamptz not null default now(),
  processed_at       timestamptz
);

create index if not exists idx_stripe_webhook_events_recent
  on public.stripe_webhook_events (received_at desc);

comment on table public.stripe_webhook_events is
  'Every Stripe delivery, recorded before it is handled -- the primary key IS the deduplication of Stripe''s retries. status=unresolved means the event named an account or customer no company here owns; that is recorded rather than dropped, because silently ignoring a payment notification is indistinguishable from never receiving one.';

-- ---------------------------------------------------------------------------
-- 4. The staleness backstop
-- ---------------------------------------------------------------------------
--
-- The sync functions already return early on an older fetch. This repeats the
-- test at the row, for any writer that reaches the table another way -- the
-- service role bypasses RLS, so a policy could never be this backstop.
-- Strictly older only: an equal timestamp is the same fetch being re-applied
-- and must still land (a retried sync of a partially-written row).
create or replace function public.stripe_drop_stale_sync()
returns trigger
language plpgsql
as $$
begin
  if new.stripe_synced_at < old.stripe_synced_at then
    return null;  -- skip the UPDATE entirely; the newer row stands
  end if;
  return new;
end;
$$;

comment on function public.stripe_drop_stale_sync() is
  'BEFORE UPDATE backstop: an update carrying an older stripe_synced_at than the stored row is DROPPED (returns null), so a late webhook retry cannot revert a paid invoice to open. Returns null rather than old deliberately -- returning old would perform a pointless write and re-fire triggers.';

do $$
declare t text;
begin
  foreach t in array array[
    'billing_subscriptions','billing_invoices','stripe_connect_accounts',
    'stripe_invoice_customers','stripe_invoices'
  ] loop
    execute format('drop trigger if exists stripe_drop_stale_sync on public.%I', t);
    execute format(
      'create trigger stripe_drop_stale_sync before update on public.%I
         for each row execute function public.stripe_drop_stale_sync()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5. RLS
--
-- Read-only to every client, for every table in this file. The write side is
-- absent on purpose rather than gated: there is no legitimate client write to
-- a mirror of an external system, and a gated write policy invites one.
-- ---------------------------------------------------------------------------

alter table public.billing_plans            enable row level security;
alter table public.billing_subscriptions    enable row level security;
alter table public.billing_invoices         enable row level security;
alter table public.stripe_connect_accounts  enable row level security;
alter table public.stripe_invoice_customers enable row level security;
alter table public.stripe_invoices          enable row level security;
alter table public.stripe_invoice_lines     enable row level security;
alter table public.stripe_invoice_requests  enable row level security;
alter table public.stripe_webhook_events    enable row level security;

revoke all on public.billing_plans,
              public.billing_subscriptions,
              public.billing_invoices,
              public.stripe_connect_accounts,
              public.stripe_invoice_customers,
              public.stripe_invoices,
              public.stripe_invoice_lines,
              public.stripe_invoice_requests,
              public.stripe_webhook_events
  from anon, authenticated;

grant select on public.billing_plans,
                public.billing_subscriptions,
                public.billing_invoices,
                public.stripe_connect_accounts,
                public.stripe_invoice_customers,
                public.stripe_invoices,
                public.stripe_invoice_lines,
                public.stripe_invoice_requests
  to authenticated;

grant select on public.stripe_connect_status_v to authenticated;

-- The catalogue is global and carries no company's data -- a price list.
drop policy if exists billing_plans_select on public.billing_plans;
create policy billing_plans_select on public.billing_plans
  for select to authenticated using (is_active or public.is_admin_user());

-- What this company pays SILO: admin-tier of THIS company only. Not
-- can_manage_client_invoices() -- that gate is about billing customers, and an
-- admin who cannot issue invoices can still reasonably be asked whether the
-- company's own SILO subscription lapsed.
drop policy if exists billing_subscriptions_select on public.billing_subscriptions;
create policy billing_subscriptions_select on public.billing_subscriptions
  for select to authenticated
  using (company_entity_id = public.active_company_id() and public.is_admin_user());

drop policy if exists billing_invoices_select on public.billing_invoices;
create policy billing_invoices_select on public.billing_invoices
  for select to authenticated
  using (company_entity_id = public.active_company_id() and public.is_admin_user());

-- The connected account row carries the requirements payload (what Stripe is
-- still waiting on, which can name a person and a document), so the table is
-- admin-gated and stripe_connect_status_v exists for everyone else.
drop policy if exists stripe_connect_accounts_select on public.stripe_connect_accounts;
create policy stripe_connect_accounts_select on public.stripe_connect_accounts
  for select to authenticated
  using (company_entity_id = public.active_company_id() and public.is_admin_user());

drop policy if exists stripe_invoice_customers_select on public.stripe_invoice_customers;
create policy stripe_invoice_customers_select on public.stripe_invoice_customers
  for select to authenticated
  using (company_entity_id = public.active_company_id()
         and (public.can_manage_client_invoices() or public.is_exec_or_owner()));

drop policy if exists stripe_invoices_select on public.stripe_invoices;
create policy stripe_invoices_select on public.stripe_invoices
  for select to authenticated
  using (company_entity_id = public.active_company_id()
         and (public.can_manage_client_invoices() or public.is_exec_or_owner()));

-- Lines inherit the parent invoice's visibility through an EXISTS rather than
-- repeating the gate, so the two can never disagree (the pattern
-- comp_adjustment_request_activity already uses).
drop policy if exists stripe_invoice_lines_select on public.stripe_invoice_lines;
create policy stripe_invoice_lines_select on public.stripe_invoice_lines
  for select to authenticated
  using (exists (select 1 from public.stripe_invoices i
                  where i.id = stripe_invoice_lines.invoice_id));

drop policy if exists stripe_invoice_requests_select on public.stripe_invoice_requests;
create policy stripe_invoice_requests_select on public.stripe_invoice_requests
  for select to authenticated
  using (company_entity_id = public.active_company_id()
         and (public.can_manage_client_invoices() or public.is_exec_or_owner()));

-- stripe_webhook_events: RLS enabled, NO policy and NO grant. Service role
-- only. It is plumbing, and the one table here whose rows describe deliveries
-- rather than the company's own business.

-- ---------------------------------------------------------------------------
-- 6. Sync functions -- the only writers
--
-- Every one is SECURITY DEFINER and revoked from anon AND authenticated:
-- Supabase's default privileges grant EXECUTE on new public functions to both,
-- so the revoke is the boundary, not an afterthought (20260904330000 is the
-- precedent -- anon could call chat_run_readonly_query for exactly this
-- reason). They are called by the edge functions with the service-role key.
-- ---------------------------------------------------------------------------

-- Which company does this delivery belong to? ONE definition, deliberately
-- not metadata-driven: an account id and a customer id are issued by Stripe
-- and recorded here when SILO created them, whereas metadata on a connected
-- account can be written by the client who owns that account. Returns null
-- for an unknown account/customer -- the caller records `unresolved` rather
-- than guessing.
create or replace function public.stripe_resolve_event_company(
  p_endpoint text,
  p_account  text default null,
  p_customer text default null
)
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v_company uuid;
begin
  if p_endpoint = 'connect' then
    if p_account is null then
      raise exception 'stripe_resolve_event_company: a connect event with no account id is mis-routed';
    end if;
    select company_entity_id into v_company
      from public.stripe_connect_accounts where stripe_account_id = p_account;
    return v_company;
  elsif p_endpoint = 'platform' then
    -- A platform event must NOT carry an account id. If it does, the endpoint
    -- secrets have been crossed and attributing it by customer would file a
    -- tenant's own Stripe activity as SILO revenue.
    if p_account is not null then
      raise exception 'stripe_resolve_event_company: platform event carries account %, refusing to attribute it', p_account;
    end if;
    if p_customer is null then return null; end if;
    select company_entity_id into v_company
      from public.billing_subscriptions where stripe_customer_id = p_customer;
    return v_company;
  else
    raise exception 'stripe_resolve_event_company: unknown endpoint %', p_endpoint;
  end if;
end;
$$;

-- Claim a delivery for handling. Returns WHICH of three things happened, not a
-- boolean -- because the caller's answer to Stripe differs for each, and a
-- boolean forced the two refusals to share one response:
--
--   claimed  -- you own this delivery, process it
--   leased   -- a `received` row is in flight and not yet stale. NOT terminal:
--               the caller must answer NON-2xx so Stripe delivers again later.
--               This is the case the boolean got wrong. A handler that failed
--               AND whose status write also failed leaves the row `received`;
--               Stripe's prompt retry then arrived inside the ten-minute lease,
--               was called a duplicate, and got a 200 -- so Stripe stopped
--               retrying and the event was lost during exactly the database
--               outage that asked for the retry.
--   terminal -- processed or ignored. Answer 200; re-running it is the
--               double-processing the claim exists to prevent.
--
-- Insert-first deduplication of Stripe's retries was the whole of this
-- function, and it was WRONG IN THE ONE CASE THE RETRY EXISTS FOR. The
-- caller records the event, dispatches, and on a transient failure marks the
-- row `error` and returns 500 precisely so Stripe will send it again -- but a
-- plain `on conflict do nothing` then reported that retry as a duplicate, so
-- the handler never ran again and an `invoice.paid` could be lost forever.
-- The endpoint asked for a retry it had already made useless.
--
-- So the claim is RECLAIMABLE, and atomically: `on conflict do update ...
-- where` takes the row lock, and row_count is 1 only if this caller either
-- inserted the row or won the update. Two concurrent deliveries of one event
-- cannot both be told to process it.
--
-- What is reclaimable, and why:
--   error       -- a failure that asked for the retry. The whole point.
--   unresolved  -- the event named an account SILO did not know YET. A tenant
--                  finishing Connect onboarding a minute later makes the same
--                  event resolvable, and Stripe retries for three days.
--   received    -- only once STALE (10 minutes). An edge function killed
--                  mid-handler (the gateway stops a request at 150s) otherwise
--                  leaves the row claimed forever. Ten minutes is far beyond
--                  any real in-flight handler and far under Stripe's retry
--                  window.
-- NOT reclaimable: processed and ignored. Those are terminal successes, and
-- re-running them is the double-processing this function exists to prevent.
create or replace function public.stripe_record_webhook_event(
  p_event_id   text,
  p_endpoint   text,
  p_event_type text,
  p_account    text default null,
  p_company    uuid default null,
  p_created    timestamptz default null
)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_claimed boolean;
  v_status  text;
begin
  insert into public.stripe_webhook_events
    (stripe_event_id, endpoint, event_type, stripe_account_id, company_entity_id, event_created_at)
  values (p_event_id, p_endpoint, p_event_type, p_account, p_company, p_created)
  on conflict (stripe_event_id) do update
    set status = 'received',
        error_message = null,
        processed_at = null,
        received_at = now(),
        -- A retry may resolve to a company the first attempt could not. Never
        -- overwrite a known company with null.
        company_entity_id = coalesce(excluded.company_entity_id,
                                     stripe_webhook_events.company_entity_id),
        stripe_account_id = coalesce(excluded.stripe_account_id,
                                     stripe_webhook_events.stripe_account_id)
    where stripe_webhook_events.status in ('error', 'unresolved')
       or (stripe_webhook_events.status = 'received'
           and stripe_webhook_events.received_at < now() - interval '10 minutes');
  get diagnostics v_claimed = row_count;
  if v_claimed then return 'claimed'; end if;

  select status into v_status
    from public.stripe_webhook_events where stripe_event_id = p_event_id;

  -- Only processed and ignored are terminal. Anything else means the row is
  -- leased by an attempt that has not reported back, and the honest answer to
  -- Stripe is "come back", not "thanks, done".
  if v_status in ('processed', 'ignored') then return 'terminal'; end if;
  return 'leased';
end;
$$;

create or replace function public.stripe_finish_webhook_event(
  p_event_id text,
  p_status   text,
  p_error    text default null
)
returns void
language sql
security definer
set search_path to 'public'
as $$
  update public.stripe_webhook_events
     set status = p_status,
         error_message = p_error,
         processed_at = now()
   where stripe_event_id = p_event_id;
$$;

-- Records the Stripe customer for a company BEFORE checkout is handed to
-- Stripe, so the subscription webhook that follows can be attributed. Returns
-- the row's company so a caller cannot quietly repoint one company's customer
-- at another: a customer id already bound elsewhere raises.
create or replace function public.stripe_begin_checkout(
  p_company  uuid,
  p_customer text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_owner uuid;
begin
  select company_entity_id into v_owner
    from public.billing_subscriptions where stripe_customer_id = p_customer;
  if v_owner is not null and v_owner <> p_company then
    raise exception 'stripe_begin_checkout: customer % already belongs to another company', p_customer;
  end if;

  -- stripe_synced_at is '-infinity', NOT now(), and that is the whole
  -- correctness of this function. This row is a PLACEHOLDER: it records which
  -- Stripe customer to attribute the coming webhook to, and knows nothing
  -- about Stripe's state -- `incomplete` is SILO's guess, not Stripe's answer.
  -- Stamping now() would claim "this row reflects Stripe as of this moment",
  -- and the staleness guard would then DROP the first real sync whenever its
  -- fetch began before the checkout insert (a replayed webhook, a backfill, a
  -- `sync` action racing the redirect). The company's subscription would sit
  -- at `incomplete` with a null plan forever, which is the exact failure the
  -- guard exists to prevent, pointed the wrong way. Caught by the regression
  -- suite, which is why the test stamps its sync with a fixed past timestamp.
  --
  -- On conflict the sync time is deliberately LEFT ALONE: a second checkout
  -- attempt against an already-synced subscription must not re-open it to a
  -- stale payload.
  insert into public.billing_subscriptions
    (company_entity_id, stripe_customer_id, status, stripe_synced_at)
  values (p_company, p_customer, 'incomplete', '-infinity'::timestamptz)
  on conflict (company_entity_id) do update
    set stripe_customer_id = excluded.stripe_customer_id,
        updated_at = now();
end;
$$;

-- The subscription mirror. p_synced_at is the time the payload was FETCHED,
-- which is what orders out-of-order webhook deliveries; an older fetch
-- returns without writing.
create or replace function public.stripe_sync_subscription(
  p_company   uuid,
  p_payload   jsonb,
  p_synced_at timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_item      jsonb := coalesce(p_payload->'items'->'data'->0, '{}'::jsonb);
  v_price     jsonb := coalesce(v_item->'price', '{}'::jsonb);
  v_customer  text  := coalesce(p_payload->>'customer', p_payload->'customer'->>'id');
  v_status    text  := p_payload->>'status';
  v_existing  timestamptz;
  v_stored_sub    text;
  v_stored_status text;
begin
  if p_company is null or p_payload->>'id' is null then
    raise exception 'stripe_sync_subscription: company and payload id are required';
  end if;

  select stripe_synced_at, stripe_subscription_id, status
    into v_existing, v_stored_sub, v_stored_status
    from public.billing_subscriptions where company_entity_id = p_company;
  if v_existing is not null and v_existing > p_synced_at then return; end if;

  -- One row per company, so this mirror holds ONE subscription -- and fetch
  -- time alone does not decide which. A tenant who cancels and resubscribes
  -- has two subscriptions at Stripe, and the older one's
  -- `customer.subscription.deleted` can be delivered (or re-delivered) after
  -- the new one synced. Ordered only by time, that terminal event lands last
  -- and the company reads `canceled` while paying, until somebody presses
  -- Sync. Identity has to be part of the test: a terminal update for a
  -- DIFFERENT subscription than the one on file is about a subscription this
  -- row no longer describes.
  if v_stored_sub is not null
     and v_stored_sub <> p_payload->>'id'
     and v_status in ('canceled','incomplete_expired')
     and v_stored_status in ('active','trialing','past_due','unpaid')
  then
    return;
  end if;

  insert into public.billing_subscriptions (
    company_entity_id, stripe_customer_id, stripe_subscription_id, plan_key,
    stripe_price_id, status, quantity, currency, unit_amount_cents,
    current_period_start, current_period_end, cancel_at_period_end, canceled_at,
    trial_end, collection_issue, stripe_synced_at, raw, updated_at)
  values (
    p_company,
    coalesce(v_customer, 'unknown:' || (p_payload->>'id')),
    p_payload->>'id',
    (select plan_key from public.billing_plans where stripe_price_id = v_price->>'id'),
    v_price->>'id',
    v_status,
    nullif(v_item->>'quantity','')::integer,
    lower(coalesce(v_price->>'currency', p_payload->>'currency')),
    public.stripe_cents(v_price, 'unit_amount'),
    -- Stripe moved the subscription period from the subscription to its items
    -- in 2025-03-31.basil. Read both, newest location last, so a future SDK
    -- bump degrades to the other field instead of writing NULL periods.
    public.stripe_epoch(coalesce(
      nullif(p_payload->>'current_period_start','')::bigint,
      nullif(v_item->>'current_period_start','')::bigint)),
    public.stripe_epoch(coalesce(
      nullif(p_payload->>'current_period_end','')::bigint,
      nullif(v_item->>'current_period_end','')::bigint)),
    coalesce((p_payload->>'cancel_at_period_end')::boolean, false),
    public.stripe_epoch(nullif(p_payload->>'canceled_at','')::bigint),
    public.stripe_epoch(nullif(p_payload->>'trial_end','')::bigint),
    case when v_status in ('past_due','unpaid','incomplete','incomplete_expired')
         then v_status else null end,
    p_synced_at,
    p_payload,
    now())
  on conflict (company_entity_id) do update set
    stripe_customer_id     = coalesce(v_customer, billing_subscriptions.stripe_customer_id),
    stripe_subscription_id = excluded.stripe_subscription_id,
    plan_key               = excluded.plan_key,
    stripe_price_id        = excluded.stripe_price_id,
    status                 = excluded.status,
    quantity               = excluded.quantity,
    currency               = excluded.currency,
    unit_amount_cents      = excluded.unit_amount_cents,
    current_period_start   = excluded.current_period_start,
    current_period_end     = excluded.current_period_end,
    cancel_at_period_end   = excluded.cancel_at_period_end,
    canceled_at            = excluded.canceled_at,
    trial_end              = excluded.trial_end,
    collection_issue       = excluded.collection_issue,
    stripe_synced_at       = excluded.stripe_synced_at,
    raw                    = excluded.raw,
    updated_at             = now();
end;
$$;

create or replace function public.stripe_sync_billing_invoice(
  p_company   uuid,
  p_payload   jsonb,
  p_synced_at timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_existing timestamptz;
begin
  if p_company is null or p_payload->>'id' is null then
    raise exception 'stripe_sync_billing_invoice: company and payload id are required';
  end if;

  -- Unreachable through Stripe (a customer's invoices only ever list under
  -- their own company) but written out because the conflict target is the
  -- invoice id alone: without this, a mis-called sync would silently update
  -- another company's row while appearing to succeed.
  if exists (select 1 from public.billing_invoices
              where stripe_invoice_id = p_payload->>'id'
                and company_entity_id <> p_company) then
    raise exception 'stripe_sync_billing_invoice: invoice % belongs to another company', p_payload->>'id';
  end if;

  select stripe_synced_at into v_existing
    from public.billing_invoices where stripe_invoice_id = p_payload->>'id';
  if v_existing is not null and v_existing > p_synced_at then return; end if;

  insert into public.billing_invoices (
    company_entity_id, stripe_invoice_id, stripe_customer_id, number, status, currency,
    amount_due_cents, amount_paid_cents, period_start, period_end, due_date, paid_at,
    hosted_invoice_url, invoice_pdf_url, stripe_synced_at, raw, updated_at)
  values (
    p_company,
    p_payload->>'id',
    coalesce(p_payload->>'customer', p_payload->'customer'->>'id'),
    p_payload->>'number',
    p_payload->>'status',
    lower(coalesce(p_payload->>'currency','usd')),
    public.stripe_cents(p_payload, 'amount_due'),
    public.stripe_cents(p_payload, 'amount_paid'),
    public.stripe_epoch(nullif(p_payload->>'period_start','')::bigint),
    public.stripe_epoch(nullif(p_payload->>'period_end','')::bigint),
    public.stripe_epoch(nullif(p_payload->>'due_date','')::bigint),
    public.stripe_epoch(nullif(p_payload->'status_transitions'->>'paid_at','')::bigint),
    p_payload->>'hosted_invoice_url',
    p_payload->>'invoice_pdf',
    p_synced_at,
    p_payload,
    now())
  on conflict (stripe_invoice_id) do update set
    status             = excluded.status,
    number             = excluded.number,
    amount_due_cents   = excluded.amount_due_cents,
    amount_paid_cents  = excluded.amount_paid_cents,
    paid_at            = excluded.paid_at,
    due_date           = excluded.due_date,
    hosted_invoice_url = excluded.hosted_invoice_url,
    invoice_pdf_url    = excluded.invoice_pdf_url,
    stripe_synced_at   = excluded.stripe_synced_at,
    raw                = excluded.raw,
    updated_at         = now();
end;
$$;

-- The connected account mirror. Called on create, on every return from the
-- hosted onboarding, on `account.updated`, and whenever the invoicing page
-- asks -- always from a fresh Account fetch, never from the account link's
-- redirect parameters (Stripe documents that the return_url is reached whether
-- or not onboarding actually completed, so treating it as completion is the
-- classic Connect bug).
create or replace function public.stripe_sync_connect_account(
  p_company   uuid,
  p_payload   jsonb,
  p_synced_at timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_account text := p_payload->>'id';
  v_owner   uuid;
  v_bound   text;
  v_existing timestamptz;
  v_reqs    jsonb := coalesce(p_payload->'requirements', '{}'::jsonb);
  v_done    boolean := coalesce((p_payload->>'charges_enabled')::boolean, false)
                       and coalesce((p_payload->>'details_submitted')::boolean, false);
begin
  if p_company is null or v_account is null then
    raise exception 'stripe_sync_connect_account: company and payload id are required';
  end if;

  -- An account id already bound to another company is never re-pointed. One
  -- Stripe account belongs to one tenant, and a bug that swapped them would
  -- route a client's invoices -- and their customers' card details -- to
  -- somebody else's screen.
  select company_entity_id into v_owner
    from public.stripe_connect_accounts where stripe_account_id = v_account;
  if v_owner is not null and v_owner <> p_company then
    raise exception 'stripe_sync_connect_account: account % already belongs to another company', v_account;
  end if;

  -- ...and a company already bound to an account is never re-pointed EITHER,
  -- which the cross-company check above does not cover and which is the
  -- likelier accident: two tabs both start onboarding, Stripe issues two
  -- accounts, and the second sync would quietly move this company onto the
  -- second one. The first account keeps its invoices and its customers, SILO
  -- stops routing that account's webhooks to anybody (they resolve to no
  -- company), and nothing anywhere says so. Refusing makes the duplicate
  -- visible as an error instead of as silence. Re-pointing a company at a
  -- different Stripe account is a deliberate act and takes a service-role
  -- write, not a second click.
  select stripe_account_id into v_bound
    from public.stripe_connect_accounts where company_entity_id = p_company;
  if v_bound is not null and v_bound <> v_account then
    -- `%`, not `%s`: PL/pgSQL's placeholder is bare, and the C-style one
    -- printed every account id with a stray trailing "s".
    raise exception 'stripe_sync_connect_account: this company is already bound to %, refusing to rebind it to %',
      v_bound, v_account;
  end if;

  select stripe_synced_at into v_existing
    from public.stripe_connect_accounts where company_entity_id = p_company;
  if v_existing is not null and v_existing > p_synced_at then return; end if;

  insert into public.stripe_connect_accounts (
    company_entity_id, stripe_account_id, account_type, country, default_currency,
    business_name, charges_enabled, payouts_enabled, details_submitted,
    disabled_reason, requirements, onboarding_started_at, onboarding_completed_at,
    stripe_synced_at, raw, updated_at)
  values (
    p_company,
    v_account,
    coalesce(nullif(p_payload->>'type',''), 'standard'),
    p_payload->>'country',
    lower(nullif(p_payload->>'default_currency','')),
    coalesce(p_payload->'business_profile'->>'name', p_payload->'settings'->'dashboard'->>'display_name'),
    coalesce((p_payload->>'charges_enabled')::boolean, false),
    coalesce((p_payload->>'payouts_enabled')::boolean, false),
    coalesce((p_payload->>'details_submitted')::boolean, false),
    nullif(v_reqs->>'disabled_reason',''),
    v_reqs,
    now(),
    case when v_done then now() else null end,
    p_synced_at,
    p_payload,
    now())
  on conflict (company_entity_id) do update set
    -- stripe_account_id is deliberately NOT updated here. The guard above
    -- already refuses a different one, so assigning it could only ever be a
    -- no-op -- and leaving the assignment in place would quietly restore the
    -- rebind the moment somebody relaxed that guard.
    account_type      = excluded.account_type,
    country           = excluded.country,
    default_currency  = excluded.default_currency,
    business_name     = excluded.business_name,
    charges_enabled   = excluded.charges_enabled,
    payouts_enabled   = excluded.payouts_enabled,
    details_submitted = excluded.details_submitted,
    disabled_reason   = excluded.disabled_reason,
    requirements      = excluded.requirements,
    -- First completion wins: this records WHEN the account first became able
    -- to charge, so a later restriction must not restamp it as if it had just
    -- finished onboarding.
    onboarding_completed_at = coalesce(stripe_connect_accounts.onboarding_completed_at,
                                       excluded.onboarding_completed_at),
    stripe_synced_at  = excluded.stripe_synced_at,
    raw               = excluded.raw,
    updated_at        = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- 6b. Creating a connected account is claimed per company
--
-- `stripe-connect` reads the company's row, finds none, and calls Stripe. Two
-- concurrent first clicks (two tabs, or a double-click on a slow link) both
-- read no row and both create an account, and the tenant ends up with two
-- merchant identities in their own Stripe. The guard added to
-- stripe_sync_connect_account above stops the SECOND one taking over the
-- company's row -- but by then the second account exists at Stripe, which is
-- somebody's real business record and cannot be deleted from here.
--
-- So the creation is claimed first. The claim is durable (a row, not an
-- advisory lock) because the thing it spans is an HTTP call to Stripe, which
-- no transaction can hold.
--
-- `stripe_account_id` on the claim is what closes the window that matters:
-- the edge function records the id the INSTANT Stripe returns it, before the
-- mirror write. A retry that arrives after a create succeeded but before the
-- sync landed therefore ADOPTS that account instead of creating another one.
-- Without it, a crash in those few milliseconds means the next attempt after
-- the claim goes stale opens a second account, and nothing would ever say so.
create table if not exists public.stripe_connect_setup_claims (
  company_entity_id uuid primary key references public.entities(id) on delete cascade,
  claimed_by        uuid references auth.users(id) on delete set null,
  stripe_account_id text,
  claimed_at        timestamptz not null default now()
);

alter table public.stripe_connect_setup_claims enable row level security;
revoke all on public.stripe_connect_setup_claims from anon, authenticated;
-- No policy and no grant: service role only, like stripe_webhook_events.

comment on table public.stripe_connect_setup_claims is
  'One in-flight Connect account creation per company. Durable rather than an advisory lock because it spans an HTTP call to Stripe. stripe_account_id is written the instant Stripe returns it, so a retry between the create and the mirror write adopts that account instead of opening a second merchant identity in the client''s Stripe.';

-- Returns one of:
--   already_bound -- the company has a connected account; do not create
--   adopt         -- an in-flight claim already has an account id: sync THAT
--   claimed       -- you hold the claim; create
--   in_flight     -- somebody else is mid-creation; refuse and tell the user
create or replace function public.stripe_claim_connect_setup(
  p_company uuid,
  p_user    uuid default null
)
returns table (outcome text, stripe_account_id text)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_claimed boolean;
  v_existing public.stripe_connect_setup_claims;
begin
  if exists (select 1 from public.stripe_connect_accounts where company_entity_id = p_company) then
    return query select 'already_bound'::text, null::text;
    return;
  end if;

  insert into public.stripe_connect_setup_claims (company_entity_id, claimed_by)
  values (p_company, p_user)
  on conflict (company_entity_id) do update
    set claimed_by = excluded.claimed_by,
        claimed_at = now()
    -- Only a STALE claim is taken over, and only when no account id was
    -- recorded against it -- an id means Stripe made something, and that is
    -- adopted below rather than duplicated.
    where public.stripe_connect_setup_claims.claimed_at < now() - interval '10 minutes'
      and public.stripe_connect_setup_claims.stripe_account_id is null;
  get diagnostics v_claimed = row_count;

  if v_claimed then
    return query select 'claimed'::text, null::text;
    return;
  end if;

  select * into v_existing
    from public.stripe_connect_setup_claims where company_entity_id = p_company;

  if v_existing.stripe_account_id is not null then
    return query select 'adopt'::text, v_existing.stripe_account_id;
  else
    return query select 'in_flight'::text, null::text;
  end if;
end;
$$;

-- Called the moment Stripe returns an account id, BEFORE the mirror write.
create or replace function public.stripe_note_connect_setup_account(
  p_company uuid,
  p_account text
)
returns void
language sql
security definer
set search_path to 'public'
as $$
  update public.stripe_connect_setup_claims
     set stripe_account_id = p_account
   where company_entity_id = p_company;
$$;

create or replace function public.stripe_release_connect_setup(p_company uuid)
returns void
language sql
security definer
set search_path to 'public'
as $$
  delete from public.stripe_connect_setup_claims where company_entity_id = p_company;
$$;

-- The client disconnected SILO from their Stripe account. SILO can no longer
-- act for them, and the honest record is "this stopped working", not a blank
-- row: the invoices really were issued and the history stays readable. A
-- dedicated function rather than a synthetic payload through the sync above,
-- which would overwrite country, currency, business name and `raw` with a stub
-- -- losing real history to record an absence.
create or replace function public.stripe_mark_connect_disconnected(
  p_company   uuid,
  p_account   text,
  p_synced_at timestamptz default now()
)
returns void
language sql
security definer
set search_path to 'public'
as $$
  update public.stripe_connect_accounts
     set charges_enabled   = false,
         payouts_enabled   = false,
         details_submitted = false,
         disabled_reason   = 'deauthorized',
         stripe_synced_at  = p_synced_at,
         updated_at        = now()
   where company_entity_id = p_company
     and stripe_account_id = p_account;
$$;

-- Shared by both writers of a customer mirror (the invoice edge function after
-- a create, and the webhook on customer.updated), so there is exactly one
-- definition of what a mirrored customer row is.
create or replace function public.stripe_sync_invoice_customer(
  p_company   uuid,
  p_account   text,
  p_payload   jsonb,
  p_synced_at timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
  v_customer text := p_payload->>'id';
  v_existing timestamptz;
begin
  if p_company is null or p_account is null or v_customer is null then
    raise exception 'stripe_sync_invoice_customer: company, account and payload id are required';
  end if;
  -- The pairing is checked here as well as by the composite FK, so the error
  -- names the problem instead of surfacing as a constraint violation.
  if not exists (select 1 from public.stripe_connect_accounts
                  where company_entity_id = p_company and stripe_account_id = p_account) then
    raise exception 'stripe_sync_invoice_customer: % is not the connected account for this company', p_account;
  end if;

  select id, stripe_synced_at into v_id, v_existing
    from public.stripe_invoice_customers
   where company_entity_id = p_company and stripe_customer_id = v_customer;
  if v_id is not null and v_existing > p_synced_at then return v_id; end if;

  insert into public.stripe_invoice_customers (
    company_entity_id, stripe_account_id, stripe_customer_id, name, email, phone,
    currency, address, metadata, delinquent, stripe_synced_at, raw, updated_at)
  values (
    p_company, p_account, v_customer,
    nullif(p_payload->>'name',''),
    nullif(p_payload->>'email',''),
    nullif(p_payload->>'phone',''),
    lower(nullif(p_payload->>'currency','')),
    p_payload->'address',
    coalesce(p_payload->'metadata', '{}'::jsonb),
    coalesce((p_payload->>'delinquent')::boolean, false),
    p_synced_at, p_payload, now())
  on conflict (company_entity_id, stripe_customer_id) do update set
    name             = excluded.name,
    email            = excluded.email,
    phone            = excluded.phone,
    currency         = excluded.currency,
    address          = excluded.address,
    metadata         = excluded.metadata,
    delinquent       = excluded.delinquent,
    stripe_synced_at = excluded.stripe_synced_at,
    raw              = excluded.raw,
    updated_at       = now()
  returning id into v_id;

  return v_id;
end;
$$;

-- The invoice mirror, and the lines with it. ONE definition called by both the
-- edge function (after a create/finalize/send/void) and the webhook: two
-- mappers would drift, and the second one to gain a column would be the one
-- nobody noticed was missing it -- the card_coding_effective_lines lesson.
create or replace function public.stripe_sync_invoice(
  p_company   uuid,
  p_account   text,
  p_payload   jsonb,
  p_synced_at timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id       uuid;
  v_invoice  text := p_payload->>'id';
  v_existing timestamptz;
  v_customer text := coalesce(p_payload->>'customer', p_payload->'customer'->>'id');
  v_currency text := lower(coalesce(p_payload->>'currency','usd'));
begin
  if p_company is null or p_account is null or v_invoice is null then
    raise exception 'stripe_sync_invoice: company, account and payload id are required';
  end if;
  if not exists (select 1 from public.stripe_connect_accounts
                  where company_entity_id = p_company and stripe_account_id = p_account) then
    raise exception 'stripe_sync_invoice: % is not the connected account for this company', p_account;
  end if;

  select id, stripe_synced_at into v_id, v_existing
    from public.stripe_invoices
   where company_entity_id = p_company and stripe_invoice_id = v_invoice;
  -- An older fetch arriving late leaves BOTH the invoice and its lines alone.
  if v_id is not null and v_existing > p_synced_at then return v_id; end if;

  insert into public.stripe_invoices (
    company_entity_id, stripe_account_id, stripe_invoice_id, stripe_customer_id,
    customer_name, customer_email, number, status, currency,
    subtotal_cents, tax_cents, total_cents, amount_due_cents, amount_paid_cents,
    amount_remaining_cents, collection_method, description, footer, due_date,
    finalized_at, paid_at, voided_at, marked_uncollectible_at,
    hosted_invoice_url, invoice_pdf_url, stripe_synced_at, raw, updated_at)
  values (
    p_company, p_account, v_invoice, v_customer,
    nullif(p_payload->>'customer_name',''),
    nullif(p_payload->>'customer_email',''),
    nullif(p_payload->>'number',''),
    coalesce(p_payload->>'status','draft'),
    v_currency,
    coalesce(public.stripe_cents(p_payload,'subtotal'), 0),
    public.stripe_cents(p_payload,'tax'),
    coalesce(public.stripe_cents(p_payload,'total'), 0),
    coalesce(public.stripe_cents(p_payload,'amount_due'), 0),
    coalesce(public.stripe_cents(p_payload,'amount_paid'), 0),
    coalesce(public.stripe_cents(p_payload,'amount_remaining'), 0),
    nullif(p_payload->>'collection_method',''),
    nullif(p_payload->>'description',''),
    nullif(p_payload->>'footer',''),
    public.stripe_epoch(nullif(p_payload->>'due_date','')::bigint),
    public.stripe_epoch(nullif(p_payload->'status_transitions'->>'finalized_at','')::bigint),
    public.stripe_epoch(nullif(p_payload->'status_transitions'->>'paid_at','')::bigint),
    public.stripe_epoch(nullif(p_payload->'status_transitions'->>'voided_at','')::bigint),
    public.stripe_epoch(nullif(p_payload->'status_transitions'->>'marked_uncollectible_at','')::bigint),
    nullif(p_payload->>'hosted_invoice_url',''),
    nullif(p_payload->>'invoice_pdf',''),
    p_synced_at, p_payload, now())
  on conflict (company_entity_id, stripe_invoice_id) do update set
    stripe_customer_id      = excluded.stripe_customer_id,
    customer_name           = excluded.customer_name,
    customer_email          = excluded.customer_email,
    number                  = excluded.number,
    status                  = excluded.status,
    currency                = excluded.currency,
    subtotal_cents          = excluded.subtotal_cents,
    tax_cents               = excluded.tax_cents,
    total_cents             = excluded.total_cents,
    amount_due_cents        = excluded.amount_due_cents,
    amount_paid_cents       = excluded.amount_paid_cents,
    amount_remaining_cents  = excluded.amount_remaining_cents,
    collection_method       = excluded.collection_method,
    description             = excluded.description,
    footer                  = excluded.footer,
    due_date                = excluded.due_date,
    finalized_at            = excluded.finalized_at,
    paid_at                 = excluded.paid_at,
    voided_at               = excluded.voided_at,
    marked_uncollectible_at = excluded.marked_uncollectible_at,
    hosted_invoice_url      = excluded.hosted_invoice_url,
    invoice_pdf_url         = excluded.invoice_pdf_url,
    stripe_synced_at        = excluded.stripe_synced_at,
    raw                     = excluded.raw,
    updated_at              = now()
  returning id into v_id;

  -- Lines are REPLACED, not upserted: an edited invoice can lose a line, and a
  -- leftover row would make the mirror's own lines disagree with its total.
  delete from public.stripe_invoice_lines where invoice_id = v_id;

  insert into public.stripe_invoice_lines (
    company_entity_id, invoice_id, stripe_line_id, description, quantity,
    unit_amount_cents, amount_cents, currency, period_start, period_end, metadata)
  select
    p_company,
    v_id,
    l->>'id',
    nullif(l->>'description',''),
    nullif(l->>'quantity','')::numeric,
    coalesce(public.stripe_cents(l->'price','unit_amount'),
             -- Permissive on purpose: this field is a decimal STRING, and the
             -- strict reader raised on it -- aborting the sync for every line
             -- without an inline price. See stripe_decimal_cents.
             public.stripe_decimal_cents(l,'unit_amount_excluding_tax')),
    coalesce(public.stripe_cents(l,'amount'), 0),
    lower(coalesce(l->>'currency', v_currency)),
    public.stripe_epoch(nullif(l->'period'->>'start','')::bigint),
    public.stripe_epoch(nullif(l->'period'->>'end','')::bigint),
    coalesce(l->'metadata','{}'::jsonb)
  from jsonb_array_elements(coalesce(p_payload->'lines'->'data', '[]'::jsonb)) as l
  where l->>'id' is not null;

  -- The customer name on an invoice is denormalised for the list view, but the
  -- customer row is the better source when Stripe expanded neither.
  update public.stripe_invoices i
     set customer_name  = coalesce(i.customer_name, c.name),
         customer_email = coalesce(i.customer_email, c.email)
    from public.stripe_invoice_customers c
   where i.id = v_id
     and c.company_entity_id = p_company
     and c.stripe_customer_id = i.stripe_customer_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. The idempotency ledger's two halves
-- ---------------------------------------------------------------------------

-- Claim a request id before calling Stripe. Returns what is already known
-- about it, so the caller can decide:
--   already = false            -> first attempt, go call Stripe
--   already, status succeeded  -> return the object the first attempt made
--   already, status pending    -> another attempt is in flight; do NOT create
--                                 a second invoice, tell the user to refresh
--   already, status failed     -> the row is re-claimed and the caller retries
create or replace function public.stripe_begin_invoice_request(
  p_request_id  uuid,
  p_company     uuid,
  p_account     text,
  p_action      text,
  p_user        uuid default null,
  p_fingerprint text default null
)
returns table (already boolean, status text, stripe_object_id text)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_claimed boolean;
  r public.stripe_invoice_requests;
begin
  insert into public.stripe_invoice_requests
    (request_id, company_entity_id, stripe_account_id, action, created_by, payload_fingerprint)
  values (p_request_id, p_company, p_account, p_action, p_user, p_fingerprint)
  on conflict (request_id) do nothing;

  get diagnostics v_claimed = row_count;
  if v_claimed then
    return query select false, 'pending'::text, null::text;
    return;
  end if;

  select * into r from public.stripe_invoice_requests where request_id = p_request_id;

  -- A request id minted by another company is not this caller's to resume, and
  -- neither is one minted for a different action -- a create_customer id
  -- replayed as create_invoice would hand back a customer id as an invoice.
  if r.company_entity_id <> p_company or r.action <> p_action then
    raise exception 'stripe_begin_invoice_request: request % was not issued for this company and action', p_request_id;
  end if;

  -- A failed attempt is re-claimed ONLY when nothing was created. The handler
  -- records the Stripe object id alongside the failure whenever Stripe had
  -- already made something before the later step failed (a bad line, a mirror
  -- write that did not land), and re-claiming THAT is how a retry creates a
  -- second real draft for somebody's customer: a fresh claim means a fresh
  -- Stripe idempotency key, so Stripe will not collapse it either.
  --
  -- With an object id recorded, the request is closed as far as creation goes:
  -- the caller gets the id back and surfaces that draft for review or voiding.
  --
  -- So is a STALE pending one. The happy path and the error path both complete
  -- the row, but an edge function killed mid-call (Supabase's gateway stops a
  -- request at 150s) completes neither -- and a permanently 'pending' row would
  -- mean this invoice can never be created OR retried, with no way out but a
  -- service-role UPDATE. Ten minutes is far longer than any Stripe call this
  -- function makes and far shorter than a person's patience. The residual risk
  -- is a genuine 10-minute overlap creating two invoices, which Stripe's own
  -- Idempotency-Key (24h, same key) still collapses.
  if r.status = 'pending' and r.created_at < now() - interval '10 minutes' then
    update public.stripe_invoice_requests
       set created_at = now(), error_message = null
     where request_id = p_request_id;
    return query select false, 'pending'::text, null::text;
    return;
  end if;

  -- An ambiguous attempt is re-claimed and KEEPS its id: the retry must carry
  -- the same Stripe idempotency key so Stripe returns the original object
  -- rather than making a second one.
  if r.status = 'ambiguous' then
    update public.stripe_invoice_requests
       set status = 'pending', error_message = null, completed_at = null
     where request_id = p_request_id;
    return query select false, 'pending'::text, null::text;
    return;
  end if;

  if r.status = 'failed' and r.stripe_object_id is null then
    update public.stripe_invoice_requests
       set status = 'pending', error_message = null, completed_at = null
     where request_id = p_request_id;
    return query select false, 'pending'::text, null::text;
    return;
  end if;

  if r.status = 'failed' then
    -- Failed, but Stripe made something. Hand it back rather than letting a
    -- retry make a second one.
    return query select true, 'failed'::text, r.stripe_object_id;
    return;
  end if;

  -- succeeded -> hand back what the first attempt made.
  -- pending   -> another attempt is in flight; the caller must NOT create a
  --              second object, which is the whole point of this table.
  return query select true, r.status, r.stripe_object_id;
end;
$$;

create or replace function public.stripe_complete_invoice_request(
  p_request_id uuid,
  p_status     text,
  p_object_id  text default null,
  p_error      text default null
)
returns void
language sql
security definer
set search_path to 'public'
as $$
  update public.stripe_invoice_requests
     set status = p_status,
         stripe_object_id = coalesce(p_object_id, stripe_object_id),
         error_message = p_error,
         completed_at = now()
   where request_id = p_request_id;
$$;

-- ---------------------------------------------------------------------------
-- 8. Grants on the sync layer
--
-- Supabase's default privileges GRANT EXECUTE on every newly created public
-- function to anon and authenticated. Every function above is SECURITY
-- DEFINER, so leaving that in place would hand an unauthenticated caller the
-- ability to write another company's invoice mirror. The revoke below is the
-- boundary. 20260904330000 is the precedent: anon could call
-- chat_run_readonly_query for exactly this reason, and verify_v2_schema.sql
-- now checks for the repeat.
-- ---------------------------------------------------------------------------

do $$
declare f text;
begin
  foreach f in array array[
    'stripe_resolve_event_company(text,text,text)',
    'stripe_record_webhook_event(text,text,text,text,uuid,timestamptz)',
    'stripe_finish_webhook_event(text,text,text)',
    'stripe_begin_checkout(uuid,text)',
    'stripe_sync_subscription(uuid,jsonb,timestamptz)',
    'stripe_sync_billing_invoice(uuid,jsonb,timestamptz)',
    'stripe_sync_connect_account(uuid,jsonb,timestamptz)',
    'stripe_mark_connect_disconnected(uuid,text,timestamptz)',
    'stripe_claim_connect_setup(uuid,uuid)',
    'stripe_note_connect_setup_account(uuid,text)',
    'stripe_release_connect_setup(uuid)',
    'stripe_sync_invoice_customer(uuid,text,jsonb,timestamptz)',
    'stripe_sync_invoice(uuid,text,jsonb,timestamptz)',
    'stripe_begin_invoice_request(uuid,uuid,text,text,uuid,text)',
    'stripe_complete_invoice_request(uuid,text,text,text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- stripe_epoch / stripe_cents are pure formatters over a caller-supplied
-- value; they read nothing and are left with their default grants so a view or
-- a client query can use them.

-- ---------------------------------------------------------------------------
-- 9. Reading surfaces
-- ---------------------------------------------------------------------------

-- The invoicing list, with the one derived fact the page would otherwise
-- compute three times: is this invoice overdue. Overdue is "due date passed
-- AND money is still outstanding" -- a paid invoice past its due date is not
-- overdue, and a draft has no due date to pass.
drop view if exists public.stripe_invoices_v;
create view public.stripe_invoices_v
with (security_invoker = true) as
  select
    i.*,
    c.name  as customer_display_name,
    c.email as customer_display_email,
    (i.status = 'open'
      and i.due_date is not null
      and i.due_date < now()
      and i.amount_remaining_cents > 0) as is_overdue,
    (select count(*) from public.stripe_invoice_lines l where l.invoice_id = i.id) as line_count
  from public.stripe_invoices i
  left join public.stripe_invoice_customers c
    on c.company_entity_id = i.company_entity_id
   and c.stripe_customer_id = i.stripe_customer_id;

comment on view public.stripe_invoices_v is
  'stripe_invoices with the customer''s current name/email joined and is_overdue derived. security_invoker = true, so it shows exactly what the reader''s own RLS shows -- a member without can_manage_client_invoices() sees no rows, not a filtered list.';

-- Same default-grant hazard as stripe_connect_status_v above.
revoke all on public.stripe_invoices_v from anon, authenticated;
grant select on public.stripe_invoices_v to authenticated;

-- What a company owes SILO and whether anything is wrong with it, in the one
-- row the billing page reads.
drop view if exists public.billing_subscriptions_v;
create view public.billing_subscriptions_v
with (security_invoker = true) as
  select
    s.*,
    p.title       as plan_title,
    p.description as plan_description,
    p.billing_interval,
    p.seat_based,
    (s.status in ('active','trialing')) as is_entitled,
    (s.collection_issue is not null)    as needs_attention
  from public.billing_subscriptions s
  left join public.billing_plans p on p.plan_key = s.plan_key;

comment on view public.billing_subscriptions_v is
  'The company''s SILO subscription with its plan joined. is_entitled is the ONE place "is this tenant paid up" is decided (active or trialing) -- do not re-derive it per page, and note it is a display fact today: nothing in SILO gates access on it, which is a product decision, not an oversight.';

revoke all on public.billing_subscriptions_v from anon, authenticated;
grant select on public.billing_subscriptions_v to authenticated;

-- ---------------------------------------------------------------------------
-- 10. Company stamp triggers + Ask SILO's map
-- ---------------------------------------------------------------------------

select public.attach_stamp_company_entity_id_triggers();

-- Ask SILO reads the catalogue to know what exists. Descriptions are curated
-- business meaning (refresh_chat_schema_catalog() preserves them and only
-- regenerates the column lists), so they carry the caveats a model would
-- otherwise have to guess -- above all that these are TWO businesses and
-- billing_invoices is not stripe_invoices.
insert into public.silo_chat_schema_catalog (relname, description, keywords)
values
  ('billing_plans',
   'SILO''s own subscription plan catalogue (what a tenant pays SILO). Global rows, no company column. Not the tenant''s products.',
   array['billing','subscription','plan','pricing','stripe']),
  ('billing_subscriptions',
   'What each tenant company pays SILO, mirrored from SILO''s platform Stripe account. One row per company. status is Stripe''s vocabulary (active/trialing/past_due/canceled...). This is SILO''s revenue, NOT the company''s sales.',
   array['billing','subscription','saas','stripe','revenue']),
  ('billing_invoices',
   'Invoices SILO issued TO a tenant company. Amounts are integer cents with a currency column. Not the invoices the tenant issued to its own customers -- those are stripe_invoices.',
   array['billing','invoice','stripe','saas']),
  ('stripe_connect_accounts',
   'The tenant''s OWN Stripe account (Connect Standard), used to invoice their customers. charges_enabled/payouts_enabled say whether invoicing works at all; a false there means onboarding is unfinished or the account is restricted, never that the company has no customers.',
   array['stripe','connect','payments','onboarding']),
  ('stripe_invoice_customers',
   'Customers of the TENANT, mirrored from the tenant''s own Stripe account. Not SILO''s customers and not Shopify customers.',
   array['stripe','customer','invoice','accounts receivable']),
  ('stripe_invoices',
   'Invoices a tenant issued to its own customers through Stripe Connect. Amounts are integer MINOR UNITS (cents) -- divide by 100 for USD, and never for a zero-decimal currency. amount_remaining_cents > 0 with status open is money still owed to the tenant. A row appears only after Stripe confirmed it, so the absence of an invoice never means it was not sent, only that Stripe never created it.',
   array['stripe','invoice','receivable','customer billing']),
  ('stripe_invoice_lines',
   'Line detail per stripe_invoices row, replaced wholesale on every sync. amount_cents is the line total in minor units.',
   array['stripe','invoice','line items']),
  ('stripe_invoice_requests',
   'Idempotency ledger for creating customers/invoices in a tenant''s Stripe account. Operational plumbing; a row here is an ATTEMPT, not an invoice.',
   array['stripe','idempotency','internal']),
  ('stripe_webhook_events',
   'Raw Stripe webhook delivery log. Plumbing -- status=unresolved means the event named an account SILO does not know.',
   array['stripe','webhook','internal'])
on conflict (relname) do update
  set description = excluded.description,
      keywords    = excluded.keywords;

-- Plumbing is hidden from the model's index: noise reduction, not security --
-- RLS remains the boundary, and these two carry nothing a tenant could read
-- anyway.
update public.silo_chat_schema_catalog
   set is_hidden = true
 where relname in ('stripe_webhook_events','stripe_invoice_requests');

select public.refresh_chat_schema_catalog();
