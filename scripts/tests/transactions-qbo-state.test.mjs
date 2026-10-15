/* What Transactions says about QuickBooks.

   The gap these cover, from a real month: a transaction was recoded by hand in
   a July period that was still a draft, and nothing on the row said the change
   had not reached QuickBooks -- SILO sends nothing on its own, so a coded row
   is in the books only once its period is approved and then posted. The row's
   panel said "Categorized in SILO", the save said "Saved 1 row", and the
   workflow strip said "Approval required", which was equally true of a month
   waiting on its last uncoded row. Two closed months sat unposted this way.

   These run the SHIPPED inline script of v2/transactions.html against a stub
   DOM, so they fail if the wiring is removed rather than only the helpers. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const page = await readFile(new URL('../../v2/transactions.html', import.meta.url), 'utf8');
const script = page.slice(page.indexOf('<script>\n(function') + '<script>'.length);
const BOOT = '  // --------------------------------------------------------------- boot';
assert.ok(script.includes(BOOT), 'the inline script must keep its boot marker for this harness');
const body = script.slice(0, script.indexOf(BOOT));

/* The real sibling modules, not stubs: the page's filter and date rules decide
   which rows a function sees, and a stub of them would let a wrong reading pass. */
const siblings = await Promise.all(['transaction-filters', 'transaction-dates', 'card-splits']
  .map((name) => readFile(new URL(`../../v2/${name}.js`, import.meta.url), 'utf8')));

const EXPOSE = [
  'quickbooksStateLine', 'quickbooksStepDetail', 'periodLabel', 'isInQuickBooks',
  'periodClosed', 'savedCodingMessage', 'renderWorkflow', 'accountingStateLine',
  'transactionDetailInner', 'postingUnsettled', 'claimStateFor', 'loadPostingClaims',
].join(', ');

/* Enough DOM and enough of the page's siblings for the presentation functions.
   Anything a test does not set stays empty, so a function that starts reading
   something new fails loudly here rather than silently in a browser. */
function harness({ batch = null, batches = null, sources = [], dateBrowse = false, reclasses = [],
  reclassError = '', claims = {}, claimsError = '', spy = null, readError = null, readThrows = null } = {}) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, innerHTML: '', textContent: '', hidden: false, disabled: false,
      value: '', classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => null,
      querySelectorAll: () => [], addEventListener() {}, setAttribute() {}, insertAdjacentHTML() {}, append() {} });
    return nodes.get(id);
  };
  const db = {
    from(table) {
      const call = { table, eq: {}, in: {} };
      if (spy) spy.push(call);
      const q = {};
      for (const m of ['select', 'gte', 'lte', 'order', 'limit', 'range', 'maybeSingle', 'update', 'insert', 'delete']) q[m] = () => q;
      q.eq = (col, val) => { call.eq[col] = val; return q; };
      q.in = (col, vals) => { call.in[col] = vals; return q; };
      q.then = (res, rej) => (readThrows
        ? Promise.reject(new Error(readThrows))
        : Promise.resolve({ data: [], error: readError })).then(res, rej);
      return q;
    },
    rpc: () => Promise.resolve({ data: 0, error: null }), auth: { getSession: () => Promise.resolve({ data: { session: null } }) } };
  const window = {
    __SILO_CONFIG__: { SUPABASE_URL: 'https://fixture.invalid', SUPABASE_ANON_KEY: 'synthetic' },
    supabase: { createClient: () => db },
    SiloBankFeeds: { canEditBatch: (b) => !!b && ['draft', 'categorized'].includes(b.status), isAvailable: () => true,
      isBankPending: () => false, isRemovedByBank: () => false, wasPendingWhenRemoved: () => false,
      eligibleForAi: () => true, mount: () => ({}) },
    SiloCodingSuggestions: { ago: () => 'just now' },
    SiloReclass: { current: (list) => (list || []).find((r) => r.status === 'posted') || null, load: async () => new Map(), section: () => '' },
    SiloFinanceDialog: { ask: async () => false },
    SiloTransactionsTiles: { mount: () => ({}) },
    SiloChrome: { mount() {} },
    addEventListener() {}, location: { href: '', search: '' }, history: { replaceState() {} },
  };
  const document = { getElementById: node, querySelector: () => node('main'), querySelectorAll: () => [],
    createElement: () => node('created'), addEventListener() {}, body: node('body') };
  const sandbox = { window, document, console, setTimeout: () => 0, clearTimeout: () => {}, URL, URLSearchParams,
    Intl, Date, Map, Set, JSON, Number, String, Math, Object, Array, isNaN, parseFloat, parseInt, crypto: { randomUUID: () => 'id' } };
  for (const module of siblings) vm.runInNewContext(module, sandbox);
  if (!window.SiloTransactionDates?.read) window.SiloTransactionDates = { ...window.SiloTransactionDates, read: async () => [] };
  vm.runInNewContext(body + `
    _co = { id: 'co' };
    state.batch = ${JSON.stringify(batch)};
    state.batches = ${JSON.stringify(batches || (batch ? [batch] : []))};
    state.sources = ${JSON.stringify(sources)};
    dateBrowse = ${JSON.stringify(dateBrowse)};
    reclasses = new Map([['t1', ${JSON.stringify(reclasses)}]]);
    reclassError = ${JSON.stringify(reclassError)};
    postingClaims = new Map(Object.entries(${JSON.stringify(claims)}));
    postingClaimsError = ${JSON.stringify(claimsError)};
    window.subject = { ${EXPOSE} };
  })();`, sandbox);
  return { api: sandbox.window.subject, node };
}

const SOURCE = { id: 's1', source_type: 'bank', posting_enabled: true, qbo_connection_id: 'c1' };
const row = (over = {}) => ({ id: 't1', batch_id: 'b1', txn_date: '2026-07-21', amount: 250, status: 'coded',
  coding_source: 'manual', qbo_account_id: 'a1', qbo_account_name: 'Equipment Expense', origin: 'csv', ...over });
const batch = (over = {}) => ({ id: 'b1', company_entity_id: 'co', source_id: 's1', source_name: 'Baseballism Operating',
  label: '2026-07 bank feed', status: 'draft', period_start: '2026-07-01', period_end: '2026-07-31',
  txn_count: 804, uncoded_count: 0, excluded_count: 0, coded_amount: 1000, posting_status: null,
  qbo_journal_entry_id: null, qbo_doc_number: null, source_posting_enabled: true, ...over });

test('a coded row in a draft period says it is NOT in QuickBooks and names the period to approve', () => {
  const h = harness({ batch: batch(), sources: [SOURCE] });
  const line = h.api.quickbooksStateLine(row());
  assert.match(line, /^Not in QuickBooks/);
  assert.match(line, /July 2026/, 'the period must be named, not called "this period"');
  assert.match(line, /approved/);
  assert.match(line, /posted/);
});

test('a posted period says the row IS in QuickBooks and names the journal entry', () => {
  const h = harness({ batch: batch({ status: 'posted', posting_status: 'posted', qbo_doc_number: 'SILO-A98', qbo_journal_entry_id: '81573' }), sources: [SOURCE] });
  const line = h.api.quickbooksStateLine(row());
  assert.match(line, /^In QuickBooks/);
  assert.match(line, /SILO-A98/);
  assert.doesNotMatch(line, /Not in QuickBooks/);
});

test('an approved period distinguishes "frozen in SILO" from "sent to QuickBooks"', () => {
  const h = harness({ batch: batch({ status: 'approved' }), sources: [SOURCE] });
  const line = h.api.quickbooksStateLine(row());
  assert.match(line, /^Not in QuickBooks/);
  assert.match(line, /approved/);
  assert.match(line, /not been sent|not sent/);
});

test('a source with posting switched off says so instead of asking for an approval that would change nothing', () => {
  const h = harness({ batch: batch({ source_posting_enabled: false }), sources: [{ ...SOURCE, posting_enabled: false }] });
  const line = h.api.quickbooksStateLine(row());
  assert.match(line, /posting is off/i);
  assert.match(line, /Baseballism Operating/);
  assert.doesNotMatch(line, /approve/i, 'approving does not send a period whose posting is off');
});

test('an uncoded row asks for the category first, then the period', () => {
  const h = harness({ batch: batch({ uncoded_count: 1 }), sources: [SOURCE] });
  const line = h.api.quickbooksStateLine(row({ status: 'uncoded', qbo_account_id: null, qbo_account_name: null }));
  assert.match(line, /^Not in QuickBooks/);
  assert.match(line, /categoriz/i);
});

test('an excluded row never claims a QuickBooks state it cannot have', () => {
  const h = harness({ batch: batch(), sources: [SOURCE] });
  const line = h.api.quickbooksStateLine(row({ status: 'excluded' }));
  assert.match(line, /^Not in QuickBooks/);
  assert.match(line, /excluded/i);
});

test('a posted reclass reports where the amount sits now, not the period entry alone', () => {
  const h = harness({ batch: batch({ status: 'posted', posting_status: 'posted', qbo_doc_number: 'SILO-A98' }), sources: [SOURCE],
    reclasses: [{ status: 'posted', to_qbo_account_name: 'Office Supplies' }] });
  const line = h.api.quickbooksStateLine(row());
  assert.match(line, /Office Supplies/);
  assert.match(line, /reclass/i);
});

test('a posted period whose reclasses could not be read does not assert where the amount sits', () => {
  const h = harness({ batch: batch({ status: 'posted', posting_status: 'posted', qbo_doc_number: 'SILO-A98' }),
    sources: [SOURCE], reclassError: 'network' });
  const line = h.api.quickbooksStateLine(row());
  assert.match(line, /could not be read|unknown/i,
    'an unread reclass list means the posted account is not known -- it must not be stated as fact');
});

test('a row with no batch in view says nothing rather than guessing', () => {
  const h = harness({ batch: null, batches: [], sources: [SOURCE], dateBrowse: true });
  assert.equal(h.api.quickbooksStateLine(row()), '');
});

test('the period label is the month, and falls back to the import label when there is no period', () => {
  const h = harness({ batch: batch(), sources: [SOURCE] });
  assert.equal(h.api.periodLabel(batch()), 'July 2026');
  assert.equal(h.api.periodLabel(batch({ period_start: null, label: '2026-07 bank feed' })), '2026-07 bank feed');
});

test('a period counts as closed only once its last day has passed', () => {
  const h = harness({ batch: batch(), sources: [SOURCE] });
  assert.equal(h.api.periodClosed(batch()), true, 'July 2026 ended before any run of this test');
  const future = new Date(Date.now() + 86400000 * 400).toISOString().slice(0, 10);
  assert.equal(h.api.periodClosed(batch({ period_end: future })), false);
  assert.equal(h.api.periodClosed(batch({ period_end: null })), false, 'no period end is not a closed period');
});

test('the QuickBooks workflow step names the month to approve instead of a blanket "Approval required"', () => {
  const h = harness({ batch: batch(), sources: [SOURCE] });
  const detail = h.api.quickbooksStepDetail([batch()]);
  assert.match(detail, /July 2026/);
  assert.doesNotMatch(detail, /^Approval required$/);
});

test('the workflow step separates a month waiting on categorizing from one waiting on a person', () => {
  const h = harness({ batch: batch({ uncoded_count: 7 }), sources: [SOURCE] });
  assert.match(h.api.quickbooksStepDetail([batch({ uncoded_count: 7 })]), /categoriz/i);
  assert.equal(h.api.quickbooksStepDetail([batch({ status: 'posted', posting_status: 'posted' })]), 'Posted');
  assert.match(h.api.quickbooksStepDetail([batch({ status: 'approved' })]), /not sent/i);
  assert.equal(h.api.quickbooksStepDetail([]), 'No period open');
});

test('the workflow step says posting is off when the account cannot post, whatever the coding state', () => {
  const h = harness({ batch: batch({ source_posting_enabled: false }), sources: [{ ...SOURCE, posting_enabled: false }] });
  assert.match(h.api.quickbooksStepDetail([batch({ source_posting_enabled: false })]), /off for account/i);
});

test('renderWorkflow puts the QuickBooks state on the page, so the helper cannot pass while the strip is stale', () => {
  const h = harness({ batch: batch(), sources: [SOURCE] });
  h.api.renderWorkflow([row()], [batch()]);
  const html = h.node('transactionFlow').innerHTML;
  assert.match(html, /QuickBooks posting/);
  assert.match(html, /July 2026/);
});

/* The helper passing is not the feature: the panel a person actually reads has
   to carry the line. This is the wiring test, run over the real template. */
test('the transaction panel renders the QuickBooks state, labelled apart from SILO\'s own', () => {
  const h = harness({ batch: batch(), sources: [SOURCE] });
  const html = h.api.transactionDetailInner(row());
  assert.match(html, /txn-qbo-state/);
  assert.match(html, /QuickBooks<\/b>/);
  assert.match(html, /Not in QuickBooks/);
  assert.match(html, /July 2026/);
});

test('the panel keeps SILO\'s state and QuickBooks\' state as two separate statements', () => {
  const h = harness({ batch: batch(), sources: [SOURCE] });
  assert.match(h.api.accountingStateLine(row()), /Categorized in SILO/,
    'the SILO line must keep saying what SILO holds');
  assert.doesNotMatch(h.api.accountingStateLine(row()), /QuickBooks/,
    'the SILO line must not start claiming a QuickBooks state');
});

test('saving into a closed, unposted month says the change is not in QuickBooks yet', () => {
  const h = harness({ batch: batch(), sources: [SOURCE] });
  const message = h.api.savedCodingMessage(1, [row()]);
  assert.match(message, /Saved 1 row/);
  assert.match(message, /not in QuickBooks/i);
  assert.match(message, /July 2026/);
});

test('saving into the open current month does not nag about a period nobody closes yet', () => {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const open = batch({ period_start: start, period_end: end });
  const h = harness({ batch: open, sources: [SOURCE] });
  const message = h.api.savedCodingMessage(3, [row()]);
  assert.equal(message, 'Saved 3 rows.');
});

test('saving into a posted month does not claim the change is missing from QuickBooks', () => {
  const h = harness({ batch: batch({ status: 'posted', posting_status: 'posted', qbo_doc_number: 'SILO-A98' }), sources: [SOURCE] });
  assert.equal(h.api.savedCodingMessage(1, [row()]), 'Saved 1 row.');
});

test('saveCoding reports through savedCodingMessage, so the confirmation cannot drift from these tests', () => {
  const save = body.slice(body.indexOf('async function saveCoding()'));
  const end = save.indexOf('\n  const resolveSuggestedAccount');
  const saveBody = save.slice(0, end);
  assert.match(saveBody, /savedCodingMessage\(saved, dirtyRows\)/,
    'the save confirmation must come from the tested helper, over the rows actually saved');
  assert.doesNotMatch(saveBody, /setStatus\(`Saved \$\{saved\}/,
    'the old unconditional "Saved N rows." confirmation must be gone');
});

/* The shape a real interrupted post leaves behind.

   quickbooks-post-journal inserts its claim as 'submitting' BEFORE calling
   Intuit and links card_import_batches.posting_id only after a confirmed
   success, and card_import_batches_v joins the posting THROUGH that posting_id.
   So an unfinished attempt leaves the batch at 'approved' with posting_status
   null -- byte for byte the shape of a period nobody has sent. Verified on
   production: of 25 card_import claims, the 9 posted ones are linked to their
   batch and all 16 failed ones are not.

   The first version of these tests injected posting_status onto the batch, a
   shape production never produces, so they passed while the page would have
   told someone "approved but not sent yet" about an entry QuickBooks may hold.
   These use the real two-record shape instead. (Cycle-1 review, #995.) */
const TIMED_OUT = { status: 'approved', posting_id: null, posting_status: null,
  qbo_journal_entry_id: null, qbo_doc_number: null };
const claim = (over = {}) => ({ source_ref: 'b1', status: 'unknown', created_at: '2026-10-14T22:00:00Z',
  qbo_doc_number: 'SILO-7C1', qbo_journal_entry_id: null, error_message: 'network_outcome_unknown: fetch failed', ...over });

test('a post that timed out is reported as unknown, from the claim the batch never links', () => {
  for (const status of ['submitting', 'unknown']) {
    const b = batch(TIMED_OUT);
    const h = harness({ batch: b, sources: [SOURCE], claims: { b1: [claim({ status })] } });
    const line = h.api.quickbooksStateLine(row());
    assert.match(line, /^Unknown/, `${status} must not be stated either way: ${line}`);
    assert.match(line, /never confirmed/i);
    assert.match(line, /may or may not exist/i);
    assert.match(line, /cannot post twice/i, 'the reader must be told why SILO is holding it');
    assert.match(line, /SILO-7C1/, 'the doc number to search QuickBooks for travels with it');
    assert.equal(h.api.postingUnsettled(b), true);
    assert.equal(h.api.isInQuickBooks(b), false);
    assert.match(h.api.quickbooksStepDetail([b]), /unconfirmed/i);
  }
});

test('the batch alone can never show an unfinished attempt, so reading it is not enough', () => {
  // The exact regression: same batch, no claim loaded -> the old code's reading.
  const b = batch(TIMED_OUT);
  const blind = harness({ batch: b, sources: [SOURCE] });
  assert.match(blind.api.quickbooksStateLine(row()), /has not been sent yet/,
    'with no claim this is genuinely an approved, unsent period');
  const seeing = harness({ batch: b, sources: [SOURCE], claims: { b1: [claim()] } });
  assert.match(seeing.api.quickbooksStateLine(row()), /^Unknown/,
    'the same batch plus its claim must read as unknown, not as unsent');
});

test('an unfinished attempt outranks the posting switch, which resolves nothing already sent', () => {
  const b = batch({ ...TIMED_OUT, source_posting_enabled: false });
  const h = harness({ batch: b, sources: [{ ...SOURCE, posting_enabled: false }], claims: { b1: [claim()] } });
  const line = h.api.quickbooksStateLine(row());
  assert.match(line, /^Unknown/, 'turning posting off does not resolve an attempt already sent');
  assert.doesNotMatch(line, /posting is off/i);
  assert.match(h.api.quickbooksStepDetail([b]), /unconfirmed/i);
});

test('an unresolved attempt outranks a later refusal, which settles nothing about the lost one', () => {
  const b = batch(TIMED_OUT);
  const h = harness({ batch: b, sources: [SOURCE],
    claims: { b1: [claim({ status: 'failed', created_at: '2026-10-14T23:00:00Z' }), claim()] } });
  assert.equal(h.api.claimStateFor(b).kind, 'unresolved');
  assert.match(h.api.quickbooksStateLine(row()), /^Unknown/);
});

test('a lookup that failed is kept apart from knowing there is no attempt', () => {
  const b = batch(TIMED_OUT);
  const h = harness({ batch: b, sources: [SOURCE], claimsError: 'network error' });
  assert.equal(h.api.claimStateFor(b).kind, 'unreadable');
  const line = h.api.quickbooksStateLine(row());
  assert.match(line, /^Unknown/, 'not knowing must not be reported as not sent');
  assert.match(line, /could not be read/i);
  assert.match(line, /network error/);
  assert.match(h.api.quickbooksStepDetail([b]), /could not be read/i);
  assert.equal(h.api.savedCodingMessage(1, [row()]), 'Saved 1 row.',
    'a period whose attempts could not be read must not be named as merely needing approval');
});

test('a failed claim read is recorded, not swallowed, so the page knows it does not know', async () => {
  const h = harness({ batch: batch(TIMED_OUT), sources: [SOURCE],
    claims: { b1: [claim()] }, readError: { message: 'JWT expired' } });
  await h.api.loadPostingClaims();
  // The stale map from before the failed read must not be reused as fact.
  assert.equal(h.api.claimStateFor(batch(TIMED_OUT))?.kind, 'unreadable');
  assert.match(h.api.quickbooksStateLine(row()), /could not be read/i);
  assert.match(h.api.quickbooksStateLine(row()), /JWT expired/);
});

test('a thrown read degrades to the same recorded error, rather than taking the register down', async () => {
  const h = harness({ batch: batch(TIMED_OUT), sources: [SOURCE], claims: { b1: [claim()] }, readThrows: 'offline' });
  await assert.doesNotReject(() => h.api.loadPostingClaims(),
    'the page must still open when the claim read fails outright');
  assert.equal(h.api.claimStateFor(batch(TIMED_OUT))?.kind, 'unreadable');
  assert.match(h.api.quickbooksStateLine(row()), /offline/);
});

test('a refused post says QuickBooks refused it, not that a human forgot to approve', () => {
  const b = batch(TIMED_OUT);
  const h = harness({ batch: b, sources: [SOURCE], claims: { b1: [claim({ status: 'failed' })] } });
  const line = h.api.quickbooksStateLine(row());
  assert.match(line, /^Not in QuickBooks/);
  assert.match(line, /refused/i);
  assert.doesNotMatch(line, /has not been sent yet/, 'it was sent -- it came back refused');
  assert.match(h.api.quickbooksStepDetail([b]), /refused/i);
});

test('the claim read asks for the correlation on_deck_coding_items uses, and keeps a failure apart', async () => {
  const seen = [];
  const h = harness({ batch: batch(TIMED_OUT), sources: [SOURCE], spy: seen });
  await h.api.loadPostingClaims();
  const call = seen.find((c) => c.table === 'quickbooks_journal_postings');
  assert.ok(call, 'the postings table must be read on its own; the batch view cannot show this');
  assert.equal(call.eq.source, 'card_import');
  assert.ok(call.eq.company_entity_id, 'the read must be company-scoped');
  assert.deepEqual([...call.in.source_ref], ['b1'], 'correlated by source_ref = the batch id');
  assert.deepEqual([...call.in.status], ['submitting', 'unknown', 'failed'],
    'the three statuses that never reach the batch view');
});

test('a voided posting leaves the period reading as not posted', () => {
  // void_card_posting sets posting_id = null and the batch back to approved, so
  // the view carries no posting_status and no journal entry id.
  const b = batch({ status: 'approved', posting_id: null, posting_status: null, qbo_journal_entry_id: null, qbo_doc_number: null });
  const h = harness({ batch: b, sources: [SOURCE] });
  assert.equal(h.api.isInQuickBooks(b), false);
  assert.match(h.api.quickbooksStateLine(row()), /^Not in QuickBooks/);
});

test('a save never claims a period is waiting on approval when that is not what it waits on', () => {
  const cases = [
    { b: batch({ status: 'approved' }), claims: {}, why: 'approved, nothing sent' },
    { b: batch({ status: 'posted', posting_status: 'posted' }), claims: {}, why: 'already posted' },
    { b: batch(TIMED_OUT), claims: { b1: [claim()] }, why: 'an attempt is unresolved' },
    { b: batch(), claims: { b1: [claim({ status: 'failed' })] }, why: 'the last attempt was refused' },
  ];
  for (const { b, claims, why } of cases) {
    const h = harness({ batch: b, sources: [SOURCE], claims });
    assert.equal(h.api.savedCodingMessage(1, [row()]), 'Saved 1 row.',
      `a period must not be reduced to "needs approval" when ${why}`);
  }
  // The one case that SHOULD be named: a closed draft with no attempt at all.
  const plain = harness({ batch: batch(), sources: [SOURCE] });
  assert.match(plain.api.savedCodingMessage(1, [row()]), /July 2026/);
});

/* Three findings from reviewing the wired path, each with its own check. */
test('the workflow tick and its text agree: an unconfirmed post is not a completed step', () => {
  const b = batch(TIMED_OUT);
  const h = harness({ batch: b, sources: [SOURCE], claims: { b1: [claim()] } });
  h.api.renderWorkflow([row()], [b]);
  const html = h.node('transactionFlow').innerHTML;
  assert.match(html, /unconfirmed/i);
  const step = html.slice(html.indexOf('QuickBooks posting') - 120);
  assert.doesNotMatch(step.slice(0, 160), /is-done/,
    'a journal entry id on an unconfirmed post must not tick the QuickBooks step');
});

test('a period is closed by the reader\'s own day, not by UTC', () => {
  const h = harness({ batch: batch(), sources: [SOURCE] });
  const localToday = new Date().toLocaleDateString('en-CA');
  assert.equal(h.api.periodClosed(batch({ period_end: localToday })), false,
    'the day a period ends is not past; in Pacific, UTC is already tomorrow for part of it');
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA');
  assert.equal(h.api.periodClosed(batch({ period_end: yesterday })), true);
  /* This runner's clock is UTC, where the two readings agree, so the behaviour
     above cannot tell them apart. The skew is real west of UTC: at 23:30 on
     2026-10-31 in Pacific, toISOString() already says 2026-11-01 and would
     call October closed while the people closing it are still in it. Pin the
     reading itself, since the behavioural check cannot. */
  const source = body.slice(body.indexOf('const periodClosed ='));
  const fn = source.slice(0, source.indexOf('};') + 2);
  assert.doesNotMatch(fn, /toISOString/, 'periodClosed must not compare against a UTC date');
  assert.match(fn, /toLocaleDateString\('en-CA'\)/);
});

test('an unresolved source list cannot make a postable account look switched off', () => {
  // state.sources empty: batchSource() is undefined while the page is loading.
  const h = harness({ batch: batch(), sources: [] });
  const detail = h.api.quickbooksStepDetail([batch()]);
  assert.doesNotMatch(detail, /off for account/i);
  assert.match(detail, /July 2026/);
  const off = harness({ batch: batch({ source_posting_enabled: false }), sources: [] });
  assert.match(off.api.quickbooksStepDetail([batch({ source_posting_enabled: false })]), /off for account/i);
});

test('every QuickBooks line carries exactly one of the three states', () => {
  const states = [
    batch(), batch({ status: 'categorized' }), batch({ status: 'approved' }),
    batch({ status: 'posted', posting_status: 'posted', qbo_doc_number: 'X' }),
    batch({ source_posting_enabled: false }), batch({ uncoded_count: 3 }),
  ];
  // The unfinished and refused attempts live in the claim, never on the batch,
  // so the sweep carries them as the second record rather than a batch field.
  const claimSets = [{}, { b1: [claim({ status: 'submitting' })] }, { b1: [claim()] },
    { b1: [claim({ status: 'failed' })] }];
  for (const b of states) for (const claims of claimSets) {
    const h = harness({ batch: b, sources: [SOURCE], claims });
    for (const t of [row(), row({ status: 'uncoded', qbo_account_id: null }), row({ status: 'excluded' })]) {
      const line = h.api.quickbooksStateLine(t);
      assert.ok(line, 'a row in a batch in view always has a QuickBooks state');
      const hit = [/^In QuickBooks/, /^Not in QuickBooks/, /^Unknown/].filter((re) => re.test(line));
      assert.equal(hit.length, 1, `exactly one status per row, got: ${line}`);
    }
  }
});
