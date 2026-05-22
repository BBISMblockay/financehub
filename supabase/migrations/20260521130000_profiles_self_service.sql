-- =============================================================================
-- Profiles: allow signed-in users to read and update their own row
-- Run after po_costing migration (or standalone).
-- =============================================================================

-- Users can read their own profile
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles for select to authenticated
  using (id = auth.uid());

-- Users can update safe fields on their own profile
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Optional column if missing (safe no-op if exists)
alter table public.profiles
  add column if not exists default_page text;

comment on column public.profiles.default_page is 'Internal path for post-login redirect (e.g. /v2/cashflow.html)';
