-- Developer API / MCP: a read-only query tool over the tables a person can
-- see, so a connected AI can answer what the built-in reports cannot.
--
-- WHY (Blake, 2026-10-30): "our silo reports are safe and good for
-- dashboards, bad for these questions, ask silo is pretty good at those
-- questions" ... "look at what ask silo is exposed to and mirror that" ...
-- "reports only should mean run reports with supabase raw data". The first
-- MCP chat could only answer "what share of 2026 units were MLB-licensed" as
-- a floor, from a 50-row report.
--
-- WHAT a connection may do with data:read, and nothing else:
--   silo_api_describe_tables(tables, search, notes)
--       the same schema catalog Ask SILO is shown (silo_chat_schema_catalog,
--       hidden rows excluded) and the company's Ask SILO notes. Never rows.
--   silo_api_query(sql, offset)
--       one SELECT/WITH, run as the person under RLS for the grant's company,
--       in a READ ONLY transaction, 30s, 1000 rows a page.
--
-- Its own runner, not Ask SILO's (Blake: "dont want it working through ask
-- silo query, just have same data access"). Same rules as
-- chat_run_readonly_query plus two more, because the caller is a third-party
-- application rather than SILO's own assistant:
--   * silo_sql_refused_function (20261030100000): no set_config (which would
--     switch auth.uid()) and no function that runs SQL text.
--   * silo_api_refused_name (below): no SECURITY DEFINER function (it
--     would run with its owner's rights), and only relations Ask SILO's
--     catalog shows. A hidden one (connection rows, OAuth states, credit ledgers, the
--     catalog itself) or a non-public schema (auth, storage, vault, net, cron,
--     ...) is refused by name, as are silo_api_grants and the platform-level
--     onboarding_interest_queue. Measured 2026-10-30: every other public
--     relation is in the catalog and visible, and the 38 hidden names are all
--     distinctive (no common words), so the name match does not refuse
--     ordinary queries.
-- RLS is still the boundary. The runner is SECURITY DEFINER owned by
-- silo_api_exec, which owns no relations, holds no BYPASSRLS and inherits
-- `authenticated`, exactly like silo_api_run_report: auth.uid() is the grant's
-- person and active_company_id() the grant's company. Checked on production
-- the same day: every catalogued table with company_entity_id has a read
-- policy keyed on the company or on a company-scoped parent row; the one
-- platform-wide policy (onboarding_interest_queue) is refused above.
--
-- data:read is its own scope (Blake chose it on 2026-10-30). Grants are
-- frozen, so existing connections keep reports:read only until they are
-- approved again; the consent page now grants both.
--
-- Idempotent: create or replace throughout.

-- ── 1. The path allowlist gains the two new RPCs ──────────────────────────
create or replace function public.silo_api_path_allowed()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(current_setting('request.path', true), '') in (
    '/rpc/silo_api_run_report',
    '/rpc/silo_api_list_reports',
    '/rpc/silo_api_describe_tables',
    '/rpc/silo_api_query')
$$;

comment on function public.silo_api_path_allowed() is
  'True when a third-party OAuth request is on one of the paths the developer platform exposes: running and listing reports (reports:read), and describing tables and running a read-only query (data:read). Every other path is refused by silo_check_request() before the request reaches a table. 20261030050000; query tool 20261030110000.';

-- ── 2. Consent offers data:read ───────────────────────────────────────────
-- Re-stated from 20261020030000 (matches production byte for byte, modulo
-- line endings; checked 2026-10-30) with one line changed.
create or replace function public.silo_api_consent(
  p_client_id text,
  p_scopes text[] default array['reports:read'])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- data:read since 20261030110000: the MCP query tool (read-only SQL under
  -- the person's own RLS). Granted alongside reports:read, never instead.
  c_offered constant text[] := array['reports:read', 'data:read'];
  v_user    uuid;
  v_company uuid;
  v_aal     text;
  v_scopes  text[];
  v_gen     integer;
  v_id      uuid;
begin
  -- A connection can never approve anything, least of all itself.
  if public.silo_api_is_integration() then
    raise exception 'integration_not_allowed: a connection cannot approve access'
      using errcode = 'insufficient_privilege';
  end if;

  v_user := auth.uid();
  if v_user is null then
    raise exception 'not_authenticated: sign in to approve access'
      using errcode = 'insufficient_privilege';
  end if;

  v_company := public.active_company_id();
  if v_company is null then
    raise exception 'no_active_company: open the company you are approving access for'
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from public.entity_memberships em
    where em.user_id = v_user and em.entity_id = v_company) then
    raise exception 'not_a_member: you are not a member of that company'
      using errcode = 'insufficient_privilege';
  end if;

  -- The assurance of the session doing the approving, as the session itself
  -- reports it. This is the whole reason consented_aal exists: an OAuth token
  -- reads aal1 forever, so the only evidence two-factor approval happened is
  -- what was true HERE, at this moment, recorded by the server.
  --
  -- A grant consented below aal2 can never be used -- mfa_session_satisfied()
  -- refuses an integration whose grant is not aal2 -- so it is refused now,
  -- loudly, rather than written and left to fail silently on first use. That
  -- makes enrolling a second factor a precondition of API access, which is the
  -- posture the design has carried since the first proof.
  v_aal := coalesce(nullif(public.silo_api_claims() ->> 'aal', ''), 'aal1');
  if v_aal <> 'aal2' then
    raise exception 'mfa_required: finish two-step login before approving API access'
      using errcode = 'insufficient_privilege';
  end if;

  if coalesce(trim(p_client_id), '') = '' then
    raise exception 'invalid_client: no application was named'
      using errcode = 'check_violation';
  end if;

  -- Scopes are an allowlist, deduplicated, and never empty.
  select coalesce(array_agg(distinct sc), '{}')
    into v_scopes
  from unnest(coalesce(p_scopes, '{}'::text[])) sc
  where sc = any(c_offered);
  if array_length(v_scopes, 1) is null then
    raise exception 'invalid_scope: no recognised scope was requested'
      using errcode = 'check_violation';
  end if;

  -- v1 is one company per (person, client), so approving again -- for another
  -- company, or for different scopes -- revokes what came before rather than
  -- leaving two. The partial unique index makes that mandatory, not a choice.
  select coalesce(max(g.generation), 0) into v_gen
  from public.silo_api_grants g
  where g.client_id = trim(p_client_id) and g.user_id = v_user;

  update public.silo_api_grants
     set revoked_at = now()
   where client_id = trim(p_client_id)
     and user_id = v_user
     and revoked_at is null;

  insert into public.silo_api_grants
    (client_id, user_id, company_entity_id, auth_session_id, generation,
     scopes, consented_aal, consented_at, expires_at)
  values
    (trim(p_client_id), v_user, v_company, null, v_gen + 1,
     v_scopes, v_aal, now(), now() + interval '90 days')
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.silo_api_consent(text, text[]) is
  'Creates the one live authorization for a third-party client, deriving the person, company, assurance and dates from request state rather than from arguments. Offers reports:read and data:read. Refuses a session that is not aal2, because a grant consented below aal2 can never be used. Approving again revokes the previous grant and bumps generation. 20261020030000; data:read 20261030110000.';

revoke all on function public.silo_api_consent(text, text[]) from public, anon;
grant execute on function public.silo_api_consent(text, text[]) to authenticated;

-- ── 3. Which names a query may use ──────────────────────────────────
-- SECURITY DEFINER (owner: the migration role) only to read the catalog,
-- whose policy admits role 'authenticated' and so not an integration. It
-- reads no rows of anything else and returns a name or null.
create or replace function public.silo_api_refused_name(p_sql text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  with s as (select lower(replace(coalesce(p_sql, ''), '"', '')) as q),
  refused as (
    -- A public SECURITY DEFINER function: it would run with its owner's
    -- rights, and several take a company id and check membership rather
    -- than the grant's company. Three read-only helpers stay callable.
    select p.proname::text as nm
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosecdef
       and p.proname not in ('active_company_id', 'silo_company_timezone', 'silo_business_timezone')
    union
    -- A public relation Ask SILO's catalog does not show, or one named here.
    select c.relname::text
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p', 'v', 'm', 'f')
       and (c.relname in ('silo_api_grants', 'onboarding_interest_queue')
            or not exists (select 1 from public.silo_chat_schema_catalog k
                            where k.relname = c.relname and not k.is_hidden))
  ),
  pattern as (
    -- One alternation, not one regex per name: 5,714 logged Ask SILO
    -- queries checked in under a minute this way, per-name timed out.
    select '\m(' || string_agg(nm, '|' order by length(nm) desc) || ')\M' as p
      from refused
     where nm ~ '^[a-z_][a-z0-9_]*$'
  )
  select coalesce(
    -- A schema other than public, pg_catalog or information_schema.
    (select 'the ' || substring(s.q from '\m(auth|storage|vault|net|cron|extensions|graphql|graphql_public|supabase_functions|supabase_migrations|pgsodium|pgsodium_masks|realtime|_realtime|pgbouncer|private|pg_toast)\s*\.') || ' schema'
       from s),
    (select substring(s.q from pattern.p) from s, pattern where pattern.p is not null))
$$;

comment on function public.silo_api_refused_name(text) is
  'MCP query tool guard: returns the first name the SQL uses that a connection may not -- a schema other than public/pg_catalog/information_schema, a public SECURITY DEFINER function (except active_company_id, silo_company_timezone and silo_business_timezone), a relation hidden from (or missing in) silo_chat_schema_catalog, silo_api_grants or onboarding_interest_queue -- or null. Name match on word boundaries, quotes ignored. 20261030110000.';

revoke all on function public.silo_api_refused_name(text) from public, anon, authenticated;
grant execute on function public.silo_api_refused_name(text) to silo_api_exec;

-- ── 4. describe_tables: the catalog and the notes, never rows ─────────────
-- SECURITY DEFINER for the same reason as above. The notes are read with an
-- explicit company filter, which is then the tenant boundary.
create or replace function public.silo_api_describe_tables(
  p_tables text[] default null,
  p_search text default null,
  p_notes  boolean default false)
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_max_tables  constant integer := 10;
  c_max_matches constant integer := 25;
  v_company uuid;
  v_search  text;
  v_out     json;
begin
  perform public.silo_api_require_scope('data:read');

  v_company := public.active_company_id();
  if v_company is null then
    raise exception 'no_active_company: this request is not scoped to a company'
      using errcode = 'check_violation';
  end if;

  if coalesce(p_notes, false) then
    select json_build_object(
             'notes', coalesce(json_agg(json_build_object(
               'note', n.note, 'category', n.category,
               'effective_until', n.effective_until, 'added_by', p.name)
               order by n.category nulls last, n.created_at), '[]'::json),
             'about', 'Business rules and definitions people in this company gave SILO''s assistant. Follow them when they apply.')
      into v_out
      from public.silo_chat_notes n
      left join public.profiles p on p.id = n.created_by
     where n.company_entity_id = v_company
       and (n.effective_until is null or n.effective_until >= current_date);
    return v_out;
  end if;

  if p_tables is not null then
    if coalesce(array_length(p_tables, 1), 0) = 0 or array_length(p_tables, 1) > c_max_tables then
      raise exception 'invalid_tables: name between 1 and % tables', c_max_tables
        using errcode = 'check_violation';
    end if;
    select json_build_object(
             'tables', coalesce((
               select json_agg(json_build_object(
                        'name', k.relname, 'kind', k.relkind,
                        'description', k.description, 'columns', k.columns)
                        order by k.relname)
                 from public.silo_chat_schema_catalog k
                where not k.is_hidden
                  and k.relname = any (select lower(btrim(t)) from unnest(p_tables) t)), '[]'::json),
             'not_found', coalesce((
               select json_agg(t order by t)
                 from (select distinct lower(btrim(t)) as t from unnest(p_tables) t) x
                where not exists (select 1 from public.silo_chat_schema_catalog k
                                   where not k.is_hidden and k.relname = x.t)), '[]'::json))
      into v_out;
    return v_out;
  end if;

  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_search is not null then
    if length(v_search) < 2 then
      raise exception 'invalid_search: search for 2 or more characters'
        using errcode = 'check_violation';
    end if;
    v_search := replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_');
    with hits as (
      select k.relname, k.relkind, k.description,
             (k.relname ilike '%' || v_search || '%') as by_name
        from public.silo_chat_schema_catalog k
       where not k.is_hidden
         and (k.relname ilike '%' || v_search || '%'
              or k.description ilike '%' || v_search || '%'
              or exists (select 1 from unnest(k.keywords) w where w ilike '%' || v_search || '%')
              or k.columns::text ilike '%"' || v_search || '%'))
    select json_build_object(
             'tables', coalesce((
               select json_agg(json_build_object('name', h.relname, 'kind', h.relkind,
                                                 'description', left(h.description, 240))
                               order by h.by_name desc, h.relname)
                 from (select * from hits order by by_name desc, relname limit c_max_matches) h), '[]'::json),
             'total', (select count(*) from hits),
             'shown', least((select count(*) from hits), c_max_matches))
      into v_out;
    return v_out;
  end if;

  -- No arguments: every name, grouped by kind, plus how to go further.
  select json_build_object(
           'tables', coalesce((select json_agg(k.relname order by k.relname)
                                 from public.silo_chat_schema_catalog k
                                where not k.is_hidden and k.relkind = 'table'), '[]'::json),
           'views', coalesce((select json_agg(k.relname order by k.relname)
                                from public.silo_chat_schema_catalog k
                               where not k.is_hidden and k.relkind <> 'table'), '[]'::json),
           'notes_count', (select count(*) from public.silo_chat_notes n
                            where n.company_entity_id = v_company
                              and (n.effective_until is null or n.effective_until >= current_date)),
           'how_to', 'Pass tables (up to 10 names) for their columns and descriptions, search for tables by name, description or column, or notes true for this company''s business rules. Views ending _v are usually the cleaned, reconciled version of a table; prefer them. Then run query.',
           'company_entity_id', v_company,
           'timezone', public.silo_company_timezone(v_company))
    into v_out;
  return v_out;
end;
$$;

comment on function public.silo_api_describe_tables(text[], text, boolean) is
  'MCP / developer API: the schema catalog Ask SILO is shown (silo_chat_schema_catalog, hidden rows excluded) and the grant company''s live Ask SILO notes. No arguments: names; p_tables: up to 10 full cards; p_search: up to 25 matches; p_notes: the notes. Never table rows. Requires data:read. SECURITY DEFINER to read the catalog (its policy admits only role authenticated); notes filtered by active_company_id() explicitly. 20261030110000.';

revoke all on function public.silo_api_describe_tables(text[], text, boolean) from public, anon, silo_revoked;
grant execute on function public.silo_api_describe_tables(text[], text, boolean) to silo_integration, authenticated;

-- ── 5. query: one read-only SELECT as the person ──────────────────────────
create or replace function public.silo_api_query(p_sql text, p_offset integer default 0)
returns json
language plpgsql
volatile
security definer
-- public, then pg_temp LAST, as silo_api_run_report: SQL names its tables
-- unqualified, and a temporary relation must not shadow one.
set search_path = public, pg_temp
as $$
declare
  c_page_size constant integer := 1000;
  v_sql     text;
  v_refused text;
  v_rows    json;
  v_count   integer;
  v_company uuid;
  v_offset  integer := coalesce(p_offset, 0);
begin
  perform public.silo_api_require_scope('data:read');

  -- AFTER the scope check and BEFORE read only: the request's one write.
  perform public.silo_api_touch_grant();

  if v_offset < 0 or v_offset > 1000000 then
    raise exception 'invalid_offset: offset must be between 0 and 1000000'
      using errcode = 'check_violation';
  end if;

  v_company := public.active_company_id();
  if v_company is null then
    raise exception 'no_active_company: this request is not scoped to a company'
      using errcode = 'check_violation';
  end if;

  -- Shape, as chat_run_readonly_query.
  v_sql := btrim(regexp_replace(coalesce(p_sql, ''), '^(\s+|--[^\n]*(\n|$)|/\*.*?\*/)+', ''), E' \t\r\n');
  if right(v_sql, 1) = ';' then
    v_sql := btrim(left(v_sql, length(v_sql) - 1), E' \t\r\n');
  end if;
  if v_sql !~* '^(select|with)\s' then
    raise exception 'query_not_allowed: only a single SELECT or WITH statement can run'
      using errcode = 'check_violation';
  end if;
  if strpos(v_sql, ';') > 0 then
    raise exception 'query_not_allowed: one statement only, with no semicolon'
      using errcode = 'check_violation';
  end if;

  v_refused := public.silo_sql_refused_function(v_sql);
  if v_refused is not null then
    raise exception 'query_not_allowed: the query calls %, which a read-only query may not use', v_refused
      using errcode = 'check_violation';
  end if;
  v_refused := public.silo_api_refused_name(v_sql);
  if v_refused is not null then
    raise exception 'query_not_allowed: % is not available to connections; describe_tables lists what is', v_refused
      using errcode = 'check_violation';
  end if;

  set local statement_timeout = '30s';
  -- Last thing set, as in chat_run_readonly_query. EXECUTE, not a bare SET.
  execute 'set transaction read only';

  -- json_agg, not jsonb_agg: keeps the select-list column order.
  execute format(
    'select coalesce(json_agg(t), ''[]''::json), count(*)::integer
       from (select * from (%s) q limit %s offset %s) t',
    v_sql, c_page_size, v_offset)
    into v_rows, v_count;

  return json_build_object(
    'company_entity_id', v_company,
    'timezone', public.silo_company_timezone(v_company),
    'generated_at', now(),
    'offset', v_offset,
    'page_size', c_page_size,
    'row_count', v_count,
    'has_more', v_count = c_page_size,
    'rows', v_rows);
end;
$$;

comment on function public.silo_api_query(text, integer) is
  'MCP / developer API query tool: one SELECT/WITH (no semicolon; no set_config or SQL-text functions; only relations Ask SILO''s catalog shows), run as the person under RLS for the grant''s company in a READ ONLY transaction, 30s, 1000 rows a page from p_offset. Requires data:read. SECURITY DEFINER owned by silo_api_exec, which owns no relations -- RLS decides the rows. 20261030110000.';

grant create on schema public to silo_api_exec;
alter function public.silo_api_query(text, integer) owner to silo_api_exec;
revoke create on schema public from silo_api_exec;
revoke all on function public.silo_api_query(text, integer) from public, anon, silo_revoked;
grant execute on function public.silo_api_query(text, integer) to silo_integration, authenticated;

notify pgrst, 'reload schema';
