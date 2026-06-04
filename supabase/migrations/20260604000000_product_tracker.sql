-- Product Tracker: new-product launch readiness table
-- Links bidirectionally to launch_calendar + products_master + factories.
-- Safe to re-run.

create table if not exists public.product_tracker (
  id                    uuid primary key default gen_random_uuid(),
  product_title         text not null,
  manufacturer          text,                          -- denorm from factory or free text
  factory_id            uuid references public.factories(id) on delete set null,
  product_type          text,
  collection            text,
  launch_id             uuid references public.launch_calendar(id) on delete set null,
  product_master_id     uuid references public.products_master(id) on delete set null,
  product_title_snapshot text,                         -- snapshot from linked product
  bulk_eta              date,
  on_hand               text,                          -- 'Bulk','Sample','Pre-Production',etc.
  size_requests         text,
  sizes_ready_warehouse text,
  sizes_picked_up       text,
  photo_complete        text not null default 'pending', -- 'pending','complete','na'
  copy_complete         boolean not null default false,
  is_live               boolean not null default false,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists product_tracker_launch_idx on public.product_tracker (launch_id);
create index if not exists product_tracker_master_idx on public.product_tracker (product_master_id);

alter table public.product_tracker enable row level security;

-- auto-update updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists product_tracker_updated_at on public.product_tracker;
create trigger product_tracker_updated_at
  before update on public.product_tracker
  for each row execute function public.set_updated_at();

-- RLS policies
drop policy if exists "product_tracker_select" on public.product_tracker;
create policy "product_tracker_select" on public.product_tracker
  for select to authenticated using (true);

drop policy if exists "product_tracker_insert" on public.product_tracker;
create policy "product_tracker_insert" on public.product_tracker
  for insert to authenticated
  with check (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role::text in ('owner','admin')
    )
  );

drop policy if exists "product_tracker_update" on public.product_tracker;
create policy "product_tracker_update" on public.product_tracker
  for update to authenticated
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role::text in ('owner','admin')
    )
  );

drop policy if exists "product_tracker_delete" on public.product_tracker;
create policy "product_tracker_delete" on public.product_tracker
  for delete to authenticated
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role::text in ('owner','admin')
    )
  );
