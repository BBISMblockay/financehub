-- ---------------------------------------------------------------------------
-- Affiliate payouts through PayPal -- the first rail that actually sends money
--
-- WHAT THIS CHANGES, AND WHAT IT DELIBERATELY DOES NOT
--
-- Until now affiliate payouts were a manual handoff: SILO built the batch,
-- somebody paid it elsewhere, and a person recorded the reference.
-- affiliate_mark_payout_paid() refused any method but 'manual' because nothing
-- in the system could have paid a payout. This migration adds the one rail
-- where that stops being true.
--
-- The money is the CUSTOMER'S and it moves from THEIR PayPal business account
-- to THEIR affiliates. SILO's own PayPal is not in the path, holds nothing and
-- funds nothing. That is the whole design constraint, and it is why the
-- credentials below belong to the company rather than to the platform:
-- a transfer out of a Stripe balance can only be made by the platform that
-- owns it, so a platform-owned rail would make SILO the payer of record for
-- its customers' affiliates -- their 1099s, their losses, their reserve, on
-- SILO's account. PayPal's Payouts API has no such constraint: a business
-- sends from its own balance, and a platform can be told to do it on its
-- behalf. See docs/ops/affiliate-studio.md.
--
-- Still refused here, on purpose:
--   * affiliate_mark_payout_paid() continues to refuse every non-manual
--     method. A PayPal payout is NOT recorded as paid by a person clicking a
--     button; it is recorded by affiliate_payout_send_record() from what
--     PayPal answered. A human cannot assert a machine payment happened.
--   * No client role may write a credential, a send, or a payout row.
--   * Nothing here moves money by itself. A send exists only after a person
--     with the money gate approved the payout.
--
-- THE RETRY PROBLEM, WHICH IS THE WHOLE REASON FOR affiliate_payout_sends
--
-- An HTTP call to a payment API has three outcomes, not two: yes, no, and no
-- answer. A payout batch that times out may or may not have been accepted, and
-- asking again without a key is how an affiliate gets paid twice. So the send
-- row is written BEFORE the call, carries a deterministic request id, and is
-- the thing the provider's answer is recorded against. A send with no answer
-- is 'unknown' and BLOCKS another attempt until it has been reconciled against
-- PayPal -- the one state the UI must never let a person click past.
--
-- 'sent' is also not 'paid'. PayPal pays an email address, and an email with
-- no PayPal account leaves the item UNCLAIMED for 30 days before the money
-- comes back. Only an item PayPal reports as successful marks the payout paid.
-- ---------------------------------------------------------------------------

-- ── 1. The company's own payout provider connection ────────────────────────
-- One row per company per provider. Shaped like klaviyo_connections, with one
-- difference that matters: NO client role may read this table at all, because
-- client_secret is a credential that can move the company's money. Members
-- read the status view below instead, which is the same split
-- stripe_connect_accounts / stripe_connect_status_v already uses.
create table if not exists public.affiliate_payout_connections (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  provider          text not null default 'paypal' check (provider in ('paypal')),
  -- PayPal issues separate credentials per environment and the hosts differ.
  -- Storing it means a company can prove the whole flow in sandbox before any
  -- real money is involved, which is how this is meant to be adopted.
  environment       text not null default 'sandbox' check (environment in ('sandbox','live')),

  client_id         text,
  client_secret     text,

  -- Read back from PayPal when the connection is tested, never typed in.
  account_email     text,
  payouts_enabled   boolean,

  is_active         boolean not null default true,
  last_tested_at    timestamptz,
  last_test_success boolean,
  last_test_error   text,
  last_send_at      timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,

  constraint affiliate_payout_connections_company_provider unique (company_entity_id, provider)
);

alter table public.affiliate_payout_connections enable row level security;

-- No policy and no grant for any client role: service role only, like
-- stripe_connect_setup_claims. The edge function is the only reader.
revoke all on public.affiliate_payout_connections from anon, authenticated;
grant all on public.affiliate_payout_connections to service_role;

comment on table public.affiliate_payout_connections is
  'The COMPANY''s own PayPal business credentials, used to send that company''s affiliate payouts from that company''s own balance. SILO''s platform PayPal is never in the path. No client role may read this table -- client_secret can move the company''s money -- so members read affiliate_payout_connection_status_v instead, the same split as stripe_connect_accounts / stripe_connect_status_v. Written only by the affiliate-payouts edge function, which gates on can_approve_affiliate_commissions().';

-- What a member may know: whether payouts are connected and working. Definer
-- with its own explicit tenant filter, because the base table is unreadable by
-- every client role and an invoker view over it would show nothing. The WHERE
-- clause is the tenant boundary and the COLUMN LIST is the disclosure
-- boundary: client_id and client_secret are absent on purpose, and
-- credentials_set answers "is it configured" without disclosing either.
drop view if exists public.affiliate_payout_connection_status_v;
create view public.affiliate_payout_connection_status_v
with (security_invoker = false) as
  select
    c.company_entity_id,
    c.provider,
    c.environment,
    c.is_active,
    c.account_email,
    c.payouts_enabled,
    c.last_tested_at,
    c.last_test_success,
    c.last_test_error,
    c.last_send_at,
    (btrim(coalesce(c.client_id, '')) <> '' and btrim(coalesce(c.client_secret, '')) <> '') as credentials_set
  from public.affiliate_payout_connections c
  where c.company_entity_id = public.active_company_id();

revoke all on public.affiliate_payout_connection_status_v from anon, authenticated;
grant select on public.affiliate_payout_connection_status_v to authenticated;

comment on view public.affiliate_payout_connection_status_v is
  'Is this company''s affiliate payout rail connected and working. security_invoker = false with an explicit active_company_id() filter: that filter IS the tenant boundary and the column list IS the disclosure boundary, so do not remove the filter and do not add client_id or client_secret.';

-- ── 2. The affiliate's payee details ───────────────────────────────────────
-- affiliate_payout_accounts already exists as the per-affiliate payee mirror.
-- PayPal joins it as a second provider. A PayPal payee is an email address and
-- nothing else: no account to create, no onboarding, no identity check before
-- a payment can be attempted -- which is exactly why this rail ships first.
-- The constraint is dropped BY ITS DEFINITION, not by a guessed name. Several
-- objects in production were applied by hand, so a name that does not match
-- would leave `drop ... if exists` a silent no-op and the old CHECK still
-- rejecting 'paypal' -- a migration that reports success and changes nothing.
do $$
declare c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.affiliate_payout_accounts'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%stripe_express%'
  loop
    execute format('alter table public.affiliate_payout_accounts drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.affiliate_payout_accounts
  add constraint affiliate_payout_accounts_provider_check
  check (provider in ('stripe_express','paypal'));

alter table public.affiliate_payout_accounts
  add column if not exists payout_email text;
alter table public.affiliate_payout_accounts
  drop constraint if exists affiliate_payout_accounts_email_shape;
alter table public.affiliate_payout_accounts
  add constraint affiliate_payout_accounts_email_shape
  check (payout_email is null or position('@' in payout_email) > 1);

comment on column public.affiliate_payout_accounts.payout_email is
  'PayPal only: the address the affiliate is paid at. Set by the affiliate in their own portal (through the affiliate-portal edge function, service role), never by staff -- the person who owns the address is the only one who can be right about it. Deliberately NOT affiliates.contact_email: where someone reads mail and where they take money are different facts, and defaulting one to the other pays the wrong address silently.';

-- ── 3. The rail on a program and on a payout ───────────────────────────────
-- Same reasoning as above: matched on 'stripe_connect_express', which only the
-- method CHECK mentions, so the status and evidence constraints are untouched.
do $$
declare t text; c record;
begin
  foreach t in array array['affiliate_programs', 'affiliate_payouts'] loop
    for c in
      select conname
        from pg_constraint
       where conrelid = format('public.%I', t)::regclass
         and contype = 'c'
         and pg_get_constraintdef(oid) like '%stripe_connect_express%'
    loop
      execute format('alter table public.%I drop constraint %I', t, c.conname);
    end loop;
  end loop;
end $$;

alter table public.affiliate_programs
  add constraint affiliate_programs_payout_method_check
  check (payout_method in ('manual','stripe_connect_express','paypal_payouts'));

alter table public.affiliate_payouts
  add constraint affiliate_payouts_method_check
  check (method in ('manual','stripe_connect_express','paypal_payouts'));

-- ── 4. Every attempt to send a payout ──────────────────────────────────────
create table if not exists public.affiliate_payout_sends (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  payout_id         uuid not null references public.affiliate_payouts(id) on delete cascade,
  provider          text not null default 'paypal' check (provider in ('paypal')),
  environment       text not null check (environment in ('sandbox','live')),

  -- The nth attempt on this payout. A refused or returned attempt may be
  -- followed by another; a successful or in-flight one may not.
  attempt           integer not null check (attempt >= 1),

  -- The two keys that make a retry safe. Both are derived from the payout and
  -- the attempt, so the SAME attempt replayed after a timeout is recognised by
  -- PayPal as the same request rather than processed twice. PayPal rejects a
  -- sender_batch_id reused within 30 days, which is a second, independent
  -- guard on the same mistake.
  request_id        text not null,
  sender_batch_id   text not null,

  provider_batch_id text,
  provider_item_id  text,

  amount_cents      bigint not null check (amount_cents > 0),
  currency          text not null check (currency ~ '^[A-Z]{3}$'),
  payout_email      text not null,

  -- SILO's own vocabulary, which is deliberately narrower than PayPal's:
  --   unknown   -- the call was made and no answer was recorded. BLOCKS another
  --               attempt: it may have been accepted.
  --   sent      -- PayPal accepted the batch; the item has not succeeded yet.
  --   unclaimed -- sent to an address with no PayPal account. Returns after 30
  --               days if never claimed. NOT paid.
  --   paid      -- PayPal reported the item successful. This is the only state
  --               that marks the payout paid.
  --   returned  -- the money came back (unclaimed too long, or cancelled).
  --   refused   -- PayPal rejected it. Nothing moved; another attempt is safe.
  state             text not null default 'unknown'
                      check (state in ('unknown','sent','unclaimed','paid','returned','refused')),
  -- PayPal's own word, with NO CHECK: a provider that adds a status would
  -- otherwise freeze this mirror on the previous one, which is worse than an
  -- unrecognised string (the reason stripe_invoices.status has no CHECK).
  provider_status   text,
  error_code        text,
  error_message     text,
  fee_cents         bigint,

  sent_at           timestamptz,
  settled_at        timestamptz,
  checked_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references public.profiles(id)
);

-- The idempotency key is unique by construction, and the database says so: two
-- concurrent runs of the same payout cannot both claim an attempt.
create unique index if not exists affiliate_payout_sends_request_once
  on public.affiliate_payout_sends (request_id);
create unique index if not exists affiliate_payout_sends_attempt_once
  on public.affiliate_payout_sends (payout_id, attempt);
create index if not exists affiliate_payout_sends_payout_idx
  on public.affiliate_payout_sends (company_entity_id, payout_id, created_at desc);
-- The reconciler's query: everything not yet in a terminal state.
create index if not exists affiliate_payout_sends_open_idx
  on public.affiliate_payout_sends (company_entity_id, state)
  where state in ('unknown','sent','unclaimed');

alter table public.affiliate_payout_sends enable row level security;

drop policy if exists affiliate_payout_sends_select on public.affiliate_payout_sends;
create policy affiliate_payout_sends_select on public.affiliate_payout_sends
  for select to authenticated
  using (company_entity_id = public.active_company_id());

-- No affiliate table or view is readable by anon -- the drift check fails
-- CRITICAL on any that is, and Supabase's default privileges grant it.
revoke all on public.affiliate_payout_sends from anon;
revoke insert, update, delete on public.affiliate_payout_sends from authenticated;
grant select on public.affiliate_payout_sends to authenticated;
grant all on public.affiliate_payout_sends to service_role;

comment on table public.affiliate_payout_sends is
  'One row per ATTEMPT to send a payout through a provider. Written before the call, not after, so a call that never answered leaves evidence instead of nothing: that row is state unknown and BLOCKS another attempt until it has been reconciled against the provider. Readable by the company, writable only by the service role through affiliate_payout_send_claim() and affiliate_payout_send_record(). sent is not paid -- PayPal pays an email address, and an address with no PayPal account sits unclaimed for 30 days before the money returns.';

-- ── 5. Claiming an attempt ─────────────────────────────────────────────────
-- Service role only. The gate on WHO may cause a payment lives in the edge
-- function (can_approve_affiliate_commissions, evaluated by a caller-scoped
-- client, the payment-request-notify pattern); this function's job is that the
-- same payout can never be in flight twice.
-- An earlier shape of this function took no company. Dropped rather than left
-- as an overload, because an overload without the tenant check would still be
-- callable by the service role.
drop function if exists public.affiliate_payout_send_claim(uuid, text, uuid);

create or replace function public.affiliate_payout_send_claim(
  p_payout uuid,
  p_company uuid,
  p_environment text,
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payout  public.affiliate_payouts;
  v_email   text;
  v_attempt integer;
  v_open    text;
  v_send    uuid;
  v_request text;
begin
  select * into v_payout from public.affiliate_payouts where id = p_payout;
  if not found then raise exception 'affiliate_payout_send_claim: no such payout'; end if;

  -- THE TENANT CHECK, and it has to be here. This function runs as the service
  -- role, which bypasses RLS, and the payout id reaches it from a request
  -- body: without this, a person with money authority at one company could
  -- send another company's payout -- paying that company's affiliate out of
  -- their own PayPal, and learning the address. The caller's company is read
  -- from their own profile by the edge function and passed in; it is never
  -- taken from the request.
  if p_company is null or v_payout.company_entity_id is distinct from p_company then
    raise exception 'affiliate_payout_send_claim: that payout belongs to another company'
      using errcode = '42501';
  end if;

  if v_payout.method <> 'paypal_payouts' then
    raise exception 'affiliate_payout_send_claim: payout method is %, not paypal_payouts', v_payout.method
      using errcode = '0A000';
  end if;
  if v_payout.status not in ('approved','exported') then
    raise exception 'affiliate_payout_send_claim: a payout is sent only once it is approved (this one is %)', v_payout.status
      using errcode = '42501';
  end if;

  -- One program's money at a time, the same lock accrual and approval take, so
  -- a refund cannot be accrued into this payout while it is being sent.
  perform public.affiliate_lock_program_money(v_payout.program_id);

  -- Re-read inside the lock: approval or a void may have landed between the
  -- read above and the lock being granted.
  select * into v_payout from public.affiliate_payouts where id = p_payout;
  if v_payout.status not in ('approved','exported') then
    raise exception 'affiliate_payout_send_claim: payout is now % -- reload', v_payout.status
      using errcode = '42501';
  end if;

  select state into v_open
    from public.affiliate_payout_sends
   where payout_id = p_payout
     and state in ('unknown','sent','unclaimed','paid')
   order by attempt desc
   limit 1;
  if v_open is not null then
    if v_open = 'unknown' then
      raise exception 'affiliate_payout_send_claim: an earlier attempt never reported an answer. Check it against the provider before sending again -- it may already have been accepted.'
        using errcode = '55006';
    end if;
    raise exception 'affiliate_payout_send_claim: this payout already has an attempt in state %', v_open
      using errcode = '55006';
  end if;

  select payout_email into v_email
    from public.affiliate_payout_accounts
   where company_entity_id = v_payout.company_entity_id
     and affiliate_id = v_payout.affiliate_id
     and provider = 'paypal';
  if btrim(coalesce(v_email, '')) = '' then
    raise exception 'affiliate_payout_send_claim: this affiliate has not given a PayPal address yet'
      using errcode = '22023';
  end if;

  select coalesce(max(attempt), 0) + 1 into v_attempt
    from public.affiliate_payout_sends where payout_id = p_payout;

  -- Deterministic, so the SAME attempt replayed is the same request to PayPal.
  v_request := 'silo-' || replace(p_payout::text, '-', '') || '-' || v_attempt::text;

  insert into public.affiliate_payout_sends (
    company_entity_id, payout_id, provider, environment, attempt,
    request_id, sender_batch_id, amount_cents, currency, payout_email,
    state, created_by
  ) values (
    v_payout.company_entity_id, p_payout, 'paypal', p_environment, v_attempt,
    v_request, v_request, v_payout.amount_cents, v_payout.currency, v_email,
    'unknown', p_actor
  ) returning id into v_send;

  return jsonb_build_object(
    'send_id', v_send,
    'request_id', v_request,
    'sender_batch_id', v_request,
    'attempt', v_attempt,
    'amount_cents', v_payout.amount_cents,
    'currency', v_payout.currency,
    'payout_email', v_email,
    'company_entity_id', v_payout.company_entity_id
  );
end;
$$;

comment on function public.affiliate_payout_send_claim(uuid, uuid, text, uuid) is
  'Reserves the next attempt at sending an approved payout and returns the deterministic request id to call the provider with. Refuses a payout belonging to another company (this runs as the service role, so RLS is not the boundary and p_company is), a payout that is not approved, a method that is not paypal_payouts, an affiliate with no PayPal address, and -- the point -- a payout that already has an attempt in flight, succeeded, or in state unknown. Service role only: the authority to cause a payment is checked by the edge function against the caller.';

revoke execute on function public.affiliate_payout_send_claim(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.affiliate_payout_send_claim(uuid, uuid, text, uuid) to service_role;

-- ── 6. Recording what the provider answered ────────────────────────────────
create or replace function public.affiliate_payout_send_record(
  p_send uuid,
  p_state text,
  p_provider_batch_id text default null,
  p_provider_item_id text default null,
  p_provider_status text default null,
  p_error_code text default null,
  p_error_message text default null,
  p_fee_cents bigint default null,
  p_actor uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_send   public.affiliate_payout_sends;
  v_payout public.affiliate_payouts;
  v_ref    text;
begin
  if p_state not in ('unknown','sent','unclaimed','paid','returned','refused') then
    raise exception 'affiliate_payout_send_record: unknown state %', p_state;
  end if;

  select * into v_send from public.affiliate_payout_sends where id = p_send;
  if not found then raise exception 'affiliate_payout_send_record: no such send'; end if;

  -- A terminal state is a fact, not a draft. Once PayPal has said an item
  -- succeeded, was refused or came back, a later poll must not quietly rewrite
  -- it -- that is how a paid payout becomes unpaid in the record.
  if v_send.state in ('paid','returned','refused') and p_state <> v_send.state then
    raise exception 'affiliate_payout_send_record: attempt is already % and cannot become %',
      v_send.state, p_state using errcode = '55006';
  end if;

  update public.affiliate_payout_sends
     set state             = p_state,
         provider_batch_id = coalesce(p_provider_batch_id, provider_batch_id),
         provider_item_id  = coalesce(p_provider_item_id, provider_item_id),
         provider_status   = coalesce(p_provider_status, provider_status),
         error_code        = p_error_code,
         error_message     = p_error_message,
         fee_cents         = coalesce(p_fee_cents, fee_cents),
         sent_at           = case when p_state in ('sent','unclaimed','paid') and sent_at is null
                                  then now() else sent_at end,
         settled_at        = case when p_state in ('paid','returned','refused') then now() else settled_at end,
         checked_at        = now(),
         updated_at        = now()
   where id = p_send;

  if p_state <> 'paid' then
    return;
  end if;

  -- THE ONLY PATH THAT MARKS AN AFFILIATE PAYOUT PAID WITHOUT A PERSON SAYING
  -- SO. It exists because here SILO did make the payment and PayPal confirmed
  -- it, which is precisely the thing affiliate_mark_payout_paid() refuses to
  -- take anybody's word for. The evidence is the provider's own ids.
  select * into v_payout from public.affiliate_payouts where id = v_send.payout_id;
  if v_payout.status = 'marked_paid' then
    return;
  end if;
  if v_payout.status not in ('approved','exported') then
    raise exception 'affiliate_payout_send_record: payout is % and cannot be recorded as paid', v_payout.status
      using errcode = '55006';
  end if;

  v_ref := coalesce(p_provider_item_id, v_send.provider_item_id, v_send.request_id);

  update public.affiliate_payouts
     set status             = 'marked_paid',
         marked_paid_by     = coalesce(p_actor, v_send.created_by, marked_paid_by, approved_by),
         marked_paid_at     = now(),
         external_reference = v_ref,
         paid_evidence      = format(
           'PayPal Payouts (%s): item %s in batch %s, sender_batch_id %s, confirmed by the provider.',
           v_send.environment, v_ref,
           coalesce(p_provider_batch_id, v_send.provider_batch_id, '-'),
           v_send.sender_batch_id)
   where id = v_send.payout_id;
end;
$$;

comment on function public.affiliate_payout_send_record(uuid, text, text, text, text, text, text, bigint, uuid) is
  'Records what the provider answered for one send attempt, and -- only on state paid -- marks the payout paid with the provider''s own ids as the evidence. This is the one path that records an affiliate payout as paid without a person asserting it, and it is sound exactly because SILO made the payment and the provider confirmed it. A terminal state cannot be rewritten by a later poll. Service role only.';

revoke execute on function public.affiliate_payout_send_record(uuid, text, text, text, text, text, text, bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.affiliate_payout_send_record(uuid, text, text, text, text, text, text, bigint, uuid)
  to service_role;

-- ── 6b. Voiding a payout that is already with the provider ────────────────
-- A void releases the payout's ledger entries so the next build can claim
-- them. With a PayPal attempt in flight that is a second payment for the same
-- commission: void, rebuild, send, and the first one lands too. The money
-- rail is new, so this guard belongs to it rather than to the ledger
-- migration that wrote the function. Everything else about the function is
-- unchanged (20261110085000).
create or replace function public.affiliate_void_payout(p_payout uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid;
  v_open    text;
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

  -- An attempt that is with the provider, or that never answered, has to be
  -- settled before this payout can be let go of. The ONE exception is an
  -- attempt that never answered and is older than the provider's 30-day
  -- duplicate window: nothing can reconcile it any more (asking again would
  -- be a fresh payment, not a replay), so a void with a reason is the only
  -- way out, and by then the person has had a month to see it in their
  -- provider activity. Both halves of that are deliberate: a FRESH unknown
  -- attempt must be checked, not voided.
  select state into v_open
    from public.affiliate_payout_sends
   where payout_id = p_payout
     and (state in ('sent','unclaimed')
          or (state = 'unknown' and created_at > now() - interval '30 days'))
   order by attempt desc
   limit 1;
  if v_open is not null then
    raise exception 'affiliate_void_payout: this payout has a provider attempt in state % -- check its status first, because voiding it would free the same commission to be paid a second time', v_open
      using errcode = '55006';
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

comment on function public.affiliate_void_payout(uuid, text) is
  'Voids a draft, approved or exported payout and releases its ledger entries. Refuses while a provider attempt is unknown, sent or unclaimed: freeing those entries would let the same commission be paid twice. A paid payout is corrected with a negative manual_adjustment, never a void.';

-- A `create or replace` keeps the existing grants, but say them anyway so the
-- function's authority does not depend on what ran before it.
revoke execute on function public.affiliate_void_payout(uuid, text) from public, anon;
grant execute on function public.affiliate_void_payout(uuid, text) to authenticated;

-- ── 7. The company stamp backstop, and the same-company twins ──────────────
-- affiliate_payout_sends.payout_id references affiliate_payouts, so it needs
-- the composite twin that makes it impossible for a send to name company A
-- and company B's payout. The function attaches it to every affiliate
-- reference that exists when it runs, so it has to run again HERE: it last
-- ran in 20261111181000, before this table existed, and the drift check fails
-- CRITICAL on a reference without its twin.
select public.attach_stamp_company_entity_id_triggers();
select public.attach_affiliate_same_company_twins();
