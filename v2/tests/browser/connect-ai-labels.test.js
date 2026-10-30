/* Connect AI, "Everyone's apps": a colleague's connection reads as the app
   and the person, not "Application 8d035da1, approved by 35539e42-..."
   (Blake, 2026-10-30, the first connections made by other people). Supabase's
   own grant list only knows the viewer's connections, so the names come from
   silo_api_connection_labels. Before that migration is applied the page must
   still load, with no raw user id on it. */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const r = createReporter('connect-ai-labels');

const DAY = 24 * 60 * 60 * 1000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
const COLLEAGUE = '35539e42-a1e6-46f6-ad19-dc33ad436eb6';

const fixtures = () => ({
  silo_api_grants: [
    {
      id: 'g-mine', client_id: 'c-claude', user_id: 'test-user', company_entity_id: 'test-company',
      scopes: ['reports:read'], consented_at: iso(1), expires_at: iso(-89), revoked_at: null, last_used_at: null,
    },
    {
      id: 'g-theirs', client_id: '8d035da1-5a5d-4cc2-9193-b2fe630c4ab2', user_id: COLLEAGUE,
      company_entity_id: 'test-company', scopes: ['reports:read'], consented_at: iso(0.01),
      expires_at: iso(-90), revoked_at: null, last_used_at: null,
    },
  ],
  entities: [{ id: 'test-company', title: 'Baseballism' }],
  profiles: [{ id: 'test-user', email: 'test@baseballism.com', role: 'admin', active_company_id: 'test-company' }],
  entity_memberships: [{ entity_id: 'test-company', user_id: 'test-user', role: 'owner_admin' }],
});

async function open(suite, rpc) {
  await suite.context.route('**/auth/v1/user/oauth/grants', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([{ client_id: 'c-claude', client_name: 'Claude' }]),
  }));
  return suite.open('/v2/settings-connect-ai.html', fixtures(), {
    rpc,
    ready: () => document.querySelectorAll('#gridCompany .cn-app').length === 2,
  });
}

const card = (page, id) => page.locator('#gridCompany .cn-app[data-grant="' + id + '"]');

(async () => {
  const suite = await startSuite({ viewport: { width: 1280, height: 1000 }, secureContext: true });
  const page = await open(suite, {
    silo_api_connection_labels: (args) => {
      window.__LABEL_ARGS__ = args;
      return [
        { grant_id: 'g-mine', client_name: 'Claude', approver_name: 'Test Person', approver_email: 'test@baseballism.com' },
        { grant_id: 'g-theirs', client_name: 'ChatGPT', approver_name: 'Jon Loomis', approver_email: 'loomis@baseballism.com' },
      ];
    },
  });

  const theirs = (await card(page, 'g-theirs').textContent()).replace(/\s+/g, ' ');
  r.ok('a colleague\'s connection is named by its application', /ChatGPT/.test(theirs));
  r.ok('and says who approved it, by name', /Approved by Jon Loomis/.test(theirs));
  r.ok('with no raw user id or "Application <id>" left', !theirs.includes(COLLEAGUE) && !/Application 8d035da1/.test(theirs));
  r.ok('your own still reads "Approved by you"',
    /Approved by you/.test(await card(page, 'g-mine').textContent()));
  const args = await page.evaluate(() => window.__LABEL_ARGS__);
  r.test('one call, for exactly the live connections on the page',
    () => r.eq([...args.p_grant_ids].sort(), ['g-mine', 'g-theirs']));
  await suite.close();

  /* The page ships before the migration is applied (Blake merges, then
     applies). Without the function: still loads, and no uuid on screen. */
  const before = await startSuite({ viewport: { width: 1280, height: 1000 }, secureContext: true });
  const page2 = await open(before, {});
  const t2 = (await card(page2, 'g-theirs').textContent()).replace(/\s+/g, ' ');
  r.ok('before the migration the page still loads both cards',
    (await page2.locator('#gridCompany .cn-app').count()) === 2);
  r.ok('and shows no raw user id', !t2.includes(COLLEAGUE) && /Approved by someone else/.test(t2));
  await before.close();

  const out = r.summary();
  process.exit(out.fail ? 1 : 0);
})().catch((e) => {
  console.log('  FAIL suite crashed\n        ' + (e && e.message ? e.message : String(e)));
  r.summary();
  process.exit(1);
});
