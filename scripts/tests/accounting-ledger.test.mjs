// Account roll-forward: opening + posted by Silo + other activity = closing.
// Pins the three-source separation, the sign convention (debits minus
// credits), the date window, and that a missing trial balance is shown as
// unknown rather than as a zero closing balance.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const window = {};
vm.runInNewContext(await readFile(new URL('../../v2/accounting-ledger.js', import.meta.url), 'utf8'), { window });
const L = window.SiloLedger;
const plain = (x) => JSON.parse(JSON.stringify(x));

const opening = {
  status: 'accepted',
  snapshot: {
    as_of: '2026-07-31',
    lines: [
      { qbo_account_id: '83', name: 'Checking', account_type: 'Bank', debit: 1000, credit: 0 },
      { qbo_account_id: '290', name: 'Prepaid', account_type: 'Other Current Asset', debit: 5000, credit: 0 },
      { qbo_account_id: '300', name: 'Equity', account_type: 'Equity', debit: 0, credit: 6100 },
      // Closed to zero after the opening date: QuickBooks omits a zero row.
      { qbo_account_id: '500', name: 'Clearing', account_type: 'Other Current Asset', debit: 100, credit: 0 },
    ],
  },
};
const line = (account, side, amount) => ({ Amount: amount, JournalEntryLineDetail: { AccountRef: { value: account }, PostingType: side } });
const posting = (id, date, lines, extra = {}) => ({ id, source: 'prepaid_amortization', status: 'posted', qbo_doc_number: 'SILO-' + id, payload: { TxnDate: date, Line: lines }, ...extra });
const tbRow = (id, name, debit, credit) => ({ ColData: [{ id, value: name }, { value: debit }, { value: credit }] });
const trialBalance = {
  Rows: { Row: [
    { Header: { ColData: [{ value: 'Assets' }] }, Rows: { Row: [tbRow('83', 'Checking', '1400.00', ''), tbRow('290', 'Prepaid', '4500.00', '')] }, Summary: { ColData: [{ value: 'Total' }, { value: '5900.00' }, { value: '' }] } },
    tbRow('300', 'Equity', '', '6000.00'),
    tbRow('163', 'Amortization expense', '500.00', ''),
    tbRow('400', 'Sales', '', '400.00'),
    // A data row with no account id is not an account.
    { ColData: [{ value: 'Unassigned' }, { value: '1.00' }, { value: '' }] },
    { type: 'Section', group: 'GrandTotal', Summary: { ColData: [{ value: 'TOTAL' }, { value: '6400.00' }, { value: '6400.00' }] } },
  ] },
};

test('the trial balance parser reads accounts, nets debit minus credit and never reads a total as an account', () => {
  const tb = L.parseTrialBalance(trialBalance);
  assert.deepEqual(plain([...tb.keys()].sort()), ['163', '290', '300', '400', '83']);
  assert.equal(tb.get('83').balance, 140000);
  assert.equal(tb.get('300').balance, -600000);
});

test('roll-forward separates opening, Silo postings and other QuickBooks activity, and each column nets to zero', () => {
  const postings = [
    posting('amort', '2026-08-31', [line('163', 'Debit', 500), line('290', 'Credit', 500)]),
    // Voided and pre-opening entries are not activity after the opening date.
    posting('void', '2026-08-31', [line('163', 'Debit', 99), line('290', 'Credit', 99)], { status: 'voided' }),
    posting('early', '2026-07-31', [line('163', 'Debit', 7), line('290', 'Credit', 7)]),
    posting('late', '2026-10-01', [line('163', 'Debit', 11), line('290', 'Credit', 11)]),
  ];
  const m = L.rollForward({ opening, postings, trialBalance: L.parseTrialBalance(trialBalance), closingDate: '2026-09-22' });
  const by = Object.fromEntries(m.rows.map((r) => [r.id, r]));
  // Prepaid: 5,000 opening - 500 posted by Silo = 4,500 closing; nothing else.
  assert.deepEqual(plain([by['290'].opening, by['290'].silo, by['290'].other, by['290'].closing]), [500000, -50000, 0, 450000]);
  // Checking moved 400 in QuickBooks that Silo never posted: that is "other".
  assert.deepEqual(plain([by['83'].opening, by['83'].silo, by['83'].other, by['83'].closing]), [100000, 0, 40000, 140000]);
  // An account that exists only in the trial balance still rolls forward from zero.
  assert.deepEqual(plain([by['400'].opening, by['400'].silo, by['400'].other]), [0, 0, -40000]);
  // Absent from the trial balance means a zero closing balance, not unknown.
  assert.deepEqual(plain([by['500'].opening, by['500'].closing, by['500'].other]), [10000, 0, -10000]);
  assert.equal(by['163'].lines.length, 1, 'only the posted, in-window entry is listed');
  assert.equal(by['163'].lines[0].doc, 'SILO-amort');
  assert.deepEqual(plain(m.totals), { opening: 0, silo: 0, closing: 0, other: 0 });
  assert.equal(m.skippedBefore, 1);
});

test('with no trial balance, closing and other activity are unknown -- never zero', () => {
  const m = L.rollForward({ opening, postings: [], trialBalance: null, closingDate: null });
  assert.ok(m.rows.every((r) => r.closing === null && r.other === null));
  assert.equal(m.totals.closing, null);
  const html = L.render(m);
  assert.match(html, /No QuickBooks trial balance after the opening date/);
  assert.ok(!/<td class="num">0\.00<\/td><\/tr>/.test(html.split('<tbody>')[1].split('</tbody>')[0].replace(/Opening[^<]*/, '')), 'no closing cell reads 0.00');
});

test('a closing date in a later fiscal year is flagged', () => {
  assert.equal(L.crossesFiscalYear('2026-07-31', '2026-12-31', 1), false);
  assert.equal(L.crossesFiscalYear('2026-07-31', '2027-01-15', 1), true);
  assert.equal(L.crossesFiscalYear('2026-07-31', '2026-10-01', 10), true);
  assert.match(L.render(L.rollForward({ opening, postings: [], trialBalance: new Map(), closingDate: '2027-02-01' }), { fiscalCrossed: true }), /later fiscal year/);
});
