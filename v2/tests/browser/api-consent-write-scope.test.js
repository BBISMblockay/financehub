/* The consent screen's write permission.
 *
 * work:write is the first permission that lets a connected application change
 * anything in SILO, so the one thing that must be true of this screen is that
 * nobody grants it without meaning to: the box is off when the screen opens,
 * nothing about the default click asks for it, and ticking it changes both the
 * list of what the application will be able to do and what the screen promises
 * it cannot.
 *
 * Asserted against the real page, with silo_api_consent() captured:
 *   1. approving without touching anything grants the two read scopes only
 *   2. ticking the box adds work:write, and only that
 *   3. the "will be able to" list and the "will not be able to" line both
 *      change with it -- "change, add or delete anything" would be a lie about
 *      the "add" once writing is on
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const r = createReporter('api-consent-write-scope');

const CO = 'company-a';
const CLIENT = '003c8729-151f-4f6d-8de0-2244d192e66b';

const FIXTURE = {
  entities: [{ id: CO, title: 'Baseballism', entity_key: 'baseballism', entity_type: 'company' }],
  profiles: [{ id: 'test-user', email: 'test@baseballism.com', role: 'admin', active_company_id: CO }],
  entity_memberships: [{
    entity_id: CO, user_id: 'test-user', role: 'admin',
    entity: { id: CO, title: 'Baseballism', entity_key: 'baseballism' },
  }],
};

async function openScreen(suite) {
  await suite.context.addInitScript(() => {
    window.__FIXTURE_MFA__ = { currentLevel: 'aal2', factors: [{ id: 'f1', status: 'verified', factor_type: 'totp' }], calls: [] };
    window.__CONSENT_CALLS__ = [];
  });
  await suite.context.route('**/auth/v1/oauth/authorizations/**', (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ authorization_id: 'authz-1',
          redirect_uri: 'https://www.cursor.com/agents/mcp/oauth/callback',
          client: { id: CLIENT, name: 'Cursor' }, scope: 'reports:read data:read' }) });
    }
    // Approving ends in a redirect; keep it local so the assertion is read
    // from this page and not from somebody else's site.
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ redirect_url: '/v2/api-consent.html?done=1' }) });
  });
  const page = await suite.open('/v2/api-consent.html?authorization_id=authz-1', FIXTURE, {
    cachedCompany: { id: CO, title: 'Baseballism', entity_key: 'baseballism' },
    serverCompany: { id: CO, title: 'Baseballism', entity_key: 'baseballism' },
    rpc: {
      // These run inside the page, so they cannot close over anything here.
      silo_api_prior_company: () => 'company-a',
      silo_api_client_for_authorization: () => '003c8729-151f-4f6d-8de0-2244d192e66b',
      set_active_company: () => null,
      silo_api_consent: (args) => {
        window.__CONSENT_CALLS__ = (window.__CONSENT_CALLS__ || []).concat([args]);
        return null;
      },
    },
    ready: () => document.body && document.body.innerText.trim().length > 0,
  });
  await page.waitForSelector('#optWrite', { timeout: 10000 });
  await page.waitForFunction(() => {
    const b = document.getElementById('btnApprove');
    return !!(b && !b.disabled);
  }, { timeout: 10000 });
  return page;
}

const scopesOf = async (page) => page.evaluate(() => (window.__CONSENT_CALLS__ || []).map((c) => c.p_scopes));

(async () => {
  const suite = await startSuite({ viewport: { width: 1100, height: 900 }, secureContext: true });
  try {
    // ── 1: the default click ────────────────────────────────────────────
    let page = await openScreen(suite);
    r.test('writing is off when the screen opens', async () => {});
    r.eq(await page.isChecked('#optWrite'), false, 'nobody grants a write by not reading');
    const can = (await page.textContent('#canList')) || '';
    r.ok('the list does not mention tasks yet', !/task/i.test(can));
    r.has(await page.textContent('#cannotChange'), 'Change, add or delete anything',
      'and the screen promises nothing can be added');

    await page.click('#btnApprove');
    await page.waitForFunction(() => (window.__CONSENT_CALLS__ || []).length > 0, { timeout: 10000 });
    r.test('approving without ticking it grants reads only', async () => {});
    r.eq((await scopesOf(page))[0], ['reports:read', 'data:read'], 'no work:write anywhere near it');
    await page.close();

    // ── 2 and 3: ticking it ─────────────────────────────────────────────
    page = await openScreen(suite);
    await page.check('#optWrite');
    r.test('ticking the box changes what the screen says, in both directions', async () => {});
    r.has(await page.textContent('#canList'), 'task', 'the application will be able to open a task');
    r.has(await page.textContent('#cannotChange'), 'already exists',
      'and what it cannot do narrows to what already exists, instead of claiming nothing can be added');

    await page.click('#btnApprove');
    await page.waitForFunction(() => (window.__CONSENT_CALLS__ || []).length > 0, { timeout: 10000 });
    const sent = (await scopesOf(page))[0];
    r.test('and it is the one permission added', async () => {});
    r.eq(sent, ['reports:read', 'data:read', 'work:write'], 'the reads are unchanged, writing is appended');
    await page.close();
  } catch (err) {
    r.ok('suite ran without throwing', false, err && err.stack);
  } finally {
    await suite.close();
  }
  const out = r.summary();
  process.exit(out.fail ? 1 : 0);
})();
