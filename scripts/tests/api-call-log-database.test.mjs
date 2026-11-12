// What a SILO AI connection did (20261103240000), executed in a real
// PostgreSQL (PGlite) against the migration itself.
//
// The whole value of this log is that it can be trusted, so what is pinned
// here is mostly what it must NOT do: log a call that was refused (it cannot --
// the refusal rolls back, and the screen says so rather than implying the app
// did nothing), log a browser session as a connection, lose the tool name,
// show one colleague's connection activity to another, or let any client role
// write a row. And one thing it must do that nothing did before: count every
// tool as activity, so the 30-day idle policy stops disconnecting a connection
// whose bot lives on describe_tables and list_reports.
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/api-call-log-database.test.mjs
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

const MUTATIONS = ['', 'stable-scope', 'open-policy', 'no-touch', 'log-browser', 'ignore-read-only', 'logging-can-break-a-read', 'stable-catalog', 'stable-catalog-unchecked',
  'connect-unrecorded', 'connect-not-on-path', 'failure-no-cap', 'failure-any-tool', 'failure-touches-grant', 'failure-anon', 'still-prunes'];
const mutation = process.env.CALL_LOG_MUTATION || '';
assert.ok(MUTATIONS.includes(mutation), `Unknown mutation ${mutation}`);
const original = readFileSync('supabase/migrations/20261103240000_api_call_log.sql', 'utf8');
let MIGRATION = original;
// 20261104030000 is the other half: without it the three catalog tools stay
// STABLE, PostgREST keeps running them in a read-only transaction (on POST as
// well as on GET -- it picks the access mode from the function's volatility,
// not from the verb), and three of the six tools record nothing. Measured on
// production 2026-11-04, not reasoned about.
const original2 = readFileSync('supabase/migrations/20261104030000_api_call_log_catalog_tools.sql', 'utf8');
let MIGRATION2 = original2;
if (mutation === 'stable-scope') {
  // A STABLE gate cannot insert: STABLE is exactly what the shipped gate was,
  // and why nothing has ever been recorded.
  MIGRATION = MIGRATION.replace(
    'create or replace function public.silo_api_require_scope(p_scope text)\nreturns void\nlanguage plpgsql\nvolatile',
    'create or replace function public.silo_api_require_scope(p_scope text)\nreturns void\nlanguage plpgsql\nstable');
}
if (mutation === 'open-policy') {
  MIGRATION = MIGRATION.replace('and (user_id = auth.uid() or public.is_exec_or_owner())', 'and true');
}
if (mutation === 'no-touch') {
  MIGRATION = MIGRATION.replace('  perform public.silo_api_touch_grant();\n', '');
}
if (mutation === 'log-browser') {
  // BOTH guards, because they are deliberately redundant: the gate returns
  // early for a browser session, and the recorder refuses to write for one
  // even if it is reached. Removing either alone changes nothing observable,
  // which is the point of having two; removing both must be caught.
  MIGRATION = MIGRATION.replace(
    '  if not public.silo_api_is_integration() then\n    return;\n  end if;\n  -- Grant state before scope',
    '  -- Grant state before scope');
  MIGRATION = MIGRATION.replace(
    '  -- A person in the browser is not a connection and is not logged here.\n'
    + '  if not public.silo_api_is_integration() then\n    return;\n  end if;\n', '');
}
if (mutation === 'ignore-read-only') {
  // Without this guard a GET to a STABLE tool -- which PostgREST runs in a
  // read-only transaction -- stops working the day this is applied.
  MIGRATION = MIGRATION.replace(
    "  if current_setting('transaction_read_only', true) = 'on' then\n    return;\n  end if;\n", '');
}
if (mutation === 'logging-can-break-a-read') {
  // Remove the backstop, so any failure to record takes the data call with it.
  MIGRATION = MIGRATION.replace('  begin\n    insert into public.silo_api_call_log', '  insert into public.silo_api_call_log')
    .replace(/  exception when others then\n    raise warning[^\n]*\n  end;\n/, '');
}
if (mutation === 'stable-catalog') {
  // Leave the catalog tools STABLE: the state production was actually in with
  // 20261103240000 alone, where list_reports recorded nothing.
  MIGRATION2 = MIGRATION2.replace(/^alter function public\.silo_api_(describe_tables|list_reports)[^\n]*volatile;\n/gm, '');
}
if (mutation === 'stable-catalog-unchecked') {
  // The same defect with the migration's own assertion removed, so the thing
  // that has to catch it is the test, not the migration.
  MIGRATION2 = MIGRATION2
    .replace(/^alter function public\.silo_api_(describe_tables|list_reports)[^\n]*volatile;\n/gm, '')
    .replace(/-- Volatility is the whole change[\s\S]*?end \$\$;\n/, '');
}
// 20261112030000: the connect probe and failure records.
const original3 = readFileSync('supabase/migrations/20261112030000_api_call_log_connect_and_failures.sql', 'utf8');
let MIGRATION3 = original3;
if (mutation === 'connect-unrecorded') {
  MIGRATION3 = MIGRATION3.replace("  perform public.silo_api_record_call('');\n", '');
}
if (mutation === 'connect-not-on-path') {
  MIGRATION3 = MIGRATION3.replace("    '/rpc/silo_api_connect',\n", '');
}
if (mutation === 'failure-no-cap') {
  MIGRATION3 = MIGRATION3.replace(">= 300 then", ">= 1000000 then");
}
if (mutation === 'failure-any-tool') {
  MIGRATION3 = MIGRATION3.replace("then p_tool else 'unknown' end", "or true then p_tool else 'unknown' end");
}
if (mutation === 'failure-touches-grant') {
  MIGRATION3 = MIGRATION3.replace("  -- Same stance as silo_api_record_call()", "  perform public.silo_api_touch_grant();\n  -- Same stance as silo_api_record_call()");
}
if (mutation === 'failure-anon') {
  MIGRATION3 = MIGRATION3.replace("revoke all on function public.silo_api_record_failure(text, text) from public, anon;",
    "grant execute on function public.silo_api_record_failure(text, text) to anon;");
}
// 20261112050000: the log is the usage record now, so it is kept.
const original4 = readFileSync('supabase/migrations/20261112050000_api_call_log_keep_history.sql', 'utf8');
let MIGRATION4 = original4;
if (mutation === 'still-prunes') {
  // Leave 20261103240000's 90-day delete in place.
  MIGRATION4 = '';
}
// MIGRATION4 re-states silo_api_record_call(), so the recorder's own mutations
// must break that copy too, or the re-stated body would hide them.
if (mutation === 'no-touch') {
  MIGRATION4 = MIGRATION4.replace('  perform public.silo_api_touch_grant();\n', '');
}
if (mutation === 'log-browser') {
  MIGRATION4 = MIGRATION4.replace(
    '  -- A person in the browser is not a connection and is not logged here.\n'
    + '  if not public.silo_api_is_integration() then\n    return;\n  end if;\n', '');
}
if (mutation === 'ignore-read-only') {
  MIGRATION4 = MIGRATION4.replace(
    "  if current_setting('transaction_read_only', true) = 'on' then\n    return;\n  end if;\n", '');
}
if (mutation === 'logging-can-break-a-read') {
  MIGRATION4 = MIGRATION4.replace('  begin\n    insert into public.silo_api_call_log', '  insert into public.silo_api_call_log')
    .replace(/  exception when others then\n    raise warning[^\n]*\n  end;\n/, '');
}
for (const [m, text] of [['no-touch', original4], ['log-browser', original4], ['ignore-read-only', original4], ['logging-can-break-a-read', original4]]) {
  if (mutation === m) assert.notEqual(MIGRATION4, text, `mutation ${m} must reach 20261112050000's recorder too`);
}
assert.ok(!mutation || MIGRATION !== original || MIGRATION2 !== original2 || MIGRATION3 !== original3 || MIGRATION4 !== original4,
  `mutation ${mutation} changed nothing`);

const A = '00000000-0000-4000-a000-00000000000a';   // company A
const B = '00000000-0000-4000-a000-00000000000b';   // company B
const OWNER = '00000000-0000-4000-b000-000000000001';
const MEMBER = '00000000-0000-4000-b000-000000000002';
const COLLEAGUE = '00000000-0000-4000-b000-000000000003';
const G_MEMBER = '00000000-0000-4000-c000-000000000002';
const G_REVOKED = '00000000-0000-4000-c000-000000000003';
const G_NARROW = '00000000-0000-4000-c000-000000000004';
const G_B = '00000000-0000-4000-c000-000000000005';

await db.exec(`
-- The stubs below reference tables created further down this same script.
set check_function_bodies = off;
create schema auth;
create role silo_integration;
create role anon;
create role authenticated;
create role service_role;

create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.sub', true), '')::uuid $$;
create function public.active_company_id() returns uuid language sql stable as $$
  select nullif(current_setting('test.company', true), '')::uuid $$;
-- Definer, as in production: the gate reads memberships the caller cannot.
create function public.is_exec_or_owner() returns boolean language sql stable security definer as $$
  select exists (select 1 from public.entity_memberships m
                  where m.user_id = auth.uid()
                    and m.entity_id = public.active_company_id()
                    and m.role = 'owner_admin') $$;
create function public.silo_api_is_integration() returns boolean language sql stable as $$
  select current_setting('test.integration', true) = 'on' $$;

create table public.entity_memberships(user_id uuid, entity_id uuid, role text);
insert into public.entity_memberships values
  ('${OWNER}', '${A}', 'owner_admin'),
  ('${MEMBER}', '${A}', 'admin'),
  ('${COLLEAGUE}', '${A}', 'admin');

create table public.silo_api_grants(
  id uuid primary key, client_id text, user_id uuid, company_entity_id uuid,
  scopes text[] not null default '{}', revoked_at timestamptz,
  last_used_at timestamptz, updated_at timestamptz);
insert into public.silo_api_grants (id, client_id, user_id, company_entity_id, scopes, revoked_at) values
  ('${G_MEMBER}',  'claude',  '${MEMBER}',    '${A}', array['data:read','reports:read'], null),
  ('${G_REVOKED}', 'chatgpt', '${COLLEAGUE}', '${A}', array['data:read'], now()),
  ('${G_NARROW}',  'grok',    '${COLLEAGUE}', '${A}', array['reports:read'], null),
  ('${G_B}',       'claude',  '${OWNER}',     '${B}', array['data:read'], null);

-- The live grant of whichever connection the test is pretending to be.
create function public.silo_api_grant() returns setof public.silo_api_grants
  language sql stable as $$
  select g.* from public.silo_api_grants g
   where g.id = nullif(current_setting('test.grant_id', true), '')::uuid
     and g.revoked_at is null $$;

-- The shipped throttle, which the log must participate in rather than bypass.
create function public.silo_api_touch_grant() returns void language sql as $$
  update public.silo_api_grants g set last_used_at = now(), updated_at = now()
   where g.id = (select x.id from public.silo_api_grants x
                  where x.id = (select id from public.silo_api_grant())
                    and (x.last_used_at is null or x.last_used_at < now() - interval '1 hour')) $$;

create function public.stamp_company_entity_id() returns trigger language plpgsql as $fn$
begin
  if new.company_entity_id is null then
    new.company_entity_id := public.active_company_id();
  end if;
  return new;
end $fn$;
create function public.attach_stamp_company_entity_id_triggers() returns void
  language sql as $fn$ select null::void $fn$;

-- The gate as it shipped (20261028070000), so the migration REPLACES it here
-- exactly as it will in production.
create function public.silo_api_require_scope(p_scope text) returns void
language plpgsql stable security definer set search_path = '' as $fn$
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

-- The three catalog tools as they shipped: STABLE, which is the whole defect.
-- The signatures match production exactly, because 20261104030000 alters them
-- by signature and a near miss would silently alter nothing.
create function public.silo_api_describe_tables(p_tables text[] default null,
    p_search text default null, p_notes boolean default false)
  returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
  begin perform public.silo_api_require_scope('data:read'); return '{}'::jsonb; end $fn$;
create function public.silo_api_list_reports()
  returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
  begin perform public.silo_api_require_scope('reports:read'); return '{}'::jsonb; end $fn$;
create function public.silo_api_list_reports(p_search text)
  returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
  begin perform public.silo_api_require_scope('reports:read'); return '{}'::jsonb; end $fn$;
-- Supabase grants these; PGlite does not, and without them the policy's own
-- auth.uid() call fails before it can decide anything.
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
await apply(MIGRATION3);
await apply(MIGRATION4);

/* One tool call, as PostgREST makes it: the request path names the function,
   the connection's token resolves to a grant, and the gate runs first. */
const call = async ({ grant = G_MEMBER, scope = 'data:read', path = '/rest/v1/rpc/silo_api_query',
                      integration = true, company = A, sub = null } = {}) => {
  await db.exec('begin');
  try {
    await db.exec(`set local test.grant_id = '${grant || ''}';
      set local test.integration = '${integration ? 'on' : 'off'}';
      set local test.company = '${company || ''}';
      set local test.sub = '${sub || ''}';
      ${path ? `set local request.path = '${path}'` : 'select 1'};`);
    await db.exec(`select public.silo_api_require_scope('${scope}')`);
    await db.exec('commit');
    return { ok: true };
  } catch (e) {
    await db.exec('rollback');
    return { ok: false, message: e.message };
  }
};
const rows = (where = 'true') => q(`select * from public.silo_api_call_log where ${where} order by created_at`);

// ── The table nobody but the recorder can write ───────────────────────────
await test('the log exists, indexed for the two questions asked of it', async () => {
  assert.ok(await one(`select 1 from pg_class where oid = 'public.silo_api_call_log'::regclass`));
  const idx = (await q(`select indexname from pg_indexes
                         where tablename = 'silo_api_call_log'`)).map((r) => r.indexname);
  assert.ok(idx.some((n) => n.includes('company_time')), 'an owner reads it by company and time');
  assert.ok(idx.some((n) => n.includes('grant_time')), 'a card reads it by connection and time');
});

await test('no client role can write a row, and reads are select-only', async () => {
  const p = await q(`select polcmd, pg_get_expr(polqual, polrelid) as qual
                       from pg_policy where polrelid = 'public.silo_api_call_log'::regclass`);
  assert.equal(p.length, 1, 'one policy: an audit log a client can insert into is not an audit log');
  assert.equal(p[0].polcmd, 'r');
  assert.ok((await one(`select relrowsecurity from pg_class
                         where oid = 'public.silo_api_call_log'::regclass`)).relrowsecurity);
  for (const role of ['anon', 'authenticated']) {
    for (const priv of ['insert', 'update', 'delete']) {
      assert.equal(
        (await one(`select has_table_privilege('${role}', 'public.silo_api_call_log', '${priv}') as p`)).p,
        false, `${role} must not ${priv} the record of who read the company's data`);
    }
  }
});

// ── What it records, and what it cannot ───────────────────────────────────
await test('the gate is volatile, which is what lets it record at all', async () => {
  assert.equal((await one(`select provolatile from pg_proc
                            where oid = 'public.silo_api_require_scope(text)'::regprocedure`)).provolatile,
    'v', 'a STABLE function cannot insert; the shipped gate was STABLE and recorded nothing');
});

await test('an authorized call is recorded once, with the tool taken from the request path', async () => {
  assert.equal((await rows()).length, 0);
  assert.deepEqual(await call({}), { ok: true });
  const r = await rows();
  assert.equal(r.length, 1);
  assert.equal(r[0].tool, 'silo_api_query', 'the tool name comes from PostgREST, not from an argument');
  assert.equal(r[0].scope, 'data:read');
  assert.equal(r[0].grant_id, G_MEMBER);
  assert.equal(r[0].client_id, 'claude');
  assert.equal(r[0].user_id, MEMBER, 'the person who approved it is who the connection acts as');
  assert.equal(r[0].company_entity_id, A, 'the company comes from the grant, never from the session');
});

await test('every tool is recorded, not only the two that used to count', async () => {
  await db.exec('truncate public.silo_api_call_log');
  for (const tool of ['silo_api_describe_tables', 'silo_api_list_reports', 'silo_api_run_report',
                      'silo_api_windsor_connections']) {
    assert.deepEqual(await call({ path: '/rest/v1/rpc/' + tool, scope: 'data:read' }), { ok: true });
  }
  assert.deepEqual((await rows()).map((r) => r.tool).sort(),
    ['silo_api_describe_tables', 'silo_api_list_reports', 'silo_api_run_report', 'silo_api_windsor_connections']);
});

await test('a refused call records nothing at all, which is the documented limit', async () => {
  await db.exec('truncate public.silo_api_call_log');
  const revoked = await call({ grant: G_REVOKED });
  assert.equal(revoked.ok, false);
  assert.match(revoked.message, /integration_revoked/);
  const narrow = await call({ grant: G_NARROW, scope: 'data:read' });
  assert.equal(narrow.ok, false);
  assert.match(narrow.message, /insufficient_scope/);
  assert.equal((await rows()).length, 0,
    'the refusal rolls its own transaction back; the screen must say refusals are not listed');
});

await test('a person in the browser is not recorded as a connection', async () => {
  await db.exec('truncate public.silo_api_call_log');
  assert.deepEqual(await call({ integration: false, path: '/rest/v1/rpc/silo_api_query' }), { ok: true });
  assert.equal((await rows()).length, 0);
});

await test('a call with no resolvable grant records nothing rather than a row with no owner', async () => {
  await db.exec('truncate public.silo_api_call_log');
  const r = await call({ grant: null });
  assert.equal(r.ok, false, 'no grant is a refusal, not an anonymous log row');
  assert.equal((await rows()).length, 0);
});

await test('a GET to a stable tool still works, and is simply not recorded', async () => {
  await db.exec('truncate public.silo_api_call_log');
  // Production shape: PostgREST serves a GET for a STABLE function inside a
  // READ ONLY transaction, and describe_tables and list_reports are STABLE.
  await db.exec(`create or replace function public.stable_tool() returns text
                 language plpgsql stable security definer set search_path = '' as $fn$
                 begin perform public.silo_api_require_scope('data:read'); return 'ok'; end $fn$`);
  await db.exec('begin');
  let answer = null, failure = null;
  try {
    await db.exec(`set local test.grant_id = '${G_MEMBER}'; set local test.integration = 'on';
                   set local test.company = '${A}'; set local request.path = '/rest/v1/rpc/silo_api_list_reports';
                   set transaction read only`);
    answer = (await db.query('select public.stable_tool() as a')).rows[0].a;
    await db.exec('commit');
  } catch (e) { failure = e.message; await db.exec('rollback'); }
  assert.equal(failure, null, 'logging must never be the reason a company cannot read its own data');
  assert.equal(answer, 'ok');
  assert.equal((await rows()).length, 0, 'nothing can be written in a read-only transaction');
});

await test('a stable tool called the normal way IS recorded', async () => {
  await db.exec('truncate public.silo_api_call_log');
  await db.exec('begin');
  await db.exec(`set local test.grant_id = '${G_MEMBER}'; set local test.integration = 'on';
                 set local test.company = '${A}'; set local request.path = '/rest/v1/rpc/silo_api_describe_tables'`);
  await db.query('select public.stable_tool()');
  await db.exec('commit');
  const r = await rows();
  assert.equal(r.length, 1, 'in a read-write transaction the same tool is recorded');
  assert.equal(r[0].tool, 'silo_api_describe_tables');
});

await test('the catalog tools are VOLATILE, so PostgREST hands them a read-write transaction', async () => {
  // This is the whole of 20261104030000. PostgREST decides a request's access
  // mode from the function's volatility, NOT from the HTTP verb: a STABLE
  // function runs in a READ ONLY transaction on POST too, and the MCP server
  // POSTs every tool. While these three were STABLE they recorded nothing by
  // any route, and a bot living on them still looked idle.
  for (const sig of ['public.silo_api_describe_tables(text[], text, boolean)',
                     'public.silo_api_list_reports()',
                     'public.silo_api_list_reports(text)']) {
    assert.equal((await one(`select provolatile from pg_proc
                              where oid = '${sig}'::regprocedure`)).provolatile, 'v',
      `${sig} must not be STABLE, or PostgREST runs it read-only and it records nothing`);
  }
});

await test('each catalog tool records its own call, by the path PostgREST used', async () => {
  await db.exec('truncate public.silo_api_call_log');
  // Called as the tool itself, not through a stand-in: the gate is inside
  // these bodies, and a volatile function may insert.
  await db.exec('begin');
  await db.exec(`set local test.grant_id = '${G_MEMBER}'; set local test.integration = 'on';
                 set local test.company = '${A}';
                 set local request.path = '/rest/v1/rpc/silo_api_describe_tables'`);
  await db.query('select public.silo_api_describe_tables()');
  await db.exec('commit');
  await db.exec('begin');
  await db.exec(`set local test.grant_id = '${G_MEMBER}'; set local test.integration = 'on';
                 set local test.company = '${A}';
                 set local request.path = '/rest/v1/rpc/silo_api_list_reports'`);
  await db.query(`select public.silo_api_list_reports('launch')`);
  await db.exec('commit');
  assert.deepEqual((await rows()).map((r) => r.tool).sort(),
    ['silo_api_describe_tables', 'silo_api_list_reports'],
    'the two tools that recorded nothing in production are the point of this change');
});

await test('a failure to record never fails the data call', async () => {
  await db.exec('truncate public.silo_api_call_log');
  // Make the write impossible in a way nothing else can route around.
  await db.exec(`alter table public.silo_api_call_log add constraint impossible check (tool is null) not valid`);
  await db.exec(`alter table public.silo_api_call_log validate constraint impossible`);
  const r = await call({});
  assert.deepEqual(r, { ok: true }, 'the read goes through; the lost row is a warning in the Postgres log');
  assert.equal((await rows()).length, 0);
  await db.exec('alter table public.silo_api_call_log drop constraint impossible');
});

// ── The idle-disconnect hole it closes ────────────────────────────────────
await test('recording a call counts as activity, under the existing hourly throttle', async () => {
  await db.exec('truncate public.silo_api_call_log');
  await db.exec(`update public.silo_api_grants set last_used_at = null, updated_at = null
                  where id = '${G_MEMBER}'`);
  await call({ path: '/rest/v1/rpc/silo_api_describe_tables' });
  const after = await one(`select last_used_at from public.silo_api_grants where id = '${G_MEMBER}'`);
  assert.ok(after.last_used_at,
    'before this, a bot living on describe_tables looked idle and got disconnected at 30 days');
  // The throttle is the grant's, not the log's: a second call inside the hour
  // is still recorded, it just does not rewrite the stamp.
  await call({ path: '/rest/v1/rpc/silo_api_list_reports' });
  const again = await one(`select last_used_at from public.silo_api_grants where id = '${G_MEMBER}'`);
  assert.equal(String(again.last_used_at), String(after.last_used_at), 'the hourly throttle survives');
  assert.equal((await rows()).length, 2, 'both calls are recorded even though only one touched the grant');
});

// ── Kept, not pruned (20261112050000) ─────────────────────────────────────
await test('old rows are kept: the log is the usage record a company is billed from', async () => {
  await db.exec('truncate public.silo_api_call_log');
  await db.exec(`insert into public.silo_api_call_log (company_entity_id, grant_id, tool, created_at) values
    ('${A}', '${G_MEMBER}', 'silo_api_query', now() - interval '91 days'),
    ('${A}', '${G_MEMBER}', 'silo_api_query', now() - interval '400 days'),
    ('${B}', '${G_B}', 'silo_api_query', now() - interval '400 days')`);
  await call({});
  assert.equal((await rows(`created_at < now() - interval '90 days'`)).length, 3,
    'a call older than 90 days is still there after the next recorded call');
  assert.equal((await rows(`company_entity_id = '${A}' and created_at > now() - interval '1 minute'`)).length, 1,
    'and the new call is recorded');
  const body = await one(`select pg_get_functiondef('public.silo_api_record_call(text)'::regprocedure) as d`);
  assert.ok(!/delete\s+from/i.test(body.d), 'the recorder deletes nothing');
});

// ── Who may read it ───────────────────────────────────────────────────────
const readAs = async (sub, company) => {
  await db.exec('begin');
  try {
    await db.exec(`set local test.sub = '${sub}'; set local test.company = '${company}';
                   set local role authenticated`);
    return (await db.query('select grant_id from public.silo_api_call_log')).rows;
  } finally { await db.exec('rollback'); }
};

await test('the approver sees their own connection, an owner sees every connection, a colleague sees neither', async () => {
  await db.exec('truncate public.silo_api_call_log');
  await db.exec(`insert into public.silo_api_call_log (company_entity_id, grant_id, user_id, tool) values
    ('${A}', '${G_MEMBER}', '${MEMBER}', 'silo_api_query'),
    ('${B}', '${G_B}', '${OWNER}', 'silo_api_query')`);
  assert.deepEqual((await readAs(MEMBER, A)).map((r) => r.grant_id), [G_MEMBER],
    'the person who approved an app can see what it did');
  assert.deepEqual((await readAs(OWNER, A)).map((r) => r.grant_id), [G_MEMBER],
    'an owner answers for the company, so they see every connection in it');
  assert.deepEqual(await readAs(COLLEAGUE, A), [],
    'a colleague has no business reading which data someone else\'s app pulled');
  assert.deepEqual(await readAs(OWNER, B), [G_B].map((g) => ({ grant_id: g })),
    'the same owner in the other company sees that company only');
  assert.deepEqual(await readAs(MEMBER, B), [], 'no row crosses a company boundary');
});

// ── 20261112030000: connections counted apart, failures recorded ──────────
const asConnection = async (sql, { grant = G_MEMBER, path, integration = true } = {}) => {
  await db.exec('begin');
  try {
    await db.exec(`set local test.grant_id = '${grant || ''}'; set local test.integration = '${integration ? 'on' : 'off'}';
                   set local test.company = '${A}'; set local request.path = '${path}'`);
    const r = (await db.query(sql)).rows;
    await db.exec('commit');
    return { ok: true, rows: r };
  } catch (e) { await db.exec('rollback'); return { ok: false, message: e.message }; }
};
const pathAllowed = async (path) => {
  await db.exec('begin');
  try {
    await db.exec(`set local request.path = '${path}'`);
    return (await one('select public.silo_api_path_allowed() as ok')).ok;
  } finally { await db.exec('rollback'); }
};

await test('the connect probe is logged as a connection, needs no scope, and counts as activity', async () => {
  await db.exec('truncate public.silo_api_call_log');
  await db.exec(`update public.silo_api_grants set last_used_at = null where id = '${G_NARROW}'`);
  // G_NARROW holds reports:read only; connecting is not reading.
  const r = await asConnection('select public.silo_api_connect() as a', { grant: G_NARROW, path: '/rpc/silo_api_connect' });
  assert.equal(r.ok, true, r.message);
  const logged = await rows();
  assert.deepEqual(logged.map((x) => [x.tool, x.scope, x.outcome]), [['silo_api_connect', null, 'ok']],
    'a handshake is one connect row, not a "listed reports"');
  assert.ok((await one(`select last_used_at from public.silo_api_grants where id = '${G_NARROW}'`)).last_used_at);
});

await test('connecting with a revoked grant is refused and records nothing', async () => {
  await db.exec('truncate public.silo_api_call_log');
  const r = await asConnection('select public.silo_api_connect()', { grant: G_REVOKED, path: '/rpc/silo_api_connect' });
  assert.equal(r.ok, false);
  assert.match(r.message, /integration_revoked/);
  assert.equal((await rows()).length, 0);
});

await test('both new functions are on the API path, and the old surface still is', async () => {
  for (const p of ['/rpc/silo_api_connect', '/rpc/silo_api_record_failure', '/rpc/silo_api_query',
                   '/rpc/silo_api_list_reports', '/rpc/silo_api_mark_code_created']) {
    assert.equal(await pathAllowed(p), true, p);
  }
  assert.equal(await pathAllowed('/rpc/silo_api_record_call'), false, 'the recorder itself stays internal');
  assert.equal(await pathAllowed('/silo_api_call_log'), false, 'the table is never on the API path');
});

await test('a failure is recorded for the token\'s own grant, and survives as its own row', async () => {
  await db.exec('truncate public.silo_api_call_log');
  const r = await asConnection(`select public.silo_api_record_failure('silo_api_query', '57014')`,
    { path: '/rpc/silo_api_record_failure' });
  assert.equal(r.ok, true, r.message);
  const x = await rows();
  assert.equal(x.length, 1);
  assert.deepEqual([x[0].tool, x[0].outcome, x[0].error_code, x[0].scope], ['silo_api_query', 'error', '57014', null]);
  assert.deepEqual([x[0].grant_id, x[0].company_entity_id, x[0].user_id, x[0].client_id], [G_MEMBER, A, MEMBER, 'claude'],
    'grant, company, person and app come from the token, not from arguments');
});

await test('a failure record cannot name another tool family, inject text, or grow without bound', async () => {
  await db.exec('truncate public.silo_api_call_log');
  await asConnection(`select public.silo_api_record_failure('drop_everything', 'bad code; <script>')`,
    { path: '/rpc/silo_api_record_failure' });
  const x = await rows();
  assert.deepEqual([x[0].tool, x[0].error_code], ['unknown', 'badcodescript']);
  await asConnection(`select public.silo_api_record_failure('silo_api_query', null)`, { path: '/rpc/silo_api_record_failure' });
  assert.equal((await rows(`error_code = 'error'`)).length, 1, 'no code is stored as "error", never blank');

  await db.exec('truncate public.silo_api_call_log');
  await db.exec(`insert into public.silo_api_call_log (company_entity_id, grant_id, tool, outcome)
                 select '${A}', '${G_MEMBER}', 'silo_api_query', 'error' from generate_series(1, 300)`);
  await asConnection(`select public.silo_api_record_failure('silo_api_query', 'x')`, { path: '/rpc/silo_api_record_failure' });
  assert.equal((await rows()).length, 300, 'at most 300 failure rows per connection per hour');
  await asConnection(`select public.silo_api_record_failure('silo_api_query', 'x')`,
    { grant: G_NARROW, path: '/rpc/silo_api_record_failure' });
  assert.equal((await rows(`grant_id = '${G_NARROW}'`)).length, 1, 'the cap is per connection, not global');
});

await test('a failure is not activity, a browser session records nothing, and a dead grant records nothing', async () => {
  await db.exec('truncate public.silo_api_call_log');
  await db.exec(`update public.silo_api_grants set last_used_at = null where id = '${G_MEMBER}'`);
  await asConnection(`select public.silo_api_record_failure('silo_api_query', 'x')`, { path: '/rpc/silo_api_record_failure' });
  assert.equal((await one(`select last_used_at from public.silo_api_grants where id = '${G_MEMBER}'`)).last_used_at, null,
    'a bot that only fails is not in use, for the 30-day idle policy');
  await db.exec('truncate public.silo_api_call_log');
  await asConnection(`select public.silo_api_record_failure('silo_api_query', 'x')`,
    { integration: false, path: '/rpc/silo_api_record_failure' });
  await asConnection(`select public.silo_api_record_failure('silo_api_query', 'x')`,
    { grant: G_REVOKED, path: '/rpc/silo_api_record_failure' });
  assert.equal((await rows()).length, 0);
});

await test('existing rows read as successes, and outcome only takes two values', async () => {
  await db.exec('truncate public.silo_api_call_log');
  await call({});
  assert.equal((await rows())[0].outcome, 'ok');
  await assert.rejects(db.exec(`insert into public.silo_api_call_log (company_entity_id, tool, outcome)
                                values ('${A}', 'silo_api_query', 'maybe')`));
});

await test('no client role but the integration and signed-in roles may call either function', async () => {
  for (const fn of ['public.silo_api_connect()', 'public.silo_api_record_failure(text, text)']) {
    assert.equal((await one(`select has_function_privilege('anon', '${fn}', 'execute') as p`)).p, false, `${fn} for anon`);
    assert.equal((await one(`select has_function_privilege('silo_integration', '${fn}', 'execute') as p`)).p, true, fn);
  }
});

await test('verify_v2_schema.sql\'s call-log check reads ok against this schema', async () => {
  // The block itself, out of the file the drift check runs, so a check that
  // cannot pass (or cannot fail) is caught here and not on production.
  const verify = readFileSync('supabase/verify_v2_schema.sql', 'utf8');
  const i = verify.indexOf("select 'connection call log' as check_name");
  const j = verify.indexOf('end as status;', i) + 'end as status;'.length;
  assert.ok(i > 0 && j > i);
  assert.equal((await one(verify.slice(i, j))).status, 'ok');
});

// ── Idempotence ───────────────────────────────────────────────────────────
await test('re-applying the migration changes nothing and keeps the rows', async () => {
  const before = await q(`select count(*)::int as n from public.silo_api_call_log`);
  await apply(MIGRATION);
  await apply(MIGRATION2);
  await apply(MIGRATION3);
  await apply(MIGRATION4);
  await apply(MIGRATION);
  await apply(MIGRATION2);
  await apply(MIGRATION3);
  await apply(MIGRATION4);
  assert.deepEqual(await q(`select count(*)::int as n from public.silo_api_call_log`), before);
  assert.equal((await q(`select 1 from pg_policy
                          where polrelid = 'public.silo_api_call_log'::regclass`)).length, 1);
  assert.deepEqual(await call({}), { ok: true }, 'the gate still works after a re-apply');
});

console.log(`\n${passed} checks passed${mutation ? ` (mutation ${mutation})` : ''}`);
await db.close();
