/* The Custom conversions card, and the reach/frequency columns, on Marketing
 * Performance.
 *
 * What it defends:
 *   1. The card shows the conversion by NAME, with its count, and the campaign
 *      that drove most of it -- the number Blake can read in Ads Manager and,
 *      until 20261104000500, nowhere in SILO.
 *   2. It reads CAMPAIGN level only. Ad-level rows describe the same
 *      conversions over the same spend; loading both would double every count
 *      on the card.
 *   3. The page still loads in full when the view is missing -- the page ships
 *      before the migration is applied, and an empty card is the correct state
 *      in that gap, not a broken Funnel tab.
 *   4. Frequency is RECOMPUTED, never averaged, and reach is never summed: the
 *      same person reached on two days is one person. The campaigns table
 *      shows the biggest single day and that day's own frequency.
 *   5. A database without the reach/frequency columns still loads every KPI
 *      row -- that read is the whole page, so asking for a column it does not
 *      have must cost the two columns and nothing else.
 */
'use strict';
const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');
const R = createReporter('marketing-custom-conversions');

(async () => {
  const suite = await startSuite();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const base = {
      marketing_kpis_daily: [{ id:'kpi-1', company_entity_id:'test-company', platform:'meta_ads', day_date:today, campaign_id:'campaign-1', campaign_name:'Early Bird 2026', spend:100, impressions:1000, clicks:20, conversions:2, conversion_value:200 }],
      v_marketing_mer_daily: [], facebook_page_insights_daily: [], instagram_media_insights: [],
      instagram_account_profile: [], instagram_account_insights_daily: [], facebook_page_posts: [],
      redo_marketing_daily_v: [], meta_ad_performance_daily: [], meta_ad_creatives: [],
      launch_calendar: [], launch_system_links: [], launch_channel_items: [], launch_tasks: [],
      launch_assets: [], launch_comments: [], launch_product_readiness: [], product_tracker: [], profiles: [],
    };
    const conv = (over) => Object.assign({
      id:'cc-1', company_entity_id:'test-company', day_date:today, level:'campaign',
      campaign_name:'Early Bird 2026', conversion_name:'Black Friday 2026 Sign ups',
      custom_conversion_id:'987654321', conversions:207, conversion_value:0,
    }, over);

    const ready = () => document.getElementById('statusText')?.textContent.includes('rows loaded.');

    // ── 1 + 2 ───────────────────────────────────────────────────────────────
    const page = await suite.open('/v2/marketing-overview.html', Object.assign({}, base, {
      meta_custom_conversion_daily_v: [
        conv({}),
        conv({ id:'cc-2', campaign_name:'Retargeting', conversions:41 }),
        // Same conversion at AD level. It must not be added in.
        conv({ id:'cc-3', level:'ad', ad_id:'a1', conversions:999 }),
        conv({ id:'cc-4', conversion_name:null, custom_conversion_id:'111', conversions:3 }),
        // Same display name, different conversion. Names are not unique, so
        // keying the card on the name would merge these two into one row.
        conv({ id:'cc-5', custom_conversion_id:'222', conversion_name:'Black Friday 2026 Sign ups', campaign_name:'Second campaign', conversions:9 }),
      ],
    }), { ready });
    await page.click('[data-tab="funnel"]');
    const body = await page.locator('#customConvBody').innerText();
    R.has(body, 'Black Friday 2026 Sign ups');
    R.has(body, '248', 'campaign-level counts summed (207 + 41), ad level excluded');
    R.not(body, '999', 'the ad-level copy of the same conversion is not added in');
    R.has(body, 'Early Bird 2026', 'top campaign named');
    R.has(body, '111', 'an unnamed conversion still shows, by its id');
    // Two conversions sharing a name stay two rows: merged, the first would
    // read 257 and claim the wrong top campaign.
    R.not(body, '257', 'two conversions with the same name are not merged');
    R.has(body, '9', 'the second same-named conversion has its own row');
    R.eq(await page.locator('#customConvBody tr').count(), 3, 'one row per conversion identity');
    const levels = await page.evaluate(() => window.__QUERIES__
      .filter(q => q.table === 'meta_custom_conversion_daily_v')
      .flatMap(q => (q.filters || []).filter(f => f.col === 'level').map(f => f.val)));
    R.ok('every read asks for campaign level', levels.length > 0 && levels.every(v => v === 'campaign'));
    await page.close();

    // ── 4. Reach and frequency ──────────────────────────────────────────────
    const twoDays = [
      { id:'kpi-a', company_entity_id:'test-company', platform:'meta_ads', day_date:today, campaign_id:'campaign-1', campaign_name:'Early Bird 2026', spend:100, impressions:1000, clicks:20, conversions:2, conversion_value:200, reach:500, frequency:2 },
      { id:'kpi-b', company_entity_id:'test-company', platform:'meta_ads', day_date:'2026-01-01', campaign_id:'campaign-1', campaign_name:'Early Bird 2026', spend:50, impressions:300, clicks:5, conversions:1, conversion_value:60, reach:200, frequency:1.5 },
    ];
    const pageRf = await suite.open('/v2/marketing-overview.html',
      Object.assign({}, base, { marketing_kpis_daily: twoDays }), { ready });
    await pageRf.click('[data-tab="campaigns"]');
    const camp = await pageRf.locator('#campaignBody').innerText();
    R.has(camp, '500', 'the biggest single day\'s reach is shown');
    R.not(camp, '700', 'reach is never summed across days');
    R.has(camp, '2.00', "frequency is that day's impressions / reach");
    await pageRf.close();

    // ── 5. Before the reach/frequency migration ─────────────────────────────
    const old = await suite.open('/v2/marketing-overview.html', base, {
      ready,
      missingColumns: { marketing_kpis_daily: ['reach', 'frequency'], meta_ad_performance_daily: ['reach', 'frequency'] },
    });
    R.has(await old.textContent('#statusText'), 'rows loaded.', 'the page still loads without the new columns');
    await old.click('[data-tab="campaigns"]');
    R.has(await old.locator('#campaignBody').innerText(), 'Early Bird 2026', 'campaign rows still render');
    await old.close();

    // ── 3. The view missing entirely ────────────────────────────────────────
    const page2 = await suite.open('/v2/marketing-overview.html', base, { ready });
    await page2.click('[data-tab="funnel"]');
    R.has(await page2.locator('#customConvBody').innerText(), 'No custom conversions');
    R.has(await page2.textContent('#statusText'), 'rows loaded.', 'the rest of the page still loaded');
    await page2.close();

  } finally {
    await suite.close();
    if (R.summary().fail) process.exitCode = 1;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
