/* v2/profile.html — the "Two-step login" section: off by default, turned on
 * with a QR code and a first code, turned off with two clicks. Drives the
 * real page and the real pages/mfa.js against the harness's mfa stand-in. */
'use strict';

const { startSuite, CONFIG_STUB } = require('../lib/harness');
const { createReporter } = require('../lib/assert');

const R = createReporter('profile-two-step (browser)');

const TABLES = {
  profiles: [{ id: 'test-user', role: 'admin', department: 'finance', email: 'test@baseballism.com', name: 'Test', is_active: true }],
};
const ready = () => {
  const s = document.getElementById('mfaState');
  return !!s && !document.getElementById('mfaCard').hidden && /On|Off|Unavailable/.test(s.textContent);
};

(async () => {
  const suite = await startSuite();
  const settle = (page) => page.waitForTimeout(250);
  const text = (page, sel) => page.evaluate((s) => document.querySelector(s).textContent.trim(), sel);
  // What the person SEES, not just the attribute: a `display` rule on the
  // element's class beats the UA [hidden] rule (the setup panel shipped that
  // way, 2026-10-14). Both must agree.
  const hidden = (page, sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    const rendered = getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
    if (el.hidden === rendered) throw new Error(`${s}: hidden=${el.hidden} but rendered=${rendered}`);
    return el.hidden;
  }, sel);

  const anyState = () => !!document.getElementById('mfaState') && document.readyState === 'complete';

  try {
    // Production: MFA_ENROLLMENT_OPEN unset. Setup is not offered until the
    // database enforces the code (PR #970 review, cycle 1).
    {
      const page = await suite.open('/v2/profile.html', TABLES, { ready: anyState });
      await page.waitForTimeout(500);
      R.ok('closed: the section is hidden for an account without two-step login', await hidden(page, '#mfaCard'));
      R.ok('closed: the rest of the page still loads', await page.evaluate(() => !document.getElementById('settingsCard').hidden));
      await page.close();
    }
    {
      const page = await suite.open('/v2/profile.html', TABLES, { ready: anyState });
      // Re-runs with the harness's own init scripts on reload.
      await page.addInitScript(() => { window.__FIXTURE_MFA__ = { factors: [{ id: 'fx', status: 'verified', factor_type: 'totp' }], calls: [] }; });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(ready, { timeout: 20000 });
      R.ok('closed: an account that already has it still sees On', (await text(page, '#mfaState')) === 'On');
      R.ok('closed: ...and can turn it off', !(await hidden(page, '#btnMfaOff')));
      R.ok('closed: ...but Turn on is never offered', await hidden(page, '#btnMfaOn'));
      R.ok('closed: "On" is labelled as a preview, not full protection', /Preview: .*does not yet require it everywhere/.test(await text(page, '#mfaMsg')), await text(page, '#mfaMsg'));
      await page.close();
    }

    // Open (after enforcement ships): the full flow.
    await suite.context.route('**/pages/config.js', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: CONFIG_STUB + '\nwindow.__SILO_CONFIG__.MFA_ENROLLMENT_OPEN = true;' }));

    // Off by default: nothing set up, nothing changes for this user.
    const page = await suite.open('/v2/profile.html', TABLES, { ready });
    R.ok('shows Off for an account without two-step login', (await text(page, '#mfaState')) === 'Off');
    R.ok('offers Turn on', !(await hidden(page, '#btnMfaOn')));
    R.ok('no Turn off', await hidden(page, '#btnMfaOff'));
    R.ok('setup panel closed', await hidden(page, '#mfaSetup'));

    // Turn on: QR and key shown.
    await page.click('#btnMfaOn');
    await settle(page);
    R.ok('setup panel opens', !(await hidden(page, '#mfaSetup')));
    R.ok('QR code drawn', /^data:image\/svg\+xml/.test(await page.getAttribute('#mfaQr', 'src')));
    R.ok('manual key shown', (await text(page, '#mfaSecret')) === 'FIXTURESECRET');

    // Wrong code: stays off.
    await page.fill('#mfaSetupCode', '000000');
    await page.click('#btnMfaConfirm');
    await settle(page);
    R.ok('wrong first code is refused', /didn't match/.test(await text(page, '#mfaMsg')), await text(page, '#mfaMsg'));
    R.ok('...and it stays Off', (await text(page, '#mfaState')) === 'Off');

    // Right code: on.
    await page.fill('#mfaSetupCode', '123456');
    await page.click('#btnMfaConfirm');
    await settle(page);
    R.ok('right code turns it On', (await text(page, '#mfaState')) === 'On');
    R.ok('setup panel closes', await hidden(page, '#mfaSetup'));
    R.ok('confirmation says what happens next', /Next time you sign in/.test(await text(page, '#mfaMsg')));
    R.ok('Turn off now offered', !(await hidden(page, '#btnMfaOff')));

    // Turn off: first click only arms.
    await page.click('#btnMfaOff');
    await settle(page);
    R.ok('first click does not turn it off', (await text(page, '#mfaState')) === 'On');
    R.ok('...it asks for a second click', /Click again/.test(await text(page, '#btnMfaOff')));
    await page.click('#btnMfaOff');
    await settle(page);
    R.ok('second click turns it Off', (await text(page, '#mfaState')) === 'Off');

    // A cancel Supabase refuses keeps the setup open (PR #970 review, P2).
    await page.click('#btnMfaOn');
    await settle(page);
    await page.evaluate(() => { window.__FIXTURE_MFA__.unenrollError = 'Network down'; });
    await page.click('#btnMfaCancel');
    await settle(page);
    R.ok('refused cancel: setup stays open', !(await hidden(page, '#mfaSetup')));
    R.ok('refused cancel: the reason is shown', /Could not cancel setup.*Network down/.test(await text(page, '#mfaMsg')), await text(page, '#mfaMsg'));
    R.ok('refused cancel: the factor is still there', await page.evaluate(() => window.__FIXTURE_MFA__.factors.length === 1));
    await page.evaluate(() => { window.__FIXTURE_MFA__.unenrollError = null; });

    // Cancelling a half-finished setup removes the unverified factor.
    await page.click('#btnMfaCancel');
    await settle(page);
    const left = await page.evaluate(() => window.__FIXTURE_MFA__.factors.length);
    R.ok('cancel removes the half-set-up authenticator', left === 0, String(left));
    R.ok('...and the page is back to Off', (await text(page, '#mfaState')) === 'Off' && (await hidden(page, '#mfaSetup')));

    // The rest of the page still works: Save is untouched by this section.
    R.ok('Save button still present', await page.evaluate(() => !!document.getElementById('btnSave')));
    await page.close();
  } finally {
    await suite.close();
  }
  const s = R.summary();
  process.exit(s.fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
