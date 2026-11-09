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
 *   EMAIL_SMS_MUTATION=not-linkable  take launch linking off Klaviyo rows
 *   EMAIL_SMS_MUTATION=link-per-row  link the ROW rather than the message
 *   EMAIL_SMS_MUTATION=no-audience   stop showing a campaign's audience
 *   EMAIL_SMS_MUTATION=usd-always    ignore the account's own currency
 *   EMAIL_SMS_MUTATION=hard-context  let a missing audience column fail the read
 *
 * The audience and currency both come from reads the numbers do not need, on
 * columns a migration adds. The last pass serves the page those columns
 * MISSING, as an unapplied migration would, and the numbers must still show.
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
  'no-audience': ['${esc(m.name)}${audienceLine(m.audience)}', '${esc(m.name)}'],
  'usd-always': ["currency:r._currency||'USD', audience:", "currency:'USD', audience:"],
  'hard-context': [
    "soft('audiences', () => loadPaged(",
    "(async(_l,f)=>f())('audiences', () => loadPaged(",
  ],
  'not-linkable': [
    "const launch=m=>launchCell(m.ref,m.refId,'message');",
    "const launch=m=>m.ref===REDO_REF?launchCell(m.ref,m.refId,'message'):'—';",
  ],
  // A link keyed by the ROW rather than the message gives each conversion
  // metric its own link, so one message links several times over.
  'link-per-row': [
    "const launch=m=>launchCell(m.ref,m.refId,'message');",
    "const launch=m=>launchCell(m.ref,m.id,'message');",
  ],
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
        { company_entity_id:'test-company', kind:'campaign', klaviyo_id:'camp1', connection_id:'kc-eur', message_name:'Klaviyo autumn email',
          parent_name:null, channel:'email', timeframe_start:ago(365), timeframe_end:today,
          conversion_metric_id:'MET1', recipients:1000, conversions:12, conversion_value:1234.56 },
        { company_entity_id:'test-company', kind:'campaign', klaviyo_id:'camp1', connection_id:'kc-eur', message_name:'Klaviyo autumn email',
          parent_name:null, channel:'email', timeframe_start:ago(60), timeframe_end:today,
          conversion_metric_id:'MET1', recipients:100, conversions:1, conversion_value:100 },
        // The same campaign measured against a SECOND conversion metric: a
        // different event, so its own row -- but the same message, so the same
        // launch link.
        { company_entity_id:'test-company', kind:'campaign', klaviyo_id:'camp1', connection_id:'kc-eur', message_name:'Klaviyo autumn email',
          parent_name:null, channel:'email', timeframe_start:ago(60), timeframe_end:today,
          conversion_metric_id:'MET2', recipients:100, conversions:2, conversion_value:50 },
        { company_entity_id:'test-company', kind:'flow_message', klaviyo_id:'fmsg1', connection_id:'kc-old', message_name:'Welcome 2',
          parent_name:'Welcome flow', channel:'sms', timeframe_start:ago(60), timeframe_end:today,
          conversion_metric_id:'MET1', recipients:200, conversions:4, conversion_value:99.5 },
      ],
      // The campaign went to a list and a segment SILO has names for, plus one
      // id it has not synced, and excluded a segment. The unknown id is shown
      // as itself: SILO does not guess what an unsynced id is.
      klaviyo_messages: [
        { company_entity_id:'test-company', kind:'campaign', klaviyo_id:'camp1',
          audiences:{ name:null, included:['L1','S9'], excluded:['S2'] } },
        { company_entity_id:'test-company', kind:'flow_message', klaviyo_id:'fmsg1', audiences:null },
      ],
      klaviyo_audiences: [
        { company_entity_id:'test-company', kind:'list', klaviyo_id:'L1', name:'Newsletter' },
        { company_entity_id:'test-company', kind:'segment', klaviyo_id:'S2', name:'Unengaged 180d' },
      ],
      // One account that reported its currency (accounts:read granted) and one
      // granted before the scope existed, which said nothing.
      klaviyo_connections: [
        { id:'kc-eur', company_entity_id:'test-company', account_currency:'EUR' },
        { id:'kc-old', company_entity_id:'test-company', account_currency:null },
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
    // Four rows: Redo, the flow message, and camp1 once per conversion metric.
    // Windows collapse, metrics do not -- they count different events.
    R.eq(rows, 4, 'the second stored window is the same sends measured again, so it adds no row');
    R.has(body, '1,234.56');
    R.not(body, '1,334.56');
    R.not(body, '1,100');

    // The vendor is on the row, so two vendors' revenue can never read as one.
    R.has(head, 'vendor');
    R.has(body, 'Klaviyo');
    R.has(body, 'Redo');
    // Two rows now carry that name, one per conversion metric.
    const klaviyoRow = await page.locator('#redoBody tr', { hasText:'Klaviyo autumn email' }).first().innerText();
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

    // Both vendors link to a launch, and a Klaviyo link belongs to the
    // MESSAGE: its two conversion-metric rows offer the same link id, so one
    // link covers the message rather than one of its measurements.
    R.eq(await page.locator('[data-link-source="redo_marketing_messages"][data-link-id="campaign:redo-1"]').count(), 1,
      'the Redo message keeps its link control');
    R.eq(await page.locator('[data-link-source="klaviyo_messages"][data-link-id="campaign:camp1"]').count(), 2,
      'both metric rows of one Klaviyo message offer the same link');
    R.eq(await page.locator('[data-link-source="klaviyo_messages"][data-link-id="flow_message:fmsg1"]').count(), 1,
      'the flow message links by its own identity');

    // Who the campaign went to, named, under the campaign's name.
    R.has(klaviyoRow, 'To Newsletter, S9');
    R.has(klaviyoRow, 'not Unengaged 180d');
    const flowRow = await page.locator('#redoBody tr', { hasText:'Welcome 2' }).innerText();
    R.not(flowRow, 'To ', 'a flow message has no audience of its own');

    // Money in the currency Klaviyo said the account is in -- and USD, as
    // before, for the connection that has not said.
    R.has(klaviyoRow, '€1,234.56');
    R.not(klaviyoRow, '$1,234.56');
    R.has(flowRow, '$99.50');

    await page.close();

    // ── the migration not applied yet ──────────────────────────────────
    // Every context column missing, as PostgREST reports it. The numbers
    // still show; only the audience line and the reported currency go.
    const bare = await suite.open('/v2/marketing-overview.html', tables, { ready,
      missingColumns: { klaviyo_messages: ['audiences'], klaviyo_connections: ['account_currency'] } });
    await bare.click('[data-tab="redo"]');
    // Counted first, so a context read that takes the rows down with it fails
    // here, on an assertion, rather than as a locator timeout below.
    R.eq(await bare.locator('#redoBody tr').count(), 4, 'a missing context column must not take the Klaviyo rows with it');
    const bareRow = await bare.locator('#redoBody tr', { hasText:'Klaviyo autumn email' }).first().innerText();
    R.has(bareRow, '1,234.56', 'the numbers do not depend on the audience or currency reads');
    R.not(bareRow, 'To Newsletter');
    R.has(bareRow, '$1,234.56', 'no reported currency: back to USD, exactly as before');
    await bare.close();
  } finally {
    await suite.close();
    if (R.summary().fail) process.exitCode = 1;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
