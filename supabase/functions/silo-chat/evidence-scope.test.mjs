/* Evidence-scope derivation -- DETERMINISTIC unit assertions.
 *
 * These prove what the code computes from a statement. They prove nothing
 * about what a model then writes; that question is the eval harness in
 * evals/, which is a different kind of test and is kept in a different file
 * on purpose. Do not read a green run here as "Ask SILO now labels figures
 * correctly".
 *
 * Every case is one of the two traced failures of 2026-09-16, with the real
 * SQL those requests ran (see evidence-fixtures.mjs).
 *
 * Run: node supabase/functions/silo-chat/evidence-scope.test.mjs
 */
import {
  SCOPE_COLUMNS, QUERY_ROW_CAP, denoise, cteNames, relationsInStatement,
  dateLiteralsIn, buildCatalogIndex, describeEvidenceScope, renderQueryResult,
} from './evidence-scope.mjs';
import {
  CATALOG_FIXTURE, COMBINED_SPEND_SQL, COMBINED_SPEND_ROWS, PER_PLATFORM_SQL,
  PER_PLATFORM_ROWS, WEEKLY_BUCKET_SQL, WEEKLY_BUCKET_ROWS, CREATIVE_MATCH_SQL,
} from './evidence-fixtures.mjs';

let failures = 0;
let run = 0;
function test(name, fn) {
  run++;
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}
function assert(cond, message) { if (!cond) throw new Error(message); }
function eq(a, b, label) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${label}\n       expected ${y}\n       actual   ${x}`);
}

const INDEX = buildCatalogIndex(CATALOG_FIXTURE);
const scopeOf = (sql, meta) => describeEvidenceScope(sql, INDEX, meta || {});
const pooledCols = (s) => (s.pooled_across || []).map((p) => `${p.relation}.${p.column}`);
const narrowedCols = (s) => (s.narrowed_to || []).map((p) => `${p.relation}.${p.column}`);

console.log('\n-- statement parsing --');

test('string contents cannot be mistaken for structure', () => {
  const { text, literals } = denoise("select 1 from t where name = 'group by platform'");
  assert(!/group\s+by/.test(text), `literal leaked into structure: ${text}`);
  eq(literals, ['group by platform'], 'literal table');
});

test("a doubled quote inside a literal does not end it", () => {
  const { literals } = denoise("select 1 from t where s = 'it''s here' and x = 2");
  eq(literals, ["it's here"], 'escaped quote');
});

test('a CTE name is not reported as a relation', () => {
  const names = cteNames(denoise(CREATIVE_MATCH_SQL).text);
  assert(names.has('sonic_ads'), 'sonic_ads not recognised as a CTE');
  eq(relationsInStatement(CREATIVE_MATCH_SQL), ['meta_ad_creatives', 'meta_ad_performance_daily'], 'relations');
});

test('information_schema discovery carries no business scope', () => {
  eq(relationsInStatement("select column_name from information_schema.columns where table_name='sales_by_day'"), [], 'relations');
  const rendered = renderQueryResult(
    "select column_name from information_schema.columns where table_name='sales_by_day'",
    [{ column_name: 'day_date' }], INDEX,
  );
  assert(!rendered.includes('evidence_scope'), 'a catalog lookup got an envelope it does not need');
});

test('every ISO date written into the statement is recovered, deduped and sorted', () => {
  eq(dateLiteralsIn(WEEKLY_BUCKET_SQL),
    ['2026-08-17', '2026-08-23', '2026-08-24', '2026-08-30', '2026-08-31', '2026-09-06', '2026-09-07', '2026-09-13'],
    'bucket edges');
});

console.log('\n-- FAILURE 1: combined-platform spend must not be presented as one platform --');

test('a relation with no platform column is reported as totals-only', () => {
  const s = scopeOf(COMBINED_SPEND_SQL, { resultId: 'R8' });
  const totals = (s.totals_only || []).find((t) => t.relation === 'marketing_daily_totals_v');
  assert(totals, `marketing_daily_totals_v was not flagged as totals-only: ${JSON.stringify(s.totals_only)}`);
  assert(totals.carries_none_of.includes('platform'), 'platform not named among the columns it lacks');
  assert(totals.carries_none_of.includes('campaign_name'), 'campaign_name not named among the columns it lacks');
  assert(/cannot be attributed to one platform/i.test(s.totals_only_means), 'the consequence is not stated');
});

test('...and the per-platform result is reported as broken out, not pooled', () => {
  const s = scopeOf(PER_PLATFORM_SQL, { resultId: 'R9' });
  eq((s.broken_out_per_value || []).map((b) => `${b.relation}.${b.column}`),
    ['marketing_kpis_daily.platform'], 'broken out');
  assert(!pooledCols(s).includes('marketing_kpis_daily.platform'), 'a GROUP BY column was called pooled');
});

test('the two results are distinguishable by their envelopes alone', () => {
  const a = renderQueryResult(COMBINED_SPEND_SQL, COMBINED_SPEND_ROWS, INDEX, { resultId: 'R8' });
  const b = renderQueryResult(PER_PLATFORM_SQL, PER_PLATFORM_ROWS, INDEX, { resultId: 'R9' });
  assert(a.includes('totals_only'), 'the pooled result does not say it is pooled');
  assert(!b.includes('totals_only'), 'the split result claims to be pooled');
  assert(a.includes('"result_id":"R8"') && b.includes('"result_id":"R9"'), 'results are not individually addressable');
});

test('the envelope is read before the numbers', () => {
  const rendered = renderQueryResult(COMBINED_SPEND_SQL, COMBINED_SPEND_ROWS, INDEX, { resultId: 'R8' });
  assert(rendered.indexOf('evidence_scope') < rendered.indexOf('"rows"'), 'rows come before their scope');
  assert(JSON.parse(rendered).rows.length === 1, 'the rows themselves did not survive');
});

console.log('\n-- FAILURE 2: a bucket that straddles a launch is not "before" or "after" it --');

test('a bucketed result names its bucket edges and says so', () => {
  const s = scopeOf(WEEKLY_BUCKET_SQL, { resultId: 'R12' });
  assert(s.date_scope.literals_in_statement.includes('2026-08-31'), 'the Aug 31 bucket edge is not surfaced');
  assert(/bucketed/i.test(s.date_scope.note || ''), `no bucket warning: ${JSON.stringify(s.date_scope)}`);
  assert(/never "before"\/"after"/i.test(s.date_scope.note || ''), 'the before/after prohibition is missing');
});

test('a two-date window is a window, not a bucketing', () => {
  const s = scopeOf(PER_PLATFORM_SQL);
  eq(s.date_scope.window, { from: '2026-08-24', to: '2026-08-30' }, 'window');
  assert(!s.date_scope.note, 'a plain window was reported as bucketed');
});

console.log('\n-- FAILURE 3: a population spanning campaigns is not one campaign --');

test('a creative-text match with no campaign predicate is reported as pooling campaigns', () => {
  const s = scopeOf(CREATIVE_MATCH_SQL, { resultId: 'R8' });
  assert(pooledCols(s).includes('meta_ad_performance_daily.campaign_name'),
    `campaign_name not reported as pooled: ${JSON.stringify(s.pooled_across)}`);
  assert(pooledCols(s).includes('meta_ad_performance_daily.ad_id'), 'ad_id not reported as pooled');
});

test('...and an unrestricted date range says so rather than going quiet', () => {
  const s = scopeOf(CREATIVE_MATCH_SQL);
  assert(typeof s.date_scope.window === 'string' && /not restricted/i.test(s.date_scope.window),
    `an unbounded query claimed a window: ${JSON.stringify(s.date_scope)}`);
});

test('a campaign that IS filtered is reported with the value it was filtered to', () => {
  const s = scopeOf(WEEKLY_BUCKET_SQL);
  const n = (s.narrowed_to || []).find((x) => x.column === 'campaign_name');
  assert(n && n.values && n.values.includes('Subscribers'), `campaign filter not recovered: ${JSON.stringify(s.narrowed_to)}`);
  const p = (s.narrowed_to || []).find((x) => x.column === 'platform');
  assert(p && p.values && p.values.includes('meta_ads'), 'platform filter not recovered');
});

console.log('\n-- the derivation does not overclaim --');

test('a column that is merely mentioned is reported as pooled, not as narrowed', () => {
  const sql = 'select campaign_name, sum(spend) from marketing_kpis_daily group by 1 order by campaign_name';
  const s = scopeOf(sql);
  assert(pooledCols(s).includes('marketing_kpis_daily.platform'), 'platform should be pooled here');
  assert(!narrowedCols(s).includes('marketing_kpis_daily.platform'), 'mention was read as a filter');
});

test('the envelope states it describes the query and not the values', () => {
  const s = scopeOf(PER_PLATFORM_SQL);
  assert(/does not verify a number/i.test(s.derivation), `derivation caveat missing: ${s.derivation}`);
  assert(/pooled is the safe reading/i.test(s.derivation), 'the bias direction is not stated');
});

test('the derivation names the two ambiguities it cannot resolve', () => {
  // Found by reading the final path rather than the helpers: the predicate
  // search runs over the WHOLE statement, so a filter on one relation's
  // campaign_name is reported for every relation in the query that has one,
  // and a filter inside a CTE branch is reported even when that branch does
  // not reach the returned rows. Both over-report NARROWED, which is the
  // unsafe direction -- so the envelope says so rather than pretending the
  // derivation is exact.
  const s = scopeOf(WEEKLY_BUCKET_SQL);
  assert(/two relations here carry the same column/i.test(s.derivation), 'the join ambiguity is not disclosed');
  assert(/inside a subquery or CTE/i.test(s.derivation), 'the CTE ambiguity is not disclosed');
});

test('a relation outside the schema map is named rather than silently dropped', () => {
  const s = scopeOf('select * from some_table_nobody_catalogued where x = 1');
  eq(s.relations_not_in_schema_map, ['some_table_nobody_catalogued'], 'unmapped relations');
});

test('a full first page says it is a first page', () => {
  const rows = Array.from({ length: QUERY_ROW_CAP }, (_, i) => ({ i }));
  const s = scopeOf(PER_PLATFORM_SQL, { rowCount: rows.length });
  assert(/FIRST PAGE/.test(s.page_cap_reached || ''), 'a capped result did not say so');
  assert(!scopeOf(PER_PLATFORM_SQL, { rowCount: 3 }).page_cap_reached, 'a short result claimed a cap');
});

test('SCOPE_COLUMNS holds the dimensions these failures turned on', () => {
  for (const col of ['platform', 'campaign_name', 'ad_id', 'location_name']) {
    assert(SCOPE_COLUMNS.includes(col), `${col} is not treated as a scope column`);
  }
});

console.log(`\n${run - failures}/${run} passed`);
if (failures) process.exit(1);
