-- Connection is not consent to import. Preserve only established successful
-- fixed datasets on the FIRST apply; replay never resumes a paused account.
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
    and table_name = 'windsor_linked_accounts' and column_name = 'sync_enabled') then
    alter table public.windsor_linked_accounts add column sync_enabled boolean not null default false;
    update public.windsor_linked_accounts set sync_enabled = true
      where ds_id in ('tiktok', 'klaviyo') and last_sync_status = 'success';
  end if;
end;
$$;
comment on column public.windsor_linked_accounts.sync_enabled is
  'Admin consent for subsequent scheduled runs. False for new accounts. Does not cancel an in-flight run. Unsupported source contracts remain blocked even when true.';
-- Existing SELECT-only client grants/RLS remain unchanged. Broker is the only
-- client control path, after user/MFA/integration/company/admin authorization.
select public.attach_stamp_company_entity_id_triggers();
select public.refresh_chat_schema_catalog();
