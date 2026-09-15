/* The migration flow, in the real page, on the real module.
 *
 * The unit suite proves the decision table. This one proves the half a unit
 * test cannot reach: that accounting-books.html actually BOOTS far enough to
 * mount it, that a failing table degrades that step to "Unknown" instead of
 * blanking the strip or taking the page down, that the state is legible as
 * text and not only as a colour, and that the panel's jump buttons drive the
 * page's own tabs rather than a second copy of them.
 *
 * Nothing is saved: every read is a select and every click is navigation.
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const r = createReporter('accounting-migration-flow');

/* The live Baseballism position, as fixture rows. */
const FIXTURES = () => ({
  accounting_settings: [{ accounting_start_date: '2026-08-01', accounting_basis: 'Accrual', fiscal_year_start_month: 1, qbo_connection_id: 'conn-1' }],
  accounting_opening_balances: [{ id: 'ob-1', status: 'accepted', accepted_at: '2026-09-14T00:00:00Z', snapshot: { as_of: '2026-07-31', accounting_start_date: '2026-08-01', currency: 'USD', basis: 'Accrual', debits: 1, credits: 1, fetched_at: 'x', lines: [] }, snapshot_hash: 'h' }],
  accounting_accounts: [{ id: 'a1', name: 'Cash', account_type: 'Bank', qbo_account_id: '1', is_active: true }],
  qbo_history_imports: [
    { id: 'h1', period_start: '2026-01-01', period_end: '2026-07-31', exception_count: 71, transaction_count: 22909, created_at: '2026-09-15T03:50:03Z' },
    { id: 'h2', period_start: '2026-01-01', period_end: '2026-07-31', exception_count: 71, transaction_count: 22909, created_at: '2026-09-15T04:11:00Z' },
  ],
  plaid_connections: [{ id: 'p1', institution_name: 'Columbia Bank - Commercial', status: 'active' }],
  plaid_accounts: [{ id: 'pa1', name: 'Checking', mask: '1234', type: 'depository', last_error_code: null }],
  card_sources: [
    { id: 's1', source_key: 'divvy', source_type: 'card', ingest_mode: 'csv', is_active: true, posting_enabled: true },
    { id: 's2', source_key: 'flex', source_type: 'card', ingest_mode: 'csv', is_active: true, posting_enabled: false },
  ],
  card_transactions: Array.from({ length: 10 }, (_, i) => ({ id: 't' + i, coding_source: i < 8 ? 'manual' : null })),
  card_coding_rules: [{ id: 'r1', is_active: true }, { id: 'r2', is_active: true }],
  card_split_rules: [],
  card_import_batches: [
    { id: 'b1', status: 'posted', entry_date: '2026-08-31', period_start: '2026-08-01', period_end: '2026-08-31', row_count: 46 },
    { id: 'b2', status: 'draft', entry_date: '2026-09-30', period_start: '2026-09-01', period_end: '2026-09-30', row_count: 250 },
  ],
  journal_adjustments: [{ id: 'j1', status: 'posted', entry_date: '2026-08-31', memo: 'Shopify sales & payout fees — 2026-08', source_context: 'qbo-reports:GeneralLedger' }],
  shopify_connections: [{ id: 'sc1', shop_domain: 'baseballism.myshopify.com', is_active: true }],
  sales_by_day: [{ day_date: '2026-09-13' }, { day_date: '2026-09-14' }],
  accounting_journal_register: [],
  quickbooks_report_runs: [],
  silo_business_today: ['2026-09-15'],
  can_manage_journal_entries: [true],
  is_exec_or_owner: [true],
  accounting_qbo_connections: [{ id: 'conn-1', company_name: 'Baseballism Inc', environment: 'production', realm_id: '1' }],
});

/* Ready when the flow has drawn — which only happens if the page booted. */
const READY = () => {
  const n = document.getElementById('migrationFlow');
  return !!(n && !n.hidden && n.querySelectorAll('.migration-step').length === 5);
};

const readSteps = () => Array.from(document.querySelectorAll('.migration-step')).map((li) => ({
  classes: li.className,
  name: li.querySelector('.migration-step-name').textContent.trim(),
  state: li.querySelector('.migration-step-state').textContent.trim(),
  summary: li.querySelector('.migration-step-summary').textContent.trim(),
  expanded: li.querySelector('.migration-step-btn').getAttribute('aria-expanded'),
  current: li.querySelector('.migration-step-btn').getAttribute('aria-current'),
}));

(async () => {
  const suite = await startSuite();
  const errors = [];

  async function check(name, fn) {
    try { await fn(); r.ok(name, true); }
    catch (err) { r.ok(name, false, err && err.message ? err.message : String(err)); }
  }

  try {
    let page;
    try {
      page = await suite.open('/v2/accounting-books.html', FIXTURES(), { ready: READY });
    } catch (err) {
      r.ok('accounting-books.html boots and mounts the migration flow', false, err.message.split('\n')[0]);
      console.log(r.summary().fail ? '' : '');
      await suite.close();
      process.exit(1);
    }
    page.on('pageerror', (e) => errors.push(e.message));
    r.ok('accounting-books.html boots and mounts the migration flow', true);

    const steps = await page.evaluate(readSteps);

    await check('five steps render, in migration order, each named', async () => {
      r.eq(steps.map((s) => s.name), [
        'Banks and cards connected',
        'Opening trial balance stored',
        'QuickBooks history retained',
        'Coding and rules in Silo',
        'Revenue journals posted',
      ]);
    });

    await check('each step carries its state as a WORD, not only as a colour', async () => {
      const words = ['Done', 'Needs attention', 'In progress', 'Not started', 'Unknown'];
      for (const s of steps) r.truthy(words.indexOf(s.state) !== -1, `step "${s.name}" showed state "${s.state}"`);
    });

    await check('the fixture position is read correctly end to end', async () => {
      r.eq(steps.map((s) => s.state), ['Done', 'Done', 'Needs attention', 'In progress', 'Done']);
    });

    await check('exactly one step is marked current, and it is the first unfinished one', async () => {
      const current = steps.filter((s) => s.current === 'step');
      r.eq(current.length, 1, 'exactly one current step');
      r.eq(current[0].name, 'QuickBooks history retained');
      const headline = await page.$eval('[data-migration-headline]', (n) => n.textContent);
      r.has(headline, 'Step 3 of 5');
    });

    await check('the current step opens by default and is the only one expanded', async () => {
      r.eq(steps.filter((s) => s.expanded === 'true').length, 1);
      r.eq(steps.find((s) => s.expanded === 'true').name, 'QuickBooks history retained');
    });

    await check('two snapshots of one window are reported once, not added together', async () => {
      const detail = await page.$eval('#migrationDetail', (n) => n.textContent);
      r.has(detail, '71 account exceptions');
      r.not(detail, '142');
      r.has(detail, '22,909', 'ledger lines are not doubled either');
      r.not(detail, '45,818');
    });

    await check('every panel states what its step does not establish', async () => {
      for (const s of steps) {
        await page.click(`.migration-step-btn[data-stage]:nth-of-type(1)`).catch(() => {});
      }
      const limits = [];
      for (const id of ['feeds', 'opening', 'history', 'coding', 'revenue']) {
        await page.click(`.migration-step-btn[data-stage="${id}"]`);
        limits.push(await page.$eval('.migration-limit', (n) => n.textContent.trim()));
      }
      r.eq(limits.length, 5);
      for (const l of limits) r.truthy(l.length > 50, `a step shipped a stub limit: ${l}`);
      r.eq(new Set(limits).size, 5, 'each step states its OWN limit');
    });

    await check('opening a step closes the one before it', async () => {
      await page.click('.migration-step-btn[data-stage="feeds"]');
      const after = await page.evaluate(readSteps);
      r.eq(after.filter((s) => s.expanded === 'true').map((s) => s.name), ['Banks and cards connected']);
    });

    await check('a panel jump drives the page’s own tabs, not a second copy', async () => {
      await page.click('.migration-step-btn[data-stage="history"]');
      await page.click('#migrationDetail [data-jump="history"]');
      const shown = await page.evaluate(() => Array.from(document.querySelectorAll('.books-surface'))
        .filter((s) => !s.hidden).map((s) => s.id));
      r.eq(shown, ['history'], 'the QBO history surface is the one on screen');
      const pressed = await page.$$eval('.books-tabs [data-surface]', (bs) =>
        bs.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.surface));
      r.eq(pressed, ['history'], 'the tab itself reads as pressed');
    });

    /* The methodology note was three permanent lines beside the headline and
       display:none below 560px -- so a desktop reader could not dismiss it and
       a phone reader could not reach it. As a disclosure it is the other way
       round, and both halves of that are worth pinning. */
    await check('how the steps are measured is collapsed on a desktop and still reachable on a phone', async () => {
      const shape = await page.$eval('.migration-note', (n) => ({
        tag: n.tagName, open: n.open, summary: n.querySelector('summary').textContent.trim(),
        text: n.textContent, display: getComputedStyle(n).display,
      }));
      r.eq(shape.tag, 'DETAILS');
      r.eq(shape.open, false, 'it does not sit open');
      r.has(shape.summary, 'How these steps are measured');
      r.has(shape.text, 'never “Done”', 'and it still carries what it always said');
      r.not(shape.display, 'none');
      await page.setViewportSize({ width: 390, height: 900 });
      const phone = await page.$eval('.migration-note', (n) => getComputedStyle(n).display);
      r.not(phone, 'none', 'a phone reader can still open it');
      await page.setViewportSize({ width: 1280, height: 900 });
    });

    await check('the flow is readable in dark theme', async () => {
      const painted = await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'dark');
        const s = getComputedStyle(document.querySelector('.migration-step-btn'));
        const d = getComputedStyle(document.getElementById('migrationDetail'));
        return { btn: s.backgroundColor, btnInk: s.color, panel: d.backgroundColor, panelInk: d.color };
      });
      const light = (v) => {
        if (!v) return null;
        if (v.indexOf('oklch(') === 0) return Number(v.slice(6).trim().split(/[\s)]/)[0]);
        const p = (v.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
        return p.length < 3 ? null : (p[0] + p[1] + p[2]) / (3 * 255);
      };
      for (const [bg, fg, what] of [[painted.btn, painted.btnInk, 'step'], [painted.panel, painted.panelInk, 'panel']]) {
        r.truthy(bg && bg !== 'transparent' && bg.indexOf('rgba(0, 0, 0, 0)') === -1, `${what} background was ${bg}`);
        const a = light(bg); const b = light(fg);
        r.truthy(a != null && b != null, `${what} colours unreadable: ${bg} / ${fg}`);
        r.truthy(Math.abs(a - b) > 0.3, `${what} text too close to its background: ${fg} on ${bg}`);
        r.truthy(a < 0.6, `${what} painted light in dark theme: ${bg}`);
      }
      // Back to light, never to NO theme: silo-chrome always sets one, and an
      // unset data-theme leaves every beacon token undefined (they are declared
      // only inside the two [data-theme] blocks), which is a state the app
      // never occupies and a test must not manufacture.
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    });

    /* Compare the PAINTED rail against the colour the step's state declares
       (--migration-rail on the <li>), never against another step -- comparing
       steps to each other is circular the moment a rule wipes the rail on the
       one being read. Numbers are normalised because a custom property keeps
       the author's "0.20" where the computed colour says "0.2". */
    const NORM = 'v => String(v).trim().replace(/[0-9]*\\.?[0-9]+/g, (n) => String(Number(n)))';

    await check('every step paints the rail its state declares, the open one included', async () => {
      const rails = await page.$$eval('.migration-step', (lis, src) => {
        const norm = eval(src);
        return lis.map((li) => ({
          state: li.querySelector('.migration-step-state').textContent.trim(),
          open: li.classList.contains('is-open'),
          declared: norm(getComputedStyle(li).getPropertyValue('--migration-rail')),
          painted: norm(getComputedStyle(li.querySelector('.migration-step-btn')).borderTopColor),
          width: getComputedStyle(li.querySelector('.migration-step-btn')).borderTopWidth,
        }));
      }, NORM);
      r.eq(rails.filter((x) => x.open).length, 1, 'exactly one step is open');
      for (const x of rails) {
        r.eq(x.width, '3px', `step "${x.state}" drew no rail`);
        r.truthy(x.declared.length > 0, `step "${x.state}" declares no rail colour`);
        r.eq(x.painted, x.declared,
          `step "${x.state}"${x.open ? ' (the OPEN one)' : ''} painted ${x.painted} for a declared ${x.declared}`);
      }
      const byState = new Map(rails.map((x) => [x.state, x.declared]));
      r.truthy(byState.size >= 3, 'the fixture should exercise at least three states');
      r.eq(new Set(byState.values()).size, byState.size, 'two different states declare the same colour');
    });

    await check('the strip reflows 5 → 2 → 1 columns without ever scrolling sideways', async () => {
      for (const [width, columns] of [[1440, 5], [900, 2], [390, 1]]) {
        await page.setViewportSize({ width, height: 840 });
        const at = await page.evaluate(() => {
          const ol = getComputedStyle(document.querySelector('.migration-steps'));
          const btn = getComputedStyle(document.querySelector('.migration-step-btn'));
          return { columns: ol.gridTemplateColumns.split(' ').length, bg: btn.backgroundColor,
            doc: document.documentElement.scrollWidth, vw: window.innerWidth };
        });
        r.eq(at.columns, columns, `at ${width}px the strip drew ${at.columns} columns`);
        r.truthy(at.bg.indexOf('/') === -1 && at.bg !== 'transparent', `step background was ${at.bg} at ${width}px`);
        r.truthy(at.doc <= at.vw + 1, `the page scrolls sideways at ${width}px (${at.doc} > ${at.vw})`);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    });

    await check('the strip stacks rather than overflowing a phone', async () => {
      await page.setViewportSize({ width: 390, height: 780 });
      const box = await page.evaluate(() => {
        const s = document.getElementById('migrationFlow').getBoundingClientRect();
        return { right: s.right, viewport: window.innerWidth, doc: document.documentElement.scrollWidth };
      });
      r.truthy(box.right <= box.viewport + 1, `flow ran to ${box.right} in a ${box.viewport}px viewport`);
      r.truthy(box.doc <= box.viewport + 1, `the page scrolls sideways (${box.doc} > ${box.viewport})`);
      await page.setViewportSize({ width: 1440, height: 900 });
    });

    await check('no page errors while the flow rendered', async () => {
      r.eq(errors, [], errors.join(' / '));
    });

    await page.close();

    /* ---- a table that cannot be read ----------------------------------
       The whole design rests on this: a missing fact must reach the screen
       as "Unknown" and must not be stepped over on the way to a later Done. */
    const page2 = await suite.open('/v2/accounting-books.html', FIXTURES(),
      { ready: READY, broken: ['qbo_history_imports'] });
    const broken = await page2.evaluate(readSteps);

    await check('a table that returns an error degrades ITS step, not the whole flow', async () => {
      r.eq(broken.length, 5, 'the strip still draws every step');
      const history = broken.find((s) => s.name === 'QuickBooks history retained');
      r.eq(history.state, 'Unknown');
      r.eq(broken.find((s) => s.name === 'Opening trial balance stored').state, 'Done',
        'a readable step is unaffected');
    });

    await check('an unreadable step is never stepped over to reach a later Done', async () => {
      const current = broken.filter((s) => s.current === 'step');
      r.eq(current.map((s) => s.name), ['QuickBooks history retained']);
    });

    await page2.close();
  } finally {
    await suite.close();
  }

  const out = r.summary();
  process.exit(out.fail ? 1 : 0);
})();
