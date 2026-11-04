-- Navigation preferences only: no entitlements, route gates or operating data.
-- No rows are seeded: every absent module remains visible by default.
begin;
create table if not exists public.workspace_module_visibility (
  company_entity_id uuid not null references public.entities(id) on delete cascade,
  module_id text not null check (module_id in ('marketing','finance','purchasing_inventory','planning','team')),
  visible boolean not null default true,
  primary key (company_entity_id, module_id)
);
comment on table public.workspace_module_visibility is
  'Workspace menu preferences only; absence means visible. Not security or purchased entitlements.';
alter table public.workspace_module_visibility enable row level security;
revoke all on public.workspace_module_visibility from public, anon, authenticated;
grant select, insert, update on public.workspace_module_visibility to authenticated;
grant all on public.workspace_module_visibility to service_role;

drop policy if exists workspace_modules_read on public.workspace_module_visibility;
create policy workspace_modules_read on public.workspace_module_visibility for select to authenticated
using (company_entity_id = (select public.active_company_id())
  and (select public.is_active_user()) and public.is_entity_member(company_entity_id));

drop policy if exists workspace_modules_insert on public.workspace_module_visibility;
create policy workspace_modules_insert on public.workspace_module_visibility for insert to authenticated
with check (company_entity_id = (select public.active_company_id())
  and (select public.is_active_user()) and public.is_entity_admin(company_entity_id));

drop policy if exists workspace_modules_update on public.workspace_module_visibility;
create policy workspace_modules_update on public.workspace_module_visibility for update to authenticated
using (company_entity_id = (select public.active_company_id())
  and (select public.is_active_user()) and public.is_entity_admin(company_entity_id))
with check (company_entity_id = (select public.active_company_id())
  and (select public.is_active_user()) and public.is_entity_admin(company_entity_id));

select public.attach_stamp_company_entity_id_triggers();
select public.refresh_chat_schema_catalog();
commit;
