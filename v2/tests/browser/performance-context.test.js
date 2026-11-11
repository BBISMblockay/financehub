/* Performance: one selection across Overview, Explorer and Ad Studio.
 *
 * Why this suite exists. Overview and Explorer became two tabs of one
 * destination, and the point of that is how quickly someone gets from "what
 * changed?" to the ad and an action. That only holds if:
 *
 *   1. nothing either page could do was lost in the move (the seven Overview
 *      tabs; Explorer's presets, typed dates, drill, filter, columns, compare
 *      and export);
 *   2. the selection survives: the date window, the platform and the campaign
 *      are still there after a refresh, after Back, and after switching tab;
 *   3. there is a next step on the row: Overview -> Explorer's drill, an ad
 *      -> Ad Studio on that ad, and Ad Studio -> back to that ad's result.
 *
 * Runs the REAL pages against a fake Supabase (v2/tests/lib/harness.js).
 *
 * Mutations (each must fail at least one assertion):
 *   PERF_CTX_MUTATION=no-carry        the strip stops carrying the selection between the two tabs
 *   PERF_CTX_MUTATION=no-url          Explorer stops writing its selection to the address bar
 *   PERF_CTX_MUTATION=no-back         Explorer ignores Back / Forward
 *   PERF_CTX_MUTATION=no-window       Overview ignores the window in the address bar
 *   PERF_CTX_MUTATION=no-tab          Overview forgets the open tab on refresh
 *   PERF_CTX_MUTATION=no-drill-link   Overview's rows lose their way into Explorer
 *   PERF_CTX_MUTATION=no-studio-link  an ad row loses its way into Ad Studio
 *   PERF_CTX_MUTATION=no-return       Ad Studio loses its way back to the result
 *   PERF_CTX_MUTATION=no-focus        Explorer no longer finds the ad a link points at
 *   PERF_CTX_MUTATION=range-ignored   Overview swaps a typed range for 30d
 *   PERF_CTX_MUTATION=range-unbounded Overview reads past the end of a typed range
 *   PERF_CTX_MUTATION=range-unnamed   Overview shows a typed range's numbers under a 30d label
 *   PERF_CTX_MUTATION=foreign-campaign Overview filters Campaigns by another platform's campaign
 */
'use strict';
const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');
const assert = require('node:assert/strict');
const R = createReporter('performance-context');

const MUTATIONS = {
  'no-carry': ['/performance-suite.js', "if (!SHARES_CONTEXT.includes(active) || !SHARES_CONTEXT.includes(id)) return base;", 'return base;'],
  'no-url': ['/marketing-explorer.html', "    history[push ? 'pushState' : 'replaceState'](null, '', url);", ''],
  'no-back': ['/marketing-explorer.html', "      if (readUrl()) runLoad(); else { settleDrill(); render(); }", ''],
  'no-window': ['/marketing-overview.html', '  let WINDOW_DAYS = windowFromUrl();', '  let WINDOW_DAYS = 30;'],
  'no-tab': ['/marketing-overview.html', "      setUrlParams({ tab: tab.dataset.tab === 'overview' ? null : tab.dataset.tab });", ''],
  'no-drill-link': ['/marketing-overview.html', '    return `/v2/marketing-explorer.html?${q}`;', "    return '/v2/marketing-explorer.html';"],
  'no-studio-link': ['/marketing-explorer.html', '    const studioLink = (r) => r.adId', '    const studioLink = (r) => false'],
  'no-return': ['/ad-studio.html', 'href="/v2/marketing-explorer.html?ad=${encodeURIComponent(a.ad_id)}"', 'href="/v2/marketing-explorer.html"'],
  'no-focus': ['/marketing-explorer.html', '    if (state.focusAd && !d.adsetId){', '    if (false){'],
  'range-ignored': ['/marketing-overview.html', "      return e === todayIso() ? { days: n, start: null, end: null } : { days: n, start: s, end: e };", "      return { days: 30, start: null, end: null };"],
  'range-unbounded': ['/marketing-overview.html', "  const upTo = (q, col = 'day_date') => isFixedRange() ? q.lte(col, RANGE.end) : q;", "  const upTo = (q) => q;"],
  'range-unnamed': ['/marketing-overview.html', "    if (isFixedRange()){ extra.dataset.fixed = '1'; extra.textContent = windowLabel();", "    if (isFixedRange()){ extra.dataset.fixed = '1'; extra.textContent = '30d';"],
  'foreign-campaign': ['/marketing-overview.html', "(!urlParam('platform') || urlParam('platform') === 'meta_ads') ? urlParam('campaign') : null", "urlParam('campaign')"],
};
const MUT = process.env.PERF_CTX_MUTATION || '';
assert.ok(!MUT || MUTATIONS[MUT], `Unknown mutation ${MUT}`);
const transform = (rel, source) => {
  if (!MUT) return source;
  const [file, from, to] = MUTATIONS[MUT];
  if (!rel.endsWith(file)) return source;
  assert.ok(source.includes(from), `mutation ${MUT}: pattern missing`);
  return source.split(from).join(to);
};

// Fixture days are relative to today: both pages' windows end today.
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const CO = 'test-company';
const kpi = (o) => Object.assign({ company_entity_id: CO, account_name: 'Acct', impressions: 1000, clicks: 50, spend: 100,
  conversions: 4, conversion_value: 400, sessions: 0, view_content: 0, add_to_cart: 0, initiate_checkout: 0, reach: 500 }, o);
const KPIS = [];
for (const d of [1, 3, 10, 20]) {
  KPIS.push(kpi({ platform: 'meta_ads', day_date: day(d), campaign_id: 'c1', campaign_name: 'Holiday Prospecting', spend: 300, conversion_value: 600 }));
  KPIS.push(kpi({ platform: 'meta_ads', day_date: day(d), campaign_id: 'c2', campaign_name: 'Retargeting', spend: 100, conversion_value: 700 }));
  KPIS.push(kpi({ platform: 'google_ads', day_date: day(d), campaign_id: 'g1', campaign_name: 'Brand Search', spend: 80, conversion_value: 560 }));
}
const adrow = (o) => Object.assign({ company_entity_id: CO, campaign_id: 'c1', campaign_name: 'Holiday Prospecting',
  impressions: 500, clicks: 20, spend: 50, conversions: 2, conversion_value: 100 }, o);
const ADPERF = [];
for (const d of [1, 3, 10, 20]) {
  ADPERF.push(adrow({ day_date: day(d), adset_id: 's1', adset_name: 'Broad 25-54', ad_id: 'a1', ad_name: 'Dad Hat UGC', conversion_value: 400 }));
  ADPERF.push(adrow({ day_date: day(d), adset_id: 's1', adset_name: 'Broad 25-54', ad_id: 'a2', ad_name: 'Bundle Carousel' }));
  ADPERF.push(adrow({ day_date: day(d), adset_id: 's2', adset_name: 'Lookalike 1%', ad_id: 'a3', ad_name: 'Static Hoodie' }));
}
const CREATIVES = [
  { company_entity_id: CO, ad_id: 'a1', ad_name: 'Dad Hat UGC', thumbnail_url: null, title: null, effective_status: 'ACTIVE', preview_shareable_link: null, object_type: 'VIDEO' },
  { company_entity_id: CO, ad_id: 'a2', ad_name: 'Bundle Carousel', thumbnail_url: null, title: null, effective_status: 'PAUSED', preview_shareable_link: null, object_type: 'SHARE' },
  { company_entity_id: CO, ad_id: 'a3', ad_name: 'Static Hoodie', thumbnail_url: null, title: null, effective_status: 'ACTIVE', preview_shareable_link: null, object_type: 'PHOTO' },
];
const TABLES = { marketing_kpis_daily: KPIS, meta_ad_performance_daily: ADPERF, meta_ad_creatives: CREATIVES };

const STUDIO_AD = {
  ad_id: 'a1', ad_name: 'Dad Hat UGC', campaign_name: 'Holiday Prospecting', adset_name: 'Broad 25-54', objective: 'purchase',
  first_day: day(40), last_day: day(1), days_with_spend: 30, spend: 10000, impressions: 1000000, clicks: 15000,
  conversions: 400, conversion_value: 60000, thruplays: null, leads: null, add_to_cart: 900,
  recent_spend: 1400, recent_impressions: 140000, recent_clicks: 2100, recent_conversions: 50, recent_conversion_value: 4500,
  early_impressions: 140000, early_clicks: 2200, effective_status: 'ACTIVE', object_type: 'VIDEO', body: 'Dad hats.', title: null,
  link_url: null, link_url_source: null, link_path: null, preview_shareable_link: null, thumbnail_url: null,
  image_path: null, image_width: null, image_height: null, image_shared_by: null, window_start: day(365), data_through: day(1),
};

const overviewReady = () => /rows loaded|Load failed/.test(document.getElementById('statusText')?.textContent || '');
const explorerReady = () => !!document.querySelector('#mainBody tr.mx-total, #mainBody .mx-empty') && !document.querySelector('#mainBody .mx-spinner');
const q = (page) => page.evaluate(() => Object.fromEntries(new URLSearchParams(location.search)));
const trail = (page) => page.locator('#trail').innerText();
const rowNames = (page) => page.$$eval('#mainBody tr[data-idx] .mx-name', (n) => n.map((x) => x.textContent.trim()));

(async () => {
  const suite = await startSuite({ transform });
  try {
    // ── 1. Nothing was lost ──────────────────────────────────────────────
    let page = await suite.open('/v2/marketing-overview.html?days=14', TABLES, { ready: overviewReady });
    R.eq(await page.$$eval('.bcn-tab[data-tab]', (t) => t.map((x) => x.dataset.tab)),
      ['overview', 'campaigns', 'creatives', 'redo', 'funnel', 'channels', 'organic'], 'Overview tabs');
    R.eq(await page.$$eval('[data-panel]', (p) => [...new Set(p.map((x) => x.dataset.panel))].sort()),
      ['campaigns', 'channels', 'creatives', 'funnel', 'organic', 'overview', 'redo'], 'every tab still has its panel');
    R.eq(await page.$$eval('#windowBtns button', (b) => b.map((x) => x.textContent)), ['7d', '14d', '30d', '90d'], 'Overview windows');
    const stripTabs = await page.$$eval('.perf-suite-text', (n) => n.map((x) => x.textContent));
    const pageTabs = await page.$$eval('.bcn-tab[data-tab]', (n) => n.map((x) => x.textContent.trim()));
    R.ok('no page tab repeats a strip tab’s name', !pageTabs.some((t) => stripTabs.includes(t)), `${stripTabs} / ${pageTabs}`);

    // ── 2. Overview: window and tab survive a refresh ────────────────────
    R.eq(await page.locator('#windowBtns .is-active').innerText(), '14d', 'the window in the address bar is the window shown');
    const sinceSeen = await page.evaluate(() => window.__QUERIES__.find((x) => x.table === 'marketing_kpis_daily').filters.find((f) => f.op === 'gte').val);
    R.eq(sinceSeen, day(13), 'and the window queried');
    await page.click('.bcn-tab[data-tab="campaigns"]');
    R.eq((await q(page)).tab, 'campaigns', 'the open tab is in the address bar');
    await page.reload(); await page.waitForFunction(overviewReady);
    R.eq(await page.locator('.bcn-tab--active').getAttribute('data-tab'), 'campaigns', 'refresh keeps the tab');
    R.eq(await page.locator('#windowBtns .is-active').innerText(), '14d', 'refresh keeps the window');

    // ── 3. Overview -> Explorer, already drilled in ──────────────────────
    const campLink = page.locator('#campaignBody tr', { hasText: 'Holiday Prospecting' }).locator('a.mo-next');
    R.eq(await campLink.getAttribute('href'), '/v2/marketing-explorer.html?days=14&platform=meta_ads&campaign=c1', 'a campaign row links to its ads');
    await page.click('.bcn-tab[data-tab="overview"]');
    R.eq(await page.locator('#platformBody tr', { hasText: 'Google Ads' }).locator('a.mo-next').getAttribute('href'),
      '/v2/marketing-explorer.html?days=14&platform=google_ads', 'a platform row links to its campaigns');
    await page.click('.bcn-tab[data-tab="campaigns"]');
    await Promise.all([page.waitForURL(/marketing-explorer/), campLink.click()]);
    await page.waitForFunction(explorerReady);
    R.has(await trail(page), 'Holiday Prospecting', 'Explorer opens on the campaign');
    R.eq(await page.locator('#tableTitle').innerText(), 'Ad sets');
    R.eq(await page.locator('#dtStart').inputValue(), day(13), 'with Overview’s 14-day window, though Explorer has no 14d button');
    R.eq((await q(page)).days, '14', 'still a rolling window, not two frozen dates');

    // ── 1b. Explorer kept its controls ───────────────────────────────────
    R.eq(await page.$$eval('#presetBtns .bcn-btn', (b) => b.map((x) => x.textContent)), ['7d', '30d', '90d', '1y', 'YTD', 'All'], 'Explorer presets');
    for (const id of ['dtStart', 'dtEnd', 'rowSearch', 'btnCols', 'cmpToggle', 'btnExport', 'dayDetails'])
      R.ok(`Explorer keeps #${id}`, await page.locator('#' + id).count() === 1);

    // ── 4. Explorer: drill, Back, refresh ────────────────────────────────
    await page.locator('#mainBody tr[data-idx]', { hasText: 'Broad 25-54' }).click();
    R.eq(await page.locator('#tableTitle').innerText(), 'Ads');
    R.eq((await q(page)).adset, 's1', 'the ad set is in the address bar');
    R.eq(await rowNames(page), ['Dad Hat UGC', 'Bundle Carousel']);
    await page.reload(); await page.waitForFunction(explorerReady);
    R.eq(await page.locator('#tableTitle').innerText(), 'Ads', 'refresh keeps the drill');
    R.has(await trail(page), 'Broad 25-54', 'and names it, though the link carries only ids');
    await page.goBack(); await page.waitForFunction(() => document.getElementById('tableTitle').textContent === 'Ad sets');
    R.ok('Back steps out one drill level, on the same page', /marketing-explorer/.test(page.url()));
    R.ok('and the ad set leaves the address bar', !(await q(page)).adset);
    await page.goForward(); await page.waitForFunction(() => document.getElementById('tableTitle').textContent === 'Ads');
    R.eq((await q(page)).adset, 's1', 'Forward steps back in');

    // ── 5. The next action: an ad -> Ad Studio ───────────────────────────
    const studio = page.locator('#mainBody tr[data-idx]', { hasText: 'Dad Hat UGC' }).locator('a.mx-act');
    R.eq(await studio.getAttribute('href'), '/v2/ad-studio.html?ad=a1', 'an ad row opens that ad in Ad Studio');
    R.eq(await page.locator('#mainBody a.mx-act').count(), 2, 'on every ad row');
    await page.goBack(); await page.waitForFunction(() => document.getElementById('tableTitle').textContent === 'Ad sets');
    R.eq(await page.locator('#mainBody a.mx-act').count(), 0, 'and only on ad rows');

    // ── 6. Switching tab keeps the selection ─────────────────────────────
    await Promise.all([page.waitForURL(/marketing-overview/), page.locator('.perf-suite-links a', { hasText: 'Overview' }).click()]);
    await page.waitForFunction(overviewReady);
    let params = await q(page);
    R.eq([params.days, params.platform, params.campaign], ['14', 'meta_ads', 'c1'], 'Overview receives the window and the campaign');
    R.eq(await page.locator('.bcn-tab--active').getAttribute('data-tab'), 'campaigns', 'and opens on that campaign');
    R.eq(await page.$$eval('#campaignBody tr', (r) => r.length), 1, 'filtered to it');
    R.has(await page.locator('#campaignBody').innerText(), 'Holiday Prospecting');
    R.eq(await page.locator('#campaignFocus').isHidden(), false, 'with the existing way to show all');
    await Promise.all([page.waitForURL(/marketing-explorer/), page.locator('.perf-suite-links a', { hasText: 'Explorer' }).click()]);
    await page.waitForFunction(explorerReady);
    R.has(await trail(page), 'Holiday Prospecting', 'and Explorer is still on the campaign on the way back');
    R.eq(await page.locator('.perf-suite-links a', { hasText: 'Overview' }).getAttribute('href'), '/v2/marketing-overview.html',
      'the drawn tab link stays the plain page URL');
    await page.close();

    // A campaign on another platform is carried, not used as Overview's Meta filter.
    page = await suite.open('/v2/marketing-overview.html?days=30&platform=google_ads&campaign=g1', TABLES, { ready: overviewReady });
    R.eq(await page.locator('.bcn-tab--active').getAttribute('data-tab'), 'overview', 'a non-Meta campaign does not hijack the Campaigns tab');
    await page.click('.bcn-tab[data-tab="campaigns"]');
    R.eq(await page.$$eval('#campaignBody tr', (r) => r.length), 2, 'which still lists every Meta campaign');
    R.eq((await q(page)).campaign, 'g1', 'while the selection stays in the address bar for Explorer');
    await page.close();

    // A window Overview has no button for is shown and named, not swapped for 30d.
    page = await suite.open('/v2/marketing-overview.html?days=365', TABLES, { ready: overviewReady });
    R.eq(await page.locator('#windowBtns .is-active').innerText(), '1y', 'Explorer’s 1y is honoured on Overview');
    await page.click('#windowBtns button[data-days="7"]');
    await page.waitForFunction(() => new URLSearchParams(location.search).get('days') === '7');
    R.ok('choosing a window updates the address bar', true);
    await page.close();

    // A typed range that ends before today is shown AS that range -- never
    // quietly replaced by 30d under numbers someone will read as the range.
    page = await suite.open(`/v2/marketing-overview.html?start=${day(12)}&end=${day(8)}&platform=meta_ads`, TABLES, { ready: overviewReady });
    const kq = await page.evaluate(() => window.__QUERIES__.filter((x) => x.table === 'marketing_kpis_daily')
      .map((x) => x.filters.filter((f) => f.col === 'day_date').map((f) => `${f.op}:${f.val}`).sort().join(',')));
    R.eq([...new Set(kq)], [`gte:${day(12)},lte:${day(8)}`], 'the KPI read is bounded on both sides');
    const fixedBounds = await page.evaluate(() => window.__QUERIES__
      .filter((x) => ['v_marketing_mer_daily', 'meta_ad_performance_daily', 'redo_marketing_daily_v', 'meta_custom_conversion_daily_v'].includes(x.table))
      .map((x) => [x.table, x.filters.some((f) => f.col === 'day_date' && f.op === 'lte')]));
    R.ok('every day-keyed read has the ceiling', fixedBounds.length >= 4 && fixedBounds.every(([, ok]) => ok), JSON.stringify(fixedBounds));
    // Only the day-10 rows fall in the range: 300 + 100 + 80.
    R.eq(await page.locator('#kpiSpend').innerText(), '$480', 'the numbers are the range’s, not 30 days’');
    const fixedBtn = page.locator('#windowBtns .is-active');
    R.eq(await page.locator('#windowBtns .is-active').count(), 1, 'exactly one window is marked');
    R.ok('and it names the dates', /\d{4}\s–\s.*\d{4}/.test(await fixedBtn.innerText()), await fixedBtn.innerText());
    R.has(await page.locator('#kpiSpendDelta').innerText(), await fixedBtn.innerText(), 'the KPI caption names the same range');
    R.not(await page.locator('#chartTitle').innerText(), 'last', 'the chart title does not say "last N days"');
    R.eq(await page.locator('#platformBody tr', { hasText: 'Meta Ads' }).locator('a.mo-next').getAttribute('href'),
      `/v2/marketing-explorer.html?start=${day(12)}&end=${day(8)}&platform=meta_ads`, 'links into Explorer keep the range');
    await page.click('#windowBtns button[data-days="30"]');
    await page.waitForFunction(() => document.getElementById('kpiSpend').textContent === '$1,920');
    params = await q(page);
    R.eq([params.days, params.start, params.end], ['30', undefined, undefined], 'choosing a window returns to rolling');
    R.eq(await page.locator('#windowBtns button[data-fixed]').count(), 0, 'and the range label goes away');
    const rolling = await page.evaluate(() => window.__QUERIES__.filter((x) => x.table === 'marketing_kpis_daily').pop()
      .filters.filter((f) => f.col === 'day_date').map((f) => f.op));
    R.eq(rolling, ['gte'], 'a rolling window keeps the query it always had');
    await page.close();

    // A range that is not real dates is not sent to the database: default window.
    page = await suite.open('/v2/marketing-overview.html?start=2026-02-31&end=2026-03-02', TABLES, { ready: overviewReady });
    R.eq(await page.locator('#windowBtns .is-active').innerText(), '30d', 'an impossible date falls back to the default, and says 30d');
    R.eq(await page.locator('#windowBtns button[data-fixed]').count(), 0);
    await page.close();
    page = await suite.open('/v2/marketing-explorer.html?start=2026-02-31&end=2026-03-02&platform=<img src=x onerror=window.__PWNED__=1>', TABLES, { ready: explorerReady });
    R.eq(await page.locator('#presetBtns .is-active').innerText(), '30d', 'Explorer likewise');
    R.ok('a hostile platform value is text, not HTML', (await page.evaluate(() => window.__PWNED__)) === undefined);
    await page.close();

    // ── 7. Ad Studio -> back to the result ───────────────────────────────
    page = await suite.open('/v2/ad-studio.html?ad=a1', { ad_ideas: [], ad_studio_ads: [STUDIO_AD] },
      { ready: () => !!document.querySelector('#detail .as-title') });
    R.has(await page.locator('#detail .as-title').innerText(), 'Dad Hat UGC', 'Ad Studio opens on the linked ad');
    const back = page.locator('#detail a', { hasText: 'See results in Explorer' });
    R.eq(await back.getAttribute('href'), '/v2/marketing-explorer.html?ad=a1', 'and links back to that ad’s result');
    await page.close();

    page = await suite.open('/v2/marketing-explorer.html?ad=a1', TABLES, { ready: explorerReady });
    R.eq(await page.locator('#tableTitle').innerText(), 'Ads', 'Explorer finds the ad’s ad set from the ad alone');
    R.has(await trail(page), 'Holiday Prospecting');
    R.has(await page.locator('#mainBody tr[data-focus-ad]').innerText(), 'Dad Hat UGC', 'and marks the ad');
    R.eq(await page.locator('#mainBody tr[data-focus-ad]').count(), 1);
    const [focusBg, otherBg] = await page.evaluate(() => [...document.querySelectorAll('#mainBody tr[data-idx]')]
      .sort((x) => (x.hasAttribute('data-focus-ad') ? -1 : 1)).map((tr) => getComputedStyle(tr.querySelector('.mx-c-name')).backgroundColor));
    R.ok('visibly, not only in the markup', focusBg !== otherBg, `${focusBg} vs ${otherBg}`);
    params = await q(page);
    R.eq([params.platform, params.campaign, params.adset, params.ad], ['meta_ads', 'c1', 's1', 'a1'], 'the address bar is the full selection');
    await page.close();

    page = await suite.open('/v2/marketing-explorer.html?ad=gone&days=7', TABLES, { ready: explorerReady });
    R.has(await page.locator('#caveat').innerText(), 'linked ad has no rows', 'an ad outside the range is explained, not silently dropped');
    R.eq(await page.locator('#tableTitle').innerText(), 'By platform');
    await page.close();
  } catch (err) {
    R.ok('suite ran to completion', false, err && err.stack ? err.stack : String(err));
  } finally {
    await suite.close();
    if (R.summary().fail) process.exitCode = 1;
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
