/* Pagination past the 1000-row-per-page cap (20260904320000): the report
 * builder's Preview and a dashboard TABLE widget can both fetch further
 * pages and append them, rather than silently stopping at the cap.
 *
 * The real report-builder.html and dashboard.html run unmodified against
 * the real report-builder.js / report-builder-ui.js / dashboard-renderer.js
 * -- only chat_run_readonly_query is faked (fixtures/fake-supabase.js),
 * with a 2,500-row fixture ('select n, val from big_series') sliced by
 * p_offset exactly like the real RPC, so this suite exercises the actual
 * page-1 / page-2 / partial-page-3 lifecycle rather than a mock of it. */
'use strict';
const { startSuite } = require('../lib/harness');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { console.log('  ok   ' + n); pass++; } else { console.log('  FAIL ' + n + (x ? '  [' + x + ']' : '')); fail++; } };

(async () => {
  const suite = await startSuite({ viewport: { width: 1440, height: 940 } });
  const { BASE, ctx } = suite;

  // ── Report builder preview: Load next 1000 rows ─────────────────────
  {
    const { page: p, errors: errs } = await suite.newPage();
    await p.goto(`${BASE}/v3/report-builder.html`);
    await p.waitForSelector('.rb-src', { timeout: 15000 });

    await p.click('[data-tab="sql"]');
    await p.fill('#sqlText', 'select n, val from big_series');
    await p.click('#btnPreview');
    await p.waitForFunction(
      () => !/Running/.test(document.getElementById('previewBody').textContent),
      null, { timeout: 10000 });

    ok('page 1 reports the 1000-row page cap, not the full 2500',
      (await p.textContent('#previewMeta')).includes('1000 row'));
    ok('a full page offers Load more',
      (await p.locator('#btnLoadMorePreview').count()) === 1);
    ok('the RPC was called with p_offset 0 for page 1',
      await p.evaluate(() => {
        const calls = window.__FAKE_DB__.rpcCalls.filter((c) => c.name === 'chat_run_readonly_query');
        return calls[calls.length - 1].args.p_offset === 0;
      }));

    await p.click('#btnLoadMorePreview');
    await p.waitForFunction(
      () => /2000 row/.test(document.getElementById('previewMeta').textContent),
      null, { timeout: 10000 });
    ok('page 2 appended onto page 1 rather than replacing it', true);
    ok('the second page fetch carried p_offset 1000 (rows already loaded)',
      await p.evaluate(() => {
        const calls = window.__FAKE_DB__.rpcCalls.filter((c) => c.name === 'chat_run_readonly_query');
        return calls[calls.length - 1].args.p_offset === 1000;
      }));
    ok('a second full page still offers Load more',
      (await p.locator('#btnLoadMorePreview').count()) === 1);

    await p.click('#btnLoadMorePreview');
    await p.waitForFunction(
      () => /2500 row/.test(document.getElementById('previewMeta').textContent),
      null, { timeout: 10000 });
    ok('the final PARTIAL page (500 rows) completed the set at 2500',
      (await p.textContent('#previewMeta')).includes('2500 row'));
    ok('a partial page ends pagination -- no more Load more',
      (await p.locator('#btnLoadMorePreview').count()) === 0);

    ok('no page errors', errs.length === 0 || (console.log(errs.slice(0, 5)), false));
    await p.close();
  }

  // ── Dashboard table widget: Load more ────────────────────────────────
  {
    const { page: p, errors: errs } = await suite.newPage();
    // Persist the fake DB across navigation: the report saved on the
    // report-builder page has to still exist when we land on the dashboard.
    await p.addInitScript(() => { try { sessionStorage.setItem('__PERSIST_FAKE_DB__', '1'); } catch { /* ignore */ } });

    await p.goto(`${BASE}/v3/report-builder.html`);
    await p.waitForSelector('.rb-src', { timeout: 15000 });
    await p.click('[data-tab="sql"]');
    await p.fill('#sqlText', 'select n, val from big_series');
    await p.click('#btnPreview');
    await p.waitForFunction(
      () => !/Running/.test(document.getElementById('previewBody').textContent), null, { timeout: 10000 });
    await p.click('#btnSave');
    await p.waitForSelector('#saveBackdrop.open');
    await p.fill('#saveName', 'Big series report');
    await p.click('#btnConfirmSave');
    await p.waitForTimeout(400);

    await p.goto(`${BASE}/v3/dashboard.html?id=D1&edit=1`);
    await p.waitForSelector('#btnAddWidget:not([hidden])', { timeout: 10000 });
    await p.click('#btnAddWidget');
    await p.waitForSelector('.v3-report-card');
    await p.click('.v3-report-card:has-text("Big series report")');
    await p.waitForSelector('.dw');

    // The picker recommends a visual off the raw profile; force table since
    // pagination is table-only (see dashboard-renderer.js's header).
    await p.click('.v3-visual-opt:has(input[value="table"])');
    await p.waitForTimeout(250);
    ok('table tile rendered', (await p.locator('.dw-table').count()) === 1);

    ok('page 1 offers Load more with a running count',
      (await p.locator('[data-act="loadmore"]').count()) === 1
      && (await p.textContent('.dw-foot')).includes('1,000 loaded so far'));

    await p.click('[data-act="loadmore"]');
    await p.waitForFunction(
      () => /2,000 loaded so far/.test(document.querySelector('.dw-foot')?.textContent || ''),
      null, { timeout: 10000 });
    ok('a second click appended rather than replaced the first page', true);

    await p.click('[data-act="loadmore"]');
    await p.waitForFunction(
      () => /2,500 rows loaded/.test(document.querySelector('.dw-foot')?.textContent || ''),
      null, { timeout: 10000 });
    ok('the partial third page completed the set at 2,500, and the footer says so rather than going quiet',
      (await p.textContent('.dw-foot')).includes('2,500 rows loaded'));
    ok('...and Load more is gone once there is nothing left to fetch',
      (await p.locator('[data-act="loadmore"]').count()) === 0);

    ok('no page errors', errs.length === 0 || (console.log(errs.slice(0, 5)), false));
    await p.close();
  }

  await suite.close();
  console.log(`\n${pass}/${pass + fail} checks passed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
