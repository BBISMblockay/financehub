// SEO competitor / SERP schema regressions against a REAL PostgreSQL (PGlite):
// the committed migration, role switching and RLS -- not a mock, and not the
// service role.
//
// What this proves, as authenticated users:
//   - a keyword set that deduplicates on the normalised keyword, per company
//   - a competitor-domain registry only approvers may edit
//   - SERP observations that no client can write, update or delete; the
//     provider (service role) and seo_import_manual_serp_observations() are the
//     only writers, and every observation carries date, location, device and
//     source as NOT NULL columns
//   - the newest completed run wins over an older run that resumes late
//   - seo_keyword_landscape_v lists every active keyword, with NULL (never 0)
//     where nothing observed it, our OWN observed position beside the Search
//     Console average as two different measures, and movement between the two
//     latest runs
//   - seo_competitor_share_v counts top-10 appearances against the number of
//     keywords the run observed, never against the keyword set
//   - seo_derive_keyword_candidates() returns the four-source list from
//     docs/ops/seo-competitors.md scoped to the caller's company
//
// Run:  npm ci --prefix scripts/tests/finance-db --ignore-scripts && node scripts/tests/seo-serp-database.test.mjs
// Mutations (each must fail at least one assertion):
//   SERP_DB_MUTATION=stale-write-allowed    (the newest-run-wins triggers removed)
//   SERP_DB_MUTATION=observations-writable  (a client insert policy on observations)
//   SERP_DB_MUTATION=import-unscoped        (the manual import resolves keywords across companies)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
import { splitSqlStatements } from '../lib/sql-statements.mjs';

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const MIGRATION = '20260926120000_seo_competitor_serp_schema.sql';
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
  '20260914120000_seo_measurement_capture.sql',
  '20260914130000_search_console_newest_run_wins.sql',
  '20260924130000_business_timezone_core.sql',
  '20260924130100_business_timezone_seo.sql',
];
const mutation = process.env.SERP_DB_MUTATION || '';
assert.ok(['', 'stale-write-allowed', 'observations-writable', 'import-unscoped'].includes(mutation), 'Unknown SERP database mutation');

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
const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// Service-role writer, the shape the provider sync (PR B) will use: run row
// first (so observations have an id to cite), observations, then the run row
// marked completed LAST -- that completion timestamp is what "this identity
// is done" means to the newest-run-wins trigger.
async function providerRun({ observedOn, device = 'desktop', syncedAt, batch, rows, asked, provider = 'dataforseo', complete = true }) {
  return asRole('service_role', '', async () => {
    const upserted = await first(`
      insert into seo_serp_runs (company_entity_id, provider, observed_on, location_code, location_name, language_code, device, search_engine, depth, synced_at, sync_batch_id)
      values ($1, $2, $3, 2840, 'United States', 'en', $4, 'google', 10, $5, $6)
      on conflict (company_entity_id, provider, observed_on, location_name, language_code, device, search_engine)
      do update set synced_at = excluded.synced_at, sync_batch_id = excluded.sync_batch_id, completed_at = null
      returning id`, [co, provider, observedOn, device, syncedAt, batch]);
    // If the upsert was refused (older payload) the returning row is absent;
    // fetch the stored id so the caller can still try its observation writes.
    const id = upserted?.id ?? await scalar(
      'select id from seo_serp_runs where company_entity_id=$1 and provider=$2 and observed_on=$3 and device=$4 and location_name=$5 and language_code=$6 and search_engine=$7',
      [co, provider, observedOn, device, 'United States', 'en', 'google']);
    const keywordIds = asked || [...new Set(rows.map((r) => r.keywordId))];
    for (const keywordId of keywordIds) {
      await q(`
        insert into seo_serp_run_keywords (company_entity_id, run_id, keyword_id, result_count, provider_request_id, synced_at, sync_batch_id)
        values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (run_id, keyword_id)
        do update set result_count = excluded.result_count, provider_request_id = excluded.provider_request_id, synced_at = excluded.synced_at, sync_batch_id = excluded.sync_batch_id`,
      [co, id, keywordId, rows.filter((r) => r.keywordId === keywordId).length, `${batch}-${keywordId.slice(0, 8)}`, syncedAt, batch]);
    }
    for (const r of rows) {
      await q(`
        insert into seo_serp_observations (company_entity_id, run_id, keyword_id, provider, observed_on, location_name, language_code, device, search_engine,
                                           result_type, position, domain, url, title, synced_at, sync_batch_id)
        values ($1, $2, $3, $4, $5, 'United States', 'en', $6, 'google', $7, $8, $9, $10, $11, $12, $13)
        on conflict (run_id, keyword_id, result_type, position)
        do update set domain = excluded.domain, url = excluded.url, title = excluded.title, synced_at = excluded.synced_at, sync_batch_id = excluded.sync_batch_id`,
      [co, id, r.keywordId, provider, observedOn, device, r.resultType || 'organic', r.position, r.domain, r.url || `https://${r.domain}/`, r.title || null, syncedAt, batch]);
    }
    if (complete) {
      await q('update seo_serp_runs set completed_at = $2, synced_at = $3, result_count = (select count(*) from seo_serp_observations where run_id = $1) where id = $1', [id, syncedAt, syncedAt]);
    }
    return id;
  });
}

const START = '2026-08-01';

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
    ($1,$2,'www.baseballism.com','primary'),($1,$2,'baseballism.myshopify.com','myshopify')`, [co, SHOP]);
  // 41 days of site rows and query rows: "baseball dad hat" is a click leader
  // at position ~4, "baseball hoodie" is an impressions-heavy opportunity at
  // position ~14, "mlb tee" is small. Another company's query never surfaces.
  for (let i = 0; i < 41; i++) {
    const day = addDays(START, i);
    await q(`insert into search_console_site_daily(company_entity_id,site_url,day_date,clicks,impressions,ctr,position,
      page_rows,page_attributed_clicks,page_attributed_impressions,query_rows,query_attributed_clicks,query_attributed_impressions)
      values ($1,$2,$3,100,1000,0.1,8.5,50,100,1200,40,60,700)`, [co, SITE, day]);
    await q(`insert into search_console_query_daily(company_entity_id,site_url,day_date,query,clicks,impressions,ctr,position) values
      ($1,$2,$3,'baseball dad hat',40,400,0.1,4.0),
      ($1,$2,$3,'baseball hoodie',2,900,0.002,14.0),
      ($1,$2,$3,'mlb tee',5,50,0.1,7.0)`, [co, SITE, day]);
  }
  await q(`insert into search_console_site_daily(company_entity_id,site_url,day_date,clicks,impressions) values ($1,'https://other.example/','2026-08-05',999,9999)`, [otherCo]);
  await q(`insert into search_console_query_daily(company_entity_id,site_url,day_date,query,clicks,impressions) values ($1,'https://other.example/','2026-08-05','other company query',999,9999)`, [otherCo]);
  await q(`insert into products_master(company_entity_id,sku,product_title,product_type,shopify_status,online_published_at) values
    ($1,'A1','Dad Hat Navy','Dad Hat','active',now()),
    ($1,'A2','Raglan Tee','Raglan','active',now()),
    ($1,'A3','Old Hoodie','Hoodie','archived',null),
    ($2,'B1','Other Cap','Other Type','active',now())`, [co, otherCo]);
  await q(`insert into launch_calendar(company_entity_id,title,launch_date,status) values
    ($1,'Opening Day Collection',$2,'planned'),
    ($1,'Ancient Launch','2020-01-01','done'),
    ($3,'Other Launch',$2,'planned')`, [co, addDays(iso(new Date()), 30), otherCo]);

  await test('the SERP migration applies twice on top of the committed SEO migrations', async () => {
    const sql = await readFile(new URL(`supabase/migrations/${MIGRATION}`, root), 'utf8');
    await db.exec(sql);
    await db.exec(sql);
    assert.equal(await scalar("select count(*)::int from information_schema.tables where table_schema='public' and table_name in ('seo_keyword_set','seo_competitor_domains','seo_serp_runs','seo_serp_run_keywords','seo_serp_observations')"), 5);
    assert.equal(await scalar("select count(*)::int from pg_trigger where tgname='trg_seo_serp_newest_run_wins' and not tgisinternal"), 3, 'runs, run keywords and observations all carry the trigger');
    assert.match(await scalar("select pg_get_constraintdef(oid) from pg_constraint where conname='sync_jobs_job_type_check'"), /seo_serp_weekly/, 'the job type is appended to the live list');
    assert.match(await scalar("select pg_get_constraintdef(oid) from pg_constraint where conname='sync_jobs_job_type_check'"), /shopify_sales/, '...without retyping it');
    assert.ok(!sql.includes('America/Los_Angeles'), 'Pacific is written in one place (silo_company_timezone), never here');
    if (mutation === 'stale-write-allowed') {
      for (const t of ['seo_serp_runs', 'seo_serp_run_keywords', 'seo_serp_observations']) await db.exec(`drop trigger trg_seo_serp_newest_run_wins on public.${t}`);
    }
    if (mutation === 'observations-writable') {
      await db.exec(`create policy seo_serp_observations_insert on public.seo_serp_observations for insert to authenticated
        with check (company_entity_id = public.active_company_id())`);
    }
    if (mutation === 'import-unscoped') {
      const def = await scalar("select pg_get_functiondef('public.seo_import_manual_serp_observations(jsonb,date,text,text,text)'::regprocedure)");
      const anchor = 'and k.company_entity_id = v_company';
      assert.ok(def.includes(anchor), 'mutation must find the company scope on the keyword lookup');
      await db.exec(def.replaceAll(anchor, 'and true'));
    }
  });

  await test('writers and readers carry the right privileges under Supabase default grants', async () => {
    for (const fn of ['public.seo_import_manual_serp_observations(jsonb,date,text,text,text)', 'public.seo_derive_keyword_candidates(integer)']) {
      assert.equal(await scalar(`select has_function_privilege('anon', '${fn}', 'execute')`), false, `${fn} anon`);
      assert.equal(await scalar(`select has_function_privilege('authenticated', '${fn}', 'execute')`), true, `${fn} authenticated`);
    }
    assert.equal(await scalar("select prosecdef from pg_proc where proname='seo_import_manual_serp_observations'"), true, 'the import is the only client-side writer of observations, so it is DEFINER');
    assert.equal(await scalar("select prosecdef from pg_proc where proname='seo_derive_keyword_candidates'"), false, 'the candidate reader stays INVOKER');
    for (const t of ['seo_keyword_set', 'seo_competitor_domains', 'seo_serp_runs', 'seo_serp_run_keywords', 'seo_serp_observations']) {
      assert.equal(await scalar(`select has_table_privilege('anon', 'public.${t}', 'select')`), false, `${t} anon`);
      assert.equal(await scalar(`select relrowsecurity from pg_class where relname='${t}'`), true, `${t} RLS`);
    }
    for (const t of ['seo_serp_runs', 'seo_serp_run_keywords', 'seo_serp_observations']) {
      const writes = await q("select policyname, cmd from pg_policies where schemaname='public' and tablename=$1 and cmd <> 'SELECT'", [t]);
      if (mutation === 'observations-writable' && t === 'seo_serp_observations') assert.ok(writes.length > 0);
      else assert.deepEqual(writes, [], `${t} has no client write policy`);
    }
    for (const v of ['seo_serp_observations_v', 'seo_keyword_landscape_v', 'seo_competitor_share_v']) {
      assert.equal(await scalar("select 'security_invoker=true' = any(reloptions) from pg_class where relname=$1", [v]), true, `${v} is security_invoker`);
    }
  });

  let kDadHat, kHoodie, kApproverOwned;
  await test('the keyword set deduplicates on the normalised keyword within a company, and the creator or an approver edits it', async () => {
    kDadHat = await asMember(() => scalar("insert into seo_keyword_set (company_entity_id, keyword, source, commercial_note) values ($1, 'Baseball  Dad Hat ', 'search_console_clicks', 'in stock') returning id", [co]));
    assert.equal(await scalar('select keyword_norm from seo_keyword_set where id=$1', [kDadHat]), 'baseball dad hat', 'lowercased, trimmed, whitespace collapsed');
    await refused(() => asMember(() => q("insert into seo_keyword_set (company_entity_id, keyword, source) values ($1, 'baseball dad hat', 'manual')", [co])),
      /seo_keyword_set_company_keyword|duplicate key/, 'the same keyword twice');
    kHoodie = await asMember(() => scalar("insert into seo_keyword_set (company_entity_id, keyword, source) values ($1, 'baseball hoodie', 'search_console_opportunity') returning id", [co]));
    // The other company may hold the same keyword: the set is per company.
    const foreign = await asOutsider(() => scalar("insert into seo_keyword_set (company_entity_id, keyword, source) values ($1, 'baseball dad hat', 'manual') returning id", [otherCo]));
    assert.ok(foreign);
    assert.equal((await asOutsider(() => q('select id from seo_keyword_set where id=$1', [kDadHat]))).length, 0, 'another company sees nothing');
    await refused(() => asOutsider(() => q("insert into seo_keyword_set (company_entity_id, keyword, source) values ($1, 'x', 'manual')", [co])),
      /row-level security/i, 'outsider inserting into this company');
    kApproverOwned = await asApprover(() => scalar("insert into seo_keyword_set (company_entity_id, keyword, source) values ($1, 'mlb tee', 'manual') returning id", [co]));
    assert.equal((await asMember(() => q("update seo_keyword_set set priority = 9 where id=$1 returning id", [kApproverOwned]))).length, 0, "a member cannot edit a keyword they did not add (RLS: zero rows, not an error)");
    assert.equal((await asMember(() => q("update seo_keyword_set set priority = 1 where id=$1 returning id", [kDadHat]))).length, 1, 'the creator edits their own');
    assert.equal((await asApprover(() => q("update seo_keyword_set set priority = 2 where id=$1 returning id", [kDadHat]))).length, 1, 'an approver edits anyone\'s');
    assert.equal(await scalar('select created_by from seo_keyword_set where id=$1', [kDadHat]), member, 'attributed');
  });

  await test('competitor domains: approvers only, normalised, and readable by every member', async () => {
    await refused(() => asMember(() => q("insert into seo_competitor_domains (company_entity_id, domain, relationship) values ($1, 'www.rivalbrand.com', 'commercial')", [co])),
      /row-level security/i, 'member adding a competitor');
    const id = await asApprover(() => scalar("insert into seo_competitor_domains (company_entity_id, domain, relationship, note) values ($1, 'WWW.RivalBrand.com', 'commercial', 'sells to the same customer') returning id", [co]));
    assert.equal(await scalar('select domain_norm from seo_competitor_domains where id=$1', [id]), 'rivalbrand.com', 'lowercased, www. stripped');
    await refused(() => asApprover(() => q("insert into seo_competitor_domains (company_entity_id, domain, relationship) values ($1, 'rivalbrand.com', 'search')", [co])),
      /seo_competitor_domains_company_domain|duplicate key/, 'the same domain twice');
    await refused(() => asApprover(() => q("insert into seo_competitor_domains (company_entity_id, domain, relationship) values ($1, 'x.com', 'friend')", [co])),
      /check constraint|violates/i, 'an unknown relationship');
    assert.equal((await asMember(() => q('select domain from seo_competitor_domains where id=$1', [id]))).length, 1, 'a member reads the registry');
    assert.equal((await asOutsider(() => q('select domain from seo_competitor_domains where id=$1', [id]))).length, 0, 'another company does not');
    assert.equal(await scalar('select added_by from seo_competitor_domains where id=$1', [id]), approver);
  });

  await test('no client writes an observation or a run, even an approver; every observation names its date, location, device and source', async () => {
    const attempt = (actor) => asRole('authenticated', actor, () => q(`
      insert into seo_serp_runs (company_entity_id, provider, observed_on, location_name, device) values ($1, 'dataforseo', '2026-09-01', 'United States', 'desktop')`, [co]));
    await refused(() => attempt(member), /row-level security|permission denied/i, 'member inserting a run');
    await refused(() => attempt(approver), /row-level security|permission denied/i, 'approver inserting a run');
    const runId = await providerRun({ observedOn: '2026-09-01', syncedAt: '2026-09-01T06:00:00Z', batch: 'seed', rows: [
      { keywordId: kDadHat, position: 1, domain: 'rivalbrand.com' },
    ] });
    const direct = () => asApprover(() => q(`
      insert into seo_serp_observations (company_entity_id, run_id, keyword_id, provider, observed_on, location_name, language_code, device, search_engine, result_type, position, domain, url)
      values ($1, $2, $3, 'dataforseo', '2026-09-01', 'United States', 'en', 'desktop', 'google', 'organic', 2, 'typed.example', 'https://typed.example/')`, [co, runId, kDadHat]));
    if (mutation === 'observations-writable') { await direct(); assert.fail('a client typed an observation'); }
    await refused(direct, /row-level security|permission denied/i, 'approver typing an observation');
    for (const [col, val] of [['device', null], ['location_name', null], ['observed_on', null], ['provider', null]]) {
      await refused(() => asRole('service_role', '', () => q(`
        insert into seo_serp_observations (company_entity_id, run_id, keyword_id, provider, observed_on, location_name, language_code, device, search_engine, result_type, position, domain, url)
        values ($1, $2, $3, ${col === 'provider' ? '$4' : "'dataforseo'"}, ${col === 'observed_on' ? '$4' : "'2026-09-01'"}, ${col === 'location_name' ? '$4' : "'United States'"}, 'en', ${col === 'device' ? '$4' : "'desktop'"}, 'google', 'organic', 3, 'x.example', 'https://x.example/')`,
      [co, runId, kDadHat, val])), /not-null|null value/i, `${col} may not be null`);
    }
    await refused(() => asRole('service_role', '', () => q(`
      insert into seo_serp_observations (company_entity_id, run_id, keyword_id, provider, observed_on, location_name, language_code, device, search_engine, result_type, position, domain, url)
      values ($1, $2, $3, 'dataforseo', '2026-09-01', 'United States', 'en', 'tablet', 'google', 'organic', 3, 'x.example', 'https://x.example/')`, [co, runId, kDadHat])),
    /check constraint|violates/i, 'an unknown device');
    assert.equal((await asMember(() => q('select id from seo_serp_observations where run_id=$1', [runId]))).length, 1, 'a member reads the provider rows');
    assert.equal((await asOutsider(() => q('select id from seo_serp_observations where run_id=$1', [runId]))).length, 0, 'another company does not');
    assert.equal((await asMember(() => q("delete from seo_serp_observations where run_id=$1 returning id", [runId]))).length, 0, 'append-only: no delete');
    assert.equal((await asApprover(() => q("update seo_serp_observations set position = 9 where run_id=$1 returning id", [runId]))).length, 0, 'append-only: no update');
  });

  await test('the manual import: any member records a dated, attributed observation for a keyword in THEIR set, refusing anything under-specified', async () => {
    const rows = JSON.stringify([
      { keyword: 'baseball dad hat', position: 1, domain: 'rivalbrand.com', url: 'https://rivalbrand.com/hats' },
      { keyword: 'Baseball Dad Hat', position: 4, domain: 'www.baseballism.com', url: 'https://www.baseballism.com/collections/hats', title: 'Dad Hats' },
      { keyword_id: kHoodie, position: 2, domain: 'bigbox.example', url: 'https://bigbox.example/h', result_type: 'shopping' },
    ]);
    const result = await asMember(() => scalar('select public.seo_import_manual_serp_observations($1::jsonb, $2, $3, $4, $5)', [rows, '2026-09-08', 'United States', 'desktop', 'private window, US locale']));
    assert.equal(result.rows_written, 3);
    assert.ok(result.run_id);
    const run = await first('select provider, observed_on, device, location_name, recorded_by, completed_at, note from seo_serp_runs where id=$1', [result.run_id]);
    assert.equal(run.provider, 'manual');
    assert.equal(iso(run.observed_on), '2026-09-08');
    assert.equal(run.device, 'desktop');
    assert.equal(run.recorded_by, member, 'attributed to the person');
    assert.ok(run.completed_at, 'a manual run is complete when the import returns');
    assert.equal(run.note, 'private window, US locale');
    const obs = await q('select keyword_id, position, domain, result_type, provider, device from seo_serp_observations where run_id=$1 order by position', [result.run_id]);
    assert.deepEqual(obs.map((o) => [o.keyword_id === kDadHat ? 'dadhat' : 'hoodie', Number(o.position), o.domain, o.result_type, o.provider, o.device]),
      [['dadhat', 1, 'rivalbrand.com', 'organic', 'manual', 'desktop'], ['hoodie', 2, 'bigbox.example', 'shopping', 'manual', 'desktop'], ['dadhat', 4, 'www.baseballism.com', 'organic', 'manual', 'desktop']]);
    // Same identity again appends for other keywords; the same slot twice is a duplicate.
    const again = await asMember(() => scalar('select public.seo_import_manual_serp_observations($1::jsonb, $2, $3, $4, $5)',
      [JSON.stringify([{ keyword_id: kApproverOwned, position: 1, domain: 'rivalbrand.com', url: 'https://rivalbrand.com/t' }]), '2026-09-08', 'United States', 'desktop', null]));
    assert.equal(again.run_id, result.run_id, 'the same date/location/device is the same manual run');
    await refused(() => asMember(() => q('select public.seo_import_manual_serp_observations($1::jsonb, $2, $3, $4, $5)',
      [JSON.stringify([{ keyword_id: kDadHat, position: 1, domain: 'someone.else', url: 'https://someone.else/' }]), '2026-09-08', 'United States', 'desktop', null])),
    /already recorded|duplicate/i, 'the same keyword and position twice on one date');
    const bad = async (payload, pattern, label, date = '2026-09-08', device = 'desktop') => refused(
      () => asMember(() => q('select public.seo_import_manual_serp_observations($1::jsonb, $2, $3, $4, $5)', [JSON.stringify(payload), date, 'United States', device, null])), pattern, label);
    await bad([], /no rows/i, 'empty payload');
    await bad([{ keyword: 'not in the set', position: 1, domain: 'a.b', url: 'https://a.b/' }], /not in this company's keyword set/i, 'unknown keyword');
    await bad([{ keyword_id: kDadHat, position: 0, domain: 'a.b', url: 'https://a.b/' }], /position/i, 'position 0');
    await bad([{ keyword_id: kDadHat, position: 7, url: 'https://a.b/' }], /domain/i, 'missing domain');
    await bad([{ keyword_id: kDadHat, position: 7, domain: 'a.b', url: 'https://a.b/', result_type: 'ad' }], /result_type/i, 'unknown result type');
    await bad([{ keyword_id: kDadHat, position: 7, domain: 'a.b', url: 'https://a.b/' }], /device/i, 'unknown device', '2026-09-08', 'tablet');
    await bad([{ keyword_id: kDadHat, position: 7, domain: 'a.b', url: 'https://a.b/' }], /future/i, 'a future date', '2999-01-01');
    // The outsider's set does not contain this company's keyword id, whatever the id says.
    const foreignImport = () => asOutsider(() => q('select public.seo_import_manual_serp_observations($1::jsonb, $2, $3, $4, $5)',
      [JSON.stringify([{ keyword_id: kDadHat, position: 3, domain: 'a.b', url: 'https://a.b/' }]), '2026-09-08', 'United States', 'desktop', null]));
    if (mutation === 'import-unscoped') { await foreignImport(); assert.fail('an outsider recorded an observation against another company\'s keyword'); }
    await refused(foreignImport, /not in this company's keyword set/i, 'outsider citing a foreign keyword id');
    assert.equal(await scalar('select count(*)::int from seo_serp_observations where keyword_id=$1 and domain=$2', [kDadHat, 'a.b']), 0, 'nothing landed from the refusals');
    await refused(() => asRole('anon', '', () => q('select public.seo_import_manual_serp_observations($1::jsonb, $2, $3, $4, $5)', [rows, '2026-09-08', 'United States', 'desktop', null])),
      /permission denied|no active company/i, 'anon');
  });

  await test('the newest completed run wins over an older run that resumes late', async () => {
    // Run B (T2) completes 2026-09-15 desktop; run A (T1 < T2) then resumes
    // with an older payload for the same identity: its run upsert is refused,
    // its observation upsert on a shared slot is refused, its observation for a
    // keyword B did not return is refused. A newer run C (T3) updates everything.
    const T1 = '2026-09-15T10:00:00Z', T2 = '2026-09-15T10:05:00Z', T3 = '2026-09-15T10:10:00Z';
    const runB = await providerRun({ observedOn: '2026-09-15', syncedAt: T2, batch: 'B', rows: [
      { keywordId: kDadHat, position: 1, domain: 'rivalbrand.com' },
      { keywordId: kDadHat, position: 2, domain: 'www.baseballism.com' },
    ] });
    const runA = await providerRun({ observedOn: '2026-09-15', syncedAt: T1, batch: 'A', rows: [
      { keywordId: kDadHat, position: 1, domain: 'older.example' },
      { keywordId: kHoodie, position: 1, domain: 'stale.example' },
    ] });
    assert.equal(runA, runB, 'one identity, one run row');
    const stored = await first('select sync_batch_id, completed_at, synced_at from seo_serp_runs where id=$1', [runB]);
    assert.equal(stored.sync_batch_id, 'B', "A's run upsert lost to B's newer row");
    assert.ok(stored.completed_at, 'B is still the completed run');
    const asked = await q('select keyword_id, sync_batch_id from seo_serp_run_keywords where run_id=$1 order by keyword_id = $2 desc', [runB, kDadHat]);
    assert.deepEqual(asked.map((a) => [a.keyword_id === kDadHat ? 'dadhat' : 'hoodie', a.sync_batch_id]), [['dadhat', 'B']], "A's request record for a keyword B never asked about is refused too");
    const obs = await q('select keyword_id, position, domain, sync_batch_id from seo_serp_observations where run_id=$1 order by keyword_id = $2 desc, position', [runB, kDadHat]);
    assert.deepEqual(obs.map((o) => [o.keyword_id === kDadHat ? 'dadhat' : 'hoodie', Number(o.position), o.domain, o.sync_batch_id]),
      [['dadhat', 1, 'rivalbrand.com', 'B'], ['dadhat', 2, 'www.baseballism.com', 'B']],
      "B's snapshot stands: the shared slot keeps B's domain, A's extra keyword is refused");
    const runC = await providerRun({ observedOn: '2026-09-15', syncedAt: T3, batch: 'C', rows: [
      { keywordId: kDadHat, position: 1, domain: 'rivalbrand.com' },
      { keywordId: kDadHat, position: 2, domain: 'newcomer.example' },
      { keywordId: kHoodie, position: 1, domain: 'bigbox.example' },
    ] });
    assert.equal(runC, runB);
    const after = await q('select keyword_id, position, domain, sync_batch_id from seo_serp_observations where run_id=$1 order by keyword_id = $2 desc, position', [runB, kDadHat]);
    assert.deepEqual(after.map((o) => [o.keyword_id === kDadHat ? 'dadhat' : 'hoodie', Number(o.position), o.domain, o.sync_batch_id]),
      [['dadhat', 1, 'rivalbrand.com', 'C'], ['dadhat', 2, 'newcomer.example', 'C'], ['hoodie', 1, 'bigbox.example', 'C']],
      'a newer run updates shared slots and adds its own rows');
    // Equal timestamps (a retry inside one run) still write.
    await providerRun({ observedOn: '2026-09-15', syncedAt: T3, batch: 'C', rows: [{ keywordId: kDadHat, position: 2, domain: 'retried.example' }] });
    assert.equal(await scalar('select domain from seo_serp_observations where run_id=$1 and keyword_id=$2 and position=2', [runB, kDadHat]), 'retried.example', 'a same-run retry is not refused');
  });

  await test('the landscape lists every active keyword: our observed position, our Search Console average, and movement -- NULL where nothing observed', async () => {
    // Two dataforseo desktop runs: 09-01 (seeded above: rivalbrand #1 only) and
    // 09-15 (rivalbrand #1, newcomer #2, hoodie: bigbox #1). Add our own domain
    // to 09-01 at #5 so movement exists, then a 09-22 run where we are #3.
    await providerRun({ observedOn: '2026-09-01', syncedAt: '2026-09-01T06:05:00Z', batch: 'seed2', rows: [
      { keywordId: kDadHat, position: 1, domain: 'rivalbrand.com' },
      { keywordId: kDadHat, position: 5, domain: 'www.baseballism.com', url: 'https://www.baseballism.com/collections/hats' },
    ] });
    // The 09-22 run also ASKED about the hoodie keyword and got no top-10 row
    // back: that is an observation of absence, which is different from never
    // having asked, and the run-keyword record is what carries the difference.
    await providerRun({ observedOn: '2026-09-22', syncedAt: '2026-09-22T06:00:00Z', batch: 'D', asked: [kDadHat, kHoodie], rows: [
      { keywordId: kDadHat, position: 1, domain: 'rivalbrand.com' },
      { keywordId: kDadHat, position: 3, domain: 'baseballism.com', url: 'https://baseballism.com/collections/hats' },
      { keywordId: kDadHat, position: 4, domain: 'newcomer.example' },
    ] });
    const rows = await asMember(() => q("select * from seo_keyword_landscape_v where provider='dataforseo' and device='desktop' order by keyword"));
    const byKw = Object.fromEntries(rows.map((r) => [r.keyword_norm, r]));
    const dad = byKw['baseball dad hat'];
    assert.ok(dad, 'the keyword is listed');
    assert.equal(iso(dad.latest_observed_on), '2026-09-22');
    assert.equal(Number(dad.our_serp_position), 3, 'our own host in the latest run, matched with or without www.');
    assert.equal(iso(dad.previous_observed_on), '2026-09-15');
    assert.equal(dad.our_previous_serp_position, null, 'we were not in the 09-15 top 10 after run C rewrote it: NULL, not 11 and not 0');
    assert.equal(dad.our_serp_movement, null, 'no movement figure without two observed positions');
    assert.equal(Number(dad.results_in_latest_run), 3);
    assert.deepEqual(dad.latest_top_results.map((r) => [r.position, r.domain]), [[1, 'rivalbrand.com'], [3, 'baseballism.com'], [4, 'newcomer.example']]);
    assert.equal(dad.latest_top_results[0].relationship, 'commercial', 'the registry relationship rides along');
    assert.equal(dad.latest_top_results[1].is_own_domain, true);
    assert.equal(Number(dad.search_console_avg_position_28d), 4, 'impression-weighted GSC average over the last 28 ingested days, a DIFFERENT measure');
    assert.equal(Number(dad.search_console_clicks_28d), 40 * 28);
    assert.equal(Number(dad.observation_runs), 3);
    const hoodie = byKw['baseball hoodie'];
    assert.equal(iso(hoodie.latest_observed_on), '2026-09-22', 'asked about on 09-22, even though nothing came back');
    assert.equal(hoodie.our_serp_position, null, 'observed, and we were not in the top 10: NULL');
    assert.equal(Number(hoodie.results_in_latest_run), 0, 'asked and nothing returned is a measured 0, unlike the never-asked keyword below');
    assert.equal(iso(hoodie.previous_observed_on), '2026-09-15');
    assert.deepEqual(hoodie.latest_top_results, [], 'an empty result list, not NULL');
    assert.equal(Number(hoodie.observation_runs), 2);
    const tee = byKw['mlb tee'];
    assert.ok(tee, 'a keyword with NO provider observation is still listed');
    assert.equal(tee.latest_observed_on, null);
    assert.equal(Number(tee.observation_runs), 0, 'never observed, never zero results');
    assert.equal(tee.results_in_latest_run, null, 'never asked: NULL, where the hoodie above is 0');
    assert.equal(tee.latest_top_results, null);
    assert.equal(Number(tee.search_console_avg_position_28d), 7, 'Search Console still speaks for it');
    // The manual pilot is its own provider row, never pooled with dataforseo.
    const manual = await asMember(() => q("select keyword_norm, our_serp_position, latest_observed_on from seo_keyword_landscape_v where provider='manual' and device='desktop' and keyword_norm='baseball dad hat'"));
    assert.equal(manual.length, 1);
    assert.equal(Number(manual[0].our_serp_position), 4);
    assert.equal(iso(manual[0].latest_observed_on), '2026-09-08');
    // Movement where both positions exist: 09-01 (#5) -> 09-15 (#2, before run C) is
    // gone; build it explicitly on mobile: 09-01 #6, 09-08 #2 => +4 (improved).
    await providerRun({ observedOn: '2026-09-01', device: 'mobile', syncedAt: '2026-09-01T07:00:00Z', batch: 'M1', rows: [{ keywordId: kDadHat, position: 6, domain: 'www.baseballism.com' }] });
    await providerRun({ observedOn: '2026-09-08', device: 'mobile', syncedAt: '2026-09-08T07:00:00Z', batch: 'M2', rows: [{ keywordId: kDadHat, position: 2, domain: 'www.baseballism.com' }] });
    const mob = await asMember(() => first("select * from seo_keyword_landscape_v where provider='dataforseo' and device='mobile' and keyword_norm='baseball dad hat'"));
    assert.equal(Number(mob.our_serp_position), 2);
    assert.equal(Number(mob.our_previous_serp_position), 6);
    assert.equal(Number(mob.our_serp_movement), 4, 'positive = moved UP the page (previous minus current)');
    assert.equal((await asOutsider(() => q('select * from seo_keyword_landscape_v'))).length, 1, 'the outsider sees only their own one keyword');
    assert.equal((await asOutsider(() => first('select observation_runs from seo_keyword_landscape_v'))).observation_runs, 0);
  });

  await test('competitor share counts appearances against the keywords the run observed, never against the set', async () => {
    const rows = await asMember(() => q("select * from seo_competitor_share_v where provider='dataforseo' and device='desktop' order by domain_norm"));
    const byDomain = Object.fromEntries(rows.map((r) => [r.domain_norm, r]));
    assert.equal(iso(rows[0].observed_on), '2026-09-22', 'the latest completed desktop run');
    assert.equal(Number(rows[0].keywords_observed), 2, 'the 09-22 run asked about two keywords (one returned nothing) -- the denominator is what was ASKED, not the set of three');
    assert.equal(Number(byDomain['rivalbrand.com'].keywords_in_top_10), 1);
    assert.equal(Number(byDomain['rivalbrand.com'].keywords_in_top_3), 1);
    assert.equal(Number(byDomain['rivalbrand.com'].best_position), 1);
    assert.equal(byDomain['rivalbrand.com'].relationship, 'commercial');
    assert.equal(byDomain['rivalbrand.com'].is_own_domain, false);
    assert.equal(byDomain['baseballism.com'].is_own_domain, true);
    assert.equal(Number(byDomain['newcomer.example'].keywords_in_top_3), 0);
    assert.equal(byDomain['newcomer.example'].relationship, null, 'not in the registry: derived from observation only');
    assert.ok(!('share_of_voice' in rows[0]), 'no percentage column: the reader divides by keywords_observed and says so');
    assert.equal((await asOutsider(() => q('select * from seo_competitor_share_v'))).length, 0);
  });

  await test('keyword candidates come from the four sources, scoped to the caller, and say which are already in the set', async () => {
    const rows = await asMember(() => q('select * from seo_derive_keyword_candidates(90)'));
    const bySource = {};
    for (const r of rows) (bySource[r.source] ||= []).push(r);
    const norms = (s) => (bySource[s] || []).map((r) => r.keyword_norm);
    assert.ok(norms('search_console_clicks').includes('baseball dad hat'), 'click leader');
    assert.ok(norms('search_console_opportunity').includes('baseball hoodie'), 'impressions with position worse than 10');
    assert.ok(!norms('search_console_opportunity').includes('baseball dad hat'), 'a click leader is not also an opportunity');
    assert.ok(!rows.some((r) => r.keyword_norm === 'other company query'), 'another company\'s queries never surface');
    assert.deepEqual(norms('product_type').sort(), ['dad hat', 'raglan'], 'live product types only (archived Hoodie excluded)');
    assert.deepEqual(norms('launch'), ['opening day collection'], 'upcoming launches only');
    const dad = bySource.search_console_clicks.find((r) => r.keyword_norm === 'baseball dad hat');
    assert.equal(dad.already_in_set, true);
    assert.equal(Number(dad.our_position), 4);
    assert.equal(Number(dad.clicks), 40 * 41);
    assert.match(dad.coverage_note, /unattributed/i, 'the window\'s unattributed share is stated beside the Search Console groups');
    const raglan = bySource.product_type.find((r) => r.keyword_norm === 'raglan');
    assert.equal(raglan.already_in_set, false);
    assert.equal(raglan.our_position, null, 'not a Search Console query: no position, never 0');
    assert.ok(rows.every((r) => r.company_entity_id === co));
    assert.ok((bySource.search_console_clicks || []).length <= 60 && (bySource.search_console_opportunity || []).length <= 30, 'group caps');
    const theirs = await asOutsider(() => q('select * from seo_derive_keyword_candidates(90)'));
    assert.ok(theirs.every((r) => r.company_entity_id === otherCo));
    assert.ok(theirs.some((r) => r.keyword_norm === 'other type'));
    assert.ok(!theirs.some((r) => r.keyword_norm === 'dad hat'));
  });

  await test('the committed verification checks for this schema return ok on the migrated database', async () => {
    const verifySql = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
    const checks = splitSqlStatements(verifySql).filter((s) => /as seo_competitor_serp\b/.test(s.text));
    assert.equal(checks.length, 1, 'the seo_competitor_serp check must be committed');
    for (const sql of checks) {
      const rows = await q(sql.text);
      assert.ok(rows.length > 0, 'a verification check must return evidence');
      for (const row of rows) assert.equal(Object.values(row)[0], 'ok', JSON.stringify(row));
    }
    // And the catalog rows exist with columns and their load-bearing markers.
    for (const [rel, marker] of [['seo_serp_observations', 'NEVER OBSERVED'], ['seo_keyword_landscape_v', 'two different measures'], ['seo_competitor_share_v', 'keywords_observed'], ['seo_keyword_set', 'keyword_norm']]) {
      const row = await first('select description, columns from silo_chat_schema_catalog where relname=$1', [rel]);
      assert.ok(row, `${rel} catalogued`);
      assert.ok(row.description.includes(marker), `${rel} description carries "${marker}"`);
      assert.ok(row.columns.length > 0, `${rel} has columns`);
    }
  });

  console.log(`${passed} SEO SERP database tests passed (local PostgreSQL only).`);
} finally {
  await db.close();
}
