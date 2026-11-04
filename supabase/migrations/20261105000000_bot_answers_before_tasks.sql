-- An answer beats a task, and the retired AR tables stop being an answer.
--
-- Two things the first live test of work:write showed, both the same mistake
-- in different places: SILO let a bot do a person's work by hand when SILO
-- already had the answer.
--
-- 1. A bot was asked "send me an open AR report for wholesale, tasked to
--    Brett". It created the task, and ALSO got the matching report back as a
--    hint (20261104230000) -- so Brett was left a job SILO had already done.
--    Blake: "if the create task flow found the answer, why create the task
--    instead of just give [it to] the creator of said task rather than
--    duplicative work for [the] receiver". Right. When the match is strong
--    the tool now returns the report and creates NOTHING; the bot delivers
--    the numbers. A weak match still creates the task and keeps the hint, and
--    a bot that really does want the task asks again with confirm.
--
-- 2. That same bot answered "what is owed" from ar_invoices -- the retired AR
--    import, frozen since the wholesale/AR surfaces moved onto Shopify order
--    status -- and reported $99,854.94 against the live $67,000.04. The
--    numbers were not wrong about the table; the table is not the answer any
--    more. So the retired ar_* relations leave the index bots and Ask SILO
--    are shown, which also makes them unnameable in bot SQL
--    (20261030110000), and shopify_orders_v says it is where receivables
--    live.
--
-- Also fixes report search ranking, which is why the bot had to guess at all:
-- "AR" is a substring of "marketing", "margin" and "year", so the search
-- returned 71 matches ordered by last-updated and buried the one report that
-- answers the question.
--
-- No data rows change. Catalog text, three functions. Needs 20261104230000.
-- Deploy: mcp (create_task gains confirm).

-- ── 1. The retired AR import leaves the bot index ─────────────────────────
-- Not dropped and not hidden from the app: the old page and its tables are
-- frozen history somebody may still want to read in SILO. They are simply no
-- longer offered as an answer, because the live answer comes from Shopify
-- order status.
update public.silo_chat_schema_catalog
   set is_hidden = true,
       reportable = false
 where relname in (
   'ar_invoices', 'ar_customers', 'ar_statements', 'ar_contact_log',
   'ar_action_queue', 'ar_customer_rollup_v', 'ar_invoice_workbench_v',
   'ar_customer_last_contact_v', 'ar_customer_queue_summary_v',
   'ar_sync_status_v');

-- And where receivables DO live, in the words someone asks the question in.
update public.silo_chat_schema_catalog
   set description = description ||
         ' Wholesale receivables live here: an order with payment_terms_name set and paid_at null'
      || ' and total_outstanding above zero is an open balance, payment_due_at is its due date.'
      || ' This is the source for AR, what customers owe, aging and collections -- not the retired AR import tables.',
       keywords = (
         select array_agg(distinct k)
         from unnest(coalesce(keywords, '{}'::text[])
                     || array['ar','accounts receivable','receivables','owed','open balance',
                              'aging','collections','payment terms','wholesale ar','unpaid']) k)
 where relname = 'shopify_orders_v'
   and coalesce(description, '') not like '%Wholesale receivables live here%';

-- ── 2. The hint learns how strong it is ───────────────────────────────────
-- Unchanged in what it looks at (SILO's own reports plus this company's
-- shared ones and this person's private ones, scored on shared words). Two
-- changes: a word now has to match at a WORD START, so "balance" still finds
-- "balances" but a short word stops matching the middle of a longer one; and
-- each match says whether it is strong. Strong means two or more of the
-- request's own words are in the report's TITLE -- "open AR report for
-- wholesale" against "Wholesale AR -- open balances (Shopify)". A match
-- carried only by the description stays weak, because a description is a
-- paragraph and two words in a paragraph prove very little.
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
    -- Words worth matching on: four letters or more, and not the words every
    -- request contains anyway (a report called "Daily sales" must not match
    -- every sentence with "daily" in it). Split on non-alphanumerics, so a
    -- word can never carry a regex metacharacter.
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
             where lower(c.title || ' ' || coalesce(c.description, '')) ~ ('\m' || w.w)) as hits
    from candidate c
  )
  select coalesce(json_agg(json_build_object(
           'report_id', x.id,
           'title', x.title,
           'description', left(x.description, 200),
           'verified', x.verified,
           'strength', case when x.title_hits >= 2 then 'strong' else 'weak' end,
           'url', 'https://get-silo.com/v3/report-builder.html?id=' || x.id::text)
         order by x.title_hits desc, x.hits desc, x.verified desc, x.title), '[]'::json)
  from (
    select * from scored
     where hits >= 2
     order by title_hits desc, hits desc, verified desc, title
     limit 3) x
$$;

comment on function public.silo_api_report_hint(uuid, uuid, text) is
  'The saved reports that look like the same request as a piece of text: SILO''s own reports plus the company''s shared ones and that person''s private ones, scored on words shared at a word start. Each match says strength: strong when two or more of the request''s words are in the report TITLE, weak otherwise. silo_api_create_task returns the report instead of creating anything on a strong match. 20261105000000.';

revoke all on function public.silo_api_report_hint(uuid, uuid, text) from public, anon;
grant execute on function public.silo_api_report_hint(uuid, uuid, text) to authenticated, silo_integration;

-- ── 3. The tool: an answer instead of a task ─────────────────────────────
create or replace function public.silo_api_create_task(
  p_title           text,
  p_notes           text default null,
  p_assignee_email  text default null,
  p_due_date        date default null,
  p_launch_id       uuid default null,
  p_priority        text default 'normal',
  p_idempotency_key text default null,
  p_confirm         boolean default false)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_grant     public.silo_api_grants;
  v_company   uuid;
  v_user      uuid;
  v_title     text;
  v_notes     text;
  v_priority  text;
  v_assignee  uuid;
  v_name      text;
  v_app       text;
  v_write     uuid;
  v_task      uuid;
  v_used      integer;
  v_hint      json;
  v_strong    boolean;
begin
  -- Scope first: this is also what records the call and keeps the connection
  -- from looking idle (20261103240000).
  perform public.silo_api_require_scope('work:write');

  -- Grant-only for now. The Ask SILO front door is a separate change: it runs
  -- as a signed-in person, where this function's definer rights would have to
  -- re-check their own authority rather than read it off a grant.
  if not public.silo_api_is_integration() then
    raise exception 'not_a_connection: this tool is for approved AI connections; use SILO itself to add a task'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_grant from public.silo_api_grant() limit 1;
  if v_grant.id is null then
    raise exception 'integration_revoked: this connection is no longer approved'
      using errcode = 'insufficient_privilege';
  end if;
  if v_grant.writes_paused_at is not null then
    raise exception 'writes_paused: writing is switched off for this connection in Connected apps'
      using errcode = 'insufficient_privilege';
  end if;

  -- The company is the GRANT's, never the session's.
  v_company := v_grant.company_entity_id;
  v_user    := v_grant.user_id;
  if v_company is null or v_user is null then
    raise exception 'integration_revoked: this connection is not bound to a company'
      using errcode = 'insufficient_privilege';
  end if;

  -- The person it acts as must still be a member of that company. A grant
  -- outlives a departure otherwise.
  if not exists (
    select 1 from public.entity_memberships em
    where em.user_id = v_user and em.entity_id = v_company) then
    raise exception 'not_a_member: the person who approved this connection is no longer in that company'
      using errcode = 'insufficient_privilege';
  end if;

  v_title := btrim(coalesce(p_title, ''));
  if v_title = '' then
    raise exception 'invalid_title: a task needs a title'
      using errcode = 'check_violation';
  end if;
  if length(v_title) > 200 then
    raise exception 'invalid_title: keep the title under 200 characters and put the detail in notes'
      using errcode = 'check_violation';
  end if;

  v_notes := nullif(btrim(coalesce(p_notes, '')), '');
  if length(coalesce(v_notes, '')) > 4000 then
    raise exception 'invalid_notes: notes must be under 4000 characters'
      using errcode = 'check_violation';
  end if;

  v_priority := lower(btrim(coalesce(p_priority, 'normal')));
  if v_priority = '' then v_priority := 'normal'; end if;
  if v_priority not in ('low', 'normal', 'high') then
    raise exception 'invalid_priority: priority must be low, normal or high'
      using errcode = 'check_violation';
  end if;

  if p_due_date is not null
     and (p_due_date < current_date - interval '1 year'
          or p_due_date > current_date + interval '5 years') then
    raise exception 'invalid_due_date: a due date that far from today is a mistake'
      using errcode = 'check_violation';
  end if;

  -- An assignee must be a member of the grant's company. Resolved by email,
  -- because that is what a person says to a bot, and matched case-insensitively
  -- but exactly -- never a prefix, never the first of several.
  if nullif(btrim(coalesce(p_assignee_email, '')), '') is not null then
    select p.id, coalesce(nullif(btrim(p.name), ''), p.email)
      into v_assignee, v_name
    from public.profiles p
    join public.entity_memberships em
      on em.user_id = p.id and em.entity_id = v_company
    where lower(p.email) = lower(btrim(p_assignee_email))
    limit 1;

    if v_assignee is null then
      raise exception 'unknown_assignee: % is not a member of this company', btrim(p_assignee_email)
        using errcode = 'check_violation';
    end if;
  end if;

  if p_launch_id is not null
     and not exists (
       select 1 from public.launch_calendar lc
       where lc.id = p_launch_id and lc.company_entity_id = v_company) then
    raise exception 'unknown_launch: that launch is not in this company'
      using errcode = 'check_violation';
  end if;

  -- ── The answer beats the task ───────────────────────────────────────────
  -- Looked up BEFORE anything is created, and before the cap is spent. If
  -- SILO already reports what was asked for, the person who asked wants the
  -- numbers, not a colleague doing by hand what SILO does in a second.
  -- Only a STRONG match stops the write (two or more of the request's own
  -- words in the report's title); a weak one still creates the task and
  -- carries the hint, because swallowing a real task would be worse than an
  -- extra one. p_confirm is the way back: a bot told "no, still make the
  -- task" says so and it is made.
  v_hint := public.silo_api_report_hint(v_company, v_user, v_title || ' ' || coalesce(v_notes, ''));
  v_strong := exists (
    select 1 from json_array_elements(v_hint) e
    where e->>'strength' = 'strong');

  if v_strong and not coalesce(p_confirm, false) then
    return json_build_object(
      'created', false,
      'reason', 'answer_exists',
      'title', v_title,
      'report_matches', v_hint,
      'next_step', 'SILO already reports this. No task was created. Run this report and give the person the numbers (silo_api_run_report, or send them the url). If they really do want a task opened as well, call this tool again with confirm set to true.');
  end if;

  -- The application's own name, stored ON the row. The task list must be able
  -- to say "Via Claude" to everyone who can see the task, and a colleague
  -- cannot read somebody else's grant -- so resolving it at read time would
  -- show the name to its owner and "an app" to the team. auth.oauth_clients is
  -- reachable here because this function is definer; client_id is compared as
  -- text so a non-uuid registration cannot raise.
  select nullif(btrim(c.client_name), '')
    into v_app
  from auth.oauth_clients c
  where c.id::text = v_grant.client_id
    and c.deleted_at is null;
  v_app := coalesce(v_app, nullif(split_part(coalesce(v_grant.app_key, ''), '|', 1), ''), 'an app');

  -- The cap, over a rolling day. Counted from the ledger, so a replay does not
  -- spend a second write.
  select count(*) into v_used
  from public.silo_api_writes w
  where w.grant_id = v_grant.id
    and w.created_at > now() - interval '1 day';
  if v_used >= public.silo_api_write_cap() then
    raise exception 'write_cap_reached: this connection has used its % writes for today', public.silo_api_write_cap()
      using errcode = 'check_violation';
  end if;

  -- Claim the key BEFORE the task exists, so two parallel retries cannot both
  -- create one. If the key is already claimed, hand back the first task.
  if nullif(btrim(coalesce(p_idempotency_key, '')), '') is not null then
    insert into public.silo_api_writes
      (company_entity_id, grant_id, user_id, via, kind, idempotency_key)
    values
      (v_company, v_grant.id, v_user, 'app', 'task', btrim(p_idempotency_key))
    on conflict (grant_id, kind, idempotency_key) where idempotency_key is not null and grant_id is not null
      do nothing
    returning id into v_write;

    if v_write is null then
      select w.target_id into v_task
      from public.silo_api_writes w
      where w.grant_id = v_grant.id
        and w.kind = 'task'
        and w.idempotency_key = btrim(p_idempotency_key);

      return json_build_object(
        'created', true,
        'task_id', v_task,
        'url', 'https://get-silo.com/v2/tasks.html?task=' || coalesce(v_task::text, ''),
        'replayed', true,
        'report_matches', v_hint);
    end if;
  else
    insert into public.silo_api_writes
      (company_entity_id, grant_id, user_id, via, kind, idempotency_key)
    values
      (v_company, v_grant.id, v_user, 'app', 'task', null)
    returning id into v_write;
  end if;

  insert into public.launch_tasks
    (company_entity_id, launch_id, task_title, notes, status, priority,
     due_date, assigned_to_user_id, assigned_to_name, is_private,
     created_by, created_by_grant_id, created_via, created_by_app)
  values
    (v_company, p_launch_id, v_title, v_notes, 'open', v_priority,
     p_due_date, v_assignee, v_name, false,
     v_user, v_grant.id, 'app', v_app)
  returning id into v_task;

  update public.silo_api_writes set target_id = v_task where id = v_write;

  return json_build_object(
    'created', true,
    'task_id', v_task,
    'url', 'https://get-silo.com/v2/tasks.html?task=' || v_task::text,
    'title', v_title,
    'created_by_app', v_app,
    'assigned_to', v_name,
    'due_date', p_due_date,
    'replayed', false,
    'report_matches', v_hint,
    'next_step', case when v_hint::text <> '[]'
      then 'A SILO report looks related. Have a look before anyone does this by hand -- it may already answer the request, in which case send the person the report and tell them the task is there if they still want it.'
      end);
end;
$$;

comment on function public.silo_api_create_task(text, text, text, date, uuid, text, text, boolean) is
  'MCP / developer API write tool: opens ONE task in the grant''s company, as the person who approved the connection, marked created_via = app with the grant on the row. Creates only -- it cannot read, change, reassign, complete or delete an existing task. Refuses an assignee or launch outside that company, a paused connection, and more than silo_api_write_cap() writes a rolling day; an idempotency key makes a retry return the first task. Creates NOTHING and returns the report when a saved report strongly matches the request, unless p_confirm is true: a bot should deliver the answer rather than leave a person to produce it by hand. A weak match still creates the task and carries the hint. Requires work:write. SECURITY DEFINER: the company and the person come from the grant row, never from the session. 20261105000000.';

revoke all on function public.silo_api_create_task(text, text, text, date, uuid, text, text, boolean) from public, anon, authenticated, silo_revoked;
grant execute on function public.silo_api_create_task(text, text, text, date, uuid, text, text, boolean) to silo_integration;


-- The seven-argument version goes: left in place, a call that passes seven
-- positional arguments is ambiguous between the two. Dropped AFTER the new
-- one exists, so the tool is never missing.
drop function if exists public.silo_api_create_task(text, text, text, date, uuid, text, text);

-- ── 4. Report search that puts the right report first ────────────────────
-- Why the bot was guessing at AR in the first place: searching "AR" matched
-- 71 reports -- "AR" is inside "marketing", "margin" and "year" -- and the
-- ten it returned were the ten most recently updated, which is not what
-- anybody means by a search. A whole-word hit in the title now outranks a
-- substring, and a substring in the title outranks one buried in a
-- description. Same limit, same shape, same scope; only the order changes.
create or replace function public.silo_api_list_reports(p_search text)
returns json
language plpgsql
-- VOLATILE, not stable: PostgREST picks a request's access mode from the
-- function's volatility, so a STABLE function runs read-only and the call
-- cannot be recorded (20261104030000, measured on production). Re-creating
-- this function as STABLE would silently undo that fix.
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

  -- Search-only: no term, no list.
  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_search is null or length(v_search) < 2 then
    raise exception 'search_required: give a search term of 2 or more characters (words in the report title or description)'
      using errcode = 'check_violation';
  end if;

  -- A plain substring, never a pattern: % and _ in the search are literal.
  -- Two escaped copies: one for LIKE, one for the word-boundary regex used to
  -- rank. A search like "AR" is a substring of "marketing", "margin" and
  -- "year", so a plain substring match buries the report somebody meant.
  v_word   := regexp_replace(v_search, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g');
  v_search := replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_');

  -- Shared reports and the caller's own; RLS on the view adds the company.
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
    -- A whole-word hit in the TITLE is what someone searching means; a
    -- substring buried in a description is the weakest evidence there is.
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
  'Developer API / MCP: the company reports a connection may see that match a search term -- shared reports plus the caller''s own, never SILO''s own system reports. Ranked: a whole-word hit in the title, then a substring in the title, then the description; ties by last updated. Ten at a time. Requires reports:read. 20261105000000.';

revoke all on function public.silo_api_list_reports(text) from public, anon, silo_revoked;
grant execute on function public.silo_api_list_reports(text) to silo_integration, authenticated;

notify pgrst, 'reload schema';
