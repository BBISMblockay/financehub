-- Reconnect an ad-platform connection IN PLACE.
--
-- WHY. Every Google/TikTok "Connect" inserted a NEW ad_platform_connections
-- row, so there was no way to renew an existing connection's authorization:
-- the only controls on a row were Test and Remove. Removing is the wrong
-- answer twice over -- the row holds the chosen property/account and sync
-- settings, and five history tables reference it (connection_id, ON DELETE
-- SET NULL, unindexed), which is why a Remove timed out on 2026-09-28. It
-- became urgent when SILO switched Google OAuth clients: a refresh token only
-- refreshes with the client that issued it (Google answers
-- `unauthorized_client`), so every existing Google row needs one fresh
-- consent, onto the SAME row.
--
-- The OAuth state now optionally names the connection the flow renews. The
-- start function sets it only after checking that row belongs to the company
-- and platform the flow is for; the callback then updates that row's tokens
-- instead of inserting, re-checking both again. ON DELETE CASCADE: a state
-- for a connection removed mid-flow is dropped with it, and the callback then
-- reports an expired state instead of recreating a row somebody deleted.
alter table public.ad_platform_oauth_states
  add column if not exists connection_id uuid
    references public.ad_platform_connections(id) on delete cascade;

comment on column public.ad_platform_oauth_states.connection_id is
  'Set when the flow RECONNECTS an existing ad_platform_connections row: the callback writes the new tokens onto that row (same company and platform, re-checked) instead of inserting a second connection. NULL = a new connection.';
