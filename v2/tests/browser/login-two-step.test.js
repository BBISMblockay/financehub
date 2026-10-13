/* Two-step login on pages/login.html and pages/set-password.html, driven for
 * real against a Supabase stand-in that models assurance levels.
 *
 * The property this suite exists for: an account that never turned two-step
 * login on signs in exactly as before (no code step, same redirect), and an
 * account that did is stopped at the code step on every way in -- password,
 * an existing password-only session, and a password-reset link -- before
 * any company is resolved or any page is routed to. */
'use strict';

const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');

const R = createReporter('login-two-step (browser)');

// Installed as an init script so both the UMD page (login) and the ESM page
// (set-password) get the same stand-in. Scenario comes from
// window.__MFA_SCENARIO__, set per page before load.
const FAKE = `
(function () {
  // Read when the page creates its client: the per-page scenario init script
  // runs AFTER this context-level one.
  var sc = {};
  window.__CALLS__ = [];
  var rec = function (n, a) { window.__CALLS__.push({ name: n, args: a }); };
  var listeners = [];
  function b64(o) { return btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\\+/g, '-').replace(/\\//g, '_'); }
  function makeSession(aal) {
    return {
      access_token: 'h.' + b64({ aal: aal, sub: 'u1' }) + '.s',
      user: { id: 'u1', email: 'pat@example.com',
        factors: sc.hasFactor ? [{ id: 'f1', status: 'verified', factor_type: 'totp' }] : [] },
      __aal: aal
    };
  }
  var session = null;
  function emit(evt) { listeners.forEach(function (cb) { try { cb(evt, session); } catch (e) {} }); }
  function later(v) { return new Promise(function (r) { setTimeout(function () { r(v); }, 0); }); }

  function table(name) {
    var q = { name: name };
    var api = {
      select: function () { return api; }, eq: function () { return api; },
      maybeSingle: function () {
        rec('from:' + name);
        if (name === 'profiles') return later({ data: { role: 'admin', department: 'finance', is_active: true, default_page: null }, error: null });
        return later({ data: null, error: null });
      },
      then: function (res, rej) {
        rec('from:' + name);
        var rows = name === 'entity_memberships'
          ? [{ role: 'admin', entity: { id: 'c1', title: 'Co', entity_key: 'co', meta: {} } }] : [];
        return later({ data: rows, error: null }).then(res, rej);
      }
    };
    return api;
  }

  function makeClient() {
    sc = window.__MFA_SCENARIO__ || {};
    session = sc.sessionAtLoad ? makeSession(sc.sessionAtLoad) : null;
    return {
      auth: {
        getSession: function () { return later({ data: { session: session }, error: null }); },
        setSession: function () { return later({ data: { session: session }, error: null }); },
        onAuthStateChange: function (cb) { listeners.push(cb); return { data: { subscription: { unsubscribe: function () {} } } }; },
        signInWithPassword: function (a) {
          rec('signInWithPassword', a);
          session = makeSession('aal1');
          // The real client fires SIGNED_IN as well as resolving: both paths
          // reach resolveAndRedirect, and the code step must hold against both.
          setTimeout(function () { emit('SIGNED_IN'); }, 0);
          return later({ data: { user: session.user, session: session }, error: null });
        },
        signOut: function () { rec('signOut'); session = null; emit('SIGNED_OUT'); return later({ error: null }); },
        updateUser: function (a) { rec('updateUser', a); return later({ data: {}, error: null }); },
        resetPasswordForEmail: function () { return later({ error: null }); },
        signInWithOtp: function () { return later({ error: null }); },
        mfa: {
          getAuthenticatorAssuranceLevel: function () {
            rec('aal');
            if (!session) return later({ data: { currentLevel: null, nextLevel: null }, error: null });
            return later({ data: { currentLevel: session.__aal, nextLevel: sc.hasFactor ? 'aal2' : session.__aal }, error: null });
          },
          listFactors: function () {
            var f = sc.hasFactor ? [{ id: 'f1', status: 'verified', factor_type: 'totp' }] : [];
            return later({ data: { all: f, totp: f }, error: null });
          },
          challengeAndVerify: function (a) {
            rec('challengeAndVerify', a);
            if (a.code !== '123456') {
              return later({ data: null, error: { code: 'mfa_verification_failed', message: 'Invalid TOTP code entered' } });
            }
            session = makeSession('aal2');
            setTimeout(function () { emit('MFA_CHALLENGE_VERIFIED'); }, 0);
            return later({ data: {}, error: null });
          }
        }
      },
      from: table,
      rpc: function (n, a) { rec('rpc:' + n, a); return later({ data: null, error: null }); }
    };
  }
  window.__makeFakeClient = makeClient;
  window.supabase = { createClient: makeClient };
})();`;

const CONFIG = `window.__SILO_CONFIG__ = {
  SUPABASE_URL: 'https://fixture.supabase.co',
  SUPABASE_ANON_KEY: '${'k'.repeat(60)}',
  setActiveCompany: function () {}
};`;

(async () => {
  const suite = await startSuite();
  await suite.context.addInitScript(FAKE);
  await suite.context.route('**/cdn.jsdelivr.net/**supabase**', (route) => {
    const esm = route.request().url().includes('+esm');
    route.fulfill({
      contentType: 'text/javascript',
      body: esm ? 'export function createClient() { return window.__makeFakeClient(); }' : '/* stand-in installed by init script */',
    });
  });
  await suite.context.route('**/pages/config.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: CONFIG }));
  // Where a finished sign-in lands. Served as a stub so arriving is the
  // observable, not whatever finance.html does under a fake client.
  await suite.context.route('**/v2/finance.html', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>landed</title><p id="landed">landed</p>' }));

  const settle = (page, ms) => page.waitForTimeout(ms || 300);
  const shown = (page, sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    if (el.closest('.hidden')) return false;
    let n = el;
    while (n && n.nodeType === 1) { if (getComputedStyle(n).display === 'none') return false; n = n.parentElement; }
    return true;
  }, sel);
  const status = (page) => page.evaluate(() => { const el = document.getElementById('status') || document.getElementById('statusBox'); return el ? el.textContent : '(no status element: ' + location.pathname + ')'; });
  const calls = (page) => page.evaluate(() => (window.__CALLS__ || []).map((c) => c.name));
  const landed = (page) => page.url().endsWith('/v2/finance.html');

  async function open(path, scenario) {
    const page = await suite.context.newPage();
    page.on('pageerror', (e) => { console.log('  [pageerror] ' + e.message); });
    await page.addInitScript((s) => { window.__MFA_SCENARIO__ = s; }, scenario);
    await page.goto(suite.base + path, { waitUntil: 'domcontentloaded' });
    await settle(page);
    return page;
  }

  async function signIn(page) {
    await page.fill('#email1', 'pat@example.com');
    await page.fill('#password', 'secret123');
    await page.click('#btnLogin');
    await settle(page, 500);
  }

  try {
    // 1. No two-step login: identical to before -- no code step, straight in.
    {
      const page = await open('/pages/login.html', { hasFactor: false });
      R.ok('code step hidden on load', !(await shown(page, '#formMfa')));
      await signIn(page);
      R.ok('an account without two-step login lands in the app', landed(page), page.url());
    }

    // 2. Two-step login on: the password alone does not get in.
    {
      const page = await open('/pages/login.html', { hasFactor: true });
      await signIn(page);
      R.ok('password accepted -> code step shown', await shown(page, '#formMfa'));
      R.ok('sign-in forms hidden behind it', !(await shown(page, '#formPassword')) && !(await shown(page, '#authTabs')));
      R.ok('still on the login page', !landed(page), page.url());
      const before = await calls(page);
      R.ok('nothing resolved or routed before the code (no profile/company reads, no RPC)',
        !before.some((n) => n.startsWith('from:') || n.startsWith('rpc:')), before.join(','));
      R.ok('status asks for the code', /code from your authenticator app/.test(await status(page)), await status(page));

      await page.fill('#mfaCode', '000000');
      await page.click('#btnMfa');
      await settle(page);
      R.ok('a wrong code is refused with a plain message', /didn't match/.test(await status(page)), await status(page));
      R.ok('...and does not get in', !landed(page) && (await shown(page, '#formMfa')));

      await page.fill('#mfaCode', '123 456');
      await page.click('#btnMfa');
      await settle(page, 600);
      R.ok('the right code (with a space) gets in', landed(page), page.url());
    }

    // 3. A password-only session left in the browser (tab closed at the code
    //    step) is stopped too, and "Use a different account" ends it.
    {
      const page = await open('/pages/login.html', { hasFactor: true, sessionAtLoad: 'aal1' });
      R.ok('existing password-only session -> code step, not the app', (await shown(page, '#formMfa')) && !landed(page), page.url());
      await page.click('#btnMfaCancel');
      await settle(page);
      R.ok('"Use a different account" signs out', (await calls(page)).includes('signOut'));
      R.ok('...and brings the sign-in form back', (await shown(page, '#formPassword')) && !(await shown(page, '#formMfa')));
    }

    // 4. A session that already entered its code is not asked again.
    {
      const page = await open('/pages/login.html', { hasFactor: true, sessionAtLoad: 'aal2' });
      await settle(page, 400);
      R.ok('verified session goes straight in', landed(page), page.url());
    }

    // 5. Password reset / change: no factor -> password form as before.
    {
      const page = await open('/pages/set-password.html', { hasFactor: false, sessionAtLoad: 'aal1' });
      R.ok('reset without two-step login shows the password form', await shown(page, '#passwordForm'));
      R.ok('...and no code step', !(await shown(page, '#mfaForm')));
    }

    // 6. Password reset with two-step login on: code first.
    {
      const page = await open('/pages/set-password.html', { hasFactor: true, sessionAtLoad: 'aal1' });
      R.ok('reset with two-step login asks for the code first', await shown(page, '#mfaForm'));
      R.ok('...password form hidden until then', !(await shown(page, '#passwordForm')));
      await page.fill('#mfaCode', '111111');
      await page.click('#mfaBtn');
      await settle(page);
      R.ok('wrong code keeps the password form hidden', !(await shown(page, '#passwordForm')), await status(page));
      await page.fill('#mfaCode', '123456');
      await page.click('#mfaBtn');
      await settle(page);
      R.ok('right code reveals the password form', (await shown(page, '#passwordForm')) && !(await shown(page, '#mfaForm')));
      R.ok('no password was changed before the code', !(await calls(page)).includes('updateUser'));
    }
  } finally {
    await suite.close();
  }
  const s = R.summary();
  process.exit(s.fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
