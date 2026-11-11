/* Launch links on the real /v2/marketing-explorer.html.
 *
 * Why this suite exists. Overview's Creatives and Campaigns tabs let you link
 * an ad or campaign to a launch and show which launch it already belongs to.
 * Explorer lists the same ads and campaigns and is where the Performance
 * workflow sends people to find an ad, but it showed neither. Both pages now
 * draw the same control from one shared module (v2/marketing-launch-links.js),
 * so they cannot disagree about what is linked.
 *
 * What is asserted is what a person sees and what the page WRITES:
 *   - an already-linked ad shows its launch; an unlinked one offers "+ Link";
 *   - linking and unlinking write exactly one launch_system_links row each,
 *     scoped to the active company, and the row redraws without a reload;
 *   - on a campaign row -- which drills when clicked -- the control is its own
 *     action and does not drill;
 *   - only Meta campaigns and ads offer it, as on Overview;
 *   - a link made here is the link Overview shows;
 *   - when links cannot be read the page still works and offers nothing.
 *
 * Mutations (each must fail at least one assertion):
 *   EXP_LINKS_MUTATION=no-cell        Explorer stops drawing the launch cell
 *   EXP_LINKS_MUTATION=bare-label     the control reads "+ Link" with nothing saying what it links to
 *   EXP_LINKS_MUTATION=drill-on-link  clicking "+ Link" on a campaign row drills into it
 *   EXP_LINKS_MUTATION=any-platform   non-Meta campaigns are offered a link
 *   EXP_LINKS_MUTATION=no-redraw      a new link is not shown until the page reloads
 *   EXP_LINKS_MUTATION=no-company     the written row loses its company
 *   EXP_LINKS_MUTATION=dash           an unreadable links table draws a dash under every row
 */
'use strict';
const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');
const assert = require('node:assert/strict');
const R = createReporter('explorer-launch-links');

const MUTATIONS = {
  'no-cell': ['/marketing-explorer.html', "    if (lv === 3 && r.adId) return launchLinks.cell(", "    if (false) return launchLinks.cell("],
  'bare-label': ['/marketing-explorer.html', "linkLabel:'+ Link to launch'", "linkLabel:'+ Link'"],
  'drill-on-link': ['/marketing-explorer.html', "        if (e.target.closest('.mx-launch')) return;", ''],
  'any-platform': ['/marketing-explorer.html', "if (lv === 1 && state.drill.platform === 'meta_ads' && r.drillId != null)", "if (lv === 1 && r.drillId != null)"],
  'no-redraw': ['/marketing-explorer.html', "    onChange(){ renderTable(); },", "    onChange(){},"],
  'no-company': ['/marketing-launch-links.js', "        company_entity_id: companyId(), launch_id: launchId, link_type: 'campaign',", "        launch_id: launchId, link_type: 'campaign',"],
  'dash': ['/marketing-launch-links.js', "(bare ? '' : '—')", "'—'"],
};
const MUT = process.env.EXP_LINKS_MUTATION || '';
assert.ok(!MUT || MUTATIONS[MUT], `Unknown mutation ${MUT}`);
const transform = (rel, source) => {
  if (!MUT) return source;
  const [file, from, to] = MUTATIONS[MUT];
  if (!rel.endsWith(file)) return source;
  assert.ok(source.includes(from), `mutation ${MUT}: pattern missing`);
  return source.split(from).join(to);
};

const CO = 'test-company';
const today = new Date().toISOString().slice(0, 10);
const kpi = (o) => Object.assign({ company_entity_id: CO, account_name: 'Acct', day_date: today, impressions: 1000, clicks: 50, spend: 100,
  conversions: 4, conversion_value: 400, sessions: 0 }, o);
const adrow = (o) => Object.assign({ company_entity_id: CO, day_date: today, campaign_id: 'c1', campaign_name: 'Sonic', adset_id: 's1', adset_name: 'Broad',
  impressions: 500, clicks: 20, spend: 50, conversions: 2, conversion_value: 100 }, o);
const TABLES = {
  marketing_kpis_daily: [
    kpi({ platform: 'meta_ads', campaign_id: 'c1', campaign_name: 'Sonic' }),
    kpi({ platform: 'meta_ads', campaign_id: 'c2', campaign_name: 'Evergreen' }),
    kpi({ platform: 'google_ads', campaign_id: 'g1', campaign_name: 'Brand Search' }),
  ],
  meta_ad_performance_daily: [
    adrow({ id: 'p1', ad_id: 'ad-1', ad_name: 'Sonic video' }),
    adrow({ id: 'p2', ad_id: 'ad-2', ad_name: 'Sonic static' }),
  ],
  meta_ad_creatives: [
    { company_entity_id: CO, ad_id: 'ad-1', ad_name: 'Sonic video', effective_status: 'ACTIVE', thumbnail_url: null, title: null, object_type: 'VIDEO' },
    { company_entity_id: CO, ad_id: 'ad-2', ad_name: 'Sonic static', effective_status: 'ACTIVE', thumbnail_url: null, title: null, object_type: 'PHOTO' },
  ],
  launch_calendar: [
    { id: 'launch-1', company_entity_id: CO, title: 'Sonic launch', launch_date: today },
    { id: 'other-company-launch', company_entity_id: 'other-company', title: 'Private launch', launch_date: today },
  ],
  // ad-1 is already linked: Explorer has to SHOW that, not only offer to link.
  launch_system_links: [
    { id: 'link-1', company_entity_id: CO, launch_id: 'launch-1', link_type: 'campaign', ref_table: 'meta_ad_creatives', ref_id: 'ad-1', ref_label: 'Sonic video', channel_item_id: null },
  ],
  launch_channel_items: [
    { id: 'init-meta', launch_id: 'launch-1', company_entity_id: CO, channel: 'meta', item_title: 'Paid launch push', scheduled_date: today },
  ],
};
const explorerReady = () => !!document.querySelector('#mainBody tr.mx-total, #mainBody .mx-empty') && !document.querySelector('#mainBody .mx-spinner');
const writes = (page, op) => page.evaluate((o) => window.__QUERIES__.filter((q) => q._op === o && q.table === 'launch_system_links')
  .map((q) => ({ rows: q.rows, filters: q.filters })), op);
const row = (page, text) => page.locator('#mainBody tr[data-idx]', { hasText: text });

(async () => {
  const suite = await startSuite({ transform });
  try {
    // ── Ads level ────────────────────────────────────────────────────────
    let page = await suite.open('/v2/marketing-explorer.html?days=7&platform=meta_ads&campaign=c1&adset=s1', TABLES, { ready: explorerReady });
    R.eq(await page.locator('#tableTitle').innerText(), 'Ads');
    R.has(await row(page, 'Sonic video').locator('.mo-link-chip').innerText(), 'Sonic launch', 'an ad already linked shows its launch');
    R.eq(await row(page, 'Sonic video').locator('.mo-link-chip a').getAttribute('href'), '/v2/launch-calendar.html?launch=launch-1', 'and the chip opens that launch');
    R.eq(await row(page, 'Sonic static').locator('.mo-link-chip').count(), 0, 'an unlinked ad shows none');
    R.eq(await row(page, 'Sonic static').locator('[data-link-source="meta_ad_creatives"][data-link-id="ad-2"]').count(), 1, 'and offers + Link');
    R.eq(await row(page, 'Sonic static').locator('[data-link-source]').innerText(), '+ Link to launch', 'named for what it does, since no column heading says Launch here');
    R.eq(await row(page, 'Sonic static').locator('a.mx-act').count(), 1, 'beside the Ad Studio link, not instead of it');

    await row(page, 'Sonic static').locator('[data-link-source]').click();
    R.ok('the same dialog as Overview opens', await page.locator('#creativeLaunchDialog').isVisible());
    R.has(await page.textContent('#creativeLaunchTitle'), 'Link creative to launch');
    R.has(await page.textContent('#creativeLaunchName'), 'Sonic static');
    R.has(await page.textContent('#creativeLaunchSelect'), 'Sonic launch');
    R.not(await page.textContent('#creativeLaunchSelect'), 'Private launch', 'another company’s launch is never offered');
    R.eq((await writes(page, 'insert')).length, 0, 'opening the dialog writes nothing');
    await page.click('#creativeLaunchSave');
    await page.waitForFunction(() => !document.getElementById('creativeLaunchDialog').open);
    let ins = await writes(page, 'insert');
    R.eq(ins.length, 1, 'exactly one row is written');
    R.eq([ins[0].rows.company_entity_id, ins[0].rows.launch_id, ins[0].rows.link_type, ins[0].rows.ref_table, ins[0].rows.ref_id, ins[0].rows.ref_label],
      [CO, 'launch-1', 'campaign', 'meta_ad_creatives', 'ad-2', 'Sonic static'], 'for this company, this launch and this ad');
    R.has(await row(page, 'Sonic static').locator('.mo-link-chip').innerText(), 'Sonic launch', 'the new link shows without a reload');
    R.eq(await page.locator('#tableTitle').innerText(), 'Ads', 'and the drill did not move');

    // The same launch cannot be linked twice.
    await row(page, 'Sonic video').locator('[data-link-source]').click();
    R.ok('an ad already on every launch cannot be linked again', await page.locator('#creativeLaunchSave').isDisabled());
    await page.click('#creativeLaunchCancel');

    // Unlink, from here.
    await row(page, 'Sonic video').locator('[data-unlink-id="link-1"]').click();
    R.ok('unlink asks before it deletes', await page.locator('#unlinkDialog').isVisible());
    R.eq((await writes(page, 'delete')).length, 0);
    await page.click('#unlinkConfirm');
    await page.waitForFunction(() => !document.getElementById('unlinkDialog').open);
    const del = await writes(page, 'delete');
    R.eq(del.length, 1, 'one delete');
    R.eq(del[0].filters.filter((f) => f.col === 'id').map((f) => f.val), ['link-1'], 'of exactly that link row');
    R.eq(await row(page, 'Sonic video').locator('.mo-link-chip').count(), 0, 'the chip is gone without a reload');
    await page.close();

    // ── Campaign level: the row drills, the control does not ─────────────
    page = await suite.open('/v2/marketing-explorer.html?days=7&platform=meta_ads', TABLES, { ready: explorerReady });
    R.eq(await page.locator('#tableTitle').innerText(), 'Campaigns');
    R.eq(await row(page, 'Evergreen').locator('[data-link-source="marketing_kpis_daily"][data-link-id="c2"]').count(), 1, 'a Meta campaign offers + Link');
    await row(page, 'Evergreen').locator('[data-link-source]').click();
    R.ok('the dialog opens', await page.locator('#creativeLaunchDialog').isVisible());
    R.eq(await page.locator('#tableTitle').innerText(), 'Campaigns', 'and the row did not drill');
    R.ok('nor did the address bar gain a campaign', !(await page.evaluate(() => new URLSearchParams(location.search).get('campaign'))));
    R.has(await page.textContent('#creativeLaunchTitle'), 'Link campaign to launch');
    await page.click('#creativeLaunchSave');
    await page.waitForFunction(() => !document.getElementById('creativeLaunchDialog').open);
    ins = await writes(page, 'insert');
    R.eq([ins[0].rows.ref_table, ins[0].rows.ref_id, ins[0].rows.ref_label, ins[0].rows.company_entity_id], ['marketing_kpis_daily', 'c2', 'Evergreen', CO], 'the campaign link is the row Overview would have written');
    R.has(await row(page, 'Evergreen').locator('.mo-link-chip').innerText(), 'Sonic launch');
    // The rest of the row still drills.
    await row(page, 'Evergreen').locator('.mx-c-rank').click();
    await page.waitForFunction(() => document.getElementById('tableTitle').textContent === 'Ad sets');
    R.ok('clicking the row itself still drills', true);
    await page.close();

    // Only Meta: the links are read back for Meta campaigns and ads.
    page = await suite.open('/v2/marketing-explorer.html?days=7&platform=google_ads', TABLES, { ready: explorerReady });
    R.eq(await page.locator('#tableTitle').innerText(), 'Campaigns');
    R.eq(await page.locator('#mainBody [data-link-source]').count(), 0, 'a Google campaign is not offered a launch link');
    await page.close();
    page = await suite.open('/v2/marketing-explorer.html?days=7', TABLES, { ready: explorerReady });
    R.eq(await page.locator('#mainBody [data-link-source]').count(), 0, 'nor is a platform row');
    await page.close();

    // ── The link Explorer shows is the link Overview shows ───────────────
    page = await suite.open('/v2/marketing-overview.html?days=7&tab=creatives', TABLES,
      { ready: () => /rows loaded/.test(document.getElementById('statusText')?.textContent || '') });
    R.has(await page.locator('#creativeBody tr', { hasText: 'Sonic video' }).locator('.mo-link-chip').innerText(), 'Sonic launch', 'Overview draws the same link for the same ad');
    await page.close();

    // ── Links unreadable: the page works and offers nothing ──────────────
    page = await suite.open('/v2/marketing-explorer.html?days=7&platform=meta_ads&campaign=c1&adset=s1', TABLES,
      { ready: explorerReady, broken: ['launch_system_links'] });
    R.eq(await page.$$eval('#mainBody tr[data-idx] .mx-name', (n) => n.map((x) => x.textContent.trim())), ['Sonic video', 'Sonic static'], 'the ads still list');
    R.eq(await page.locator('#mainBody [data-link-source], #mainBody .mo-link-chip').count(), 0, 'with no link control');
    R.eq(await page.locator('#mainBody .mx-launch').count(), 0, 'and nothing drawn in its place');
    await page.close();
  } catch (err) {
    R.ok('suite ran to completion', false, err && err.stack ? err.stack : String(err));
  } finally {
    await suite.close();
    if (R.summary().fail) process.exitCode = 1;
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
