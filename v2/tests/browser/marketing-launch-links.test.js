/* The real Marketing Performance and Launch Workbench pages, with an isolated
 * Supabase fixture. Check the association written and both navigation paths. */
'use strict';
const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');
const R = createReporter('marketing-launch-links');

(async () => {
  const suite = await startSuite();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const link = { id:'link-1', launch_id:'launch-1', company_entity_id:'test-company',
      link_type:'campaign', ref_table:'meta_ad_creatives', ref_id:'ad-1', ref_label:'Sonic video' };
    const tables = {
      marketing_kpis_daily: [{id:'kpi-1',company_entity_id:'test-company',platform:'meta_ads',day_date:today,campaign_id:'campaign-1',campaign_name:'Sonic campaign',spend:100,impressions:1000,clicks:20,conversions:2,conversion_value:200}], v_marketing_mer_daily: [], instagram_media_insights: [], facebook_page_insights_daily: [],
      redo_marketing_daily_v: [{company_entity_id:'test-company',kind:'campaign',redo_id:'redo-1',name:'Sonic email',channel:'EMAIL',day_date:today,sends:500,orders:4,revenue:190,revenue_currency:'USD'}],
      meta_ad_performance_daily: [
        { id:'perf-1', company_entity_id:'test-company', day_date:today, ad_id:'ad-1', ad_name:'Sonic video', campaign_name:'Sonic', spend:100, impressions:1000, clicks:20, conversions:2, conversion_value:200 },
        { id:'perf-2', company_entity_id:'test-company', day_date:today, ad_id:'ad-2', ad_name:'Other ad', campaign_name:'Other', spend:50, impressions:500, clicks:10, conversions:1, conversion_value:60 },
      ],
      meta_ad_creatives: [
        { company_entity_id:'test-company', ad_id:'ad-1', ad_name:'Sonic video', effective_status:'ACTIVE' },
        { company_entity_id:'test-company', ad_id:'ad-2', ad_name:'Other ad', effective_status:'ACTIVE' },
      ],
      launch_calendar: [
        { id:'launch-1', company_entity_id:'test-company', title:'Sonic launch', launch_date:today, status:'planned', launch_readiness:'not_reviewed' },
        { id:'other-company-launch', company_entity_id:'other-company', title:'Private launch', launch_date:today },
      ],
      launch_system_links: [], launch_channel_items: [], launch_tasks: [], launch_assets: [],
      launch_comments: [], launch_product_readiness: [], product_tracker: [], profiles: [],
    };
    const ready = () => document.getElementById('statusText')?.textContent.includes('rows loaded.');
    const page = await suite.open('/v2/marketing-overview.html', tables, { ready });
    await page.click('[data-tab="creatives"]');
    R.ok('creative has Link control', await page.locator('[data-link-source="meta_ad_creatives"][data-link-id="ad-1"]').count() === 1);
    await page.click('[data-link-source="meta_ad_creatives"][data-link-id="ad-1"]');
    R.has(await page.textContent('#creativeLaunchSelect'), 'Sonic launch');
    R.not(await page.textContent('#creativeLaunchSelect'), 'Private launch');
    await page.click('#creativeLaunchSave');
    await page.waitForFunction(() => !document.getElementById('creativeLaunchDialog').open);
    const writes = await page.evaluate(() => window.__QUERIES__.filter(q => q.table === 'launch_system_links' && q._op === 'insert').map(q => q.rows));
    R.eq(writes.length, 1, 'one link written');
    R.eq(writes[0].company_entity_id, 'test-company', 'company scoped');
    R.eq(writes[0].ref_table, 'meta_ad_creatives', 'exact source');
    R.eq(writes[0].ref_id, 'ad-1', 'exact ad id');
    R.eq(writes[0].launch_id, 'launch-1', 'selected launch');
    R.has(await page.locator('#creativeBody').innerText(), 'Sonic launch');
    R.ok('creative links to launch drawer', (await page.locator('#creativeBody a[href*="launch=launch-1"]').count()) === 1);
    await page.click('[data-tab="campaigns"]');
    await page.click('[data-link-source="marketing_kpis_daily"][data-link-id="campaign-1"]');
    await page.click('#creativeLaunchSave');
    await page.waitForFunction(() => !document.getElementById('creativeLaunchDialog').open);
    await page.click('[data-tab="redo"]');
    R.has(await page.locator('#redoBody').innerText(),'Sonic email');
    await page.click('[data-link-source="redo_marketing_messages"][data-link-id="campaign:redo-1"]');
    await page.click('#creativeLaunchSave');
    await page.waitForFunction(() => !document.getElementById('creativeLaunchDialog').open);
    const allWrites=await page.evaluate(()=>window.__QUERIES__.filter(q=>q.table==='launch_system_links'&&q._op==='insert').map(q=>q.rows));
    R.eq(allWrites.length,3,'three source associations written');
    R.eq(allWrites[1].ref_id,'campaign-1','campaign ID retained');
    R.eq(allWrites[2].ref_id,'campaign:redo-1','Redo kind and ID retained');
    R.eq(allWrites[2].company_entity_id,'test-company','Redo link company scoped');
    await page.close();

    tables.launch_system_links = [link,
      {id:'link-2',launch_id:'launch-1',company_entity_id:'test-company',link_type:'campaign',ref_table:'marketing_kpis_daily',ref_id:'campaign-1',ref_label:'Sonic campaign'},
      {id:'link-3',launch_id:'launch-1',company_entity_id:'test-company',link_type:'campaign',ref_table:'redo_marketing_messages',ref_id:'campaign:redo-1',ref_label:'Sonic email'},
    ];
    const launch = await suite.open('/v2/launch-calendar.html?launch=launch-1', tables, {
      ready: () => document.getElementById('page-status')?.textContent.includes('Ready.'),
    });
    await launch.waitForSelector('#lc2-summary');
    R.has(await launch.locator('#lc2-summary').innerText(), 'Linked marketing (3)');
    R.ok('launch links to exact creative', (await launch.locator('#lc2-summary a[href*="ad=ad-1"]').count()) === 1);
    R.ok('launch links to exact campaign',(await launch.locator('#lc2-summary a[href*="campaign=campaign-1"]').count())===1);
    R.ok('launch links to exact Redo message',(await launch.locator('#lc2-summary a[href*="redo=campaign%3Aredo-1"]').count())===1);
    await launch.close();

    const focused = await suite.open('/v2/marketing-overview.html?ad=ad-1', tables, { ready });
    R.ok('deep link opens Creatives tab', await focused.locator('[data-panel="creatives"]').isVisible());
    R.has(await focused.locator('#creativeBody').innerText(), 'Sonic video');
    R.not(await focused.locator('#creativeBody').innerText(), 'Other ad');
    await focused.click('[data-link-source="meta_ad_creatives"][data-link-id="ad-1"]');
    R.ok('same launch cannot be linked twice', await focused.locator('#creativeLaunchSave').isDisabled());
    await focused.click('#creativeLaunchCancel');
    await focused.click('#clearCreativeFocus');
    R.has(await focused.locator('#creativeBody').innerText(), 'Other ad');
    await focused.close();

    const focusedCampaign=await suite.open('/v2/marketing-overview.html?campaign=campaign-1',tables,{ready});
    R.ok('campaign deep link opens Campaigns',await focusedCampaign.locator('[data-panel="campaigns"]').isVisible());
    R.has(await focusedCampaign.locator('#campaignBody').innerText(),'Sonic campaign');
    await focusedCampaign.click('[data-link-source="marketing_kpis_daily"][data-link-id="campaign-1"]');
    R.ok('campaign duplicate excluded',await focusedCampaign.locator('#creativeLaunchSave').isDisabled());
    await focusedCampaign.close();

    const focusedMessage=await suite.open('/v2/marketing-overview.html?redo=campaign%3Aredo-1',tables,{ready});
    R.ok('Redo deep link opens Email & SMS',await focusedMessage.locator('[data-panel="redo"]').isVisible());
    R.has(await focusedMessage.locator('#redoBody').innerText(),'Sonic email');
    await focusedMessage.click('[data-link-source="redo_marketing_messages"][data-link-id="campaign:redo-1"]');
    R.ok('Redo duplicate excluded',await focusedMessage.locator('#creativeLaunchSave').isDisabled());
    await focusedMessage.close();
  } finally {
    await suite.close();
    if (R.summary().fail) process.exitCode = 1;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
