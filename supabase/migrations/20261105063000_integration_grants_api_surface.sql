-- Put the work:write grants back inside the API surface the nightly check
-- draws.
--
-- `deployment-drift-check` has been red since 20261104230000 was applied, on
-- a check that predates it: #292 asserts that the integration roles hold an
-- explicit EXECUTE grant on NOTHING outside SILO's API surface, and names
-- that surface in a list. Three functions arrived without being added to it:
--
--   silo_api_create_task  the write tool itself
--   silo_api_scopes       what the MCP server reads to decide which tools to
--                         advertise
--   silo_api_write_cap    the cap behind the write tool
--
-- The first two belong on the list: both are on the PostgREST path allowlist
-- (silo_api_path_allowed), so they are exactly what "the API surface" means,
-- and the check's list is updated in verify_v2_schema.sql alongside this file.
--
-- The third does not. Nothing calls silo_api_write_cap() over PostgREST: it
-- is read inside silo_api_create_task, which is SECURITY DEFINER and owned by
-- postgres, so the grant to silo_integration buys nothing and only widens
-- what a connection could call if a path were ever added by mistake. It goes.
-- `authenticated` keeps its grant, because the number is not a secret and a
-- page may yet want to show it.
--
-- No row changes, no function bodies change. No deploy.
revoke execute on function public.silo_api_write_cap() from silo_integration;

-- Proof, in the migration, that the write tool still has what it needs and
-- the integration role does not have what it should not.
do $$
begin
  if not has_function_privilege('silo_integration',
       'public.silo_api_create_task(text, text, text, date, uuid, text, text, boolean)', 'execute') then
    raise exception 'the integration role can no longer call the write tool';
  end if;
  if has_function_privilege('silo_integration', 'public.silo_api_write_cap()', 'execute') then
    raise exception 'silo_api_write_cap is still granted to the integration role';
  end if;
end $$;
