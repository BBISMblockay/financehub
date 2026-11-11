-- Follow-up outreach to the same person works.
--
-- WHY. Blake, 2026-11-10: a second approved message to someone already
-- emailed was skipped by claim_outreach_to_send with a raw
-- 'duplicate key value violates unique constraint "affiliates_identity"'.
-- The signup minter looked for the affiliate record only by the prospect row
-- the draft came from; the follow-up was written against a second prospect
-- row with the same email, so it tried to create a second affiliate record
-- for an email the program already had. Blake: "may want to ping them more
-- than once".
--
-- WHAT CHANGES. affiliate_outreach_mint_signup() falls back to the program's
-- record for the same email. An invited or pending one is reused (fresh
-- link, the older one revoked by affiliate_issue_access_token, as before). An
-- invite a person ENDED is reopened to invited. An active or paused
-- affiliate is skipped as already_affiliate, and someone who joined and was
-- then ended is skipped as ended_affiliate -- both with a readable reason
-- instead of a constraint name. affiliate-invite's signup_link (the export
-- path) does the same in the edge function.
--
-- Re-stated from 20261110093000 (live, per the drift check); only the
-- affiliate lookup changes.

create or replace function public.affiliate_outreach_mint_signup(
  p_company uuid,
  p_program uuid,
  p_prospect uuid,
  p_email text,
  p_actor uuid)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_p       public.affiliate_prospects;
  v_aff     uuid;
  v_status  text;
  v_accepted timestamptz;
  v_raw     text;
  v_token   uuid;
  v_expires timestamptz := now() + interval '14 days';
begin
  select * into v_p from public.affiliate_prospects x
   where x.id = p_prospect and x.company_entity_id = p_company and x.program_id = p_program;
  if v_p.id is null then
    raise exception 'unknown_prospect';
  end if;
  if v_p.status not in ('approved', 'invited') then
    raise exception 'prospect_not_approved: the prospect is %', v_p.status;
  end if;

  -- The affiliate record is this prospect's, or -- for a follow-up written
  -- against another prospect row -- the one this program already holds for
  -- the same email (affiliates_identity allows one per email per program).
  select a.id, a.status, a.terms_accepted_at into v_aff, v_status, v_accepted
    from public.affiliates a
   where a.company_entity_id = p_company and a.from_prospect_id = v_p.id
   limit 1;
  if v_aff is null then
    select a.id, a.status, a.terms_accepted_at into v_aff, v_status, v_accepted
      from public.affiliates a
     where a.company_entity_id = p_company and a.program_id = p_program
       and lower(btrim(a.contact_email)) = lower(btrim(p_email))
     limit 1;
  end if;
  if v_status in ('active', 'paused') then
    raise exception 'already_affiliate: this person is already an affiliate of this program';
  end if;
  -- An invite someone ended is reopened by a new approved message; an
  -- affiliate who joined and was then ended is not.
  if v_status = 'terminated' then
    if v_accepted is not null then
      raise exception 'ended_affiliate: this person was an affiliate of this program and was ended';
    end if;
    update public.affiliates set status = 'invited', updated_at = now(), changed_by = p_actor
     where id = v_aff and company_entity_id = p_company;
    v_status := 'invited';
  end if;
  if v_aff is null then
    insert into public.affiliates
      (company_entity_id, program_id, display_name, contact_email, platform, handle,
       profile_url, status, from_prospect_id, created_by)
    values
      (p_company, p_program, coalesce(nullif(btrim(v_p.display_name), ''), nullif(btrim(v_p.handle), ''), p_email),
       p_email, v_p.platform, v_p.handle, v_p.profile_url, 'invited', v_p.id, p_actor)
    returning id, status into v_aff, v_status;
  end if;
  if v_status = 'active' then
    raise exception 'already_affiliate: this person is already an active affiliate';
  end if;

  -- 64 hex characters from two CSPRNG uuids (pg_catalog.gen_random_uuid uses
  -- pg_strong_random): 244 random bits, inside the portal's token pattern.
  -- Only the SHA-256 is stored, exactly as the edge function stores it.
  v_raw := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_token := public.affiliate_issue_access_token(
    p_company, p_program, 'signup',
    encode(sha256(convert_to(v_raw, 'UTF8')), 'hex'),
    v_expires, v_aff, null, p_actor);

  update public.affiliate_prospects
     set status = 'invited', affiliate_id = v_aff, updated_at = now()
   where id = v_p.id and company_entity_id = p_company;

  return json_build_object(
    'token_id', v_token,
    'affiliate_id', v_aff,
    'url', 'https://get-silo.com/v2/affiliates/join.html?t=' || v_raw,
    'expires_at', v_expires);
end;
$$;

comment on function public.affiliate_outreach_mint_signup(uuid, uuid, uuid, text, uuid) is
  'Mints one 14-day signup link for an approved prospect, creating the invited affiliate record if needed, as affiliate-invite''s signup_link does. Returns the raw URL once; only its SHA-256 is stored. Reuses the program''s existing record for the same email (a follow-up), reopens an ended invite, refuses an active, paused or ended affiliate. Internal to silo_api_claim_outreach. 20261110093000, follow-ups 20261110120000.';

revoke all on function public.affiliate_outreach_mint_signup(uuid, uuid, uuid, text, uuid)
  from public, anon, authenticated, silo_integration, silo_revoked;
