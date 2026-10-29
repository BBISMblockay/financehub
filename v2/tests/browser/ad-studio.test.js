/* The real /v2/ad-studio.html with a fake Supabase: the baselines, one ad's
 * detail, the idea bank, and every write the page can make.
 *
 * Fixture values are shaped on production's own 2026-09-27 numbers (purchase
 * ROAS pooled ~3.6x, catalog ads sharing one template image, most thumbnails
 * expired). What is asserted is what a person reads and what the page WRITES. */
'use strict';
const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');
const R = createReporter('ad-studio');

const CO = 'test-company';
const XSS = '<img src=x onerror="window.__PWNED__=1">Evil Ad';
const W = { window_start: '2025-09-27', data_through: '2026-09-26' };
const ad = (o) => Object.assign({
  ad_name: 'Ad', campaign_name: 'Prospecting Purchase', adset_name: 'Broad', objective: 'purchase',
  first_day: '2026-06-01', last_day: '2026-09-26', days_with_spend: 100,
  spend: 10000, impressions: 1000000, clicks: 15000, conversions: 400, conversion_value: 36000,
  thruplays: null, leads: null, add_to_cart: 900,
  recent_spend: 1400, recent_impressions: 140000, recent_clicks: 2100, recent_conversions: 50, recent_conversion_value: 4500,
  early_impressions: 140000, early_clicks: 2200,
  effective_status: 'ACTIVE', object_type: 'PHOTO', body: 'Hoodie weather is here. Grab yours.', title: null,
  link_url: 'https://www.baseballism.com/collections/hoodies?utm_source=fb', link_url_source: 'asset_feed', link_path: '/collections/hoodies',
  preview_shareable_link: 'https://fb.me/abc', thumbnail_url: 'https://scontent.xx.fbcdn.net/t.jpg?oe=6A000000',
  image_path: null, image_width: null, image_height: null, image_shared_by: null,
}, W, o);

const ADS = [
  // The winner: ROAS 6x on real volume, archived image.
  ad({ ad_id: '101', ad_name: 'Gus Hoodie LS', conversion_value: 60000, image_path: `${CO}/${'a'.repeat(64)}.jpg`, image_shared_by: 0 }),
  // Around baseline.
  ad({ ad_id: '102', ad_name: 'New Releases', object_type: 'SHARE', conversion_value: 30000,
    image_path: `${CO}/${'b'.repeat(64)}.png`, image_shared_by: 4, body: '{{product.brand}} {{product.name}}', preview_shareable_link: 'javascript:alert(1)' }),
  // A great-looking ROAS on 3 purchases: early, never ranked first.
  ad({ ad_id: '103', ad_name: XSS, spend: 300, conversions: 3, conversion_value: 6000, impressions: 20000, clicks: 300, last_day: '2026-07-01', recent_spend: null }),
  // A video buy, judged on cost per ThruPlay.
  ad({ ad_id: '201', ad_name: 'Griffey Aiden', campaign_name: 'Upper Funnel Thruplay', objective: 'thruplay', object_type: 'VIDEO',
    spend: 3000, thruplays: 400000, conversions: 1, conversion_value: 50 }),
  // A second video buy that costs MORE per ThruPlay than the baseline.
  ad({ ad_id: '202', ad_name: 'Pricey Video', campaign_name: 'Upper Funnel Thruplay', objective: 'thruplay', object_type: 'VIDEO',
    spend: 3000, thruplays: 100000, conversions: 0, conversion_value: 0, first_day: '2026-09-20' }),
];
const IDEAS = [
  { id: 'idea-live', company_entity_id: CO, title: 'Hoodie weather, v2', hook: 'Cold mornings.', status: 'live',
    baseline_ad_ids: ['101'], live_ad_ids: ['101'], updated_at: '2026-09-26T00:00:00Z',
    baseline_snapshot: { objective: 'purchase', metric: 'roas', value: 4, data_through: '2026-09-01', ad_ids: ['101'] } },
  { id: 'idea-draft', company_entity_id: CO, title: 'Catalog refresh', hook: null, status: 'idea',
    baseline_ad_ids: [], live_ad_ids: [], baseline_snapshot: null, updated_at: '2026-09-25T00:00:00Z',
    testing_element: null },
  // Two ideas already name what they are testing, one of them past the testing
  // stage: the suggestion list is what the company has USED, not what is being
  // tested right now, and the element stays on the record afterwards.
  { id: 'idea-testing', company_entity_id: CO, title: 'Product fill-out shot', hook: null, status: 'testing',
    baseline_ad_ids: [], live_ad_ids: [], baseline_snapshot: null, updated_at: '2026-09-24T00:00:00Z',
    testing_element: 'Product fill out' },
  // A test with its ad already linked: its result has to be readable on the
  // card while it is still in Testing, because that stage IS the test record now.
  { id: 'idea-testing-measured', company_entity_id: CO, title: 'Hook cut, in test', hook: null, status: 'testing',
    baseline_ad_ids: ['101'], live_ad_ids: ['101'], updated_at: '2026-09-21T00:00:00Z',
    testing_element: 'Hook',
    baseline_snapshot: { objective: 'purchase', metric: 'roas', value: 4, data_through: '2026-09-01', ad_ids: ['101'] } },
  // A test with a bar and nothing running yet: the picker has to be reachable
  // without parking the idea in Live to get at it.
  { id: 'idea-testing-empty', company_entity_id: CO, title: 'Offer threshold test', hook: null, status: 'testing',
    baseline_ad_ids: ['101'], live_ad_ids: [], updated_at: '2026-09-20T00:00:00Z',
    testing_element: 'Offer',
    baseline_snapshot: { objective: 'purchase', metric: 'roas', value: 4, data_through: '2026-09-01', ad_ids: ['101'] } },
  { id: 'idea-plain', company_entity_id: CO, title: 'Bat bag carousel', hook: null, status: 'idea',
    baseline_ad_ids: [], live_ad_ids: [], baseline_snapshot: null, updated_at: '2026-09-22T00:00:00Z',
    testing_element: null },
  { id: 'idea-retired', company_entity_id: CO, title: 'Founder story cut', hook: null, status: 'retired',
    baseline_ad_ids: [], live_ad_ids: [], baseline_snapshot: null, updated_at: '2026-09-23T00:00:00Z',
    testing_element: 'Hook' },
];

(async () => {
  const suite = await startSuite();
  try {
    const ready = () => !!document.querySelector('#grid .as-card, #grid .as-empty') && !!document.querySelector('#detail .as-title, #detail .as-empty');
    // RPC fixtures cross into the page as source text, so the rows ride the
    // table fixture of the same name, which the harness's rpc() falls back to.
    const page = await suite.open('/v2/ad-studio.html', { ad_ideas: IDEAS, ad_studio_ads: ADS }, { ready });

    // ── Baselines ────────────────────────────────────────────────────────
    const rpc = await page.evaluate(() => window.__QUERIES__.find((q) => q.table === 'rpc:ad_studio_ads'));
    R.eq(rpc.args.p_days, 365, 'defaults to the last 12 months');
    R.eq(JSON.stringify(rpc.range), JSON.stringify([0, 999]), 'paged, so more than 1,000 ads are not cut off');
    const objs = await page.locator('#objs').innerText();
    R.has(objs, 'Purchase'); R.has(objs, 'ThruPlay');
    R.eq(await page.locator('#objs [aria-pressed="true"]').getAttribute('data-obj'), 'purchase', 'opens on the objective with the most spend');
    const band = await page.locator('#band').innerText();
    // (60000 + 30000 + 6000) / (10000 + 10000 + 300) = 4.73x -- pooled, where
    // the mean of the three ads' ROAS (6, 3, 20) would be 9.67x.
    R.has(band, '4.73×', 'the baseline is pooled: sum of value over sum of spend');
    R.has(band, 'Meta-reported', 'ROAS says whose revenue it is');

    const names = await page.$$eval('#grid .as-name', (n) => n.map((x) => x.textContent));
    R.eq(names[0], 'Gus Hoodie LS', 'the best against baseline leads');
    R.eq(names[names.length - 1], XSS, 'a 3-purchase ROAS is ranked last, not first');
    R.ok('the hostile ad name is text, not HTML', (await page.evaluate(() => window.__PWNED__)) === undefined);
    const grid = await page.locator('#grid').innerText();
    R.ok('an early ad says so', /early/i.test(grid));
    R.has(await page.locator('#grid .as-card').first().innerText(), 'Strong evidence', 'every card shows its evidence, not only the detail');
    R.ok('the shared catalog image is labelled a template', /template/i.test(grid));
    R.eq(await page.locator('#grid .as-card').first().locator('img').getAttribute('src'),
      `https://fixture.local/signed/${CO}/${'a'.repeat(64)}.jpg`, 'the archived image is drawn through a signed link');
    R.ok('an ad with no archive and an expired thumbnail shows a labelled blank', /not archived yet/i.test(grid));

    // ── Detail ───────────────────────────────────────────────────────────
    const detail = () => page.locator('#detail').innerText();
    let d = await detail();
    R.has(d, 'Gus Hoodie LS');
    R.has(d, 'vs 4.73× baseline');
    R.has(d, 'Hoodie weather is here.');
    R.has(d, 'www.baseballism.com/collections/hoodies');
    R.not(d, 'utm_source', 'the destination is shown without tracking');
    const ask = await page.locator('#detail a[href*="silo-chat.html?q="]').getAttribute('href');
    R.has(decodeURIComponent(ask), 'Gus Hoodie LS');
    R.has(decodeURIComponent(ask), 'Do not predict results.');
    R.eq(await page.locator('#detail a:has-text("Preview on Meta")').getAttribute('href'), 'https://fb.me/abc');

    await page.click('#grid [data-ad="102"]');
    await page.waitForFunction(() => /New Releases/.test(document.querySelector('#detail .as-title')?.textContent || ''));
    d = await detail();
    R.has(d, 'Same image as 4 other ads');
    R.has(d, 'Copy uses catalog placeholders');
    R.eq(await page.locator('#detail .as-copy .as-token').count(), 2, 'placeholders are drawn as fields, not copy');
    const ask102 = decodeURIComponent(await page.locator('#detail a[href*="silo-chat.html?q="]').getAttribute('href'));
    R.not(ask102, '{{', 'no placeholder reaches the Ask SILO prompt');
    R.eq(await page.locator('#detail a:has-text("Preview on Meta")').count(), 0, 'a non-web preview link is never a link');

    // ── Idea from one ad ─────────────────────────────────────────────────
    await page.click('#grid [data-ad="101"]');
    await page.waitForFunction(() => /Gus Hoodie/.test(document.querySelector('#detail .as-title')?.textContent || ''));
    await page.click('#btnIdeaFromAd');
    R.ok('the idea dialog opens pre-filled', await page.evaluate(() => document.getElementById('dlgIdea').open
      && /Gus Hoodie/.test(document.getElementById('iTitle').value) && document.getElementById('iHook').value === 'Hoodie weather is here.'));
    const barText = await page.locator('#iBar').innerText();
    R.has(barText, 'Match the ad you picked: ROAS 6.00×');
    R.has(barText, 'Beat the typical purchase ad: ROAS 4.73×', 'the objective baseline is offered beside the picked ads’ result');
    R.eq(await page.locator('#iLiveWrap').isHidden(), true, 'a new idea does not ask for live ads');
    R.eq(await page.evaluate(() => window.__QUERIES__.filter((q) => q._op === 'insert').length), 0, 'opening the dialog writes nothing');
    await page.click('#btnIdeaSave');
    await page.waitForFunction(() => !document.getElementById('dlgIdea').open);
    const ins = await page.evaluate(() => window.__QUERIES__.filter((q) => q._op === 'insert').map((q) => ({ table: q.table, rows: q.rows })));
    R.eq(ins.length, 1);
    R.eq(ins[0].table, 'ad_ideas');
    R.eq(ins[0].rows.company_entity_id, CO);
    R.eq(JSON.stringify(ins[0].rows.baseline_ad_ids), '["101"]');
    R.eq(ins[0].rows.baseline_snapshot.metric, 'roas');
    R.eq(ins[0].rows.baseline_snapshot.value, 6, 'the bar is the baseline ad’s own pooled ROAS');
    R.eq(ins[0].rows.baseline_snapshot.basis, 'selected');
    R.eq(ins[0].rows.baseline_snapshot.objective_baseline.value, 4.7291, 'the objective baseline is recorded beside it');
    R.eq(JSON.stringify(ins[0].rows.live_ad_ids), '[]');
    R.eq(ins[0].rows.destination_url, 'https://www.baseballism.com/collections/hoodies');
    R.ok('the client never sets who created or approved it', !('created_by' in ins[0].rows) && !('approved_by' in ins[0].rows));

    // ── A selection belongs to one objective ─────────────────────────────
    await page.check('#grid [data-pick="101"]');
    await page.check('#grid [data-pick="102"]');
    R.has(await page.locator('#selCount').innerText(), '2 selected');
    R.has(await page.locator('#selCount').innerText(), 'together ROAS 4.50× vs 4.73× baseline', 'the picked ads’ own result sits beside the baseline');
    await page.click('#btnIdeaFromSel');
    await page.check('#iBar input[value="objective"]');
    await page.click('#btnIdeaSave');
    await page.waitForFunction(() => !document.getElementById('dlgIdea').open);
    const ins2 = await page.evaluate(() => window.__QUERIES__.filter((q) => q._op === 'insert').map((q) => q.rows));
    R.eq(ins2[1].baseline_snapshot.basis, 'objective', 'choosing the typical ad saves that bar');
    R.eq(ins2[1].baseline_snapshot.value, 4.7291);
    R.eq(JSON.stringify(ins2[1].baseline_ad_ids), '["101","102"]');
    await page.check('#grid [data-pick="101"]');
    await page.check('#grid [data-pick="102"]');
    await page.click('#btnClearSel');
    R.eq(await page.locator('#selCount').innerText(), '', 'Clear empties the selection');
    R.eq(await page.locator('#grid [data-pick="101"]').isChecked(), false);
    await page.check('#grid [data-pick="101"]');
    await page.click('#objs [data-obj="thruplay"]');
    await page.waitForFunction(() => !!document.querySelector('#grid [data-pick="201"]'));
    R.eq(await page.locator('#selCount').innerText(), '', 'leaving an objective drops its hidden selection');
    await page.check('#grid [data-pick="201"]');
    R.eq(await page.locator('#grid [data-pick="201"]').isChecked(), true, 'so the new objective can be picked at once');
    const tpGrid = await page.locator('#grid').innerText();
    R.has(tpGrid, 'Higher cost · +$', 'a costlier ad reads as higher cost');
    R.has(tpGrid, 'Lower cost · −$');
    R.not(tpGrid, 'below baseline');
    R.has(await page.locator('#selCount').innerText(), '1 selected');
    await page.click('#btnIdeaFromSel');
    R.has(await page.locator('#iBaselines').innerText(), 'Griffey Aiden', 'the idea is built from what is visibly selected');
    R.not(await page.locator('#iBaselines').innerText(), 'Gus Hoodie');
    await page.click('#dlgIdea [data-close]');
    await page.selectOption('#selWindow', '90');
    await page.waitForFunction(() => !document.getElementById('btnRefresh').disabled && !!document.querySelector('#grid .as-card'));
    R.eq(await page.locator('#selCount').innerText(), '', 'a new window starts the selection over');
    R.eq(await page.locator('#btnIdeaFromSel').isDisabled(), true);

    // ── Idea bank ────────────────────────────────────────────────────────
    await page.click('[data-view="ideas"]');
    const board = await page.locator('#board').innerText();
    R.has(board, 'Hoodie weather, v2');
    R.has(board, 'Beating the bar', 'a live idea is measured against its frozen bar');
    R.has(board, 'No bar set', 'an idea with no baselines says it has nothing to beat');
    R.ok('the view is kept in the address bar', (await page.evaluate(() => location.search)).includes('view=ideas'));
    const cols = (await page.locator('#board .as-col h3').allInnerTexts())
      .map((t) => t.replace(/\s+/g, ' ').replace(/ \d+$/, '').trim());
    R.eq(cols.join(' > '), 'Ideas > Testing > Approved > In production > Live > Retired', 'the board stages, in order');

    // Testing is a plain move: no dialog, and the write is just the status.
    await page.selectOption('[data-move="idea-draft"]', 'testing');
    await page.waitForFunction(() => window.__QUERIES__.some((q) => q._op === 'update'));
    R.eq(await page.evaluate(() => document.getElementById('dlgIdea').open), false, 'moving to testing asks nothing');
    const toTesting = await page.evaluate(() => window.__QUERIES__.filter((q) => q._op === 'update').map((q) => q.patch));
    R.eq(JSON.stringify(toTesting[0]), '{"status":"testing"}', 'the move writes the status alone');
    await page.evaluate(() => { window.__QUERIES__.length = 0; });

    // Moving an idea to live without its ads asks for them first.
    await page.selectOption('[data-move="idea-draft"]', 'live');
    R.ok('going live without ads opens the dialog', await page.evaluate(() => document.getElementById('dlgIdea').open));
    R.eq(await page.locator('#iLiveWrap').isVisible(), true, 'a live idea shows the ad picker');
    await page.click('#btnIdeaSave');
    R.has(await page.locator('#iError').innerText(), 'live idea needs the ads');
    const upd = await page.evaluate(() => window.__QUERIES__.filter((q) => q._op === 'update').length);
    R.eq(upd, 0, 'nothing written while the live idea names no ads');
    await page.fill('#iLiveSearch', 'pricey');
    R.eq(await page.locator('#iLiveList [data-live]').count(), 1, 'the picker searches by name');
    await page.check('#iLiveList [data-live="202"]');
    await page.fill('#iLiveSearch', 'zzz-no-match');
    R.eq(await page.locator('#iLiveList [data-live="202"]').isChecked(), true, 'a ticked ad stays listed whatever the search');
    await page.click('#btnIdeaSave');
    await page.waitForFunction(() => !document.getElementById('dlgIdea').open);
    const up = await page.evaluate(() => window.__QUERIES__.filter((q) => q._op === 'update').map((q) => q.patch || q.rows));
    R.eq(JSON.stringify(up[0].live_ad_ids), '["202"]', 'the ticked ad is what is saved');
    R.eq(up[0].status, 'live');

    // ── The testing element ──────────────────────────────────────────────
    // One optional box, and the reason it is one box: Sammie asked for the
    // element to be named where the idea already lives, so the result comes
    // off the linked ads and nothing else is typed twice. It must not become
    // an empty box on every card, so it is hidden on a plain idea.
    R.has(await page.locator('#board').innerText(), 'Testing Product fill out',
      'the card says what the idea is testing');
    R.not(await page.locator('[data-idea="idea-plain"]').innerText(), 'Testing ',
      'an idea that is testing nothing says nothing');

    await page.click('[data-edit="idea-plain"]');
    await page.waitForFunction(() => document.getElementById('dlgIdea').open);
    R.eq(await page.locator('#iElementWrap').isHidden(), true, 'a plain idea is not asked for an element');
    await page.selectOption('#iStatus', 'testing');
    R.eq(await page.locator('#iElementWrap').isVisible(), true, 'moving it to Testing asks for one');
    // The suggestions are every element the company has used, in both
    // directions: a value from an idea still testing, and one from an idea
    // that has moved on. Retyping either of them by hand is what splits a
    // list meant to group tests.
    R.eq(await page.locator('#iElementList').isHidden(), true, 'the list starts closed');
    await page.click('#iElementOpen');
    const sugg = await page.$$eval('#iElementList li', (o) => o.map((x) => x.textContent).sort());
    R.eq(JSON.stringify(sugg), JSON.stringify(['Hook', 'Offer', 'Product fill out']),
      'the arrow shows what has been used before, deduplicated and sorted');

    // Typing filters the same list, and picking one fills the box.
    await page.fill('#iElement', 'oo');
    R.eq(JSON.stringify(await page.$$eval('#iElementList li', (o) => o.map((x) => x.textContent))),
      JSON.stringify(['Hook']), 'typing narrows it');
    await page.click('#iElementList li');
    R.eq(await page.inputValue('#iElement'), 'Hook', 'picking one fills the box');
    R.eq(await page.locator('#iElementList').isHidden(), true, 'and closes the list');

    // The same list by keyboard: the arrow opens and walks it, Enter takes it.
    await page.fill('#iElement', '');
    // Escape shuts the list, not the dialog behind it.
    await page.keyboard.press('Escape');
    R.eq(await page.locator('#iElementList').isHidden(), true, 'Escape closes the list');
    R.eq(await page.evaluate(() => document.getElementById('dlgIdea').open), true, 'and leaves the dialog open');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    R.eq(await page.inputValue('#iElement'), 'Offer', 'the arrows walk the list and Enter takes the value');
    R.eq(await page.evaluate(() => document.getElementById('dlgIdea').open), true,
      'and Enter on the list does not close the dialog');

    // A value nobody has used before is still just typed in.
    await page.fill('#iElement', 'Thumbnail');
    R.eq(await page.locator('#iElementList').isHidden(), true, 'a new element matches nothing, so no list is in the way');
    R.eq(await page.locator('#iElementNote').count(), 0, 'no instructions under the field');

    // Too long is said before the save, not by the database's constraint name.
    // The box's own maxlength stops a person getting here, so the value is set
    // the way a bug or a future caller would -- past the attribute -- and what
    // is asserted is that the check behind it still refuses to write.
    const updatesSoFar = await page.evaluate(() => window.__QUERIES__.filter((q) => q._op === 'update').length);
    await page.evaluate(() => { document.getElementById('iElement').value = 'x'.repeat(121); });
    await page.click('#btnIdeaSave');
    R.has(await page.locator('#iError').innerText(), 'under 120 characters');
    R.eq(await page.evaluate(() => window.__QUERIES__.filter((q) => q._op === 'update').length), updatesSoFar,
      'nothing written while the element is too long');
    R.eq(await page.evaluate(() => document.getElementById('dlgIdea').open), true, 'and the dialog stays open');

    await page.fill('#iElement', '  Product fill out  ');
    await page.click('#btnIdeaSave');
    await page.waitForFunction(() => !document.getElementById('dlgIdea').open);
    const el = (await page.evaluate(() => window.__QUERIES__.filter((q) => q._op === 'update').map((q) => q.patch))).pop();
    R.eq(el.testing_element, 'Product fill out', 'the element is saved trimmed, so it matches the suggestion');
    R.eq(el.status, 'testing');

    // An emptied box is NULL, not an empty string: "nobody said" and "the
    // empty element" must not become two different stored values.
    await page.click('[data-edit="idea-testing"]');
    await page.waitForFunction(() => document.getElementById('dlgIdea').open);
    R.eq(await page.inputValue('#iElement'), 'Product fill out', 'an existing element is shown for editing');
    await page.fill('#iElement', '   ');
    await page.click('#btnIdeaSave');
    await page.waitForFunction(() => !document.getElementById('dlgIdea').open);
    const cleared = (await page.evaluate(() => window.__QUERIES__.filter((q) => q._op === 'update').map((q) => q.patch))).pop();
    R.eq(cleared.testing_element, null, 'a whitespace-only element is written as null');

    // And the element a live or retired idea was testing is still on the
    // record: it is not hidden again once the idea moves past Testing.
    await page.click('[data-edit="idea-retired"]');
    await page.waitForFunction(() => document.getElementById('dlgIdea').open);
    R.eq(await page.locator('#iElementWrap').isVisible(), true, 'a retired idea still shows what it tested');
    R.eq(await page.inputValue('#iElement'), 'Hook');
    await page.click('#dlgIdea [data-close]');
    R.ok('the testing element: hidden on a plain idea, suggested from what the company used, '
      + 'trimmed on save, null when emptied, and kept once the idea moves on', true);

    // ── A test can name its ads, and shows its result in Testing ────────
    // The element says WHAT is being tested; the linked ads are how it is
    // judged, and this PR made Testing the whole test record. So the stage has
    // to reach the ad picker without parking the idea in Live to get at it,
    // and the card has to show the measurement while it is still a test.
    R.has(await page.locator('[data-idea="idea-testing-measured"]').innerText(), 'Beating the bar',
      'a test with its ad linked is measured against its bar on the card');
    R.has(await page.locator('[data-idea="idea-testing-empty"]').innerText(), 'No ads linked yet',
      'and a test with nothing running says so, rather than showing nothing');

    await page.click('[data-edit="idea-testing-empty"]');
    await page.waitForFunction(() => document.getElementById('dlgIdea').open);
    R.eq(await page.locator('#iLiveWrap').isVisible(), true,
      'a test in Testing can name the ads carrying it');
    await page.evaluate(() => { window.__QUERIES__.length = 0; });
    await page.fill('#iLiveSearch', 'gus');
    await page.check('#iLiveList [data-live="101"]');
    await page.click('#btnIdeaSave');
    await page.waitForFunction(() => !document.getElementById('dlgIdea').open);
    const linked = (await page.evaluate(() => window.__QUERIES__
      .filter((q) => q._op === 'update').map((q) => q.patch))).pop();
    R.eq(JSON.stringify(linked.live_ad_ids), '["101"]', 'the link is saved');
    R.eq(linked.status, 'testing', 'and the idea stays in Testing to do it');
    R.eq(linked.testing_element, 'Offer', 'with the element it was already testing intact');

    // ── Before the migration is applied ─────────────────────────────────
    // The migration is applied by hand after the merge, so this page runs for
    // a while against a database with no testing_element. The field has to be
    // absent AND absent from the payload: PostgREST refuses a whole write for
    // one unknown column, so a patch carrying it would turn every edit of an
    // idea past the idea stage into "Could not save".
    const pre = await suite.open('/v2/ad-studio.html?view=ideas',
      { ad_ideas: IDEAS, ad_studio_ads: ADS },
      { ready, missingColumns: { ad_ideas: ['testing_element'] } });
    await pre.waitForFunction(() => !!document.querySelector('[data-edit="idea-retired"]'));
    await pre.click('[data-edit="idea-retired"]');
    await pre.waitForFunction(() => document.getElementById('dlgIdea').open);
    R.eq(await pre.locator('#iElementWrap').isHidden(), true,
      'the field is not offered while the database has nowhere to put it');
    await pre.click('#btnIdeaSave');
    await pre.waitForFunction(() => !document.getElementById('dlgIdea').open);
    const prePatch = (await pre.evaluate(() => window.__QUERIES__
      .filter((q) => q._op === 'update').map((q) => q.patch))).pop();
    R.eq('testing_element' in prePatch, false, 'and it is not in the payload either');
    R.eq(await pre.textContent('#iError'), '', 'so the edit saves, rather than failing on an unknown column');
    await pre.close();
  } finally {
    await suite.close();
    if (R.summary().fail) process.exitCode = 1;
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
