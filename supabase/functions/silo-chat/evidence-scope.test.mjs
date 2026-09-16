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
  auditAnswerClaims, unresolvedDimensions, formatClaimNote, CLAIM_DIMENSIONS,
} from './evidence-scope.mjs';
import {
  CATALOG_FIXTURE, COMBINED_SPEND_SQL, COMBINED_SPEND_ROWS, PER_PLATFORM_SQL,
  PER_PLATFORM_ROWS, WEEKLY_BUCKET_SQL, WEEKLY_BUCKET_ROWS, CREATIVE_MATCH_SQL,
  SONIC_TITLE_SALES_SQL, SONIC_ANSWER_CHANNEL_CLAIM,
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

test('...and a query with no date predicate says so without claiming all history', () => {
  const s = scopeOf(CREATIVE_MATCH_SQL);
  assert(!s.date_scope.window, `an unbounded query claimed a window: ${JSON.stringify(s.date_scope)}`);
  assert(/no date predicate was readable/i.test(s.date_scope.restriction), 'the absent predicate is not reported');
  // It used to say "this result covers every date present in the relation(s)".
  // That is an assertion about the data made from a textual read of the
  // statement: a date filter this parser cannot see reads as no filter at all.
  assert(/not a guarantee/i.test(s.date_scope.restriction), 'the parser-not-prover caveat is missing');
});

test('a campaign that IS filtered is reported with the value it was filtered to', () => {
  const s = scopeOf(WEEKLY_BUCKET_SQL);
  const n = (s.narrowed_to || []).find((x) => x.column === 'campaign_name');
  assert(n && n.values && n.values.includes('Subscribers'), `campaign filter not recovered: ${JSON.stringify(s.narrowed_to)}`);
  const p = (s.narrowed_to || []).find((x) => x.column === 'platform');
  assert(p && p.values && p.values.includes('meta_ads'), 'platform filter not recovered');
});

console.log('\n-- CYCLE 1: an exclusion is not an inclusion --');

// Reported by the independent review and reproduced before fixing: a correct
// non-Meta total came back carrying `narrowed_to: platform = ['meta_ads']`.
// Every exclusion operator was being read by the same positive-value collector,
// so the envelope said the opposite of what the statement asked for -- this
// module committing the mislabelling it exists to prevent.
for (const [label, sql] of [
  ['<>', "select sum(spend) from marketing_kpis_daily where platform <> 'meta_ads'"],
  ['!=', "select sum(spend) from marketing_kpis_daily where platform != 'meta_ads'"],
  ['NOT IN', "select sum(spend) from marketing_kpis_daily where platform not in ('meta_ads','tiktok_ads')"],
]) {
  test(`${label} is reported as an exclusion, never as a narrowing to that value`, () => {
    const s = scopeOf(sql);
    assert(!narrowedCols(s).includes('marketing_kpis_daily.platform'),
      `an exclusion was reported as a narrowing: ${JSON.stringify(s.narrowed_to)}`);
    const x = (s.excludes || []).find((e) => e.column === 'platform');
    assert(x, `no exclusion recorded: ${JSON.stringify(s)}`);
    assert(x.values.includes('meta_ads'), `excluded values not recovered: ${JSON.stringify(x)}`);
  });
}

test('an inclusion and an exclusion in one statement stay on their own sides', () => {
  const s = scopeOf(
    "select sum(spend) from marketing_kpis_daily where platform = 'meta_ads' and campaign_name not in ('Subscribers')",
  );
  const inc = (s.narrowed_to || []).find((n) => n.column === 'platform');
  eq(inc && inc.values, ['meta_ads'], 'included values');
  const exc = (s.excludes || []).find((e) => e.column === 'campaign_name');
  eq(exc && exc.values, ['Subscribers'], 'excluded values');
});

test('a predicate with no readable values is neither one value nor all of them', () => {
  const s = scopeOf("select sum(spend) from marketing_kpis_daily where campaign_name ilike '%sonic%'");
  assert(!narrowedCols(s).includes('marketing_kpis_daily.campaign_name'), 'a LIKE was read as a value filter');
  assert(!pooledCols(s).includes('marketing_kpis_daily.campaign_name'), 'a LIKE was read as no filter');
  eq((s.restricted_no_readable_values || []).map((r) => r.column), ['campaign_name'], 'restricted columns');
});

console.log('\n-- CYCLE 1: a date window is read from the operators, not from stray dates --');

test('a relative bound is restricted, and is NOT reported as all history', () => {
  const s = scopeOf('select sum(spend) from marketing_kpis_daily where day_date >= current_date - 30');
  assert(!s.date_scope.window, 'a relative range was given a window');
  assert(/this IS restricted on a date/i.test(s.date_scope.restriction),
    `a 30-day query was reported as unrestricted: ${JSON.stringify(s.date_scope)}`);
  assert(/relative or computed/i.test(s.date_scope.restriction), 'the reason the edges are unreadable is not given');
});

test('a one-sided bound is not collapsed into a single-day window', () => {
  const s = scopeOf("select sum(spend) from marketing_kpis_daily where day_date >= '2026-09-01'");
  assert(!s.date_scope.window,
    `an open-ended range was published as a window: ${JSON.stringify(s.date_scope)}`);
  eq(s.date_scope.literals_in_statement, ['2026-09-01'], 'the literal is still surfaced');
  assert(/no end/.test(s.date_scope.restriction), `the open end is not named: ${s.date_scope.restriction}`);
});

test('...and the mirror case, an upper bound with no lower one', () => {
  const s = scopeOf("select sum(spend) from marketing_kpis_daily where day_date < '2026-09-01'");
  assert(!s.date_scope.window, 'an open-started range was published as a window');
  assert(/no start/.test(s.date_scope.restriction), `the open start is not named: ${s.date_scope.restriction}`);
});

test('two one-sided bounds together DO make a window', () => {
  const s = scopeOf(
    "select sum(spend) from marketing_kpis_daily where day_date >= '2026-09-01' and day_date <= '2026-09-07'",
  );
  eq(s.date_scope.window, { from: '2026-09-01', to: '2026-09-07' }, 'window');
});

test('a NEGATED range restricts without bounding, so it is not a window', () => {
  // `not between 'a' and 'b'` reaches both edges of the data with a hole in the
  // middle. Publishing a window from its literals would name the EXCLUDED range
  // as the period -- the date-side twin of the exclusion bug above.
  const s = scopeOf(
    "select sum(spend) from marketing_kpis_daily where day_date not between '2026-09-01' and '2026-09-07'",
  );
  assert(!s.date_scope.window, `a negated range was published as a window: ${JSON.stringify(s.date_scope)}`);
  assert(/this IS restricted on a date/i.test(s.date_scope.restriction), 'a negated range was read as no filter');
});

test('a date used only as a join key does not become a window', () => {
  // The same class as the ad_id join key on the value side: `t.day_date =
  // m.day_date` bounds nothing, and treating `=` as a full bound would report a
  // fully specified period on a query with no date filter at all.
  const s = scopeOf(
    'select sum(m.spend) from marketing_kpis_daily m join marketing_daily_totals_v t on t.day_date = m.day_date',
  );
  assert(!s.date_scope.window, `a join key was published as a window: ${JSON.stringify(s.date_scope)}`);
  assert(/no date predicate was readable/i.test(s.date_scope.restriction), 'a join key was read as a predicate');
});

console.log('\n-- CYCLE 2: separate periods are not one window --');

// Reported by the independent review and reproduced before fixing: a
// year-on-year query read two seven-day periods and the envelope called it a
// 372-day window. Third instance of the same root error -- asserting a period
// the statement never set -- so the fix fails closed.
const YOY_SQL = "select sum(spend) from marketing_kpis_daily where day_date between '2025-09-01' and '2025-09-07' or day_date between '2026-09-01' and '2026-09-07'";

test('a year-on-year comparison is not published as one continuous window', () => {
  const s = scopeOf(YOY_SQL);
  assert(!s.date_scope.window,
    `two seven-day periods were published as a window: ${JSON.stringify(s.date_scope.window)}`);
  assert(/SEVERAL SEPARATE PERIODS/.test(s.date_scope.restriction), 'the disjunction is not reported');
  assert(/is NOT the window/.test(s.date_scope.restriction),
    'nothing stops the earliest-to-latest span being read as the period');
});

test('...and each period is named, so the answer has something to describe', () => {
  eq(scopeOf(YOY_SQL).date_scope.periods,
    [{ from: '2025-09-01', to: '2025-09-07' }, { from: '2026-09-01', to: '2026-09-07' }],
    'periods');
});

test('an OR that is not about dates does NOT suppress the window', () => {
  // The detection has to be about DATE branches, not about the word `or`.
  // Failing closed on every disjunction would strip the window from a routine
  // "these two platforms over this week" query.
  const s = scopeOf(
    "select sum(spend) from marketing_kpis_daily where (platform = 'meta_ads' or platform = 'google_ads') and day_date between '2026-09-01' and '2026-09-07'",
  );
  eq(s.date_scope.window, { from: '2026-09-01', to: '2026-09-07' }, 'window');
  assert(!s.date_scope.periods, 'a single period was reported as several');
});

test('a disjoint branch that is not a from/to pair leaves periods UNLISTED, not short', () => {
  // A partial list of periods reads as the complete one, which is the failure
  // this whole file is about.
  const s = scopeOf(
    "select sum(spend) from marketing_kpis_daily where day_date between '2025-09-01' and '2025-09-07' or day_date >= '2026-09-01'",
  );
  assert(!s.date_scope.window, 'a disjoint query was published as a window');
  assert(!s.date_scope.periods, 'an incomplete period list was published as the whole set');
  assert(/NOT all listed here/.test(s.date_scope.restriction), 'the incompleteness is not stated');
});

test('the bucketed single-range query keeps its window (no false positive)', () => {
  // WEEKLY_BUCKET_SQL carries FIVE `between` predicates -- four inside a CASE
  // plus the enclosing WHERE -- and no OR. Counting BETWEENs instead of OR
  // branches would have stripped the window from the very query whose bucket
  // edges are the point of failure 2.
  const s = scopeOf(WEEKLY_BUCKET_SQL);
  eq(s.date_scope.window, { from: '2026-08-17', to: '2026-09-13' }, 'window');
  assert(!s.date_scope.periods, 'a bucketed single range was reported as several periods');
});

console.log('\n-- SONIC: a period boundary that came from nowhere --');

// The 2026-09-16 request asked whether prelaunch advertising paid off. Its
// first query answered the launch date from the planning record and showed
// preview_start_date NULL on every Sonic row -- the record does not say when
// prelaunch began. The sales query then ran `between '2026-08-01' and
// '2026-09-15'` and every "before the launch" figure rests on that 1 August.
const sonicKnown = { results: new Set(['2026-09-01', '2026-09-03', '2026-09-15']), question: new Set() };

test('a boundary that appears in no earlier result is marked unsourced', () => {
  const s = describeEvidenceScope(SONIC_TITLE_SALES_SQL, INDEX, { knownDates: sonicKnown });
  const p = s.date_scope.boundary_provenance;
  assert(p, `no provenance recorded: ${JSON.stringify(s.date_scope)}`);
  eq(p.unsourced, ['2026-08-01'], 'unsourced boundaries');
  eq(p.from_results, ['2026-09-15'], 'boundaries traceable to a queried value');
});

test('...and is named an assumption rather than a measurement', () => {
  const p = describeEvidenceScope(SONIC_TITLE_SALES_SQL, INDEX, { knownDates: sonicKnown }).date_scope.boundary_provenance;
  assert(/ASSUMPTION, not a measurement/.test(p.note), `note: ${p.note}`);
  assert(/say so in the answer/.test(p.note), 'the answer is not asked to state it');
});

test('a date the person supplied is sourced, not invented', () => {
  const s = describeEvidenceScope(SONIC_TITLE_SALES_SQL, INDEX, {
    knownDates: { results: new Set(['2026-09-15']), question: new Set(['2026-08-01']) },
  });
  const p = s.date_scope.boundary_provenance;
  eq(p.from_question, ['2026-08-01'], 'question-supplied dates');
  assert(!p.unsourced, 'a date the person gave was called invented');
  assert(!p.note, 'a fully sourced window was given a warning');
});

test('provenance rides along with an unreadable period too', () => {
  const s = describeEvidenceScope(
    "select sum(spend) from marketing_kpis_daily where day_date >= '2026-08-01'",
    INDEX, { knownDates: { results: new Set(), question: new Set() } },
  );
  assert(s.date_scope.boundary_provenance.unsourced.includes('2026-08-01'),
    'provenance is only attached to clean windows');
});

test('with no provenance supplied at all, nothing is claimed either way', () => {
  // Older callers, and the concept workflow, pass no knownDates. Every literal
  // would then be "unsourced", which is noise rather than information -- but it
  // is the safe direction, so it is asserted rather than special-cased away.
  const s = describeEvidenceScope(SONIC_TITLE_SALES_SQL, INDEX, {});
  eq(s.date_scope.boundary_provenance.unsourced, ['2026-08-01', '2026-09-15'], 'no-provenance case');
});

console.log('\n-- SONIC: "online" on a result that pooled every channel --');

const sonicSalesScope = () => [describeEvidenceScope(SONIC_TITLE_SALES_SQL, INDEX, {})];

test('the channel word is flagged when nothing resolved the channel', () => {
  const flags = auditAnswerClaims(SONIC_ANSWER_CHANNEL_CLAIM, sonicSalesScope());
  eq(flags.length, 1, `flags: ${JSON.stringify(flags)}`);
  eq(flags[0].label, 'sales channel', 'label');
  eq(flags[0].terms, ['online'], 'terms');
});

test('...and the note says the figures are real but the label is not', () => {
  const note = formatClaimNote(auditAnswerClaims(SONIC_ANSWER_CHANNEL_CLAIM, sonicSalesScope()));
  assert(/Scope check \(automatic\)/.test(note), 'no scope-check heading');
  assert(/the figures are real, the label on them was not established/.test(note), 'the distinction is missing');
  assert(/can be wrong in both directions/.test(note), 'the check does not admit its own fallibility');
});

test('a request that DID narrow the channel is not flagged', () => {
  const narrowed = [describeEvidenceScope(
    "select sum(net_sales) from sales_by_product_title_daily_v where location_tag = 'online'", INDEX, {},
  )];
  eq(auditAnswerClaims(SONIC_ANSWER_CHANNEL_CLAIM, narrowed), [], 'a narrowed request was flagged');
});

test('...nor one where ANOTHER result broke the channel out per value', () => {
  // Grouping by a dimension earns the right to name one of its values. The
  // pooled result has to be present too, or this passes vacuously: a grouped
  // column is never in pooled_across in the first place, so a lone grouped
  // result could not be flagged whatever unresolvedDimensions did. Mutation
  // testing caught the earlier version of this test doing exactly that.
  const mixed = [...sonicSalesScope(), describeEvidenceScope(
    'select location_tag, sum(net_sales) from sales_by_product_title_daily_v group by location_tag', INDEX, {},
  )];
  eq(auditAnswerClaims(SONIC_ANSWER_CHANNEL_CLAIM, mixed), [], 'grouping elsewhere did not resolve the dimension');
});

test('resolving it in ANY result of the request clears it for all of them', () => {
  const mixed = [...sonicSalesScope(), describeEvidenceScope(
    "select sum(net_sales) from sales_by_product_title_daily_v where location_tag = 'online'", INDEX, {},
  )];
  eq(auditAnswerClaims(SONIC_ANSWER_CHANNEL_CLAIM, mixed), [], 'one pooled result outvoted a narrowed one');
});

test('totals_only is deliberately NOT treated as pooled, and that is a trade', () => {
  // marketing_daily_totals_v carries no platform column, so platform appears in
  // totals_only. So does meta_ad_performance_daily's -- and every row THERE is
  // Meta's, where every row here spans three platforms. The envelope cannot
  // tell those apart, so feeding totals_only into the pooled set would flag the
  // word "Meta" every time a Meta-only table is aggregated, which is constant.
  //
  // The cost is real and is stated rather than hidden: a figure taken ONLY from
  // this view and called "Meta" is not caught by this route. It is caught by
  // the pooled route whenever the same request also reads marketing_kpis_daily,
  // which carries platform -- which is what the 2026-09-16 request did.
  const totalsOnly = [describeEvidenceScope('select sum(ad_spend) from marketing_daily_totals_v', INDEX, {})];
  eq(auditAnswerClaims('Meta ad spend reached $118,946 that week.', totalsOnly), [],
    'totals_only was fed into the pooled set');
});

test('a platform word IS flagged when a multi-platform relation was pooled', () => {
  const pooled = [describeEvidenceScope(
    "select sum(spend) from marketing_kpis_daily where day_date between '2026-08-24' and '2026-08-30'", INDEX, {},
  )];
  eq(auditAnswerClaims('Meta ad spend reached $118,946 that week.', pooled).map((f) => f.label),
    ['ad platform'], 'the trace-1 shape was not flagged');
});

test('word boundaries hold, so common words do not misfire', () => {
  const pooled = sonicSalesScope();
  eq(auditAnswerClaims('The position of each product in the metadata was unchanged.', pooled), [],
    '"pos" matched inside "position", or "meta" inside "metadata"');
});

test('an empty answer is not audited', () => {
  eq(auditAnswerClaims('', sonicSalesScope()), [], 'empty answer');
  eq(formatClaimNote([]), '', 'a note was produced with no flags');
});

test('unresolvedDimensions is the whole basis, and excludes count as resolved', () => {
  const excl = [describeEvidenceScope(
    "select sum(net_sales) from sales_by_product_title_daily_v where location_tag <> 'retail'", INDEX, {},
  )];
  assert(!unresolvedDimensions(excl).has('location_tag'), 'an exclusion left the dimension unresolved');
  assert(CLAIM_DIMENSIONS.some((d) => d.columns.includes('location_tag')), 'channel is not a claim dimension');
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
