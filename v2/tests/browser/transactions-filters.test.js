/* The transaction register, in a real browser, against fixture rows.
 *
 * The unit suite pins the PREDICATE. This one pins the wiring around it,
 * which is where the equivalent bugs actually shipped elsewhere in SILO: a
 * control that reads one piece of state while the table reads another, a bar
 * that rebuilds its own innerHTML and discards what was being typed into it,
 * a count that describes a different set from the rows beneath it.
 *
 * Everything outside the page is stubbed (see lib/harness.js). The page, its
 * modules and its stylesheets are served unmodified from the checkout.
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const r = createReporter('transactions-filters');

// Dates inside the page's default period (this month), so the register's own
// date presets load them without the suite driving the date form.
const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const day = (n) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(Math.min(n, 28))}`;

const CONNECTION = 'conn-1';
const SOURCE = 'src-1';
const BATCH = 'batch-1';

const accounts = [
  { qbo_account_id: 'acc_rent', name: 'Lease & Rent', fully_qualified_name: 'Lease & Rent', account_type: 'Expense', account_sub_type: 'Rent', is_active: true, connection_id: CONNECTION },
  { qbo_account_id: 'acc_int', name: 'Interest Expense', fully_qualified_name: 'Interest Expense', account_type: 'Expense', account_sub_type: 'Interest', is_active: true, connection_id: CONNECTION },
  { qbo_account_id: 'acc_loan', name: 'Biz2Credit Loan', fully_qualified_name: 'Biz2Credit Loan', account_type: 'Other Current Liability', account_sub_type: 'Loan', is_active: true, connection_id: CONNECTION },
];

const txn = (over) => Object.assign({
  company_entity_id: 'test-company', batch_id: BATCH, row_no: 1,
  txn_date: day(5), description: 'A CHARGE', clean_merchant: null, amount: 10,
  status: 'uncoded', coding_source: null, confidence: null, coding_conflict: null,
  accounting_treatment: 'purchase', origin: 'csv', provider_status: null,
  qbo_account_id: null, qbo_account_name: null, qbo_location_id: null,
  qbo_location_name: null, entity_qbo_id: null, entity_name: null, entity_type: null,
  card_name: 'Ops', cardholder: null, cardholder_email: null, memo: null,
  vendor_name: null, exclude_reason: null, currency: 'USD', last4: null,
  external_transaction_id: null, rule_id: null, ai_reasoning: null, raw: {},
}, over);

const transactions = [
  txn({ id: 't-amazon', row_no: 1, txn_date: day(4), description: 'AMZN Mktp US*2A4XY9',
    clean_merchant: 'Amazon', amount: 120.5, status: 'coded', coding_source: 'manual',
    qbo_account_id: 'acc_rent', qbo_account_name: 'Lease & Rent' }),
  txn({ id: 't-loan', row_no: 2, txn_date: day(6), description: 'BIZ2CREDIT PAYMENT',
    clean_merchant: null, amount: 25187.68, status: 'coded', coding_source: 'manual' }),
  txn({ id: 't-refund', row_no: 3, txn_date: day(8), description: 'RETURN CREDIT 8841',
    clean_merchant: 'Amazon', amount: -45.25, accounting_treatment: 'refund',
    status: 'coded', coding_source: 'manual', qbo_account_id: 'acc_rent', qbo_account_name: 'Lease & Rent' }),
  txn({ id: 't-bare', row_no: 4, txn_date: day(10), description: 'CHECKCARD 0412 SQ *TST',
    clean_merchant: null, amount: 62 }),
  txn({ id: 't-comcast', row_no: 5, txn_date: day(12), description: 'COMCAST BUSINESS',
    clean_merchant: 'Comcast', amount: 310 }),
];

const splitLines = [
  { id: 's1', company_entity_id: 'test-company', transaction_id: 't-loan', line_no: 1, amount: 22000,
    qbo_account_id: 'acc_loan', qbo_account_name: 'Biz2Credit Loan', qbo_location_id: null,
    qbo_location_name: null, entity_qbo_id: null, entity_type: null, memo: 'principal' },
  { id: 's2', company_entity_id: 'test-company', transaction_id: 't-loan', line_no: 2, amount: 3187.68,
    qbo_account_id: 'acc_int', qbo_account_name: 'Interest Expense', qbo_location_id: null,
    qbo_location_name: null, entity_qbo_id: null, entity_type: null, memo: 'interest' },
];

// 60 rules, so 25-per-page paging has three pages and 10-per-page has six.
const codingRules = Array.from({ length: 60 }, (_, i) => ({
  id: 'rule-' + i, company_entity_id: 'test-company', source_id: SOURCE,
  match_field: i % 3 === 0 ? 'card_name' : 'merchant',
  match_type: i % 2 === 0 ? 'normalized' : 'contains',
  pattern: (i === 7 ? 'sugar hill' : 'vendor ' + i),
  qbo_account_id: i % 2 ? 'acc_rent' : 'acc_int',
  qbo_account_name: i % 2 ? 'Lease & Rent' : 'Interest Expense',
  entity_qbo_id: null, entity_name: null, qbo_location_id: null, qbo_location_name: null,
  direction: 'outflow', accounting_treatment: 'purchase', is_active: true,
  priority: 100, hit_count: i,
}));

const TABLES = {
  card_sources: [{
    id: SOURCE, company_entity_id: 'test-company', display_name: 'Amex Platinum',
    source_key: 'amex', source_type: 'card', is_active: true, ingest_mode: 'csv',
    qbo_connection_id: CONNECTION, posting_enabled: false, column_map: {},
    credit_account_name: 'Amex', credit_account_type: 'Credit Card',
    default_qbo_location_id: null, authoritative_from: null,
  }],
  quickbooks_accounts: accounts,
  quickbooks_locations: [{ qbo_location_id: 'loc_hq', name: 'HQ', fully_qualified_name: 'HQ', is_active: true, connection_id: CONNECTION }],
  quickbooks_customers: [],
  quickbooks_vendors: [],
  card_import_batches_v: [{
    id: BATCH, company_entity_id: 'test-company', source_id: SOURCE, source_name: 'Amex Platinum',
    source_key: 'amex', label: 'September', file_name: 'amex.csv', status: 'draft',
    created_at: day(1) + 'T00:00:00Z', entry_date: day(28), period_start: day(1), period_end: day(28),
    total_amount: 0, txn_count: transactions.length, uncoded_count: 2, excluded_count: 0,
    coded_amount: 0, qbo_journal_entry_id: null, qbo_doc_number: null, posting_status: null,
    posting_id: null, qbo_connection_id: CONNECTION, origin: 'csv', feed_sequence: null,
    approved_at: null, approved_by: null, approval_version: null, approval_hash: null,
    source_posting_enabled: false,
  }],
  card_transactions: transactions,
  card_transaction_splits: splitLines,
  card_coding_rules: codingRules,
  card_split_rules: [{
    id: 'split-rule-1', company_entity_id: 'test-company', source_id: SOURCE,
    match_field: 'merchant', pattern: 'biz2credit', priority: 100, hit_count: 4,
  }],
  card_split_rule_lines: [
    { rule_id: 'split-rule-1', line_no: 1, qbo_account_id: 'acc_loan', qbo_account_name: 'Biz2Credit Loan' },
    { rule_id: 'split-rule-1', line_no: 2, qbo_account_id: 'acc_int', qbo_account_name: 'Interest Expense' },
  ],
  profiles: [{ id: 'test-user', name: 'Test', email: 'test@baseballism.com', role: 'owner', department: 'finance' }],
};

(async () => {
  const suite = await startSuite();
  let page;
  try {
    page = await suite.open('/v2/transactions.html', TABLES, {
      ready: () => document.querySelectorAll('#tblCoding tbody tr.txn-row').length > 0,
    });

    const visibleIds = async () => (await page.$$eval('#tblCoding tbody tr.txn-row',
      (trs) => trs.map((tr) => tr.dataset.txn))).sort();
    const chipLabels = () => page.$$eval('#filterChips .txn-chip',
      (bs) => bs.map((b) => b.textContent.replace(/\u00d7$/, '').trim()));
    const countText = () => page.$eval('#filterCount', (n) => n.textContent.trim());
    const ruleRows = () => page.$$eval('#tblRules tbody tr', (trs) => trs.length);
    const text = (sel) => page.$eval(sel, (n) => n.textContent);
    // The filter bar debounces a typed value; a select applies at once.
    const settle = () => page.waitForTimeout(320);

    /* Clear filters lives in the active-filter bar, which is hidden when
       nothing is active -- so clicking it unconditionally waits 30s on an
       invisible button. */
    async function clearAll() {
      if (await page.$eval('#codeActiveFilters', (n) => n.hidden)) return;
      await page.click('#btnClearFilters');
      await settle();
    }

    /* r.eq() THROWS, so an assertion outside r.test() would abort the suite
       instead of recording a failure -- and an async body cannot be passed to
       r.test(). This is the async equivalent. */
    async function check(name, fn) {
      try { await fn(); r.ok(name, true); }
      catch (err) { r.ok(name, false, err && err.message ? err.message : String(err)); }
    }

    // ---------------------------------------------------------- the table

    console.log('\n\u2500\u2500 the register renders \u2500\u2500');
    const ALL = await visibleIds();
    await check('every fixture row is on screen', async () => r.eq(ALL.length, 5));

    console.log('\n\u2500\u2500 the Merchant column \u2500\u2500');
    await check('Merchant is its own column, beside Transaction', async () => {
      const header = await page.$$eval('#tblCoding thead th', (ths) => ths.map((t) => t.textContent.trim()));
      r.truthy(header.includes('Merchant'), 'header: ' + header.join(' | '));
      r.eq(header.indexOf('Merchant'), header.indexOf('Transaction') + 1, 'header: ' + header.join(' | '));
    });

    const merchants = await page.$$eval('#tblCoding tbody tr.txn-row', (trs) => trs.map((tr) => ({
      id: tr.dataset.txn,
      // Only what a sighted reader sees: the sr-only note is excluded.
      shown: (tr.querySelector('.txn-merchant .txn-merchant-button') || {}).textContent || '',
      description: (tr.querySelector('.txn-description-button') || {}).textContent || '',
    })));
    const row = (id) => merchants.find((m) => m.id === id);

    await check('a supplied merchant is shown', async () => {
      r.eq(row('t-amazon').shown, 'Amazon');
      r.eq(row('t-comcast').shown, 'Comcast');
    });

    await check('an unsupplied merchant is BLANK, not the description', async () => {
      r.eq(row('t-bare').shown, '');
      r.eq(row('t-loan').shown, '');
      r.eq(row('t-bare').description, 'CHECKCARD 0412 SQ *TST', 'the description is still there');
    });

    await check('the original description stays on every row', async () => {
      r.truthy(merchants.every((m) => m.description.length > 0),
        JSON.stringify(merchants.map((m) => m.description)));
    });

    await check('a blank merchant cell explains itself to a screen reader only', async () => {
      const cell = await page.$eval('#tblCoding tr[data-txn="t-bare"] .txn-merchant', (td) => {
        const note = td.querySelector('.txn-sr-only');
        const box = note ? note.getBoundingClientRect() : null;
        return { html: td.innerHTML, w: box && box.width, h: box && box.height };
      });
      r.has(cell.html, 'No merchant supplied by the source');
      // Clipped to a 1px box: present for a screen reader, invisible on screen.
      r.truthy(cell.w <= 1 && cell.h <= 1, 'sr-only note measured ' + cell.w + 'x' + cell.h);
    });

    // -------------------------------------------------------- the filters

    console.log('\n\u2500\u2500 filters narrow the whole loaded set \u2500\u2500');
    if (await page.$eval('#codeFilterPanel', (n) => n.hidden)) await page.click('#btnFilterToggle');

    await check('money in selects the refund alone, and says so', async () => {
      await page.selectOption('#fltDirection', 'in');
      await settle();
      r.eq(await visibleIds(), ['t-refund']);
      r.eq(await countText(), 'Showing 1 of 5');
    });

    await check('clearing direction restores the whole set', async () => {
      await page.selectOption('#fltDirection', 'any');
      await settle();
      r.eq(await visibleIds(), ALL);
    });

    await check('the merchant picker selects that merchant', async () => {
      await page.selectOption('#fltMerchant', 'Amazon');
      await settle();
      r.eq(await visibleIds(), ['t-amazon', 't-refund']);
    });

    await check('"no merchant from the source" is its own choice', async () => {
      await page.selectOption('#fltMerchant', '__none__');
      await settle();
      r.eq(await visibleIds(), ['t-bare', 't-loan']);
      await page.selectOption('#fltMerchant', '');
      await settle();
    });

    console.log('\n\u2500\u2500 a split matches its lines, once \u2500\u2500');
    await check('the split parent appears exactly once under a line account', async () => {
      await page.selectOption('#fltAccount', 'acc_int');
      await settle();
      r.eq(await visibleIds(), ['t-loan']);
      r.eq(await countText(), 'Showing 1 of 5');
    });

    await check('a split is not counted as uncategorized', async () => {
      await page.selectOption('#fltAccount', '__none__');
      await settle();
      r.eq(await visibleIds(), ['t-bare', 't-comcast']);
      await page.selectOption('#fltAccount', '');
      await settle();
    });

    console.log('\n\u2500\u2500 amounts are magnitudes \u2500\u2500');
    await check('an exact amount matches the negative row by magnitude', async () => {
      await page.selectOption('#fltAmountMode', 'exact');
      await settle();
      await page.fill('#fltAmountExact', '45.25');
      await settle();
      r.eq(await visibleIds(), ['t-refund']);
    });

    await check('a range is inclusive at both ends', async () => {
      await page.selectOption('#fltAmountMode', 'range');
      await settle();
      await page.fill('#fltAmountMin', '100');
      await page.fill('#fltAmountMax', '400');
      await settle();
      r.eq(await visibleIds(), ['t-amazon', 't-comcast']);
    });

    console.log('\n\u2500\u2500 typing is not discarded by a re-render \u2500\u2500');
    await check('a typed value survives the table redrawing under it', async () => {
      await page.fill('#fltText', 'comcast');
      await settle();
      r.eq(await page.inputValue('#fltText'), 'comcast');
      r.eq(await page.inputValue('#fltAmountMin'), '100', 'and so do the sibling fields');
      r.eq(await visibleIds(), ['t-comcast'], 'combined with the amount range');
    });

    console.log('\n\u2500\u2500 chips, counts and Clear filters \u2500\u2500');
    await check('one chip per active filter, each naming what it did', async () => {
      const chips = await chipLabels();
      r.eq(chips.length, 2, chips.join(' | '));
      r.truthy(chips.some((c) => c.indexOf('comcast') !== -1), chips.join(' | '));
      r.truthy(chips.some((c) => c.indexOf('$100.00') !== -1 && c.indexOf('$400.00') !== -1), chips.join(' | '));
      r.eq(await countText(), 'Showing 1 of 5');
    });

    await check('removing one chip leaves the other applied', async () => {
      await page.click('#filterChips .txn-chip:last-child');
      await settle();
      r.eq((await chipLabels()).length, 1);
      r.eq(await page.inputValue('#fltAmountMin'), '', 'the amount inputs cleared with the chip');
      r.eq(await page.inputValue('#fltText'), 'comcast', 'the text filter survived');
    });

    await check('Clear filters resets everything and hides the bar', async () => {
      await page.click('#btnClearFilters');
      await settle();
      r.eq(await visibleIds(), ALL);
      r.eq(await page.$eval('#codeActiveFilters', (n) => n.hidden), true);
      r.eq(await page.inputValue('#fltText'), '');
      r.eq(await page.inputValue('#fltAmountMode'), 'any');
    });

    console.log('\n\u2500\u2500 filters survive opening and closing a transaction \u2500\u2500');
    await check('a filter is still set and still applied around a review panel', async () => {
      await page.selectOption('#fltMerchant', 'Amazon');
      await settle();
      await page.click('#tblCoding tr[data-txn="t-amazon"] .txn-review-button');
      await page.waitForTimeout(150);
      r.eq(await page.$eval('#txn-detail-t-amazon', (n) => n.hidden), false, 'the panel opened');
      r.eq(await page.inputValue('#fltMerchant'), 'Amazon');
      r.eq(await visibleIds(), ['t-amazon', 't-refund']);
      await page.click('#tblCoding tr[data-txn="t-amazon"] .txn-review-button');
      await page.waitForTimeout(150);
      r.eq(await visibleIds(), ['t-amazon', 't-refund'], 'still applied after closing it');
    });

    console.log('\n\u2500\u2500 the Merchant cell drives the merchant filter \u2500\u2500');
    await check('clicking a merchant filters to it, and clicking again clears it', async () => {
      await clearAll();
      await page.click('#tblCoding tr[data-txn="t-comcast"] .txn-merchant-button');
      await settle();
      r.eq(await visibleIds(), ['t-comcast']);
      r.eq(await page.inputValue('#fltMerchant'), 'Comcast', 'the picker agrees with the table');
      await page.click('#tblCoding tr[data-txn="t-comcast"] .txn-merchant-button');
      await settle();
      r.eq(await visibleIds(), ALL);
    });

    console.log('\n\u2500\u2500 filters survive reloading the data \u2500\u2500');
    await check('a filter survives a date-range reload, and says when its value is gone', async () => {
      await clearAll();
      await page.selectOption('#fltMerchant', 'Comcast');
      await settle();
      r.eq(await visibleIds(), ['t-comcast']);

      // Reload the account over a window that excludes the Comcast row. The
      // set on screen changes; the filter position must not.
      const start = await page.inputValue('#dateStart');
      const narrow = start.slice(0, 8) + '01';
      const before = start.slice(0, 8) + '11';
      await page.fill('#dateStart', narrow);
      await page.fill('#dateEnd', before);
      await page.click('#dateForm button[type="submit"]');
      await page.waitForTimeout(600);

      r.eq(await page.inputValue('#fltMerchant'), 'Comcast', 'the filter was not reset by the reload');
      r.eq((await chipLabels()).length, 1, 'and its chip is still shown');
      r.eq(await visibleIds(), [], 'no row in the new window matches it');
      const absent = await page.$eval('#fltMerchant',
        (f) => !!f.querySelector('option[data-absent]'));
      r.truthy(absent, 'the picker says the value is not in these transactions');

      // Put the window back and confirm the filter starts matching again.
      await page.fill('#dateEnd', start.slice(0, 8) + '28');
      await page.click('#dateForm button[type="submit"]');
      await page.waitForTimeout(600);
      r.eq(await visibleIds(), ['t-comcast']);
      r.eq(await page.$eval('#fltMerchant', (f) => !!f.querySelector('option[data-absent]')), false,
        'and the placeholder is cleared once the value is back');
      await page.click('#btnClearFilters');
      await settle();
    });

    // ---------------------------------------------------------- the rules

    console.log('\n\u2500\u2500 the rules page \u2500\u2500');
    await page.click('#ccTabs .bcn-tab[data-pane="rules"]');
    await page.waitForTimeout(250);

    await check('25 rules per page by default, over all 61 rules', async () => {
      r.eq(await page.inputValue('#rulePageSize'), '25');
      r.eq(await ruleRows(), 25);
      r.has(await text('#rulesCount'), '61 rules');
      r.has(await text('#rulesPageLabel'), '1\u201325 of 61');
    });

    await check('10 per page is offered and pages through', async () => {
      await page.selectOption('#rulePageSize', '10');
      await page.waitForTimeout(200);
      r.eq(await ruleRows(), 10);
      r.has(await text('#rulesPageLabel'), '1\u201310 of 61');
      await page.click('#btnRulesNext');
      await page.waitForTimeout(200);
      r.eq(await ruleRows(), 10);
      r.has(await text('#rulesPageLabel'), '11\u201320 of 61');
    });

    await check('search filters BEFORE paging and reports the match total', async () => {
      await page.selectOption('#rulePageSize', '25');
      await page.fill('#ruleSearch', 'sugar hill');
      await page.waitForTimeout(250);
      r.eq(await ruleRows(), 1);
      r.has(await text('#rulesCount'), '1 of 61 rules');
      r.eq(await page.$eval('#rulesPager', (n) => n.hidden), true, 'one page needs no pager');
    });

    await check('a filter that shortens the list does not strand the reader on a dead page', async () => {
      await page.fill('#ruleSearch', '');
      await page.waitForTimeout(200);
      await page.click('#btnRulesNext');
      await page.waitForTimeout(200);
      await page.fill('#ruleSearch', 'sugar hill');
      await page.waitForTimeout(250);
      r.eq(await ruleRows(), 1, 'the single match is shown, not an empty page 2');
    });

    await check('the account filter reaches a saved split\'s own lines', async () => {
      await page.fill('#ruleSearch', '');
      await page.selectOption('#ruleFilterAccount', 'acc_int');
      await page.waitForTimeout(250);
      // 30 coding rules code to Interest Expense, plus the saved split, whose
      // account is only on its second LINE -- 31 is the proof it was reached.
      r.has(await text('#rulesCount'), '31 of 61 rules');
      await page.selectOption('#ruleFilterAccount', 'acc_loan');
      await page.waitForTimeout(250);
      r.has(await text('#rulesCount'), '1 of 61 rules', 'only the split touches the loan account');
      r.eq(await page.$$eval('#tblRules tbody tr[data-split-rule]', (t) => t.length), 1);
    });

    await check('rule type narrows to saved splits, which say they store no amounts', async () => {
      await page.selectOption('#ruleFilterAccount', '');
      await page.selectOption('#ruleFilterKind', 'split');
      await page.waitForTimeout(250);
      r.eq(await ruleRows(), 1);
      const splitText = await page.$eval('#tblRules tbody tr[data-split-rule]', (tr) => tr.innerText);
      r.has(splitText, 'Biz2Credit Loan');
      r.has(splitText, 'Interest Expense');
      r.has(splitText.toLowerCase(), 'amounts are typed against the statement every time');
      r.not(splitText, 'Delete', 'no Delete button it has no write path for');
    });

    await check('Clear restores the full first page', async () => {
      await page.click('#btnClearRuleFilters');
      await page.waitForTimeout(250);
      r.eq(await ruleRows(), 25);
    });

    // -------------------------------------------------------- the dialogs

    console.log('\n\u2500\u2500 dialogs are opaque \u2500\u2500');
    await page.click('#ccTabs .bcn-tab[data-pane="coding"]');
    await page.waitForTimeout(200);

    /* Beacon's light tokens are hex (serialized rgb) and its dark tokens are
       oklch(), which getComputedStyle returns verbatim -- an rgb-only check
       reads every dark-theme colour as see-through. */
    const opaque = (value) => {
      if (!value || value === 'transparent') return false;
      if (value.indexOf('rgba(') === 0) return Number(value.split(',')[3]) > 0.9;
      if (value.indexOf('oklch(') === 0) return value.indexOf('/') === -1;
      return value.indexOf('rgb(') === 0;
    };
    // 0 (black) to 1 (white), from either notation.
    const lightness = (value) => {
      if (value.indexOf('oklch(') === 0) return Number(value.slice(6).trim().split(/[\s)]/)[0]);
      const parts = value.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
      return (parts[0] + parts[1] + parts[2]) / (3 * 255);
    };

    await check('the row-detail drawer has a solid background', async () => {
      await page.click('#tblCoding tr[data-txn="t-bare"] .txn-review-button');
      await page.waitForTimeout(150);
      await page.click('#tblCoding tr[data-txn="t-bare"] [data-raw]');
      await page.waitForTimeout(200);
      r.eq(await page.$eval('#rawDrawer', (n) => n.hidden), false, 'the drawer opened');
      const bg = await page.$eval('#rawDrawer', (n) => getComputedStyle(n).backgroundColor);
      r.truthy(opaque(bg), 'background-color was ' + bg);
    });

    await check('the split editor panel has a solid background', async () => {
      const bg = await page.$eval('.txn-split-panel', (n) => getComputedStyle(n).backgroundColor);
      r.truthy(opaque(bg), 'background-color was ' + bg);
    });

    await check('the sticky page header is opaque, so rows do not scroll through it', async () => {
      const bg = await page.$eval('.accounting-workspace > .bcn-header',
        (n) => getComputedStyle(n).backgroundColor);
      r.truthy(opaque(bg), 'background-color was ' + bg);
    });

    await check('the accounting suite nav bar is opaque', async () => {
      const bg = await page.$eval('[data-accounting-suite]', (n) => getComputedStyle(n).backgroundColor);
      r.truthy(opaque(bg), 'background-color was ' + bg);
    });

    await check('a native dialog has a solid background', async () => {
      const bg = await page.evaluate(() => {
        const d = document.getElementById('accountInfo');
        d.showModal();
        const value = getComputedStyle(d).backgroundColor;
        d.close();
        return value;
      });
      r.truthy(opaque(bg), 'background-color was ' + bg);
    });

    console.log('\n\u2500\u2500 dark theme \u2500\u2500');
    await check('a dialog in dark theme is dark, not a white card', async () => {
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
      await page.waitForTimeout(120);
      const seen = await page.evaluate(() => {
        const d = document.getElementById('accountInfo');
        d.showModal();
        const s = getComputedStyle(d);
        const out = { bg: s.backgroundColor, fg: s.color };
        d.close();
        return out;
      });
      r.truthy(opaque(seen.bg), 'background-color was ' + seen.bg);
      r.truthy(lightness(seen.bg) < 0.45, 'dark theme dialog background was ' + seen.bg);
      r.truthy(lightness(seen.fg) > 0.65, 'dark theme dialog text was ' + seen.fg);
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    });

    // ------------------------------------------------------ the suite nav

    console.log('\n\u2500\u2500 the accounting suite nav \u2500\u2500');
    // The row drawer is fixed to the right of the window and covers the nav;
    // Escape must close it, innermost first.
    await check('Escape closes the row drawer', async () => {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
      r.eq(await page.$eval('#rawDrawer', (n) => n.hidden), true);
    });
    await check('every destination has an icon and an accessible name', async () => {
      const nav = await page.$$eval('[data-accounting-suite] a', (links) => links.map((a) => ({
        name: a.textContent.trim(), label: a.dataset.label,
        icon: !!a.querySelector('svg'), current: a.getAttribute('aria-current'),
      })));
      r.truthy(nav.length >= 7, 'got ' + nav.length + ' links');
      r.truthy(nav.every((n) => n.icon), 'every link draws an icon');
      r.truthy(nav.every((n) => n.name && n.name === n.label), 'name and tooltip label agree');
      r.eq(nav.filter((n) => n.current === 'page').map((n) => n.name), ['Transactions'],
        'the active destination is marked');
    });

    await check('compact hides the label visually but keeps it as the name', async () => {
      await page.click('.accounting-suite-compact');
      await page.waitForTimeout(120);
      const compact = await page.$$eval('[data-accounting-suite] a', (links) => links.map((a) => ({
        name: a.textContent.trim(),
        width: a.querySelector('.accounting-suite-text').getBoundingClientRect().width,
      })));
      r.truthy(compact.every((c) => c.width <= 1), 'label widths: ' + compact.map((c) => c.width).join(','));
      r.truthy(compact.every((c) => c.name.length > 0), 'the text node is still in the DOM');
    });

    await check('compact draws its tooltip from data-label, on hover AND keyboard focus', async () => {
      const content = await page.$eval('[data-accounting-suite] a',
        (a) => getComputedStyle(a, '::after').content);
      r.has(content, 'Transactions');
      /* :focus-visible needs focus to ARRIVE by keyboard -- a programmatic
         .focus() right after a click does not match it in Chromium, which is
         the same rule a real keyboard user gets. So: focus the first link,
         then Tab to the second. */
      await page.focus('[data-accounting-suite] a');
      await page.keyboard.press('Tab');
      // The tooltip fades in; wait past the transition rather than racing it.
      await page.waitForTimeout(400);
      const focused = await page.evaluate(() => {
        const a = document.activeElement;
        return { label: a.dataset && a.dataset.label,
          matches: a.matches(':focus-visible'),
          opacity: getComputedStyle(a, '::after').opacity };
      });
      r.eq(focused.label, 'Sales & journals', 'Tab landed on the next destination');
      r.truthy(focused.matches, 'the link is :focus-visible');
      r.eq(focused.opacity, '1');
    });

    await check('toggling back restores the labels', async () => {
      await page.click('.accounting-suite-compact');
      await page.waitForTimeout(120);
      const width = await page.$eval('[data-accounting-suite] .accounting-suite-text',
        (n) => n.getBoundingClientRect().width);
      r.truthy(width > 1, 'label width ' + width);
    });

    console.log('\n\u2500\u2500 touch and small screens \u2500\u2500');
    await check('on a phone the labels show and the compact toggle is not offered', async () => {
      await page.setViewportSize({ width: 390, height: 780 });
      await page.waitForTimeout(200);
      const seen = await page.evaluate(() => ({
        toggleShown: getComputedStyle(document.querySelector('.accounting-suite-compact')).display !== 'none',
        labelWidth: document.querySelector('[data-accounting-suite] .accounting-suite-text').getBoundingClientRect().width,
      }));
      r.eq(seen.toggleShown, false);
      r.truthy(seen.labelWidth > 1, 'label width ' + seen.labelWidth);
    });

    await check('filter controls stay inside a 390px screen with touch-sized targets', async () => {
      const seen = await page.evaluate(() => {
        document.getElementById('codeFilterPanel').hidden = false;
        const rect = document.getElementById('fltMerchant').getBoundingClientRect();
        return { height: rect.height, right: rect.right, inner: window.innerWidth,
          scroll: document.documentElement.scrollWidth };
      });
      r.truthy(seen.height >= 32, 'control height was ' + seen.height);
      r.truthy(seen.right <= seen.inner + 1,
        'right edge ' + seen.right + ' vs viewport ' + seen.inner);
      r.truthy(seen.scroll <= seen.inner + 1, 'page scrolls sideways: ' + seen.scroll);
    });

  } catch (err) {
    r.test('suite ran to completion', () => { throw err; });
  } finally {
    if (page) await page.close();
    await suite.close();
  }

  process.exit(r.summary().fail ? 1 : 0);
})();
