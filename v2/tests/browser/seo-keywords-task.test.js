/* /v2/seo-keywords.html's Recommendations tab, "Create SEO task": the draft
 * path that now lives in seo-task-draft.js and is shared with SEO Studio.
 * Nothing is written until confirm, and what is written is a DRAFT under the
 * company's one "SEO Recommendations" project. */
'use strict';
const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');
const R = createReporter('seo-keywords-task');

const CO = 'test-company';
const tables = {
  seo_keyword_set: [{ id: 'k1', company_entity_id: CO, keyword: 'baseball backpacks', keyword_norm: 'baseball backpacks', source: 'manual', is_active: true, priority: 1, created_at: '2026-09-26' }],
  seo_keyword_landscape_v: [], seo_serp_features_v: [], seo_competitor_domains: [], seo_competitor_share_v: [], seo_competitor_page_types_v: [],
  seo_serp_schedules: [], seo_serp_runs: [], seo_serp_provider_tasks: [],
  seo_projects: [{ id: 'proj-1', company_entity_id: CO, name: 'SEO Recommendations', created_at: '2026-09-26T00:00:00Z' }],
  seo_tasks: [],
  seo_recommendations_v: [{
    company_entity_id: CO, opportunity_class: 'page_one_not_top3', class_label: 'Page one, not top 3', keyword_id: 'k1', keyword: 'baseball backpacks',
    keyword_cluster: null, provider: 'dataforseo', device: 'desktop', our_position: 3, our_url: 'https://www.baseballism.com/collections/backpacks?srsltid=AAA',
    our_page_type: 'collection', competitor_domain: 'bl101.com', competitor_url: 'https://www.bl101.com/collections/backpacks', competitor_position: 1,
    competitor_page_type: 'collection', sc_clicks_28d: 30, sc_impressions_28d: 4000, observation_runs: 1, score: 500, evidence_strength: 'moderate',
    suggested_action: 'Page one but not top 3 for "baseball backpacks".',
  }],
};

(async () => {
  const suite = await startSuite();
  try {
    const page = await suite.open('/v2/seo-keywords.html#recommendations', tables, {
      rpc: { can_approve_seo_tasks: true },
      ready: () => !!document.querySelector('#recBody button[data-rec-task]'),
    });
    await page.click('#recBody button[data-rec-task]');
    R.ok('the review panel opens pre-filled', await page.evaluate(() => document.getElementById('dlgRecTask').open && /baseball backpacks/.test(document.getElementById('rtTitle').value)));
    R.eq(await page.evaluate(() => window.__QUERIES__.filter(q => q._op === 'insert').length), 0, 'opening the panel writes nothing');
    await page.click('#btnRtConfirm');
    await page.waitForFunction(() => !document.getElementById('dlgRecTask').open);
    const writes = await page.evaluate(() => window.__QUERIES__.filter(q => q._op === 'insert').map(q => ({ table: q.table, rows: q.rows })));
    R.ok('exactly one write: the task', writes.length === 1 && writes[0].table === 'seo_tasks');
    R.eq(writes[0].rows.project_id, 'proj-1', 'filed under the existing project');
    R.eq(writes[0].rows.approval_status, 'draft');
    R.eq(writes[0].rows.target_url, 'https://www.baseballism.com/collections/backpacks', 'the tracking parameter is stripped');
    R.has(await page.locator('#status').innerText(), 'Draft SEO task created for “baseball backpacks”.');

    // A blank title is refused before anything is written.
    await page.click('#recBody button[data-rec-task]');
    await page.fill('#rtTitle', '   ');
    await page.click('#btnRtConfirm');
    R.ok('a blank title keeps the panel open', await page.evaluate(() => document.getElementById('dlgRecTask').open));
    R.eq(await page.evaluate(() => window.__QUERIES__.filter(q => q._op === 'insert').length), 1, 'no second write');
  } finally {
    await suite.close();
    if (R.summary().fail) process.exitCode = 1;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
