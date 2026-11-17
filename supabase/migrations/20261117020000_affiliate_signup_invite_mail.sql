-- 2026-11-17: Affiliate Studio emails the onboarding invite.
--
-- A person a manager adds by hand, or one who applied, is emailed their
-- signup link when they are approved (affiliate-invite `signup_link` with
-- email=true, INVITE_SOURCES = manual / applied). Creators a search found are
-- still never emailed by SILO. The delivery is recorded in
-- affiliate_notifications under the new kind 'signup_invite', which this adds
-- to the CHECK. Nothing else changes: no table, policy or grant.
--
-- Apply BEFORE deploying affiliate-invite, or the invite still goes out but
-- its delivery record is refused (logged, not raised).

alter table public.affiliate_notifications drop constraint if exists affiliate_notifications_kind_check;
alter table public.affiliate_notifications add constraint affiliate_notifications_kind_check
  check (kind in ('signup_confirmation', 'portal_link', 'codes_and_links', 'payout_status', 'link_renewal', 'signup_invite'));
