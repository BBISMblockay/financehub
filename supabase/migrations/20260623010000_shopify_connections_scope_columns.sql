-- Additive columns on shopify_connections to match prod schema.
-- Idempotent — safe to re-run.

alter table public.shopify_connections
  add column if not exists display_name          text,
  add column if not exists location_tag_prefix   text,
  add column if not exists credential_ref        text,
  add column if not exists sync_enabled          boolean      not null default false,
  add column if not exists history_days_default  integer      not null default 90,
  add column if not exists meta                  jsonb        not null default '{}',
  add column if not exists location_id           bigint,
  add column if not exists last_test_success     boolean,
  add column if not exists scopes_granted        jsonb        not null default '[]',
  add column if not exists scopes_missing        jsonb        not null default '[]',
  add column if not exists scopes_checked_at     timestamptz;

-- access_token was NOT NULL in the original migration; relax to nullable
-- (token may eventually be stored via credential_ref / vault instead)
alter table public.shopify_connections
  alter column access_token drop not null;

-- Bump api_version default to current stable
alter table public.shopify_connections
  alter column api_version set default '2025-01';
