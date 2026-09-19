-- Customer accounts — SILO's first NATIVE customer master.
--
-- ── Why this table did not already exist ────────────────────────────────────
-- SILO held four customer-shaped things when this was written, and not one of
-- them could hold an onboarding form, each for a different reason:
--
--   ar_customers (446 rows)  -- DERIVED. server/ar-sync.mjs upserts it from a
--       Google Sheet keyed on normalised customer NAME. No address, no legal
--       name, no tax fields, and its contact columns are empty in practice
--       (15 of 446 have a contact name, 2 have a phone). Typing an EIN into a
--       row a sync owns means the sync owns the EIN.
--   quickbooks_customers     -- a read-only QBO mirror, service-role writes.
--   stripe_invoice_customers -- a read-only Stripe mirror with NO client write
--       policy at all, by design: a locally-authored row would be a customer
--       SILO claims and Stripe has never heard of.
--   factories                -- the right SHAPE, the wrong party (suppliers).
--
-- And the accounting foundation (accounting_settings / _accounts /
-- _opening_balances) is a chart of accounts and balances: it has no party
-- table of any kind. So this is not a wholesale side-table bolted to the AR
-- sheet -- it is the customer entity the QBO migration needs anyway, which is
-- why it is `customer_accounts` with an `account_type` rather than
-- `wholesale_accounts` with a boolean. A boolean would have to be migrated
-- away the first time a distributor or licensee is onboarded.
--
-- The three mirrors above stay mirrors. This table LINKS to them
-- (ar_customer_id / qbo_customer_id / stripe_customer_id, all nullable) and
-- never writes into them. Nothing here contaminates the sheet sync, the QBO
-- sync, or the Stripe sync.
--
-- ── Who fills it in ─────────────────────────────────────────────────────────
-- The prospect, on a PUBLIC page, with no SILO login -- so the token is the
-- entire authorization, exactly as review_access_tokens and org_invites work.
-- customer_account_invites is RLS deny-all + RPC-only for the same reason
-- org_invites is: a token table a client can read is not a token table.
--
-- The invite is CONSUMED at submission and a separate, short-lived
-- continuation token is issued for the card-setup step. The original link is
-- the one that sits in an inbox forever; the card step is minutes long and
-- should not inherit a fourteen-day life.
--
-- ── Three separations that are the point of the design ──────────────────────
-- 1. TAX DATA IS NOT DIRECTORY DATA. An EIN and a resale certificate live in
--    customer_account_tax_profiles, gated by can_manage_client_invoices(),
--    while the directory (who they are, where they ship) is readable by any
--    active member. Someone looking up a ship-to address should not be handed
--    a federal tax id to do it.
-- 2. REQUESTED TERMS ARE NOT APPROVED TERMS. requested_payment_terms is what
--    the applicant asked for and is applicant-writable; approved_payment_terms,
--    credit_limit and price_tier are internal and are written ONLY by
--    approve_customer_account(). submit_customer_account() never names those
--    columns, so a submission payload carrying them changes nothing -- which
--    is asserted, not assumed.
-- 3. AN ADDRESS "SAME AS" ANOTHER IS A POINTER, NOT A COPY. Copying the
--    business address into the billing row at submission means correcting it
--    later fixes one of the two. So same_as_address_type is a real column, the
--    pointer rows carry no street, and resolution happens in a view. The CHECK
--    constraints bound the graph to at most two hops (billing -> shipping ->
--    business), so no cycle is representable.
--
-- ── What is deliberately NOT stored ─────────────────────────────────────────
-- Card data. Not a PAN, not a CVC, not an expiry typed by anyone. The card is
-- captured by Stripe Checkout in `setup` mode on the tenant's own CONNECT
-- account; SILO keeps the payment-method id and the display metadata Stripe
-- hands back (brand, last four, expiry month/year) and nothing else.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. customer_accounts
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.customer_accounts (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,

  -- 'wholesale' today. Deliberately a type, not a boolean: see the header.
  account_type text not null default 'wholesale'
    check (account_type in ('wholesale','retail','distributor','licensee','other')),

  status text not null default 'invited'
    check (status in ('invited','submitted','approved','rejected','inactive')),

  -- ── Applicant-supplied identity ──────────────────────────────────────────
  legal_name text,
  dba_name text,
  website text,
  -- The address the invite was issued to. The submission cannot change it:
  -- it is what the token is bound to.
  contact_email text not null,

  -- What the applicant ASKED for. Never an authorization for anything.
  requested_payment_terms text,
  applicant_notes text,

  -- ── Internal, set at approval only ───────────────────────────────────────
  approved_payment_terms text,
  credit_limit numeric(14,2) check (credit_limit is null or credit_limit >= 0),
  price_tier text,
  internal_notes text,

  -- ── Links OUT to the three mirrors. Never a write into them. ─────────────
  -- A SOFT link, deliberately without a foreign key. ar_customers is owned by
  -- the Google Sheet sync (server/ar-sync.mjs), which upserts by normalised
  -- name and may legitimately purge and rebuild rows; a hard FK would let that
  -- sync's writes fail against a customer_accounts row, or cascade a null into
  -- it. The link is a convenience for reporting, never an integrity claim.
  ar_customer_id uuid,
  qbo_customer_id text,
  stripe_customer_id text,

  -- ── Card on file (Stripe Connect, mode: 'setup') ─────────────────────────
  -- 'not_started' -> 'session_open' -> 'succeeded' | 'abandoned'.
  -- 'abandoned' is reachable from checkout.session.expired and is NOT
  -- terminal: the applicant can start a fresh session afterwards.
  card_setup_status text not null default 'not_started'
    check (card_setup_status in ('not_started','session_open','succeeded','abandoned')),
  -- What makes a RESTART mint a genuinely new Checkout session. The create
  -- carries `silo-setup-<account>-<attempt>` as its Stripe idempotency key,
  -- and Stripe replays a key for 24 hours -- so without this, restarting after
  -- an expiry would replay the EXPIRED session and hand the applicant a dead
  -- URL. It is bumped ONLY by release_customer_card_setup(), which runs only
  -- once Stripe has stated the previous session is expired or gone. Bumping it
  -- on a mere timeout would be the Billing surface's original bug in reverse:
  -- a lost answer whose session really does exist must replay the same key,
  -- not mint a second payable one.
  card_setup_attempt integer not null default 0,
  -- When the current claim was taken. Only a claim that never recorded a
  -- session goes stale (10 minutes); one holding a session id is NEVER stolen
  -- on a timer, because that session may still be open in the applicant's tab.
  -- Stripe decides that, in the caller.
  card_setup_claimed_at timestamptz,
  card_setup_session_id text,
  card_setup_intent_id text,
  -- Safe display metadata only. Never a PAN, never a CVC.
  card_payment_method_id text,
  card_brand text,
  card_last4 text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  card_exp_month integer check (card_exp_month is null or card_exp_month between 1 and 12),
  card_exp_year integer check (card_exp_year is null or card_exp_year between 2000 and 2100),
  card_captured_at timestamptz,
  -- Set only once the PaymentMethod is confirmed as the customer's invoice
  -- default. Checkout ATTACHES the method; making it the invoice default is a
  -- separate call, so a null here with a non-null card_payment_method_id means
  -- "saved but not yet the default" -- a real state, not a missing one.
  default_payment_method_set_at timestamptz,

  -- ── Consent to future off-session charges ────────────────────────────────
  -- Stripe requires the customer authorise off-session use, stating how
  -- amounts are determined and when charges may occur. The TEXT is snapshotted
  -- rather than only its version, because the defensible record is what this
  -- person actually read, not a pointer to what that version says today.
  off_session_consent_at timestamptz,
  off_session_consent_version text,
  off_session_consent_text text,

  submitted_at timestamptz,
  approved_at timestamptz,
  approved_by uuid references public.profiles(id),
  decision_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,

  -- One live account per email per company. Partial so a rejected or inactive
  -- applicant can re-apply later without a service-role delete.
  constraint customer_accounts_email_not_blank check (btrim(contact_email) <> '')
);

create unique index if not exists customer_accounts_live_email_uidx
  on public.customer_accounts (company_entity_id, lower(contact_email))
  where status in ('invited','submitted','approved');

create index if not exists customer_accounts_company_status_idx
  on public.customer_accounts (company_entity_id, status);
create index if not exists customer_accounts_stripe_customer_idx
  on public.customer_accounts (stripe_customer_id)
  where stripe_customer_id is not null;
-- The webhook looks an account up by the session it is being told about.
create unique index if not exists customer_accounts_setup_session_uidx
  on public.customer_accounts (card_setup_session_id)
  where card_setup_session_id is not null;

-- The composite foreign keys on the child tables below reference
-- (id, company_entity_id), which needs its own unique key -- declared here
-- rather than inline so the table body reads as the record it is. What it buys
-- is that a child row naming one company and a parent belonging to another is
-- unrepresentable, not merely unlikely.
alter table public.customer_accounts
  drop constraint if exists customer_accounts_id_company_uk;
alter table public.customer_accounts
  add constraint customer_accounts_id_company_uk unique (id, company_entity_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. customer_account_tax_profiles  (narrower than the directory)
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.customer_account_tax_profiles (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  customer_account_id uuid not null unique
    references public.customer_accounts(id) on delete cascade,

  federal_ein text,
  resale_tax_id text,
  -- <customer_account_id>/<filename>, in the private customer-account-files
  -- bucket. The storage policy keys on THIS table, so the certificate object
  -- inherits this table's narrower gate rather than the directory's.
  resale_certificate_path text,
  resale_certificate_uploaded_at timestamptz,

  verified_at timestamptz,
  verified_by uuid references public.profiles(id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A tax profile naming one company and an account belonging to another is
  -- unrepresentable, not merely unlikely.
  constraint customer_account_tax_profiles_account_fk
    foreign key (customer_account_id, company_entity_id)
    references public.customer_accounts (id, company_entity_id)
    on delete cascade
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. customer_account_addresses
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.customer_account_addresses (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  customer_account_id uuid not null
    references public.customer_accounts(id) on delete cascade,

  address_type text not null check (address_type in ('business','shipping','billing')),

  -- A pointer at another of this account's addresses. NOT a copy: correcting
  -- the business address must correct the billing address that says it is the
  -- same one.
  same_as_address_type text
    check (same_as_address_type in ('business','shipping')),

  -- On a shipping row these are the label's "company / attention" lines --
  -- part of the PLACE, which is why they live here and not in contacts.
  recipient_name text,
  attention_name text,
  street1 text,
  street2 text,
  city text,
  region text,
  postal_code text,
  country text,
  phone text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint customer_account_addresses_account_fk
    foreign key (customer_account_id, company_entity_id)
    references public.customer_accounts (id, company_entity_id)
    on delete cascade,

  -- A business address can never defer to another: it is the root, and
  -- without this the graph could cycle.
  constraint customer_account_addresses_business_is_root
    check (address_type <> 'business' or same_as_address_type is null),
  -- Shipping may only defer to business, so billing -> shipping -> business
  -- is the longest chain that exists. Two hops, no cycles, and the resolving
  -- view below can therefore be two joins rather than a recursive CTE.
  constraint customer_account_addresses_shipping_defers_to_business
    check (address_type <> 'shipping' or same_as_address_type in ('business') or same_as_address_type is null),
  constraint customer_account_addresses_no_self_reference
    check (same_as_address_type is null or same_as_address_type <> address_type),
  -- A pointer carries no street; a real address does. Enforcing both
  -- directions is what stops a half-filled row reading as a real address.
  constraint customer_account_addresses_pointer_is_empty
    check (
      (same_as_address_type is not null and street1 is null)
      or (same_as_address_type is null)
    )
);

create unique index if not exists customer_account_addresses_type_uidx
  on public.customer_account_addresses (customer_account_id, address_type);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. customer_account_contacts
-- ═══════════════════════════════════════════════════════════════════════════
-- People, as opposed to places. The receiving contact on a shipping label is
-- part of the address (attention_name/phone above); a named human SILO might
-- email is a contact.

create table if not exists public.customer_account_contacts (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  customer_account_id uuid not null
    references public.customer_accounts(id) on delete cascade,

  contact_type text not null default 'primary'
    check (contact_type in ('primary','accounts_payable','buyer','other')),
  first_name text,
  last_name text,
  title text,
  email text,
  phone text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint customer_account_contacts_account_fk
    foreign key (customer_account_id, company_entity_id)
    references public.customer_accounts (id, company_entity_id)
    on delete cascade
);

-- Exactly one primary contact; any number of the rest.
create unique index if not exists customer_account_contacts_primary_uidx
  on public.customer_account_contacts (customer_account_id)
  where contact_type = 'primary';

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. customer_account_invites   (RLS deny-all, RPC-only -- like org_invites)
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.customer_account_invites (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  customer_account_id uuid not null
    references public.customer_accounts(id) on delete cascade,

  -- 'onboarding' is the emailed link (14 days). 'card_setup' is the
  -- continuation issued when the form is submitted (2 hours) -- a card step is
  -- minutes long and must not inherit the life of a link sitting in an inbox.
  purpose text not null default 'onboarding'
    check (purpose in ('onboarding','card_setup')),

  email text not null,
  token_hash text not null unique,
  status text not null default 'pending'
    check (status in ('pending','consumed','revoked','expired')),

  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  consumed_at timestamptz,

  constraint customer_account_invites_account_fk
    foreign key (customer_account_id, company_entity_id)
    references public.customer_accounts (id, company_entity_id)
    on delete cascade
);

create index if not exists customer_account_invites_account_idx
  on public.customer_account_invites (customer_account_id, purpose, status);

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. customer_account_activity
-- ═══════════════════════════════════════════════════════════════════════════
-- Same shape and stance as payment_request_activity: append-only, written by
-- the functions below, visible with the parent.

create table if not exists public.customer_account_activity (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  customer_account_id uuid not null
    references public.customer_accounts(id) on delete cascade,
  event text not null,
  detail text,
  actor uuid references public.profiles(id),
  created_at timestamptz not null default now(),

  constraint customer_account_activity_account_fk
    foreign key (customer_account_id, company_entity_id)
    references public.customer_accounts (id, company_entity_id)
    on delete cascade
);

create index if not exists customer_account_activity_account_idx
  on public.customer_account_activity (customer_account_id, created_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. updated_at
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.touch_customer_account_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare r record;
begin
  for r in select unnest(array[
    'customer_accounts','customer_account_tax_profiles',
    'customer_account_addresses','customer_account_contacts'
  ]) as t
  loop
    execute format(
      'drop trigger if exists touch_updated_at on public.%I;
       create trigger touch_updated_at before update on public.%I
         for each row execute function public.touch_customer_account_updated_at()',
      r.t, r.t);
  end loop;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. RLS
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.customer_accounts            enable row level security;
alter table public.customer_account_tax_profiles enable row level security;
alter table public.customer_account_addresses    enable row level security;
alter table public.customer_account_contacts     enable row level security;
alter table public.customer_account_invites      enable row level security;
alter table public.customer_account_activity     enable row level security;

-- ── Directory: readable by any active member of the owning company ─────────
drop policy if exists customer_accounts_select on public.customer_accounts;
create policy customer_accounts_select on public.customer_accounts
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- ── Client writes are DIRECTORY-ONLY, and RLS is not what enforces that ────
-- Supabase's default privileges grant `authenticated` full DML on every new
-- public table, so RLS is the only thing standing between a browser session
-- and an UPDATE -- and RLS cannot scope a policy to particular COLUMNS. A
-- `for all` policy here therefore let anyone who may approve an application
-- also PATCH the columns the approval RPC exists to control: `status` straight
-- to 'approved' without the submitted-state check and without the append-only
-- activity row, `credit_limit` and the approved terms, and -- worst -- the
-- card block and `stripe_customer_id`.
--
-- That last part is the sharp end. `card_brand`, `card_last4`,
-- `card_setup_status` and `default_payment_method_set_at` are a MIRROR of
-- Stripe, exactly like stripe_invoices, and this repo's stance on a mirror is
-- that no client writes it at all: a locally-authored row is a card SILO
-- claims to hold and Stripe has never heard of. `stripe_customer_id` has a
-- write-once binding function guarding it, which a direct PATCH walks around.
--
-- So the privilege, not the policy, draws the line: UPDATE is granted on the
-- four descriptive columns a person legitimately corrects, and nothing else.
-- INSERT and DELETE go entirely -- an account is created by
-- create_customer_account_invite() and is never deleted. The SECURITY DEFINER
-- RPCs run as the owner and are unaffected.
drop policy if exists customer_accounts_write on public.customer_accounts;
create policy customer_accounts_write on public.customer_accounts
  for update to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_client_invoices())
  with check (company_entity_id = public.active_company_id() and public.can_manage_client_invoices());

revoke insert, update, delete on public.customer_accounts from authenticated;
revoke insert, update, delete on public.customer_accounts from anon;
grant update (legal_name, dba_name, website, internal_notes)
  on public.customer_accounts to authenticated;

do $$
declare r record;
begin
  for r in select unnest(array['customer_account_addresses','customer_account_contacts']) as t
  loop
    execute format('drop policy if exists %I on public.%I', r.t || '_select', r.t);
    execute format(
      'create policy %I on public.%I for select to authenticated
         using (company_entity_id = public.active_company_id())',
      r.t || '_select', r.t);
    execute format('drop policy if exists %I on public.%I', r.t || '_write', r.t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (company_entity_id = public.active_company_id() and public.can_manage_client_invoices())
         with check (company_entity_id = public.active_company_id() and public.can_manage_client_invoices())',
      r.t || '_write', r.t);
  end loop;
end;
$$;

-- ── Tax profile: NARROWER. Not readable by the directory's audience. ───────
drop policy if exists customer_account_tax_profiles_select on public.customer_account_tax_profiles;
create policy customer_account_tax_profiles_select on public.customer_account_tax_profiles
  for select to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_client_invoices());

drop policy if exists customer_account_tax_profiles_write on public.customer_account_tax_profiles;
create policy customer_account_tax_profiles_write on public.customer_account_tax_profiles
  for all to authenticated
  using (company_entity_id = public.active_company_id() and public.can_manage_client_invoices())
  with check (company_entity_id = public.active_company_id() and public.can_manage_client_invoices());

-- ── Activity: visible with the parent, never client-written ────────────────
drop policy if exists customer_account_activity_select on public.customer_account_activity;
create policy customer_account_activity_select on public.customer_account_activity
  for select to authenticated
  using (
    exists (
      select 1 from public.customer_accounts ca
       where ca.id = customer_account_activity.customer_account_id
    )
  );
-- No insert/update/delete policy at all: the RPCs below are the only writers,
-- same stance as sample_notification_log and product_concept_revisions.

-- ── Invites: deny-all. No policy. RPC-only. ────────────────────────────────
-- (org_invites' precedent: a token table a client can select is not a token
-- table, even when only a hash is stored.)

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. Views
-- ═══════════════════════════════════════════════════════════════════════════

-- Addresses with "same as" pointers followed. Two left joins, not a recursive
-- CTE, because the CHECK constraints above bound the chain to two hops.
create or replace view public.customer_account_addresses_resolved_v as
select
  a.id,
  a.company_entity_id,
  a.customer_account_id,
  a.address_type,
  a.same_as_address_type,
  -- Which row the values below actually came from. A reader that prints an
  -- address without this cannot tell a stored address from an inherited one.
  coalesce(a.same_as_address_type, a.address_type) as resolved_from,
  coalesce(a.recipient_name, src.recipient_name, root.recipient_name) as recipient_name,
  coalesce(a.attention_name, src.attention_name, root.attention_name) as attention_name,
  coalesce(a.street1,  src.street1,  root.street1)  as street1,
  coalesce(a.street2,  src.street2,  root.street2)  as street2,
  coalesce(a.city,     src.city,     root.city)     as city,
  coalesce(a.region,   src.region,   root.region)   as region,
  coalesce(a.postal_code, src.postal_code, root.postal_code) as postal_code,
  coalesce(a.country,  src.country,  root.country)  as country,
  coalesce(a.phone,    src.phone,    root.phone)    as phone
from public.customer_account_addresses a
left join public.customer_account_addresses src
  on src.customer_account_id = a.customer_account_id
 and src.address_type = a.same_as_address_type
-- The second hop: billing -> shipping -> business.
left join public.customer_account_addresses root
  on root.customer_account_id = a.customer_account_id
 and root.address_type = src.same_as_address_type;

alter view public.customer_account_addresses_resolved_v set (security_invoker = true);

-- The directory row a customer list reads. Deliberately carries NO tax
-- columns: joining them in here would hand the narrow table's contents to
-- everyone the directory is readable by, which is the whole thing the
-- separate table exists to prevent.
create or replace view public.customer_accounts_v as
select
  ca.*,
  c.first_name  as primary_contact_first_name,
  c.last_name   as primary_contact_last_name,
  c.title       as primary_contact_title,
  c.email       as primary_contact_email,
  c.phone       as primary_contact_phone,
  ap.email      as approved_by_email,
  (ca.card_payment_method_id is not null)     as has_card_on_file,
  (ca.default_payment_method_set_at is not null) as card_is_invoice_default,
  -- "Is there a tax profile" is directory-safe; what is IN it is not.
  exists (
    select 1 from public.customer_account_tax_profiles tp
     where tp.customer_account_id = ca.id
  ) as has_tax_profile
from public.customer_accounts ca
left join public.customer_account_contacts c
  on c.customer_account_id = ca.id and c.contact_type = 'primary'
left join public.profiles ap on ap.id = ca.approved_by;

alter view public.customer_accounts_v set (security_invoker = true);

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. RPCs — internal (JWT, gated)
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.create_customer_account_invite(
  p_email        text,
  p_legal_name   text default null,
  p_account_type text default 'wholesale'
)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_email text;
  v_type text;
  v_account public.customer_accounts%rowtype;
  v_token text;
begin
  if not public.can_manage_client_invoices() then
    raise exception 'not authorized';
  end if;
  v_company := public.active_company_id();
  if v_company is null then raise exception 'no active company'; end if;

  v_email := lower(btrim(coalesce(p_email, '')));
  if v_email = '' or position('@' in v_email) = 0 then
    raise exception 'valid email required';
  end if;

  v_type := lower(btrim(coalesce(nullif(p_account_type, ''), 'wholesale')));
  if v_type not in ('wholesale','retail','distributor','licensee','other') then
    raise exception 'unknown account type %', v_type;
  end if;

  -- Re-inviting an address that already has a live account RESUMES it rather
  -- than founding a second one -- the partial unique index would refuse the
  -- insert anyway, and a raised error here would read as "this person cannot
  -- be invited" when the truth is "they already were".
  select * into v_account
    from public.customer_accounts
   where company_entity_id = v_company
     and lower(contact_email) = v_email
     and status in ('invited','submitted','approved');

  if v_account.id is null then
    insert into public.customer_accounts
      (company_entity_id, account_type, status, legal_name, contact_email, created_by)
    values (v_company, v_type, 'invited', nullif(btrim(coalesce(p_legal_name,'')),''),
            v_email, auth.uid())
    returning * into v_account;
  elsif v_account.status = 'approved' then
    raise exception 'that customer is already approved';
  end if;

  -- Exactly one live onboarding link at a time.
  update public.customer_account_invites
     set status = 'revoked'
   where customer_account_id = v_account.id
     and purpose = 'onboarding'
     and status = 'pending';

  v_token := encode(extensions.gen_random_bytes(24), 'hex');

  insert into public.customer_account_invites
    (company_entity_id, customer_account_id, purpose, email, token_hash,
     expires_at, created_by)
  values (v_company, v_account.id, 'onboarding', v_email,
          encode(extensions.digest(v_token, 'sha256'), 'hex'),
          now() + interval '14 days', auth.uid());

  insert into public.customer_account_activity
    (company_entity_id, customer_account_id, event, detail, actor)
  values (v_company, v_account.id, 'invited', v_email, auth.uid());

  -- The raw token is returned exactly once, here.
  return json_build_object(
    'ok', true,
    'customer_account_id', v_account.id,
    'email', v_email,
    'token', v_token,
    'expires_at', now() + interval '14 days'
  );
end;
$$;

create or replace function public.revoke_customer_account_invite(p_invite_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_rows integer;
begin
  if not public.can_manage_client_invoices() then
    raise exception 'not authorized';
  end if;
  update public.customer_account_invites
     set status = 'revoked'
   where id = p_invite_id
     and company_entity_id = public.active_company_id()
     and status = 'pending';
  get diagnostics v_rows = row_count;
  return json_build_object('ok', v_rows > 0);
end;
$$;

create or replace function public.approve_customer_account(
  p_account_id uuid,
  p_payment_terms text default null,
  p_credit_limit numeric default null,
  p_price_tier text default null
)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_account public.customer_accounts%rowtype;
begin
  if not public.can_manage_client_invoices() then
    raise exception 'not authorized';
  end if;

  select * into v_account from public.customer_accounts
   where id = p_account_id and company_entity_id = public.active_company_id();
  if v_account.id is null then raise exception 'customer account not found'; end if;
  if v_account.status <> 'submitted' then
    raise exception 'only a submitted application can be approved (this one is %)', v_account.status;
  end if;

  -- This function is the ONLY writer of the three internal terms columns.
  update public.customer_accounts
     set status = 'approved',
         approved_payment_terms = coalesce(nullif(btrim(coalesce(p_payment_terms,'')),''),
                                           approved_payment_terms),
         credit_limit = coalesce(p_credit_limit, credit_limit),
         price_tier = coalesce(nullif(btrim(coalesce(p_price_tier,'')),''), price_tier),
         approved_at = now(),
         approved_by = auth.uid()
   where id = p_account_id;

  insert into public.customer_account_activity
    (company_entity_id, customer_account_id, event, detail, actor)
  values (v_account.company_entity_id, p_account_id, 'approved',
          coalesce(p_payment_terms, ''), auth.uid());

  return json_build_object('ok', true);
end;
$$;

create or replace function public.reject_customer_account(
  p_account_id uuid,
  p_reason text default null
)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_account public.customer_accounts%rowtype;
begin
  if not public.can_manage_client_invoices() then
    raise exception 'not authorized';
  end if;
  select * into v_account from public.customer_accounts
   where id = p_account_id and company_entity_id = public.active_company_id();
  if v_account.id is null then raise exception 'customer account not found'; end if;
  if v_account.status = 'approved' then
    raise exception 'an approved customer cannot be rejected -- deactivate instead';
  end if;

  update public.customer_accounts
     set status = 'rejected', decision_reason = p_reason
   where id = p_account_id;

  -- A rejected application's live links die with it.
  update public.customer_account_invites
     set status = 'revoked'
   where customer_account_id = p_account_id and status = 'pending';

  insert into public.customer_account_activity
    (company_entity_id, customer_account_id, event, detail, actor)
  values (v_account.company_entity_id, p_account_id, 'rejected', p_reason, auth.uid());

  return json_build_object('ok', true);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 11. RPCs — the public path (service-role only; the edge function calls them)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- These take a TOKEN, not an account id. The edge function never decides which
-- account a request is about -- the token does -- so a body naming somebody
-- else's account cannot reach anything.

-- Resolve a token to its account, or say precisely why not. Returning the
-- reason (expired / consumed / revoked) rather than a bare null is what lets
-- the page say "this link has expired, ask for a new one" instead of "not
-- found", which reads as a typo and produces a support email.
create or replace function public.customer_onboarding_resolve_token(
  p_token   text,
  p_purpose text default 'onboarding'
)
returns table (
  ok boolean,
  reason text,
  invite_id uuid,
  customer_account_id uuid,
  company_entity_id uuid,
  email text
)
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_invite public.customer_account_invites%rowtype;
begin
  select * into v_invite from public.customer_account_invites
   where token_hash = encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex')
     and purpose = p_purpose;

  if v_invite.id is null then
    return query select false, 'not_found'::text, null::uuid, null::uuid, null::uuid, null::text;
    return;
  end if;
  if v_invite.status <> 'pending' then
    return query select false, v_invite.status, v_invite.id, v_invite.customer_account_id,
                        v_invite.company_entity_id, v_invite.email;
    return;
  end if;
  if v_invite.expires_at < now() then
    update public.customer_account_invites set status = 'expired' where id = v_invite.id;
    return query select false, 'expired'::text, v_invite.id, v_invite.customer_account_id,
                        v_invite.company_entity_id, v_invite.email;
    return;
  end if;

  return query select true, 'ok'::text, v_invite.id, v_invite.customer_account_id,
                      v_invite.company_entity_id, v_invite.email;
end;
$$;

-- The whole submission, atomically: account fields, tax profile, addresses,
-- contacts, invite consumption, and the continuation token, in ONE
-- transaction. Split across separate calls, a failure halfway leaves an
-- application that is neither submitted nor resumable.
--
-- p_payload is applicant-owned data ONLY. approved_payment_terms, credit_limit,
-- price_tier, every card column and every link column are not named anywhere
-- below, so a payload carrying them changes nothing.
create or replace function public.submit_customer_account(
  p_token   text,
  p_payload jsonb
)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tok record;
  v_account public.customer_accounts%rowtype;
  v_continuation text;
  v_addr jsonb;
  v_contact jsonb;
begin
  select * into v_tok from public.customer_onboarding_resolve_token(p_token, 'onboarding');
  if not v_tok.ok then
    raise exception 'invite_%', v_tok.reason using errcode = '28000';
  end if;

  select * into v_account from public.customer_accounts where id = v_tok.customer_account_id;
  if v_account.status not in ('invited','submitted') then
    -- Approved or rejected: the application is over. A late replay of the
    -- token must not reopen it.
    raise exception 'account_%', v_account.status using errcode = '28000';
  end if;

  update public.customer_accounts
     set legal_name = nullif(btrim(coalesce(p_payload->>'legal_name', '')), ''),
         dba_name   = nullif(btrim(coalesce(p_payload->>'dba_name', '')), ''),
         website    = nullif(btrim(coalesce(p_payload->>'website', '')), ''),
         requested_payment_terms =
           nullif(btrim(coalesce(p_payload->>'requested_payment_terms', '')), ''),
         applicant_notes = nullif(btrim(coalesce(p_payload->>'applicant_notes', '')), ''),
         status = 'submitted',
         submitted_at = now()
   where id = v_account.id
  returning * into v_account;

  -- ── Tax profile (narrow table) ────────────────────────────────────────────
  if coalesce(p_payload->>'federal_ein', '') <> ''
     or coalesce(p_payload->>'resale_tax_id', '') <> '' then
    insert into public.customer_account_tax_profiles
      (company_entity_id, customer_account_id, federal_ein, resale_tax_id)
    values (v_account.company_entity_id, v_account.id,
            nullif(btrim(coalesce(p_payload->>'federal_ein','')), ''),
            nullif(btrim(coalesce(p_payload->>'resale_tax_id','')), ''))
    on conflict (customer_account_id) do update
      set federal_ein = excluded.federal_ein,
          resale_tax_id = excluded.resale_tax_id,
          updated_at = now();
  end if;

  -- ── Addresses ─────────────────────────────────────────────────────────────
  -- Replaced wholesale rather than merged: a resubmission that drops the
  -- separate billing address must not leave the old one standing.
  delete from public.customer_account_addresses where customer_account_id = v_account.id;
  for v_addr in
    select value from jsonb_array_elements(coalesce(p_payload->'addresses', '[]'::jsonb))
  loop
    insert into public.customer_account_addresses
      (company_entity_id, customer_account_id, address_type, same_as_address_type,
       recipient_name, attention_name, street1, street2, city, region, postal_code,
       country, phone)
    values (
      v_account.company_entity_id, v_account.id,
      v_addr->>'address_type',
      nullif(btrim(coalesce(v_addr->>'same_as_address_type','')), ''),
      nullif(btrim(coalesce(v_addr->>'recipient_name','')), ''),
      nullif(btrim(coalesce(v_addr->>'attention_name','')), ''),
      nullif(btrim(coalesce(v_addr->>'street1','')), ''),
      nullif(btrim(coalesce(v_addr->>'street2','')), ''),
      nullif(btrim(coalesce(v_addr->>'city','')), ''),
      nullif(btrim(coalesce(v_addr->>'region','')), ''),
      nullif(btrim(coalesce(v_addr->>'postal_code','')), ''),
      nullif(btrim(coalesce(v_addr->>'country','')), ''),
      nullif(btrim(coalesce(v_addr->>'phone','')), '')
    );
  end loop;

  -- ── Contacts ──────────────────────────────────────────────────────────────
  delete from public.customer_account_contacts where customer_account_id = v_account.id;
  for v_contact in
    select value from jsonb_array_elements(coalesce(p_payload->'contacts', '[]'::jsonb))
  loop
    insert into public.customer_account_contacts
      (company_entity_id, customer_account_id, contact_type,
       first_name, last_name, title, email, phone)
    values (
      v_account.company_entity_id, v_account.id,
      coalesce(nullif(btrim(coalesce(v_contact->>'contact_type','')), ''), 'primary'),
      nullif(btrim(coalesce(v_contact->>'first_name','')), ''),
      nullif(btrim(coalesce(v_contact->>'last_name','')), ''),
      nullif(btrim(coalesce(v_contact->>'title','')), ''),
      nullif(btrim(coalesce(v_contact->>'email','')), ''),
      nullif(btrim(coalesce(v_contact->>'phone','')), '')
    );
  end loop;

  -- ── Consume the onboarding token, issue the continuation ──────────────────
  update public.customer_account_invites
     set status = 'consumed', consumed_at = now()
   where id = v_tok.invite_id;

  -- Any earlier card_setup token is retired: one live continuation at a time,
  -- so a resubmission cannot leave two card links working.
  update public.customer_account_invites
     set status = 'revoked'
   where customer_account_id = v_account.id
     and purpose = 'card_setup'
     and status = 'pending';

  v_continuation := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.customer_account_invites
    (company_entity_id, customer_account_id, purpose, email, token_hash, expires_at)
  values (v_account.company_entity_id, v_account.id, 'card_setup', v_account.contact_email,
          encode(extensions.digest(v_continuation, 'sha256'), 'hex'),
          now() + interval '2 hours');

  insert into public.customer_account_activity
    (company_entity_id, customer_account_id, event, detail)
  values (v_account.company_entity_id, v_account.id, 'submitted', v_account.legal_name);

  return json_build_object(
    'ok', true,
    'customer_account_id', v_account.id,
    'continuation_token', v_continuation,
    'expires_at', now() + interval '2 hours'
  );
end;
$$;

-- Record the applicant's authorization for future off-session charges. A
-- separate call from the submission because consent is given on the card
-- screen, next to the card field, which is where Stripe expects it to be.
create or replace function public.record_customer_account_consent(
  p_account_id uuid,
  p_version    text,
  p_text       text
)
returns void
language sql
security definer
set search_path to 'public'
as $$
  update public.customer_accounts
     set off_session_consent_at = now(),
         off_session_consent_version = p_version,
         off_session_consent_text = p_text
   where id = p_account_id;
$$;

-- Claim the card-setup step for an account. The unique index on
-- card_setup_session_id is the backstop; this is the gate that decides whether
-- a caller may create a NEW Checkout session or must be handed the one that
-- already exists -- the same check-then-act problem stripe_claim_checkout
-- solves for subscriptions, and solved the same way.
create or replace function public.claim_customer_card_setup(p_account_id uuid)
returns table (allowed boolean, reason text, existing_session_id text, attempt integer)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_attempt integer;
  v_taken boolean;
  v_account public.customer_accounts%rowtype;
begin
  -- ONE atomic statement, not select-then-decide. A `select ... for update`
  -- followed by an update is correct too, but its correctness is invisible to
  -- any test that cannot open two connections -- and an untestable guard is
  -- how check-then-act came back twice on the Billing surface. Expressed as a
  -- conditional UPDATE, the row either transitions or it does not, and a test
  -- calling this twice in a row sees the difference.
  update public.customer_accounts
     set card_setup_status = 'session_open',
         card_setup_claimed_at = now()
   where id = p_account_id
     -- Consent first: a session must not exist before the authorisation does.
     and off_session_consent_at is not null
     -- Already captured is terminal here. Running setup again would attach a
     -- second payment method and leave which one is the invoice default
     -- ambiguous.
     and card_setup_status <> 'succeeded'
     and (
       card_setup_status in ('not_started','abandoned')
       -- A stale claim that never got as far as recording a session: the
       -- caller was killed mid-flight. Ten minutes is far longer than any
       -- Stripe call this makes. A claim WITH a session id is deliberately
       -- excluded -- that one is resolved by asking Stripe, never by a timer.
       or (card_setup_session_id is null
           and card_setup_claimed_at < now() - interval '10 minutes')
     )
  returning card_setup_attempt into v_attempt;
  get diagnostics v_taken = row_count;

  if v_taken then
    -- Note the attempt is NOT rotated when a stale claim is taken over. The
    -- dead attempt may have created a session at Stripe whose answer was lost,
    -- and only replaying its idempotency key gets that same session back --
    -- rotating here would open a second one. Rotation happens exclusively in
    -- release_customer_card_setup(), once Stripe has said the old session is
    -- expired or gone.
    return query select true, 'ok'::text, null::text, v_attempt;
    return;
  end if;

  select * into v_account from public.customer_accounts where id = p_account_id;
  if v_account.id is null then
    return query select false, 'not_found'::text, null::text, 0; return;
  end if;
  if v_account.card_setup_status = 'succeeded' then
    return query select false, 'already_captured'::text, v_account.card_setup_session_id,
                        v_account.card_setup_attempt; return;
  end if;
  if v_account.off_session_consent_at is null then
    return query select false, 'consent_required'::text, null::text,
                        v_account.card_setup_attempt; return;
  end if;
  -- A live claim. The caller retrieves the session from Stripe and lets ITS
  -- status decide -- never mints a second payable link on a timer.
  return query select false, 'session_open'::text, v_account.card_setup_session_id,
                      v_account.card_setup_attempt;
end;
$$;

-- Record the Checkout session against the account. Fail-closed: the caller
-- does not hand the URL out unless this lands, or a session exists at Stripe
-- that SILO cannot match to the delivery that completes it.
create or replace function public.note_customer_card_setup_session(
  p_account_id uuid,
  p_session_id text
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_rows integer;
begin
  -- The claim already moved the row to 'session_open'; this records WHICH
  -- session it was taken for. Scoped to a row that is still claimed and has no
  -- session yet, so a late write from a superseded attempt cannot overwrite the
  -- session id a live attempt just recorded.
  update public.customer_accounts
     set card_setup_session_id = p_session_id
   where id = p_account_id
     and card_setup_status = 'session_open'
     and card_setup_session_id is null;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- Does this Checkout session belong to a customer account of this company?
--
-- Read-only, and it exists so the webhook can answer that question BEFORE it
-- changes anything at Stripe. A tenant owns their Connect account outright
-- (Standard) and can run a setup-mode Checkout from their own dashboard or
-- another integration; those events arrive on the SAME connect endpoint and
-- resolve to the same company. Acting on one -- in particular re-pointing that
-- customer's invoice default -- would be SILO reaching into a flow that is
-- none of its business. A session this feature did not create returns NO ROWS,
-- and the caller stops without touching Stripe.
create or replace function public.customer_card_setup_session_owner(
  p_company    uuid,
  p_session_id text
)
returns table (customer_account_id uuid, stripe_customer_id text)
language sql
stable
security definer
set search_path to 'public'
as $$
  select ca.id, ca.stripe_customer_id
    from public.customer_accounts ca
   where ca.card_setup_session_id = p_session_id
     and ca.company_entity_id = p_company;
$$;

-- Stamp the moment the PaymentMethod became the customer's invoice default.
-- Separate from record_customer_card_setup() because the two facts are
-- established by two different Stripe calls and can fail independently: the
-- card is attached by Checkout, the default is set by customers.update, and
-- "saved but not yet default" is a real state a person has to be able to see.
create or replace function public.mark_customer_card_default(
  p_company    uuid,
  p_session_id text
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_rows integer;
begin
  update public.customer_accounts
     set default_payment_method_set_at = coalesce(default_payment_method_set_at, now())
   where card_setup_session_id = p_session_id
     and company_entity_id = p_company
     and card_payment_method_id is not null;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- The webhook's writer. Takes the SESSION id, not the account id: the
-- delivery names a session, and looking the account up FROM the session is
-- what makes a mismatched customer detectable rather than assumed.
create or replace function public.record_customer_card_setup(
  p_company           uuid,
  p_session_id        text,
  p_setup_intent_id   text,
  p_customer_id       text,
  p_payment_method_id text,
  p_brand             text default null,
  p_last4             text default null,
  p_exp_month         integer default null,
  p_exp_year          integer default null,
  p_is_default        boolean default false
)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_account public.customer_accounts%rowtype;
begin
  select * into v_account from public.customer_accounts
   where card_setup_session_id = p_session_id for update;

  if v_account.id is null then
    return json_build_object('ok', false, 'reason', 'no_account_for_session');
  end if;
  -- The delivery must belong to the company that owns this account, and to the
  -- Stripe customer this account is bound to. Either mismatch means the event
  -- was resolved to the wrong tenant or the account was re-pointed mid-flight;
  -- writing a payment method in either case attaches somebody's card to
  -- somebody else's account.
  if v_account.company_entity_id <> p_company then
    return json_build_object('ok', false, 'reason', 'company_mismatch');
  end if;
  if v_account.stripe_customer_id is distinct from p_customer_id then
    return json_build_object('ok', false, 'reason', 'customer_mismatch');
  end if;

  -- Repeat completions are idempotent: the same session completing twice
  -- writes the same row twice and changes nothing.
  update public.customer_accounts
     set card_setup_status = 'succeeded',
         card_setup_intent_id = p_setup_intent_id,
         card_payment_method_id = p_payment_method_id,
         card_brand = p_brand,
         card_last4 = p_last4,
         card_exp_month = p_exp_month,
         card_exp_year = p_exp_year,
         card_captured_at = coalesce(card_captured_at, now()),
         default_payment_method_set_at =
           case when p_is_default then coalesce(default_payment_method_set_at, now())
                else default_payment_method_set_at end
   where id = v_account.id;

  insert into public.customer_account_activity
    (company_entity_id, customer_account_id, event, detail)
  values (v_account.company_entity_id, v_account.id, 'card_captured',
          coalesce(p_brand, '') || ' ****' || coalesce(p_last4, ''));

  return json_build_object('ok', true, 'customer_account_id', v_account.id);
end;
$$;

-- checkout.session.expired: the applicant walked away. NOT terminal -- the
-- account goes back to a state a fresh session can be started from, or one
-- abandoned tab would block the card step forever.
create or replace function public.release_customer_card_setup(
  p_company    uuid,
  p_session_id text
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_attempt integer;
begin
  -- The attempt bump is the point of this function, not a detail of it: the
  -- next create's Stripe idempotency key is derived from it, so a release that
  -- did not bump would replay the session it just released. It happens HERE,
  -- in the one function both the webhook's expiry and the handler's
  -- definitively-gone path call, rather than in either caller -- two copies of
  -- this would eventually disagree about when a new session is a new session.
  update public.customer_accounts
     set card_setup_status = 'abandoned',
         card_setup_session_id = null,
         card_setup_claimed_at = null,
         card_setup_attempt = card_setup_attempt + 1
   where card_setup_session_id = p_session_id
     and company_entity_id = p_company
     -- A late expiry for a session that already succeeded must not undo it.
     and card_setup_status = 'session_open'
  returning card_setup_attempt into v_attempt;
  -- null means nothing was released (already succeeded, or another delivery
  -- got there first) -- distinguishable from "released, now on attempt 0",
  -- which cannot occur since the bump makes the first release attempt 1.
  return v_attempt;
end;
$$;

-- Bind the Stripe customer to the account. Write-once: a second, different
-- customer id means two Stripe customers exist for one applicant and their
-- invoice history would split.
create or replace function public.bind_customer_account_stripe_customer(
  p_account_id  uuid,
  p_customer_id text
)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_existing text;
begin
  select stripe_customer_id into v_existing
    from public.customer_accounts where id = p_account_id for update;

  if v_existing is not null and v_existing <> p_customer_id then
    raise exception 'customer account % is already bound to Stripe customer %',
      p_account_id, v_existing;
  end if;
  update public.customer_accounts
     set stripe_customer_id = p_customer_id where id = p_account_id;
  return json_build_object('ok', true, 'stripe_customer_id', p_customer_id);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 12. Grants
-- ═══════════════════════════════════════════════════════════════════════════
-- Supabase's default privileges grant EXECUTE on every new public function to
-- anon AND authenticated. For the public-path functions that would put a
-- SECURITY DEFINER token resolver and a submission writer on the open
-- internet, reachable with the published anon key -- so the revoke IS the
-- boundary here, exactly as 20260904330000 was for chat_run_readonly_query.
do $$
declare r text;
begin
  for r in select unnest(array[
    'customer_onboarding_resolve_token(text,text)',
    'submit_customer_account(text,jsonb)',
    'record_customer_account_consent(uuid,text,text)',
    'claim_customer_card_setup(uuid)',
    'note_customer_card_setup_session(uuid,text)',
    'record_customer_card_setup(uuid,text,text,text,text,text,text,integer,integer,boolean)',
    'release_customer_card_setup(uuid,text)',
    'bind_customer_account_stripe_customer(uuid,text)',
    'customer_card_setup_session_owner(uuid,text)',
    'mark_customer_card_default(uuid,text)'
  ])
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', r);
  end loop;
end;
$$;

-- The internal RPCs stay callable by authenticated users; each gates itself on
-- can_manage_client_invoices().
do $$
declare r text;
begin
  for r in select unnest(array[
    'create_customer_account_invite(text,text,text)',
    'revoke_customer_account_invite(uuid)',
    'approve_customer_account(uuid,text,numeric,text)',
    'reject_customer_account(uuid,text)'
  ])
  loop
    execute format('revoke all on function public.%s from public, anon', r);
    execute format('grant execute on function public.%s to authenticated', r);
  end loop;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 13. Storage — the resale certificate
-- ═══════════════════════════════════════════════════════════════════════════
-- Private bucket, parent id as the first path segment, policy as an EXISTS --
-- the rule set in 20260904120000. The EXISTS names the TAX PROFILE rather
-- than the account, so the certificate inherits the narrow gate instead of the
-- directory's: someone who may see the ship-to address may not pull the
-- seller's permit.
--
-- There is deliberately no anon policy. The applicant is unauthenticated and
-- uploads through a service-role-minted signed URL, which bypasses RLS --
-- so an anon policy would be a hole with nothing behind it.

insert into storage.buckets (id, name, public)
values ('customer-account-files', 'customer-account-files', false)
on conflict (id) do nothing;

drop policy if exists "customer account files readable with the tax profile" on storage.objects;
create policy "customer account files readable with the tax profile"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'customer-account-files'
    and exists (
      select 1 from public.customer_account_tax_profiles tp
       where tp.customer_account_id::text = (storage.foldername(name))[1]
    )
  );

drop policy if exists "customer account files writable with the tax profile" on storage.objects;
create policy "customer account files writable with the tax profile"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'customer-account-files'
    and exists (
      select 1 from public.customer_account_tax_profiles tp
       where tp.customer_account_id::text = (storage.foldername(name))[1]
    )
  );

drop policy if exists "customer account files deletable with the tax profile" on storage.objects;
create policy "customer account files deletable with the tax profile"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'customer-account-files'
    and exists (
      select 1 from public.customer_account_tax_profiles tp
       where tp.customer_account_id::text = (storage.foldername(name))[1]
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- 14. Comments + Ask SILO catalog
-- ═══════════════════════════════════════════════════════════════════════════

comment on table public.customer_accounts is
  'SILO''s native customer master -- the first party table in the platform (the accounting foundation has a chart of accounts and no parties). account_type carries wholesale/retail/distributor/licensee rather than a wholesale boolean, which would have to be migrated away at the first distributor. Links OUT to ar_customers, quickbooks_customers and stripe_invoice_customers and never writes into any of them: all three are mirrors owned by their syncs. requested_payment_terms is applicant-supplied; approved_payment_terms, credit_limit and price_tier are internal and are written only by approve_customer_account(). Card columns hold Stripe display metadata only -- brand, last four, expiry -- never card data.';

comment on table public.customer_account_tax_profiles is
  'EIN, resale/sales-tax id and the seller''s-permit file path, split out of customer_accounts so ordinary customer-directory access does not expose a federal tax id. Gated by can_manage_client_invoices() on both halves of its policy, and the customer-account-files storage policy keys its EXISTS on THIS table so the certificate object inherits the same narrow gate.';

comment on table public.customer_account_addresses is
  'Business / shipping / billing addresses. same_as_address_type is a POINTER, not a copy -- a pointer row carries no street, and the CHECK constraints bound the chain to billing -> shipping -> business, so no cycle is representable and customer_account_addresses_resolved_v can follow it with two joins. recipient_name/attention_name/phone are part of the shipping LABEL (the place), which is why they sit here rather than in customer_account_contacts (the people).';

comment on table public.customer_account_invites is
  'Onboarding and card-setup tokens: sha256-hashed, email-bound, RLS deny-all with no policy, RPC-only -- org_invites'' stance. The onboarding token (14 days) is CONSUMED at submission and a card_setup continuation (2 hours) is issued in the same transaction, so the link that lives in an inbox is not the link that authorises the card step.';

comment on function public.submit_customer_account(text,jsonb) is
  'The entire submission in one transaction: account fields, tax profile, addresses, contacts, invite consumption and the continuation token. Takes a TOKEN rather than an account id, so a body naming someone else''s account reaches nothing. Names no internal or card or link column, so a payload carrying approved_payment_terms or stripe_customer_id changes nothing. Addresses and contacts are replaced wholesale, not merged, or a resubmission that drops the billing address would leave the old one standing.';

comment on function public.claim_customer_card_setup(uuid) is
  'May this caller create a NEW Checkout setup session? Decided by ONE conditional UPDATE rather than a select-then-act, so two tabs cannot both be told yes and so the guard is observable to a single-connection test. An open session is handed back rather than replaced -- the caller retrieves it from Stripe and lets its status decide, never minting a second link on a timer. A stale claim is taken over only when it never recorded a session, and the takeover KEEPS the attempt id: the dead attempt may have created a session whose answer was lost, and only replaying its idempotency key returns that same session. Rotation belongs to release_customer_card_setup(), after Stripe has said the old session is gone.';

comment on function public.record_customer_card_setup(uuid,text,text,text,text,text,text,integer,integer,boolean) is
  'The webhook''s writer, keyed on the SESSION id so the account is looked up FROM the delivery rather than supplied beside it -- which is what makes a company or Stripe-customer mismatch detectable instead of assumed. Idempotent: the same session completing twice changes nothing. default_payment_method_set_at is stamped only when the PaymentMethod was confirmed as the customer''s invoice default, so "saved but not yet default" stays a distinguishable state.';

select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog
   set description = 'SILO''s native customer master (wholesale and other account types). Onboarded through a public token-gated form. Links to ar_customers / quickbooks_customers / stripe_invoice_customers without writing to them. Tax identifiers live in customer_account_tax_profiles, which most users cannot read.',
       keywords = array['customer','wholesale','account','onboarding','retailer','store']
 where relname = 'customer_accounts';

update public.silo_chat_schema_catalog
   set is_hidden = true
 where relname in ('customer_account_invites','customer_account_tax_profiles');
