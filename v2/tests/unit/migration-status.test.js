/* The migration flow's decision table.
 *
 * The visual is only worth having if its steps are DERIVED. So the assertions
 * that matter most here are the negative ones:
 *
 *   - a fact that could not be read never renders "Done"
 *   - measured-and-absent and not-measured are different answers
 *   - a later "Done" never lets the flow step over an earlier "Unknown"
 *   - coverage is judged against the hand-off date, never against a guess at
 *     how far back history "should" reach
 *   - every step states what it does not establish
 *
 * Fixtures mirror the real Baseballism position (cutover 2026-08-01, history
 * 2026-01-01 → 2026-07-31 with 71 exceptions) so a change that quietly
 * reclassifies the live books fails here first.
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { loadV2 } = require('../lib/load');

const r = createReporter('migration-status');
const M = loadV2(['migration-status.js']).SiloMigrationStatus;
const U = M.UNMEASURED;

/* The live position, as measured 2026-09-15. */
const LIVE = () => ({
  today: '2026-09-15',
  settings: { accounting_start_date: '2026-08-01', accounting_basis: 'Accrual', fiscal_year_start_month: 1 },
  opening: { status: 'accepted', accepted_at: '2026-09-14T00:00:00Z', as_of: '2026-07-31', line_count: 458 },
  history: [
    { period_start: '2026-01-01', period_end: '2026-07-31', exception_count: 71, transaction_count: 22909, created_at: '2026-09-15T03:50:03Z' },
    { period_start: '2026-01-01', period_end: '2026-07-31', exception_count: 71, transaction_count: 22909, created_at: '2026-09-15T04:11:00Z' },
  ],
  bank: { connections: [{ institution_name: 'Columbia Bank - Commercial', status: 'active' }],
    accounts: [{ name: 'Checking', type: 'depository', last_error_code: null }] },
  sources: [
    { source_key: 'columbia_cc', source_type: 'card', ingest_mode: 'csv', is_active: true, posting_enabled: true },
    { source_key: 'divvy', source_type: 'card', ingest_mode: 'csv', is_active: true, posting_enabled: true },
    { source_key: 'plaid_x', source_type: 'bank', ingest_mode: 'plaid', is_active: true, posting_enabled: false },
  ],
  coding: { total: 2250, uncoded: 64, rules: 813, splitRules: 0 },
  batches: [
    { status: 'draft', entry_date: '2026-07-31' },
    { status: 'posted', entry_date: '2026-08-31' },
    { status: 'draft', entry_date: '2026-09-30' },
  ],
  journals: [{ status: 'posted', entry_date: '2026-08-31', memo: 'Shopify sales & payout fees — 2026-08' }],
  revenue: { shops: 20, newestSalesDay: '2026-09-14' },
});

const stage = (facts, id) => M.assess(facts).stages.find(s => s.id === id);
const text = s => [s.summary, s.stateLabel].concat(s.points).concat([s.limit]).join(' | ');

/* ---- date and coverage primitives ------------------------------------- */

r.test('addDays crosses a month and a year boundary in UTC', () => {
  r.eq(M.addDays('2026-08-01', -1), '2026-07-31');
  r.eq(M.addDays('2026-12-31', 1), '2027-01-01');
  r.eq(M.addDays('2026-02-28', 1), '2026-03-01', '2026 is not a leap year');
});

r.test('monthsFrom lists whole months inclusively and refuses a reversed range', () => {
  r.eq(M.monthsFrom('2026-08-01', '2026-10-15'), ['2026-08', '2026-09', '2026-10']);
  r.eq(M.monthsFrom('2026-11-01', '2027-01-31'), ['2026-11', '2026-12', '2027-01']);
  r.eq(M.monthsFrom('2026-10-01', '2026-08-31'), []);
});

r.test('two identical history windows are one period of coverage, not two', () => {
  const merged = M.mergeWindows([
    { period_start: '2026-01-01', period_end: '2026-07-31' },
    { period_start: '2026-01-01', period_end: '2026-07-31' },
  ]);
  r.eq(merged, [{ start: '2026-01-01', end: '2026-07-31' }]);
});

r.test('adjacent windows merge — a clean hand-off is not a gap', () => {
  const cov = M.coverage([
    { period_start: '2026-01-01', period_end: '2026-03-31' },
    { period_start: '2026-04-01', period_end: '2026-07-31' },
  ], '2026-08-01');
  r.eq(cov.gaps, []);
  r.truthy(cov.covered, 'contiguous windows read as covered');
  r.eq([cov.from, cov.to], ['2026-01-01', '2026-07-31']);
});

r.test('an interior gap and a tail gap are both named, clipped to the hand-off', () => {
  const cov = M.coverage([
    { period_start: '2026-01-01', period_end: '2026-02-28' },
    { period_start: '2026-05-01', period_end: '2026-06-30' },
  ], '2026-08-01');
  r.eq(cov.gaps, [{ from: '2026-03-01', to: '2026-04-30' }, { from: '2026-07-01', to: '2026-07-31' }]);
  r.truthy(!cov.covered, 'a gapped archive is not covered');
});

r.test('a window reaching past the hand-off leaves no tail gap', () => {
  const cov = M.coverage([{ period_start: '2026-01-01', period_end: '2026-09-30' }], '2026-08-01');
  r.eq(cov.gaps, []);
  r.eq(cov.beyond, 1);
});

r.test('a malformed window is dropped rather than inventing coverage', () => {
  r.eq(M.mergeWindows([
    { period_start: '2026-05-01', period_end: null },
    { period_start: 'later', period_end: '2026-06-30' },
    { period_start: '2026-06-30', period_end: '2026-01-01' },
  ]), []);
});

/* ---- unknown is never done -------------------------------------------- */

r.test('every step reads Unknown, not Done, when nothing could be measured', () => {
  const model = M.assess({
    today: null, settings: U, opening: U, history: U, bank: U, sources: U,
    coding: U, batches: U, journals: U, revenue: U,
  });
  r.eq(model.stages.map(s => s.state), ['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
  r.truthy(!model.complete, 'an unmeasured company is not complete');
  r.eq(model.current.id, 'feeds', 'the first unmeasured step is where to look');
});

r.test('measured-and-absent is Not started; not-measured is Unknown', () => {
  const absent = Object.assign(LIVE(), { opening: null });
  const missing = Object.assign(LIVE(), { opening: U });
  r.eq(stage(absent, 'opening').state, 'todo');
  r.eq(stage(missing, 'opening').state, 'unknown');
  r.not(stage(missing, 'opening').stateLabel, 'Done');
});

r.test('saved history with no hand-off date is Unknown, never Done', () => {
  const s = stage(Object.assign(LIVE(), { settings: null }), 'history');
  r.eq(s.state, 'unknown');
  r.has(text(s), 'accounting start date');
});

r.test('the position never steps over an earlier Unknown to reach a later Done', () => {
  const facts = Object.assign(LIVE(), { bank: U, sources: U });
  const model = M.assess(facts);
  r.eq(model.stages.find(s => s.id === 'opening').state, 'done', 'a later step is genuinely done');
  r.eq(model.current.id, 'feeds', 'the flow still points at the unreadable one');
  r.has(model.headline, 'unknown');
  r.has(model.headline, 'Banks and cards connected', 'the headline names the step, cased as the step is');
});

/* ---- the live position ------------------------------------------------ */

r.test('the live books read as: feeds done, opening done, history flagged, coding in progress', () => {
  const model = M.assess(LIVE());
  r.eq(model.stages.map(s => s.state), ['done', 'done', 'attention', 'active', 'done']);
  r.eq(model.current.id, 'history', 'the open exceptions are the first thing outstanding');
});

r.test('history states its coverage and its 71 open exceptions without claiming completeness', () => {
  const s = stage(LIVE(), 'history');
  r.has(text(s), '2026-01-01');
  r.has(text(s), '2026-07-31');
  r.has(text(s), '71 account exceptions');
  r.has(s.limit, 'does not prove every source document was retained');
  r.not(text(s), 'complete');
  r.not(text(s), 'nothing is missing');
});

r.test('how far BACK history should reach is never graded', () => {
  const s = stage(LIVE(), 'history');
  r.has(text(s), 'How far back history should reach is your decision');
});

r.test('a covered window with no exceptions is Done', () => {
  const facts = LIVE();
  facts.history = [{ period_start: '2025-01-01', period_end: '2026-07-31', exception_count: 0, transaction_count: 10 }];
  r.eq(stage(facts, 'history').state, 'done');
});

r.test('a gap outranks exceptions in what the summary says', () => {
  const facts = LIVE();
  facts.history = [{ period_start: '2026-01-01', period_end: '2026-06-30', exception_count: 0 }];
  const s = stage(facts, 'history');
  r.eq(s.state, 'attention');
  r.has(text(s), '2026-07-01 → 2026-07-31');
  r.has(text(s), 'cannot be recovered');
});


r.test('two snapshots of one period are 71 exceptions, never 142', () => {
  const s = stage(LIVE(), 'history');
  r.has(text(s), '71 account exceptions');
  r.not(text(s), '142');
  r.has(text(s), 'overlapping ones are never added together');
  const { kept, setAside } = M.independentSnapshots(LIVE().history);
  r.eq(kept.length, 1);
  r.eq(setAside, 1);
  r.eq(kept[0].created_at, '2026-09-15T04:11:00Z', 'the newest snapshot of a window wins');
});

r.test('snapshots of genuinely different periods still add up', () => {
  const { kept, setAside } = M.independentSnapshots([
    { period_start: '2025-01-01', period_end: '2025-12-31', exception_count: 4 },
    { period_start: '2026-01-01', period_end: '2026-07-31', exception_count: 71 },
  ]);
  r.eq(kept.length, 2);
  r.eq(setAside, 0);
  r.eq(kept.reduce((n, x) => n + x.exception_count, 0), 75);
});

r.test('where windows overlap without matching, the widest snapshot is the one reported', () => {
  const { kept } = M.independentSnapshots([
    { period_start: '2026-03-01', period_end: '2026-03-31', exception_count: 9 },
    { period_start: '2026-01-01', period_end: '2026-07-31', exception_count: 71 },
  ]);
  r.eq(kept.length, 1);
  r.eq(kept[0].exception_count, 71);
});

/* ---- feeds ------------------------------------------------------------- */

r.test('card sources with no live bank feed is In progress, not Done', () => {
  const facts = LIVE();
  facts.bank = { connections: [], accounts: [] };
  const s = stage(facts, 'feeds');
  r.eq(s.state, 'active');
  r.has(text(s), 'No bank is connected for automatic sync');
});

r.test('a stopped connection or a sync error is Needs attention', () => {
  const stopped = LIVE();
  stopped.bank = { connections: [{ institution_name: 'Columbia', status: 'login_required' }], accounts: [] };
  r.eq(stage(stopped, 'feeds').state, 'attention');

  const errored = LIVE();
  errored.bank.accounts = [{ name: 'Checking', last_error_code: 'ITEM_LOGIN_REQUIRED' }];
  const s = stage(errored, 'feeds');
  r.eq(s.state, 'attention');
  r.has(text(s), 'ITEM_LOGIN_REQUIRED');
});

r.test('nothing connected at all is Not started', () => {
  const facts = LIVE();
  facts.bank = { connections: [], accounts: [] };
  facts.sources = [];
  r.eq(stage(facts, 'feeds').state, 'todo');
});

r.test('connected feeds never claim to be every account the company holds', () => {
  r.has(stage(LIVE(), 'feeds').limit, 'no way to know how many bank or card accounts the company holds');
});

/* ---- opening balances -------------------------------------------------- */

r.test('a prepared but unaccepted trial balance is In progress', () => {
  const facts = LIVE();
  facts.opening = { status: 'draft', line_count: 458 };
  const s = stage(facts, 'opening');
  r.eq(s.state, 'active');
  r.has(text(s), 'nobody has accepted it');
});

r.test('accepted balances with no start date are flagged, not Done', () => {
  const facts = LIVE();
  facts.settings = { accounting_basis: 'Accrual' };
  r.eq(stage(facts, 'opening').state, 'attention');
});

/* ---- coding ------------------------------------------------------------ */

r.test('uncoded is read from the coding source, so a split row is not reported unfinished', () => {
  // A split row carries no single account by design -- reading a null account
  // id would report every split as waiting to be coded. Only `coding_source`
  // distinguishes "coded across several accounts" from "nobody coded this".
  // Nothing uncoded, nothing open, splits in play: that is FINISHED.
  const facts = LIVE();
  facts.coding = { total: 100, uncoded: 0, rules: 10, splitRules: 3 };
  facts.batches = [{ status: 'posted', entry_date: '2026-08-31' }];
  const s = stage(facts, 'coding');
  r.eq(s.state, 'done', 'splits alone must never hold the step open');
  r.has(text(s), '3 split rules');
  r.has(text(s), 'remembers no amounts');

  const open = LIVE();
  open.coding = { total: 100, uncoded: 0, rules: 10, splitRules: 3 };
  r.eq(stage(open, 'coding').state, 'active', 'an unapproved batch does hold it open');
});

r.test('coding is Done only when nothing is uncoded and no batch is still open', () => {
  const facts = LIVE();
  facts.coding = { total: 100, uncoded: 0, rules: 10, splitRules: 0 };
  facts.batches = [{ status: 'posted', entry_date: '2026-08-31' }];
  r.eq(stage(facts, 'coding').state, 'done');
});

r.test('no transactions at all is Not started, and counts absent rather than uncoded', () => {
  const facts = LIVE();
  facts.coding = { total: 0, uncoded: 0, rules: 0, splitRules: 0 };
  const s = stage(facts, 'coding');
  r.eq(s.state, 'todo');
  r.has(s.limit, 'is not uncoded here — it is absent');
});

/* ---- revenue ----------------------------------------------------------- */

r.test('the month in progress is never graded as missing', () => {
  const facts = LIVE();           // today 2026-09-15, cutover 2026-08-01
  const s = stage(facts, 'revenue');
  r.eq(s.state, 'done', 'August is posted and September has not finished');
  r.not(text(s), 'Nothing posted for', 'the unfinished month is not counted against the company');
});

r.test('a complete month with nothing posted is named', () => {
  const facts = LIVE();
  facts.today = '2026-11-02';
  const s = stage(facts, 'revenue');
  r.eq(s.state, 'attention');
  r.has(text(s), '2026-09, 2026-10');
});

r.test('no complete month since the hand-off is Not started, not a failure', () => {
  const facts = LIVE();
  facts.today = '2026-08-14';
  const s = stage(facts, 'revenue');
  r.eq(s.state, 'todo');
  r.has(text(s), 'No month has finished since');
});

r.test('posted entries never claim every revenue source is represented', () => {
  r.has(stage(LIVE(), 'revenue').limit, 'cannot tell whether every revenue source is represented');
});

/* ---- shape ------------------------------------------------------------- */

r.test('every step carries a state word, a summary and a stated limit', () => {
  for (const facts of [LIVE(), { today: null }]) {
    for (const s of M.assess(facts).stages) {
      r.truthy(s.stateLabel && s.stateLabel.length, `${s.id} has no state word`);
      r.truthy(s.limit && s.limit.length > 30, `${s.id} states no limit`);
      r.truthy(s.points.length > 0, `${s.id} says nothing`);
      r.truthy(Object.keys(M.STATES).indexOf(s.state) !== -1, `${s.id} has state ${s.state}`);
    }
  }
});

r.test('a completed migration says so plainly', () => {
  const facts = LIVE();
  facts.history = [{ period_start: '2025-01-01', period_end: '2026-07-31', exception_count: 0 }];
  facts.coding = { total: 10, uncoded: 0, rules: 5, splitRules: 0 };
  facts.batches = [{ status: 'posted', entry_date: '2026-08-31' }];
  const model = M.assess(facts);
  r.truthy(model.complete, 'nothing outstanding');
  r.has(model.headline, 'Every step Silo can measure is complete');
  r.has(model.headline, 'can measure', 'the headline never claims more than it measured');
});

/* The panel's density rule. Figures answer a step; paragraphs elaborate. But a
   step with no figures has nothing BUT paragraphs, and on those steps the
   paragraph is the instruction for getting past them -- so collapsing by habit
   would hide "fetch a trial balance from QuickBooks" on the one screen whose
   whole job is to ask for it. */
r.test('a step with figures collapses its prose; a step with none keeps it open', () => {
  const model = M.assess(LIVE());
  const withMetrics = model.stages.find(s => s.metrics.length);
  r.truthy(withMetrics, 'the live position has at least one measured step');
  const rich = M.detailMarkup(withMetrics);
  r.has(rich, 'class="migration-more"', 'the prose is behind a disclosure');
  r.has(rich, 'What this means');
  r.truthy(rich.indexOf('migration-metrics') < rich.indexOf('migration-more'),
    'the figures stay outside the disclosure, above it');
  r.has(rich, 'migration-limit', 'the limit still ships, inside the disclosure');
  /* Inside the disclosure, not merely after it -- a limit stranded below a
     closed <details> is the step's caveat reading as though it applied to the
     figures, which is the opposite of what it says. */
  r.truthy(rich.indexOf('migration-limit') > rich.indexOf('migration-more')
    && rich.indexOf('migration-limit') < rich.indexOf('</details>'),
    'and it is inside the disclosure, not stranded below it');

  /* Nothing read at all: no figures exist to stand in for the words. */
  const blind = LIVE();
  blind.bank = U; blind.sources = U;
  const unknown = M.assess(blind).stages.find(s => s.id === 'feeds');
  r.eq(unknown.state, 'unknown');
  r.eq(unknown.metrics.length, 0, 'an unreadable step has no figures');
  const bare = M.detailMarkup(unknown);
  r.not(bare, 'migration-more', 'so its prose is not collapsed');
  r.has(bare, 'migration-limit');
});

const out = r.summary();
process.exit(out.fail ? 1 : 0);
