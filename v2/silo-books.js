/* SILO books: the statements built from SILO's own ledger.
 *
 * Shared by /v2/silo-books.html and its tests. Two halves:
 *
 *   1. the SQL each statement runs through chat_run_readonly_query (the shared
 *      report engine: SECURITY INVOKER, SELECT-only, 1000-row pages), and
 *   2. pure functions that turn those rows into a statement.
 *
 * Everything reads silo_books_ledger_v: for a month SILO has read back from
 * QuickBooks the lines are QuickBooks' own, every other day is SILO's ledger.
 * Opening positions come from the earliest imported period, because a ledger
 * of activity alone cannot say where a balance started.
 *
 * Nothing here names a company or an account. Sections are QuickBooks' own
 * account types.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SiloBooks = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Debit-natural types are shown as their debit balance; the rest as their
  // credit balance, which is how a statement reads.
  const SECTIONS = Object.freeze({
    income: ['Income'],
    cogs: ['Cost of Goods Sold'],
    expense: ['Expense'],
    otherIncome: ['Other Income'],
    otherExpense: ['Other Expense'],
    asset: ['Bank', 'Accounts Receivable', 'Other Current Asset', 'Fixed Asset', 'Other Asset'],
    liability: ['Accounts Payable', 'Credit Card', 'Other Current Liability', 'Long Term Liability', 'Other Liability'],
    equity: ['Equity'],
  });
  const PL_TYPES = [...SECTIONS.income, ...SECTIONS.cogs, ...SECTIONS.expense,
    ...SECTIONS.otherIncome, ...SECTIONS.otherExpense];
  const BS_TYPES = [...SECTIONS.asset, ...SECTIONS.liability, ...SECTIONS.equity];
  const DEBIT_NATURAL = [...SECTIONS.asset, ...SECTIONS.cogs, ...SECTIONS.expense, ...SECTIONS.otherExpense];

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;

  // The engine takes one text argument, so values are checked, never trusted:
  // a company id must be a uuid, a date must be a real calendar date, and an
  // account id is quote-doubled after refusing anything that is not an id.
  function uuid(v) {
    if (!UUID.test(String(v || ''))) throw new Error('Not a company id');
    return `'${String(v).toLowerCase()}'::uuid`;
  }
  function date(v) {
    const s = String(v || '');
    const d = DATE.test(s) ? new Date(`${s}T00:00:00Z`) : null;
    if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new Error('Pick a valid date');
    return `'${s}'::date`;
  }
  function accountId(v) {
    const s = String(v ?? '');
    if (!s || s.length > 64 || /[^A-Za-z0-9_.:-]/.test(s)) throw new Error('Not an account id');
    return `'${s.replace(/'/g, "''")}'`;
  }
  const list = (types) => types.map((t) => `'${t}'`).join(', ');

  /** First day of the fiscal year that contains `to`. */
  function fiscalYearStart(to, startMonth) {
    if (!DATE.test(String(to || ''))) throw new Error('Pick a valid date');
    const m = Number.isInteger(startMonth) && startMonth >= 1 && startMonth <= 12 ? startMonth : 1;
    const year = Number(to.slice(0, 4));
    const month = Number(to.slice(5, 7));
    const y = month >= m ? year : year - 1;
    return `${y}-${String(m).padStart(2, '0')}-01`;
  }

  /** Activity by account for a period: the Profit & Loss and the account list. */
  function activitySql({ companyId, from, to, byMonth, types }) {
    const month = byMonth ? ", to_char(entry_date, 'YYYY-MM') as month" : '';
    const typeFilter = types ? ` and account_type in (${list(types)})` : '';
    return 'select qbo_account_id as account_id, max(qbo_account_name) as account_name, account_type'
      + `${month}, round(sum(signed_amount), 2) as amount, count(*) as line_count`
      + ' from public.silo_books_ledger_v'
      + ` where company_entity_id = ${uuid(companyId)}`
      + ` and entry_date between ${date(from)} and ${date(to)}`
      + ' and signed_amount is not null'
      + typeFilter
      + ` group by qbo_account_id, account_type${byMonth ? ", to_char(entry_date, 'YYYY-MM')" : ''}`
      + ` order by account_type, account_name, account_id${byMonth ? ', month' : ''}`;
  }

  /** Where every account stands on a date: opening position + all activity
   *  through it, and the part of that activity inside the fiscal year. */
  function positionsSql({ companyId, to, fiscalStart }) {
    const co = uuid(companyId);
    const asOf = date(to);
    const fy = date(fiscalStart);
    return 'with opening as ('
      + ' select h.qbo_account_id as account_id, max(h.account_name) as account_name, h.account_type,'
      + `  sum(case when h.account_type in (${list(DEBIT_NATURAL)}) then h.natural_balance`
      + `           when h.account_type in (${list([...SECTIONS.liability, ...SECTIONS.equity, ...SECTIONS.income, ...SECTIONS.otherIncome])}) then -h.natural_balance end) as amount`
      + ' from public.qbo_history_lines h'
      + ' join public.qbo_history_imports i on i.id = h.import_id and i.company_entity_id = h.company_entity_id'
      + ` where h.company_entity_id = ${co} and h.row_kind = 'opening'`
      + `  and i.period_start <= ${asOf}`
      // The earliest imported period of each QuickBooks connection is where the
      // books start; the newest import of that period wins a tie.
      + '  and not exists (select 1 from public.qbo_history_imports o'
      + '   where o.company_entity_id = i.company_entity_id and o.qbo_connection_id = i.qbo_connection_id'
      + '    and (o.period_start < i.period_start'
      + '     or (o.period_start = i.period_start and (o.created_at, o.id) > (i.created_at, i.id))))'
      + ' group by h.qbo_account_id, h.account_type'
      + '), activity as ('
      + ' select qbo_account_id as account_id, max(qbo_account_name) as account_name, account_type,'
      + '  sum(signed_amount) as amount,'
      + `  sum(signed_amount) filter (where entry_date >= ${fy}) as fiscal_amount`
      + ' from public.silo_books_ledger_v'
      + ` where company_entity_id = ${co} and entry_date <= ${asOf} and signed_amount is not null`
      + ' group by qbo_account_id, account_type'
      + ')'
      + ' select coalesce(a.account_id, o.account_id) as account_id,'
      + '  coalesce(a.account_name, o.account_name) as account_name,'
      + '  coalesce(a.account_type, o.account_type) as account_type,'
      + '  round(coalesce(o.amount, 0), 2) as opening,'
      + '  round(coalesce(a.amount, 0), 2) as activity,'
      + '  round(coalesce(a.fiscal_amount, 0), 2) as fiscal_activity'
      + ' from activity a full join opening o'
      + '  on o.account_id = a.account_id and o.account_type is not distinct from a.account_type'
      + ' order by 3, 2, 1';
  }

  /** One account's lines for a period, newest page size the engine allows. */
  function accountLinesSql({ companyId, account, from, to }) {
    return 'select entry_date, transaction_type, document_number, counterparty, memo, description,'
      + ' signed_amount, source'
      + ' from public.silo_books_ledger_v'
      + ` where company_entity_id = ${uuid(companyId)} and qbo_account_id = ${accountId(account)}`
      + ` and entry_date between ${date(from)} and ${date(to)}`
      + ' order by entry_date, transaction_ref, document_number, signed_amount';
  }

  /** How far SILO has read QuickBooks back, for the quiet line under a title. */
  function freshnessSql({ companyId }) {
    return 'select min(period_start) as read_from, max(read_through) as read_through,'
      + ' count(*) filter (where last_error is not null) as months_with_a_problem'
      + ' from public.quickbooks_ledger_mirror_periods'
      + ` where company_entity_id = ${uuid(companyId)} and read_at is not null`;
  }

  /** Lines the ledger cannot place on a side (an account type QuickBooks' map
   *  does not know). A statement that silently left them out would be wrong. */
  function unplacedSql({ companyId, to }) {
    return 'select count(*) as line_count from public.silo_books_ledger_v'
      + ` where company_entity_id = ${uuid(companyId)} and entry_date <= ${date(to)}`
      + ' and signed_amount is null';
  }

  // ── statements ───────────────────────────────────────────────────────────

  const cents = (n) => Math.round((Number(n) || 0) * 100);
  const money = (c) => c / 100;
  const inSection = (key, type) => SECTIONS[key].includes(type);

  function monthsBetween(from, to) {
    const out = [];
    let y = Number(from.slice(0, 4));
    let m = Number(from.slice(5, 7));
    const end = to.slice(0, 7);
    for (let i = 0; i < 600; i += 1) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      if (key > end) break;
      out.push(key);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return out;
  }

  /** Profit & Loss. `rows` are activitySql rows; `columns` is the list of
   *  months when broken out, else null. Every value is in cents until the end. */
  function profitAndLoss(rows, columns) {
    const keys = columns && columns.length ? columns : ['total'];
    const blank = () => keys.map(() => 0);
    const accounts = new Map();
    for (const r of rows || []) {
      if (!PL_TYPES.includes(r.account_type)) continue;
      const id = `${r.account_type}|${r.account_id}`;
      if (!accounts.has(id)) {
        accounts.set(id, { id: r.account_id, name: r.account_name || r.account_id, type: r.account_type, values: blank() });
      }
      const idx = columns && columns.length ? keys.indexOf(r.month) : 0;
      if (idx < 0) continue;
      // Income reads as a credit balance, costs as a debit balance.
      const sign = DEBIT_NATURAL.includes(r.account_type) ? 1 : -1;
      accounts.get(id).values[idx] += sign * cents(r.amount);
    }
    const all = [...accounts.values()].sort((a, b) => a.name.localeCompare(b.name));
    const out = [];
    const add = (a, b, sign = 1) => a.map((v, i) => v + sign * b[i]);
    const section = (key, label) => {
      const members = all.filter((a) => inSection(key, a.type));
      const total = members.reduce((t, a) => add(t, a.values), blank());
      if (members.length) {
        out.push({ kind: 'header', label });
        for (const a of members) out.push({ kind: 'account', label: a.name, accountId: a.id, values: a.values });
        out.push({ kind: 'total', label: `Total ${label}`, values: total });
      }
      return total;
    };
    const income = section('income', 'Income');
    const cogs = section('cogs', 'Cost of Goods Sold');
    const gross = add(income, cogs, -1);
    out.push({ kind: 'total', label: 'Gross Profit', values: gross });
    const expense = section('expense', 'Expenses');
    const operating = add(gross, expense, -1);
    out.push({ kind: 'total', label: 'Net Operating Income', values: operating });
    const otherIncome = section('otherIncome', 'Other Income');
    const otherExpense = section('otherExpense', 'Other Expenses');
    const net = add(add(operating, otherIncome), otherExpense, -1);
    out.push({ kind: 'total', label: 'Net Income', values: net });
    return finish(out, keys, columns && columns.length > 1);
  }

  // A by-month statement carries a Total column; the cents become dollars last.
  function finish(lines, keys, withTotal) {
    const columns = withTotal ? [...keys, 'Total'] : keys;
    return {
      columns,
      lines: lines.map((l) => {
        if (!l.values) return l;
        const values = withTotal ? [...l.values, l.values.reduce((t, v) => t + v, 0)] : l.values;
        return { ...l, values: values.map(money) };
      }),
    };
  }

  function positions(rows) {
    const list2 = [];
    let priorEarnings = 0;   // credit-positive: profit of earlier fiscal years
    let netIncome = 0;       // credit-positive: profit of this fiscal year
    for (const r of rows || []) {
      const total = cents(r.opening) + cents(r.activity);
      const fiscal = cents(r.fiscal_activity);
      if (PL_TYPES.includes(r.account_type)) {
        netIncome -= fiscal;
        priorEarnings -= (total - fiscal);
        list2.push({ id: r.account_id, name: r.account_name || r.account_id, type: r.account_type, debit: fiscal, pl: true });
      } else if (BS_TYPES.includes(r.account_type)) {
        list2.push({ id: r.account_id, name: r.account_name || r.account_id, type: r.account_type, debit: total, pl: false });
      }
    }
    list2.sort((a, b) => a.name.localeCompare(b.name));
    return { accounts: list2, priorEarnings, netIncome };
  }

  /** Balance Sheet on a date. */
  function balanceSheet(rows) {
    const { accounts, priorEarnings, netIncome } = positions(rows);
    const out = [];
    const group = (types, label, sign) => {
      let total = 0;
      const members = accounts.filter((a) => !a.pl && types.includes(a.type) && a.debit !== 0);
      if (members.length) out.push({ kind: 'header', label });
      for (const a of members) {
        total += sign * a.debit;
        out.push({ kind: 'account', label: a.name, accountId: a.id, values: [sign * a.debit] });
      }
      return total;
    };
    const assets = group(SECTIONS.asset, 'Assets', 1);
    out.push({ kind: 'total', label: 'Total Assets', values: [assets] });
    const liabilities = group(SECTIONS.liability, 'Liabilities', -1);
    out.push({ kind: 'total', label: 'Total Liabilities', values: [liabilities] });
    let equity = group(SECTIONS.equity, 'Equity', -1);
    if (!out.some((l) => l.kind === 'header' && l.label === 'Equity')) out.push({ kind: 'header', label: 'Equity' });
    out.push({ kind: 'account', label: 'Earnings from earlier years', values: [priorEarnings] });
    out.push({ kind: 'account', label: 'Net income this year', values: [netIncome] });
    equity += priorEarnings + netIncome;
    out.push({ kind: 'total', label: 'Total Equity', values: [equity] });
    out.push({ kind: 'total', label: 'Total Liabilities and Equity', values: [liabilities + equity] });
    const done = finish(out, ['total'], false);
    // Assets must equal liabilities plus equity. When they do not, the page
    // says so instead of printing a statement that does not balance.
    done.outOfBalance = money(assets - liabilities - equity);
    return done;
  }

  /** Trial Balance on a date: every account on its debit or credit side. */
  function trialBalance(rows) {
    const { accounts, priorEarnings } = positions(rows);
    const out = [];
    let debit = 0;
    let credit = 0;
    const push = (label, amount, accountId2) => {
      if (amount === 0) return;
      const d = amount > 0 ? amount : 0;
      const c = amount < 0 ? -amount : 0;
      debit += d; credit += c;
      out.push({ kind: 'account', label, accountId: accountId2, values: [d, c] });
    };
    for (const a of accounts) push(a.name, a.debit, a.id);
    push('Earnings from earlier years', -priorEarnings, undefined);
    out.push({ kind: 'total', label: 'Total', values: [debit, credit] });
    const done = finish(out, ['Debit', 'Credit'], false);
    done.outOfBalance = money(debit - credit);
    return done;
  }

  /** Activity by account, every type, for the General Ledger tile. */
  function accountActivity(rows) {
    const out = [];
    let debit = 0;
    let credit = 0;
    const sorted = [...(rows || [])].sort((a, b) =>
      String(a.account_name || '').localeCompare(String(b.account_name || '')));
    for (const r of sorted) {
      const c = cents(r.amount);
      const d = c > 0 ? c : 0;
      const k = c < 0 ? -c : 0;
      debit += d; credit += k;
      out.push({ kind: 'account', label: r.account_name || r.account_id, accountId: r.account_id,
        note: r.account_type, values: [d, k] });
    }
    out.push({ kind: 'total', label: 'Total', values: [debit, credit] });
    return finish(out, ['Debit', 'Credit'], false);
  }

  // What a reader is told about where a line came from. SILO's own entries and
  // the imported history say nothing: only a difference is worth a word.
  const SOURCE_LABEL = Object.freeze({
    quickbooks: 'QuickBooks',
    quickbooks_edited: 'Edited in QuickBooks',
  });

  return {
    SECTIONS, PL_TYPES, BS_TYPES, SOURCE_LABEL,
    fiscalYearStart, monthsBetween,
    activitySql, positionsSql, accountLinesSql, freshnessSql, unplacedSql,
    profitAndLoss, balanceSheet, trialBalance, accountActivity,
  };
});
