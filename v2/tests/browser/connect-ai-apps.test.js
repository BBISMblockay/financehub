/* Connect AI, the connected-apps half: one card per live connection, and
   Remove app takes a confirm and then takes the app off the page. */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const r = createReporter('connect-ai-apps');

const DAY = 24 * 60 * 60 * 1000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

(async () => {
  const suite = await startSuite({ viewport: { width: 1280, height: 1000 }, secureContext: true });

  const page = await suite.open('/v2/settings-connect-ai.html', {
    silo_api_grants: [
      {
        id: 'g-claude', client_id: 'c-1', user_id: 'test-user', company_entity_id: 'test-company',
        scopes: ['reports:read'], consented_at: iso(3), expires_at: iso(-87),
        revoked_at: null, last_used_at: iso(1),
      },
      {
        id: 'g-cursor', client_id: 'c-2', user_id: 'test-user', company_entity_id: 'test-company',
        scopes: ['reports:read'], consented_at: iso(10), expires_at: iso(-80),
        revoked_at: null, last_used_at: iso(2),
      },
      // Already removed before this page was opened: it must not come back.
      {
        id: 'g-old', client_id: 'c-3', user_id: 'test-user', company_entity_id: 'test-company',
        scopes: ['reports:read'], consented_at: iso(40), expires_at: iso(-50),
        revoked_at: iso(5), last_used_at: iso(30),
      },
    ],
    entities: [{ id: 'test-company', title: 'Baseballism' }],
    profiles: [{ id: 'test-user', email: 'test@baseballism.com', role: 'admin', active_company_id: 'test-company' }],
    entity_memberships: [{ entity_id: 'test-company', user_id: 'test-user', role: 'admin' }],
  }, {
    rpc: {
      /* Fixture functions are rebuilt INSIDE the page, so what they record has
         to live on window and be read back out. */
      silo_api_revoke: (args) => {
        window.__REVOKED__ = (window.__REVOKED__ || []).concat([args]);
        return true;
      },
    },
    ready: () => !!document.querySelector('#gridMine .cn-app, #gridMine .cn-empty:not(:empty)'),
  });

  await page.waitForFunction(() => document.querySelectorAll('#gridMine .cn-app').length > 0);

  const cardCount = await page.locator('#gridMine .cn-app').count();
  r.test('a live connection per card, and the removed one stays gone',
    () => r.eq(cardCount, 2));

  r.ok('each card carries a mark, not a table row',
    (await page.locator('#gridMine .cn-mark svg, #gridMine .cn-mark .app-mark-letter').count()) === 2);
  r.ok('no table is left on the page', (await page.locator('.ws-table').count()) === 0);
  r.ok('the setup half is on the same page now',
    (await page.locator('.ca-app[data-client="claude"]').count()) === 1);
  const sub0 = (await page.textContent('#mineSub')).trim();
  r.test('the count names live connections only', () => r.eq(sub0, '2 connected'));

  const shotList = process.env.CONNECTED_APPS_SHOT_LIST || '/opt/cursor/artifacts/connect-ai-apps-list.png';
  try { await page.screenshot({ path: shotList, fullPage: true }); }
  catch (_) { console.log('  note: screenshot not written (' + shotList + ')'); }

  /* Removing is two steps. The first click must not revoke anything: a
     one-click Remove on a card beside another card is how the wrong
     application gets disconnected. */
  await page.click('#gridMine .cn-app[data-grant="g-claude"] [data-ask]');
  const after1 = await page.evaluate(() => (window.__REVOKED__ || []).length);
  r.test('the first click asks instead of revoking', () => r.eq(after1, 0));
  r.ok('the confirm is in the card itself',
    (await page.locator('#gridMine .cn-app[data-grant="g-claude"] [data-confirm]').count()) === 1);

  await page.click('#gridMine .cn-app[data-grant="g-claude"] [data-cancel]');
  const afterCancel = await page.evaluate(() => (window.__REVOKED__ || []).length);
  r.test('Keep leaves the connection alone', () => r.eq(afterCancel, 0));
  r.ok('Keep puts the card back as it was',
    (await page.locator('#gridMine .cn-app[data-grant="g-claude"] [data-ask]').count()) === 1);

  await page.click('#gridMine .cn-app[data-grant="g-claude"] [data-ask]');
  await page.click('#gridMine .cn-app[data-grant="g-claude"] [data-confirm]');
  await page.waitForFunction(() => !document.querySelector('.cn-app[data-grant="g-claude"]'));

  const calls = await page.evaluate(() => window.__REVOKED__ || []);
  r.test('confirming revokes that grant and only that one',
    () => r.eq(calls, [{ p_grant_id: 'g-claude' }]));
  r.ok('the removed app leaves the page',
    (await page.locator('#gridMine .cn-app').count()) === 1);
  r.ok('the other connection is untouched',
    (await page.locator('#gridMine .cn-app[data-grant="g-cursor"]').count()) === 1);
  const sub1 = (await page.textContent('#mineSub')).trim();
  r.test('the count follows', () => r.eq(sub1, '1 connected'));

  await page.click('#gridMine .cn-app[data-grant="g-cursor"] [data-ask]');
  await page.click('#gridMine .cn-app[data-grant="g-cursor"] [data-confirm]');
  await page.waitForFunction(() => !document.querySelector('#gridMine .cn-app'));
  r.ok('the last removal leaves an empty state, not a blank box',
    (await page.locator('#gridMine .cn-empty').count()) === 1);

  const shot = process.env.CONNECTED_APPS_SHOT || '/opt/cursor/artifacts/connect-ai-apps.png';
  try { await page.screenshot({ path: shot, fullPage: true }); }
  catch (_) { console.log('  note: screenshot not written (' + shot + ')'); }

  await suite.close();
  const out = r.summary();
  process.exit(out.fail ? 1 : 0);
})().catch((e) => {
  console.log('  FAIL suite crashed\n        ' + (e && e.message ? e.message : String(e)));
  r.summary();
  process.exit(1);
});
