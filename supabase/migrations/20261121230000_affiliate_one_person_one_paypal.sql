-- One creator across several programs: one payout address, one email.
-- 2026-11-21. Gap 3 of the three Blake asked to close, answered by his own
-- rule: "No one PayPal per affiliate" -- a creator has ONE payout address for
-- the company, not one per program.
--
-- A program membership IS an `affiliates` row, deliberately (Blake 2026-11-17,
-- 20261118010000): each row carries its own rate, and codes, the ledger,
-- payouts and the portal are all program-scoped through `affiliates.program_id`.
-- That stays. What was wrong is what belongs to the PERSON rather than to the
-- membership:
--
--   * `affiliate_payout_accounts` is keyed per affiliate row, and
--     `affiliate_add_to_program()` COPIED the PayPal address once at add time
--     with nothing keeping the copies in step afterwards. Two rows for one
--     person is two places to pay them from, and the day one is edited the
--     other program pays a stale address. Money, so this is the part that
--     matters.
--   * A creator's address is also their identity: `affiliate_portal_brands()`
--     and the portal token check both compare
--     `affiliate_contact_key(contact_email)` to the token's `mailed_to_hash`.
--     Editing one program row's email therefore split the person in two in the
--     brand switcher AND left their live portal link silently dead.
--
-- Both are fixed by triggers rather than by rewriting readers, for the same
-- reason the program scope guard is a trigger (20261121210000): several
-- deployed functions write these tables and have no source in this repository,
-- and the money path reads the stored row directly.
--
-- Measured on production before writing this: 10 people, 1 of them in more
-- than one program, 9 payout rows, and NOBODY yet holding two different
-- addresses -- so the backfill below converges nothing today, which is the
-- safe moment to make the rule true.

begin;

-- 1. One PayPal address per person per company.

create or replace function public.affiliate_payout_account_mirror()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text;
begin
  -- PayPal only. A Stripe Express account is per affiliate row by
  -- construction (it carries its own `stripe_account_id`, and
  -- `stripe_connect_status_v` reports on it), so copying an email onto a
  -- sibling's stripe row would describe an account that does not exist.
  if new.provider <> 'paypal' then
    return null;
  end if;
  if nullif(btrim(new.payout_email), '') is null then
    return null;
  end if;
  select public.affiliate_contact_key(a.contact_email) into v_key
    from public.affiliates a
   where a.id = new.affiliate_id
     and a.company_entity_id = new.company_entity_id;
  if v_key is null then
    return null;
  end if;
  -- Their other memberships in THIS company follow. A row is written where
  -- there was none, which is the point: a person who gave an address in one
  -- program is payable in the others without being asked again.
  insert into public.affiliate_payout_accounts (company_entity_id, affiliate_id, provider, payout_email)
  select new.company_entity_id, a.id, new.provider, new.payout_email
    from public.affiliates a
   where a.company_entity_id = new.company_entity_id
     and a.id <> new.affiliate_id
     and public.affiliate_contact_key(a.contact_email) = v_key
  on conflict (company_entity_id, affiliate_id, provider)
    do update set payout_email = excluded.payout_email
    -- No write where it already agrees, which is also what stops this
    -- recursing: the mirrored rows fire this trigger again, find nothing to
    -- change, and stop.
    where affiliate_payout_accounts.payout_email is distinct from excluded.payout_email;
  return null;
end;
$$;

comment on function public.affiliate_payout_account_mirror() is
  'One payout address per person per company: a PayPal address written for one membership follows the same person''s other memberships. (20261121230000)';

drop trigger if exists affiliate_payout_accounts_mirror on public.affiliate_payout_accounts;
create trigger affiliate_payout_accounts_mirror
  after insert or update of payout_email on public.affiliate_payout_accounts
  for each row execute function public.affiliate_payout_account_mirror();

-- Converge what is already stored onto the newest address each person gave.
-- Idempotent: a second run finds every row already agreeing and writes nothing.
with person as (
  select a.company_entity_id,
         public.affiliate_contact_key(a.contact_email) as k,
         (array_agg(nullif(btrim(pa.payout_email), '') order by pa.created_at desc))[1] as email
    from public.affiliates a
    join public.affiliate_payout_accounts pa
      on pa.affiliate_id = a.id
     and pa.company_entity_id = a.company_entity_id
     and pa.provider = 'paypal'
   where nullif(btrim(pa.payout_email), '') is not null
     and public.affiliate_contact_key(a.contact_email) is not null
   group by 1, 2
)
insert into public.affiliate_payout_accounts (company_entity_id, affiliate_id, provider, payout_email)
select a.company_entity_id, a.id, 'paypal', p.email
  from public.affiliates a
  join person p
    on p.company_entity_id = a.company_entity_id
   and p.k = public.affiliate_contact_key(a.contact_email)
 where p.email is not null
on conflict (company_entity_id, affiliate_id, provider)
  do update set payout_email = excluded.payout_email
  where affiliate_payout_accounts.payout_email is distinct from excluded.payout_email;

commit;

begin;

-- 2. A person's address is their identity, so an edit moves the whole person
--    and ends the link that was mailed to the old one.

create or replace function public.affiliate_person_email_follows()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old text := public.affiliate_contact_key(old.contact_email);
  v_new text := public.affiliate_contact_key(new.contact_email);
begin
  if v_old is null or v_new is null or v_old = v_new then
    return null;
  end if;
  -- A portal link is bound to the address it was mailed to, and
  -- affiliate_portal_brands() requires that address to STILL be this
  -- affiliate's, so the link stops working the moment the address changes.
  -- That check is deliberate -- it is what stops an edit after the mail from
  -- walking a token into another company -- so this does not loosen it. It
  -- records the revocation instead of leaving a link that silently fails, and
  -- the page then says to send a new one.
  update public.affiliate_access_tokens t
     set revoked_at = now()
   where t.company_entity_id = new.company_entity_id
     and t.mailed_to_hash = v_old
     and t.purpose = 'portal'
     and t.revoked_at is null;
  -- And their other memberships in this company follow the new address, or the
  -- brand switcher -- which finds them by that same key -- splits one person
  -- into two who each see half their brands. Terminates: the cascaded rows
  -- fire this trigger with the same old key and find nothing left under it.
  update public.affiliates a
     set contact_email = new.contact_email
   where a.company_entity_id = new.company_entity_id
     and a.id <> new.id
     and public.affiliate_contact_key(a.contact_email) = v_old;
  return null;
end;
$$;

comment on function public.affiliate_person_email_follows() is
  'A creator''s address is their identity: changing it on one membership moves their other memberships in the same company and revokes the portal links mailed to the old address, which could no longer work anyway. (20261121230000)';

drop trigger if exists affiliates_person_email_follows on public.affiliates;
create trigger affiliates_person_email_follows
  after update of contact_email on public.affiliates
  for each row execute function public.affiliate_person_email_follows();

commit;

begin;

-- 3. What the page needs to say which other programs a person is in, without
--    reading the whole company's creator list. SECURITY INVOKER, so RLS
--    answers: a manager given one program sees only the membership they were
--    given, which is the isolation, not an omission.

create or replace function public.affiliate_person_programs(p_affiliate uuid)
returns table (
  affiliate_id uuid,
  program_id uuid,
  program_name text,
  status text
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with me as (
    select a.company_entity_id, public.affiliate_contact_key(a.contact_email) as k
      from public.affiliates a
     where a.id = p_affiliate
  )
  select a.id, a.program_id, p.name, a.status
    from me
    join public.affiliates a
      on a.company_entity_id = me.company_entity_id
     and public.affiliate_contact_key(a.contact_email) = me.k
    join public.affiliate_programs p on p.id = a.program_id
   order by p.name
   limit 25;
$$;

comment on function public.affiliate_person_programs(uuid) is
  'Every program this one person is in, as far as the caller may see: SECURITY INVOKER, so RLS answers for both the affiliate rows and the programs. (20261121230000)';

revoke all on function public.affiliate_person_programs(uuid) from public, anon;
grant execute on function public.affiliate_person_programs(uuid) to authenticated;

commit;
