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
-- WHAT AUTHORIZES IT. A portal token proves the holder received mail at the
-- address on that affiliate record. A sibling record carries the SAME address
-- on file -- it is where its own link would be mailed, by sign-in or by
-- renewal. So handing the holder a sibling's link grants nothing they could
-- not already get from their own inbox; it only saves the round trip. The
-- equality is checked HERE, on the stored addresses, never on anything the
-- request says, and the match is on the normalized address so that casing or
-- padding cannot widen it.
--
-- WHAT IT IS NOT. It is not a cross-company read: this function returns names
-- for a menu, nothing of either brand's data. The switched-to session is a
-- NEW token for that one affiliate, and every later read still goes through
-- affiliate_portal_resolve / _statement / _feed on that token alone. A rep
-- never holds one session that sees two brands.
--
-- Idempotent. Apply after 20261110180000, then deploy affiliate-portal.

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
  'Every active or paused affiliate record sharing the contact email on the record this PORTAL token belongs to, newest session first: the brand menu in the portal. Names only -- no brand data crosses, and switching mints a fresh token for the one record chosen. Service role only. 20261110190000.';
