/* How big is this report? (20260907140000)
 *
 * Every SURFACE already handles the 1000-row page cap honestly -- a table
 * tile pages, a chart tile says it hit the cap. What none of them did was
 * tell the AUTHOR, at authoring time, before the report is on somebody's
 * board. Two tiles on prod were already over the cap and nobody could have
 * known without wrapping each query in a count() by hand.
 *
 * The properties that matter here are all about NOT claiming things:
 *   - an unmeasured report must read as unknown, never as small
 *   - a capped preview must never record its page size as the total
 *   - a failed count must persist null rather than a confident 1,000
 *
 * Uses the same 2,500-row fixture as pagination.test.js, so the count and the
 * rows it describes come from one source and cannot drift apart.
 */
'use strict';
const { startSuite } = require('../lib/harness');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { console.log('  ok   ' + n); pass++; } else { console.log('  FAIL ' + n + (x ? '  [' + x + ']' : '')); fail++; } };

(async () => {
  const suite = await startSuite({ viewport: { width: 1440, height: 940 } });
  const { BASE } = suite;

  // ── over the cap: the author is told, and told what a tile will do ──
  {
    const { page: p, errors: errs } = await suite.newPage();
    p.on('pageerror', (e) => errs.push(String(e)));
    await p.goto(`${BASE}/v3/report-builder.html`);
    await p.waitForSelector('.rb-src', { timeout: 15000 });

    await p.click('[data-tab="sql"]');
    await p.fill('#sqlText', 'select n, val from big_series');
    await p.click('#btnPreview');
    await p.waitForFunction(
      () => /2,500 rows/.test(document.getElementById('previewMeta').textContent),
      null, { timeout: 10000 });

    ok('the meta line leads with the true total, not the page size',
      (await p.textContent('#previewMeta')).includes('2,500 rows'));
    ok('...and says how much of it is actually on screen',
      (await p.textContent('#previewMeta')).includes('showing 1,000'));

    const warn = await p.textContent('#previewBody');
    ok('a warning states the size in the preview', /2,500 rows/.test(warn));
    ok('...explains a table can page but a chart cannot',
      /chart or KPI is drawn from the first page alone/.test(warn));
    ok('...and is not phrased as a refusal',
      !/cannot save|refused|not allowed/i.test(warn));

    ok('the count went through the runner as a single wrapped statement',
      await p.evaluate(() => window.__FAKE_DB__.rpcCalls.some((c) =>
        c.name === 'chat_run_readonly_query'
        && /^select count\(\*\) as n from \(/.test(String(c.args.query || '')))));

    // Saving must record the measured total, never the page size.
    await p.click('#btnSave');
    await p.waitForSelector('#saveBackdrop.open', { timeout: 5000 });
    ok('the save dialog repeats the size warning on a NEW report',
      /2,500 rows/.test(await p.textContent('#impactPanel')));
    await p.fill('#saveName', 'Big export');
    await p.click('#btnConfirmSave');
    await p.waitForTimeout(400);

    const saved = await p.evaluate(() =>
      (window.__FAKE_DB__.silo_chat_saved_reports || []).find((r) => r.title === 'Big export') || null);
    ok('row_estimate persists the real total (2500), not the 1000 fetched',
      saved && Number(saved.row_estimate) === 2500,
      saved ? String(saved.row_estimate) : 'report was not inserted');
    ok('row_estimate_at is stamped alongside it', saved && !!saved.row_estimate_at);
    ok('no page errors', errs.length === 0, errs.join(' | '));
  }

  // ── under the cap: exact, no extra query, no warning ──
  {
    const { page: p, errors: errs } = await suite.newPage();
    p.on('pageerror', (e) => errs.push(String(e)));
    await p.goto(`${BASE}/v3/report-builder.html`);
    await p.waitForSelector('.rb-src', { timeout: 15000 });

    await p.click('[data-tab="sql"]');
    await p.fill('#sqlText', 'select product_title, net_sales, units from sales');
    await p.click('#btnPreview');
    await p.waitForFunction(
      () => !/Running/.test(document.getElementById('previewBody').textContent),
      null, { timeout: 10000 });
    await p.waitForTimeout(250);

    ok('a result that fits one page is exact with no count query',
      await p.evaluate(() => !window.__FAKE_DB__.rpcCalls.some((c) =>
        /^select count\(\*\) as n from \(/.test(String(c.args?.query || '')))));
    ok('no size warning on a small report',
      !/A dashboard tile shows/.test(await p.textContent('#previewBody')));
    ok('no page errors', errs.length === 0, errs.join(' | '));
  }

  await suite.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
