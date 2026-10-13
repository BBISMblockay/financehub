/* pages/mfa.js — the two-step login helpers shared by login, set-password
 * and My profile. Run against hand-built Supabase clients, because the
 * properties that matter are about WHICH auth calls happen:
 *
 *   - an account with no verified factor is never asked for a code, even
 *     when the assurance call fails (the opt-in promise: nothing changes for
 *     anyone who did not turn it on);
 *   - an account WITH one is asked, even when the assurance call fails;
 *   - a malformed code never reaches Supabase. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createReporter } = require('../lib/assert');

const R = createReporter('mfa-helpers');
const REPO = path.resolve(__dirname, '..', '..', '..');
const src = fs.readFileSync(path.join(REPO, 'pages/mfa.js'), 'utf8');

const ctx = vm.createContext({ module: { exports: {} }, atob, Buffer });
vm.runInContext(src, ctx);
const M = ctx.module.exports;

const jwt = (claims) => 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.s';

function client(opts = {}) {
  const calls = [];
  const factors = opts.factors || [];
  const c = {
    calls,
    auth: {
      getSession: async () => ({ data: { session: opts.session || null }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => {
          calls.push('aal');
          if (opts.aalThrows) throw new Error('boom');
          if (opts.aalError) return { data: null, error: { message: 'nope' } };
          return { data: opts.aal || { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null };
        },
        listFactors: async () => {
          calls.push('list');
          return {
            data: { all: factors, totp: factors.filter((f) => f.status === 'verified') },
            error: null,
          };
        },
        challengeAndVerify: async (a) => {
          calls.push('verify:' + a.factorId + ':' + a.code);
          if (opts.goodFactor && a.factorId === opts.goodFactor && a.code === '123456') return { data: {}, error: null };
          return { data: null, error: { code: 'mfa_verification_failed', message: 'Invalid TOTP code entered' } };
        },
        enroll: async (a) => {
          calls.push('enroll:' + a.factorType + ':' + a.issuer);
          return { data: { id: 'new', totp: { qr_code: 'data:image/svg+xml;x', secret: 'ABC' } }, error: null };
        },
        unenroll: async (a) => {
          calls.push('unenroll:' + a.factorId);
          if (opts.unenrollError) return { data: null, error: opts.unenrollError };
          return { data: {}, error: null };
        },
      },
    },
  };
  return c;
}

(async () => {
  // normalizeCode
  R.ok('6 digits pass', M.normalizeCode('123456') === '123456');
  R.ok('spaces and dashes are dropped', M.normalizeCode(' 123 456 ') === '123456' && M.normalizeCode('123-456') === '123456');
  R.ok('5 digits fail', M.normalizeCode('12345') === null);
  R.ok('letters fail', M.normalizeCode('12345a') === null);
  R.ok('empty fails', M.normalizeCode('') === null && M.normalizeCode(null) === null);

  // jwtAal
  R.ok('reads aal2', M.jwtAal(jwt({ aal: 'aal2' })) === 'aal2');
  R.ok('missing claim is null', M.jwtAal(jwt({ sub: 'x' })) === null);
  R.ok('garbage is null', M.jwtAal('not-a-jwt') === null);

  // needsCode: the normal path
  R.ok('no factor: no code', !(await M.needsCode(client({ aal: { currentLevel: 'aal1', nextLevel: 'aal1' } }))));
  R.ok('factor, password only: code', await M.needsCode(client({ aal: { currentLevel: 'aal1', nextLevel: 'aal2' } })));
  R.ok('factor, code already entered: no code', !(await M.needsCode(client({ aal: { currentLevel: 'aal2', nextLevel: 'aal2' } }))));
  R.ok('signed out: no code', !(await M.needsCode(client({ aal: { currentLevel: null, nextLevel: null } }))));

  // needsCode: the assurance call fails -> decided from the session
  const noFactorUser = { id: 'u', factors: [] };
  const factorUser = { id: 'u', factors: [{ id: 'f', status: 'verified' }] };
  const unverifiedUser = { id: 'u', factors: [{ id: 'f', status: 'unverified' }] };
  R.ok('assurance throws, no factor: NOT blocked (current users unaffected)',
    !(await M.needsCode(client({ aalThrows: true, session: { access_token: jwt({ aal: 'aal1' }), user: noFactorUser } }))));
  R.ok('assurance errors, unverified factor only: NOT blocked',
    !(await M.needsCode(client({ aalError: true, session: { access_token: jwt({ aal: 'aal1' }), user: unverifiedUser } }))));
  R.ok('assurance throws, verified factor, aal1: code asked (fails closed)',
    await M.needsCode(client({ aalThrows: true, session: { access_token: jwt({ aal: 'aal1' }), user: factorUser } })));
  R.ok('assurance throws, verified factor, aal2: not asked again',
    !(await M.needsCode(client({ aalThrows: true, session: { access_token: jwt({ aal: 'aal2' }), user: factorUser } }))));
  R.ok('assurance throws, no session: no code', !(await M.needsCode(client({ aalThrows: true }))));

  // verifyCode
  {
    const c = client({ factors: [{ id: 'f1', status: 'verified', factor_type: 'totp' }], goodFactor: 'f1' });
    let err = null;
    try { await M.verifyCode(c, '12'); } catch (e) { err = e; }
    R.ok('a malformed code is refused locally', err && /6-digit/.test(err.message), err && err.message);
    R.ok('...without calling Supabase', !c.calls.some((x) => x.startsWith('verify')), c.calls.join(','));

    err = null;
    try { await M.verifyCode(c, '000000'); } catch (e) { err = e; }
    R.ok('a wrong code gets a plain message', err && /didn't match/.test(err.message), err && err.message);

    R.ok('the right code verifies', await M.verifyCode(c, '123 456'));
  }
  {
    const c = client({
      factors: [
        { id: 'a', status: 'verified', factor_type: 'totp' },
        { id: 'b', status: 'verified', factor_type: 'totp' },
      ],
      goodFactor: 'b',
    });
    R.ok('with two authenticators, a code from the second works', await M.verifyCode(c, '123456'));
    R.ok('...tried in order', c.calls.filter((x) => x.startsWith('verify')).join(',') === 'verify:a:123456,verify:b:123456', c.calls.join(','));
  }
  {
    const c = client({ factors: [] });
    let err = null;
    try { await M.verifyCode(c, '123456'); } catch (e) { err = e; }
    R.ok('no authenticator: says so', err && /no authenticator/.test(err.message), err && err.message);
  }

  // status
  R.ok('status: off with no verified factor', (await M.status(client({ factors: [{ id: 'x', status: 'unverified', factor_type: 'totp' }] }))) === null);
  R.ok('status: on with one', (await M.status(client({ factors: [{ id: 'x', status: 'verified', factor_type: 'totp' }] }))).id === 'x');

  // startEnrollment clears an abandoned attempt first
  {
    const c = client({ factors: [{ id: 'old', status: 'unverified', factor_type: 'totp' }] });
    const en = await M.startEnrollment(c);
    R.ok('abandoned unverified factor removed before enrolling',
      c.calls.indexOf('unenroll:old') >= 0 && c.calls.indexOf('unenroll:old') < c.calls.indexOf('enroll:totp:SILO'), c.calls.join(','));
    R.ok('enrollment returns QR and secret', en.factorId === 'new' && /^data:image/.test(en.qrCode) && en.secret === 'ABC');
  }

  // disable: an aal1 session gets an actionable message
  {
    const c = client({ unenrollError: { code: 'insufficient_aal', message: 'AAL2 required' } });
    let err = null;
    try { await M.disable(c, 'f'); } catch (e) { err = e; }
    R.ok('turning off from a password-only session explains what to do', err && /Sign out and back in/.test(err.message), err && err.message);
  }

  const s = R.summary();
  process.exit(s.fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
