-- 2026-11-17: Affiliate Studio emails the onboarding invite.
--
-- A person a manager adds by hand, or one who applied, is emailed their
-- signup link when they are approved (affiliate-invite `signup_link` with
-- email=true, INVITE_SOURCES = manual / applied). Creators a search found are
-- still never emailed by SILO. The delivery is recorded in
-- affiliate_notifications under the new kind 'signup_invite', which this adds
-- to the CHECK. It also adds affiliate_prospect_merge_evidence() (below),
-- service role only. No table or policy changes.
--
-- Apply BEFORE deploying affiliate-invite and affiliate-research. Without it
-- the invite still goes out but its delivery record is refused (logged, not
-- raised), and photo and stats refreshes write nothing.

alter table public.affiliate_notifications drop constraint if exists affiliate_notifications_kind_check;
alter table public.affiliate_notifications add constraint affiliate_notifications_kind_check
  check (kind in ('signup_confirmation', 'portal_link', 'codes_and_links', 'payout_status', 'link_renewal', 'signup_invite'));

-- Creator photos and YouTube stats are written by two separate jobs that can
-- run at the same time. Each merges only the evidence keys it owns, in one
-- statement, so neither erases what the other just stored. A contact email is
-- filled only when none is on file. Service role only.
create or replace function public.affiliate_prospect_merge_evidence(
  p_id uuid, p_company uuid, p_patch jsonb,
  p_contact_email text default null, p_contact_source_url text default null,
  p_touch boolean default false)
returns boolean
language sql
security invoker
set search_path = public
as $$
  update public.affiliate_prospects
     set evidence = coalesce(evidence, '{}'::jsonb) || coalesce(p_patch, '{}'::jsonb),
         contact_source_url = case when contact_email is null and p_contact_email is not null
                                   then p_contact_source_url else contact_source_url end,
         contact_email = coalesce(contact_email, p_contact_email),
         updated_at = case when p_touch then now() else updated_at end
   where id = p_id and company_entity_id = p_company
  returning true
$$;
revoke all on function public.affiliate_prospect_merge_evidence(uuid, uuid, jsonb, text, text, boolean) from public, anon, authenticated;
grant execute on function public.affiliate_prospect_merge_evidence(uuid, uuid, jsonb, text, text, boolean) to service_role;
