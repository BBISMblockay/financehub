/* The Ledger tab in the real Books page.
 *
 * The unit suite proves the arithmetic. This proves the page opens on the
 * ledger once opening balances are accepted, reads the three sources it
 * claims to (accepted snapshot, posted payloads, a saved trial balance),
 * keeps Silo's postings apart from other QuickBooks activity, and drills
 * into the lines behind a Silo figure. Nothing is saved.
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const r = createReporter('accounting-ledger');
const tbRow = (id, name, debit, credit) => ({ ColData: [{ id, value: name }, { value: debit }, { value: credit }] });

const FIXTURES = () => ({
  accounting_settings: [{ accounting_start_date: '2026-08-01', accounting_basis: 'Accrual', fiscal_year_start_month: 1, qbo_connection_id: 'conn-1' }],
  accounting_opening_balances: [{ id: 'ob-1', status: 'accepted', accepted_at: '2026-09-14T00:00:00Z', snapshot_hash: 'h',
    snapshot: { as_of: '2026-07-31', accounting_start_date: '2026-08-01', currency: 'USD', basis: 'Accrual', debits: 6000, credits: 6000, fetched_at: '2026-09-14',
      lines: [
        { qbo_account_id: '83', name: 'Checking', account_type: 'Bank', debit: 1000, credit: 0 },
        { qbo_account_id: '290', name: 'Prepaid licensing', account_type: 'Other Current Asset', debit: 5000, credit: 0 },
        { qbo_account_id: '300', name: 'Equity', account_type: 'Equity', debit: 0, credit: 6000 },
      ] } }],
  accounting_accounts: [],
  quickbooks_journal_postings: [{ id: 'p1', connection_id: 'conn-1', source: 'prepaid_amortization', status: 'posted', qbo_doc_number: 'SILO-AMORT',
    payload: { TxnDate: '2026-08-31', Line: [
      { Amount: 500, Description: 'Epic Games — 2026-08', JournalEntryLineDetail: { AccountRef: { value: '163' }, PostingType: 'Debit' } },
      { Amount: 500, Description: 'Epic Games — 2026-08', JournalEntryLineDetail: { AccountRef: { value: '290' }, PostingType: 'Credit' } }] } }],
  quickbooks_report_runs: [{ id: 'tb-1', report_name: 'TrialBalance', status: 'ok', end_date: '2026-09-22', fetched_at: '2026-09-23T00:00:00Z', connection_id: 'conn-1',
    params: { start_date: '2026-01-01', end_date: '2026-09-22', accounting_method: 'Accrual' },
    raw_response: {
      Header: { ReportName: 'TrialBalance', ReportBasis: 'Accrual', Currency: 'USD', EndPeriod: '2026-09-22' },
      Columns: { Column: [{ ColType: 'Account', ColTitle: '' }, { ColType: 'Money', ColTitle: 'Debit' }, { ColType: 'Money', ColTitle: 'Credit' }] },
      Rows: { Row: [tbRow('83', 'Checking', '1400.00', ''), tbRow('290', 'Prepaid licensing', '4500.00', ''), tbRow('300', 'Equity', '', '6000.00'), tbRow('163', 'Amortization', '500.00', ''), tbRow('400', 'Sales', '', '400.00')] } } }],
  accounting_journal_register: [],
});

(async () => {
  const suite = await startSuite();
  async function check(name, fn) {
    try { await fn(); r.ok(name, true); }
    catch (err) { r.ok(name, false, err && err.message ? err.message : String(err)); }
  }
  try {
    let page;
    try {
      page = await suite.open('/v2/accounting-books.html', FIXTURES(), {
        ready: () => !!document.querySelector('#ledgerTable table'),
        rpc: { silo_business_today: () => '2026-09-23', can_manage_journal_entries: () => true, is_exec_or_owner: () => true, accounting_qbo_connections: () => [{ id: 'conn-1', company_name: 'Synthetic', environment: 'sandbox' }] },
      });
      r.ok('Books draws the ledger roll-forward', true);
    } catch (err) {
      r.ok('Books draws the ledger roll-forward', false, err.message.split('\n')[0]);
    }
    if (page) {
      await check('accepted books open on the Ledger tab', async () => {
        r.eq(await page.$eval('#ledger', (n) => n.hidden), false);
        r.eq(await page.$eval('[data-surface="ledger"]', (n) => n.getAttribute('aria-pressed')), 'true');
      });
      const rowOf = (name) => page.evaluate((n) => {
        const tr = [...document.querySelectorAll('#ledgerTable tbody tr')].find((t) => t.querySelector('td').textContent.startsWith(n));
        return tr ? [...tr.querySelectorAll('td')].slice(1).map((td) => td.textContent.trim()) : null;
      }, name);
      await check("Silo's postings and other QuickBooks activity are separate columns", async () => {
        r.eq(await rowOf('Prepaid licensing'), ['5,000.00', '(500.00)', '0.00', '4,500.00']);
        r.eq(await rowOf('Checking'), ['1,000.00', '0.00', '400.00', '1,400.00']);
      });
      await check('every column nets to zero', async () => {
        const foot = await page.$$eval('#ledgerTable tfoot td', (t) => t.slice(1).map((x) => x.textContent.trim()));
        r.eq(foot, ['0.00', '0.00', '0.00', '0.00']);
      });
      await check('a Posted by Silo figure opens the lines behind it', async () => {
        await page.click('[data-ledger-account="290"]');
        const text = await page.$eval('#ledgerLines', (n) => (n.hidden ? '' : n.textContent));
        r.has(text, 'SILO-AMORT');
        r.has(text, 'Schedules');
        r.has(text, 'Epic Games');
      });
    }
  } finally {
    await suite.close();
  }
  process.exit(r.summary().fail ? 1 : 0);
})();
