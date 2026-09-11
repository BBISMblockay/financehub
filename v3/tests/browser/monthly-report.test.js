'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { startSuite, FIXTURES } = require('../lib/harness');
// Explicitly synthetic review: tests presentation, never production books.
const overview = month => [{ month, focus: 'Profit', result: month === 'August 2026' ? '$50,000 loss' : '$75,000 profit', next_step: 'Review the change with Finance. Confirm the books are closed before sharing.' },
  { month, focus: 'Marketing', result: 'Online sales and ad spend both decreased.', next_step: 'Review launch timing and campaign pacing together. The numbers alone do not establish cause.' },
  { month, focus: 'Coverage', result: 'Historical stock was not returned.', next_step: 'Do not substitute current inventory. Missing rows are not zero activity. '.repeat(5) }];
const extra = {
  "select review where month = '2026-08'": overview('August 2026'),
  "select review where month = '2026-07'": overview('July 2026'),
  'select headlines': [{ revenue: 2500000, margin: 40.8, profit: -50000, previous_profit: 75000 }],
};
const fake = fs.readFileSync(path.join(FIXTURES, 'fake-supabase.js'), 'utf8')
  .replace('const QUERY_ROWS = {', 'const QUERY_ROWS = {' + Object.entries(extra).map(([k,v]) => JSON.stringify(k)+':'+JSON.stringify(v)).join(',') + ',');
(async () => {
  const suite = await startSuite({ extraRoutes: { '**/@supabase/supabase-js**': { body: fake } } });
  try {
    const { page, errors } = await suite.newPage();
    await page.addInitScript(() => {
      sessionStorage.setItem('__PERSIST_FAKE_DB__', '1');
      const report = (id, title, sql, parameters = []) => ({ id, title, source: 'manual', company_entity_id: 'C1', visibility: 'private', created_by: 'U1', queries_run: [sql], parameters });
      const reports = [report('REVIEW', 'What changed — example data', 'select review where month = {{reporting_month}}', [{ key: 'reporting_month', type: 'enum', label: 'Month', default: '2026-08', options: ['2026-08','2026-07'] }]), report('HEAD', 'Financial headlines — example data', 'select headlines')];
      const widget = (id, report_id, title, visual_type, x, y, w, h, visual_config = {}) => ({ id, dashboard_id: 'D1', report_id, query_index: 0, title, visual_type, visual_config, layout: {x,y,w,h}, sort_order: y });
      sessionStorage.setItem('__FAKE_DB_STATE__', JSON.stringify({
        dashboards: [{ id: 'D1', company_entity_id: 'C1', created_by: 'U1', name: 'Monthly review · Example', visibility: 'private', filter_state: { reporting_month: '2026-08' } }],
        silo_chat_saved_reports: reports,
        dashboard_widgets: [widget('K1','HEAD','Revenue','kpi',0,0,4,3,{y_field:'revenue',abbreviate:true,field_semantics:{revenue:'currency'}}), widget('K2','HEAD','Gross margin','kpi',4,0,4,3,{y_field:'margin',field_semantics:{margin:'percent'}}), widget('K3','HEAD','Net profit','kpi',8,0,4,3,{y_field:'profit',compare_field:'previous_profit',compare_label:'Previous month',abbreviate:true,field_semantics:{profit:'currency',previous_profit:'currency'}}),
          widget('S',null,'What changed','section',0,3,12,1),
          widget('T','REVIEW','Three things to know','table',0,4,12,4,{table_layout:'summary',summary_heading:'focus',columns:['focus','result','next_step'],limit:0,sort:'none'})],
      }));
    });
    await page.goto(`${suite.BASE}/v3/dashboard.html?id=D1&view=report`);
    await page.waitForSelector('.dw-summary-card');
    assert.equal(await page.locator('#grid').evaluate(e=>getComputedStyle(e).display), 'grid', 'report mode must activate the flowing layout');
    assert.equal(await page.locator('[gs-id="T"] .dw-body').evaluate(e=>e.scrollHeight>e.clientHeight+2), false, 'the complete summary fits its expanded body');
    assert.equal(await page.locator('.dw-summary-card').count(), 3);
    assert.ok(await page.locator('[gs-id="K3"]').textContent().then(t=>t.includes('-$50k')));
    const boxes = await page.locator('[data-report-kind="kpi"]').evaluateAll(es=>es.map(e=>({ y:e.getBoundingClientRect().y, w:e.getBoundingClientRect().width })));
    assert.ok(boxes.every(b=>Math.abs(b.y-boxes[0].y)<2), 'three KPI cards share a row');
    assert.ok(boxes[0].w>200 && boxes[0].w<450, 'headlines retain readable column width');
    await page.selectOption('#slicer_reporting_month','2026-07');
    await page.waitForFunction(()=>document.querySelector('.dw-summary-list').textContent.includes('$75,000 profit'));
    assert.ok(await page.locator('[gs-id="K1"] .dw-filter-status').count() || await page.locator('[gs-id="K1"]').textContent().then(t=>/not filtered/i.test(t)), 'unfiltered reference stays marked');
    await page.selectOption('#slicer_reporting_month','2026-08');
    await page.waitForFunction(()=>document.querySelector('.dw-summary-list').textContent.includes('$50,000 loss'));
    if (process.env.MONTHLY_REPORT_SCREENSHOT) await page.screenshot({path:process.env.MONTHLY_REPORT_SCREENSHOT,fullPage:true});
    const geo = await page.evaluate(()=>JSON.stringify([...window.__siloDashboard.runtime.layout()]));
    await page.click('#btnReportView');
    await page.click('[data-act="collapse"]');
    assert.equal(await page.locator('[gs-id="T"]').isVisible(),false);
    await page.evaluate(()=>window.dispatchEvent(new Event('beforeprint')));
    await page.emulateMedia({media:'print'});
    assert.equal(await page.locator('#canvas').evaluate(e=>getComputedStyle(e).overflowY),'visible','print cannot clip the canvas');
    assert.equal(await page.locator('[gs-id="T"]').isVisible(),true, 'printing includes collapsed sections');
    assert.equal(await page.locator('.dw-summary-card').last().evaluate(e=>e.scrollHeight>e.clientHeight+2),false);
    await page.emulateMedia({media:'screen'});
    await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')));
    assert.equal(await page.evaluate(()=>JSON.stringify([...window.__siloDashboard.runtime.layout()])),geo);
    await page.click('#btnReportView');
    await page.setViewportSize({width:390,height:844});
    await page.waitForTimeout(300);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
    const mobile = await page.locator('[data-report-kind="kpi"]').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().y));
    assert.ok(mobile[0]<mobile[1] && mobile[1]<mobile[2], 'headlines stack in reading order');
    await page.setViewportSize({width:1440,height:900});
    await page.waitForTimeout(300);
    await page.click('#btnReportView');
    assert.equal(await page.evaluate(()=>JSON.stringify([...window.__siloDashboard.runtime.layout()])),geo, 'report/mobile/desktop round trip preserves saved geometry');
    assert.deepEqual(errors,[]);
    console.log('Monthly review: headline row, long narrative, month refresh, print sections and mobile passed');
  } finally {await suite.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
