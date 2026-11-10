-- One rep, several brands: the portal's brand switcher.
--
-- WHY. Blake, 2026-11-10: "one creator multiple? Like repping STLHD +
-- Baseballism -- can we just drop down client list in the affiliate portal?"
--
-- A creator who reps two brands already has two affiliate records, one per
-- company, because a program belongs to a company and so does its ledger.
-- That is not changing: merging them would merge two companies' money.
-- What changes is the WAY IN. Sign-in by email (20261110170000) already mails
-- a link for EVERY record on that address, so the rep's inbox holds one link
-- per brand and switching means going back to the inbox. This adds the
-- switch to the page itself.
--
-- WHAT AUTHORIZES IT, AND WHY A PORTAL TOKEN IS NOT ENOUGH. The menu rests on
-- the holder controlling the mailbox: a sibling record carries the SAME
-- address on file, so handing them that session grants nothing they could not
-- already get by asking sign-in to mail them its own link.
--
-- But NOT every portal token reaches the mailbox. `affiliate-invite`'s staff
-- `portal_link` hands the raw portal URL to a manager (mailing it is
-- optional), and `affiliate-portal`'s `accept` returns one to whoever
-- finished a signup link -- which a manager can also hold. Both are scoped to
-- ONE company today. Treating either as mailbox proof would let a manager of
-- company A open a rep's session on company B and read B's earnings, payouts
-- and codes: a company's manager reading another company's ledger.
--
-- So the authorization is not the token's existence but HOW it was issued.
-- `mailed_only` marks a token whose raw value went ONLY to the address on
-- file and was never returned to its requester -- sign-in, renewal, and a
-- switch descending from such a session. A staff-issued or signup-accepted
-- token is not marked and gets no menu, so neither path widens beyond the one
-- company it already reaches. The address equality is then checked HERE, on
-- the stored addresses, normalized so casing or padding cannot widen it, and
-- never on anything the request says.
--
-- WHAT IT IS NOT. It is not a cross-company read: this function returns names
-- for a menu, nothing of either brand's data. The switched-to session is a
-- NEW token for that one affiliate, and every later read still goes through
-- affiliate_portal_resolve / _statement / _feed on that token alone. A rep
-- never holds one session that sees two brands.
--
-- Idempotent. Apply after 20261110180000, then deploy affiliate-portal.

-- ---------------------------------------------------------------------------
-- 1. Which tokens reached the mailbox
-- ---------------------------------------------------------------------------

-- FALSE for every token that exists today, which is the safe default: a token
-- is mailbox proof only once a path that mails it says so.
alter table public.affiliate_access_tokens
  add column if not exists mailed_only boolean not null default false;

comment on column public.affiliate_access_tokens.mailed_only is
  'TRUE when this token''s raw value went only to the address on the affiliate record and was never returned to whoever asked for it: sign-in, renewal, and a brand switch descending from such a session. FALSE for a staff-issued portal link and for the one returned by signup acceptance, which their requester holds. Only a mailed_only token may list or switch to another brand (affiliate_portal_brands). 20261110190000.';

-- Mints a portal token through affiliate_issue_access_token (so the "one live
-- link per subject" revoke and every ownership check still apply) and marks
-- it as having gone to the address on file. SEPARATE from that function on
-- purpose: its signature is referenced by two other migrations, its own
-- grants and verify, and a second overload of it would make the named-argument
-- calls from PostgREST ambiguous.
create or replace function public.affiliate_portal_issue_mailed_token(
  p_company_entity_id uuid,
  p_program_id uuid,
  p_affiliate_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
) returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_affiliate_id is null then
    raise exception 'affiliate_portal_issue_mailed_token: a mailed link belongs to an affiliate';
  end if;
  v_id := public.affiliate_issue_access_token(
    p_company_entity_id, p_program_id, 'portal', p_token_hash, p_expires_at,
    p_affiliate_id, null, null);
  update public.affiliate_access_tokens set mailed_only = true where id = v_id;
  return v_id;
end;
$$;

revoke all on function public.affiliate_portal_issue_mailed_token(uuid, uuid, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.affiliate_portal_issue_mailed_token(uuid, uuid, uuid, text, timestamptz) to service_role;

comment on function public.affiliate_portal_issue_mailed_token(uuid, uuid, uuid, text, timestamptz) is
  'A portal token whose raw value goes only to the address on file: mints through affiliate_issue_access_token, then marks mailed_only. Used by sign-in, renewal and the brand switch. Service role only. 20261110190000.';

-- ---------------------------------------------------------------------------
-- 2. The menu
-- ---------------------------------------------------------------------------

-- A rep with the same address on several programs of ONE company would see
-- that company twice; the menu is per affiliate record, which is what the
-- ledger is keyed by, so that is correct rather than a duplicate.
drop function if exists public.affiliate_portal_brands(text);
create or replace function public.affiliate_portal_brands(p_token_hash text)
returns table (
  affiliate_id      uuid,
  company_entity_id uuid,
  program_id        uuid,
  company_title     text,
  program_name      text,
  display_name      text,
  contact_email     text,
  is_current        boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (
    -- A SIGNUP token is deliberately excluded: someone part-way through
    -- accepting one brand's terms has no session to switch out of.
    select a.id as affiliate_id, lower(btrim(a.contact_email)) as email
      from public.affiliate_access_tokens t
      join public.affiliates a
        on a.id = t.affiliate_id
       and a.company_entity_id = t.company_entity_id
       and a.program_id = t.program_id
     where t.token_hash = p_token_hash
       and t.purpose = 'portal'
       -- The whole authorization: this session reached the mailbox. A
       -- staff-issued or signup-accepted token stops here.
       and t.mailed_only
       and t.revoked_at is null
       and t.expires_at > now()
       and a.status in ('active', 'paused')
  )
  select a.id, a.company_entity_id, a.program_id,
         e.title, p.name, a.display_name, a.contact_email,
         a.id = me.affiliate_id
    from me
    join public.affiliates a
      on lower(btrim(a.contact_email)) = me.email
     and a.status in ('active', 'paused')
    join public.entities e on e.id = a.company_entity_id
    join public.affiliate_programs p on p.id = a.program_id
   order by (a.id = me.affiliate_id) desc, e.title, p.name
   limit 10;
$$;

revoke all on function public.affiliate_portal_brands(text) from public, anon, authenticated;
grant execute on function public.affiliate_portal_brands(text) to service_role;

comment on function public.affiliate_portal_brands(text) is
  'Every active or paused affiliate record sharing the contact email on the record this PORTAL token belongs to, this token''s own record first: the brand menu in the portal. Only a mailed_only token gets one, because a staff-issued or signup-accepted portal token is held by its requester and would otherwise reach another company. Names only -- no brand data crosses, and switching mints a fresh token for the one record chosen. Service role only. 20261110190000.';
