-- 20261112040000 -- remember when a sync last asked the institution to re-fetch.
--
-- A Plaid feed can stop delivering while every sync stays green: the cursor
-- returns nothing, the item stays active, balances refresh, and the scheduled
-- run reports success. The date-range top-up (20261103070000's sibling in
-- plaid-finance) covers the case where PLAID holds days our cursor missed, but
-- not the case where Plaid itself was never given them. Only
-- /transactions/refresh makes Plaid go and ask the institution, and until now
-- that was reachable only from a button a person had to press.
--
-- This column lets the scheduled sync make that request itself, at most once
-- per item per cooldown window. It is stamped BEFORE the request, so a refused
-- or lost call waits out the window instead of being retried every six hours.
-- The grain is the CONNECTION, not the account, because /transactions/refresh
-- takes an access token and refreshes the whole item: per-account would fire
-- one request per mapped account for the same refresh.
--
-- Nothing reads this but that cooldown, and a null means "never asked", which
-- is the correct starting point for every existing connection. No policy,
-- grant, view, report or tie-out changes: plaid_connections already has RLS and
-- the column is covered by the existing policies.
--
-- No catalog refresh: plaid_connections is deliberately hidden from Ask SILO
-- (feeds are read through silo_feed_health_v), so it has no catalog row for a
-- new column to appear in -- the same reason 20261103070000 and
-- 20261103200000 do not refresh it either.
--
-- Idempotent: add if not exists, applied twice by
-- scripts/tests/plaid-bank-feed-database.test.mjs.

begin;

alter table public.plaid_connections
  add column if not exists auto_refresh_requested_at timestamptz;

comment on column public.plaid_connections.auto_refresh_requested_at is
  'When a scheduled sync last asked the institution to re-fetch (/transactions/refresh), stamped before the request. Null means never. Only the automatic cooldown reads it; a person pressing "Ask bank to re-fetch" does not stamp it.';

commit;
