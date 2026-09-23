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

// ---- mount(): the real read path, against a mock that honours eq/gte
// filters, ordering, ranges, limits and a server-side row cap -------------
function fakeDb(data, { cap = Infinity } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const q = { table, eq: [], gte: [], order: null, range: null, limit: null };
      calls.push(q);
      const api = {
        select() { return api; },
        eq(c, v) { q.eq.push([c, v]); return api; },
        gte(c, v) { q.gte.push([c, v]); return api; },
        order(c) { q.order = q.order || c; return api; },
        range(a, b) { q.range = [a, b]; return api; },
        limit(n) { q.limit = n; return api; },
        then(res, rej) {
          let rows = (data[table] || []).filter((r) => q.eq.every(([c, v]) => r[c] === v) && q.gte.every(([c, v]) => String(r[c]) >= String(v)));
          if (q.order) rows = rows.slice().sort((a, b) => String(a[q.order]).localeCompare(String(b[q.order])));
          if (q.range) rows = rows.slice(q.range[0], Math.min(q.range[1] + 1, q.range[0] + cap));
          if (q.limit) rows = rows.slice(0, q.limit);
          return Promise.resolve({ data: rows, error: null }).then(res, rej);
        },
      };
      return api;
    },
  };
}
function fakeEls() {
  const m = new Map();
  return (id) => {
    if (!m.has(id)) m.set(id, { innerHTML: '', textContent: '', value: '', hidden: false, checked: false, addEventListener() {} });
    return m.get(id);
  };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const acc = { ...opening, snapshot: { ...opening.snapshot, basis: 'Accrual', currency: 'USD' } };
const header = (basis = 'Accrual', extra = {}) => ({ ReportName: 'TrialBalance', ReportBasis: basis, Currency: 'USD', EndPeriod: '2026-09-22', ...extra });
const cols = { Column: [{ ColType: 'Account', ColTitle: '' }, { ColType: 'Money', ColTitle: 'Debit' }, { ColType: 'Money', ColTitle: 'Credit' }] };
const run = (id, extra = {}) => ({ id, company_entity_id: 'co', connection_id: 'A', report_name: 'TrialBalance', status: 'ok', end_date: '2026-09-22', fetched_at: '2026-09-23', params: { start_date: '2026-01-01', end_date: '2026-09-22', accounting_method: 'Accrual' }, raw_response: { Header: header(), Columns: cols, ...trialBalance }, ...extra });
const stored = (id, date, lines, extra = {}) => ({ ...posting(id, date, lines), company_entity_id: 'co', connection_id: 'A', ...extra });
async function mountWith(data, options = {}) {
  const el = fakeEls();
  const db = fakeDb(data, options);
  await L.mount({ db, companyId: 'co', opening: acc, settings: { qbo_connection_id: 'A', fiscal_year_start_month: 1, accounting_basis: 'Accrual' }, businessToday: '2026-09-23', el });
  await settle();
  return { el, db };
}

test('posted activity is read for the books’ own QuickBooks connection only', async () => {
  const { el, db } = await mountWith({
    quickbooks_journal_postings: [
      stored('a1', '2026-08-31', [line('163', 'Debit', 500), line('290', 'Credit', 500)]),
      // Connection B, colliding account id 83: must not reach connection A's books.
      stored('b1', '2026-08-31', [line('83', 'Debit', 10), line('300', 'Credit', 10)], { connection_id: 'B' }),
    ],
    quickbooks_report_runs: [run('tb-a')],
  });
  const html = el('ledgerTable').innerHTML;
  assert.match(html, /data-ledger-account="290"/);
  assert.ok(!/data-ledger-account="83"/.test(html), 'a connection-B journal must not appear as Silo activity');
  assert.ok(db.calls.filter((c) => c.table === 'quickbooks_journal_postings').every((c) => c.eq.some(([k, v]) => k === 'connection_id' && v === 'A')));
});

test('a closing report on a different basis is never compared with the opening balances', async () => {
  // A newer Cash report beside an older Accrual one: only the Accrual one is offered.
  let r = await mountWith({ quickbooks_journal_postings: [], quickbooks_report_runs: [
    run('tb-cash', { fetched_at: '2026-09-24', params: { start_date: '2026-01-01', end_date: '2026-09-22', accounting_method: 'Cash' }, raw_response: { Header: header('Cash'), Columns: cols, ...trialBalance } }),
    run('tb-accrual'),
  ] });
  assert.match(r.el('ledgerRun').innerHTML, /tb-accrual/);
  assert.ok(!/tb-cash/.test(r.el('ledgerRun').innerHTML));
  // Only a Cash report: nothing is compared, and the page says why.
  r = await mountWith({ quickbooks_journal_postings: [], quickbooks_report_runs: [
    run('tb-cash', { params: { accounting_method: 'Cash' }, raw_response: { Header: header('Cash'), Columns: cols, ...trialBalance } }),
  ] });
  assert.match(r.el('ledgerTable').innerHTML, /1 saved trial balance was left out because it does not match the opening balances&#39; Accrual basis/);
  assert.ok(!/1,400\.00/.test(r.el('ledgerTable').innerHTML), 'no closing balance from an incompatible report');
  // Params claim Accrual but the report header says Cash: the header wins.
  r = await mountWith({ quickbooks_journal_postings: [], quickbooks_report_runs: [
    run('tb-lying', { raw_response: { Header: header('Cash'), Columns: cols, ...trialBalance } }),
  ] });
  assert.match(r.el('ledgerTable').innerHTML, /cannot be compared with the opening balances \(Cash basis, opening balances are Accrual\)/);
  assert.ok(!/1,400\.00/.test(r.el('ledgerTable').innerHTML));
});

test('compatibility rules mirror how the opening balances were seeded', () => {
  const snap = acc.snapshot;
  assert.equal(L.paramsIncompatibility({ accounting_method: 'Accrual', start_date: 'x', end_date: 'y' }, snap), null);
  assert.match(L.paramsIncompatibility({ accounting_method: 'Accrual', account: '83' }, snap), /filtered/);
  assert.match(L.paramsIncompatibility({ accounting_method: 'Cash' }, snap), /Cash basis/);
  const raw = { Header: header(), Columns: cols };
  assert.equal(L.closingIncompatibility(raw, { endDate: '2026-09-22' }, snap), null);
  assert.match(L.closingIncompatibility({ ...raw, Header: header('Accrual', { Currency: 'CAD' }) }, { endDate: '2026-09-22' }, snap), /CAD currency/);
  assert.match(L.closingIncompatibility({ ...raw, Header: header('Accrual', { EndPeriod: '2026-09-01' }) }, { endDate: '2026-09-22' }, snap), /period/);
  assert.match(L.closingIncompatibility({ ...raw, Columns: { Column: [cols.Column[0], { ColTitle: 'Jan 2026' }] } }, { endDate: '2026-09-22' }, snap), /Debit\/Credit/);
});

test('every posted journal is read, past any page size or server row cap', async () => {
  const early = Array.from({ length: 5000 }, (_, i) => stored('p' + String(i).padStart(5, '0'), '2026-07-15', [line('163', 'Debit', 1), line('290', 'Credit', 1)]));
  // Sorts after every pre-opening row, so it sits well past the first page.
  const late = stored('z-late', '2026-08-31', [line('83', 'Debit', 10), line('300', 'Credit', 10)]);
  const { el } = await mountWith({ quickbooks_journal_postings: [...early, late], quickbooks_report_runs: [run('tb-a')] }, { cap: 700 });
  assert.match(el('ledgerTable').innerHTML, /data-ledger-account="83"/, 'the in-period journal beyond the first page is counted');
  assert.match(el('ledgerTable').innerHTML, /5000 posted entries are dated on or before the opening date/);
});
