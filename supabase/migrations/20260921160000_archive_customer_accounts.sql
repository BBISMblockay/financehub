-- Archiving a customer application.
--
-- The open form made this necessary: DELETE is revoked outright on
-- customer_accounts and there is no delete policy, which was right while every
-- row came from an invite somebody at the company had chosen to send. Once
-- anyone with a link can submit, the register accumulates rows nobody wants
-- and there is no way to clear them from the app.
--
-- Archiving rather than deleting, because the rows were created by strangers:
-- if something is ever wrong about one, the evidence should still exist.
--
-- A TIMESTAMP, not a status. `status` records what the APPLICATION is
-- (invited/submitted/approved/rejected/inactive) and archiving is orthogonal
-- to that -- archiving a submitted application must not erase that it was
-- submitted, and an approved customer who is later archived is still an
-- approved customer. Reusing `inactive` would have needed no migration and
-- would have conflated "a former customer" with "junk from the public form".

alter table public.customer_accounts
  add column if not exists archived_at timestamptz;
alter table public.customer_accounts
  add column if not exists archived_by uuid references auth.users(id) on delete set null;

comment on column public.customer_accounts.archived_at is
  'When this application was archived: hidden from the register by default, still readable and still holding its own status. Orthogonal to `status` on purpose -- archiving a submitted application does not erase that it was submitted. Null means not archived.';

create index if not exists customer_accounts_live_idx
  on public.customer_accounts (company_entity_id, status)
  where archived_at is null;

create or replace function public.set_customer_account_archived(
  p_account_id uuid,
  p_archived   boolean
)
returns json
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_account public.customer_accounts%rowtype;
begin
  -- The same gate as approve and reject: triaging the register is the work of
  -- whoever reviews it, not a separate authority.
  if not public.can_manage_client_invoices() then
    raise exception 'not authorized';
  end if;

  select * into v_account from public.customer_accounts
   where id = p_account_id and company_entity_id = public.active_company_id();
  if v_account.id is null then raise exception 'customer account not found'; end if;

  update public.customer_accounts
     set archived_at = case when p_archived then now() else null end,
         archived_by = case when p_archived then auth.uid() else null end
   where id = p_account_id;

  -- A live application link on an archived row is a loose end: somebody could
  -- still complete a form for a record nobody is watching. Unarchiving does
  -- NOT bring the links back -- a fresh invite is one click and a resurrected
  -- token is a surprise.
  if p_archived then
    update public.customer_account_invites
       set status = 'revoked'
     where customer_account_id = p_account_id and status = 'pending';
  end if;

  insert into public.customer_account_activity
    (company_entity_id, customer_account_id, event, detail, actor)
  values (v_account.company_entity_id, v_account.id,
          case when p_archived then 'archived' else 'unarchived' end,
          v_account.legal_name, auth.uid());

  return json_build_object('ok', true, 'archived', p_archived);
end;
$fn$;

revoke all on function public.set_customer_account_archived(uuid, boolean) from public;
revoke all on function public.set_customer_account_archived(uuid, boolean) from anon;
grant execute on function public.set_customer_account_archived(uuid, boolean) to authenticated;

-- The directory view has to be rebuilt to carry the new columns: it selects
-- ca.*, which expands at creation time, and create-or-replace may only append
-- to a view's column list. Same reason 20260921120000 had to drop it.
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
  (ca.archived_at is not null)                as is_archived,
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

-- An open submission must not resurrect an archived application by colliding
-- with it. The duplicate check in open_customer_application looks at live
-- statuses only, so an archived row with status 'submitted' would block a
-- genuine re-application forever with "we already have your application".
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
as $fn$
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

  v_type := lower(btrim(coalesce(nullif(p_account_type, ''), 'wholesale')));
  if v_type not in ('wholesale','retail','distributor','licensee','other') then
    raise exception 'open_bad_type' using errcode = '28000';
  end if;

  -- `archived_at is null` is the addition: an archived application is not a
  -- live one, so it does not stand in the way of a new submission.
  if exists (
    select 1 from public.customer_accounts
     where company_entity_id = v_company
       and lower(contact_email) = v_email
       and status in ('invited','submitted','approved')
       and archived_at is null
  ) then
    raise exception 'open_duplicate' using errcode = '28000';
  end if;

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
$fn$;

revoke all on function public.open_customer_application(text, text, text, jsonb) from public;
revoke all on function public.open_customer_application(text, text, text, jsonb) from anon;

-- Two more places treat "live" as a matter of status alone, and an archived
-- row would go on blocking the address forever in both.

-- The partial unique index: an archived 'submitted' row still occupies the
-- slot, so a genuine re-application or a re-invite would fail on a constraint
-- rather than being allowed.
drop index if exists public.customer_accounts_live_email_uidx;
create unique index if not exists customer_accounts_live_email_uidx
  on public.customer_accounts (company_entity_id, lower(contact_email))
  where status in ('invited','submitted','approved') and archived_at is null;

-- And the invite RPC's own resume-or-create lookup, which would otherwise
-- RESUME an archived application when somebody re-invites that address --
-- quietly un-hiding the row rather than starting fresh.
create or replace function public.create_customer_account_invite(
  p_email        text,
  p_legal_name   text default null,
  p_account_type text default 'wholesale'
)
returns json
language plpgsql
security definer
set search_path to 'public'
as $fn$
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
  -- than founding a second one. An ARCHIVED account is not live: re-inviting
  -- that address starts a new application and leaves the archived one alone.
  select * into v_account
    from public.customer_accounts
   where company_entity_id = v_company
     and lower(contact_email) = v_email
     and status in ('invited','submitted','approved')
     and archived_at is null;

  if v_account.id is null then
    insert into public.customer_accounts
      (company_entity_id, account_type, status, legal_name, contact_email, created_by)
    values (v_company, v_type, 'invited', nullif(btrim(coalesce(p_legal_name,'')),''),
            v_email, auth.uid())
    returning * into v_account;
  elsif v_account.status = 'approved' then
    raise exception 'that customer is already approved';
  end if;

  update public.customer_account_invites
     set status = 'revoked'
   where customer_account_id = v_account.id
     and purpose = 'onboarding'
     and status = 'pending';

  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.customer_account_invites
    (company_entity_id, customer_account_id, purpose, email, token_hash, expires_at, created_by)
  values (v_company, v_account.id, 'onboarding', v_email,
          encode(extensions.digest(v_token, 'sha256'), 'hex'),
          now() + interval '14 days', auth.uid());

  insert into public.customer_account_activity
    (company_entity_id, customer_account_id, event, detail, actor)
  values (v_company, v_account.id, 'invited', v_email, auth.uid());

  -- The raw token is returned exactly once, here. `email` is carried too:
  -- the original returned it and dropping it would be a silent regression for
  -- any caller reading it.
  return json_build_object(
    'ok', true,
    'customer_account_id', v_account.id,
    'email', v_email,
    'token', v_token,
    'expires_at', now() + interval '14 days'
  );
end;
$fn$;
