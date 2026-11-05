-- Point at the dashboard, not at one tile of it.
--
-- The answer-first gate (20261105000000) worked on its first live use: asked
-- to task a colleague with "send me an open AR report for wholesale", the bot
-- created nothing and delivered the report instead. But it handed over the
-- REPORT link, and the person's next question was "you linked to report
-- instead of the dashboard why?" -- the bot had no way to know the report was
-- one of three tiles on a dashboard, so it guessed the dashboard URL from a
-- screenshot.
--
-- A dashboard is the fuller answer wherever one exists: it carries the
-- report's own tiles plus whatever else is on the page, and it is the page a
-- person would have been sent to. The link is already in the data
-- (dashboard_widgets.report_id), so both the hint and the search now return
-- the dashboard a report lives on, and a report that lives on one sorts
-- first among equals.
--
-- Nothing here is company-specific and no row changes. Two functions.
-- Needs 20261105000000. Deploy: mcp (the tool text that says which link to
-- send).

-- ── 1. A report's dashboard, where the caller may see it ──────────────────
-- Visibility is judged exactly as the report side is: a company dashboard, or
-- a private one belonging to the person this connection acts as. A dashboard
-- somebody else keeps private is not named, not even as a title.
--
-- SQL, STABLE, definer: it is a lookup used inside the two functions below,
-- which are themselves definer, and it must not be callable to enumerate
-- dashboards on its own -- hence no grant to authenticated beyond what those
-- need.
create or replace function public.silo_api_report_dashboard(
  p_report  uuid,
  p_company uuid,
  p_user    uuid)
returns json
language sql
stable
security definer
set search_path = ''
as $$
  select json_build_object(
           'dashboard_id', d.id,
           'name', d.name,
           'url', 'https://get-silo.com/v3/dashboard.html?id=' || d.id::text)
    from public.dashboard_widgets w
    join public.dashboards d on d.id = w.dashboard_id
   where w.report_id = p_report
     and d.company_entity_id = p_company
     and (d.visibility = 'company' or d.created_by = p_user)
   order by (d.visibility = 'company') desc, d.updated_at desc nulls last, d.id
   limit 1
$$;

comment on function public.silo_api_report_dashboard(uuid, uuid, uuid) is
  'The dashboard a saved report is tiled on, when there is one the given person may see (a company dashboard, or their own private one). INTERNAL: it takes the company and the person as arguments and trusts them, so no client role may call it -- only the checked entry points (silo_api_create_task, silo_api_list_reports, silo_api_report_hint), which read both off the grant or the session. Null when the report is on no dashboard. 20261105003000.';

-- No client role, by design. Both of this file's helpers take the company and
-- the person as ARGUMENTS and trust them, which is safe only because the
-- caller is always one of SILO's own definer entry points, where those two
-- values come from the grant row or auth.uid(). Granted to a signed-in
-- person, the same function would let anyone name a colleague's id and read
-- the title of a dashboard they keep private. silo_api_exec is granted
-- because silo_api_list_reports is owned by it and a definer function's
-- calls are checked against its OWNER, not its caller.
revoke all on function public.silo_api_report_dashboard(uuid, uuid, uuid)
  from public, anon, authenticated, silo_integration, silo_revoked;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'silo_api_exec') then
    execute 'grant execute on function public.silo_api_report_dashboard(uuid, uuid, uuid) to silo_api_exec';
  end if;
end $$;

-- ── 2. The hint carries it ────────────────────────────────────────────────
-- Same candidates, same scoring, same strength rule as 20261105000000. Two
-- changes: every match carries its dashboard (null when it has none), and
-- among equally good matches the one that lives on a dashboard wins, because
-- that is the better thing to send.
create or replace function public.silo_api_report_hint(
  p_company uuid,
  p_user    uuid,
  p_text    text)
returns json
language sql
stable
security definer
set search_path = ''
as $$
  with words as (
    select distinct w
    from regexp_split_to_table(lower(coalesce(p_text, '')), '[^a-z0-9]+') as w
    where length(w) >= 4
      and w <> all (array['report','reports','please','send','task','tasks','tasked',
                          'need','needs','needed','make','create','created','with',
                          'from','this','that','then','into','over','team','email',
                          'about','asap','want','wants','give','pull','check','look',
                          'every','daily','weekly','monthly','update','updated','silo',
                          'thanks','today','tomorrow','morning'])
  ), candidate as (
    select s.id, s.title, s.description, (s.source = 'system') as verified
    from public.silo_chat_saved_reports s
    where s.archived_at is null
      and coalesce(array_length(s.queries_run, 1), 0) > 0
      and (s.source = 'system'
           or (s.company_entity_id = p_company
               and (s.visibility = 'company' or s.created_by = p_user)))
  ), scored as (
    select c.*,
           (select count(*) from words w
             where lower(c.title) ~ ('\m' || w.w)) as title_hits,
           (select count(*) from words w
             where lower(c.title || ' ' || coalesce(c.description, '')) ~ ('\m' || w.w)) as hits,
           public.silo_api_report_dashboard(c.id, p_company, p_user) as dashboard
    from candidate c
  )
  select coalesce(json_agg(json_build_object(
           'report_id', x.id,
           'title', x.title,
           'description', left(x.description, 200),
           'verified', x.verified,
           'strength', case when x.title_hits >= 2 then 'strong' else 'weak' end,
           'dashboard', x.dashboard,
           'url', 'https://get-silo.com/v3/report-builder.html?id=' || x.id::text)
         order by x.title_hits desc, x.hits desc, (x.dashboard is not null) desc,
                  x.verified desc, x.title), '[]'::json)
  from (
    select * from scored
     where hits >= 2
     order by title_hits desc, hits desc, (dashboard is not null) desc, verified desc, title
     limit 3) x
$$;

comment on function public.silo_api_report_hint(uuid, uuid, text) is
  'The saved reports that look like the same request as a piece of text: SILO''s own reports plus the company''s shared ones and that person''s private ones, scored on words shared at a word start. Each match says strength (strong when two or more of the request''s words are in the report TITLE) and the dashboard it is tiled on, where the caller may see one. silo_api_create_task returns the report instead of creating anything on a strong match. 20261105003000.';

-- Same reasoning, and this one closes a hole that predates the dashboard:
-- the hint has taken the person as an argument since 20261104230000 while
-- being executable by `authenticated`, so a signed-in member could have named
-- a colleague's id and read the titles of that colleague's PRIVATE saved
-- reports. Nothing in SILO calls it from a browser -- silo_api_create_task is
-- its only caller -- so it becomes internal too. Ask SILO's own copy of this
-- behaviour, when it is built, must resolve the person from the session
-- rather than be handed one.
revoke all on function public.silo_api_report_hint(uuid, uuid, text)
  from public, anon, authenticated, silo_integration, silo_revoked;

-- ── 3. So does the search ─────────────────────────────────────────────────
-- Same function as 20261105000000, still VOLATILE for the reason stated
-- there (PostgREST picks the access mode from volatility, so a STABLE
-- re-creation would stop the call being logged), with one field added.
create or replace function public.silo_api_list_reports(p_search text)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_limit constant integer := 10;
  c_max_options constant integer := 10;
  v_company uuid;
  v_search  text;
  v_word    text;
  v_rows    json;
  v_total   integer;
begin
  perform public.silo_api_require_scope('reports:read');

  v_company := public.active_company_id();
  if v_company is null then
    raise exception 'no_active_company: this request is not scoped to a company'
      using errcode = 'check_violation';
  end if;

  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_search is null or length(v_search) < 2 then
    raise exception 'search_required: give a search term of 2 or more characters (words in the report title or description)'
      using errcode = 'check_violation';
  end if;

  v_word   := regexp_replace(v_search, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g');
  v_search := replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_');

  with visible as (
    select s.*
      from public.silo_chat_saved_reports_v s
     where s.source <> 'system'
       and (s.visibility = 'company' or s.created_by = auth.uid())
       and s.archived_at is null
       and coalesce(array_length(s.queries_run, 1), 0) > 0
       and (s.title ilike '%' || v_search || '%'
            or s.description ilike '%' || v_search || '%')
  ), scored as (
    select v.*,
           (case when v.title ~* ('\m' || v_word) then 4
                 when v.title ilike '%' || v_search || '%' then 3
                 when coalesce(v.description, '') ~* ('\m' || v_word) then 2
                 else 1 end) as match_rank
      from visible v
  ), page as (
    select s.*
      from scored s
     order by s.match_rank desc, s.updated_at desc nulls last, s.id
     limit c_limit
  )
  select (select count(*)::integer from visible),
         coalesce(json_agg(json_build_object(
           'id', p.id,
           'title', p.title,
           'description', left(p.description, 200),
           'kind', 'company',
           'verified', false,
           'sharing', case when p.visibility = 'company' then 'shared' else 'private' end,
           'created_by', p.created_by_name,
           -- The page this report is a tile of, when the caller may see one:
           -- send that rather than the single report.
           'dashboard', public.silo_api_report_dashboard(p.id, v_company, auth.uid()),
           'parameters', (
             select coalesce(json_agg(
                      (e - 'options')
                      || case when coalesce(jsonb_typeof(e->'options'), '') <> 'array' then '{}'::jsonb
                              when jsonb_array_length(e->'options') <= c_max_options
                                then jsonb_build_object('options', e->'options')
                              else jsonb_build_object(
                                     'options', (select jsonb_agg(o) from (
                                        select o from jsonb_array_elements(e->'options') with ordinality x(o, n)
                                         where n <= c_max_options) y),
                                     'options_total', jsonb_array_length(e->'options'),
                                     'options_note', 'Only the first ' || c_max_options || ' options are listed.')
                         end
                      order by n), '[]'::json)
               from jsonb_array_elements(coalesce(p.parameters, '[]'::jsonb)) with ordinality t(e, n)),
           'query_count', coalesce(array_length(p.queries_run, 1), 0),
           'updated_at', p.updated_at)
           order by p.match_rank desc, p.updated_at desc nulls last, p.id), '[]'::json)
    into v_total, v_rows
    from page p;

  return json_build_object(
    'reports', v_rows,
    'total', v_total,
    'shown', least(v_total, c_limit),
    'note', case when v_total > c_limit
                 then 'Only the ' || c_limit || ' closest matches are shown, best first. Search for something more specific.' end,
    'company_entity_id', v_company,
    'timezone', public.silo_company_timezone(v_company),
    'generated_at', now());
end;
$$;

comment on function public.silo_api_list_reports(text) is
  'Developer API / MCP: the company reports a connection may see that match a search term -- shared reports plus the caller''s own, never SILO''s own system reports. Ranked: a whole-word hit in the title, then a substring in the title, then the description; ties by last updated. Each carries the dashboard it is tiled on, where there is one. Ten at a time. Requires reports:read. 20261105003000.';

revoke all on function public.silo_api_list_reports(text) from public, anon, silo_revoked;
grant execute on function public.silo_api_list_reports(text) to silo_integration, authenticated;

-- ── 4. Say which link to send ─────────────────────────────────────────────
-- Only the two sentences the bot reads change; the gate itself is untouched.
do $$
declare
  v_src text := pg_get_functiondef(
    to_regprocedure('public.silo_api_create_task(text, text, text, date, uuid, text, text, boolean)'));
begin
  if v_src is null then
    raise exception 'silo_api_create_task is missing: apply 20261105000000 first';
  end if;

  -- Already rewritten: apply_all_post_merge.sql replays every file, and a
  -- second pass has nothing to do.
  if position('Send them its dashboard url where the match has one' in v_src) > 0 then
    return;
  end if;

  -- Asserted, not hoped: a replace that matches nothing leaves the old
  -- sentence in place and says nothing about it, which is exactly the kind of
  -- silence this pair of migrations exists to remove.
  if position('Run this report and give the person the numbers (silo_api_run_report, or send them the url).' in v_src) = 0
     or position('A SILO report looks related. Have a look before anyone does this by hand' in v_src) = 0 then
    raise exception 'silo_api_create_task does not carry the next_step sentences this migration rewrites; apply 20261105000000 first, or restate the function here';
  end if;

  v_src := replace(v_src,
    'Run this report and give the person the numbers (silo_api_run_report, or send them the url).',
    'Run this report and give the person the numbers (silo_api_run_report). Send them its dashboard url where the match has one, because that is the whole page rather than one tile of it, and its report url otherwise.');
  v_src := replace(v_src,
    'A SILO report looks related. Have a look before anyone does this by hand',
    'A SILO report looks related (send its dashboard url where it has one). Have a look before anyone does this by hand');

  execute v_src;
end $$;

notify pgrst, 'reload schema';
