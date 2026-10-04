/* /v2/on-deck-coding.js's decisions: what a coding card claims, what starts
 * selected, and what a posting response means to the person who clicked.
 *
 * Why: every figure on an On Deck card comes from the queue row, a low
 * confidence suggestion must be a choice rather than a default, and an
 * unknown posting outcome must never read as a success or as "safe to retry
 * blindly". */
'use strict';

const { createReporter } = require('../lib/assert');
const { loadV2 } = require('../lib/load');

const W = loadV2(['on-deck-coding.js']);
const C = W.SiloOnDeckCoding;
const r = createReporter('on-deck-coding');

const item = (o) => Object.assign({ batch_id: 'b', label: 'Sep', source_name: 'Card', stage: 'code', open_suggestions: 3,
  suggested_amount: 1234.5, coded_amount: 0, txn_count: 5, excluded_count: 1, uncoded_count: 3, currency: 'USD', account_mix: [] }, o);

console.log('\n── cards ──');
r.test('a code card counts suggestions and shows their amount in the batch currency', () => {
  const m = C.cardModel(item());
  r.eq(m.title, 'Code 3 transactions'); r.eq(m.figure, '$1,234.50'); r.eq(m.pill, 'Prepared'); r.eq(m.reviewable, true);
  r.eq(C.cardModel(item({ open_suggestions: 1 })).title, 'Code 1 transaction');
});
r.test('a mixed or unknown currency is never shown as dollars', () => {
  r.eq(C.cardModel(item({ currency: null })).figure, '1,234.50');
});
r.test('needs-input names the specific gap and is not reviewable', () => {
  // A card that does not send to QuickBooks is not a gap any more: its transactions are in the SILO ledger.
  const m = C.cardModel(item({ stage: 'needs_input', stage_reason: 'posting_disabled', coded_amount: 5 }));
  r.eq(m.title, 'Recorded in SILO'); r.eq(m.reviewable, false); r.eq(m.action, null);
  r.eq(C.isRecorded(item({ stage: 'needs_input', stage_reason: 'posting_disabled' })), true);
  r.eq(C.isRecorded(item({ stage: 'needs_input', stage_reason: 'uncoded_without_suggestion' })), false);
  r.eq(C.cardModel(item({ stage: 'needs_input', stage_reason: 'uncoded_without_suggestion', uncoded_count: 4 })).title, '4 transactions need a person');
  r.eq(C.cardModel(item({ stage: 'needs_input', stage_reason: 'posting_unresolved' })).title, 'Posting outcome needs checking');
});
r.test('a saved categorization is the finish line: the monthly QuickBooks entry is optional, never pending', () => {
  const ready = C.cardModel(item({ stage: 'approve', coded_amount: 35.5 }));
  r.eq(ready.figure, '$35.50'); r.eq(ready.title, 'Recorded in SILO'); r.eq(ready.reviewable, false);
  r.ok('says the QuickBooks entry is optional', /QuickBooks entry not prepared \(optional\)/.test(ready.caption));
  const done = C.cardModel(item({ stage: 'approved', coded_amount: 35.5 }));
  r.eq(done.title, 'QuickBooks entry approved'); r.eq(done.reviewable, false);
  r.ok('says it was not sent to QuickBooks', /not sent to QuickBooks/.test(done.caption));
  r.eq(C.cardModel(item({ stage: 'posted' })).reviewable, false);
  r.eq(C.REVIEWABLE.join(','), 'code');
  r.ok('every recorded stage is a receipt', ['approve', 'approved', 'posted'].every((stage) => C.isRecorded(item({ stage }))));
  r.eq(C.isRecorded(item({ stage: 'code' })), false);
});

console.log('\n── account mix ──');
r.test('top three accounts by count, the rest pooled as Other, shares summing to one', () => {
  const segs = C.mixSegments([{ account: 'A', count: 5 }, { account: 'B', count: 3 }, { account: 'C', count: 1 }, { account: 'D', count: 1 }]);
  r.eq(segs.map((s) => s.label).join(','), 'A,B,C,Other');
  r.eq(Math.round(segs.reduce((s, x) => s + x.share, 0) * 1000), 1000);
  r.eq(C.mixSegments([]).length, 0);
});

console.log('\n── selection ──');
r.test('a suggestion under 60% confidence starts unticked', () => {
  r.eq(C.defaultSelected({ confidence: 0.59 }), false);
  r.eq(C.defaultSelected({ confidence: 0.6 }), true);
  r.eq(C.defaultSelected({ confidence: null }), true);
});

console.log('\n── posting outcomes ──');
r.test('only an ok response is a success; an already-posted entry is not a failure', () => {
  r.eq(C.postOutcome(200, { ok: true }).kind, 'posted');
  r.eq(C.postOutcome(409, { error: 'This entry is already posted' }).kind, 'already');
});
r.test('unknown outcomes and transport failures say the entry is locked, never "posted"', () => {
  r.eq(C.postOutcome(502, { code: 'UNKNOWN_OUTCOME' }).kind, 'unknown');
  r.eq(C.postOutcome(0, { error: 'Failed to fetch' }).kind, 'unknown');
  r.eq(C.postOutcome(500, { code: 'LOCAL_PERSISTENCE_FAILURE' }).kind, 'unknown');
  r.ok('message names the lock', /cannot post twice/.test(C.postOutcome(502, {}).message));
});
r.test('a reapproval since review asks for a fresh review', () => {
  r.eq(C.postOutcome(409, { code: 'APPROVAL_CHANGED', error: 'x' }).kind, 'changed');
  r.eq(C.postOutcome(403, { error: 'Finance access required to post' }).kind, 'error');
});
r.test('Transactions deep links carry the batch and company, encoded', () => {
  r.eq(C.transactionsHref('a b', 'c&d'), '/v2/transactions.html?batch=a%20b&company=c%26d');
});

r.test('coded rows the ledger refused turn a recorded import into needs input; review and posted cards are left alone', () => {
  const items = [{ batch_id: 'a', stage: 'approve' }, { batch_id: 'b', stage: 'code' }, { batch_id: 'c', stage: 'posted' },
    { batch_id: 'd', stage: 'needs_input', stage_reason: 'posting_disabled' }, { batch_id: 'e', stage: 'approve' }];
  const status = ['a', 'b', 'c', 'd'].map((id) => ({ batch_id: id, unrecorded: 1, reason: 'A location is not active' }));
  const out = C.applyLedgerStatus(items, status);
  r.eq(out[0].stage_reason, 'ledger_blocked');
  r.eq(out[1].stage, 'code');
  r.eq(out[2].stage, 'posted');
  r.eq(out[3].stage_reason, 'ledger_blocked');
  r.eq(out[4].stage, 'approve');
  r.ok('a blocked import is not a receipt', !C.isRecorded(out[0]) && !C.isRecorded(out[3]));
  r.ok('the card names the reason', /not in the SILO ledger yet/.test(C.cardModel(out[0]).title) && /location is not active/.test(C.cardModel(out[0]).detail));
  r.eq(C.applyLedgerStatus(items, null).length, 5);
});

r.summary();
