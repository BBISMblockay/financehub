-- Explicit publication for live, read-only Windsor access through SILO MCP.
-- No source data is persisted. Every account starts unpublished, including
-- existing accounts. This does not enable sync or alter existing reporting.
alter table public.windsor_linked_accounts
  add column if not exists mcp_enabled boolean not null default false;
comment on column public.windsor_linked_accounts.mcp_enabled is
  'Company-admin approval for live read-only access by this company''s SILO OAuth grants with data:read. Independent of sync_enabled. False by default.';

-- The RPC executor is a non-owner, non-BYPASSRLS role. Ordinary client grants
-- are unchanged; the integration role still has no direct table access.
drop policy if exists windsor_linked_accounts_mcp_select on public.windsor_linked_accounts;
create policy windsor_linked_accounts_mcp_select on public.windsor_linked_accounts
  for select to silo_api_exec
  using (company_entity_id = (select public.active_company_id()) and mcp_enabled);
grant select (id,company_entity_id,ds_id,account_id,account_name,mcp_enabled)
  on public.windsor_linked_accounts to silo_api_exec;

create or replace function public.silo_api_windsor_connections(p_connection_id uuid default null, p_offset integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_connection jsonb;
begin
  if not public.silo_api_is_integration() then
    raise exception 'integration_required: use an authorized SILO AI connection' using errcode='insufficient_privilege';
  end if;
  perform public.silo_api_require_scope('data:read');
  v_company := public.active_company_id(); -- the LIVE grant company, not the browser profile
  if v_company is null then
    raise exception 'no_active_company: no authorized company' using errcode='insufficient_privilege';
  end if;
  if p_offset < 0 or p_offset > 100000 or p_offset is null then
    raise exception 'invalid_offset';
  end if;
  if p_connection_id is not null then
    select jsonb_build_object('id',a.id,'company_entity_id',a.company_entity_id,
      'source',a.ds_id,'account_id',a.account_id,'name',a.account_name)
    into v_connection
    from public.windsor_linked_accounts a
    where a.id=p_connection_id and a.company_entity_id=v_company and a.mcp_enabled and a.ds_id <> 'all';
    if v_connection is null then
      raise exception 'connection_not_available: connection is not published for this company' using errcode='insufficient_privilege';
    end if;
    return v_connection;
  end if;
  return jsonb_build_object('connections',coalesce((
    select jsonb_agg(jsonb_build_object('id',a.id,'source',a.ds_id,'name',a.account_name) order by a.ds_id,a.id)
    from (select * from public.windsor_linked_accounts
      where company_entity_id=v_company and mcp_enabled and ds_id <> 'all'
      order by ds_id,id limit 100 offset p_offset) a
  ),'[]'::jsonb), 'next_offset', case when (select count(*) from public.windsor_linked_accounts
    where company_entity_id=v_company and mcp_enabled and ds_id <> 'all') > p_offset+100 then p_offset+100 else null end);
end;
$$;
grant create on schema public to silo_api_exec;
alter function public.silo_api_windsor_connections(uuid,integer) owner to silo_api_exec;
revoke create on schema public from silo_api_exec;
revoke all on function public.silo_api_windsor_connections(uuid,integer) from public,anon,authenticated;
grant execute on function public.silo_api_windsor_connections(uuid,integer) to silo_integration;

-- Preserve every existing read-only API path; admit only the scoped resolver.
create or replace function public.silo_api_path_allowed()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('request.path', true), '') in (
    '/rpc/silo_api_run_report', '/rpc/silo_api_list_reports',
    '/rpc/silo_api_describe_tables', '/rpc/silo_api_query',
    '/rpc/silo_api_windsor_connections')
$$;

-- Connection plumbing is not a business dataset. Existing fact tables and
-- reports remain unchanged; only the scoped resolver advertises published accounts.
select public.refresh_chat_schema_catalog();
update public.silo_chat_schema_catalog set is_hidden=true,reportable=false
where relname in ('windsor_links','windsor_linked_accounts');
select public.attach_stamp_company_entity_id_triggers();
