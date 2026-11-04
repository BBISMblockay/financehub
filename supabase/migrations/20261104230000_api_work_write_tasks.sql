-- work:write, part one: a connection can open a task. Nothing else.
--
-- WHY A WRITE AT ALL. Every SILO AI connection is read-only today, so a bot
-- that notices something has no way to leave a record where the work happens:
-- the person has to retype it into SILO later, or it is lost. The first write
-- is the smallest one that is useful and fully recoverable -- CREATE a task --
-- and it is recoverable because a wrong task is deleted in one click by anyone
-- who can see it.
--
-- WHAT THIS DELIBERATELY CANNOT DO. It cannot touch anything that already
-- exists: no status change, no reassignment, no edit, no delete, nothing on
-- another company's rows, and nothing in money, approvals or outbound
-- messages. Blake's rule, 2026-11-04: "if exists, can't change, can link to it
-- with url or make comment." Creating is recoverable; editing someone's row
-- silently is not, and nothing in the audit screen would show the old value.
--
-- HOW AUTHORITY WORKS HERE. The integration role holds NO table privileges --
-- not on launch_tasks, not on anything (checked on production 2026-11-04) --
-- and silo_api_path_allowed() admits only the /rpc/ paths named in it. So a
-- connection reaches a table through exactly one named function, and this
-- migration adds one. It is SECURITY DEFINER, like every other silo_api_*
-- tool, and it re-checks by hand what RLS would have checked: the company
-- comes from the GRANT row, never from the session; an assignee must be a
-- member of that company; a launch must belong to it.
--
-- WHO IS RECORDED. The write is the person's -- they approved the connection
-- and it acts as them -- so created_by stays their id. What is new is that the
-- row says so: created_by_grant_id names the connection and created_via says
-- 'app'. That is Blake's "tagged with their bot as generator", and the task
-- list shows it as "Via <app name>". A row with both columns null is a person
-- typing, which is every row that exists today.
--
-- THE TWO LIMITS THAT MAKE IT SAFE TO HAND OUT.
--   * An idempotency key per write. A bot that times out and retries gets the
--     SAME task back, not a second one. Without this the first flaky network
--     day produces duplicates nobody can tell apart.
--   * A cap of silo_api_write_cap() writes per connection per rolling day
--     (50, in one place, like silo_api_app_connection_limit()). A loop is then
--     a refusal, not four hundred tasks. The same table is what a usage bill
--     would read.
--
-- NOT HERE, ON PURPOSE: the Ask SILO front door (the same RPC, exposed as a
-- model tool in silo-chat, which needs a deploy) and the save-a-report write.
-- Both are their own change; this one is grant-only, so `authenticated` is not
-- given execute on it yet.
begin;

-- ── 1. The scope ──────────────────────────────────────────────────────────
-- silo_api_consent() is the allowlist of scopes that can be granted at all.
-- Re-stated from production 2026-11-04 (20261104020000's version, read back
-- with pg_get_functiondef) with ONE line changed: c_offered. Everything else
-- -- the slot rules, the advisory lock, the aal2 check -- is byte-identical in
-- meaning, and the body is not restructured, because this migration is about a
-- scope and a restructure here would be unreviewable.
create or replace function public.silo_api_consent(
  p_client_id text,
  p_scopes text[] default array['reports:read'])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- data:read since 20261030110000 (the query tool).
  -- work:write since 20261104230000: creating a task. Asked for separately on
  -- the consent screen and never implied by a read scope.
  c_offered constant text[] := array['reports:read', 'data:read', 'work:write'];
  v_user    uuid;
  v_company uuid;
  v_aal     text;
  v_scopes  text[];
  v_app     text;
  v_gen     integer;
  v_limit   integer;
  v_slot    integer;
  v_evict   uuid;
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
  -- reports it. An OAuth token reads aal1 forever, so the only evidence
  -- two-factor approval happened is what was true HERE, at this moment.
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

  -- Up to silo_api_app_connection_limit() live connections per person per
  -- APPLICATION (20261102180000, slots 20261104020000).
  v_app   := public.silo_api_app_key(p_client_id);
  v_limit := public.silo_api_app_connection_limit();

  perform pg_advisory_xact_lock(
    hashtextextended(v_app || ':' || v_user::text, 0));

  select coalesce(max(g.generation), 0) into v_gen
  from public.silo_api_grants g
  where g.app_key = v_app and g.user_id = v_user;

  -- Rule 1: an authorization that never received a token is nobody's
  -- connection.
  update public.silo_api_grants
     set revoked_at = now()
   where app_key = v_app
     and user_id = v_user
     and revoked_at is null
     and auth_session_id is null
     and last_used_at is null;

  -- Rule 1b: this person's live grant for THIS SAME client registration.
  update public.silo_api_grants
     set revoked_at = now()
   where client_id = trim(p_client_id)
     and user_id = v_user
     and revoked_at is null;

  -- Rule 2: the lowest free slot, or the least recently used connection's.
  select s.n into v_slot
  from generate_series(0, v_limit - 1) as s(n)
  where not exists (
    select 1 from public.silo_api_grants g
    where g.app_key = v_app
      and g.user_id = v_user
      and g.revoked_at is null
      and g.slot = s.n)
  order by s.n
  limit 1;

  if v_slot is null then
    select g.id, g.slot into v_evict, v_slot
    from public.silo_api_grants g
    where g.app_key = v_app
      and g.user_id = v_user
      and g.revoked_at is null
      and g.slot < v_limit
    order by g.last_used_at desc nulls last, g.consented_at desc, g.id
    offset greatest(v_limit - 1, 0)
    limit 1;

    if v_evict is null then
      raise exception 'no_connection_slot: disconnect one of your existing connections to this application first'
        using errcode = 'check_violation';
    end if;

    update public.silo_api_grants
       set revoked_at = now()
     where id = v_evict
       and revoked_at is null;
  end if;

  insert into public.silo_api_grants
    (client_id, app_key, slot, user_id, company_entity_id, auth_session_id,
     generation, scopes, consented_aal, consented_at, expires_at)
  values
    (trim(p_client_id), v_app, v_slot, v_user, v_company, null,
     v_gen + 1, v_scopes, v_aal, now(), now() + interval '90 days')
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.silo_api_consent(text, text[]) is
  'Writes the SILO grant row for an approved application: aal2 required, scopes from the allowlist (reports:read, data:read, work:write), up to silo_api_app_connection_limit() live connections per person per application in numbered slots. 20261020030000; app_key 20261102180000; slots 20261104020000; work:write 20261104230000.';

revoke all on function public.silo_api_consent(text, text[]) from public, anon;
grant execute on function public.silo_api_consent(text, text[]) to authenticated;

-- The person can stop a connection writing WITHOUT disconnecting it. Scopes
-- are frozen by silo_api_grants_frozen(), deliberately, so the pause is its
-- own column rather than a scope edit: the grant still says what was approved,
-- and this says whether writing is on right now.
alter table public.silo_api_grants
  add column if not exists writes_paused_at timestamptz;

comment on column public.silo_api_grants.writes_paused_at is
  'When the person (or an owner) paused this connection''s writes. Reads are unaffected. Null means writing is on, if work:write was granted at all. Not a scope change: scopes are frozen. 20261104230000.';

-- ── 2. The path ───────────────────────────────────────────────────────────
-- Re-stated from 20261103210000 with one path added. Every other path is
-- refused by silo_check_request() before the request reaches a table.
create or replace function public.silo_api_path_allowed()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('request.path', true), '') in (
    '/rpc/silo_api_run_report', '/rpc/silo_api_list_reports',
    '/rpc/silo_api_describe_tables', '/rpc/silo_api_query',
    '/rpc/silo_api_windsor_connections',
    '/rpc/silo_api_create_task')
$$;

comment on function public.silo_api_path_allowed() is
  'True when a third-party OAuth request is on one of the paths the developer platform exposes: running and listing reports (reports:read), describing tables, running a read-only query and reading published connections (data:read), and opening a task (work:write). Every other path is refused by silo_check_request(). 20261030050000; query 20261030110000; connections 20261103210000; create_task 20261104230000.';

-- ── 3. The write ledger: idempotency, the cap, and the bill ────────────────
create table if not exists public.silo_api_writes (
  id               uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null,
  grant_id         uuid references public.silo_api_grants(id) on delete set null,
  user_id          uuid,
  via              text not null,
  kind             text not null,
  target_id        uuid,
  idempotency_key  text,
  created_at       timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.silo_api_writes'::regclass
                    and conname = 'silo_api_writes_via_check') then
    alter table public.silo_api_writes
      add constraint silo_api_writes_via_check check (via in ('app', 'ask_silo'));
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.silo_api_writes'::regclass
                    and conname = 'silo_api_writes_kind_check') then
    alter table public.silo_api_writes
      add constraint silo_api_writes_kind_check check (kind in ('task'));
  end if;
end $$;

comment on table public.silo_api_writes is
  'One row per write a SILO AI connection made (or replayed): company, connection, person, which kind, which row, and the caller''s idempotency key. Three jobs: a retry returns the first result instead of a second row, the day''s count is what the per-connection cap reads, and it is what a usage bill would read. Written only by the silo_api_* write tools. 20261104230000.';

-- A retry is the same write. Partial, because a key is optional and a grant
-- can be deleted out from under the row.
create unique index if not exists silo_api_writes_idempotent
  on public.silo_api_writes (grant_id, kind, idempotency_key)
  where idempotency_key is not null and grant_id is not null;

create index if not exists silo_api_writes_grant_time_idx
  on public.silo_api_writes (grant_id, created_at desc);
create index if not exists silo_api_writes_company_time_idx
  on public.silo_api_writes (company_entity_id, created_at desc);

alter table public.silo_api_writes enable row level security;

-- Same stance as silo_api_call_log: readable by the person who approved the
-- connection and by an owner or executive of the company, and writable by
-- nobody through a client role.
drop policy if exists silo_api_writes_select on public.silo_api_writes;
create policy silo_api_writes_select on public.silo_api_writes
  for select using (
    company_entity_id = public.active_company_id()
    and (user_id = auth.uid() or public.is_exec_or_owner()));

revoke all on public.silo_api_writes from anon, authenticated;
grant select on public.silo_api_writes to authenticated;

-- The cap in one place, for the same reason silo_api_app_connection_limit()
-- exists: it is a policy number and changing it has to be one edit.
create or replace function public.silo_api_write_cap()
returns integer language sql immutable set search_path = '' as $$
  select 50
$$;

comment on function public.silo_api_write_cap() is
  'Writes one connection may make per rolling day. 50, Blake 2026-11-04, metered in silo_api_writes so volume can be billed later. 20261104230000.';

revoke all on function public.silo_api_write_cap() from public, anon;
grant execute on function public.silo_api_write_cap() to authenticated, silo_integration;

-- ── 3b. "This is already a SILO report" ───────────────────────────────────
-- Blake, 2026-11-04: "if server knows the answer or can complete said task
-- with its tools, it should mention. Example: Send me an open AR report for
-- wholesale -- tasked to Brett -- via loomis. Servers should recognize well
-- this is just a silo report and we don't need a task, we just need to
-- deliver the link and report."
--
-- So every task a connection opens comes back with the reports that look like
-- the same request, and the tool's own description tells the bot to deliver
-- one instead of making a person do it by hand. It is a HINT, not a refusal:
-- guessing wrong and swallowing a real task would be worse than an extra
-- task, which anyone deletes in one click. The bot can then run the report
-- itself (silo_api_run_report) or hand over the link.
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
    -- every sentence with "daily" in it).
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
    -- The same reports a connection may already list: SILO's own tied-out
    -- reports, plus this company's shared reports and this person's private
    -- ones. The company and the person come from the grant, not the session.
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
             where position(w.w in lower(c.title || ' ' || coalesce(c.description, ''))) > 0) as hits
    from candidate c
  )
  select coalesce(json_agg(json_build_object(
           'report_id', x.id,
           'title', x.title,
           'description', left(x.description, 200),
           'verified', x.verified,
           'url', 'https://get-silo.com/v3/report-builder.html?id=' || x.id::text)
         order by x.hits desc, x.verified desc, x.title), '[]'::json)
  from (
    select * from scored
     where hits >= 2
     order by hits desc, verified desc, title
     limit 3) x
$$;

comment on function public.silo_api_report_hint(uuid, uuid, text) is
  'The saved reports that look like the same request as a piece of text: SILO''s own reports plus the company''s shared ones and that person''s private ones, scored on shared words. Used by the write tools to answer "this is already a report" rather than leaving a person to run it by hand. A hint only -- it never refuses a write. 20261104230000.';

revoke all on function public.silo_api_report_hint(uuid, uuid, text) from public, anon;
grant execute on function public.silo_api_report_hint(uuid, uuid, text) to authenticated, silo_integration;

-- ── 4. The tool ───────────────────────────────────────────────────────────
create or replace function public.silo_api_create_task(
  p_title           text,
  p_notes           text default null,
  p_assignee_email  text default null,
  p_due_date        date default null,
  p_launch_id       uuid default null,
  p_priority        text default 'normal',
  p_idempotency_key text default null)
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
        'task_id', v_task,
        'url', 'https://get-silo.com/v2/tasks.html?task=' || coalesce(v_task::text, ''),
        'replayed', true,
        'report_matches', public.silo_api_report_hint(v_company, v_user, v_title || ' ' || coalesce(v_notes, '')));
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

  -- "This is already a SILO report." Looked up AFTER the task exists, so a
  -- slow or empty hint can never be the reason a task was lost.
  v_hint := public.silo_api_report_hint(v_company, v_user, v_title || ' ' || coalesce(v_notes, ''));

  return json_build_object(
    'task_id', v_task,
    'url', 'https://get-silo.com/v2/tasks.html?task=' || v_task::text,
    'title', v_title,
    'created_by_app', v_app,
    'assigned_to', v_name,
    'due_date', p_due_date,
    'replayed', false,
    'report_matches', v_hint,
    'next_step', case when v_hint::text <> '[]'
      then 'SILO already has a report that looks like this request. Send the person the report (or run it and give them the numbers) instead of leaving the task for someone to do by hand -- and tell them the task is there if they still want it.'
      end);
end;
$$;

comment on function public.silo_api_create_task(text, text, text, date, uuid, text, text) is
  'MCP / developer API write tool: opens ONE task in the grant''s company, as the person who approved the connection, marked created_via = app with the grant on the row. Creates only -- it cannot read, change, reassign, complete or delete an existing task. Refuses an assignee or launch outside that company, a paused connection, and more than silo_api_write_cap() writes a rolling day; an idempotency key makes a retry return the first task. Returns any saved report that looks like the same request, so a bot can deliver the report instead of leaving the work to a person. Requires work:write. SECURITY DEFINER: the company and the person come from the grant row, never from the session. 20261104230000.';

revoke all on function public.silo_api_create_task(text, text, text, date, uuid, text, text) from public, anon, authenticated, silo_revoked;
grant execute on function public.silo_api_create_task(text, text, text, date, uuid, text, text) to silo_integration;

-- ── 5. The task row says where it came from ───────────────────────────────
alter table public.launch_tasks
  add column if not exists created_by_grant_id uuid references public.silo_api_grants(id) on delete set null,
  add column if not exists created_via text,
  add column if not exists created_by_app text;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.launch_tasks'::regclass
                    and conname = 'launch_tasks_created_via_check') then
    alter table public.launch_tasks
      add constraint launch_tasks_created_via_check
      check (created_via is null or created_via in ('app', 'ask_silo'));
  end if;
end $$;

comment on column public.launch_tasks.created_by_grant_id is
  'The AI connection that created this task, when one did. created_by stays the person it acted for. Null for every task a person typed. 20261104230000.';
comment on column public.launch_tasks.created_by_app is
  'The application''s own name, as it registered it, stored on the row so everyone who can see the task sees the same "Via <app>" -- a colleague cannot read the grant it came from. 20261104230000.';
comment on column public.launch_tasks.created_via is
  'How this task arrived: app (an approved AI connection) or ask_silo (SILO''s own assistant). Null means a person typed it. 20261104230000.';

-- Pause or resume a connection's writes. Same authority as disconnecting it
-- (silo_api_revoke): the person who approved it, or an owner of its company.
create or replace function public.silo_api_set_writes_paused(
  p_grant_id uuid,
  p_paused   boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_hit  integer;
begin
  if public.silo_api_is_integration() then
    raise exception 'integration_not_allowed: a connection cannot change its own permissions'
      using errcode = 'insufficient_privilege';
  end if;
  v_user := auth.uid();
  if v_user is null then
    raise exception 'not_authenticated: sign in to change an application''s access'
      using errcode = 'insufficient_privilege';
  end if;

  update public.silo_api_grants g
     set writes_paused_at = case when p_paused then now() else null end
   where g.id = p_grant_id
     and g.revoked_at is null
     and (g.user_id = v_user
          or exists (
            select 1 from public.entity_memberships em
            where em.user_id = v_user
              and em.entity_id = g.company_entity_id
              and em.role = 'owner_admin'));
  get diagnostics v_hit = row_count;
  return v_hit > 0;
end;
$$;

comment on function public.silo_api_set_writes_paused(uuid, boolean) is
  'Switches an approved connection''s writing off or back on without disconnecting it, for the person who approved it or an owner of its company. Reads are unaffected; scopes are frozen, so this is a column and not a scope edit. 20261104230000.';

revoke all on function public.silo_api_set_writes_paused(uuid, boolean) from public, anon;
grant execute on function public.silo_api_set_writes_paused(uuid, boolean) to authenticated;

select public.attach_stamp_company_entity_id_triggers();
select public.refresh_chat_schema_catalog();

-- Connection plumbing is not a business dataset: keep the ledger out of what
-- bots and Ask SILO are shown, as silo_api_call_log already is.
update public.silo_chat_schema_catalog set is_hidden = true, reportable = false
where relname in ('silo_api_writes');

notify pgrst, 'reload schema';

commit;
