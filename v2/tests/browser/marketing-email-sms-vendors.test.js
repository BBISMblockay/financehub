/* The Email & SMS tab on the real Marketing Performance page, with two
 * vendors in it.
 *
 * Why this suite exists: that tab was Redo's alone, and Klaviyo measures the
 * same kind of thing differently. Two failures are easy to ship and invisible
 * on screen -- a Klaviyo message appearing once per stored measurement window
 * (the same sends counted twice), and the two vendors' revenue reading as one
 * number a person could add up. Both are asserted here.
 *
 * Mutations (each must fail at least one assertion):
 *   EMAIL_SMS_MUTATION=sum-windows   keep every Klaviyo window, not the widest
 *   EMAIL_SMS_MUTATION=no-vendor     drop the Vendor column
 *   EMAIL_SMS_MUTATION=redo-wording  put Redo back in the table's own wording
 */
'use strict';
const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');
const assert = require('node:assert/strict');
const R = createReporter('marketing-email-sms-vendors');

// Each mutation breaks one guard in the REAL page, served broken to the
// browser. A mutation that leaves the suite green means the guard is untested.
const MUTATIONS = {
  'sum-windows': [
    'const key=`${r.kind}:${r.klaviyo_id}:${r.channel||\'\'}:${r.conversion_metric_id||\'\'}`;',
    'const key=`${r.kind}:${r.klaviyo_id}:${r.channel||\'\'}:${r.conversion_metric_id||\'\'}:${r.timeframe_start}`;',
  ],
  'no-vendor': ['<th>Vendor</th>', ''],
  'redo-wording': ['<h2>Email &amp; SMS messages</h2>', '<h2>Redo email &amp; SMS messages</h2>'],
};
const MUT = process.env.EMAIL_SMS_MUTATION || '';
assert.ok(!MUT || MUTATIONS[MUT], `Unknown mutation ${MUT}`);
const transform = (rel, source) => {
  if (!MUT || !rel.endsWith('/marketing-overview.html')) return source;
  const [from, to] = MUTATIONS[MUT];
  assert.ok(source.includes(from), `mutation ${MUT}: pattern missing`);
  return source.split(from).join(to);
};

(async () => {
  const suite = await startSuite({ transform });
  try {
    const today = new Date().toISOString().slice(0, 10);
    const ago = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
    const tables = {
      marketing_kpis_daily: [], v_marketing_mer_daily: [], facebook_page_insights_daily: [],
      instagram_media_insights: [], instagram_account_profile: [], instagram_account_insights_daily: [],
      facebook_page_posts: [], meta_ad_performance_daily: [], meta_ad_creatives: [],
      launch_calendar: [], launch_system_links: [], launch_channel_items: [], launch_tasks: [],
      launch_assets: [], launch_comments: [], launch_product_readiness: [], product_tracker: [], profiles: [],
      redo_marketing_daily_v: [
        { company_entity_id:'test-company', kind:'campaign', redo_id:'redo-1', name:'Redo autumn email',
          channel:'EMAIL', day_date:today, sends:500, orders:4, revenue:190, revenue_currency:'USD' },
      ],
      // The SAME Klaviyo campaign, measured over two windows that both end in
      // range: a year from a backfill and 60 days from the nightly. One
      // measurement must reach the table, the widest, and its revenue must be
      // that window's -- never 1234.56 + 100.
      klaviyo_message_performance_v: [
        { company_entity_id:'test-company', kind:'campaign', klaviyo_id:'camp1', message_name:'Klaviyo autumn email',
          parent_name:null, channel:'email', timeframe_start:ago(365), timeframe_end:today,
          conversion_metric_id:'MET1', recipients:1000, conversions:12, conversion_value:1234.56 },
        { company_entity_id:'test-company', kind:'campaign', klaviyo_id:'camp1', message_name:'Klaviyo autumn email',
          parent_name:null, channel:'email', timeframe_start:ago(60), timeframe_end:today,
          conversion_metric_id:'MET1', recipients:100, conversions:1, conversion_value:100 },
        { company_entity_id:'test-company', kind:'flow_message', klaviyo_id:'fmsg1', message_name:'Welcome 2',
          parent_name:'Welcome flow', channel:'sms', timeframe_start:ago(60), timeframe_end:today,
          conversion_metric_id:'MET1', recipients:200, conversions:4, conversion_value:99.5 },
      ],
    };
    const ready = () => document.getElementById('statusText')?.textContent.includes('rows loaded.');
    const page = await suite.open('/v2/marketing-overview.html', tables, { ready });
    await page.click('[data-tab="redo"]');
    const body = await page.locator('#redoBody').innerText();
    // The header is upper-cased by the stylesheet, so compare in one case.
    const head = (await page.locator('[data-panel="redo"] thead').innerText()).toLowerCase();
    const card = await page.locator('[data-panel="redo"]').innerText();

    R.has(body, 'Redo autumn email');
    R.has(body, 'Klaviyo autumn email');
    R.has(body, 'Welcome 2');

    // One row per Klaviyo message, whatever windows are stored.
    const rows = await page.locator('#redoBody tr').count();
    R.eq(rows, 3, 'three messages, not four: the second stored window is the same sends measured again');
    R.has(body, '1,234.56');
    R.not(body, '1,334.56');
    R.not(body, '1,100');

    // The vendor is on the row, so two vendors' revenue can never read as one.
    R.has(head, 'vendor');
    R.has(body, 'Klaviyo');
    R.has(body, 'Redo');
    const klaviyoRow = await page.locator('#redoBody tr', { hasText:'Klaviyo autumn email' }).innerText();
    R.has(klaviyoRow, 'Klaviyo');
    R.has(klaviyoRow, 'MET1');
    const redoRow = await page.locator('#redoBody tr', { hasText:'Redo autumn email' }).innerText();
    R.has(redoRow, 'Redo');

    // The table's own wording belongs to neither vendor, and the caveat names
    // the mistake rather than one vendor's version of it.
    const title = await page.locator('[data-panel="redo"] .bcn-card-header h2').innerText();
    R.not(title, 'Redo');
    R.not(head, 'attributed by redo');
    R.has(card, 'Never add two vendors');

    // Launch linking is Redo's; a Klaviyo row says so instead of offering an
    // inert control.
    R.eq(await page.locator('[data-link-source="redo_marketing_messages"]').count(), 1,
      'only the Redo message is linkable');

    await page.close();
  } finally {
    await suite.close();
    if (R.summary().fail) process.exitCode = 1;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
