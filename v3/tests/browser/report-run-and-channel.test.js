/* Exercise actual v3 report HTML and controls against the usual Supabase fixture. */
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { startSuite, FIXTURES } = require('../lib/harness');

(async () => {
  const suite = await startSuite();
  try {
    const { page, errors } = await suite.newPage();
    const fake = fs.readFileSync(path.join(FIXTURES, 'fake-supabase.js'), 'utf8');
    const extra = `
      const db = window.__FAKE_DB__;
      db.silo_report_channels = [{ company_entity_id: 'C1', channel: 'Recent channel', label: 'Recent channel' }];
      db.silo_chat_saved_reports.push({
        id: 'RUN_CHANNEL', title: 'Sales by Channel', source: 'system', visibility: 'company',
        company_entity_id: null, created_at: '2026-11-20T00:00:00Z',
        queries_run: [
          'select channel, orders from detail where filter = {{channel}}',
          'select channel, orders from breakdown where filter = {{channel}}',
        ],
        columns_metadata: { _queries: [
          { index: 0, title: 'Detail', chart: false },
          { index: 1, title: 'Breakdown', chart: false },
        ] },
        parameters: [{ key: 'channel', type: 'text', label: 'Channel', default: 'all', options_source: 'channel' }],
      });
      window.__runMode = 'ok';
      window.__FAKE_RPC_HANDLERS__ = {
        chat_run_readonly_query: ({ query }) => {
          const failed = window.__runMode === 'fail'
            || (window.__runMode === 'partial' && query.includes('from breakdown'));
          if (failed) return { data: null, error: { message: 'fixture timeout; raw diagnostic' } };
          if (window.__runMode === 'partial') return { data: [], error: null };
          return { data: [{ channel: 'Recent channel', orders: 4 }], error: null };
        },
      };
    `;
    await page.route('**/@supabase/supabase-js**', (r) =>
      r.fulfill({ contentType: 'text/javascript', body: fake + extra }));
    await page.goto(suite.BASE + '/v3/dashboard.html?report=RUN_CHANNEL');
    await page.waitForFunction(() => document.querySelectorAll('#grid table').length === 2);
    const readStatus = () => page.locator('#status').textContent();
    const run = async (mode, pattern) => {
      await page.evaluate((m) => { window.__runMode = m; }, mode);
      await page.click('#btnRefresh');
      await page.waitForFunction(() => !document.getElementById('btnRefresh').disabled);
      assert.match(await readStatus(), pattern);
      assert.equal(await page.isVisible('#status'), true);
    };
    await run('ok', /Queries finished.*not synced/i);
    await run('partial', /Some results could not load \(1 of 2 tiles\)/i);
    assert.match(await page.textContent('#grid'), /No rows/i, 'zero rows is not a query failure');
    assert.equal(await page.locator('#status').evaluate((el) => el.classList.contains('bcn-status--neg')), true);
    await run('fail', /^Results could not load\./);
    assert.doesNotMatch(await readStatus(), /raw diagnostic/i);
    assert.equal(await page.locator('#grid [data-act="retry"]').count(), 2);
    await run('ok', /Queries finished.*not synced/i);
    assert.equal(await page.locator('#grid table').count(), 2, 'retry recovers both tables');

    if (!(await page.isVisible('#slicer_channel'))) await page.click('#btnFilters');
    await page.waitForSelector('#slicer_channel option[value="Recent channel"]', { state: 'attached' });
    const queryCount = () => page.evaluate(() => window.__FAKE_DB__.rpcCalls
      .filter((call) => call.name === 'chat_run_readonly_query').length);
    const n = await queryCount();
    const open = page.getByRole('button', { name: 'Enter a channel name' });
    const field = page.getByRole('textbox', { name: 'Exact channel name' });
    await open.click();
    await field.fill('bad; value');
    await field.press('Enter');
    await page.waitForFunction(() => /Enter an exact channel name/.test(
      document.querySelector('#slicer_channel_manual .v3-slicer-error').textContent));
    assert.equal(await queryCount(), n, 'invalid names do not run a query');
    await field.press('Escape');
    assert.equal(await field.isVisible(), false);
    assert.equal(await queryCount(), n, 'cancel leaves the current report untouched');

    await open.click();
    await field.fill("Retired O'Hare Channel");
    await field.press('Enter');
    await page.waitForFunction(() => window.__FAKE_DB__.rpcCalls
      .some((call) => call.name === 'chat_run_readonly_query'
        && call.args.query.includes("'Retired O''Hare Channel'")));
    assert.equal(await page.inputValue('#slicer_channel'), "Retired O'Hare Channel");
    assert.match(await page.locator('#slicer_channel option:checked').textContent(), /not in recent choices/);

    await page.selectOption('#slicer_channel', 'all');
    await page.waitForFunction(() => window.__FAKE_DB__.rpcCalls
      .filter((call) => call.name === 'chat_run_readonly_query').at(-1)?.args.query.includes("'all'"));
    assert.equal(await page.inputValue('#slicer_channel'), 'all');
    assert.equal(await page.evaluate(() => window.__FAKE_DB__.queryCalls.some((call) => call.op !== 'select')), false);
    assert.deepEqual(errors.filter((e) => !/favicon/.test(e)), []);
    console.log('PASS report run feedback, partial success, failure recovery and historical channels');
  } finally { await suite.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
