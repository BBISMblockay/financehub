/* The consent screen's company default.

   This is the case the first review of #1095 found still broken: a reconnect
   under a FRESH dynamic client registration. Every MCP client registers itself
   again on each connect, so Supabase has never seen that client_id, returns an
   authorization_id, and the page takes the FRESH-consent path -- not the
   auto-approved repeat path. The prior-company lookup was gated on that repeat
   path, so the very case it exists for never reached it.

   Why it matters: silo_api_consent() binds the connection to whatever company
   is ACTIVE and revokes the previous grant in the same breath. Someone who
   connected Cursor to company A, later switched SILO to company B, and then
   reconnects would hand Cursor company B's numbers with one unchanged click. */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const r = createReporter('api-consent-company');

const CO_A = 'company-a';
const CO_B = 'company-b';
const FRESH_CLIENT = '003c8729-151f-4f6d-8de0-2244d192e66b';

(async () => {
  const suite = await startSuite({ viewport: { width: 1100, height: 900 }, secureContext: true });

  /* The page draws its enrol pane below aal2, and a real consent screen is
     only reachable from a session that has already done two-step login. */
  await suite.context.addInitScript(() => {
    window.__FIXTURE_MFA__ = {
      currentLevel: 'aal2',
      factors: [{ id: 'f1', status: 'verified', factor_type: 'totp' }],
      calls: [],
    };
  });

  /* Fresh authorization details: an authorization_id IS present, which is what
     makes planFromAuthorizationDetails() return kind 'ask'. api-consent.html
     reaches this over authFetch when the SDK has no oauth helper, which is the
     case under the harness client. */
  await suite.context.route('**/auth/v1/oauth/authorizations/**', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authorization_id: 'authz-1',
        redirect_uri: 'https://www.cursor.com/agents/mcp/oauth/callback',
        client: { id: FRESH_CLIENT, name: 'Cursor' },
        scope: 'reports:read data:read',
      }),
    });
  });

  const page = await suite.open('/v2/api-consent.html?authorization_id=authz-1', {
    entities: [
      { id: CO_A, title: 'Baseballism', entity_key: 'baseballism', entity_type: 'company' },
      { id: CO_B, title: 'STLHD', entity_key: 'stlhd', entity_type: 'company' },
    ],
    profiles: [{ id: 'test-user', email: 'test@baseballism.com', role: 'admin', active_company_id: CO_B }],
    /* The page reads its companies through the embedded relation
       `entity:entities!inner(...)`, so the fixture rows carry it nested, the
       way PostgREST returns them. */
    entity_memberships: [
      {
        entity_id: CO_A, user_id: 'test-user', role: 'admin',
        entity: { id: CO_A, title: 'Baseballism', entity_key: 'baseballism' },
      },
      {
        entity_id: CO_B, user_id: 'test-user', role: 'admin',
        entity: { id: CO_B, title: 'STLHD', entity_key: 'stlhd' },
      },
    ],
  }, {
    // The active company is B. The application's own history is A.
    cachedCompany: { id: CO_B, title: 'STLHD', entity_key: 'stlhd' },
    serverCompany: { id: CO_B, title: 'STLHD', entity_key: 'stlhd' },
    rpc: {
      silo_api_prior_company: (args) => {
        window.__PRIOR_CALLS__ = (window.__PRIOR_CALLS__ || []).concat([args]);
        return 'company-a';
      },
      silo_api_client_for_authorization: () => '003c8729-151f-4f6d-8de0-2244d192e66b',
      set_active_company: () => null,
      silo_api_consent: () => null,
    },
    ready: () => document.body && document.body.innerText.trim().length > 0,
  });

  await page.waitForFunction(() => {
    const s = document.getElementById('coSelect');
    return !!(s && s.options && s.options.length > 1);
  }, { timeout: 10000 });

  const calls = await page.evaluate(() => window.__PRIOR_CALLS__ || []);
  r.test('the prior-company lookup runs on the fresh-consent path too',
    () => r.eq(calls, [{ p_client_id: FRESH_CLIENT }]));

  const selected = await page.inputValue('#coSelect');
  r.test('and the selector starts on the company the application already had, not the active one',
    () => r.eq(selected, CO_A));

  r.ok('both companies are still offered, so changing it stays possible',
    (await page.locator('#coSelect option').count()) === 2);

  /* The name on this path comes from the authorization details, so the heading
     never reads "Approve Application 003c8729?" for a fresh registration. */
  const title = (await page.textContent('#askTitle')) || '';
  r.ok('the application is named from the authorization details', /Cursor/.test(title));

  const shot = process.env.API_CONSENT_SHOT || '/opt/cursor/artifacts/api-consent-company.png';
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
