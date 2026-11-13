-- The nav profile becomes company DATA instead of a literal in shared code.
--
-- WHY. v2/nav-config.js decided the sidebar profile with
-- `entity_key === 'baseballism'` -> 'grandfathered', everyone else 'standard'.
-- That is a company-specific fact in code every tenant loads, which the
-- project rule forbids, and it had two practical costs: no second workspace
-- could ever be grandfathered without a code change, and the literal told
-- every reader of a public repo which tenant SILO grew up in.
--
-- The escape hatch already existed and was already checked FIRST:
-- entities.meta.nav_profile, honoured for 'grandfathered' and 'standard'.
-- Nothing in production set it. This migration sets it, which is why it is
-- safe to apply BEFORE the code change ships: with the old code, meta and the
-- entity_key branch agree on 'grandfathered' for Baseballism, so applying
-- this changes nothing at all. With the new code, meta is the only answer.
--
-- APPLY THIS BEFORE THE FRONTEND SHIPS. If the new nav-config.js reaches the
-- browser while this is unapplied, Baseballism resolves to 'standard' and sees
-- the smaller menu (Reviews, Compensation, the TikTok schedule and the
-- Marketing Report drop off the sidebar). No data is exposed -- RLS is
-- untouched and every URL still works -- and applying this restores the menu
-- on the next page load.
--
-- Scoped by entity_key, not by id, so nothing here depends on a uuid literal
-- staying correct. Idempotent: re-running it rewrites the same value.
begin;

update public.entities
   set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('nav_profile', 'grandfathered')
 where entity_key = 'baseballism'
   and entity_type = 'company'
   and coalesce(meta->>'nav_profile', '') <> 'grandfathered';

-- Any other company stays unset, which resolves to 'standard' -- the same menu
-- it sees today. Granting a workspace the larger menu later is one update of
-- this flag, not a code change.
comment on column public.entities.meta is
  'Per-company settings that are not their own columns. Keys in use: nav_profile (''grandfathered'' | ''standard'', read by v2/nav-config.js resolveNavProfile -- unset means ''standard''), integrations, invite_id, platform_invite, seeded, test. 20261113040000.';

commit;
