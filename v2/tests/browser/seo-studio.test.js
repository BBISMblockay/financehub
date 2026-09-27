/* The real /v2/seo-studio.html with a fake Supabase: the queue, one page's
 * detail, and every write the page can make.
 *
 * Fixture values are shaped on production's own 2026-09-26 rank check and
 * Search Console data for Baseballism's backpacks collection, because that is
 * the case the page was designed around. What is asserted is what a person
 * reads and what the page WRITES -- not the DOM's structure. */
'use strict';
const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');
const R = createReporter('seo-studio');

const CO = 'test-company';
const SITE = 'https://www.baseballism.com';
const BP_COL = 'gid://shopify/Collection/1';
const CAPS_COL = 'gid://shopify/Collection/2';
const LONG_DESC = 'Baseballism Backpack Collection\nBuilt for Ballplayers. Designed for Battle.\n\n' + 'The Baseballism Backpack Collection is where diamond heritage meets everyday grind. '.repeat(26);
const XSS = '<img src=x onerror="window.__PWNED__=1">Evil Bags';

const results = (ownPos, ownTitle) => [
  { position: 1, domain: 'www.bl101.com', url: 'https://www.bl101.com/collections/backpacks', title: 'Baseball Backpacks & Bags | BL101', result_type: 'organic', is_own_domain: false },
  { position: 2, domain: 'easton.rawlings.com', url: 'https://easton.rawlings.com/easton/bags/', title: XSS, result_type: 'organic', is_own_domain: false },
  { position: ownPos, domain: 'www.baseballism.com', url: `${SITE}/collections/backpacks?srsltid=AAA`, title: ownTitle, result_type: 'organic', is_own_domain: true },
  { position: 9, domain: 'cheapbats.com', url: 'https://cheapbats.com/x', title: 'Bat Packs', result_type: 'organic', is_own_domain: false },
];

const rec = (o) => Object.assign({
  company_entity_id: CO, opportunity_class: 'page_one_not_top3', class_label: 'Page one, not top 3', keyword_id: null, keyword_cluster: null,
  provider: 'dataforseo', location_name: 'United States', our_page_type: 'collection', competitor_domain: 'bl101.com',
  competitor_url: 'https://www.bl101.com/collections/backpacks', competitor_position: 1, competitor_page_type: 'collection',
  search_console_avg_position_28d: 6.7, observation_runs: 1, movement: null, is_at_risk: false, observed_single_run: true,
  suggested_action: 'Page one but not top 3 for this keyword.', paa_questions: null,
}, o);

const tables = {
  seo_recommendations_v: [
    rec({ keyword: 'baseball backpacks', device: 'desktop', our_position: 3, our_url: `${SITE}/collections/backpacks?srsltid=AAA`, sc_clicks_28d: 30, sc_impressions_28d: 4000, score: 500, evidence_strength: 'strong' }),
    rec({ keyword: 'baseball backpack', device: 'mobile', our_position: 4, our_url: `${SITE}/collections/backpacks?srsltid=BBB`, sc_clicks_28d: 12, sc_impressions_28d: 3000, score: 300, evidence_strength: 'moderate' }),
    rec({ keyword: 'caps', device: 'desktop', our_position: 4, our_url: `${SITE}/collections/caps`, sc_clicks_28d: 46, sc_impressions_28d: 18074, score: 400, evidence_strength: 'moderate', competitor_domain: 'lids.com' }),
    rec({ opportunity_class: 'absent_with_demand', keyword: 'baseball gifts for boys', device: 'desktop', our_position: null, our_url: null, our_page_type: null, sc_clicks_28d: 0, sc_impressions_28d: 900, score: 90, evidence_strength: 'early', suggested_action: 'Demand exists and no page of ours ranks.' }),
  ],
  seo_keyword_landscape_v: [
    { company_entity_id: CO, keyword: 'baseball backpacks', device: 'desktop', provider: 'dataforseo', latest_observed_on: '2026-09-26', our_serp_position: 3, latest_top_results: results(3, 'Backpacks | Baseballism Online') },
    { company_entity_id: CO, keyword: 'baseball backpack', device: 'mobile', provider: 'dataforseo', latest_observed_on: '2026-09-26', our_serp_position: 4, latest_top_results: results(4, 'Backpacks | Baseballism Online') },
    { company_entity_id: CO, keyword: 'caps', device: 'desktop', provider: 'dataforseo', latest_observed_on: '2026-09-26', our_serp_position: 4,
      latest_top_results: [{ position: 1, domain: 'lids.com', url: 'https://www.lids.com/caps', title: 'Caps | Lids', result_type: 'organic' },
        { position: 2, domain: 'evil.example', url: 'javascript:window.__CLICKED__=1', title: 'Not a link', result_type: 'organic' },
        { position: 4, domain: 'www.baseballism.com', url: `${SITE}/collections/caps`, title: 'Caps | Baseballism Online', result_type: 'organic', is_own_domain: true }] },
  ],
  search_console_site_daily: [{ company_entity_id: CO, day_date: '2026-09-24' }],
  search_console_page_daily: [
    { company_entity_id: CO, page_path: '/collections/backpacks', day_date: '2026-09-20', clicks: 40, impressions: 7000, position: 6.0 },
    { company_entity_id: CO, page_path: '/collections/backpacks', day_date: '2026-09-24', clicks: 38, impressions: 6796, position: 7.42 },
    // Outside the 28-day window: must not be counted.
    { company_entity_id: CO, page_path: '/collections/backpacks', day_date: '2026-08-01', clicks: 999, impressions: 99999, position: 1 },
  ],
  seo_tasks: [], seo_task_publications: [], page_inspections: [],
  // The company's one "SEO Recommendations" project already exists (created
  // by the SEO Keywords tab); a draft must be filed under it, never a second.
  seo_projects: [{ id: 'proj-1', company_entity_id: CO, name: 'SEO Recommendations', created_at: '2026-09-26T00:00:00Z' }],
  shopify_collections: [
    { company_entity_id: CO, shopify_collection_id: BP_COL, handle: 'backpacks', title: 'Backpacks', description: '<p>Built for ballplayers.</p>', seo_title_override: null, seo_description_override: LONG_DESC, products_count: 19, missing_since: null, updated_at: '2026-09-26' },
    { company_entity_id: CO, shopify_collection_id: CAPS_COL, handle: 'caps', title: 'Caps', description: '', seo_title_override: null, seo_description_override: null, products_count: 46, missing_since: null, updated_at: '2026-09-26' },
  ],
  shopify_collection_products: [
    { company_entity_id: CO, shopify_collection_id: BP_COL, shopify_product_id: 'p1', position: 1, missing_since: null },
    { company_entity_id: CO, shopify_collection_id: BP_COL, shopify_product_id: 'p2', position: 2, missing_since: null },
    { company_entity_id: CO, shopify_collection_id: BP_COL, shopify_product_id: 'p4', position: 3, missing_since: null },
    { company_entity_id: CO, shopify_collection_id: CAPS_COL, shopify_product_id: 'p3', position: 1, missing_since: null },
  ],
  products_master: [
    // p2 is the newest LIVE release, so it leads although Shopify sorts it
    // second; p4 is newer still but a draft, so it is not on the website.
    { company_entity_id: CO, shopify_product_id: 'p1', product_title: 'Ronin Backpack - Angler Camo', image_url: 'https://cdn.shopify.com/ronin-camo.jpg', shopify_status: 'active', online_published_at: '2025-04-01T00:00:00Z' },
    { company_entity_id: CO, shopify_product_id: 'p2', product_title: 'Ronin Backpack - Bat Bros', image_url: 'https://cdn.shopify.com/ronin-batbros.jpg', shopify_status: 'active', online_published_at: '2026-09-10T00:00:00Z' },
    { company_entity_id: CO, shopify_product_id: 'p4', product_title: 'Ronin Backpack - Unreleased', image_url: 'https://cdn.shopify.com/ronin-draft.jpg', shopify_status: 'draft', online_published_at: '2026-09-20T00:00:00Z' },
    { company_entity_id: CO, shopify_product_id: 'p3', product_title: 'Cactus Rope Cap', image_url: 'javascript:alert(1)' },
  ],
};

(async () => {
  const suite = await startSuite();
  try {
    const ready = () => !!document.querySelector('.ss-detail .ss-rec, .ss-detail .ss-empty');
    const page = await suite.open('/v2/seo-studio.html', tables, { ready });

    const queue = await page.locator('#queue').innerText();
    const cards = page.locator('#queue [data-key]');
    R.eq(await cards.count(), 3, 'three queue entries: two pages and one needs-a-page');
    const first = await cards.nth(0).innerText();
    R.has(first, 'Backpacks');
    R.has(first, '#3–4 on 2 tracked keywords');
    R.has(first, 'Strong evidence');
    R.eq(await cards.nth(0).getAttribute('aria-current'), 'true', 'the top page opens by default');
    R.eq(await cards.nth(0).locator('img').first().getAttribute('src'), 'https://cdn.shopify.com/ronin-batbros.jpg', 'the collection\'s newest live release leads');
    R.eq(await page.locator('#queue img[src$="ronin-draft.jpg"]').count(), 0, 'a draft product is not shown as the collection');
    const tabs = await page.evaluate(() => [...document.querySelectorAll('[data-seo-suite] a')].map(a => [a.getAttribute('href'), a.getAttribute('aria-current')]));
    R.eq(JSON.stringify(tabs), JSON.stringify([['/v2/seo-studio.html', 'page'], ['/v2/seo-overview.html', null], ['/v2/seo-keywords.html', null]]), 'the SEO suite strip renders with Studio current');
    // A ranking absence is never presented as "we have no page".
    R.ok('a not-ranking entry is labelled as such', /no page ranking/i.test(queue));
    R.ok('and never claims a page is missing', !/needs a page|no page yet/i.test(queue));
    R.ok('a not-ranking entry shows a labelled blank, never another page\'s photo', /not ranking/i.test(queue));
    R.eq(await page.locator('#queue img[src^="javascript"]').count(), 0, 'a non-https image URL is never rendered');

    const detail = () => page.locator('#detail').innerText();
    let d = await detail();
    R.has(d, 'Backpacks');
    R.has(d, 'Backpacks | Baseballism Online', 'Google\'s own title for our page');
    R.has(d, 'Title doesn’t say “Baseball Backpacks”.');
    R.has(d, 'The #1 result is titled “Baseball Backpacks & Bags | BL101”.');
    R.has(d, 'Search description is');
    R.has(d, 'Google shows about 155');
    R.has(d, 'Headings and image alt text not checked yet.');
    R.has(d, '#3', 'the rank check');
    R.has(d, '6.7', 'Google average from the page rows, impression-weighted');
    R.has(d, '13,796', 'impressions in the 28-day window only');
    R.not(d, '99,999', 'a row outside the window is never counted');
    R.has(d, 'bl101.com');
    R.has(d, '(you)');
    R.has(d, 'Say “Baseball Backpacks” in the title, and cut the search description to one sentence');
    R.has(d, 'You approve every edit. SILO never publishes.');
    R.ok('a competitor title is rendered as text, not HTML', (await page.evaluate(() => window.__PWNED__)) === undefined);
    R.has(d, '<img src=x', 'the hostile title is shown escaped');

    const ask = await page.locator('#detail a[href*="silo-chat.html?q="]').getAttribute('href');
    const q = decodeURIComponent(ask.split('?q=')[1]);
    R.has(q, '/collections/backpacks');
    R.has(q, 'do not publish');

    // Inspect: the page asks page-inspect about OUR url, tracking noise removed.
    await page.click('#btnInspect');
    await page.waitForFunction(() => (window.__INVOKES__ || []).length > 0);
    const inv = await page.evaluate(() => window.__INVOKES__[0]);
    R.eq(inv.name, 'page-inspect');
    R.eq(inv.body.url, `${SITE}/collections/backpacks`, 'the tracking parameter is stripped before inspecting');

    // Draft task: nothing is written until confirm; then a draft, never approved.
    await page.waitForSelector('#btnTask');
    await page.click('#btnTask');
    R.ok('the task dialog opens pre-filled', await page.evaluate(() => document.getElementById('dlgTask').open && document.getElementById('tTitle').value.length > 0));
    R.eq(await page.evaluate(() => window.__QUERIES__.filter(x => x._op === 'insert').length), 0, 'opening the dialog writes nothing');
    await page.click('#btnTaskConfirm');
    await page.waitForFunction(() => !document.getElementById('dlgTask').open);
    const writes = await page.evaluate(() => window.__QUERIES__.filter(x => x._op === 'insert').map(x => ({ table: x.table, rows: x.rows })));
    const task = writes.find(w => w.table === 'seo_tasks');
    R.ok('exactly one write: the task, under the existing project', writes.length === 1 && !!task);
    R.eq(task.rows.project_id, 'proj-1');
    R.eq(task.rows.approval_status, 'draft');
    R.eq(task.rows.target_url, `${SITE}/collections/backpacks`, 'the task targets the clean URL');
    R.eq(task.rows.target_type, 'collection');
    R.has(task.rows.rationale, 'Title doesn’t say');

    // Caps: no description and no intro are named; no Google rows is not zero.
    await cards.nth(1).click();
    await page.waitForFunction(() => document.querySelector('#detail .ss-title')?.textContent === 'Caps' && !!document.querySelector('#detail .ss-rec'));
    d = await detail();
    R.has(d, 'No search description set.');
    R.has(d, 'No introduction on the page.');
    R.has(d, 'Not returned by Google');
    R.has(d, 'That is not the same as no traffic.');
    R.has(d, 'Not a link', 'a result with a non-http URL is still listed');
    R.eq(await page.locator('#detail a[href^="javascript"]').count(), 0, 'but never as a link');
    R.ok('the selection is kept in the address bar', (await page.evaluate(() => location.search)).includes('page=page%3A%2Fcollections%2Fcaps'));

    // Not ranking: demand, who ranks, and no invented page facts.
    await cards.nth(2).click();
    await page.waitForFunction(() => /No page of ours ranking/.test(document.querySelector('#detail .ss-crumb')?.textContent || '') && !!document.querySelector('#detail .ss-rec'));
    d = await detail();
    R.has(d, 'The demand');
    R.has(d, '900');
    R.not(d, 'How the page shows in Google');
    R.has(d, 'Demand exists and no page of ours ranks.');
    R.has(d, 'That is not proof we have no page');

    // Drafting a task for it needs the person to say existing page or new.
    const inserts = () => page.evaluate(() => window.__QUERIES__.filter(x => x._op === 'insert').length);
    const before = await inserts();
    await page.click('#btnTask');
    R.ok('the existing-or-new choice is shown', await page.evaluate(() => !document.getElementById('tTarget').hidden));
    await page.click('#btnTaskConfirm');
    R.ok('no choice: refused, dialog stays open', await page.evaluate(() => document.getElementById('dlgTask').open && !document.getElementById('tError').hidden));
    await page.check('input[name="tTarget"][value="existing"]');
    await page.fill('#tUrl', '');
    await page.click('#btnTaskConfirm');
    R.ok('existing with no URL: refused', await page.evaluate(() => document.getElementById('dlgTask').open));
    R.eq(await inserts(), before, 'nothing written while undecided');
    await page.check('input[name="tTarget"][value="new"]');
    await page.click('#btnTaskConfirm');
    await page.waitForFunction(() => !document.getElementById('dlgTask').open);
    const nt = await page.evaluate(() => window.__QUERIES__.filter(x => x._op === 'insert' && x.table === 'seo_tasks').pop().rows);
    R.has(nt.rationale, 'the reviewer confirmed no existing page fits', 'the decision is recorded on the task');

    // Keywords tab: absences read as absences.
    await cards.nth(0).click();
    await page.waitForFunction(() => !!document.querySelector('#detail .ss-rec'));
    await page.click('[data-tab="keywords"]');
    await page.waitForFunction(() => /Opportunity/.test(document.querySelector('#detail .ss-table')?.textContent || ''));
    d = await detail();
    R.has(d, 'baseball backpack');
    R.has(d, 'mobile');

    // Refresh re-reads Shopify rather than keeping cached collections and
    // photos: a newer live release published since the first load leads.
    await page.evaluate(() => {
      window.__FIXTURE_TABLES__.shopify_collection_products.push({ company_entity_id: 'test-company', shopify_collection_id: window.__FIXTURE_TABLES__.shopify_collections[0].shopify_collection_id, shopify_product_id: 'p5', position: 9, missing_since: null });
      window.__FIXTURE_TABLES__.products_master.push({ company_entity_id: 'test-company', shopify_product_id: 'p5', product_title: 'Ronin Backpack - New Drop', image_url: 'https://cdn.shopify.com/ronin-new.jpg', shopify_status: 'active', online_published_at: '2026-09-26T00:00:00Z' });
    });
    await page.click('#btnRefresh');
    await page.waitForFunction(() => /ronin-new\.jpg$/.test(document.querySelector('#queue [data-key] img')?.getAttribute('src') || ''), null, { timeout: 5000 });
    R.ok('photos are re-read on refresh, and the new release leads', true);

    // Empty state.
    const empty = await suite.open('/v2/seo-studio.html', Object.assign({}, tables, { seo_recommendations_v: [] }), { ready: () => !!document.querySelector('#queue .ss-empty') });
    R.has(await empty.locator('#queue').innerText(), 'Nothing to work on yet.');
    await empty.close();

    // The recommendations read failing (a timeout) is named, not shown as empty.
    const broken = await suite.open('/v2/seo-studio.html', tables, { broken: ['seo_recommendations_v'], ready: () => /Could not load/.test(document.getElementById('queue')?.innerText || '') });
    R.has(await broken.locator('#queue').innerText(), 'Could not load.');
    await broken.close();
  } finally {
    await suite.close();
    if (R.summary().fail) process.exitCode = 1;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
