-- =============================================================================
-- Lock ad_platform_connections / redo_connections reads to admin-tier
--
-- Both tables' SELECT policy was `company_entity_id = active_company_id()` --
-- readable by ANY active company member -- while their own WRITE policy was
-- already `... AND is_admin_user()`. That's backwards: these rows carry live
-- secrets (redo_connections.webhook_secret/api_secret, ad_platform_connections
-- .access_token/refresh_token) that only the people who can create/edit a
-- connection should ever see. The gap was concretely exploitable: Ask SILO's
-- run_sql tool is SECURITY INVOKER and respects RLS as-is, so any active user
-- asking it "what's in redo_connections" got the secrets back in plain text
-- -- and /v2/integrations.html, which does display them, isn't nav-gated
-- either (see the companion nav-config.js change).
--
-- Fix: SELECT now requires is_admin_user(), matching the existing WRITE
-- policy exactly -- no new function, no behavior change for the only
-- consumer that matters (integrations.html, whose edit actions already
-- required admin). Edge functions (redo-webhook, google/tiktok-oauth-
-- callback, test-ad-platform-connection) all use the service-role key and
-- are unaffected by RLS either way.
-- =============================================================================

drop policy if exists redo_connections_active_select on public.redo_connections;
create policy redo_connections_admin_select on public.redo_connections
  for select using (
    company_entity_id = active_company_id()
    and is_admin_user()
  );

drop policy if exists ad_platform_connections_active_select on public.ad_platform_connections;
create policy ad_platform_connections_admin_select on public.ad_platform_connections
  for select using (
    company_entity_id = active_company_id()
    and is_admin_user()
  );
