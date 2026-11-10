/* The TikTok Ads card on the real Integrations page.
 *
 * Why this suite exists: TikTok rows live in ad_platform_connections like
 * every other ad platform, so the card and the generic "Ad platforms" table
 * read the SAME rows. Drawn in both, one connection would be editable in two
 * places and either copy could overwrite the other. And a connection whose
 * advertiser has not been chosen syncs nothing at all, which is invisible
 * unless the card says so.
 *
 * Mutations (each must fail at least one assertion):
 *   TIKTOK_CARD_MUTATION=no-filter     tiktok rows are drawn in the ads table too
 *   TIKTOK_CARD_MUTATION=no-card       loadAdConnections stops drawing the card
 *   TIKTOK_CARD_MUTATION=silent-choice the "choose an advertiser" prompt disappears
 *   TIKTOK_CARD_MUTATION=no-sync-now   TikTok loses Sync now (back to waiting for the nightly)
 */
'use strict';
const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');
const assert = require('node:assert/strict');
const R = createReporter('integrations-tiktok-card');

const MUTATIONS = {
  'no-filter': ["      rows = rows.filter((row) => row.platform !== 'tiktok_ads');", '      rows = rows.slice();'],
  'no-card': ['      renderTiktokConnections(data || []);', '      void 0;'],
  'silent-choice': [
    "          ? '<div class=\"int-muted\">Choose which advertiser SILO reads — nothing syncs until you do.</div>'",
    "          ? ''",
  ],
  'no-sync-now': [
    "    const SYNC_NOW_PLATFORMS = ['google_ads', 'ga4', 'meta_ads', 'tiktok_ads'];",
    "    const SYNC_NOW_PLATFORMS = ['google_ads', 'ga4', 'meta_ads'];",
  ],
};
const MUT = process.env.TIKTOK_CARD_MUTATION || '';
assert.ok(!MUT || MUTATIONS[MUT], `Unknown mutation ${MUT}`);
const transform = (rel, source) => {
  if (!MUT || !rel.endsWith('/integrations.html')) return source;
  const [from, to] = MUTATIONS[MUT];
  assert.ok(source.includes(from), `mutation ${MUT}: pattern missing`);
  return source.split(from).join(to);
};

(async () => {
  const suite = await startSuite({ transform });
  try {
    const co = 'test-company';
    const adRow = (over) => ({
      company_entity_id: co, is_active: true, sync_enabled: false, display_name: 'Ads',
      last_tested_at: null, last_test_success: null, last_test_error: null,
      google_customer_id: null, meta_ad_account_id: null, tiktok_advertiser_id: null,
      ga4_property_id: null, search_console_site_url: null,
      facebook_page_id: null, instagram_business_account_id: null, ...over,
    });
    const tables = {
      ad_platform_connections: [
        adRow({ id: 'g1', platform: 'google_ads', display_name: 'Google Ads', google_customer_id: '123-456-7890', sync_enabled: true }),
        // Connected, advertiser not chosen yet: the state that syncs nothing.
        adRow({ id: 't1', platform: 'tiktok_ads', display_name: 'Acme Supply Co' }),
      ],
    };
    const ready = () => !!document.querySelector('#tiktok-connections-list tr');

    const page = await suite.open('/v2/integrations.html', tables, { ready, rpc: { is_admin_user: true } });
    await page.waitForFunction(
      () => (document.querySelector('#ad-connections-list')?.textContent || '').includes('Google Ads'),
      null, { timeout: 8000 },
    ).catch(() => {});

    const card = () => document.querySelector('#tiktok-connections-list')?.textContent || '';
    const adsTable = () => document.querySelector('#ad-connections-list')?.textContent || '';
    const cardHtml = () => document.querySelector('#tiktok-connections-list')?.innerHTML || '';

    // The display name lives in an input's value, so the markup is what carries it.
    R.has(await page.evaluate(cardHtml), 'Acme Supply Co', 'the TikTok connection is drawn on its own card');
    R.has(await page.evaluate(adsTable), 'Google Ads', 'the other ad platforms still fill the table above');
    R.not(await page.evaluate(() => document.querySelector('#ad-connections-list')?.innerHTML || ''), 'Acme Supply Co');
    R.eq(
      await page.evaluate(() => document.querySelectorAll('#ad-connections-list tr').length),
      1,
      'exactly one row above: TikTok must not be drawn in both places',
    );
    R.has(await page.evaluate(card), 'Choose which advertiser',
      'a connection with no advertiser says nothing syncs until one is chosen');
    R.has(await page.evaluate(cardHtml), 'syncAdConnection',
      'Sync now is offered, so the first pull does not wait for the nightly');
    R.has(await page.evaluate(cardHtml), 'openAccountPicker');
    await page.close();

    // Advertiser chosen and syncing: the prompt is gone, the id is shown.
    const chosen = {
      ad_platform_connections: [
        adRow({
          id: 't1', platform: 'tiktok_ads', display_name: 'Acme Supply Co',
          tiktok_advertiser_id: '7012345678901234567', sync_enabled: true,
          last_tested_at: new Date().toISOString(), last_test_success: true,
        }),
      ],
    };
    const live = await suite.open('/v2/integrations.html', chosen, { ready, rpc: { is_admin_user: true } });
    R.has(await live.evaluate(cardHtml), '7012345678901234567');
    R.not(await live.evaluate(card), 'Choose which advertiser');
    R.eq(
      await live.evaluate(() => document.querySelector('#tiktok-connections-list input[type="checkbox"]')?.checked),
      true,
      'the nightly toggle reads its stored state',
    );
    R.eq(
      await live.evaluate(() => document.querySelectorAll('#ad-connections-list .empty-state').length),
      1,
      'with only a TikTok connection, the ads table above is empty rather than showing it',
    );
    await live.close();

    // No TikTok connection at all: the card invites one rather than looking broken.
    const none = await suite.open('/v2/integrations.html', { ad_platform_connections: [] },
      { ready, rpc: { is_admin_user: true } });
    R.has(await none.evaluate(card), 'Not connected');
    R.eq(await none.evaluate(() => !!document.querySelector('#btn-connect-tiktok')), true,
      'the connect button is offered to every company, not just the grandfathered one');
    R.eq(await none.evaluate(() => document.querySelector('#btn-connect-tiktok').hidden), false);
    await none.close();
  } finally {
    await suite.close();
    if (R.summary().fail) process.exitCode = 1;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
