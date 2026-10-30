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

  /* Both connections report the same NAME with different client ids, which is
     exactly what reconnecting Claude produces (Blake, 2026-10-30). */
  await suite.context.route('**/auth/v1/user/oauth/grants', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([
      { client_id: 'c-1', client_name: 'Claude' },
      { client_id: 'c-2', client_name: 'Claude' },
    ]),
  }));

  /* The sign-out half: DELETE .../grants?client_id=... . Its own route,
     because the glob above has no query string and so never sees it. */
  const deletes = [];
  await suite.context.route('**/auth/v1/user/oauth/grants?*', (route) => {
    deletes.push({ method: route.request().method(), url: route.request().url() });
    return route.fulfill({ status: 204, body: '' });
  });

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
    (await page.locator('.ca-row[data-client="claude"]').count()) === 1);

  /* Two connections to the SAME app, which is what you get by reconnecting:
     each card has to say which is which, or Remove is a coin flip. */
  const names = await page.locator('#gridMine .cn-name').allTextContents();
  r.ok('both cards name the same app', names.filter((n) => /Claude/.test(n)).length === 2);
  const tags = await page.locator('#gridMine .cn-tag').allTextContents();
  r.test('and each carries its own client id, which is what differs',
    () => r.eq(tags, ['c-1', 'c-2']));
  const used = await page.locator('#gridMine .cn-meta span').first().textContent();
  r.ok('last used itself reads as a relative time, not a bare date',
    /^Last used (\d+ (minute|hour|day)s? ago|just now|never)$/.test(used.trim()));
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

  /* Shipped broken on 2026-10-30: the SDK wanted `{ clientId }` and got a
     bare string, so the browser sent `client_id=undefined`, Supabase answered
     400, and the page still said the app was signed out. Claude kept its
     token, the MCP server kept 401ing it, and it showed no tools. */
  r.test('the sign-out carries that card’s real client id', () => r.eq(
    deletes.map((d) => d.method + ' ' + new URL(d.url).searchParams.get('client_id')),
    ['DELETE c-1']));
  const okStatus = (await page.textContent('#status')).trim();
  r.ok('and only then does it say the application was signed out',
    /signed out/i.test(okStatus));

  await page.click('#gridMine .cn-app[data-grant="g-cursor"] [data-ask]');
  await page.click('#gridMine .cn-app[data-grant="g-cursor"] [data-confirm]');
  await page.waitForFunction(() => !document.querySelector('#gridMine .cn-app'));
  r.ok('the last removal leaves an empty state, not a blank box',
    (await page.locator('#gridMine .cn-empty').count()) === 1);

  const shot = process.env.CONNECTED_APPS_SHOT || '/opt/cursor/artifacts/connect-ai-apps.png';
  try { await page.screenshot({ path: shot, fullPage: true }); }
  catch (_) { console.log('  note: screenshot not written (' + shot + ')'); }

  /* The apps list must not sit behind MCP discovery: that call is about the
     server address, and this page is now the only place to remove an app.
     Review cycle 1 on #1073 caught the two chained. */
  const stalled = await startSuite({ viewport: { width: 1280, height: 900 }, secureContext: true });
  let release;
  const held = new Promise((res) => { release = res; });
  await stalled.context.route('**/functions/v1/mcp/.well-known/oauth-protected-resource', async (route) => {
    await held;
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  const page2 = await stalled.open('/v2/settings-connect-ai.html', {
    silo_api_grants: [{
      id: 'g-one', client_id: 'c-9', user_id: 'test-user', company_entity_id: 'test-company',
      scopes: ['reports:read'], consented_at: iso(2), expires_at: iso(-88),
      revoked_at: null, last_used_at: iso(1),
    }],
    entities: [{ id: 'test-company', title: 'Baseballism' }],
    profiles: [{ id: 'test-user', email: 'test@baseballism.com', role: 'admin', active_company_id: 'test-company' }],
    entity_memberships: [{ entity_id: 'test-company', user_id: 'test-user', role: 'admin' }],
  }, {
    rpc: {
      silo_api_revoke: (args) => {
        window.__REVOKED__ = (window.__REVOKED__ || []).concat([args]);
        return true;
      },
    },
    ready: () => !!document.querySelector('#gridMine .cn-app'),
  });

  r.ok('the apps load while discovery is still hanging',
    (await page2.locator('#gridMine .cn-app[data-grant="g-one"]').count()) === 1);

  await page2.click('#gridMine .cn-app[data-grant="g-one"] [data-ask]');
  await page2.click('#gridMine .cn-app[data-grant="g-one"] [data-confirm]');
  await page2.waitForFunction(() => !document.querySelector('#gridMine .cn-app'));
  const stalledCalls = await page2.evaluate(() => window.__REVOKED__ || []);
  r.test('removal still reaches exactly that grant with discovery hanging',
    () => r.eq(stalledCalls, [{ p_grant_id: 'g-one' }]));

  release();
  await stalled.close();

  /* A refused sign-out must read as refused. The SDK's own DELETE is
     noResolveJson with no status check, so it reports success on a 400 --
     which is the other half of what shipped broken. */
  const refused = await startSuite({ viewport: { width: 1280, height: 900 }, secureContext: true });
  await refused.context.route('**/auth/v1/user/oauth/grants?*', (route) => route.fulfill({
    status: 400, contentType: 'application/json',
    body: JSON.stringify({ msg: 'invalid client_id format' }),
  }));
  const page3 = await refused.open('/v2/settings-connect-ai.html', {
    silo_api_grants: [{
      id: 'g-bad', client_id: 'c-bad', user_id: 'test-user', company_entity_id: 'test-company',
      scopes: ['reports:read'], consented_at: iso(2), expires_at: iso(-88),
      revoked_at: null, last_used_at: iso(1),
    }],
    entities: [{ id: 'test-company', title: 'Baseballism' }],
    profiles: [{ id: 'test-user', email: 'test@baseballism.com', role: 'admin', active_company_id: 'test-company' }],
    entity_memberships: [{ entity_id: 'test-company', user_id: 'test-user', role: 'admin' }],
  }, {
    rpc: { silo_api_revoke: () => true },
    ready: () => !!document.querySelector('#gridMine .cn-app'),
  });

  await page3.click('#gridMine .cn-app[data-grant="g-bad"] [data-ask]');
  await page3.click('#gridMine .cn-app[data-grant="g-bad"] [data-confirm]');
  await page3.waitForFunction(() => !document.querySelector('#gridMine .cn-app'));
  const badStatus = (await page3.textContent('#status')).trim();
  r.ok('a refused sign-out is not reported as a clean one',
    !/signed out/i.test(badStatus));
  r.ok('it says SILO access stopped and the app still needs removing there',
    /could not be revoked/i.test(badStatus) && /remove it in the application/i.test(badStatus));
  r.ok('and it passes on what Supabase said',
    /invalid client_id format/.test(badStatus));
  r.ok('the status reads as a warning, not a success',
    (await page3.getAttribute('#status', 'class') || '').includes('bcn-status--warn'));

  await refused.close();


  await suite.close();
  const out = r.summary();
  process.exit(out.fail ? 1 : 0);
})().catch((e) => {
  console.log('  FAIL suite crashed\n        ' + (e && e.message ? e.message : String(e)));
  r.summary();
  process.exit(1);
});
