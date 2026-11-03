/* The feed-health surface: 20261103220000, applied on top of 20261103190000.
 *
 * What can go wrong here is not arithmetic, it is a surface that LOOKS
 * trustworthy:
 *   - the table readable or writable by the wrong role, so a verdict can be
 *     forged or read across tenants;
 *   - the view running as its owner, which would make RLS decorative;
 *   - the report losing the 48-hour tie-out, which is the only thing that
 *     notices the reconciler itself stopping -- without it a stalled freshness
 *     surface serves yesterday's verdicts as news, the exact failure the
 *     migration exists to end;
 *   - the catalog rows for the new relations silently not updating, because
 *     they are generated from pg_class and do not exist until a refresh;
 *   - the dated staleness notes surviving, or silo_ledger_lines_v going on
 *     calling itself the books.
 *
 * Both migrations are applied one statement at a time, with begin/commit
 * dropped, the way the SQL editor applies them.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { splitSqlStatements } from '../lib/sql-statements.mjs';

const db = new PGlite();
const root = new URL('../../', import.meta.url);
const SEED_MIGRATION = '20261103190000_chat_catalog_coverage.sql';
const MIGRATION = '20261103220000_integration_feed_health.sql';
const MUTATIONS = ['', 'no-refresh', 'keep-dates', 'ledger-books', 'open-policy', 'one-tieout', 'owner-view'];
const mutation = process.env.FEED_HEALTH_MUTATION || '';
assert.ok(MUTATIONS.includes(mutation), `Unknown mutation ${mutation}`);

const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const first = async (sql, params = []) => (await q(sql, params))[0];
let checks = 0;
const check = (name) => { checks += 1; if (process.env.VERBOSE) console.log('  ok', name); };

const seedSql = await readFile(new URL(`supabase/migrations/${SEED_MIGRATION}`, root), 'utf8');
const original = await readFile(new URL(`supabase/migrations/${MIGRATION}`, root), 'utf8');
let sql = original;
if (mutation === 'no-refresh') {
  sql = sql.replace('select public.refresh_chat_schema_catalog();', 'select 1;');
}
if (mutation === 'keep-dates') {
  // Leave 20261103190000's dated verdicts in place.
  sql = sql.replace(/-- ── 4\. The dated staleness notes come out[\s\S]*?where relname = 'silo_ledger_lines_v';/,
    'select 1;');
}
if (mutation === 'ledger-books') {
  sql = sql.replace('THIS IS ACTIVITY SILO RECORDED, NOT THE BOOKS:', 'THE ONE TO USE for the books:');
}
if (mutation === 'open-policy') {
  sql = sql.replace('for select using (company_entity_id = public.active_company_id());',
    'for select using (true);');
}
if (mutation === 'one-tieout') {
  sql = sql.replace(/,\n  \(r\.id, 'Every verdict was formed in the last 48 hours'[\s\S]*?trusting the report\.'\);/, ';');
}
if (mutation === 'owner-view') {
  sql = sql.replace('with (security_invoker = true) as', 'as');
}
assert.ok(!mutation || sql !== original, `mutation ${mutation} changed nothing`);

/* The foundation both migrations assume: the catalog, the saved-report tables
   with their real constraints, and stubs for the three functions they call. */
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;


  create table public.silo_chat_schema_catalog (
    relname text primary key,
    relkind text not null,
    columns jsonb not null default '[]'::jsonb,
    description text,
    keywords text[],
    is_hidden boolean not null default false,
    reportable boolean not null default false,
    auto_refreshed_at timestamptz,
    updated_at timestamptz not null default now()
  );

  create table public.silo_chat_saved_reports (
    id uuid primary key,
    company_entity_id uuid,
    created_by uuid,
    source text not null,
    visibility text not null,
    title text not null,
    description text,
    question text,
    answer text,
    queries_run text[] not null default '{}',
    parameters jsonb not null default '[]'::jsonb,
    columns_metadata jsonb not null default '{}'::jsonb,
    archived_at timestamptz,
    updated_at timestamptz not null default now()
  );

  create table public.silo_report_tieouts (
    id uuid primary key default gen_random_uuid(),
    report_id uuid not null references public.silo_chat_saved_reports(id) on delete cascade,
    name text not null,
    kind text not null check (kind in ('reconciliation', 'sanity')),
    check_sql text not null,
    tolerance numeric not null default 0,
    enabled boolean not null default true,
    note text,
    created_at timestamptz not null default now(),
    unique (report_id, name)
  );

  create function public.active_company_id() returns uuid
    language sql stable as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$;
  create function public.attach_stamp_company_entity_id_triggers() returns void
    language sql as $fn$ select null::void $fn$;
  -- The real one generates a row per public relation from pg_catalog and
  -- preserves the curated fields; that generation is the behaviour under test.
  create function public.refresh_chat_schema_catalog() returns integer
    language plpgsql as $fn$
    declare v integer;
    begin
      insert into public.silo_chat_schema_catalog (relname, relkind, auto_refreshed_at)
      select c.relname,
             case c.relkind when 'r' then 'table' when 'v' then 'view' when 'm' then 'matview' end,
             now()
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'v', 'm')
      on conflict (relname) do update set auto_refreshed_at = now();
      select count(*) into v from public.silo_chat_schema_catalog;
      return v;
    end $fn$;
`);

// Every relation 20261103190000 seeds or hides, as the catalog holds them
// before it runs: sync_jobs with its curated description, the rest with none.
const SEEDED = [...seedSql.matchAll(/^\('([a-z0-9_]+)',$/gm)].map((m) => m[1]);
const HIDDEN = [...seedSql.match(/set is_hidden = true[\s\S]*?\) and not is_hidden;/)[0]
  .matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
assert.ok(SEEDED.length >= 50 && HIDDEN.length === 11, 'the seed parse is wrong');
const CURATED_SYNC_JOBS = 'Per-connection sync run log. One row per stage per run.';
for (const relname of [...SEEDED, ...HIDDEN]) {
  await q('insert into public.silo_chat_schema_catalog (relname, relkind, description) values ($1, $2, $3)',
    [relname, relname.endsWith('_v') ? 'view' : 'table', relname === 'sync_jobs' ? CURATED_SYNC_JOBS : null]);
}

const applyFile = async (text) => {
  for (const statement of splitSqlStatements(text)) {
    if (/^(begin|commit)$/i.test(statement.text.trim())) continue;
    await db.exec(statement.text);
  }
};
await applyFile(seedSql);
const apply = () => applyFile(sql);
await apply();

const cat = (relname) => first('select * from public.silo_chat_schema_catalog where relname = $1', [relname]);
const REPORT = 'c8000000-0000-4000-a000-000000000001';

// ── 1. The table only its writer can write ────────────────────────────────
check('the table exists, with current-state identity rather than history');
const identity = await first(`select pg_get_constraintdef(oid) as def from pg_constraint
                               where conrelid = 'public.integration_feed_health'::regclass
                                 and conname = 'integration_feed_health_identity'`);
assert.ok(identity, 'no identity constraint: every run would append another copy of each feed');
assert.match(identity.def, /NULLS NOT DISTINCT/i,
  'a row that reached the table without a connection_id would otherwise be inserted again every run rather than replaced');

check('row-level security is on and scoped to the active company');
const rls = await first(`select relrowsecurity from pg_class where oid = 'public.integration_feed_health'::regclass`);
assert.equal(rls.relrowsecurity, true);
const policies = await q(`select polcmd, pg_get_expr(polqual, polrelid) as qual
                            from pg_policy where polrelid = 'public.integration_feed_health'::regclass`);
assert.equal(policies.length, 1, 'read-only: the reconciler writes as the service role, nothing else writes at all');
assert.equal(policies[0].polcmd, 'r');
assert.match(policies[0].qual, /active_company_id/,
  'without the company predicate one tenant reads another tenant feed health');

check('severity is constrained, so a bad write cannot invent a state the UI does not colour');
await assert.rejects(
  () => q(`insert into public.integration_feed_health (company_entity_id, feed, state, severity)
           values ('11111111-1111-1111-1111-111111111111', 'sales', 'ok', 'catastrophe')`),
  /severity/);

check('one row per company, feed and connection, replaced rather than appended');
const CO = '11111111-1111-1111-1111-111111111111';
const put = (feed, connection, state, severity, observedAt) =>
  q(`insert into public.integration_feed_health (company_entity_id, feed, connection_id, state, severity, observed_at)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (company_entity_id, feed, connection_id) do update
       set state = excluded.state, severity = excluded.severity, observed_at = excluded.observed_at`,
    [CO, feed, connection, state, severity, observedAt]);
await put('redo', null, 'ok', 'ok', new Date().toISOString());
await put('redo', null, 'stale', 'action', new Date().toISOString());
assert.equal((await q(`select 1 from public.integration_feed_health where feed = 'redo'`)).length, 1,
  'the company-grained feed must not have doubled');
assert.equal((await first(`select state from public.integration_feed_health where feed = 'redo'`)).state, 'stale');

// ── 2. The view, and the age of its own judgement ─────────────────────────
check('the view runs as its caller, so the policy above is the boundary');
const view = await first(`select reloptions from pg_class where relname = 'silo_feed_health_v'`);
assert.ok((view.reloptions || []).includes('security_invoker=true'),
  'as owner it would read every tenant through RLS it bypasses');

check('a verdict older than 36 hours is marked stale, not served as news');
await put('sales', null, 'ok', 'ok', new Date(Date.now() - 40 * 3600 * 1000).toISOString());
const stale = await first(`select observation_stale, observed_hours_ago from public.silo_feed_health_v where feed = 'sales'`);
assert.equal(stale.observation_stale, true);
assert.ok(Number(stale.observed_hours_ago) >= 39);
const fresh = await first(`select observation_stale from public.silo_feed_health_v where feed = 'redo'`);
assert.equal(fresh.observation_stale, false);

// ── 3. The report and the tie-out that catches the reconciler stopping ────
check('the Data freshness report is a system report every surface can run');
const report = await first('select * from public.silo_chat_saved_reports where id = $1', [REPORT]);
assert.ok(report, 'no report: the MCP, the API and Ask SILO all see nothing');
assert.equal(report.source, 'system');
assert.equal(report.company_entity_id, null);
assert.match(report.queries_run[0], /silo_feed_health_v/);
assert.match(report.description, /never delivered/,
  'the description must say that behind is not a decline, which is the mistake it prevents');

check('it carries both tie-outs, including the one that notices the reconciler stopping');
const tieouts = await q('select name, kind, check_sql from public.silo_report_tieouts where report_id = $1 order by name', [REPORT]);
assert.equal(tieouts.length, 2);
const age = tieouts.find((t) => /48 hours/.test(t.name));
assert.ok(age, 'without this check a stalled freshness surface serves yesterday verdicts as news');
assert.match(age.check_sql, /48 hours/);
assert.match(age.check_sql, /integration_feed_health/);
for (const t of tieouts) {
  assert.match(t.check_sql, /left_value/);
  assert.match(t.check_sql, /right_value/);
  assert.match(t.check_sql, /md5\(queries_run/, 'a check whose report has changed must read NO DATA, not a stale pass');
}

// ── 4. The catalog ────────────────────────────────────────────────────────
check('the two new relations are described, which needs the refresh to have run');
const health = await cat('silo_feed_health_v');
assert.ok(health && health.keywords && health.keywords.length >= 3);
assert.match(health.description, /BLANK IS NOT ZERO/);
assert.match(health.description, /observation_stale/, 'a bot must know the verdicts themselves can be old');
assert.ok((await cat('integration_feed_health')).description, 'the base table must point at the view');

check('no seeded description states a date any more');
for (const relname of SEEDED) {
  const description = (await cat(relname)).description || '';
  assert.ok(!/20\d\d-\d\d-\d\d/.test(description),
    `${relname} still carries a dated claim, which rots the day the feed resumes`);
}

check('the descriptions that had a staleness verdict now say where to check instead');
assert.match((await cat('payroll_register_lines')).description, /COVERAGE IS NOT CONTINUOUS/);
assert.match((await cat('payroll_register_lines')).description, /silo_feed_health_v/);
assert.match((await cat('ar_invoices')).description, /max\(last_seen_at\)/);
assert.match((await cat('product_tags')).description, /uploaded_at/);

check('silo_ledger_lines_v no longer calls itself the books');
const ledger = await cat('silo_ledger_lines_v');
assert.match(ledger.description, /NOT THE BOOKS/);
assert.match(ledger.description, /accounting_opening_balances/,
  'it must name the source that does answer a balance question');
assert.match(ledger.description, /quickbooks_report_runs/);
assert.ok(!/THE ONE TO USE/.test(ledger.description),
  'an account balance from this view alone is understated by the opening balance and by everything SILO did not originate');

check('a curated description elsewhere is still untouched');
assert.equal((await cat('sync_jobs')).description, CURATED_SYNC_JOBS);

// ── 5. Idempotence ────────────────────────────────────────────────────────
check('re-applying changes nothing');
const before = await q(`select relname, description, keywords, is_hidden from public.silo_chat_schema_catalog order by relname`);
const tiesBefore = await q('select name, kind, check_sql from public.silo_report_tieouts order by name');
await apply();
await apply();
assert.deepEqual(
  JSON.parse(JSON.stringify(await q(`select relname, description, keywords, is_hidden from public.silo_chat_schema_catalog order by relname`))),
  JSON.parse(JSON.stringify(before)));
assert.deepEqual(
  JSON.parse(JSON.stringify(await q('select name, kind, check_sql from public.silo_report_tieouts order by name'))),
  JSON.parse(JSON.stringify(tiesBefore)));
assert.equal((await q('select 1 from public.silo_report_tieouts where report_id = $1', [REPORT])).length, 2,
  'the tie-outs are deleted and rewritten, never duplicated');
check('and the rows a run published survive a re-apply');
assert.equal((await q('select 1 from public.integration_feed_health')).length, 2,
  'applying the migration again must not wipe the verdicts');

console.log(`${checks} feed-health checks passed${mutation ? ` (mutation ${mutation})` : ''}`);
await db.close();
