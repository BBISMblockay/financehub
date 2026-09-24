// SEO workflow regressions against a REAL PostgreSQL (PGlite): the committed
// migrations, role switching and RLS -- not a mock, and not the service role.
//
// docs/ops/seo-project.md named the open gap twice: scripts/sql/verify_seo_workflow.sql
// runs as service role, so approval enforcement and company isolation were
// "asserted structurally" and never executed. This suite executes them, plus
// the measurement slice added by 20260914120000 (deterministic capture, the
// publication-requires-approval guard, and the follow-up window ordering).
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/seo-workflow-database.test.mjs
// Mutations (each must fail exactly one assertion):
//   SEO_DB_MUTATION=no-approval-guard   (publication guard removed)
//   SEO_DB_MUTATION=follow-up-unordered (follow-up ordering removed)
//   SEO_DB_MUTATION=publication-after-follow-up (publication side of the follow-up rule removed)
//   SEO_DB_MUTATION=direct-insert-open (insert policy no longer refuses captured sources)
//   SEO_DB_MUTATION=stale-write-allowed (the newest-run-wins triggers removed)
//   SEO_DB_MUTATION=baseline-session-timezone (seo_baseline_conflicts back to p_published::date)
//   SEO_DB_MUTATION=triggers-pacific-only (both triggers pass Pacific instead of the row's company timezone)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
import { splitSqlStatements } from '../lib/sql-statements.mjs';

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const migrations = ['20260914120000_seo_measurement_capture.sql', '20260914130000_search_console_newest_run_wins.sql',
  // The business-timezone sweep: the one helper, then the SEO triggers that use it.
  '20260924130000_business_timezone_core.sql', '20260924130100_business_timezone_seo.sql'];
const dependencies = [
  '20260616060000_stamp_company_entity_id_on_insert.sql',
  '20260909220000_page_inspection.sql',
  '20260909240000_seo_project_workflow.sql',
  '20260909260000_seo_workflow_integrity.sql',
  '20260909300000_seo_baseline_business_timezone.sql',
  '20260909380000_seo_collection_candidates.sql',
  '20260909400000_seo_candidates_coverage_and_pacific.sql',
  '20260909420000_seo_candidates_top_n_day_names.sql',
  '20260910130000_seo_approvers_stamp_and_granted_by.sql',
  '20260910180000_search_console_daily.sql',
  '20260910190000_search_console_page_absence_caveat.sql',
  '20260910200000_search_console_query_cap_caveat.sql',
  '20260910210000_search_console_overview_rpcs.sql',
];
const mutation = process.env.SEO_DB_MUTATION || '';
assert.ok(['', 'no-approval-guard', 'follow-up-unordered', 'publication-after-follow-up', 'direct-insert-open', 'stale-write-allowed', 'baseline-session-timezone', 'triggers-pacific-only'].includes(mutation), 'Unknown SEO database mutation');

const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const first = async (sql, params = []) => (await q(sql, params))[0];
const scalar = async (sql, params = []) => Object.values(await first(sql, params))[0];
const co = randomUUID(), otherCo = randomUUID();
const member = randomUUID(), approver = randomUUID(), outsider = randomUUID();
const SITE = 'https://www.baseballism.com/';
const SHOP = 'baseballism.myshopify.com';
let passed = 0;

async function asRole(role, user, fn) {
  assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
  await db.exec(`set role ${role}`);
  await q("select set_config('request.jwt.claim.sub', $1, false)", [user || '']);
  try { return await fn(); }
  finally {
    await db.exec('reset role');
    await q("select set_config('request.jwt.claim.sub', '', false)");
  }
}
const asMember = (fn) => asRole('authenticated', member, fn);
const asApprover = (fn) => asRole('authenticated', approver, fn);
const asOutsider = (fn) => asRole('authenticated', outsider, fn);
async function refused(fn, pattern, label) {
  let message = null;
  try { await fn(); } catch (error) { message = error.message; }
  assert.ok(message !== null, `${label}: expected a refusal`);
  assert.match(message, pattern, `${label}: ${message}`);
}
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (error) {
    console.error(`not ok - ${name}`);
    if (error.query) delete error.query;
    throw error;
  }
}
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

async function project(actor = member) {
  return asRole('authenticated', actor, () => scalar(
    "insert into seo_projects (company_entity_id, name, objective) values ($1, 'Synthetic project', 'test') returning id", [co]));
}
async function task(projectId, { actor = member, url = 'https://www.baseballism.com/collections/mlb', type = 'collection', handle = null } = {}) {
  return asRole('authenticated', actor, () => scalar(
    `insert into seo_tasks (company_entity_id, project_id, title, target_type, target_url, target_handle)
     values ($1, $2, 'Synthetic task', $3, $4, $5) returning id`, [co, projectId, type, url, handle]));
}
const approve = (id) => asApprover(() => q("update seo_tasks set approval_status='approved', approved_by=$2, approved_at=now() where id=$1", [id, approver]));
const publish = (id, at, actor = member) => asRole('authenticated', actor, () => scalar(
  "insert into seo_task_publications (company_entity_id, task_id, published_at, method, note) values ($1, $2, $3, 'manual_confirmation', 'test') returning id", [co, id, at]));
const capture = (id, kind, start, end, actor = member) => asRole('authenticated', actor, () => scalar(
  'select public.seo_capture_measurements($1, $2, $3, $4)', [id, kind, start, end]));
const rowsFor = (id) => q('select * from seo_measurements where task_id=$1 order by source, metric', [id]);

// The seeded window. Business "today" is real (Pacific); every seeded day is
// well before it so period_end is always a completed day.
const START = '2026-08-01';
const PUB = '2026-09-01T17:00:00Z'; // 10:00 Pacific on 2026-09-01

try {
  await db.exec(await readFile(new URL('./seo-db-bootstrap.sql', import.meta.url), 'utf8'));
  for (const name of dependencies) {
    try { await db.exec(await readFile(new URL(`supabase/migrations/${name}`, root), 'utf8')); }
    catch (error) { throw new Error(`Dependency migration failed: ${name}: ${error.message}`, { cause: error }); }
  }
  await q("insert into entities(id,title) values ($1,'Synthetic A'),($2,'Synthetic B')", [co, otherCo]);
  await q('insert into auth.users(id) values ($1),($2),($3)', [member, approver, outsider]);
  await q(`insert into profiles(id,name,role,department,active_company_id) values
    ($1,'Member A','user','marketing',$4),($2,'Exec A','executive','exec',$4),($3,'Member B','user','marketing',$5)`,
  [member, approver, outsider, co, otherCo]);
  await q(`insert into entity_memberships(entity_id,user_id,role) values
    ($1,$2,'member'),($1,$3,'admin'),($4,$5,'member')`, [co, member, approver, otherCo, outsider]);
  await q(`insert into shopify_shop_domains(company_entity_id,shop_domain,host,kind) values
    ($1,$2,'www.baseballism.com','primary'),($1,$2,'baseballism.myshopify.com','myshopify'),
    ($1,'baseballismwholesale.myshopify.com','baseballismb2b.com','primary')`, [co, SHOP]);
  // 41 days of site rows (2026-08-01 .. 2026-09-10), page rows for /collections/mlb on
  // 20 of the first 28 days, landing rows on 10 of them.
  for (let i = 0; i < 41; i++) {
    const day = addDays(START, i);
    await q(`insert into search_console_site_daily(company_entity_id,site_url,day_date,clicks,impressions,ctr,position,
      page_rows,page_attributed_clicks,page_attributed_impressions,query_rows,query_attributed_clicks,query_attributed_impressions)
      values ($1,$2,$3,100,1000,0.1,8.5,50,100,1200,40,60,700)`, [co, SITE, day]);
    if (i < 20) {
      await q(`insert into search_console_page_daily(company_entity_id,site_url,day_date,page,clicks,impressions,ctr,position)
        values ($1,$2,$3,$4,$5,$6,$7,$8)`, [co, SITE, day, 'https://www.baseballism.com/collections/mlb', 5, 100, 0.05, i % 2 === 0 ? 4 : 8]);
    }
    if (i < 10) {
      await q(`insert into shopify_landing_pages_daily(company_entity_id,shop_domain,day_date,landing_page_path,sessions,sessions_that_completed_checkout,is_truncated)
        values ($1,$2,$3,'/collections/mlb',30,3,true)`, [co, SHOP, day]);
    }
  }
  // Another company's rows must never surface.
  await q(`insert into search_console_site_daily(company_entity_id,site_url,day_date,clicks,impressions) values ($1,'https://other.example/','2026-08-05',999,9999)`, [otherCo]);
  await q(`insert into search_console_page_daily(company_entity_id,site_url,day_date,page,clicks,impressions) values ($1,'https://other.example/','2026-08-05','https://other.example/collections/mlb',999,9999)`, [otherCo]);

  await test('measurement migration applies twice on top of the committed SEO migrations', async () => {
    for (const name of migrations) {
      const sql = await readFile(new URL(`supabase/migrations/${name}`, root), 'utf8');
      await db.exec(sql);
      await db.exec(sql);
    }
    assert.equal(await scalar("select count(*)::int from pg_trigger where tgname in ('trg_seo_publication_admissible','trg_seo_measurement_window')"), 2);
    assert.equal(await scalar("select to_regprocedure('public.check_seo_baseline_precedes_publication()')"), null, 'the one-sided trigger function is gone');
    if (mutation === 'no-approval-guard') await db.exec('drop trigger trg_seo_publication_admissible on public.seo_task_publications');
    if (mutation === 'follow-up-unordered') {
      const def = await scalar("select pg_get_functiondef('public.check_seo_measurement_window()'::regprocedure)");
      assert.ok(def.includes("elsif new.window_kind = 'follow_up' then"), 'mutation must remove the live follow-up branch');
      await db.exec(def.replace("elsif new.window_kind = 'follow_up' then", "elsif false then"));
    }
    if (mutation === 'publication-after-follow-up') {
      const def = await scalar("select pg_get_functiondef('public.check_publication_after_baselines()'::regprocedure)");
      assert.ok(def.includes('if v_follow is not null then'), 'mutation must remove the live follow-up check');
      await db.exec(def.replace('if v_follow is not null then', 'if false then'));
    }
    if (mutation === 'stale-write-allowed') {
      for (const t of ['search_console_site_daily', 'search_console_page_daily', 'search_console_query_daily']) {
        await db.exec(`drop trigger trg_search_console_newest_run_wins on public.${t}`);
      }
    }
    if (mutation === 'baseline-session-timezone') {
      const def = await scalar("select pg_get_functiondef('public.seo_baseline_conflicts(date,timestamptz,text)'::regprocedure)");
      assert.ok(def.includes('at time zone p_tz'), 'mutation must remove the live conversion');
      await db.exec(def.replace('(p_published at time zone p_tz)::date', 'p_published::date'));
    }
    if (mutation === 'triggers-pacific-only') {
      for (const fn of ['check_publication_after_baselines', 'check_seo_measurement_window']) {
        const def = await scalar(`select pg_get_functiondef('public.${fn}()'::regprocedure)`);
        assert.ok(def.includes('v_tz := public.silo_company_timezone(new.company_entity_id);'), `${fn}: mutation must find the lookup`);
        await db.exec(def.replace('v_tz := public.silo_company_timezone(new.company_entity_id);', "v_tz := 'America/Los_Angeles';"));
      }
    }
    if (mutation === 'direct-insert-open') {
      await db.exec(`drop policy seo_measurements_insert on public.seo_measurements;
        create policy seo_measurements_insert on public.seo_measurements for insert to authenticated
          with check (company_entity_id = public.active_company_id())`);
    }
  });

  await test('capture and window functions are authenticated-only under Supabase default grants', async () => {
    for (const fn of ['public.seo_capture_measurements(uuid,text,date,date)', 'public.seo_follow_up_window(uuid,integer)']) {
      assert.equal(await scalar(`select has_function_privilege('anon', '${fn}', 'execute')`), false, `${fn} anon`);
      assert.equal(await scalar(`select has_function_privilege('authenticated', '${fn}', 'execute')`), true, `${fn} authenticated`);
    }
    assert.equal(await scalar("select prosecdef from pg_proc where proname='seo_capture_measurements'"), true, 'the capture is the only writer, so it is DEFINER');
    assert.equal(await scalar("select prosecdef from pg_proc where proname='seo_follow_up_window'"), false, 'the window reader stays INVOKER');
  });

  let proj, t1;
  await test('a member drafts a task but cannot leave it approved; an approver can', async () => {
    proj = await project();
    t1 = await task(proj);
    await asMember(() => q("update seo_tasks set approval_status='proposed' where id=$1", [t1]));
    await refused(() => asMember(() => q("update seo_tasks set approval_status='approved' where id=$1", [t1])),
      /row-level security/i, 'member approving');
    assert.equal(await scalar('select approval_status from seo_tasks where id=$1', [t1]), 'proposed');
    await approve(t1);
    assert.equal(await scalar('select approval_status from seo_tasks where id=$1', [t1]), 'approved');
    assert.equal(await scalar('select is_published from seo_tasks_v where id=$1', [t1]), false, 'approval does not publish');
  });

  await test('another company sees nothing and cannot write into this one', async () => {
    assert.equal((await asOutsider(() => q('select id from seo_tasks where id=$1', [t1]))).length, 0);
    assert.equal((await asOutsider(() => q('select id from seo_projects where id=$1', [proj]))).length, 0);
    await refused(() => asOutsider(() => q("insert into seo_tasks (company_entity_id, project_id, title) values ($1,$2,'x')", [co, proj])),
      /row-level security|violates/i, 'outsider inserting a task');
    await refused(() => asOutsider(() => q("insert into seo_measurements (company_entity_id, task_id, source, metric, value, window_kind, period_start, period_end) values ($1,$2,'manual','x',1,'baseline','2026-08-01','2026-08-02')", [otherCo, t1])),
      /foreign key|row-level security|violates/i, 'outsider citing a foreign task');
  });

  await test('editing a draft mints an immutable revision no client can write; an approved task is closed to its author', async () => {
    const draft = await task(proj);
    await asMember(() => q("update seo_tasks set proposed_title='New title', revision_note='first pass' where id=$1", [draft]));
    const rev = await first('select revision_number, changed_fields, change_summary from seo_task_revisions where task_id=$1', [draft]);
    assert.ok(rev, 'revision written');
    assert.deepEqual(rev.changed_fields, ['proposed_title']);
    assert.equal(rev.change_summary, 'first pass');
    await refused(() => asMember(() => q("insert into seo_task_revisions (company_entity_id, task_id, revision_number, snapshot) values ($1,$2,9,'{}')", [co, draft])),
      /row-level security|permission denied/i, 'client writing history');
    // The author cannot edit a task that is approved: WITH CHECK refuses leaving
    // the row approved unless the writer may approve. An approver can.
    await refused(() => asMember(() => q("update seo_tasks set proposed_title='Edited after approval' where id=$1", [t1])),
      /row-level security/i, 'author editing an approved task');
    await asApprover(() => q("update seo_tasks set proposed_title='Edited by approver' where id=$1", [t1]));
    assert.equal(await scalar('select count(*)::int from seo_task_revisions where task_id=$1', [t1]), 3, 'proposed, approved, then the approver edit');
  });

  let t2;
  await test('a publication may cite only an approved task and never a future date', async () => {
    t2 = await task(proj);
    if (mutation === 'no-approval-guard') {
      await publish(t2, PUB); // the mutation lets this through; the assertion below fails
      assert.fail('a draft task accepted a publication');
    }
    await refused(() => publish(t2, PUB), /approval_status is draft/, 'publishing a draft');
    await refused(() => publish(t1, '2999-01-01T00:00:00Z'), /in the future/, 'future publication');
    const pubId = await publish(t1, PUB);
    assert.ok(pubId);
    assert.equal(await scalar('select is_published from seo_tasks_v where id=$1', [t1]), true, 'publication row makes it live');
    assert.equal(await scalar('select approval_status from seo_tasks where id=$1', [t1]), 'approved', 'publication did not touch approval');
  });

  let t3;
  await test('baseline capture is deterministic: pooled CTR, weighted position, NULL for absence, frozen on repeat', async () => {
    t3 = await task(proj);
    const END = addDays(START, 27); // 28 days
    const result = await capture(t3, 'baseline', START, END);
    assert.equal(result.rows_written, 8);
    assert.equal(result.target_path, '/collections/mlb');
    assert.equal(result.sources.search_console_page.site_days_ingested, 28);
    assert.equal(result.sources.search_console_page.page_days_returned, 20);
    const rows = await rowsFor(t3);
    const byKey = Object.fromEntries(rows.map((r) => [`${r.source}:${r.metric}`, r]));
    assert.equal(Number(byKey['search_console_page:clicks'].value), 100, '20 days x 5 clicks');
    assert.equal(Number(byKey['search_console_page:impressions'].value), 2000);
    assert.equal(Number(byKey['search_console_page:ctr'].value), 0.05, 'pooled, not averaged');
    assert.equal(Number(byKey['search_console_page:position'].value), 6, 'impression-weighted: equal impressions, positions 4 and 8');
    assert.equal(Number(byKey['search_console_page:page_days_returned'].value), 20);
    assert.equal(byKey['search_console_page:clicks'].is_complete, true, 'every site day present, none truncated');
    assert.equal(byKey['search_console_page:clicks'].dimensions.page_path, '/collections/mlb');
    assert.equal(byKey['search_console_page:clicks'].filters.data_state, 'final');
    assert.equal(Number(byKey['shopify_landing_pages:sessions'].value), 300);
    assert.equal(Number(byKey['shopify_landing_pages:sessions_that_completed_checkout'].value), 30);
    assert.equal(byKey['shopify_landing_pages:sessions'].is_complete, false, 'top-N table is never complete');
    assert.match(byKey['shopify_landing_pages:sessions'].completeness_note, /NOT organic sessions/);
    assert.match(byKey['search_console_page:clicks'].completeness_note, /NOT RETURNED, never zero/);
    assert.ok(rows.every((r) => r.window_kind === 'baseline' && r.created_by === member), 'attributed to the caller');

    const again = await capture(t3, 'baseline', START, END);
    assert.equal(again.already_captured, true);
    assert.equal((await rowsFor(t3)).length, 8, 'frozen: nothing re-written');

    // A window with a missing site day is marked incomplete, and a window that
    // is not a completed Pacific day is refused outright.
    const t3b = await task(proj);
    await q("delete from search_console_site_daily where company_entity_id=$1 and day_date='2026-08-10'", [co]);
    const partial = await capture(t3b, 'baseline', START, END);
    assert.equal(partial.sources.search_console_page.site_days_ingested, 27);
    assert.equal((await first("select is_complete from seo_measurements where task_id=$1 and metric='clicks'", [t3b])).is_complete, false);
    await q(`insert into search_console_site_daily(company_entity_id,site_url,day_date,clicks,impressions,page_attributed_clicks,query_attributed_clicks) values ($1,$2,'2026-08-10',100,1000,100,60)`, [co, SITE]);
    await refused(() => capture(t3b, 'baseline', '2026-09-01', '2999-12-31'), /not a completed Pacific day/, 'future window');
  });

  await test('absent page: NULL values with a note, never zero; other company rows never leak', async () => {
    const t = await task(proj, { url: 'https://www.baseballism.com/collections/nothing-here' });
    const result = await capture(t, 'baseline', START, addDays(START, 6));
    assert.equal(result.sources.search_console_page.page_days_returned, 0);
    assert.equal(result.sources.search_console_page.clicks, null);
    const rows = await rowsFor(t);
    const clicks = rows.find((r) => r.source === 'search_console_page' && r.metric === 'clicks');
    assert.equal(clicks.value, null);
    assert.match(clicks.completeness_note, /not returned on any day/);
    const sessions = rows.find((r) => r.source === 'shopify_landing_pages' && r.metric === 'sessions');
    assert.equal(sessions.value, null);
    assert.match(sessions.completeness_note, /absent from the top-N/);
    const days = rows.find((r) => r.metric === 'page_days_returned');
    assert.equal(Number(days.value), 0);
    // The other company has a /collections/mlb row on 2026-08-05 with 999 clicks;
    // the member's capture of that day must not include it.
    const tm = await task(proj);
    const r2 = await capture(tm, 'baseline', '2026-08-05', '2026-08-05');
    assert.equal(r2.sources.search_console_page.clicks, 5);
  });

  await test('host resolution: a B2B host is not the DTC property, an unknown host captures nothing', async () => {
    const b2b = await task(proj, { url: 'https://baseballismb2b.com/collections/mlb' });
    const result = await capture(b2b, 'baseline', START, addDays(START, 6));
    assert.match(result.sources.search_console_page.skipped, /not covered by the ingested property/);
    assert.equal(result.sources.shopify_landing_pages.shop_domain, 'baseballismwholesale.myshopify.com');
    assert.equal(result.rows_written, 3, 'only the landing-page rows, for the B2B shop');
    const foreign = await task(proj, { url: 'https://example.com/collections/mlb' });
    await refused(() => capture(foreign, 'baseline', START, addDays(START, 6)), /nothing could be captured/, 'unknown host');
    const handleOnly = await task(proj, { url: null, type: 'collection', handle: 'mlb' });
    const h = await capture(handleOnly, 'baseline', START, addDays(START, 6));
    assert.equal(h.sources.search_console_page.page_days_returned, 7, 'a handle resolves to the property');
    assert.match(h.sources.shopify_landing_pages.skipped, /no host/);
    const none = await task(proj, { url: null, type: 'page', handle: null });
    await refused(() => capture(none, 'baseline', START, addDays(START, 6)), /no target page/, 'no target');
  });

  await test('windows are ordered against the publication in both directions', async () => {
    await approve(t3);
    // t3 has a baseline 08-01..08-28; publishing at 08-20 would straddle it.
    await refused(() => publish(t3, '2026-08-20T17:00:00Z'), /already has a baseline/, 'publication inside a baseline');
    await publish(t3, PUB);
    await refused(() => capture(t3, 'baseline', '2026-08-15', '2026-09-01'), /follow-up, not a baseline/, 'baseline reaching the change');
    if (mutation === 'follow-up-unordered') {
      await capture(t3, 'follow_up', '2026-08-25', '2026-09-01');
      assert.fail('a follow-up starting before the change was accepted');
    }
    await refused(() => capture(t3, 'follow_up', '2026-09-01', '2026-09-05'), /starts after the change/, 'follow-up on the publication day');
    await refused(() => capture(t2, 'follow_up', '2026-09-02', '2026-09-05'), /needs a recorded publication/, 'follow-up with no publication');
    const fu = await capture(t3, 'follow_up', '2026-09-02', '2026-09-05');
    assert.equal(fu.rows_written, 8);
    assert.equal((await q("select count(*)::int as n from seo_measurements where task_id=$1 and window_kind='follow_up'", [t3]))[0].n, 8);
    // Project-level rows are not ordered against any publication.
    await asMember(() => q("insert into seo_measurements (company_entity_id, project_id, source, metric, value, window_kind, period_start, period_end) values ($1,$2,'manual','note',1,'follow_up','2026-01-01','2026-01-02')", [co, proj]));
  });

  await test('seo_follow_up_window returns the equivalent window and says why it is not measurable yet', async () => {
    const w30 = await asMember(() => first('select * from seo_follow_up_window($1, 30)', [t3]));
    assert.equal(iso(w30.published_on), '2026-09-01');
    assert.equal(w30.baseline_days, 28);
    assert.equal(iso(w30.period_end), '2026-10-01');
    assert.equal(iso(w30.period_start), '2026-09-04');
    assert.equal(w30.measurable, false);
    assert.match(w30.reason, /not a completed business day|Search Console data ends/);
    const w10 = await asMember(() => first('select * from seo_follow_up_window($1, 10)', [t3]));
    assert.equal(w10.measurable, false);
    assert.match(w10.reason, /start on or before the change/);
    // A short baseline whose follow-up window is fully ingested is measurable.
    const t5 = await task(proj);
    await capture(t5, 'baseline', '2026-08-20', '2026-08-24');
    await approve(t5);
    await publish(t5, PUB);
    const w7 = await asMember(() => first('select * from seo_follow_up_window($1, 7)', [t5]));
    assert.equal(iso(w7.period_start), '2026-09-04');
    assert.equal(iso(w7.period_end), '2026-09-08');
    assert.equal(w7.measurable, true, w7.reason);
    const fu = await capture(t5, 'follow_up', iso(w7.period_start), iso(w7.period_end));
    assert.equal(fu.rows_written, 8);
    const w0 = await asMember(() => first('select * from seo_follow_up_window($1, 30)', [t2]));
    assert.equal(w0.measurable, false);
    assert.match(w0.reason, /no publication/);
    assert.equal((await asOutsider(() => q('select * from seo_follow_up_window($1, 30)', [t3])))[0].published_on, null, 'another company sees no publication');
  });

  await test('a captured source cannot be typed in by hand; a manual row still can; the index refuses a duplicate capture', async () => {
    const t = await task(proj);
    await refused(() => asMember(() => q("insert into seo_measurements (company_entity_id, task_id, source, metric, value, window_kind, period_start, period_end) values ($1,$2,'search_console_page','clicks',999,'baseline','2026-08-01','2026-08-07')", [co, t])),
      /row-level security/i, 'member typing a Search Console number');
    await refused(() => asApprover(() => q("insert into seo_measurements (company_entity_id, task_id, source, metric, value, window_kind, period_start, period_end) values ($1,$2,'shopify_landing_pages','sessions',999,'baseline','2026-08-01','2026-08-07')", [co, t])),
      /row-level security/i, 'approver typing a landing-page number');
    await asMember(() => q("insert into seo_measurements (company_entity_id, task_id, source, metric, value, window_kind, period_start, period_end) values ($1,$2,'manual','note_count',1,'baseline','2026-08-01','2026-08-07')", [co, t]));
    const captured = await capture(t, 'baseline', START, addDays(START, 6));
    assert.equal(captured.rows_written, 8, 'the function writes what a client cannot');
    assert.ok((await rowsFor(t)).every((r) => r.company_entity_id === co));
    // The partial unique index is the guarantee behind already_captured.
    await refused(() => q("insert into seo_measurements (company_entity_id, task_id, source, metric, value, window_kind, period_start, period_end) values ($1,$2,'search_console_page','clicks',1,'baseline',$3,$4)", [co, t, START, addDays(START, 6)]),
      /seo_measurements_capture_identity|duplicate key/, 'duplicate captured metric');
    // A task in another company is not found for the DEFINER function either.
    await refused(() => capture(t, 'baseline', START, addDays(START, 3), outsider), /SEO task not found/, 'outsider capturing a foreign task');
    assert.equal((await q("select count(*)::int as n from seo_measurements where task_id=$1 and period_end=$2", [t, addDays(START, 3)]))[0].n, 0);
  });

  await test('once a follow-up is captured, a further publication is refused until an approver deletes it', async () => {
    // A follow-up measures "after the LAST change". Recording another change
    // afterwards -- inside the window, on its first day, or after it -- would
    // leave a follow-up that no longer follows the last publication, so the
    // trigger refuses all three rather than silently changing what the
    // stored window means. The approver deletes the follow-up (the only
    // delete policy) and the correction is then recorded.
    const t = await task(proj);
    await capture(t, 'baseline', '2026-08-20', '2026-08-24');
    await approve(t);
    await publish(t, PUB); // 2026-09-01
    await capture(t, 'follow_up', '2026-09-04', '2026-09-08');
    for (const at of ['2026-09-06T17:00:00Z', '2026-09-04T17:00:00Z', '2026-09-09T17:00:00Z']) {
      await refused(() => publish(t, at), /already has a follow-up window starting 2026-09-04/, `correction at ${at}`);
    }
    assert.equal((await q("select count(*)::int as n from seo_task_publications where task_id=$1", [t]))[0].n, 1, 'no publication slipped through');
    await asApprover(() => q("delete from seo_measurements where task_id=$1 and window_kind='follow_up'", [t]));
    assert.ok(await publish(t, '2026-09-09T17:00:00Z'), 'the correction is recorded once the follow-up is gone');
    const w = await asMember(() => first('select * from seo_follow_up_window($1, 7)', [t]));
    assert.equal(iso(w.published_on), '2026-09-09', 'the window now follows the latest publication');
    await refused(() => capture(t, 'follow_up', '2026-09-04', '2026-09-08'), /after the latest publication|last publication|on or before/i, 'the old window cannot be re-captured against the new change');
  });

  await test('an approver may delete a frozen capture and re-capture; a member may not delete', async () => {
    await refused(() => asMember(() => q("delete from seo_measurements where task_id=$1 and window_kind='baseline'", [t3]).then((r) => {
      if (r.length === 0) throw new Error('row-level security: 0 rows deleted');
    })), /row-level security/, 'member delete');
    assert.equal((await q("select count(*)::int as n from seo_measurements where task_id=$1 and window_kind='baseline'", [t3]))[0].n, 8, 'still frozen');
    await asApprover(() => q("delete from seo_measurements where task_id=$1 and window_kind='baseline'", [t3]));
    const again = await capture(t3, 'baseline', START, addDays(START, 27));
    assert.equal(again.rows_written, 8);
  });

  await test('Search Console: the newest completed run wins over an older run that resumes late', async () => {
    // Service-role writes (superuser here, like the sync). Run B (T2) has
    // completed 2026-07-01 on a separate property; run A (T1 < T2) then
    // upserts its own older payload for the same day: the shared page keeps
    // B's numbers, A's page B did not return is refused, the site row keeps
    // B's totals, and A's retirement (rows older than A) leaves B's rows. A
    // later run C (T3) still updates everything: nothing legitimate is refused.
    const site = 'https://interleave.example/';
    const T1 = '2026-09-13T10:00:00Z', T2 = '2026-09-13T10:05:00Z', T3 = '2026-09-13T10:10:00Z';
    const up = (table, cols, vals, conflict) => q(`insert into ${table}(${cols}) values (${vals}) on conflict (${conflict}) do update set
      clicks = excluded.clicks, impressions = excluded.impressions, synced_at = excluded.synced_at, sync_batch_id = excluded.sync_batch_id`);
    const page = (t, path, clicks, batch) => up('search_console_page_daily', 'company_entity_id,site_url,day_date,page,clicks,impressions,synced_at,sync_batch_id',
      `'${co}','${site}','2026-07-01','${site}${path}',${clicks},${clicks * 10},'${t}','${batch}'`, 'company_entity_id,site_url,day_date,page');
    const siteRow = (t, clicks, batch) => up('search_console_site_daily', 'company_entity_id,site_url,day_date,clicks,impressions,synced_at,sync_batch_id',
      `'${co}','${site}','2026-07-01',${clicks},${clicks * 10},'${t}','${batch}'`, 'company_entity_id,site_url,day_date');
    // B completes: /a, /b, then the site row last.
    await page(T2, 'a', 10, 'B'); await page(T2, 'b', 20, 'B'); await siteRow(T2, 30, 'B');
    // A resumes with an older payload: /a with different numbers, /c that B did not return, then its site row.
    await page(T1, 'a', 7, 'A'); await page(T1, 'c', 3, 'A'); await siteRow(T1, 10, 'A');
    const pages = await q("select page, clicks, sync_batch_id from search_console_page_daily where site_url=$1 and day_date='2026-07-01' order by page", [site]);
    assert.deepEqual(pages.map((r) => [r.page.replace(site, ''), Number(r.clicks), r.sync_batch_id]), [['a', 10, 'B'], ['b', 20, 'B']],
      "B's snapshot stands: the shared page keeps B's numbers, A's extra page is refused");
    const siteAfter = await first("select clicks, sync_batch_id from search_console_site_daily where site_url=$1 and day_date='2026-07-01'", [site]);
    assert.deepEqual([Number(siteAfter.clicks), siteAfter.sync_batch_id], [30, 'B'], "the site totals are B's");
    // A's retirement: only rows older than A. B's are newer.
    const swept = await q("delete from search_console_page_daily where site_url=$1 and day_date='2026-07-01' and synced_at < $2 returning id", [site, T1]);
    assert.equal(swept.length, 0, "A's sweep removes none of B's rows");
    // A genuinely newer run C replaces everything as before.
    await page(T3, 'a', 11, 'C'); await page(T3, 'd', 1, 'C'); await siteRow(T3, 12, 'C');
    const after = await q("select page, clicks, sync_batch_id from search_console_page_daily where site_url=$1 and day_date='2026-07-01' order by page", [site]);
    assert.deepEqual(after.map((r) => [r.page.replace(site, ''), Number(r.clicks), r.sync_batch_id]), [['a', 11, 'C'], ['b', 20, 'B'], ['d', 1, 'C']],
      'a newer run updates shared identities and adds its own rows');
    // Equal timestamps (a retry inside one run) still write.
    await page(T3, 'a', 12, 'C');
    assert.equal(Number((await first("select clicks from search_console_page_daily where site_url=$1 and page=$2", [site, `${site}a`])).clicks), 12, 'a same-run retry is not refused');
  });

  await test('the baseline boundary is the PACIFIC publication date in both insertion orders', async () => {
    // 00:30Z on Sep 2 is 17:30 Pacific on Sep 1. A baseline ending Sep 1
    // straddles the change and must be refused whichever side is recorded
    // first; one ending Aug 31 is fine. Under the session-timezone cast the
    // suite runs on (UTC) the Sep 1 baseline would be accepted.
    const AT = '2026-09-02T00:30:00Z';
    const t1 = await task(proj);
    await capture(t1, 'baseline', '2026-08-26', '2026-09-01');
    await approve(t1);
    await refused(() => publish(t1, AT), /already has a baseline whose window ends 2026-09-01/, 'publication after a same-Pacific-day baseline');
    await asApprover(() => q("delete from seo_measurements where task_id=$1", [t1]));
    await capture(t1, 'baseline', '2026-08-25', '2026-08-31');
    assert.ok(await publish(t1, AT), 'a baseline ending the previous Pacific day is fine');
    const t2 = await task(proj);
    await approve(t2);
    await publish(t2, AT);
    await refused(() => capture(t2, 'baseline', '2026-08-26', '2026-09-01'), /follow-up, not a baseline/, 'baseline ending on the Pacific publication day');
    const ok = await capture(t2, 'baseline', '2026-08-25', '2026-08-31');
    assert.ok(ok.rows_written > 0, 'a baseline ending the previous Pacific day is captured');
  });

  await test("an EASTERN company's baseline boundary is its own Eastern publication date", async () => {
    // 04:30Z on Sep 2 is 00:30 Eastern on Sep 2 but 21:30 Pacific on Sep 1. So
    // for an Eastern company a baseline ending Sep 1 closed before the change
    // and is fine -- the Pacific reading would refuse it -- and one ending Sep 2
    // straddles it. Same company, same rows; only its stored timezone differs.
    await q("insert into company_settings(company_entity_id, business_timezone) values ($1, 'America/New_York')", [co]);
    try {
      const AT = '2026-09-02T04:30:00Z';
      const t1 = await task(proj);
      await capture(t1, 'baseline', '2026-08-26', '2026-09-01');
      await approve(t1);
      assert.ok(await publish(t1, AT), 'a baseline ending the previous EASTERN day is fine');
      const t2 = await task(proj);
      await approve(t2);
      await publish(t2, AT);
      await refused(() => capture(t2, 'baseline', '2026-08-27', '2026-09-02'), /follow-up, not a baseline/,
        'baseline ending on the Eastern publication day');
      const ok = await capture(t2, 'baseline', '2026-08-26', '2026-09-01');
      assert.ok(ok.rows_written > 0, 'the Eastern previous day is captured even though it is the Pacific publication day');
      const w = await asMember(() => first('select * from seo_follow_up_window($1, 7)', [t2]));
      assert.equal(iso(new Date(w.published_on)), '2026-09-02', 'the follow-up window counts from the Eastern publication date');
    } finally {
      await q('delete from company_settings where company_entity_id=$1', [co]);
    }
  });

  await test('the committed SEO workflow verification checks return ok on the migrated database', async () => {
    const verifySql = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
    const checks = splitSqlStatements(verifySql).filter((s) =>
      /as (seo_project_workflow|seo_workflow_integrity|seo_measurement_capture|search_console_newest_run_wins)\b/.test(s.text));
    assert.equal(checks.length, 4, 'the four SEO workflow checks must be committed');
    for (const sql of checks) {
      const rows = await q(sql.text);
      assert.ok(rows.length > 0, 'a verification check must return evidence');
      for (const row of rows) assert.equal(Object.values(row)[0], 'ok', JSON.stringify(row));
    }
  });

  console.log(`${passed} SEO workflow database tests passed (local PostgreSQL only).`);
} finally {
  await db.close();
}
