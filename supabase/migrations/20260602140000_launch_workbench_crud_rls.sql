-- =============================================================================
-- Launch Workbench: allow authenticated CRUD (including DELETE) on child tables
-- Run in Supabase SQL Editor if product/initiative delete fails silently.
-- Safe to re-run (drops/recreates policies).
-- =============================================================================

do $policy$
declare
  t text;
begin
  foreach t in array array[
    'launch_calendar',
    'launch_product_readiness',
    'launch_channel_items',
    'launch_tasks',
    'launch_assets',
    'launch_comments',
    'launch_system_links'
  ]
  loop
    if exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
    ) then
      execute format('alter table public.%I enable row level security', t);
      execute format('drop policy if exists %I_auth_all on public.%I', t, t);
      execute format(
        'create policy %I_auth_all on public.%I for all to authenticated using (true) with check (true)',
        t, t
      );
      raise notice 'Launch Workbench policy applied: %', t;
    else
      raise notice 'Skip (table missing): %', t;
    end if;
  end loop;
end
$policy$;
