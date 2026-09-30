-- Standalone archive verification. Central verification integration is pending.
-- Report archive management (20260930203350)
-- Keep above the onboarding/Plaid fixture markers: these checks need reports.
select 'Report archive management structure' as check_name,
  case
    when not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'silo_chat_saved_reports'
                       and column_name = 'archived_at' and data_type = 'timestamp with time zone')
      then 'MISSING — report archived_at; run 20260930203350_saved_report_archive.sql'
    when not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'silo_chat_saved_reports_v'
                       and column_name = 'archived_at')
      then 'MISSING — report view archived_at; archived reports cannot be restored in the library'
    when not coalesce((select 'security_invoker=true' = any(c.reloptions)
                         from pg_class c join pg_namespace n on n.oid = c.relnamespace
                        where n.nspname = 'public' and c.relname = 'silo_chat_saved_reports_v'), false)
      then 'CRITICAL — saved report view lost invoker RLS'
    when pg_get_viewdef('public.silo_chat_saved_reports_v'::regclass) ~* 'WHERE.*archived_at'
      then 'BROKEN — saved report view hides archived rows; filtering belongs to library/pickers'
    when not exists (select 1 from pg_trigger t
                     where t.tgrelid = 'public.silo_chat_saved_reports'::regclass
                       and t.tgname = 'guard_saved_report_archive' and t.tgenabled <> 'D'
                       and t.tgfoid = to_regprocedure('public.guard_saved_report_archive()')
                       and t.tgtype = 23)
      then 'CRITICAL — report archive/ownership trigger missing or misbound; direct PATCH bypass'
    else 'ok'
  end as status;

select 'Report archive management permissions' as check_name,
  case
    when to_regprocedure('public.set_saved_report_archived(uuid,boolean)') is null
      or to_regprocedure('public.saved_report_archive_usage(uuid)') is null
      then 'MISSING — creator-only report archive RPCs; run 20260930203350_saved_report_archive.sql'
    when exists (select 1 from pg_proc p
                  where p.oid in (to_regprocedure('public.set_saved_report_archived(uuid,boolean)'),
                                  to_regprocedure('public.saved_report_archive_usage(uuid)'),
                                  to_regprocedure('public.guard_saved_report_archive()'))
                    and p.prosecdef)
      then 'CRITICAL — report archive functions must be SECURITY INVOKER'
    when exists (select 1 from pg_proc p
                  where p.oid in (to_regprocedure('public.set_saved_report_archived(uuid,boolean)'),
                                  to_regprocedure('public.saved_report_archive_usage(uuid)'))
                    and (has_function_privilege('anon', p.oid, 'execute')
                         or not has_function_privilege('authenticated', p.oid, 'execute')))
      then 'CRITICAL — report archive RPC grants must allow authenticated and deny anon/PUBLIC'
    when has_table_privilege('anon', 'public.silo_chat_saved_reports_v', 'select')
      then 'CRITICAL — anon can read the saved report view'
    else 'ok'
  end as status;
-- End report archive management
