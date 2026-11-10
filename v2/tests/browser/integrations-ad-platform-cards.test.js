/* The ad-platform cards on the real Integrations page.
 *
 * Why this suite exists: every ad platform's rows live in ONE table,
 * ad_platform_connections, but the page now draws them as cards grouped by
 * where the connection comes from -- Google (Ads, GA4, Search Console, one
 * sign-in each), Meta (a System User token), TikTok (its own sign-in) --
 * because that is what an admin comes here to do. One row set drawn into
 * several cards is the hazard that creates: a connection drawn twice is
 * editable in two places and either copy can overwrite the other, and a
 * connection whose platform belongs to no card would simply vanish from
 * this page while still syncing every night.
 *
 * It also guards the two states that are invisible unless the page says so:
 * a connection with no account chosen syncs nothing, and Search Console has
 * no "Sync now" because one run fills three tables and rebuilds a rollup.
 *
 * Mutations (each must fail at least one assertion):
 *   AD_CARDS_MUTATION=no-cards      loadAdConnections stops drawing the cards
 *   AD_CARDS_MUTATION=cross-card    every card draws every platform's rows
 *   AD_CARDS_MUTATION=other-hidden  the catch-all card stays hidden with rows in it
 *   AD_CARDS_MUTATION=other-empty   an unknown platform's rows go to no card at all
 *   AD_CARDS_MUTATION=no-source     the Google card stops naming which source each row is
 *   AD_CARDS_MUTATION=silent-choice the "nothing syncs until you choose" prompt disappears
 *   AD_CARDS_MUTATION=no-sync-now   TikTok loses Sync now (back to waiting for the nightly)
 *   AD_CARDS_MUTATION=sc-sync-now   Search Console is offered a Sync now it cannot finish
 *   AD_CARDS_MUTATION=no-organic    the Meta card loses its Page / Instagram fields
 */
'use strict';
const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');
const assert = require('node:assert/strict');
const R = createReporter('integrations-ad-platform-cards');

const MUTATIONS = {
  'no-cards': [['      renderPlatformCards(data || []);', '      void 0;']],
  'cross-card': [['        const mine = rows.filter((row) => platforms.includes(row.platform));', '        const mine = rows.slice();']],
  'other-hidden': [['        card.hidden = !other.length;', '        card.hidden = true;']],
  'other-empty': [['      const other = rows.filter((row) => !CARDED_PLATFORMS.includes(row.platform));', '      const other = [];']],
  'no-source': [['        const withPlatform = platforms.length > 1;', '        const withPlatform = false;']],
  'silent-choice': [['      const needsChoice = !acctVal && CHOOSE_PROMPT[row.platform]', '      const needsChoice = false']],
  'no-sync-now': [[
    "    const SYNC_NOW_PLATFORMS = ['google_ads', 'ga4', 'meta_ads', 'tiktok_ads'];",
    "    const SYNC_NOW_PLATFORMS = ['google_ads', 'ga4', 'meta_ads'];",
  ]],
  'sc-sync-now': [[
    "    const SYNC_NOW_PLATFORMS = ['google_ads', 'ga4', 'meta_ads', 'tiktok_ads'];",
    "    const SYNC_NOW_PLATFORMS = ['google_ads', 'ga4', 'meta_ads', 'tiktok_ads', 'search_console'];",
  ]],
  'no-organic': [["      const organicRow = row.platform !== 'meta_ads' ? '' : `<tr>", '      const organicRow = true ? \'\' : `<tr>']],
};
const MUT = process.env.AD_CARDS_MUTATION || '';
assert.ok(!MUT || MUTATIONS[MUT], `Unknown mutation ${MUT}`);
const transform = (rel, source) => {
  if (!MUT || !rel.endsWith('/integrations.html')) return source;
  for (const [from, to] of MUTATIONS[MUT]) {
    assert.ok(source.includes(from), `mutation ${MUT}: pattern missing`);
    source = source.split(from).join(to);
  }
  return source;
};

// card id -> the platforms it holds, mirroring CARD_PLATFORMS on the page.
const CARDS = { google: ['google_ads', 'ga4', 'search_console'], meta_ads: ['meta_ads'], tiktok_ads: ['tiktok_ads'] };
const PLATFORMS = Object.values(CARDS).flat();
const CARD_OF = Object.fromEntries(Object.entries(CARDS).flatMap(([c, ps]) => ps.map((p) => [p, c])));

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
    // One connection per platform, each with a name no other row shares, so
    // a row drawn on the wrong card is caught by the name alone.
    const tables = {
      ad_platform_connections: [
        adRow({ id: 'g1', platform: 'google_ads', display_name: 'Google Ads Acct', google_customer_id: '123-456-7890', sync_enabled: true }),
        adRow({ id: 'a1', platform: 'ga4', display_name: 'GA4 Property', ga4_property_id: '123456789' }),
        adRow({ id: 's1', platform: 'search_console', display_name: 'SC Property', search_console_site_url: 'sc-domain:example.com' }),
        adRow({ id: 'm1', platform: 'meta_ads', display_name: 'Meta Acct', meta_ad_account_id: 'act_1' }),
        // Connected, advertiser not chosen yet: the state that syncs nothing.
        adRow({ id: 't1', platform: 'tiktok_ads', display_name: 'Acme Supply Co' }),
      ],
    };
    const ready = () => !!document.querySelector('#tiktok_ads-connections-list tr');
    const htmlOf = (c) => document.querySelector(`#${c}-connections-list`)?.innerHTML || '';

    const page = await suite.open('/v2/integrations.html', tables, { ready, rpc: { is_admin_user: true } });
    await page.waitForFunction(
      () => (document.querySelector('#google-connections-list')?.innerHTML || '').includes('Google Ads Acct'),
      null, { timeout: 8000 },
    ).catch(() => {});

    // ── Each connection on exactly one card. Display names live in an
    // input's value, so the markup is what carries them.
    const NAME = {
      google_ads: 'Google Ads Acct', ga4: 'GA4 Property', search_console: 'SC Property',
      meta_ads: 'Meta Acct', tiktok_ads: 'Acme Supply Co',
    };
    for (const [platform, name] of Object.entries(NAME)) {
      for (const card of Object.keys(CARDS)) {
        const html = await page.evaluate(htmlOf, card);
        if (card === CARD_OF[platform]) R.has(html, name, `${platform} is drawn on the ${card} card`);
        else R.not(html, name, `the ${card} card must not draw ${platform}'s connection`);
      }
    }
    R.eq(await page.evaluate(() => document.querySelectorAll('#google-connections-list tr[data-platform]').length), 3,
      'the three Google sources share one card');
    for (const card of ['meta_ads', 'tiktok_ads']) {
      R.eq(await page.evaluate((c) => document.querySelectorAll(`#${c}-connections-list tr[data-platform]`).length, card),
        1, `${card}: exactly one connection row`);
    }

    // A card holding three sources has to say which row is which, and in one
    // order whatever order they were connected in.
    R.eq(
      await page.evaluate(() => [...document.querySelectorAll('#google-connections-list tr[data-platform]')]
        .map((tr) => tr.dataset.platform)),
      ['google_ads', 'ga4', 'search_console'],
      'the Google card keeps its own order, not the order they were connected',
    );
    const googleText = await page.evaluate(() => document.querySelector('#google-connections-list')?.textContent || '');
    for (const label of ['Google Ads', 'GA4', 'Search Console']) {
      R.has(googleText, label, `the Google card names each row's source (${label})`);
    }
    R.not(await page.evaluate(() => document.querySelector('#tiktok_ads-connections-list')?.textContent || ''), 'TikTok Ads',
      'a card holding one source does not repeat it in every row');

    // ── The states the page has to say out loud.
    R.has(await page.evaluate(htmlOf, 'tiktok_ads'), 'nothing syncs until you do',
      'a connection with no account chosen says so: it syncs nothing');
    R.not(await page.evaluate(htmlOf, 'google'), 'nothing syncs until you do');

    // ── Per-platform actions, each on the row it belongs to.
    const rowHtml = (platform) => document.querySelector(`tr[data-platform="${platform}"]`)?.innerHTML || '';
    R.has(await page.evaluate(htmlOf, 'tiktok_ads'), 'syncAdConnection',
      'TikTok offers Sync now, so the first pull does not wait for the nightly');
    R.has(await page.evaluate(htmlOf, 'tiktok_ads'), 'openAccountPicker');
    R.not(await page.evaluate(rowHtml, 'search_console'), 'syncAdConnection',
      'Search Console has no Sync now: one run fills three tables and rebuilds a rollup');
    R.has(await page.evaluate(rowHtml, 'ga4'), 'syncAdConnection', 'GA4 does have one');
    R.has(await page.evaluate(rowHtml, 'google_ads'), 'reconnectAdConnection',
      'a Google sign-in can be renewed in place');
    R.has(await page.evaluate(rowHtml, 'search_console'), 'reconnectAdConnection');
    R.not(await page.evaluate(htmlOf, 'tiktok_ads'), 'reconnectAdConnection',
      'TikTok tokens do not expire: offering Reconnect would invite a pointless re-grant');
    R.has(await page.evaluate(htmlOf, 'meta_ads'), 'toggleMetaTokenForm',
      'Meta is a token, so it is replaced in place rather than re-added');
    R.has(await page.evaluate(htmlOf, 'meta_ads'), 'Instagram Business Account ID',
      'organic rides the same Meta token and needs its two IDs here');

    // ── Every platform can be connected, by anyone who can see the page.
    for (const id of ['btn-connect-google-ads', 'btn-connect-ga4', 'btn-connect-search-console', 'btn-add-meta', 'btn-connect-tiktok']) {
      R.eq(await page.evaluate((i) => !!document.getElementById(i) && !document.getElementById(i).hidden, id),
        true, `${id} is offered`);
    }

    // ── Nothing unknown here, so the catch-all stays out of the way.
    R.eq(await page.evaluate(() => document.getElementById('other-platforms-card')?.hidden), true,
      'the catch-all card is hidden while every connection has a card of its own');
    await page.close();

    // ── A platform added to the table before its card exists must still be
    // visible: it is syncing every night either way.
    const unknown = {
      ad_platform_connections: [adRow({ id: 'x1', platform: 'pinterest_ads', display_name: 'Pinterest Acct' })],
    };
    const odd = await suite.open('/v2/integrations.html', unknown, {
      ready: () => !!document.querySelector('#other-connections-list tr'), rpc: { is_admin_user: true },
    });
    R.eq(await odd.evaluate(() => document.getElementById('other-platforms-card')?.hidden), false,
      'a connection with no card of its own must never be invisible');
    R.has(await odd.evaluate(() => document.querySelector('#other-connections-list')?.innerHTML || ''), 'Pinterest Acct');
    R.has(await odd.evaluate(() => document.querySelector('#other-connections-list')?.textContent || ''), 'pinterest_ads',
      'the catch-all names the platform, which is the one thing its rows do not share');
    for (const card of Object.keys(CARDS)) {
      R.has(await odd.evaluate(htmlOf, card), 'Not connected', `${card}: an empty card invites a connection`);
    }
    await odd.close();

    // ── Chosen and syncing: the prompt is gone and the stored state shows.
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
    R.has(await live.evaluate(htmlOf, 'tiktok_ads'), '7012345678901234567');
    R.not(await live.evaluate(() => document.querySelector('#tiktok_ads-connections-list')?.textContent || ''), 'nothing syncs until you do');
    R.eq(
      await live.evaluate(() => document.querySelector('#tiktok_ads-connections-list input[type="checkbox"]')?.checked),
      true,
      'the nightly toggle reads its stored state',
    );
    await live.close();
  } finally {
    await suite.close();
    if (R.summary().fail) process.exitCode = 1;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
