-- Service-only scheduling state. Existing atomic snapshots are the day checkpoints.
create table if not exists public.shopify_attribution_coverage (
 connection_id uuid primary key references public.shopify_connections(id) on delete cascade,
 start_day date not null,
 next_day date not null,
 shop_timezone text not null,
 last_attempt_at timestamptz not null,
 last_status text not null check(last_status in ('running','success','partial_failure','permission_limited','paused','store_failed')),
 last_failed_day date,
 last_failed_at timestamptz,
 last_result jsonb not null default '{}'::jsonb
);
alter table public.shopify_attribution_coverage enable row level security;
revoke all on public.shopify_attribution_coverage from public,anon,authenticated;
grant select,insert,update,delete on public.shopify_attribution_coverage to service_role;
