/* "Refresh data" on a saved Ask SILO report, end to end on the real page.
 *
 * Ask SILO saves write the model's SQL verbatim, so a literal date in it
 * pinned the report to one window forever. The save dialog now offers to
 * make that window adjustable, which writes {{date_from}} / {{date_to}}
 * into queries_run and declares the two parameters.
 *
 * That rewrite is only safe if every path that RUNS a saved report
 * substitutes those declarations. This suite is the one that would have
 * caught it not doing so (cycle-1 review finding, P2): without the
 * substitution, Refresh data sends unresolved braces to Postgres and the
 * refresh fails on exactly the reports the new save produces.
 *
 * What is asserted against the real page, not a helper:
 *   - a report with declarations reaches chat_run_readonly_query with NO
 *     braces and no frozen date -- the window is the company's calendar
 *   - a report saved before this, with no declarations, is unchanged
 *   - a report whose declarations cannot be resolved reports the error and
 *     never reaches the database
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');
const PAGE = fs.readFileSync(path.join(__dirname, '..', '..', 'silo-chat.html'), 'utf8');

const r = createReporter('ask-silo-saved-report-refresh');

const REPORT = (over) => ({
  id: over.id,
  company_entity_id: 'c1',
  created_by: 'u1',
  created_by_name: 'Blake',
  source: 'ask_silo',
  title: over.title,
  question: 'how did we do last month?',
  answer: 'Net sales were $10.',
  visibility: 'company',
  columns_metadata: null,
  created_at: '2026-10-01T00:00:00Z',
  archived_at: null,
  ...over,
});

(async () => {
  const suite = await startSuite({ viewport: { width: 1280, height: 900 }, secureContext: true });
  await suite.context.route('**/functions/v1/silo-chat', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ answer: 'OK.' }),
  }));

  const page = await suite.open('/v2/silo-chat.html', {
    silo_chat_saved_reports_v: [
      // Saved with the rewrite: tokens, and the declarations that resolve them.
      REPORT({
        id: 'r-adjustable', title: 'Adjustable window',
        queries_run: ['select sum(net_sales) from sales_by_day_verification_v '
          + 'where day_date between {{date_from}} and {{date_to}}'],
        parameters: [
          { key: 'date_from', type: 'date', label: 'From', default: 'prior_month_start', date_basis: 'company' },
          { key: 'date_to', type: 'date', label: 'Through', default: 'prior_month_end', date_basis: 'company' },
        ],
      }),
      // Saved before any of this: plain SQL, no declarations.
      REPORT({
        id: 'r-plain', title: 'Plain report',
        queries_run: ["select sum(net_sales) from sales_by_day_verification_v where day_date >= '2026-09-01'"],
        parameters: null,
      }),
      // Declared but unresolvable: the substitution must refuse it.
      REPORT({
        id: 'r-broken', title: 'Broken declaration',
        queries_run: ['select 1 where d = {{date_from}}'],
        parameters: [{ key: 'date_from', type: 'date', label: 'From', default: 'not_a_token' }],
      }),
    ],
  }, {
    // Record every SQL string that actually reaches the database.
    rpc: {
      chat_run_readonly_query: (args) => {
        window.__SEEN_SQL__ = window.__SEEN_SQL__ || [];
        window.__SEEN_SQL__.push(args && args.query);
        return [{ sum: 10 }];
      },
    },
    ready: () => !!document.getElementById('btnSaved'),
  });

  const refresh = async (title) => {
    await page.evaluate(() => { window.__SEEN_SQL__ = []; });
    await page.click('#btnSaved');
    await page.waitForSelector('.ac-report-card-title');
    await page.click(`.ac-report-card:has-text("${title}")`);
    await page.waitForSelector('#btnRerunReport');
    await page.click('#btnRerunReport');
    await page.waitForTimeout(400);
    const seen = await page.evaluate(() => window.__SEEN_SQL__ || []);
    const html = await page.innerHTML('#rerunResults');
    await page.click('#btnCloseSaved').catch(() => {});
    await page.waitForTimeout(100);
    return { seen, html };
  };

  // The fixture client hands back whole rows whatever the select names, so
  // the one thing it cannot prove is that the READ asks for `parameters`.
  // Against the real PostgREST a column left out of the select is simply
  // absent, and the substitution would then be skipped on every report.
  {
    const sel = PAGE.match(/from\('silo_chat_saved_reports_v'\)[\s\S]{0,200}?\.select\('([^']+)'\)/);
    r.ok('the saved-report read asks for the declarations',
      !!sel && /\bparameters\b/.test(sel[1]), sel ? sel[1] : 'no select found');
    r.ok('and the page loads the shared typed substitution',
      /report-params\.js/.test(PAGE));
  }

  {
    const { seen, html } = await refresh('Adjustable window');
    r.ok('an adjustable report reaches the database once', seen.length === 1, JSON.stringify(seen));
    const sql = seen[0] || '';
    r.ok('with no unresolved token left in it', !/\{\{/.test(sql), sql);
    r.ok('and no date frozen into it', !/\d{4}-\d{2}-\d{2}/.test(sql), sql);
    r.ok('the window is resolved on the company calendar, not the browser\'s',
      /silo_business_today\(\)/.test(sql), sql);
    r.ok('and the rows come back', /10/.test(html), html.slice(0, 200));
  }

  {
    const { seen } = await refresh('Plain report');
    r.ok('a report saved before this runs exactly as it always did',
      seen.length === 1 && /2026-09-01/.test(seen[0]), JSON.stringify(seen));
  }

  {
    const { seen, html } = await refresh('Broken declaration');
    r.ok('an unresolvable declaration never reaches the database', seen.length === 0, JSON.stringify(seen));
    r.ok('and says so instead of failing silently', /ac-rerun-error/.test(html), html.slice(0, 300));
  }

  await suite.close();
  const out = r.summary();
  process.exit(out.fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
