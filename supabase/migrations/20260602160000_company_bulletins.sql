-- =============================================================================
-- Company bulletin board (profile page + future hubs)
-- Safe to re-run.
-- =============================================================================

create table if not exists public.company_bulletins (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  pinned boolean not null default false,
  priority text not null default 'normal' check (priority in ('normal', 'important')),
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists company_bulletins_starts_at_idx
  on public.company_bulletins (starts_at desc);

create index if not exists company_bulletins_pinned_idx
  on public.company_bulletins (pinned desc, created_at desc);

alter table public.company_bulletins enable row level security;

-- Anyone signed in can read active bulletins
drop policy if exists company_bulletins_select_active on public.company_bulletins;
create policy company_bulletins_select_active
  on public.company_bulletins for select to authenticated
  using (
    starts_at <= now()
    and (expires_at is null or expires_at > now())
  );

-- Admins can read all (including scheduled/expired) for management
drop policy if exists company_bulletins_select_admin on public.company_bulletins;
create policy company_bulletins_select_admin
  on public.company_bulletins for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and lower(coalesce(p.role, '')) in ('owner', 'admin', 'superadmin')
        and coalesce(p.is_active, true)
    )
  );

drop policy if exists company_bulletins_insert_admin on public.company_bulletins;
create policy company_bulletins_insert_admin
  on public.company_bulletins for insert to authenticated
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and lower(coalesce(p.role, '')) in ('owner', 'admin', 'superadmin')
        and coalesce(p.is_active, true)
    )
  );

drop policy if exists company_bulletins_update_admin on public.company_bulletins;
create policy company_bulletins_update_admin
  on public.company_bulletins for update to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and lower(coalesce(p.role, '')) in ('owner', 'admin', 'superadmin')
        and coalesce(p.is_active, true)
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and lower(coalesce(p.role, '')) in ('owner', 'admin', 'superadmin')
        and coalesce(p.is_active, true)
    )
  );

drop policy if exists company_bulletins_delete_admin on public.company_bulletins;
create policy company_bulletins_delete_admin
  on public.company_bulletins for delete to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and lower(coalesce(p.role, '')) in ('owner', 'admin', 'superadmin')
        and coalesce(p.is_active, true)
    )
  );

comment on table public.company_bulletins is 'Company-wide announcements shown on profile and internal hubs';
