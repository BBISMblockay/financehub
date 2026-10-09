/* Silo Admin's Accounts tab: accounts that belong to no company are listed
 * HERE, with why, now that a workspace's Backend hub lists only its members
 * (20261009120000). Driven in a browser against a stand-in that answers the
 * page's RPCs; the database half (who may call platform_list_accounts, and the
 * state it computes) is scripts/tests/workspace-admin-scope-database.test.mjs. */
'use strict';

const path = require('path');
const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');

const R = createReporter('platform-admin-accounts (browser)');

const ACCOUNTS = [
  { user_id: 'f1', email: 'erik@misefootwear.com', name: 'Erik Hernandez', created_at: '2026-10-07T21:34:43Z',
    email_confirmed_at: '2026-10-07T22:30:39Z', last_sign_in_at: '2026-10-07T22:31:01Z', is_active: true,
    companies: [], state: 'founder_invite_pending', founder_invite_expires_at: '2026-10-21T20:15:55Z' },
  { user_id: 'f2', email: 'joel@thegreatpnw.com', name: 'Joel Barbour', created_at: '2026-10-06T14:51:07Z',
    email_confirmed_at: '2026-10-07T22:11:58Z', last_sign_in_at: null, is_active: true,
    companies: [], state: 'founder_invite_pending', founder_invite_expires_at: '2026-10-20T02:49:37Z' },
  { user_id: 'n1', email: 'nobody@example.com', name: null, created_at: '2026-09-28T11:55:55Z',
    email_confirmed_at: null, last_sign_in_at: null, is_active: true,
    companies: [], state: 'unconfirmed', founder_invite_expires_at: null },
  { user_id: 'm1', email: 'mp@suti.co', name: 'Matthias', created_at: '2026-10-07T23:18:07Z',
    email_confirmed_at: '2026-10-07T23:18:15Z', last_sign_in_at: '2026-10-07T23:19:54Z', is_active: true,
    companies: [{ entity_id: 'c1', title: 'Suti', role: 'owner_admin' }], state: 'member', founder_invite_expires_at: null },
];

const fake = (accountsThrows) => `
(function () {
  var ACCOUNTS_THROWS = ${JSON.stringify(!!accountsThrows)};
  var RPC = {
    is_platform_admin: true,
    platform_list_companies: [],
    list_platform_invites: [],
    platform_list_accounts: ${JSON.stringify(ACCOUNTS)}
  };
  function chain(rows) {
    var q = {};
    ['select','eq','neq','in','order','range','limit','is','gte','lte','not','or','filter','match','ilike']
      .forEach(function (m) { q[m] = function () { return q; }; });
    q.maybeSingle = function () { return Promise.resolve({ data: null, error: null }); };
    q.single = q.maybeSingle;
    q.then = function (res, rej) { return Promise.resolve({ data: rows, error: null }).then(res, rej); };
    return q;
  }
  window.supabase = { createClient: function () { return {
    auth: {
      getSession: function () { return Promise.resolve({ data: { session: { user: { id: 'blake', email: 'blake@baseballism.com' } } }, error: null }); },
      getUser: function () { return Promise.resolve({ data: { user: { id: 'blake', email: 'blake@baseballism.com' } }, error: null }); },
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; }
    },
    from: function () { return chain([]); },
    rpc: function (name) {
      // A transport failure (supabase-js rejects rather than resolving with
      // an error) -- what an unknown RPC in another suite's stand-in does.
      if (name === 'platform_list_accounts' && ACCOUNTS_THROWS) return Promise.reject(new Error('network down'));
      if (!(name in RPC)) return Promise.resolve({ data: null, error: null });
      return Promise.resolve({ data: RPC[name], error: null });
    },
    storage: { from: function () { return { getPublicUrl: function () { return { data: {} }; }, createSignedUrl: function () { return Promise.resolve({ data: null }); } }; } }
  }; } };
})();`;

let accountsThrows = false;

(async () => {
  const suite = await startSuite();
  await suite.context.route('**/cdn.jsdelivr.net/**supabase**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: fake(accountsThrows) }));

  const page = await suite.context.newPage();
  page.on('pageerror', (e) => { console.log('  [pageerror] ' + e.message); });
  try {
    await page.goto(suite.base + '/v2/platform-admin.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#admin:not([hidden])', { timeout: 5000 });
    await page.waitForTimeout(300);

    R.ok('the KPI counts accounts with no company',
      (await page.textContent('#kpiNoCompany')).trim() === '3', await page.textContent('#kpiNoCompany'));
    R.ok('the work queue flags invited founders who never finished setup',
      await page.isVisible('#platStuckAlert'));
    const alert = await page.textContent('#platStuckAlert');
    R.ok('...naming both, and nobody who is not a stalled founder',
      /erik@misefootwear\.com/.test(alert) && /joel@thegreatpnw\.com/.test(alert)
        && !/nobody@example\.com/.test(alert) && !/suti/.test(alert), alert);

    await page.click('#platStuckAlert [data-plat-tab-jump="accounts"]');
    R.ok('"See accounts" opens the Accounts tab', await page.isVisible('#panelAccounts'));
    const listed = () => page.$$eval('#tblAccounts [role="listitem"]', (n) => n.map((x) => x.textContent));
    let rows = await listed();
    R.ok('by default only accounts with no company are listed', rows.length === 3, String(rows.length));
    R.ok('a stalled founder says why, with the invite expiry',
      rows.some((t) => /Erik Hernandez/.test(t) && /Founding invite not redeemed/.test(t) && /invite expires/.test(t)));
    R.ok('a founder who never signed in says so', rows.some((t) => /Joel Barbour/.test(t) && /last sign-in never/.test(t)));
    R.ok('an unconfirmed signup is labelled as such', rows.some((t) => /nobody@example\.com/.test(t) && /Email not confirmed/.test(t)));

    await page.selectOption('#accountFilter', 'all');
    rows = await listed();
    R.ok('"All accounts" adds members, with their companies', rows.length === 4 && rows.some((t) => /Suti/.test(t) && /owner_admin/.test(t)));

    if (process.env.SHOT_DIR) {
      await page.selectOption('#accountFilter', 'stranded');
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({ path: path.join(process.env.SHOT_DIR, 'platform-admin-accounts.png'), fullPage: true });
      const phone = await suite.context.newPage();
      await phone.setViewportSize({ width: 390, height: 844 });
      await phone.goto(suite.base + '/v2/platform-admin.html', { waitUntil: 'domcontentloaded' });
      await phone.waitForSelector('#admin:not([hidden])', { timeout: 5000 });
      await phone.click('#tabBtnAccounts');
      await phone.waitForTimeout(300);
      await phone.screenshot({ path: path.join(process.env.SHOT_DIR, 'platform-admin-accounts-mobile.png'), fullPage: true });
      await phone.close();
    }

    // A failure loading accounts stays inside the Accounts tab. It used to
    // reject boot's Promise.all and leave every later handler unbound
    // (public-landing's platform-interest suite, PR #942 CI).
    accountsThrows = true;
    const broken = await suite.context.newPage();
    const errors = [];
    broken.on('pageerror', (e) => errors.push(e.message));
    await broken.goto(suite.base + '/v2/platform-admin.html', { waitUntil: 'domcontentloaded' });
    await broken.waitForSelector('#admin:not([hidden])', { timeout: 5000 });
    await broken.waitForTimeout(300);
    await broken.click('#tabBtnCompanies');
    R.ok('with accounts failing, the rest of the page still works (tabs are bound)',
      await broken.isVisible('#panelCompanies'));
    await broken.click('#tabBtnAccounts');
    R.ok('...and the Accounts tab says what failed', /network down/.test(await broken.textContent('#tblAccounts')),
      await broken.textContent('#tblAccounts'));
    R.ok('...without an uncaught error', errors.length === 0, errors.join('; '));
    await broken.close();
  } finally {
    await page.close();
    await suite.close();
  }
  const s = R.summary();
  process.exit(s.fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
