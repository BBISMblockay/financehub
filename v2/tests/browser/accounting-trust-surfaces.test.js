/* Cash forecast, Reports and Journals, in the real pages.
 *
 * The unit suites prove the model (pending counted per day, due vs posted on
 * Schedules). This proves the half a unit test cannot reach:
 *   - the forecast grid opens on category totals and a category opens to its
 *     COA accounts;
 *   - an actual column that is still settling (today, or pending bank rows)
 *     says so in its header;
 *   - "Go to forecast" lands with the actual/forecast boundary on screen. The
 *     previous version measured offsetLeft from the page BODY, so it overshot
 *     by the sidebar's width and hid the boundary under the sticky label
 *     column -- a unit test could not have seen that;
 *   - Reports picks a statement by tile and only offers the account filter
 *     where QuickBooks honours it.
 *
 * Nothing is saved: every read is a select, and the one report run the tile
 * click starts goes to a stubbed endpoint.
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const r = createReporter('accounting-trust-surfaces');
const TODAY = '2026-09-23';

function addDays(d, n) {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

function cashFixtures() {
  const coa = [
    ['rev', 'Shopify Sales', 'Income', 1],
    ['cogs', 'Inventory Purchases', 'Cost of Goods Sold', -1],
    ['rent', 'Rent', 'Expense', -1],
    ['soft', 'Software', 'Expense', -1],
  ];
  const txns = [];
  let k = 0;
  for (let i = 0; i < 90; i++) {
    const d = addDays(TODAY, -i);
    for (const [id, name, , sign] of coa) {
      txns.push({ id: 't' + k, plaid_account_id: 'acc1', external_transaction_id: 'x' + k++, txn_date: d,
        description: name, amount: -sign * (100 + i), currency: 'USD', origin: 'plaid',
        provider_status: 'posted', status: 'coded', qbo_account_id: id, qbo_account_name: name });
    }
  }
  // Two pending rows yesterday, one today: those columns are not final.
  for (const d of [addDays(TODAY, -1), addDays(TODAY, -1), TODAY]) {
    txns.push({ id: 'p' + k, plaid_account_id: 'acc1', external_transaction_id: 'p' + k++, txn_date: d,
      description: 'pending', amount: 40, currency: 'USD', origin: 'plaid',
      provider_status: 'pending', status: 'uncoded' });
  }
  return {
    plaid_accounts: [{ id: 'acc1', connection_id: 'c1', name: 'Operating', mask: '1234', type: 'depository',
      subtype: 'checking', iso_currency_code: 'USD', current_balance: 250000,
      balance_updated_at: TODAY + 'T14:00:00Z', last_synced_at: new Date().toISOString(), source_id: 's1' }],
    plaid_connections: [{ id: 'c1', institution_name: 'Chase', status: 'active' }],
    card_sources: [{ id: 's1', qbo_connection_id: 'q1' }],
    quickbooks_accounts: coa.map(([id, name, type]) => ({ id: 'qa' + id, qbo_account_id: id, name,
      fully_qualified_name: name, account_type: type, connection_id: 'q1' })),
    cash_forecast_items: [],
    cash_forecast_overrides: [],
    revenue_projections: [],
    accounting_settings: [{ base_currency: 'USD' }],
    card_transactions: txns,
    payment_requests: [
      { id: 'r-soon', vendor_name: 'Mill Supply', amount_due: 1200, due_date: addDays(TODAY, 3), workflow_status: 'new', completed: false },
      { id: 'r-old', vendor_name: 'Old Invoice Co', amount_due: 9000, due_date: addDays(TODAY, -40), workflow_status: 'new', completed: false },
      { id: 'r-paid', vendor_name: 'Paid Vendor', amount_due: 500, due_date: addDays(TODAY, 5), workflow_status: 'paid', completed: true },
    ],
  };
}

(async () => {
  const suite = await startSuite();
  async function check(name, fn) {
    try { await fn(); r.ok(name, true); }
    catch (err) { r.ok(name, false, err && err.message ? err.message : String(err)); }
  }

  try {
    let page;
    try {
      page = await suite.open('/v2/cash-forecast.html', cashFixtures(), {
        ready: () => !!document.querySelector('#matrix table'),
        // Scalar RPC results: a table-style fixture would arrive as an array.
        rpc: {
          silo_business_today: () => '2026-09-23',
          can_manage_journal_entries: () => true,
          is_exec_or_owner: () => true,
        },
      });
      r.ok('cash-forecast.html boots and draws the forecast grid', true);
    } catch (err) {
      r.ok('cash-forecast.html boots and draws the forecast grid', false, err.message.split('\n')[0]);
    }

    if (page) {
      await check('COA rows open collapsed, one total per account type', async () => {
        const groups = await page.$$eval('.cf-group-toggle', (b) => b.map((x) => x.firstChild.textContent.trim()));
        r.eq(groups, ['Income', 'Cost of Goods Sold', 'Expense']);
        r.eq(await page.$$eval('.cf-child', (n) => n.length), 0, 'no account rows before a category is opened');
      });

      await check('opening a category lists its COA accounts, and its total is their sum', async () => {
        await page.click('.cf-group-toggle:has-text("Expense")');
        const out = await page.evaluate(() => {
          const group = [...document.querySelectorAll('.cf-group')].find((g) => g.textContent.includes('Expense'));
          const kids = [];
          for (let n = group.nextElementSibling; n && n.classList.contains('cf-child'); n = n.nextElementSibling) kids.push(n);
          const num = (s) => Number(s.replace(/[^0-9.-]/g, ''));
          const cell = (row) => num(row.querySelectorAll('td')[0].textContent);
          return { names: kids.map((k) => k.querySelector('th').textContent.trim()),
            sum: Math.round(kids.reduce((a, k) => a + cell(k), 0) * 100), total: Math.round(cell(group) * 100),
            expanded: group.querySelector('[data-group]').getAttribute('aria-expanded') };
        });
        r.eq(out.names.sort(), ['Rent', 'Software']);
        r.eq(out.sum, out.total, 'category total equals its accounts');
        r.eq(out.expanded, 'true');
      });

      await check('settling actual days say so in their header', async () => {
        await page.selectOption('#unit', 'day');
        await page.waitForFunction(() => document.querySelectorAll('th.cf-settling').length > 0);
        const notes = await page.$$eval('th.cf-settling .cf-settle', (n) => n.map((x) => x.textContent.trim()));
        r.eq(notes, ['2 pending', 'in progress · 1 pending']);
      });

      await check('Go to forecast lands with the boundary visible, a quarter of the way in', async () => {
        await page.evaluate(() => { document.getElementById('matrix').scrollLeft = 0; });
        await page.click('#jump');
        const pos = await page.evaluate(() => {
          const m = document.getElementById('matrix');
          const label = m.querySelector('thead th').offsetWidth;
          const x = document.getElementById('forecastStart').getBoundingClientRect().left - m.getBoundingClientRect().left;
          return { x, label, width: m.clientWidth };
        });
        r.truthy(pos.x > pos.label, `boundary at ${pos.x}px is not hidden under the ${pos.label}px label column`);
        r.truthy(pos.x < pos.label + (pos.width - pos.label) / 2, `boundary at ${pos.x}px sits in the first half of the grid`);
      });

      await check('payment requests sit in the Planned activity panel, off until switched on', async () => {
        r.eq(await page.$eval('#planDrawer', (n) => n.hidden), true, 'panel starts closed');
        await page.click('#planToggle');
        r.eq(await page.$eval('#planDrawer', (n) => n.hidden), false);
        r.eq(await page.$eval('#planToggle', (n) => n.getAttribute('aria-expanded')), 'true');
        const text = await page.$eval('#requests', (n) => n.textContent);
        r.has(text, 'Mill Supply');
        r.has(text, '1 past due');
        r.has(text, 'not in forecast');
        r.not(text, 'Paid Vendor');
        r.eq(await page.$eval('#requestsEnabled', (n) => n.checked), false, 'off by default');
        const hasLine = () => [...document.querySelectorAll('#matrix tbody th[scope="row"]')].some((x) => x.textContent.trim() === 'Payment requests');
        r.eq(await page.evaluate(hasLine), false, 'no forecast line while the switch is off');
        await page.check('#requestsEnabled');
        await page.waitForFunction(hasLine);
        r.truthy(await page.$$eval('#matrix td.cf-planned', (n) => n.length) > 0, 'the cell carrying the request is marked');
        r.has(await page.$eval('#planToggle', (n) => n.textContent), '· 1');
        await page.click('#planClose');
        r.eq(await page.$eval('#planDrawer', (n) => n.hidden), true);
      });

      await check('charts collapse', async () => {
        await page.click('#chartsWrap > summary');
        r.eq(await page.$eval('#chartsWrap', (d) => d.open), false);
      });
    }

    let reports;
    try {
      reports = await suite.open('/v2/qbo-reports.html', { quickbooks_accounts: [] }, {
        ready: () => document.querySelectorAll('#reportTiles [data-report]').length === 7,
      });
      r.ok('qbo-reports.html boots with report tiles', true);
    } catch (err) {
      r.ok('qbo-reports.html boots with report tiles', false, err.message.split('\n')[0]);
    }
    if (reports) {
      await check('the account filter is offered only where QuickBooks honours it', async () => {
        r.eq(await reports.$eval('#accountField', (n) => n.hidden), false, 'General Ledger takes an account filter');
        await reports.click('[data-report="BalanceSheet"]');
        r.eq(await reports.$eval('#accountField', (n) => n.hidden), true, 'Balance Sheet does not');
        r.eq(await reports.$eval('[data-report="BalanceSheet"]', (n) => n.getAttribute('aria-pressed')), 'true');
        r.eq(await reports.$$eval('#reportTiles [aria-pressed="true"]', (n) => n.length), 1);
      });
    }
  } finally {
    await suite.close();
  }
  const s = r.summary();
  process.exit(s.fail ? 1 : 0);
})();
