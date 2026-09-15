// Synthetic QBO GeneralLedger + TrialBalance pair at any size, in the shape
// production returns (observed 2026-09-13/14 on stored Baseballism reports and
// preserved in qbo-general-ledger-nested.json): nested account sections, a
// headerless child holding a parent's own rows, a named group with no id,
// beginning balances on balance-sheet accounts only, amounts written the way
// QBO writes them (".44", "-.67", ".00", "" for a zero-value line), and a
// trial balance whose grand total ties. Every value is invented; the structure
// is not. Deterministic for a given seed so a timing run is repeatable.
//
// Exported for the database suite (scale + correctness) and for ad-hoc
// measurement: `node scripts/tests/fixtures/qbo-ledger-generator.mjs 40000`
// prints row counts and byte sizes for a report of that many data rows.

const TYPES = {
  bank: { type: 'Bank', direction: 1, sheet: true },
  ar: { type: 'Accounts Receivable', direction: 1, sheet: true },
  inventory: { type: 'Other Current Asset', direction: 1, sheet: true },
  ap: { type: 'Accounts Payable', direction: -1, sheet: true },
  card: { type: 'Credit Card', direction: -1, sheet: true },
  sales: { type: 'Income', direction: -1, sheet: false },
  cogs: { type: 'Cost of Goods Sold', direction: 1, sheet: false },
  expense: { type: 'Expense', direction: 1, sheet: false },
  // Not in the round-robin: one balancing equity account closes the books.
  equity: { type: 'Equity', direction: -1, sheet: true },
};

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** Cents -> QBO's rendering: two decimals, no leading zero below one dollar. */
export function qboMoney(cents) {
  const neg = cents < 0; const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100); const frac = String(abs % 100).padStart(2, '0');
  return (neg ? '-' : '') + (whole === 0 ? '' : String(whole)) + '.' + frac;
}

function isoDate(start, offsetDays) {
  const d = new Date(start + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/**
 * @param {object} o
 * @param {number} o.rows           total Data rows across every leaf account (>= 40)
 * @param {number} [o.accounts]     leaf accounts to spread the rows over
 * @param {string} [o.start]        window start (inclusive)
 * @param {string} [o.end]          window end (inclusive)
 * @param {number} [o.seed]
 * @param {number} [o.blankShare]   share of rows written as a blank zero-value line
 * @param {number} [o.zeroShare]    share written as an explicit ".00"
 */
export function generateLedgerPair({ rows, accounts = 60, start = '2025-08-01', end = '2026-07-31', seed = 7, blankShare = 0.001, zeroShare = 0.02 } = {}) {
  const rand = rng(seed);
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86400000);
  const kinds = Object.keys(TYPES).filter((k) => k !== 'equity');
  const chart = []; // { id, name, kind, parent?, headerlessOwnRows? }
  // Structure: a Bank parent with a headerless child (its own rows) and two
  // named subaccounts; a named "Revenue group" (no id) holding the income
  // accounts; everything else flat. The parent's own rows carry the parent id.
  chart.push({ id: 'acct-bank', name: 'Operating bank', kind: 'bank', ownRows: true });
  chart.push({ id: 'acct-bank-sub1', name: 'Payroll bank', kind: 'bank', parent: 'acct-bank' });
  chart.push({ id: 'acct-bank-sub2', name: 'Savings bank', kind: 'bank', parent: 'acct-bank' });
  for (let i = chart.length; i < accounts; i++) {
    const kind = kinds[i % kinds.length];
    chart.push({ id: `acct-${i}`, name: `${TYPES[kind].type} ${i}`, kind, group: kind === 'sales' ? 'revenue' : undefined });
  }
  chart.push({ id: 'acct-equity', name: 'Opening balance equity', kind: 'equity' });

  // Row allocation: the bank parent's own rows get 35% (one very large
  // section, the case a bounded run must resume inside), the rest spread.
  const leafIds = chart.filter((a) => a.id !== 'acct-equity').map((a) => a.id);
  const alloc = new Map(leafIds.map((id) => [id, 0]));
  const bankRows = Math.floor(rows * 0.35);
  alloc.set('acct-bank', bankRows);
  let remaining = rows - bankRows;
  const others = leafIds.filter((id) => id !== 'acct-bank');
  others.forEach((id, i) => { const n = i === others.length - 1 ? remaining : Math.floor(remaining / (others.length - i) * (0.5 + rand())); alloc.set(id, n); remaining -= n; });

  let txn = 0;
  const closing = new Map(); // id -> closing cents
  const sections = new Map(); // id -> { rows: [], beginning, total }
  for (const a of chart) {
    const n = alloc.get(a.id) || 0;
    const sheet = TYPES[a.kind].sheet;
    let balance = sheet ? Math.round((rand() * 2 - 0.5) * 5_000_000) : 0;
    const beginning = sheet ? balance : null;
    const data = [];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const r = rand();
      let amount;
      if (r < blankShare) amount = null;          // blank cell, zero-value line
      else if (r < blankShare + zeroShare) amount = 0; // explicit ".00"
      else {
        const mag = rand() < 0.15 ? Math.floor(rand() * 100) : Math.floor(rand() * 250_000); // 15% under one dollar
        amount = (rand() < 0.4 ? -1 : 1) * (mag || 1);
      }
      balance += amount || 0; total += amount || 0;
      txn += 1;
      const type = ['Journal Entry', 'Payment', 'Bill', 'Deposit', 'Expense', 'Invoice'][Math.floor(rand() * 6)];
      data.push({ type: 'Data', ColData: [
        { value: isoDate(start, Math.min(days, Math.floor(i / Math.max(1, n) * (days + 1)))) },
        { id: String(100000 + txn), value: type },
        { value: rand() < 0.7 ? `DOC-${txn}` : '' },
        { value: rand() < 0.8 ? `Counterparty ${Math.floor(rand() * 400)}` : '' },
        { value: rand() < 0.5 ? `Memo ${txn}` : '' },
        { id: `acct-${Math.floor(rand() * accounts)}`, value: 'Split account' },
        { value: amount === null ? '' : qboMoney(amount) },
        { value: qboMoney(balance) },
      ] });
    }
    closing.set(a.id, balance);
    sections.set(a.id, { rows: data, beginning, total, n });
  }
  // Balance the books through equity: sum of debit-normalised closings = 0.
  let debitNet = 0;
  for (const a of chart) if (a.id !== 'acct-equity') debitNet += closing.get(a.id) * TYPES[a.kind].direction;
  closing.set('acct-equity', debitNet); // equity direction -1 => debit net = -closing
  sections.get('acct-equity').beginning = debitNet;

  const summary = (total, close) => ({ ColData: [{ value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: total === null ? '' : qboMoney(total) }, { value: close === null ? '' : qboMoney(close) }] });
  const leaf = (a) => {
    const s = sections.get(a.id);
    const rows = [];
    if (s.beginning !== null) rows.push({ type: 'Data', ColData: [{ value: 'Beginning Balance' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: qboMoney(s.beginning) }] });
    rows.push(...s.rows);
    return { type: 'Section', Header: { ColData: [{ id: a.id, value: a.name }, ...Array(7).fill({ value: '' })] }, Rows: { Row: rows }, Summary: summary(s.n ? s.total : (s.beginning === null ? 0 : null), closing.get(a.id)) };
  };
  const glRows = [];
  // Bank parent: headerless child (own rows) + named subaccounts.
  const bank = chart[0]; const own = leaf(bank); delete own.Header;
  const subs = chart.filter((a) => a.parent === 'acct-bank').map(leaf);
  const bankTotal = sections.get('acct-bank').total + subs.reduce((t, s, i) => t + sections.get(chart.filter((a) => a.parent === 'acct-bank')[i].id).total, 0);
  glRows.push({ type: 'Section', Header: { ColData: [{ id: 'acct-bank', value: 'Operating bank' }, ...Array(7).fill({ value: '' })] }, Rows: { Row: [own, ...subs] }, Summary: summary(bankTotal, null) });
  const revenue = chart.filter((a) => a.group === 'revenue');
  for (const a of chart) if (!a.parent && a.id !== 'acct-bank' && !a.group) glRows.push(leaf(a));
  glRows.push({ type: 'Section', Header: { ColData: [{ value: 'Revenue group' }, ...Array(7).fill({ value: '' })] }, Rows: { Row: revenue.map(leaf) }, Summary: summary(revenue.reduce((t, a) => t + sections.get(a.id).total, 0), null) });

  const gl = {
    Header: { ReportName: 'GeneralLedger', StartPeriod: start, EndPeriod: end, Currency: 'USD', ReportBasis: 'Accrual' },
    Columns: { Column: ['tx_date', 'txn_type', 'doc_num', 'name', 'memo', 'split_acc', 'subt_nat_amount', 'rbal_nat_amount'].map((k) => ({ MetaData: [{ Name: 'ColKey', Value: k }] })) },
    Rows: { Row: glRows },
  };
  let debits = 0, credits = 0;
  const tbRows = chart.map((a) => {
    const net = closing.get(a.id) * TYPES[a.kind].direction; // debit-normalised
    if (net >= 0) debits += net; else credits += -net;
    return { ColData: [{ id: a.id, value: a.name }, { value: net > 0 ? qboMoney(net) : '' }, { value: net < 0 ? qboMoney(-net) : '' }] };
  });
  tbRows.push({ type: 'Section', group: 'GrandTotal', Summary: { ColData: [{ value: 'TOTAL' }, { value: qboMoney(debits) }, { value: qboMoney(credits) }] } });
  // StartPeriod is present on every TrialBalance QBO returns (verified across
  // all 16 stored runs, 2026-09-15). It matters because the trial balance is
  // PERIOD-SCOPED for income and expense accounts, so a report over a different
  // range answers a different question than the ledger it is checked against.
  const tb = { Header: { ReportName: 'TrialBalance', Currency: 'USD', StartPeriod: start, EndPeriod: end, ReportBasis: 'Accrual' },
    Columns: { Column: [{ ColType: 'Account', ColTitle: '' }, { ColType: 'Money', ColTitle: 'Debit' }, { ColType: 'Money', ColTitle: 'Credit' }] }, Rows: { Row: tbRows } };
  const accounts_ = chart.map((a) => ({ qbo_account_id: a.id, name: a.name, account_type: TYPES[a.kind].type }));
  const dataRows = [...sections.values()].reduce((t, s) => t + s.n, 0);
  const openingRows = [...sections.values()].filter((s) => s.beginning !== null).length;
  const zeroRows = [...sections.values()].reduce((t, s) => t + s.rows.filter((r) => r.ColData[6].value === '' || r.ColData[6].value === '.00').length, 0);
  const blankRows = [...sections.values()].reduce((t, s) => t + s.rows.filter((r) => r.ColData[6].value === '').length, 0);
  return { gl, tb, accounts: accounts_, expected: { dataRows, openingRows, lineRows: dataRows + openingRows, zeroRows, blankRows, leafAccounts: chart.length, debitsCents: debits } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = Number(process.argv[2] || 40000);
  const t = Date.now();
  const { gl, tb, expected } = generateLedgerPair({ rows });
  console.log(JSON.stringify({ ...expected, glBytes: JSON.stringify(gl).length, tbBytes: JSON.stringify(tb).length, ms: Date.now() - t }));
}
