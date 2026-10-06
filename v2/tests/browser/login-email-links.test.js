/* pages/login.html, signed out, driven for real: what a person sees when an
 * emailed link is dead or their email is unconfirmed, and what Resend sends.
 *
 * The shared harness's Supabase stand-in is always signed in, which is right
 * for every app page and wrong here, so this suite routes its own stand-in
 * (registered after startSuite(), so it wins) that is signed out and records
 * the auth calls the page makes. */
'use strict';

const { startSuite } = require('../lib/harness');
const { createReporter } = require('../lib/assert');

const R = createReporter('login-email-links (browser)');

const FAKE_AUTH = `
(function () {
  window.__AUTH_CALLS__ = [];
  var rec = function (name, args) { window.__AUTH_CALLS__.push({ name: name, args: args }); };
  window.supabase = { createClient: function () { return {
    auth: {
      getSession: function () {
        return new Promise(function (res) { setTimeout(function () { res({ data: { session: null }, error: null }); }, 0); });
      },
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
      signInWithPassword: function (a) {
        rec('signInWithPassword', a);
        var e = new Error('Email not confirmed'); e.code = 'email_not_confirmed'; e.status = 400;
        return Promise.resolve({ data: { user: null, session: null }, error: e });
      },
      signUp: function (a) {
        rec('signUp', a);
        return Promise.resolve({ data: { user: { id: 'u1', identities: [{ id: 'i1' }] }, session: null }, error: null });
      },
      resend: function (a) {
        rec('resend', a);
        if (window.__RESEND_FAILS__) return Promise.resolve({ data: null, error: { message: 'For security purposes, you can only request this after 42 seconds.' } });
        return Promise.resolve({ data: {}, error: null });
      },
      resetPasswordForEmail: function () { return Promise.resolve({ error: null }); },
      signInWithOtp: function () { return Promise.resolve({ error: null }); },
      signOut: function () { return Promise.resolve({ error: null }); }
    },
    from: function () { throw new Error('no table reads expected while signed out'); },
    rpc: function () { throw new Error('no rpc expected while signed out'); }
  }; } };
})();`;

const CONFIG = `window.__SILO_CONFIG__ = {
  SUPABASE_URL: 'https://fixture.supabase.co',
  SUPABASE_ANON_KEY: '${'k'.repeat(60)}',
  EXPECT_EMAIL_CONFIRMATION: true,
  setActiveCompany: function () {}
};`;

const NEXT = '/v2/company-onboarding.html?invite=abc123';

(async () => {
  const suite = await startSuite();
  await suite.context.route('**/cdn.jsdelivr.net/**supabase**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: FAKE_AUTH }));
  await suite.context.route('**/pages/config.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: CONFIG }));

  const visible = (page, sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    return !!el && !el.classList.contains('hidden') && !el.closest('.hidden');
  }, sel);
  const status = (page) => page.evaluate(() => document.getElementById('status').textContent);
  const calls = (page, name) => page.evaluate((n) => window.__AUTH_CALLS__.filter((c) => c.name === n), name);
  const settle = (page) => page.waitForTimeout(250);
  const open = async (url) => {
    const page = await suite.context.newPage();
    page.on('pageerror', (e) => { console.log('  [pageerror] ' + e.message); });
    await page.goto(suite.base + url, { waitUntil: 'domcontentloaded' });
    await settle(page);
    return page;
  };

  try {
    // 1. A dead link lands with the reason in the hash.
    {
      const page = await open('/pages/login.html?next=' + encodeURIComponent(NEXT) +
        '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
      const text = await status(page);
      R.ok('an expired link says so', /expired or was already used/.test(text), text);
      R.ok('it says what to do if already confirmed', /already confirmed your email, sign in/.test(text), text);
      R.ok('the Resend button is offered', await visible(page, '#btnResend'));
      R.ok('the owner-signup dialog does NOT open over it (they already have an account)',
        !(await page.evaluate(() => document.getElementById('dlgSignup').open)));
      const href = await page.evaluate(() => location.pathname + location.search + location.hash);
      R.ok('the error is scrubbed from the address, next kept',
        href === '/pages/login.html?next=' + encodeURIComponent(NEXT), href);

      // Resend with no email typed: asks for one, sends nothing.
      await page.click('#btnResend');
      await settle(page);
      R.ok('resend with an empty Email field asks for one', /Enter your email/.test(await status(page)), await status(page));
      R.ok('...and sends nothing', (await calls(page, 'resend')).length === 0);

      await page.fill('#email1', 'joel@example.com');
      await page.click('#btnResend');
      await settle(page);
      const sent = await calls(page, 'resend');
      R.ok('resend sends exactly one signup confirmation', sent.length === 1 && sent[0].args.type === 'signup', JSON.stringify(sent));
      R.ok('for the typed email', sent[0] && sent[0].args.email === 'joel@example.com');
      const redirect = sent[0] && sent[0].args.options && sent[0].args.options.emailRedirectTo;
      R.ok('the new link returns to company setup (next carried)',
        typeof redirect === 'string' && redirect.includes('next=' + encodeURIComponent(NEXT)), redirect);
      R.ok('the redirect carries no stale error', typeof redirect === 'string' && !/error/.test(redirect), redirect);
      R.ok('the confirmation message is true whatever the account state',
        /If joel@example\.com still needs confirming/.test(await status(page)), await status(page));

      // Supabase's rate limit is shown as it is.
      await page.evaluate(() => { window.__RESEND_FAILS__ = true; });
      await page.click('#btnResend');
      await settle(page);
      R.ok('a rate-limited resend shows Supabase\'s own reason', /after 42 seconds/.test(await status(page)), await status(page));
      await page.close();
    }

    // 2. Signing in to an unconfirmed account.
    {
      const page = await open('/pages/login.html');
      R.ok('a plain visit shows no resend button', !(await visible(page, '#btnResend')));
      await page.fill('#email1', 'joel@example.com');
      await page.fill('#password', 'secret123');
      await page.click('#btnLogin');
      await settle(page);
      const text = await status(page);
      R.ok('"Email not confirmed" is explained, not shown raw', /hasn't been confirmed yet/.test(text), text);
      R.ok('...with the Resend button', await visible(page, '#btnResend'));
      // Switching tabs clears the status and must take the button with it.
      await page.click('#tabMagic');
      R.ok('switching tabs hides the resend button with the message', !(await visible(page, '#btnResend')));
      await page.close();
    }

    // 3. Creating the account: the message says the email link is the next step.
    {
      const page = await open('/pages/login.html?next=' + encodeURIComponent(NEXT));
      R.ok('the owner-signup dialog opens on a company-setup invite',
        await page.evaluate(() => document.getElementById('dlgSignup').open));
      await page.fill('#name3', 'Joel');
      await page.fill('#email3', 'joel@example.com');
      await page.fill('#password3', 'secret123');
      await page.click('#btnSignup');
      await settle(page);
      const text = await status(page);
      R.ok('after signup the page says to click the emailed link', /We emailed a confirmation link to joel@example\.com/.test(text), text);
      R.ok('...and that signing in first is not needed', /no need to sign in first/.test(text), text);
      R.ok('...with Resend ready and the email prefilled',
        (await visible(page, '#btnResend')) && (await page.inputValue('#email1')) === 'joel@example.com');
      await page.close();
    }
  } finally {
    await suite.close();
  }
  const s = R.summary();
  process.exit(s.fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
