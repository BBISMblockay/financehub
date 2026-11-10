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
-- So the authorization is not the token's existence but HOW it was issued,
-- AND TO WHOM. `mailed_to_hash` is set only where the raw token went solely
-- to the address on file and was never returned to its requester -- sign-in,
-- renewal, and a switch descending from such a session. It holds the SHA-256
-- of that recipient, normalized, never the address itself (the sign-in
-- throttle keeps addresses the same way).
--
-- Recording only THAT a token was mailed is not enough, because contact_email
-- is writable by any manager of its own company (affiliates_write). A manager
-- could take a genuinely mailed link for an affiliate whose address they
-- control and, AFTERWARDS, edit that affiliate's address to a victim's --
-- the old token would then follow the field into the victim's other company.
-- So the recipient is bound to the token at mint time, the sibling match is
-- made on that bound recipient rather than on today's field, and a token
-- whose affiliate no longer carries the address it was mailed to FAILS
-- CLOSED. A staff-issued or signup-accepted token is never bound at all and
-- gets no menu, so neither path widens beyond the one company it reaches now.
--
-- WHAT IT IS NOT. It is not a cross-company read: this function returns names
-- for a menu, nothing of either brand's data. The switched-to session is a
-- NEW token for that one affiliate, and every later read still goes through
-- affiliate_portal_resolve / _statement / _feed on that token alone. A rep
-- never holds one session that sees two brands.
--
-- Idempotent. Apply after 20261110180000, then deploy affiliate-portal.

-- ---------------------------------------------------------------------------
-- 1. Which address a token was mailed to
-- ---------------------------------------------------------------------------

-- An earlier draft of THIS migration carried a boolean. It recorded that a
-- token was mailed but not to whom, which a later edit of contact_email could
-- walk into another company. Dropped rather than kept beside its replacement.
alter table public.affiliate_access_tokens drop column if exists mailed_only;

-- NULL for every token that exists today, and for every path that hands its
-- raw token back to whoever asked: the safe default is "not mailbox proof".
alter table public.affiliate_access_tokens
  add column if not exists mailed_to_hash text;

comment on column public.affiliate_access_tokens.mailed_to_hash is
  'SHA-256 (hex) of the normalized address this token''s raw value was mailed to, and nowhere else: sign-in, renewal, and a brand switch descending from such a session. NULL for a staff-issued portal link and for the one signup acceptance returns, which their requester holds. Only a token with this set, still matching its affiliate''s current address, may list or switch to another brand -- the address is bound here because contact_email is writable by a manager of its own company. The address itself is never stored. 20261110190000.';

-- One spelling of "the same address", used by every comparison below, so a
-- token, its affiliate and a sibling can never be normalized differently.
create or replace function public.affiliate_contact_key(p_email text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when btrim(coalesce(p_email, '')) = '' then null
    else encode(sha256(convert_to(lower(btrim(p_email)), 'UTF8')), 'hex')
  end;
$$;

comment on function public.affiliate_contact_key(text) is
  'SHA-256 (hex) of a contact address, lowercased and trimmed; NULL for a blank one. The one spelling of affiliate address identity: used to bind a mailed portal token to its recipient and to match an affiliate to its records at other companies. 20261110190000.';

-- Mints a portal token through affiliate_issue_access_token (so the "one live
-- link per subject" revoke and every ownership check still apply) and binds it
-- to the address the caller is about to mail it to. SEPARATE from that
-- function on purpose: its signature is referenced by two other migrations,
-- its own grants and verify, and a second overload of it would make the
-- named-argument calls from PostgREST ambiguous.
--
-- p_mailed_to is the recipient the caller will actually use, and it must
-- still be the affiliate's address: that way an edit racing the mint aborts
-- the mint instead of binding a token to an address the mail did not go to.
create or replace function public.affiliate_portal_issue_mailed_token(
  p_company_entity_id uuid,
  p_program_id uuid,
  p_affiliate_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_mailed_to text
) returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_id  uuid;
  v_key text := public.affiliate_contact_key(p_mailed_to);
begin
  if p_affiliate_id is null then
    raise exception 'affiliate_portal_issue_mailed_token: a mailed link belongs to an affiliate';
  end if;
  if v_key is null then
    raise exception 'affiliate_portal_issue_mailed_token: a mailed link needs the address it is going to';
  end if;
  if not exists (
    select 1 from public.affiliates a
     where a.id = p_affiliate_id
       and a.company_entity_id = p_company_entity_id
       and public.affiliate_contact_key(a.contact_email) = v_key
  ) then
    raise exception 'affiliate_portal_issue_mailed_token: that is not the address on this affiliate'
      using errcode = '42501';
  end if;

  v_id := public.affiliate_issue_access_token(
    p_company_entity_id, p_program_id, 'portal', p_token_hash, p_expires_at,
    p_affiliate_id, null, null);
  update public.affiliate_access_tokens set mailed_to_hash = v_key where id = v_id;
  return v_id;
end;
$$;

revoke all on function public.affiliate_portal_issue_mailed_token(uuid, uuid, uuid, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.affiliate_portal_issue_mailed_token(uuid, uuid, uuid, text, timestamptz, text) to service_role;

comment on function public.affiliate_portal_issue_mailed_token(uuid, uuid, uuid, text, timestamptz, text) is
  'A portal token whose raw value goes only to the address on file, bound to that recipient: mints through affiliate_issue_access_token, then records affiliate_contact_key(p_mailed_to). Refuses unless that is still the affiliate''s own address, so an edit racing the mint aborts it. Used by sign-in, renewal and the brand switch. Service role only. 20261110190000.';

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
  is_current        boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (
    -- Three conditions, and all of them are the authorization:
    --   * a PORTAL token (a signup token is part-way through accepting ONE
    --     brand, so there is no session to switch out of);
    --   * bound to a recipient, which only the mailed paths set;
    --   * and that recipient is STILL this affiliate's address, so an edit
    --     after the mail cannot walk the token into another company.
    select a.id as affiliate_id, t.mailed_to_hash as key
      from public.affiliate_access_tokens t
      join public.affiliates a
        on a.id = t.affiliate_id
       and a.company_entity_id = t.company_entity_id
       and a.program_id = t.program_id
     where t.token_hash = p_token_hash
       and t.purpose = 'portal'
       and t.mailed_to_hash is not null
       and t.revoked_at is null
       and t.expires_at > now()
       and a.status in ('active', 'paused')
       and public.affiliate_contact_key(a.contact_email) = t.mailed_to_hash
  )
  select a.id, a.company_entity_id, a.program_id,
         e.title, p.name, a.display_name,
         a.id = me.affiliate_id
    from me
    join public.affiliates a
      on public.affiliate_contact_key(a.contact_email) = me.key
     and a.status in ('active', 'paused')
    join public.entities e on e.id = a.company_entity_id
    join public.affiliate_programs p on p.id = a.program_id
   order by (a.id = me.affiliate_id) desc, e.title, p.name
   limit 10;
$$;

revoke all on function public.affiliate_portal_brands(text) from public, anon, authenticated;
grant execute on function public.affiliate_portal_brands(text) to service_role;

comment on function public.affiliate_portal_brands(text) is
  'Every active or paused affiliate record carrying the address this PORTAL token was mailed to, the token''s own record first: the brand menu in the portal. Answers only for a token bound to a recipient (sign-in, renewal, a switch) whose affiliate still carries that address, because a staff-issued or signup-accepted token is held by its requester and contact_email is writable by a manager. Names only -- no brand data crosses. Service role only. 20261110190000.';

-- ---------------------------------------------------------------------------
-- 3. The switch
-- ---------------------------------------------------------------------------

-- The whole switch in one statement, so nothing outside the database decides
-- which record a session may move to: the source token must be bound and
-- still match, the target must carry the SAME bound address, and the new
-- token inherits that binding (the same person is switching inside a session
-- that already reached the mailbox, so a second switch must work too).
create or replace function public.affiliate_portal_switch_token(
  p_token_hash     text,
  p_affiliate_id   uuid,
  p_new_token_hash text,
  p_expires_at     timestamptz
) returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_src record;
  v_dst record;
  v_id  uuid;
begin
  select t.mailed_to_hash as key, a.id as affiliate_id
    into v_src
    from public.affiliate_access_tokens t
    join public.affiliates a
      on a.id = t.affiliate_id
     and a.company_entity_id = t.company_entity_id
     and a.program_id = t.program_id
   where t.token_hash = p_token_hash
     and t.purpose = 'portal'
     and t.mailed_to_hash is not null
     and t.revoked_at is null
     and t.expires_at > now()
     and a.status in ('active', 'paused')
     and public.affiliate_contact_key(a.contact_email) = t.mailed_to_hash;
  if not found then
    raise exception 'affiliate_portal_switch_token: this link cannot switch brands'
      using errcode = '42501';
  end if;

  select a.id, a.company_entity_id, a.program_id
    into v_dst
    from public.affiliates a
   where a.id = p_affiliate_id
     and a.id <> v_src.affiliate_id
     and a.status in ('active', 'paused')
     and public.affiliate_contact_key(a.contact_email) = v_src.key;
  -- Deliberately the same refusal as above: the menu is the only way to learn
  -- which records exist on an address.
  if not found then
    raise exception 'affiliate_portal_switch_token: that brand is not on this account'
      using errcode = '42501';
  end if;

  v_id := public.affiliate_issue_access_token(
    v_dst.company_entity_id, v_dst.program_id, 'portal', p_new_token_hash, p_expires_at,
    v_dst.id, null, null);
  update public.affiliate_access_tokens set mailed_to_hash = v_src.key where id = v_id;
  return v_id;
end;
$$;

revoke all on function public.affiliate_portal_switch_token(text, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.affiliate_portal_switch_token(text, uuid, text, timestamptz) to service_role;

comment on function public.affiliate_portal_switch_token(text, uuid, text, timestamptz) is
  'Moves a portal session to another brand on the same address: refuses unless the source token is bound to a recipient its affiliate still carries, and the target affiliate carries that same address. Mints the new token through affiliate_issue_access_token and binds it to the same recipient. The refusals are identical so the menu stays the only way to learn what exists on an address. Service role only. 20261110190000.';
