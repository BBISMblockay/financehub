// seo_recommendations_v against a REAL PostgreSQL (PGlite), as authenticated
// users -- not a mock, and not the service role. Seeds representative rows
// for each of the six opportunity classes plus edge cases (zero runs, one
// run, absent-with-no-demand, a keyword with a competitor capture vs one
// without) and asserts the view returns the right class, score and evidence
// strength for each, plus company isolation.
//
// Run:  node scripts/tests/seo-recommendations-database.test.mjs
// Mutations (each must fail at least one assertion):
//   RECS_DB_MUTATION=score-not-halved     (single-run discount removed)
//   RECS_DB_MUTATION=absence-as-zero      (an absent SC figure coalesced away)
//   RECS_DB_MUTATION=numeric-confidence   (evidence_strength carries a number)
//   RECS_DB_MUTATION=defend-not-filtered  (defend drops the decline requirement, per 20260927120000)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
import { splitSqlStatements } from '../lib/sql-statements.mjs';

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const MIGRATION = '20260926180000_seo_recommendations.sql';
const FOLLOWUP_MIGRATION = '20260927120000_seo_recommendations_defend_requires_decline.sql';
// The full chain this migration builds on, same list seo-serp-database.test.mjs
// verifies against, plus the SERP/tactics/rollup migrations it reads.
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
  '20260926120000_seo_competitor_serp_schema.sql',
  '20260926140000_seo_serp_provider_sync.sql',
  '20260926150000_seo_candidates_within_timeout.sql',
  '20260926160000_seo_collection_candidates_within_timeout.sql',
  '20260926170000_seo_serp_tactics.sql',
];
const mutation = process.env.RECS_DB_MUTATION || '';
assert.ok(['', 'score-not-halved', 'absence-as-zero', 'numeric-confidence', 'defend-not-filtered'].includes(mutation), 'Unknown recommendations mutation');

const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const first = async (sql, params = []) => (await q(sql, params))[0];
const scalar = async (sql, params = []) => Object.values(await first(sql, params))[0];
const co = randomUUID(), otherCo = randomUUID();
const member = randomUUID(), approver = randomUUID(), outsider = randomUUID();
const SITE = 'https://www.baseballism.com/';
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

// Service-role writer, same shape as seo-serp-database.test.mjs's providerRun:
// run row first, keyword requests, observations, run marked complete LAST.
async function providerRun({ observedOn, device = 'desktop', syncedAt, batch, rows, asked, complete = true }) {
  return asRole('service_role', '', async () => {
    const upserted = await first(`
      insert into seo_serp_runs (company_entity_id, provider, observed_on, location_code, location_name, language_code, device, search_engine, depth, synced_at, sync_batch_id)
      values ($1, 'dataforseo', $2, 2840, 'United States', 'en', $3, 'google', 20, $4, $5)
      on conflict (company_entity_id, provider, observed_on, location_name, language_code, device, search_engine)
      do update set synced_at = excluded.synced_at, sync_batch_id = excluded.sync_batch_id, completed_at = null
      returning id`, [co, observedOn, device, syncedAt, batch]);
    const id = upserted?.id ?? await scalar(
      'select id from seo_serp_runs where company_entity_id=$1 and provider=$2 and observed_on=$3 and device=$4 and location_name=$5 and language_code=$6 and search_engine=$7',
      [co, 'dataforseo', observedOn, device, 'United States', 'en', 'google']);
    const keywordIds = asked || [...new Set(rows.map((r) => r.keywordId))];
    for (const keywordId of keywordIds) {
      await q(`
        insert into seo_serp_run_keywords (company_entity_id, run_id, keyword_id, result_count, synced_at, sync_batch_id)
        values ($1, $2, $3, $4, $5, $6)
        on conflict (run_id, keyword_id)
        do update set result_count = excluded.result_count, synced_at = excluded.synced_at, sync_batch_id = excluded.sync_batch_id`,
      [co, id, keywordId, rows.filter((r) => r.keywordId === keywordId).length, syncedAt, batch]);
    }
    for (const r of rows) {
      await q(`
        insert into seo_serp_observations (company_entity_id, run_id, keyword_id, provider, observed_on, location_name, language_code, device, search_engine,
                                           result_type, position, domain, url, title, synced_at, sync_batch_id)
        values ($1, $2, $3, 'dataforseo', $4, 'United States', 'en', $5, 'google', $6, $7, $8, $9, $10, $11, $12)
        on conflict (run_id, keyword_id, result_type, position)
        do update set domain = excluded.domain, url = excluded.url, title = excluded.title, synced_at = excluded.synced_at, sync_batch_id = excluded.sync_batch_id`,
      [co, id, r.keywordId, observedOn, device, r.resultType || 'organic', r.position, r.domain, r.url || `https://${r.domain}/`, r.title || null, syncedAt, batch]);
    }
    if (complete) {
      await q('update seo_serp_runs set completed_at = $2, synced_at = $3, result_count = (select count(*) from seo_serp_observations where run_id = $1) where id = $1', [id, syncedAt, syncedAt]);
    }
    return id;
  });
}

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
    ($1,'baseballism.myshopify.com','www.baseballism.com','primary')`, [co]);

  // A SINGLE Search Console day, deliberately: seo_keyword_landscape_v's gsc
  // CTE SUMS clicks/impressions across whatever days fall in its 28-day
  // window, so one seeded day makes every downstream score assertion exact
  // (a sum of many identical days would multiply, not equal, the daily figure).
  const SC_DAY = '2026-09-18';
  await q(`insert into search_console_site_daily(company_entity_id,site_url,day_date,clicks,impressions,synced_at)
    values ($1,$2,$3,15,430,'2026-09-19T09:00:00Z')`, [co, SITE, SC_DAY]);
  await q(`insert into search_console_query_daily(company_entity_id,site_url,day_date,query,clicks,impressions,position,synced_at) values
    ($1,$2,$3,'baseball backpacks',3,150,6.0,'2026-09-19T09:00:00Z'),
    ($1,$2,$3,'baseball gifts for boys',0,80,0.0,'2026-09-19T09:00:00Z'),
    ($1,$2,$3,'baseball dad hat',12,120,2.0,'2026-09-19T09:00:00Z'),
    ($1,$2,$3,'baseball raglan tee',0,60,0.0,'2026-09-19T09:00:00Z'),
    ($1,$2,$3,'baseball raglan sleeve',0,40,0.0,'2026-09-19T09:00:00Z'),
    ($1,$2,$3,'baseball tote bag',0,20,15.0,'2026-09-19T09:00:00Z'),
    ($1,$2,$3,'baseball glove',8,90,2.0,'2026-09-19T09:00:00Z')`, [co, SITE, SC_DAY]);
  await db.exec('refresh materialized view search_console_query_rollup_mv');

  // Applied to BOTH migration files' text: 20260927120000 create-or-replaces
  // the same view, carrying every other class's formula and evidence_strength
  // block forward verbatim, so a mutation targeting those must survive into
  // the follow-up migration's text too -- otherwise the follow-up's clean
  // CREATE OR REPLACE would silently un-mutate the view right after the base
  // migration's test applied the broken version, and the three original
  // mutations would falsely appear to pass once 20260927120000 existed.
  function applyMutation(sql) {
    let effective = sql;
    if (mutation === 'score-not-halved') {
      effective = effective.replaceAll("case when b.observation_runs is not null and b.observation_runs < 2 then 0.5 else 1 end", '1');
    }
    if (mutation === 'absence-as-zero') {
      // Force our_position to read 0 instead of NULL when absent, the exact
      // absence-collapsed-to-zero bug this view exists to avoid. Every branch's
      // select-list column is the same literal text; replaceAll mutates all of
      // them, which is fine -- the test only reads the absent_with_demand row.
      effective = effective.replaceAll('b.our_serp_position as our_position,', "coalesce(b.our_serp_position, 0) as our_position,");
      effective = effective.replaceAll('b.our_serp_position, b.our_url, b.our_page_type,', "coalesce(b.our_serp_position, 0), b.our_url, b.our_page_type,");
    }
    if (mutation === 'numeric-confidence') {
      effective = effective.replaceAll("when b.sc_clicks_28d > 0 then 'strong'\n      else 'moderate'\n    end as evidence_strength,",
        "when b.sc_clicks_28d > 0 then '90'\n      else '50'\n    end as evidence_strength,");
    }
    if (mutation === 'defend-not-filtered') {
      // Reverts to the original 20260926180000 behaviour: every top-3-with-clicks
      // keyword qualifies for 'defend', is_at_risk reported as an attribute
      // rather than gating admission. This is the exact bug 20260927120000 fixes.
      // A no-op against 20260926180000's own text (neither pattern occurs there).
      effective = effective
        .replaceAll('true as is_at_risk,', '(coalesce(b.our_serp_movement, 0) < 0) as is_at_risk,')
        .replaceAll('    and coalesce(b.our_serp_movement, 0) < 0\n\n  union all', '\n\n  union all');
    }
    return effective;
  }

  await test('the recommendations migration applies twice, cleanly, on top of the committed SEO migrations', async () => {
    const sql = await readFile(new URL(`supabase/migrations/${MIGRATION}`, root), 'utf8');
    const effective = applyMutation(sql);
    await db.exec(effective);
    await db.exec(effective);
    assert.equal(await scalar("select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='seo_recommendations_v' and c.relkind='v'"), 1);
    assert.equal(await scalar("select 'security_invoker=true' = any(reloptions) from pg_class where relname='seo_recommendations_v'"), true, 'security_invoker');
    assert.equal(await scalar("select provolatile from pg_proc where proname='seo_recommendations_keyword_stem'"), 'i', 'the stem function is IMMUTABLE');
  });

  await test('the defend-requires-decline follow-up migration (20260927120000) applies twice, cleanly', async () => {
    const sql = await readFile(new URL(`supabase/migrations/${FOLLOWUP_MIGRATION}`, root), 'utf8');
    const effective = applyMutation(sql);
    await db.exec(effective);
    await db.exec(effective);
    assert.equal(await scalar("select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='seo_recommendations_v' and c.relkind='v'"), 1);
  });

  await test('seo_recommendations_keyword_stem: first 1-2 significant words, stopwords dropped, trailing s stripped', async () => {
    assert.equal(await scalar("select public.seo_recommendations_keyword_stem('Baseball  Backpacks')"), 'baseball backpack');
    assert.equal(await scalar("select public.seo_recommendations_keyword_stem('gifts for boys')"), 'gift boy', 'stopword "for" dropped, first two significant words kept');
    assert.equal(await scalar("select public.seo_recommendations_keyword_stem('the raglan tee')"), 'raglan tee', 'leading stopword dropped');
    assert.equal(await scalar("select public.seo_recommendations_keyword_stem('   ')"), '', 'blank in, blank out');
  });

  let kBackpacks, kGifts, kHat, kRaglanTee, kRaglanSleeve, kTote, kGlove;
  await test('seed the keyword set: one keyword per opportunity class, plus a two-keyword cluster for missing_category', async () => {
    kBackpacks = await asMember(() => scalar("insert into seo_keyword_set (company_entity_id, keyword, source, is_active) values ($1, 'baseball backpacks', 'manual', true) returning id", [co]));
    kGifts = await asMember(() => scalar("insert into seo_keyword_set (company_entity_id, keyword, source, is_active) values ($1, 'baseball gifts for boys', 'manual', true) returning id", [co]));
    kHat = await asMember(() => scalar("insert into seo_keyword_set (company_entity_id, keyword, source, is_active) values ($1, 'baseball dad hat', 'manual', true) returning id", [co]));
    kRaglanTee = await asMember(() => scalar("insert into seo_keyword_set (company_entity_id, keyword, source, is_active) values ($1, 'baseball raglan tee', 'manual', true) returning id", [co]));
    kRaglanSleeve = await asMember(() => scalar("insert into seo_keyword_set (company_entity_id, keyword, source, is_active) values ($1, 'baseball raglan sleeve', 'manual', true) returning id", [co]));
    kTote = await asMember(() => scalar("insert into seo_keyword_set (company_entity_id, keyword, source, is_active) values ($1, 'baseball tote bag', 'manual', true) returning id", [co]));
    kGlove = await asMember(() => scalar("insert into seo_keyword_set (company_entity_id, keyword, source, is_active) values ($1, 'baseball glove', 'manual', true) returning id", [co]));
    assert.equal(await scalar('select public.seo_recommendations_keyword_stem(keyword) from seo_keyword_set where id=$1', [kRaglanTee]),
      await scalar('select public.seo_recommendations_keyword_stem(keyword) from seo_keyword_set where id=$1', [kRaglanSleeve]),
      'the two raglan keywords share a stem -- the cluster this test exercises');
  });

  await test('page_one_not_top3: rank 6 on desktop, one run only -- early, halved score, no competitor captured', async () => {
    await providerRun({ observedOn: '2026-09-15', syncedAt: '2026-09-15T06:00:00Z', batch: 'r1', rows: [
      { keywordId: kBackpacks, position: 1, domain: 'bl101.com', url: 'https://bl101.com/collections/backpacks', title: 'Baseball Backpacks & Bags | BL101' },
      { keywordId: kBackpacks, position: 6, domain: 'www.baseballism.com', url: 'https://www.baseballism.com/collections/backpacks', title: 'Backpacks | Baseballism Online' },
    ] });
    const rows = await asMember(() => q("select * from seo_recommendations_v where keyword_id=$1 and opportunity_class='page_one_not_top3'", [kBackpacks]));
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.our_position, 6);
    assert.equal(r.competitor_domain, 'bl101.com');
    assert.equal(r.competitor_position, 1);
    assert.equal(r.competitor_page_type, 'collection');
    assert.equal(r.our_page_type, 'collection');
    assert.equal(r.observation_runs, 1);
    assert.equal(r.observed_single_run, true);
    assert.equal(r.evidence_strength, 'early', 'a single run is early regardless of clicks');
    // score = impressions(28d=150) * gap(6-3=3) * 0.5 (single run) = 225
    assert.equal(Number(r.score), 225, 'halved for a single run');
    assert.equal(r.our_captured_title, null, 'not captured, never blank');
    assert.equal(r.competitor_captured_title, null);
  });

  await test('a second run flips the class to strong evidence and un-halves the score, without altering the transition wording rule', async () => {
    await providerRun({ observedOn: '2026-09-22', syncedAt: '2026-09-22T06:00:00Z', batch: 'r2', rows: [
      { keywordId: kBackpacks, position: 1, domain: 'bl101.com', url: 'https://bl101.com/collections/backpacks', title: 'Baseball Backpacks & Bags | BL101' },
      { keywordId: kBackpacks, position: 5, domain: 'www.baseballism.com', url: 'https://www.baseballism.com/collections/backpacks', title: 'Backpacks | Baseballism Online' },
    ] });
    const r = await asMember(() => first("select * from seo_recommendations_v where keyword_id=$1 and opportunity_class='page_one_not_top3'", [kBackpacks]));
    assert.equal(r.our_position, 5);
    assert.equal(r.observation_runs, 2);
    assert.equal(r.observed_single_run, false);
    assert.equal(r.evidence_strength, 'strong', 'two runs and nonzero clicks (3 clicks recorded for this keyword)');
    assert.equal(Number(r.score), 300, 'impressions(150) * gap(5-3=2), no discount now');
  });

  await test('defend: top-3 with clicks, flagged is_at_risk when movement is negative, worded as a two-run transition', async () => {
    // A separate keyword, moved into the top 3 across two runs, one declining.
    await providerRun({ observedOn: '2026-09-29', syncedAt: '2026-09-29T06:00:00Z', batch: 'r3', rows: [
      { keywordId: kHat, position: 1, domain: 'rival.example', url: 'https://rival.example/' },
      { keywordId: kHat, position: 2, domain: 'www.baseballism.com', url: 'https://www.baseballism.com/collections/hats' },
    ] });
    await providerRun({ observedOn: '2026-10-06', syncedAt: '2026-10-06T06:00:00Z', batch: 'r4', rows: [
      { keywordId: kHat, position: 1, domain: 'rival.example', url: 'https://rival.example/' },
      { keywordId: kHat, position: 3, domain: 'www.baseballism.com', url: 'https://www.baseballism.com/collections/hats' },
    ] });
    const r = await asMember(() => first("select * from seo_recommendations_v where keyword_id=$1 and opportunity_class='defend'", [kHat]));
    assert.equal(r.our_position, 3);
    assert.equal(r.is_at_risk, true, 'moved from #2 to #3: movement is negative');
    assert.match(r.suggested_action, /two most recent runs/, 'names the transition, not a trend');
    assert.match(r.suggested_action, /not a trend/i, 'explicitly disclaims a trend, per the class rule');
    assert.equal(Number(r.score), 120, 'gap = 4 - position = 1 -- score is impressions(120) with no discount (2 runs)');
  });

  await test('defend: a STABLE top-3 keyword (no decline, real clicks) is NOT surfaced at all -- the 20260927120000 fix', async () => {
    // Two runs, same position both times: exactly the shape production showed
    // 91 times over (74 of them at rank #1) before this migration -- a
    // "recommendation" that is really "nothing to do here".
    await providerRun({ observedOn: '2026-09-29', syncedAt: '2026-09-29T06:05:00Z', batch: 'rglove1', rows: [
      { keywordId: kGlove, position: 1, domain: 'rival.example', url: 'https://rival.example/gloves' },
      { keywordId: kGlove, position: 2, domain: 'www.baseballism.com', url: 'https://www.baseballism.com/collections/gloves' },
    ] });
    await providerRun({ observedOn: '2026-10-06', syncedAt: '2026-10-06T06:05:00Z', batch: 'rglove2', rows: [
      { keywordId: kGlove, position: 1, domain: 'rival.example', url: 'https://rival.example/gloves' },
      { keywordId: kGlove, position: 2, domain: 'www.baseballism.com', url: 'https://www.baseballism.com/collections/gloves' },
    ] });
    const rows = await asMember(() => q("select * from seo_recommendations_v where keyword_id=$1", [kGlove]));
    // Under RECS_DB_MUTATION=defend-not-filtered this must FAIL: the row comes
    // back as opportunity_class='defend' with is_at_risk=false, the exact
    // pre-fix shape measured in production.
    assert.equal(rows.length, 0,
      `a stable rank-#2 keyword with clicks must not appear in ANY class (defend included); got: ${JSON.stringify(rows.map((r) => r.opportunity_class))}`);
  });

  await test('absent_with_demand: a run happened, we are not in it, Search Console shows demand -- "check, one snapshot" at one run', async () => {
    await providerRun({ observedOn: '2026-09-15', syncedAt: '2026-09-15T06:10:00Z', batch: 'rg', rows: [
      { keywordId: kGifts, position: 4, domain: 'bl101.com', url: 'https://bl101.com/blogs/the-bullpen/best-baseball-gifts', title: 'Best Baseball Gifts for Kids: A Parent\'s Guide by Age and Budget' },
    ] });
    const r = await asMember(() => first("select * from seo_recommendations_v where keyword_id=$1 and opportunity_class='absent_with_demand'", [kGifts]));
    assert.ok(r, 'a run happened and we are absent, with 80 impressions of demand');
    assert.equal(r.our_position, null, 'absent is NULL, never 0');
    assert.equal(r.observation_runs, 1);
    assert.match(r.suggested_action, /single run/i, 'the one-run caveat is stated, not implied');
    assert.equal(r.competitor_domain, 'bl101.com');
    assert.equal(r.competitor_page_type, 'article');
  });

  await test('content_brief: competitor ranks with an article, we rank with a collection -- PAA questions carried as the outline', async () => {
    await asRole('service_role', '', () => q(`
      insert into seo_serp_features (company_entity_id, run_id, keyword_id, provider, observed_on, location_name, language_code, device, search_engine, feature_type, position, details, synced_at)
      values ($1, (select latest_run_id from seo_keyword_landscape_v where keyword_id=$2 and company_entity_id=$1 limit 1), $2, 'dataforseo', '2026-09-15', 'United States', 'en', 'desktop', 'google', 'people_also_ask', 3,
        $3::jsonb, '2026-09-15T06:10:00Z')`,
      [co, kGifts, JSON.stringify({ entries: [{ title: 'What is a good gift for a 10 year old baseball player?' }, { title: 'How much should I spend on a baseball gift?' }] })]));
    const r = await asMember(() => first("select * from seo_recommendations_v where keyword_id=$1 and opportunity_class='content_brief'", [kGifts]));
    assert.ok(r, 'competitor is an article, we are absent -- qualifies for content_brief too');
    assert.equal(r.paa_questions.length, 2);
    assert.match(r.suggested_action, /2 questions/);
    assert.match(r.suggested_action, /hypothesis to test/i, 'the page-type difference is named as a hypothesis, never a cause');
  });

  await test('missing_category: two active keywords share a stem, have demand, and neither has ever ranked', async () => {
    const rows = await asMember(() => q("select * from seo_recommendations_v where opportunity_class='missing_category'"));
    // Only the raglan pair shares a stem AND has >=2 keywords AND neither ranks
    // (kTote has demand but is alone; kBackpacks/kHat/kGifts each rank or have
    // been observed ranking by now in some run).
    const raglan = rows.find((r) => r.keyword === 'baseball raglan');
    assert.ok(raglan, `expected a "baseball raglan" cluster; got: ${JSON.stringify(rows.map((r) => r.keyword))}`);
    assert.equal(raglan.keyword_id, null, 'a cluster has no single keyword id');
    assert.deepEqual(raglan.keyword_cluster.slice().sort(), ['baseball raglan sleeve', 'baseball raglan tee']);
    assert.equal(raglan.our_position, null);
    assert.equal(raglan.evidence_strength, 'early', 'no clicks recorded for either raglan query, so a category with impressions-only demand reads early, not moderate');
    assert.equal(Number(raglan.score), 100, 'missing_category scores on the cluster impressions alone: 60 + 40');
    assert.ok(!rows.some((r) => (r.keyword_cluster || []).includes('baseball tote bag')), 'a single-keyword "cluster" is not a category (keyword_count < 2)');
  });

  await test('evidence_strength is exactly strong, moderate or early -- never a percentage or numeric confidence', async () => {
    const rows = await asMember(() => q('select distinct evidence_strength from seo_recommendations_v'));
    const allowed = new Set(['strong', 'moderate', 'early']);
    assert.ok(rows.length > 0, 'the seeded data must produce at least one row to check');
    for (const row of rows) {
      assert.ok(allowed.has(row.evidence_strength), `unexpected evidence_strength: ${row.evidence_strength}`);
    }
  });

  await test('company isolation: another company sees none of this company\'s recommendations', async () => {
    const rows = await asRole('authenticated', outsider, () => q('select * from seo_recommendations_v'));
    assert.equal(rows.length, 0);
  });

  await test('the view never fabricates a zero: our_position, competitor fields and captures are all NULL when absent', async () => {
    const r = await asMember(() => first("select * from seo_recommendations_v where keyword_id=$1 and opportunity_class='absent_with_demand'", [kGifts]));
    assert.equal(r.our_position, null);
    assert.equal(r.our_url, null);
    assert.equal(r.our_captured_title, null);
  });

  await test('two tabs racing to create the "SEO Recommendations" project cannot both succeed', async () => {
    // The exact race findOrCreateSeoProject() in v2/seo-keywords.html can hit:
    // two people confirm their first Recommendations task at the same moment,
    // both read "no project yet", both insert. Without a uniqueness backstop
    // that silently produces two projects; the page's re-read-on-error only
    // works if the second insert is actually refused.
    const first = await asMember(() => scalar("insert into seo_projects (company_entity_id, name, status) values ($1, 'SEO Recommendations', 'active') returning id", [co]));
    assert.ok(first);
    await refused(() => asMember(() => q("insert into seo_projects (company_entity_id, name, status) values ($1, 'SEO Recommendations', 'active')", [co])),
      /seo_projects_recommendations_singleton|duplicate key/, 'a second "SEO Recommendations" project for the same company');
    // A DIFFERENT company may still have its own -- this is per-company, not global.
    const other = await asRole('authenticated', outsider, () => scalar("insert into seo_projects (company_entity_id, name, status) values ($1, 'SEO Recommendations', 'active') returning id", [otherCo]));
    assert.ok(other, 'the uniqueness is scoped per company, not global');
  });

  await test('the committed verify_v2_schema.sql check for seo_recommendations_v returns ok', async () => {
    const verifySql = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
    const checks = splitSqlStatements(verifySql).filter((s) => /as seo_recommendations\b/.test(s.text));
    assert.equal(checks.length, 1, 'the seo_recommendations check must be committed');
    for (const sql of checks) {
      const rows = await q(sql.text);
      assert.ok(rows.length > 0, 'a verification check must return evidence');
      for (const row of rows) assert.equal(Object.values(row)[0], 'ok', JSON.stringify(row));
    }
    const row = await first("select description from silo_chat_schema_catalog where relname='seo_recommendations_v'");
    assert.ok(row, 'catalogued');
    assert.ok(row.description.includes('strong / moderate / early') || row.description.includes('EXACTLY strong'), 'catalog states the evidence_strength vocabulary');
  });

  console.log(`${passed} SEO recommendations database tests passed (local PostgreSQL only).`);
} finally {
  await db.close();
}
