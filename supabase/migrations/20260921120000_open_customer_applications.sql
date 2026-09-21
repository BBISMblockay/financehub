-- Open (shareable) wholesale applications.
--
-- Until now the only way in was an emailed, email-bound, single-use invite
-- that created the customer_accounts row UP FRONT; the public page filled in
-- a row that already existed. This adds the other door: one URL per company
-- that anybody can open, where the SUBMISSION creates the account.
--
-- Three things make that safe enough to be worth having:
--
--   1. It is OFF by default, per company. A public write endpoint that every
--      tenant gets whether they asked or not is not a feature. Baseballism
--      turns it on; nobody else is exposed by this migration running.
--   2. The company is resolved from entities.entity_key, never from a body
--      field naming an id -- the same stance the rest of this feature takes.
--   3. One live application per email per company still holds, so the open
--      door cannot be used to flood the register with rows for one address.
--
-- What it deliberately does NOT add: bot protection, email verification, or
-- per-link management. Those are worth adding WHEN junk actually arrives; the
-- full business application is itself a large filter, and building the
-- defences first would have cost more than the thing being defended.

-- ── The per-company switch ──────────────────────────────────────────────────
alter table public.company_settings
  add column if not exists open_customer_applications boolean not null default false;

comment on column public.company_settings.open_customer_applications is
  'May anyone submit a wholesale application through the public link for this company? FALSE by default, and deliberately so: the open form is an unauthenticated endpoint that creates customer_accounts rows, so it exists only where somebody switched it on. Invite links work regardless of this flag.';

-- ── Which door an application came through ──────────────────────────────────
-- Finance triages an invited application and a stranger's differently, and
-- after the fact nothing else distinguishes them: created_by is null on an
-- open submission, but it is also null on anything a service role wrote.
alter table public.customer_accounts
  add column if not exists source text not null default 'invite';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'customer_accounts_source_known'
  ) then
    alter table public.customer_accounts
      add constraint customer_accounts_source_known
      check (source in ('invite','open_link'));
  end if;
end $$;

comment on column public.customer_accounts.source is
  'Which door this application came through: invite (an emailed, email-bound link somebody at the company minted) or open_link (the public shareable form). Never inferred from created_by, which is null for an open submission AND for anything written by a service role.';

-- ── One definition of what a submitted application writes ───────────────────
-- Both doors -- the emailed invite and the open link -- land here. A second
-- copy of these inserts would drift the moment either side gained a column,
-- and the drift would be invisible until a field silently stopped being
-- stored on one path. Same reasoning as card_coding_effective_lines.
create or replace function public.apply_customer_account_payload(
  p_account_id uuid,
  p_payload    jsonb
)
returns public.customer_accounts
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_account public.customer_accounts%rowtype;
  v_addr jsonb;
  v_contact jsonb;
begin
  update public.customer_accounts
     set legal_name = nullif(btrim(coalesce(p_payload->>'legal_name', '')), ''),
         dba_name   = nullif(btrim(coalesce(p_payload->>'dba_name', '')), ''),
         website    = nullif(btrim(coalesce(p_payload->>'website', '')), ''),
         requested_payment_terms =
           nullif(btrim(coalesce(p_payload->>'requested_payment_terms', '')), ''),
         applicant_notes = nullif(btrim(coalesce(p_payload->>'applicant_notes', '')), ''),
         status = 'submitted',
         submitted_at = now()
   where id = p_account_id
  returning * into v_account;

  if v_account.id is null then
    raise exception 'customer account % not found', p_account_id;
  end if;

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

  return v_account;
end;
$$;

-- Internal: called only by the two submission RPCs, which are themselves
-- SECURITY DEFINER. Supabase grants EXECUTE on new public functions to anon
-- and authenticated by default, so the revoke is the boundary -- without it
-- any logged-in user could rewrite any account's addresses by id.
revoke all on function public.apply_customer_account_payload(uuid, jsonb) from public;
revoke all on function public.apply_customer_account_payload(uuid, jsonb) from anon;
revoke all on function public.apply_customer_account_payload(uuid, jsonb) from authenticated;

-- ── One definition of issuing the card-setup continuation ───────────────────
create or replace function public.issue_customer_card_setup_token(
  p_account public.customer_accounts
)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_continuation text;
begin
  -- One live continuation at a time, so a resubmission cannot leave two card
  -- links working.
  update public.customer_account_invites
     set status = 'revoked'
   where customer_account_id = p_account.id
     and purpose = 'card_setup'
     and status = 'pending';

  v_continuation := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.customer_account_invites
    (company_entity_id, customer_account_id, purpose, email, token_hash, expires_at)
  values (p_account.company_entity_id, p_account.id, 'card_setup', p_account.contact_email,
          encode(extensions.digest(v_continuation, 'sha256'), 'hex'),
          now() + interval '2 hours');

  return v_continuation;
end;
$$;

revoke all on function public.issue_customer_card_setup_token(public.customer_accounts) from public;
revoke all on function public.issue_customer_card_setup_token(public.customer_accounts) from anon;
revoke all on function public.issue_customer_card_setup_token(public.customer_accounts) from authenticated;

-- ── The invited door, now built from the shared pieces ──────────────────────
-- Same signature, same behaviour, same errors. The ~90 lines of inserts and
-- the continuation mint moved out; what stays here is what is SPECIFIC to an
-- invited application: the token, and the rule that an approved or rejected
-- account cannot be reopened by a late replay.
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

  v_account := public.apply_customer_account_payload(v_account.id, p_payload);

  -- Consume the onboarding token.
  update public.customer_account_invites
     set status = 'consumed', consumed_at = now()
   where id = v_tok.invite_id;

  v_continuation := public.issue_customer_card_setup_token(v_account);

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

-- ── The open door ───────────────────────────────────────────────────────────

-- What the public page needs before anything is typed: does this link work,
-- and whose name goes at the top. Returns NO ROW for a company that has not
-- switched the form on, so a disabled link and an unknown one are the same
-- answer -- a probe cannot enumerate which tenants exist.
create or replace function public.peek_open_customer_application(p_company_key text)
returns table (company_entity_id uuid, company_title text)
language sql
stable
security definer
set search_path to 'public'
as $$
  select e.id, e.title
    from public.entities e
    join public.company_settings cs on cs.company_entity_id = e.id
   where e.entity_type = 'company'
     and lower(e.entity_key) = lower(btrim(coalesce(p_company_key, '')))
     and cs.open_customer_applications
   limit 1;
$$;

-- The submission itself. Nothing in the payload names a company or an
-- account: the company comes from the key in the URL and the switch above,
-- and the account is CREATED here, which is the whole difference from the
-- invited path.
create or replace function public.open_customer_application(
  p_company_key  text,
  p_account_type text,
  p_email        text,
  p_payload      jsonb
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
  v_continuation text;
begin
  select company_entity_id into v_company
    from public.peek_open_customer_application(p_company_key);
  if v_company is null then
    raise exception 'open_unavailable' using errcode = '28000';
  end if;

  v_email := lower(btrim(coalesce(p_email, '')));
  if v_email = '' or position('@' in v_email) = 0 then
    raise exception 'open_bad_email' using errcode = '28000';
  end if;

  -- The applicant picks, so the value is checked here rather than trusted.
  v_type := lower(btrim(coalesce(nullif(p_account_type, ''), 'wholesale')));
  if v_type not in ('wholesale','retail','distributor','licensee','other') then
    raise exception 'open_bad_type' using errcode = '28000';
  end if;

  -- One live application per address per company, exactly as the invite path
  -- enforces. Raised as its own reason so the page can say "we already have
  -- your application" rather than showing a constraint violation.
  if exists (
    select 1 from public.customer_accounts
     where company_entity_id = v_company
       and lower(contact_email) = v_email
       and status in ('invited','submitted','approved')
  ) then
    raise exception 'open_duplicate' using errcode = '28000';
  end if;

  -- created_by is NULL on purpose: nobody at the company created this row.
  -- The stamp_created_by trigger leaves auth.uid() null for an anonymous
  -- caller, and that null is the honest record of where it came from.
  insert into public.customer_accounts
    (company_entity_id, account_type, status, contact_email, source)
  values (v_company, v_type, 'invited', v_email, 'open_link')
  returning * into v_account;

  v_account := public.apply_customer_account_payload(v_account.id, p_payload);
  v_continuation := public.issue_customer_card_setup_token(v_account);

  insert into public.customer_account_activity
    (company_entity_id, customer_account_id, event, detail)
  values (v_account.company_entity_id, v_account.id, 'submitted',
          coalesce(v_account.legal_name, v_email));

  return json_build_object(
    'ok', true,
    'customer_account_id', v_account.id,
    'continuation_token', v_continuation,
    'expires_at', now() + interval '2 hours'
  );
end;
$$;

-- Called by the edge function under the service role. Revoked from the
-- browser roles: the public page reaches these THROUGH the function, which is
-- where the company key is turned into a company.
revoke all on function public.peek_open_customer_application(text) from public;
revoke all on function public.peek_open_customer_application(text) from anon;
revoke all on function public.peek_open_customer_application(text) from authenticated;
revoke all on function public.open_customer_application(text, text, text, jsonb) from public;
revoke all on function public.open_customer_application(text, text, text, jsonb) from anon;
revoke all on function public.open_customer_application(text, text, text, jsonb) from authenticated;

-- ── The directory view has to be rebuilt to see the new column ──────────────
-- It selects ca.*, which expands to a fixed column list AT CREATION TIME, so
-- a view created before `source` existed does not carry it however many times
-- it is replaced. CREATE OR REPLACE cannot fix that either: the new column
-- lands in the middle of the list, and replacing a view may only append.
-- Nothing in SQL depends on this view (checked: only the Customers page and a
-- column test read it), so a drop is safe here and a cascade is not needed.
drop view if exists public.customer_accounts_v;

create view public.customer_accounts_v as
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
grant select on public.customer_accounts_v to authenticated;
