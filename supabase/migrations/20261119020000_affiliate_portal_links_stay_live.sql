-- Portal links stay live for their whole 90 days (Blake 2026-11-18: after
-- signing up, "Open my partner portal" and the welcome email's button both
-- landed on Sign in).
--
-- affiliate_issue_access_token() revoked every earlier UNUSED token of the
-- same purpose for the same person. That is right for sign-up links (two live
-- invites are two ways into one record), but signing up mints three portal
-- links within seconds: the one on the "You are in" page and in the welcome
-- email, then one in each email that follows (code live, sign-in). Each new one
-- killed the last, so only the final email's link worked. Prod 2026-11-19:
-- the accept link was revoked 4s after it was made, never used.
--
-- A portal link is already personal, hashed, expiring and (for the brand
-- switch) bound to the recipient; a USED one was never revoked by this rule.
-- So the one-live rule now applies to sign-up links only. Nothing else in the
-- function changes; the body is otherwise copied from production as read on
-- 2026-11-19 (same as 20261110086000).
--
-- Idempotent.

create or replace function public.affiliate_issue_access_token(
  p_company_entity_id uuid, p_program_id uuid, p_purpose text, p_token_hash text,
  p_expires_at timestamp with time zone, p_affiliate_id uuid default null,
  p_prospect_id uuid default null, p_created_by uuid default null)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_id uuid;
begin
  if p_purpose not in ('signup','portal') then
    raise exception 'affiliate_issue_access_token: unknown purpose %', p_purpose;
  end if;
  if btrim(coalesce(p_token_hash,'')) = '' then
    raise exception 'affiliate_issue_access_token: a token hash is required';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'affiliate_issue_access_token: expires_at must be in the future';
  end if;
  if p_affiliate_id is null and p_prospect_id is null then
    raise exception 'affiliate_issue_access_token: a token must name an affiliate or a prospect';
  end if;

  -- The subject must belong to the company AND the program the caller named.
  -- Without this, a caller could mint a link that resolves to one tenant's
  -- affiliate under another tenant's program.
  if p_affiliate_id is not null and not exists (
    select 1 from public.affiliates a
     where a.id = p_affiliate_id
       and a.company_entity_id = p_company_entity_id
       and a.program_id = p_program_id
  ) then
    raise exception 'affiliate_issue_access_token: affiliate does not belong to that company and program';
  end if;
  if p_prospect_id is not null and not exists (
    select 1 from public.affiliate_prospects x
     where x.id = p_prospect_id
       and x.company_entity_id = p_company_entity_id
       and x.program_id = p_program_id
  ) then
    raise exception 'affiliate_issue_access_token: prospect does not belong to that company and program';
  end if;

  -- One live SIGN-UP link per subject: a second invite means two paths into
  -- one record, and the older mail would keep working after sign-up. Portal
  -- links are not limited this way (20261119020000): several arrive in the
  -- same minute and each must work.
  if p_purpose = 'signup' then
    update public.affiliate_access_tokens
       set revoked_at = now()
     where company_entity_id = p_company_entity_id
       and purpose = 'signup'
       and revoked_at is null
       and first_used_at is null
       and ((p_affiliate_id is not null and affiliate_id = p_affiliate_id)
         or (p_prospect_id  is not null and prospect_id  = p_prospect_id));
  end if;

  insert into public.affiliate_access_tokens (
    company_entity_id, program_id, affiliate_id, prospect_id,
    purpose, token_hash, expires_at, created_by
  ) values (
    p_company_entity_id, p_program_id, p_affiliate_id, p_prospect_id,
    p_purpose, p_token_hash, p_expires_at, p_created_by
  ) returning id into v_id;

  return v_id;
end;
$$;

-- create or replace keeps grants; stated again so a fresh database matches.
revoke all on function public.affiliate_issue_access_token(uuid, uuid, text, text, timestamptz, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.affiliate_issue_access_token(uuid, uuid, text, text, timestamptz, uuid, uuid, uuid) to service_role;
