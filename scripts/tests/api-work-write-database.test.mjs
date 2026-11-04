// work:write part one (20261104230000) -- a SILO AI connection opening a task,
// executed in a real PostgreSQL (PGlite) against the migration itself.
//
// This is the first write any connection has ever had, so what is pinned here
// is mostly the fence around it: the company comes from the GRANT row and not
// from the session, an assignee or launch outside that company is refused, a
// retry returns the FIRST task rather than a second one, a loop stops at the
// cap, a paused connection cannot write at all, and no client role can touch
// the ledger that proves any of it. Plus the one thing it must do: leave the
// row saying which application opened it, so the task list can say "Via
// Claude" to the whole team and not only to the person who approved it.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/api-work-write-database.test.mjs
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { splitSqlStatements } from '../lib/sql-statements.mjs';

const db = new PGlite();
const q = async (sql) => (await db.query(sql)).rows;
const one = async (sql) => (await q(sql))[0];
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

const MUTATIONS = ['', 'session-company', 'no-member-check', 'loose-assignee', 'any-assignee',
                   'no-cap', 'no-idempotency', 'authenticated-execute', 'ignore-pause', 'no-path',
                   'no-hint', 'hint-ignores-privacy', 'hint-no-stopwords',
                   'lax-scopes', 'no-scope-path'];
const mutation = process.env.WORK_WRITE_MUTATION || '';
assert.ok(MUTATIONS.includes(mutation), `Unknown mutation ${mutation}`);
const FILE = 'supabase/migrations/20261104230000_api_work_write_tasks.sql';
const original = readFileSync(FILE, 'utf8');
let MIGRATION = original;
// The follow-up, written after the first live test: an unrecognised scope is
// refused rather than dropped, and the MCP server can read this connection's
// scopes so tools/list stops offering a tool the connection may not call.
const FILE2 = 'supabase/migrations/20261104234500_api_consent_strict_scopes.sql';
const original2 = readFileSync(FILE2, 'utf8');
let MIGRATION2 = original2;

if (mutation === 'session-company') {
  // The whole point of reading the grant: a connection's token can carry any
  // active company, and the write must not follow it.
  MIGRATION = MIGRATION.replace('  v_company := v_grant.company_entity_id;',
    '  v_company := coalesce(public.active_company_id(), v_grant.company_entity_id);');
}
if (mutation === 'no-member-check') {
  // Anchored on the comment above it: silo_api_consent() further up this same
  // migration contains a byte-identical membership check, and removing THAT
  // one instead would prove nothing about the write tool.
  MIGRATION = MIGRATION.replace(/  -- The person it acts as must still be a member[\s\S]*?end if;\n/, '');
}
if (mutation === 'loose-assignee') {
  MIGRATION = MIGRATION.replace("    where lower(p.email) = lower(btrim(p_assignee_email))",
    "    where lower(p.email) like lower(btrim(p_assignee_email)) || '%'");
}
if (mutation === 'any-assignee') {
  MIGRATION = MIGRATION.replace(/    join public\.entity_memberships em\n      on em\.user_id = p\.id and em\.entity_id = v_company\n/, '');
}
if (mutation === 'no-cap') {
  MIGRATION = MIGRATION.replace(/  if v_used >= public\.silo_api_write_cap\(\) then\n[\s\S]*?end if;\n/, '');
}
if (mutation === 'no-idempotency') {
  // Without the unique index the "claim" insert always succeeds, so a timed-out
  // bot's retry produces a second task nobody can tell from the first.
  MIGRATION = MIGRATION.replace(/create unique index if not exists silo_api_writes_idempotent\n[\s\S]*?;\n/,
    '');
}
if (mutation === 'authenticated-execute') {
  MIGRATION = MIGRATION.replace(
    'revoke all on function public.silo_api_create_task(text, text, text, date, uuid, text, text) from public, anon, authenticated, silo_revoked;',
    'revoke all on function public.silo_api_create_task(text, text, text, date, uuid, text, text) from public, anon, silo_revoked;\ngrant execute on function public.silo_api_create_task(text, text, text, date, uuid, text, text) to authenticated;');
}
if (mutation === 'ignore-pause') {
  MIGRATION = MIGRATION.replace(/  if v_grant\.writes_paused_at is not null then\n[\s\S]*?end if;\n/, '');
}
if (mutation === 'no-path') {
  // Both files, because 20261104234500 re-states the allowlist in full: a
  // mutation that only edits the first one is overwritten by the second.
  MIGRATION = MIGRATION.replace("    '/rpc/silo_api_create_task')", '    )');
  MIGRATION2 = MIGRATION2.replace("    '/rpc/silo_api_create_task',\n", '');
}
if (mutation === 'no-hint') {
  // The task is still created, so nothing breaks -- the bot simply never
  // learns that SILO already answers the question, which is the whole ask.
  MIGRATION = MIGRATION.replace(/  v_hint := public\.silo_api_report_hint[^\n]*\n/, "  v_hint := '[]'::json;\n");
}
if (mutation === 'hint-ignores-privacy') {
  MIGRATION = MIGRATION.replace(
    "               and (s.visibility = 'company' or s.created_by = p_user)))",
    '               and true))');
}
if (mutation === 'hint-no-stopwords') {
  MIGRATION = MIGRATION.replace(/      and w <> all \(array\['report'[\s\S]*?'morning'\]\)\n/, '');
}
if (mutation === 'lax-scopes') {
  // Back to dropping silently, which is what stored a connection without the
  // permission the person had just ticked.
  MIGRATION2 = MIGRATION2.replace(/  if exists \(\n    select 1\n    from unnest\(coalesce\(p_scopes[\s\S]*?end if;\n/, '');
}
if (mutation === 'no-scope-path') {
  MIGRATION2 = MIGRATION2.replace("    '/rpc/silo_api_scopes')", '    )');
}
assert.ok(!mutation || MIGRATION !== original || MIGRATION2 !== original2,
  `mutation ${mutation} changed nothing`);

const A = '00000000-0000-4000-a000-00000000000a';   // the grant's company
const B = '00000000-0000-4000-a000-00000000000b';   // another company
const OWNER = '00000000-0000-4000-b000-000000000001';
const MEMBER = '00000000-0000-4000-b000-000000000002';
const OUTSIDER = '00000000-0000-4000-b000-000000000003';
const G = '00000000-0000-4000-c000-000000000001';        // Claude, company A, work:write
const G_READ = '00000000-0000-4000-c000-000000000002';   // read-only
const G_REVOKED = '00000000-0000-4000-c000-000000000003';
const G_PAUSED = '00000000-0000-4000-c000-000000000004';
const G_NONAME = '00000000-0000-4000-c000-000000000005'; // an app that registered no name
const G_GONE = '00000000-0000-4000-c000-000000000006';   // approver left the company
const CLIENT = '00000000-0000-4000-d000-000000000001';
const CLIENT_NONAME = '00000000-0000-4000-d000-000000000002';
const R_SYS = '00000000-0000-4000-f000-000000000001';     // a SILO report
const R_SHARED = '00000000-0000-4000-f000-000000000002';  // the company's
const R_MINE = '00000000-0000-4000-f000-000000000003';    // the approver's own
const R_THEIRS = '00000000-0000-4000-f000-000000000004';  // a colleague's private one
const R_OTHER_CO = '00000000-0000-4000-f000-000000000005';
const R_ARCHIVED = '00000000-0000-4000-f000-000000000006';
const R_GENERIC = '00000000-0000-4000-f000-000000000007';   // a title made of common words
const LAUNCH_A = '00000000-0000-4000-e000-00000000000a';
const LAUNCH_B = '00000000-0000-4000-e000-00000000000b';

await db.exec(`
set check_function_bodies = off;
create schema auth;
create role silo_integration;
create role silo_revoked;
create role anon;
create role authenticated;
create role service_role;

create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.sub', true), '')::uuid $$;
create function public.active_company_id() returns uuid language sql stable as $$
  select nullif(current_setting('test.company', true), '')::uuid $$;
create function public.silo_api_is_integration() returns boolean language sql stable as $$
  select current_setting('test.integration', true) = 'on' $$;
create function public.silo_api_claims() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('test.claims', true), '')::jsonb, '{}'::jsonb) $$;
create function public.is_exec_or_owner() returns boolean language sql stable security definer as $$
  select exists (select 1 from public.entity_memberships m
                  where m.user_id = auth.uid()
                    and m.entity_id = public.active_company_id()
                    and m.role = 'owner_admin') $$;

-- The application registrations Supabase keeps, which is where the display
-- name on the task row comes from.
create table auth.oauth_clients(id uuid primary key, client_name text, deleted_at timestamptz);
insert into auth.oauth_clients values
  ('${CLIENT}', 'Claude', null),
  ('${CLIENT_NONAME}', '   ', null);

create table public.entity_memberships(user_id uuid, entity_id uuid, role text);
insert into public.entity_memberships values
  ('${OWNER}', '${A}', 'owner_admin'),
  ('${MEMBER}', '${A}', 'admin'),
  ('${OUTSIDER}', '${B}', 'admin');

create table public.profiles(id uuid primary key, name text, email text);
insert into public.profiles values
  ('${OWNER}', 'Blake Owner', 'blake@baseballism.com'),
  ('${MEMBER}', 'Alex Rivera', 'Alex.Rivera@baseballism.com'),
  ('${OUTSIDER}', 'Jordan Lee', 'jordan@othercompany.com');

create table public.launch_calendar(id uuid primary key, company_entity_id uuid, title text);
insert into public.launch_calendar values
  ('${LAUNCH_A}', '${A}', 'Spring Drop'),
  ('${LAUNCH_B}', '${B}', 'Someone else''s drop');

create table public.launch_tasks(
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid, launch_id uuid, channel_item_id uuid,
  task_title text, notes text, status text, priority text, task_type text,
  due_date date, assigned_to_user_id uuid, assigned_to_name text,
  is_private boolean default false, sort_order integer,
  created_by uuid, created_at timestamptz not null default now());

create table public.silo_chat_saved_reports(
  id uuid primary key, company_entity_id uuid, created_by uuid, title text,
  description text, queries_run text[], visibility text, source text,
  archived_at timestamptz, updated_at timestamptz default now());
insert into public.silo_chat_saved_reports
  (id, company_entity_id, created_by, title, description, queries_run, visibility, source, archived_at) values
  ('${R_SYS}',      null,   null,        'Open AR by wholesale customer', 'Outstanding wholesale invoices by terms.', array['select 1'], 'company', 'system',   null),
  ('${R_SHARED}',   '${A}', '${OWNER}',  'Wholesale shipped orders',      'What left the warehouse, by account.',     array['select 1'], 'company', 'manual',   null),
  ('${R_MINE}',     '${A}', '${MEMBER}', 'My wholesale margin draft',     'Private working copy.',                    array['select 1'], 'private', 'ask_silo', null),
  ('${R_THEIRS}',   '${A}', '${OWNER}',  'Wholesale margin scratchpad',   'Someone else''s private wholesale invoices draft.', array['select 1'], 'private', 'ask_silo', null),
  ('${R_OTHER_CO}', '${B}', '${OUTSIDER}', 'Wholesale open invoices',     'Another company''s report.',               array['select 1'], 'company', 'manual',   null),
  ('${R_ARCHIVED}', '${A}', '${OWNER}',  'Wholesale open balances',       'Archived.',                                array['select 1'], 'company', 'manual',   now()),
  ('${R_GENERIC}',  null,   null,        'Daily sales update',            'Yesterday, across every channel.',         array['select 1'], 'company', 'system',   null);

create table public.silo_api_grants(
  id uuid primary key default gen_random_uuid(),
  client_id text, app_key text, slot integer, user_id uuid, company_entity_id uuid,
  auth_session_id uuid, generation integer default 1,
  scopes text[] not null default '{}', consented_aal text, consented_at timestamptz,
  expires_at timestamptz, revoked_at timestamptz, last_used_at timestamptz,
  updated_at timestamptz);
insert into public.silo_api_grants
  (id, client_id, app_key, slot, user_id, company_entity_id, scopes, revoked_at) values
  ('${G}',        '${CLIENT}',        'claude|', 0, '${MEMBER}', '${A}', array['data:read','work:write'], null),
  ('${G_READ}',   '${CLIENT}',        'claude|', 1, '${MEMBER}', '${A}', array['data:read'], null),
  ('${G_REVOKED}','${CLIENT}',        'claude|', 2, '${MEMBER}', '${A}', array['work:write'], now()),
  ('${G_PAUSED}', '${CLIENT}',        'claude|', 0, '${OWNER}',  '${A}', array['work:write'], null),
  ('${G_NONAME}', '${CLIENT_NONAME}', 'someapp|x', 0, '${MEMBER}', '${A}', array['work:write'], null),
  ('${G_GONE}',   '${CLIENT}',        'claude|', 0, '${OUTSIDER}','${A}', array['work:write'], null);

create function public.silo_api_grant() returns setof public.silo_api_grants
  language sql stable as $$
  select g.* from public.silo_api_grants g
   where g.id = nullif(current_setting('test.grant_id', true), '')::uuid
     and g.revoked_at is null $$;

-- The gate as 20261103240000 left it: volatile, refusing a revoked connection
-- and a scope that was not granted.
create function public.silo_api_require_scope(p_scope text) returns void
language plpgsql volatile security definer set search_path = '' as $fn$
begin
  if not public.silo_api_is_integration() then return; end if;
  if not exists (select 1 from public.silo_api_grant()) then
    raise exception 'integration_revoked';
  end if;
  if not exists (select 1 from public.silo_api_grant() g where p_scope = any(g.scopes)) then
    raise exception 'insufficient_scope';
  end if;
end $fn$;
grant execute on function public.silo_api_require_scope(text) to authenticated, silo_integration;

create function public.silo_api_app_key(p_client_id text) returns text
  language sql stable as $$ select 'app:' || coalesce(p_client_id, '') $$;
create function public.silo_api_app_connection_limit() returns integer
  language sql immutable as $$ select 3 $$;
create function public.stamp_company_entity_id() returns trigger language plpgsql as $fn$
begin
  if new.company_entity_id is null then
    new.company_entity_id := public.active_company_id();
  end if;
  return new;
end $fn$;
create function public.attach_stamp_company_entity_id_triggers() returns void
  language sql as $fn$ select null::void $fn$;
create table public.silo_chat_schema_catalog(relname text primary key, is_hidden boolean, reportable boolean);
insert into public.silo_chat_schema_catalog values ('silo_api_writes', false, true);
create function public.refresh_chat_schema_catalog() returns void
  language sql as $fn$ select null::void $fn$;

-- The consent function as it shipped, so the migration REPLACES it exactly as
-- it will in production. Only c_offered matters to this test.
create function public.silo_api_consent(p_client_id text, p_scopes text[] default array['reports:read'])
returns uuid language plpgsql security definer set search_path = '' as $fn$
begin raise exception 'stub'; end $fn$;
create table public.entities(id uuid primary key, title text);
insert into public.entities values ('${A}', 'Baseballism'), ('${B}', 'Other');

grant usage on schema auth to authenticated, anon, service_role;
grant execute on function auth.uid() to authenticated, anon, service_role;
`);

const apply = async (text) => {
  for (const s of splitSqlStatements(text)) {
    if (/^(begin|commit)$/i.test(s.text.trim())) continue;
    await db.exec(s.text);
  }
};
await apply(MIGRATION);
await apply(MIGRATION2);

/* One tool call, as PostgREST makes it. */
const call = async (args = {}, { grant = G, integration = true, company = A, sub = null } = {}) => {
  const lit = (v) => (v === undefined || v === null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
  await db.exec('begin');
  try {
    await db.exec(`set local test.grant_id = '${grant || ''}';
      set local test.integration = '${integration ? 'on' : 'off'}';
      set local test.company = '${company || ''}';
      set local test.sub = '${sub || ''}';
      set local request.path = '/rpc/silo_api_create_task';`);
    const r = (await db.query(`select public.silo_api_create_task(
      ${lit(args.title)}, ${lit(args.notes)}, ${lit(args.assignee)},
      ${args.due ? lit(args.due) + '::date' : 'null'}, ${args.launch ? lit(args.launch) + '::uuid' : 'null'},
      ${lit(args.priority ?? 'normal')}, ${lit(args.key)}) as r`)).rows[0].r;
    await db.exec('commit');
    return { ok: true, r };
  } catch (e) {
    await db.exec('rollback');
    return { ok: false, message: e.message };
  }
};
const tasks = () => q('select * from public.launch_tasks order by created_at, task_title');
const writes = () => q('select * from public.silo_api_writes order by created_at');
const reset = () => db.exec('truncate public.launch_tasks; truncate public.silo_api_writes;');

// ── The fence, before any call ────────────────────────────────────────────
await test('only the integration role may call the write tool', async () => {
  const f = 'public.silo_api_create_task(text, text, text, date, uuid, text, text)';
  assert.equal((await one(`select has_function_privilege('silo_integration', '${f}', 'execute') as p`)).p, true);
  for (const role of ['anon', 'authenticated', 'silo_revoked']) {
    assert.equal((await one(`select has_function_privilege('${role}', '${f}', 'execute') as p`)).p, false,
      `${role} must reach tasks through the page, not through the connection's tool`);
  }
  const p = await one(`select provolatile::text as vol, prosecdef from pg_proc
                        where oid = '${f}'::regprocedure`);
  assert.equal(p.vol, 'v', 'a STABLE function cannot write at all (PostgREST runs it read-only)');
  assert.equal(p.prosecdef, true, 'definer: silo_integration holds no table privileges');
});

await test('the write tool is on the path allowlist, and nothing else was opened', async () => {
  const src = (await one(`select prosrc from pg_proc
                           where oid = 'public.silo_api_path_allowed()'::regprocedure`)).prosrc;
  assert.match(src, /\/rpc\/silo_api_create_task/, 'silo_check_request() refuses a path not named here');
  const paths = [...src.matchAll(/'\/rpc\/([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(paths, ['silo_api_create_task', 'silo_api_describe_tables', 'silo_api_list_reports',
    'silo_api_query', 'silo_api_run_report', 'silo_api_scopes', 'silo_api_windsor_connections'],
    'exactly the five read paths, the one write, and the scope read the tool list needs');
});

await test('work:write can be granted, and the allowlist is still an allowlist', async () => {
  const src = (await one(`select prosrc from pg_proc
                           where oid = 'public.silo_api_consent(text, text[])'::regprocedure`)).prosrc;
  assert.match(src, /c_offered constant text\[\] := array\['reports:read', 'data:read', 'work:write'\]/);
  assert.match(src, /invalid_scope/, 'an unknown scope is still refused rather than stored');
});

await test('nobody can write the ledger through a client role, and reads are scoped', async () => {
  const p = await q(`select polcmd::text as cmd, pg_get_expr(polqual, polrelid) as qual
                       from pg_policy where polrelid = 'public.silo_api_writes'::regclass`);
  assert.equal(p.length, 1, 'a ledger a client can insert into is not a ledger');
  assert.equal(p[0].cmd, 'r');
  assert.match(p[0].qual, /active_company_id/);
  assert.match(p[0].qual, /is_exec_or_owner/);
  assert.ok((await one(`select relrowsecurity from pg_class
                         where oid = 'public.silo_api_writes'::regclass`)).relrowsecurity);
  for (const role of ['anon', 'authenticated']) {
    for (const priv of ['insert', 'update', 'delete']) {
      assert.equal((await one(`select has_table_privilege('${role}', 'public.silo_api_writes', '${priv}') as p`)).p,
        false, `${role} must not ${priv} the record that meters and bills writes`);
    }
  }
  assert.equal((await one(`select is_hidden from public.silo_chat_schema_catalog
                            where relname = 'silo_api_writes'`)).is_hidden, true,
    'connection plumbing is not a business dataset');
});

// ── The happy path ────────────────────────────────────────────────────────
await test('a connection with work:write opens one task, tagged with its application', async () => {
  await reset();
  const r = await call({ title: '  Pull the Redo refund rate  ', notes: 'For the Monday review.',
                         assignee: 'alex.rivera@BASEBALLISM.com', due: '2026-11-20',
                         launch: LAUNCH_A, priority: 'High' });
  assert.equal(r.ok, true, r.message);
  const t = await tasks();
  assert.equal(t.length, 1);
  assert.equal(t[0].task_title, 'Pull the Redo refund rate', 'trimmed');
  assert.equal(t[0].company_entity_id, A);
  assert.equal(t[0].created_by, MEMBER, 'the connection acts as the person who approved it');
  assert.equal(t[0].created_by_grant_id, G, 'and the row says which connection');
  assert.equal(t[0].created_via, 'app');
  assert.equal(t[0].created_by_app, 'Claude',
    'the name is on the row, so a colleague sees "Via Claude" too');
  assert.equal(t[0].status, 'open');
  assert.equal(t[0].priority, 'high', 'case-folded to one of the three');
  assert.equal(t[0].assigned_to_user_id, MEMBER, 'assignee matched by email, case-insensitively');
  assert.equal(t[0].assigned_to_name, 'Alex Rivera');
  assert.equal(t[0].is_private, false);
  assert.equal(r.r.task_id, t[0].id);
  assert.equal(r.r.replayed, false);
  assert.match(r.r.url, new RegExp(`/v2/tasks\\.html\\?task=${t[0].id}$`), 'the bot gets a link a person can open');

  const w = await writes();
  assert.equal(w.length, 1, 'one ledger row');
  assert.equal(w[0].target_id, t[0].id, 'pointing at what it created');
  assert.equal(w[0].kind, 'task');
  assert.equal(w[0].via, 'app');
  assert.equal(w[0].company_entity_id, A);
  assert.equal(w[0].user_id, MEMBER);
});

await test('an application that registered no name still reads as an app', async () => {
  await reset();
  const r = await call({ title: 'Check the bank feed' }, { grant: G_NONAME });
  assert.equal(r.ok, true, r.message);
  const t = await tasks();
  assert.equal(t[0].created_by_app, 'someapp', 'the app key is the fallback, never an empty chip');
});

// ── The company boundary ──────────────────────────────────────────────────
await test('the company comes from the grant, never from the session', async () => {
  await reset();
  // A connection's own token can carry any active company; following it would
  // write one company's work into another's list.
  const r = await call({ title: 'Should land in A' }, { company: B });
  assert.equal(r.ok, true, r.message);
  assert.equal((await tasks())[0].company_entity_id, A);
  assert.equal((await writes())[0].company_entity_id, A);
});

await test('an assignee outside the grant’s company is refused, not silently dropped', async () => {
  await reset();
  const r = await call({ title: 'Assign the outsider', assignee: 'jordan@othercompany.com' });
  assert.equal(r.ok, false);
  assert.match(r.message, /unknown_assignee/);
  assert.equal((await tasks()).length, 0, 'and no task is left behind unassigned');
});

await test('an assignee is matched exactly, never by prefix', async () => {
  await reset();
  const r = await call({ title: 'Near miss', assignee: 'alex' });
  assert.equal(r.ok, false, 'a prefix must not reach the first person who happens to match');
  assert.match(r.message, /unknown_assignee/);
});

await test('a launch in another company is refused', async () => {
  await reset();
  const r = await call({ title: 'Attach to someone else’s launch', launch: LAUNCH_B });
  assert.equal(r.ok, false);
  assert.match(r.message, /unknown_launch/);
  assert.equal((await tasks()).length, 0);
});

await test('a grant whose person has left the company cannot write', async () => {
  await reset();
  const r = await call({ title: 'Ghost write' }, { grant: G_GONE });
  assert.equal(r.ok, false, 'a grant must not outlive the membership it was approved under');
  assert.match(r.message, /not_a_member/);
});

// ── Who may call it at all ────────────────────────────────────────────────
await test('a person in the browser is told to use SILO itself', async () => {
  await reset();
  const r = await call({ title: 'From the page' }, { integration: false, sub: MEMBER });
  assert.equal(r.ok, false);
  assert.match(r.message, /not_a_connection/);
});

await test('a revoked connection and a connection without the scope are both refused', async () => {
  await reset();
  const revoked = await call({ title: 'After disconnecting' }, { grant: G_REVOKED });
  assert.equal(revoked.ok, false);
  assert.match(revoked.message, /integration_revoked/);
  const read = await call({ title: 'Read-only connection' }, { grant: G_READ });
  assert.equal(read.ok, false);
  assert.match(read.message, /insufficient_scope/, 'data:read never implies work:write');
  assert.equal((await tasks()).length, 0);
});

await test('pausing writes stops them without disconnecting the connection', async () => {
  await reset();
  await db.exec(`update public.silo_api_grants set writes_paused_at = now() where id = '${G_PAUSED}'`);
  const r = await call({ title: 'While paused' }, { grant: G_PAUSED });
  assert.equal(r.ok, false);
  assert.match(r.message, /writes_paused/);
  assert.equal((await tasks()).length, 0);
  // and resuming puts it back, which is the point of a switch
  await db.exec(`update public.silo_api_grants set writes_paused_at = null where id = '${G_PAUSED}'`);
  assert.equal((await call({ title: 'After resuming' }, { grant: G_PAUSED })).ok, true);
});

await test('the pause switch answers to the approver or an owner, and never to a connection', async () => {
  const f = 'public.silo_api_set_writes_paused(uuid, boolean)';
  assert.equal((await one(`select has_function_privilege('authenticated', '${f}', 'execute') as p`)).p, true);
  assert.equal((await one(`select has_function_privilege('anon', '${f}', 'execute') as p`)).p, false);
  const src = (await one(`select prosrc from pg_proc where oid = '${f}'::regprocedure`)).prosrc;
  assert.match(src, /integration_not_allowed/, 'a connection cannot unpause itself');
  assert.match(src, /owner_admin/);

  await db.exec('begin');
  await db.exec(`set local test.sub = '${OUTSIDER}'; set local test.integration = 'off';`);
  const nope = (await db.query(`select public.silo_api_set_writes_paused('${G}', true) as r`)).rows[0].r;
  await db.exec('rollback');
  assert.equal(nope, false, 'somebody else’s connection is not theirs to pause');
});

// ── The two limits ────────────────────────────────────────────────────────
await test('a retry with the same key returns the first task, not a second one', async () => {
  await reset();
  const first = await call({ title: 'Flaky network', key: 'k-1' });
  assert.equal(first.ok, true, first.message);
  const retry = await call({ title: 'Flaky network', key: 'k-1' });
  assert.equal(retry.ok, true, retry.message);
  assert.equal(retry.r.replayed, true, 'the bot is told it is a replay');
  assert.equal(retry.r.task_id, first.r.task_id, 'and gets the same task back');
  assert.equal((await tasks()).length, 1, 'one task');
  assert.equal((await writes()).length, 1, 'one write spent');
  // a different key is a different task, and no key at all never replays
  assert.equal((await call({ title: 'Second thing', key: 'k-2' })).ok, true);
  assert.equal((await call({ title: 'Third thing' })).ok, true);
  assert.equal((await call({ title: 'Third thing' })).ok, true);
  assert.equal((await tasks()).length, 4);
});

await test('the cap stops a loop, counts only the last day, and is one number in one place', async () => {
  await reset();
  const cap = (await one('select public.silo_api_write_cap() as c')).c;
  assert.equal(cap, 50, 'Blake, 2026-11-04');
  // Yesterday's writes are spent and must not count against today.
  await db.exec(`insert into public.silo_api_writes (company_entity_id, grant_id, user_id, via, kind, created_at)
                 select '${A}', '${G}', '${MEMBER}', 'app', 'task', now() - interval '2 days'
                 from generate_series(1, ${cap})`);
  assert.equal((await call({ title: 'Today, after a full yesterday' })).ok, true,
    'a rolling day, not a running total');
  await db.exec(`insert into public.silo_api_writes (company_entity_id, grant_id, user_id, via, kind)
                 select '${A}', '${G}', '${MEMBER}', 'app', 'task' from generate_series(1, ${cap})`);
  const over = await call({ title: 'One too many' });
  assert.equal(over.ok, false);
  assert.match(over.message, /write_cap_reached/);
  // the cap is per connection: another connection of the same person is unaffected
  await db.exec(`update public.silo_api_grants set scopes = array['work:write'] where id = '${G_READ}'`);
  assert.equal((await call({ title: 'Different connection' }, { grant: G_READ })).ok, true);
  await db.exec(`update public.silo_api_grants set scopes = array['data:read'] where id = '${G_READ}'`);
});

// ── What it refuses to be handed ──────────────────────────────────────────
await test('a task needs a usable title, and the rest is validated rather than stored', async () => {
  await reset();
  for (const [args, pattern] of [
    [{ title: '   ' }, /invalid_title/],
    [{ title: null }, /invalid_title/],
    [{ title: 'x'.repeat(201) }, /invalid_title/],
    [{ title: 'ok', notes: 'n'.repeat(4001) }, /invalid_notes/],
    [{ title: 'ok', priority: 'URGENT' }, /invalid_priority/],
    [{ title: 'ok', due: '1990-01-01' }, /invalid_due_date/],
    [{ title: 'ok', due: '2099-01-01' }, /invalid_due_date/],
  ]) {
    const r = await call(args);
    assert.equal(r.ok, false, `expected a refusal for ${JSON.stringify(args)}`);
    assert.match(r.message, pattern);
  }
  assert.equal((await tasks()).length, 0, 'nothing half-written');
  assert.equal((await writes()).length, 0, 'and no write spent on a refusal');
});

await test('an empty priority falls back rather than failing, and notes may be omitted', async () => {
  await reset();
  const r = await call({ title: 'Bare minimum', priority: '' });
  assert.equal(r.ok, true, r.message);
  const t = (await tasks())[0];
  assert.equal(t.priority, 'normal');
  assert.equal(t.notes, null);
  assert.equal(t.assigned_to_user_id, null, 'unassigned is allowed; a wrong assignee is not');
  assert.equal(t.launch_id, null);
});

// ── "This is already a SILO report" ───────────────────────────────────────
await test('a task that is really a report request comes back with the report', async () => {
  await reset();
  // Blake's example, verbatim in shape: the bot should deliver the report, not
  // leave a person to run one SILO already has.
  const r = await call({ title: 'Send me an open AR report for wholesale',
                         assignee: 'alex.rivera@baseballism.com' });
  assert.equal(r.ok, true, r.message);
  const ids = r.r.report_matches.map((m) => m.report_id);
  assert.ok(ids.includes(R_SYS), 'SILO’s own tied-out report is the first answer');
  assert.equal(r.r.report_matches[0].verified, true, 'and it is marked as SILO’s own');
  assert.match(r.r.report_matches[0].url, /\/v3\/report-builder\.html\?id=/, 'with a link a person can open');
  assert.match(r.r.next_step, /instead of leaving the task/,
    'the bot is told what to do with it, not just handed a list');
  assert.equal((await tasks()).length, 1,
    'the task is still created: a hint must never swallow a real request');
});

await test('the hint only offers reports that connection may already see', async () => {
  const hint = async (text, user = MEMBER, company = A) =>
    (await one(`select public.silo_api_report_hint('${company}', '${user}', '${text.replace(/'/g, "''")}') as h`)).h;
  const ids = (h) => h.map((m) => m.report_id);

  const mine = ids(await hint('wholesale open invoices and margin for the quarter'));
  assert.ok(mine.includes(R_SYS), 'SILO’s own reports are shared with everyone');
  assert.ok(mine.includes(R_MINE), 'and the approver’s own private report is theirs to be offered');
  assert.ok(!mine.includes(R_THEIRS), 'a colleague’s private report is not theirs to see');
  assert.ok(!mine.includes(R_OTHER_CO), 'and another company’s report never appears');
  assert.ok(!mine.includes(R_ARCHIVED), 'nor an archived one');

  assert.deepEqual(await hint('book the photographer for the spring shoot'), [],
    'a task that is not a data request gets no hint at all');
  assert.deepEqual(await hint('send me a report please'), [],
    'and the words every request contains are not a match');
  // "Daily sales update" is a real report whose every word is a word people
  // put in sentences: matching on those would hint it at half of all tasks.
  assert.deepEqual(await hint('please send me a daily update report today'), [],
    'a title made of common words does not match a sentence made of them');
  assert.ok(ids(await hint('yesterday’s sales across every channel')).includes(R_GENERIC),
    'it is still found by the words that mean something');
  assert.ok((await hint('wholesale open invoices')).length <= 3, 'at most three');
});

// ── The columns the task list reads ───────────────────────────────────────
await test('a task a person typed keeps the new columns null, and junk cannot be stored', async () => {
  await reset();
  await db.exec(`insert into public.launch_tasks (company_entity_id, task_title, status)
                 values ('${A}', 'Typed by a person', 'open')`);
  const t = (await tasks())[0];
  assert.equal(t.created_via, null, 'which is how the page knows to show no chip');
  assert.equal(t.created_by_grant_id, null);
  assert.equal(t.created_by_app, null);
  await assert.rejects(
    db.exec(`insert into public.launch_tasks (company_entity_id, task_title, created_via)
             values ('${A}', 'Bad provenance', 'somewhere_else')`),
    /launch_tasks_created_via_check|violates check constraint/,
    'the only two answers are app and ask_silo');
});

// ── The follow-up migration: no silent scope, and a listable scope read ───
const consent = async (scopes, { sub = MEMBER, company = A, aal = 'aal2' } = {}) => {
  const lit = scopes === null ? 'null'
    : 'array[' + scopes.map((x) => (x === null ? 'null' : `'${x}'`)).join(',') + ']::text[]';
  await db.exec('begin');
  try {
    await db.exec(`set local test.sub = '${sub}'; set local test.company = '${company}';
      set local test.integration = 'off'; set local test.claims = '{"aal":"${aal}"}';`);
    const id = (await db.query(`select public.silo_api_consent('client-x', ${lit}) as id`)).rows[0].id;
    await db.exec('commit');
    return { ok: true, id };
  } catch (e) { await db.exec('rollback'); return { ok: false, message: e.message }; }
};

await test('a scope SILO does not recognise is refused, not quietly dropped', async () => {
  // Live on 2026-11-04: an approval that ticked "also let it open tasks"
  // stored the two read scopes, because the page sent a null where the write
  // scope should have been and this filter dropped it.
  const nulled = await consent(['reports:read', 'data:read', null]);
  assert.equal(nulled.ok, false, 'a null scope must not be silently ignored');
  assert.match(nulled.message, /unknown_scope/);

  const typo = await consent(['reports:read', 'work:writes']);
  assert.equal(typo.ok, false);
  assert.match(typo.message, /unknown_scope/);

  // And the good case still works, with all three stored.
  const good = await consent(['reports:read', 'data:read', 'work:write']);
  assert.equal(good.ok, true, good.message);
  const row = await one(`select scopes from public.silo_api_grants where id = '${good.id}'`);
  assert.deepEqual([...row.scopes].sort(), ['data:read', 'reports:read', 'work:write']);
});

await test('two-factor approval is still the precondition, unchanged', async () => {
  const weak = await consent(['reports:read'], { aal: 'aal1' });
  assert.equal(weak.ok, false);
  assert.match(weak.message, /mfa_required/);
});

await test('a connection can read its own scopes, and nothing else can learn them from it', async () => {
  await db.exec('begin');
  await db.exec(`set local test.grant_id = '${G}'; set local test.integration = 'on';`);
  const mine = (await db.query('select public.silo_api_scopes() as s')).rows[0].s;
  await db.exec('rollback');
  assert.deepEqual([...mine].sort(), ['data:read', 'work:write'],
    'the MCP server lists tools from this');

  // No live grant -> empty, which is how the server fails closed and hides
  // the write tool rather than offering one that would be refused.
  await db.exec('begin');
  await db.exec(`set local test.grant_id = '${G_REVOKED}'; set local test.integration = 'on';`);
  const revoked = (await db.query('select public.silo_api_scopes() as s')).rows[0].s;
  await db.exec('rollback');
  assert.deepEqual(revoked, []);

  const f = 'public.silo_api_scopes()';
  assert.equal((await one(`select has_function_privilege('silo_integration', '${f}', 'execute') as p`)).p, true);
  assert.equal((await one(`select has_function_privilege('anon', '${f}', 'execute') as p`)).p, false);
  const src = (await one(`select prosrc from pg_proc
                           where oid = 'public.silo_api_path_allowed()'::regprocedure`)).prosrc;
  assert.match(src, /\/rpc\/silo_api_scopes/, 'and the path gate admits the read it needs');
});

console.log(`\n${passed} checks passed${mutation ? ` (mutation: ${mutation})` : ''}`);
