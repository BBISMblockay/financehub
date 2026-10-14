# Two-step login (authenticator app)

Added 2026-10-13. Opt-in per user. **Setup opened 2026-10-14**, once the
server enforced the code (see "Enforcement by the server" below): My profile offers
"Turn on" only when `pages/config.js` sets `MFA_ENROLLMENT_OPEN: true` (set
2026-10-14) and Supabase Auth TOTP enrollment is enabled. The code steps on login and set-password are
live regardless, but they only act for an account that already holds a
verified factor, and none does (0 on 2026-10-13). Code: `pages/mfa.js` (shared helpers),
`pages/login.html`, `pages/set-password.html`, `v2/profile.html`.
Tests: `v2/tests/unit/mfa-helpers.test.js`, `v2/tests/browser/login-two-step.test.js`,
`v2/tests/browser/profile-two-step.test.js`.

## What a user sees

- **Turning it on** (once `MFA_ENROLLMENT_OPEN` is set): My profile → Two-step login → Turn on. Scan the QR code
  in any authenticator app (Google Authenticator, 1Password, Authy, Microsoft
  Authenticator), enter the first code. It is on from then.
- **Signing in:** password (or email link) as before, then a 6-digit code.
  The code step sits before any invite is redeemed or company resolved.
- **Password reset / change:** `set-password.html` asks for the code before
  showing the new-password form.
- **Turning it off:** My profile → Turn off (two clicks). Needs a session that
  entered its code; Supabase refuses otherwise and the page says so.

Accounts that never turn it on see no change anywhere. If Supabase's
assurance call fails, an account with no verified factor is let through as
before, and an account with one is asked for its code.

## Supabase settings it relies on

Authentication → Multi-Factor → TOTP (App Authenticator). Supabase Auth gates
**enrollment** and **verification** separately (`MFA_TOTP_ENROLL_ENABLED` /
`MFA_TOTP_VERIFY_ENABLED` server-side). It was **Enabled** (both) on
2026-10-13, which means anyone signed in can enroll through the Auth API
directly, whatever `MFA_ENROLLMENT_OPEN` says. The browser flag only hides the
button (PR #970 review, cycle 2). **Set to verify-only ("Verify Enabled") by Blake
on 2026-10-13 ~21:20 UTC**: an enroll call is now refused with 422
`mfa_totp_enroll_not_enabled`, and password sign-in is unchanged (both checked live).

**Now (2026-10-14): TOTP Enabled** (enroll + verify), because the server
enforces the code. Before that it was verify-only (enrollment off), which was
the gate the server held while only the sign-in page asked for the code.
Setup needs BOTH enrollment Enabled here AND `MFA_ENROLLMENT_OPEN: true`;
closing it again needs only one of them off. Phone/SMS stays disabled. "Limit duration of AAL1
sessions" was showing ON in the dashboard. On 2026-10-13, 67 of 86 aal1
sessions had refreshed more than an hour after creation, so the setting is
not ending password-only sessions for accounts without a factor. Whether it
applies to enrolled accounts is unverified.

## Lost phone: resetting a user

There are no recovery codes, so an admin with Supabase access resets the user
after confirming their identity out of band. This is a production data change,
so it needs Blake. Do the steps **in this order**. Removing the factor alone
leaves the lost device signed in: its refresh token keeps minting access
tokens (PR #970 review).

1. **Revoke every session first.** In production, `refresh_tokens.session_id`
   references `sessions` with `ON DELETE CASCADE` (checked 2026-10-13), so
   this also kills every refresh token:
   ```sql
   delete from auth.sessions where user_id = '<user uuid>';
   select count(*) from auth.sessions where user_id = '<user uuid>';        -- expect 0
   select count(*) from auth.refresh_tokens where user_id = '<user uuid>'::text
     and revoked = false;                                                    -- expect 0
   ```
   Access tokens that were already issued stay valid until they expire (the
   project's JWT expiry, 1 hour by default). Revoking sessions stops renewal,
   not tokens already handed out.
2. **If the phone may also hold the password** (saved in a browser or password
   manager), reset the password too: Authentication → Users → the user → send
   a password recovery email.
3. **Remove the factor.** Prefer the supported Admin API,
   `supabase.auth.admin.mfa.deleteFactor({ userId, id })`, or the dashboard
   (Authentication → Users → the user). The raw fallback:
   ```sql
   delete from auth.mfa_factors where user_id = '<user uuid>';
   select count(*) from auth.mfa_factors where user_id = '<user uuid>';     -- expect 0
   ```

The user then signs in with their password alone and can turn two-step login
on again with a new phone.

## Enforcement by the server (20261014000000)

The sign-in and password pages ask for the code, and since `20261014000000`
the server refuses an enrolled account's password-only (`aal1`) session too.
An account WITHOUT a verified factor is untouched, so this changes nothing for
anyone until setup opens.

- **Data API (tables, views, RPCs):** `public.silo_check_request()` runs before
  every PostgREST request (`alter role authenticator set pgrst.db_pre_request`)
  and answers **403 `mfa_required`** when `public.mfa_session_satisfied()` is
  false. One choke point instead of a policy per table, and it also covers the
  ~117 SECURITY DEFINER functions and the definer views, which bypass RLS.
- **Storage:** a restrictive policy `mfa_session_required` on `storage.objects`
  (Storage does not run the pre-request hook).
- **Realtime:** not used (the `supabase_realtime` publication is empty).
- **Edge functions:** fifteen user-facing functions already make a
  caller-token PostgREST call whose error aborts, so the hook covers them.
  Sixteen check the caller with `auth.getUser()` and then act only with the
  service role; each now calls `checkMfaSession` (`mfa-gate.mjs`) first, which
  asks PostgREST as the caller and fails closed (list and ordering pinned by
  `scripts/tests/mfa-gate.test.mjs`). Audit of every function: 2026-10-13.
- `mfa_session_satisfied()` is true when the session is `aal2`, when there is
  no signed-in user (anon, service role), or when the user has no VERIFIED
  factor. An unverified (half-finished) setup grants nothing and blocks nothing.

**Rollout order:** merge → apply the migration → deploy the sixteen gated
functions. The gate fails closed, so a gated function deployed before the
migration answers 503 until it is applied.

**Rollback (instant, one statement):**
```sql
alter role authenticator reset pgrst.db_pre_request; notify pgrst, 'reload config';
```
`verify_v2_schema.sql` reports CRITICAL while it is off.

**Opening setup** still needs: TOTP enrollment switched back on in Supabase
Auth, `MFA_ENROLLMENT_OPEN: true`, and the lost-phone reset below rehearsed on
a test account. The sign-in and password pages make no data call before the
code step (checked 2026-10-13), so an enrolled user signs in normally. App
pages do not turn an `mfa_required` 403 into a redirect to the code step; a
user only meets one by holding a session that skipped it, and signing in again
fixes it.
