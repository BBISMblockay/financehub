/* An invited founder confirms their email and must still land on company setup,
 * even when Supabase throws the redirect away.
 *
 * Production, 2026-10-07: erik@... was sent a company-creation link, created
 * an account from it (signup asked Supabase to come back to
 * /pages/login.html?next=/v2/company-onboarding.html?invite=...), and the
 * confirmation email's link came back to the bare Site URL instead. The root
 * page sent the auth hash to set-password.html, which asked for a NEW password;
 * he signed in on a login page that no longer knew about the invite and was
 * told "this account isn't part of an organization yet". The invite stayed
 * pending. Joel's signup the day before had the same redirect.
 *
 * Driven for real in a browser, against a Supabase stand-in whose session and
 * memberships each step sets: the stand-in is served fresh per request, so one
 * browser context (one localStorage, as for a real person) walks the whole
 * sequence. */
'use strict';

const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');

const R = createReporter('login-founder-invite-recovery (browser)');

const NEXT = '/v2/company-onboarding.html?invite=abc123';
const KEY = 'silo:founder-invite:next';

// What the stand-in serves on the NEXT page load. Changed between steps.
const world = { email: null, memberships: [] };

function fakeAuth(asModule) {
  const session = world.email
    ? { user: { id: 'u-' + world.email, email: world.email }, access_token: 't' }
    : null;
  const body = `
  var SESSION = ${JSON.stringify(session)};
  var MEMBERSHIPS = ${JSON.stringify(world.memberships)};
  window.__AUTH_CALLS__ = [];
  var rec = function (name, args) { window.__AUTH_CALLS__.push({ name: name, args: args }); };
  function query(table) {
    var q = {
      select: function () { return q; }, eq: function () { return q; },
      maybeSingle: function () {
        if (table === 'profiles') return Promise.resolve({ data: { role: 'user', department: null, is_active: true, default_page: null }, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then: function (res, rej) {
        var rows = table === 'entity_memberships' ? MEMBERSHIPS : [];
        return Promise.resolve({ data: rows, error: null }).then(res, rej);
      }
    };
    return q;
  }
  function createClient() { return {
    auth: {
      getSession: function () { return Promise.resolve({ data: { session: SESSION }, error: null }); },
      setSession: function (a) { rec('setSession', a); return Promise.resolve({ data: {}, error: null }); },
      updateUser: function (a) { rec('updateUser', a); return Promise.resolve({ data: {}, error: null }); },
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
      signInWithPassword: function () { return Promise.resolve({ data: { user: null, session: null }, error: { message: 'unused' } }); },
      signUp: function (a) {
        rec('signUp', a);
        return Promise.resolve({ data: { user: { id: 'u1', identities: [{ id: 'i1' }] }, session: null }, error: null });
      },
      resend: function (a) { rec('resend', a); return Promise.resolve({ data: {}, error: null }); },
      resetPasswordForEmail: function () { return Promise.resolve({ error: null }); },
      signInWithOtp: function () { return Promise.resolve({ error: null }); },
      signOut: function () { return Promise.resolve({ error: null }); }
    },
    from: query,
    rpc: function () { return Promise.resolve({ data: null, error: null }); }
  }; }`;
  return asModule
    ? body + '\nexport { createClient };'
    : '(function () {' + body + '\nwindow.supabase = { createClient: createClient };\n})();';
}

const CONFIG = `window.__SILO_CONFIG__ = {
  SUPABASE_URL: 'https://fixture.supabase.co',
  SUPABASE_ANON_KEY: '${'k'.repeat(60)}',
  EXPECT_EMAIL_CONFIRMATION: true,
  setActiveCompany: function () {}
};`;

(async () => {
  const suite = await startSuite();
  // Registered after startSuite(), so these win over the harness's own.
  await suite.context.route('**/cdn.jsdelivr.net/**supabase**', (route) => {
    const esm = route.request().url().includes('+esm');
    route.fulfill({ contentType: 'text/javascript', body: fakeAuth(esm) });
  });
  await suite.context.route('**/pages/config.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: CONFIG }));
  // Where people are sent. Only the arrival matters here, not those pages.
  await suite.context.route(/\/v2\/[^?]*\.html/, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>arrived</title>' }));

  const status = (page) => page.evaluate(() => (document.getElementById('status') || {}).textContent || '');
  const stored = (page) => page.evaluate((k) => localStorage.getItem(k), KEY);
  const open = async (url) => {
    const page = await suite.context.newPage();
    page.on('pageerror', (e) => { console.log('  [pageerror] ' + e.message); });
    await page.goto(suite.base + url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    return page;
  };
  const where = (page) => { const u = new URL(page.url()); return u.pathname + u.search; };

  try {
    // 1. Creating the account from the invite keeps the destination here.
    {
      world.email = null; world.memberships = [];
      const page = await open('/pages/login.html?next=' + encodeURIComponent(NEXT));
      await page.fill('#name3', 'Erik');
      await page.fill('#email3', 'Erik@MiseFootwear.com');
      await page.fill('#password3', 'secret123');
      await page.click('#btnSignup');
      await page.waitForTimeout(250);
      const saved = JSON.parse((await stored(page)) || 'null');
      R.ok('signup from a founder invite keeps the destination in this browser',
        saved && saved.next === NEXT, JSON.stringify(saved));
      R.ok('...bound to the account\'s email, normalised', saved && saved.email === 'erik@misefootwear.com');
      await page.close();
    }

    // 1b. A teammate who HAS a company signs in on the same browser before the
    //     founder confirms. Their sign-in must not erase the founder's entry
    //     (cycle-1 review, PR #942: the cleanup ran for any account with a
    //     company, without checking whose entry it was).
    {
      world.email = 'teammate@baseballism.com';
      world.memberships = [{ role: 'admin', entity: { id: 'c0', title: 'Baseballism', entity_key: 'baseballism', meta: {} } }];
      const page = await open('/pages/login.html');
      await page.waitForURL((u) => !u.pathname.startsWith('/pages/login'), { timeout: 3000 }).catch(() => {});
      const saved = JSON.parse((await stored(page)) || 'null');
      R.ok('a different member signing in leaves the founder\'s entry in place',
        saved && saved.email === 'erik@misefootwear.com' && saved.next === NEXT, JSON.stringify(saved));
      await page.close();
    }

    // 2. The confirmation link lands on set-password with type=signup: no
    //    second password, straight on to login.
    {
      world.email = 'erik@misefootwear.com'; world.memberships = [];
      const page = await open('/pages/set-password.html#access_token=a&refresh_token=b&type=signup');
      await page.waitForURL('**/v2/company-onboarding.html**', { timeout: 4000 }).catch(() => {});
      R.ok('a signup confirmation does not ask for a new password',
        !where(page).startsWith('/pages/set-password.html'), where(page));
      R.ok('...and the whole hop ends on company setup (set-password -> login -> onboarding)',
        where(page) === NEXT, where(page));
      await page.close();
    }

    // 3. Signed in, no company, no `next` (the redirect was dropped): back to
    //    company setup.
    {
      world.email = 'erik@misefootwear.com'; world.memberships = [];
      const page = await open('/pages/login.html');
      await page.waitForURL('**/v2/company-onboarding.html**', { timeout: 3000 }).catch(() => {});
      R.ok('the founder, signed in with no company, is returned to company setup',
        where(page) === NEXT, where(page));
      await page.close();
    }

    // 4. A DIFFERENT account in the same browser is not sent to someone
    //    else's invite.
    {
      world.email = 'someone@else.com'; world.memberships = [];
      const page = await open('/pages/login.html');
      R.ok('another account with no company stays on login', where(page) === '/pages/login.html', where(page));
      R.ok('...and is told it has no organization', /isn't part of an organization/.test(await status(page)), await status(page));
      await page.close();
    }

    // 5. An expired entry is not used.
    {
      world.email = 'erik@misefootwear.com'; world.memberships = [];
      const seed = await open('/pages/set-password.html'); // any same-origin page, to write storage
      await seed.evaluate(([k, n]) => localStorage.setItem(k, JSON.stringify({
        next: n, email: 'erik@misefootwear.com', at: Date.now() - 15 * 24 * 3600 * 1000 })), [KEY, NEXT]);
      await seed.close();
      const late = await open('/pages/login.html');
      R.ok('a destination older than an invite\'s lifetime is ignored', where(late) === '/pages/login.html', where(late));
      await late.close();
    }

    // 6. Only a company-onboarding path is ever honoured.
    {
      world.email = 'erik@misefootwear.com'; world.memberships = [];
      const seed = await open('/pages/set-password.html');
      await seed.evaluate((k) => localStorage.setItem(k, JSON.stringify({
        next: '/v2/finance.html', email: 'erik@misefootwear.com', at: Date.now() })), KEY);
      await seed.close();
      const page = await open('/pages/login.html');
      R.ok('a stored path that is not company setup is not followed', where(page) === '/pages/login.html', where(page));
      await page.close();
    }

    // 7. Once the founder has a company, the entry is cleared.
    {
      world.email = 'erik@misefootwear.com'; world.memberships = [];
      const seed = await open('/pages/set-password.html');
      await seed.evaluate(([k, n]) => localStorage.setItem(k, JSON.stringify({
        next: n, email: 'erik@misefootwear.com', at: Date.now() })), [KEY, NEXT]);
      await seed.close();
      world.memberships = [{ role: 'owner_admin', entity: { id: 'c1', title: 'Mise', entity_key: 'mise', meta: {} } }];
      const page = await open('/pages/login.html');
      await page.waitForURL((u) => !u.pathname.startsWith('/pages/login'), { timeout: 3000 }).catch(() => {});
      R.ok('a founder who now has a company goes into the app, not back to setup',
        !where(page).startsWith('/v2/company-onboarding.html') && !where(page).startsWith('/pages/login.html'), where(page));
      const after = await open('/pages/set-password.html');
      R.ok('...and the kept destination is cleared', (await stored(after)) === null, await stored(after));
      await after.close();
      await page.close();
    }
  } finally {
    await suite.close();
  }
  const s = R.summary();
  process.exit(s.fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
