/* A report whose queries are PARTS of one answer (columns_metadata._queries)
 * opens as one titled tile per part, in order, each with its own chart
 * unless it declares none. Its tables use the report's own column labels,
 * a thumbnail opens the report's named preview link, and a photo that is
 * missing -- or that fails to load, like an expired Meta link -- becomes the
 * same "No image" placeholder. */
'use strict';
const assert = require('assert/strict');
const { startSuite } = require('../lib/harness');

// 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const suite = await startSuite();
  try {
    await suite.ctx.route('**/img/ok.png', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
    await suite.ctx.route('**/img/expired.jpg', (r) => r.fulfill({ status: 403, contentType: 'text/plain', body: 'URL signature expired' }));
    const { page, errors } = await suite.newPage();
    await page.addInitScript(() => {
      if (sessionStorage.getItem('__SEEDED__')) return;
      sessionStorage.setItem('__SEEDED__', '1');
      sessionStorage.setItem('__PERSIST_FAKE_DB__', '1');
      const origin = location.origin;
      sessionStorage.setItem('__FAKE_DB_STATE__', JSON.stringify({
        silo_chat_saved_reports: [{
          id: 'CP', title: 'Creative Performance', question: null, description: 'By platform, campaign and ad.',
          source: 'system', company_entity_id: null, visibility: 'company', created_at: '2026-09-25T00:00:00Z',
          queries_run: ['select platform, spend from parts_platform', 'select campaign, spend from parts_campaign',
            'select thumbnail, ad, ad_preview, spend from parts_ads'],
          parameters: [],
          columns_metadata: {
            _queries: [{ index: 0, title: 'By platform', chart: false }, { index: 1, title: 'By campaign' },
              { index: 2, title: 'By ad / creative', chart: false }],
            thumbnail: { label: 'Creative', semantic: 'image', link_column: 'ad_preview' },
            ad_preview: { label: 'Meta Preview', semantic: 'link' },
            campaign: { label: 'Campaign', semantic: 'category', chart_dimension: true },
            spend: { label: 'Spend', semantic: 'currency', chart_primary: true },
          },
        }],
        dashboards: [], dashboard_widgets: [],
        profiles: [{ id: 'U1', name: 'Blake', email: 'blake@baseballism.com', role: 'owner' }],
      }));
      sessionStorage.setItem('__FAKE_QUERY_PREFIXES__', JSON.stringify([
        { prefix: 'select platform, spend from parts_platform', rows: [{ platform: 'meta_ads', spend: 300 }, { platform: 'google_ads', spend: 20 }] },
        { prefix: 'select campaign, spend from parts_campaign', rows: [{ campaign: 'Fall drop', spend: 200 }, { campaign: 'Brand', spend: 120 }] },
        { prefix: 'select thumbnail, ad, ad_preview, spend from parts_ads', rows: [
          { thumbnail: `${origin}/img/ok.png`, ad: 'Hero video', ad_preview: 'https://fb.me/preview1', spend: 200 },
          { thumbnail: `${origin}/img/expired.jpg`, ad: 'Carousel', ad_preview: 'https://fb.me/preview2', spend: 100 },
          { thumbnail: null, ad: 'Brand search', ad_preview: null, spend: 20 },
        ] },
      ]));
    });
    await page.goto(`${suite.BASE}/v3/dashboard.html?report=CP`);
    await page.waitForSelector('[gs-id="preview-q2-table"] table');

    const tiles = await page.evaluate(() => window.__siloDashboard.runtime.getWidgets()
      .map((w) => [w.id, w.title, w.query_index]));
    assert.deepEqual(tiles, [
      ['preview-q0-table', 'By platform', 0],
      ['preview-q1-chart', 'By campaign', 1],
      ['preview-q1-table', 'By campaign', 1],
      ['preview-q2-table', 'By ad / creative', 2],
    ], 'every declared part, in order, chart only where declared');

    const heads = await page.$$eval('[gs-id="preview-q2-table"] thead .dw-th-label', (els) => els.map((e) => e.textContent));
    assert.deepEqual(heads, ['Creative', 'Ad', 'Meta Preview', 'Spend'], 'report labels name the headers');

    const ads = page.locator('[gs-id="preview-q2-table"] tbody tr');
    assert.equal(await ads.nth(0).locator('a:has(img.dw-thumb)').getAttribute('href'), 'https://fb.me/preview1',
      'the thumbnail opens the full preview');
    await page.waitForFunction(() =>
      document.querySelectorAll('[gs-id="preview-q2-table"] tbody tr:nth-child(2) .dw-thumb--none').length === 1);
    assert.equal(await ads.nth(1).locator('img').count(), 0, 'a photo that failed to load is replaced');
    assert.equal(await ads.nth(2).locator('.dw-thumb--none').count(), 1, 'a missing photo is a placeholder');
    assert.equal(await ads.nth(0).locator('img.dw-thumb').count(), 1, 'a good photo stays');

    assert.deepEqual(errors.filter((e) => !/favicon|expired\.jpg|403/.test(e)), [], 'no page errors');
    console.log('  ok   report parts: titled tile per query, labels, preview link, image fallbacks');
  } finally { await suite.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
