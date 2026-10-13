# Two-step login (authenticator app)

Added 2026-10-13. Opt-in per user. **Setup is closed in production** until
the database enforces the code (see "Limit" below): My profile offers
"Turn on" only when `pages/config.js` sets `MFA_ENROLLMENT_OPEN: true`, and
production leaves it unset. The code steps on login and set-password are
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

Authentication → Multi-Factor: **TOTP (App Authenticator) = Enabled** (it is,
checked 2026-10-13). Phone/SMS stays disabled. "Limit duration of AAL1
sessions" was showing ON in the dashboard. On 2026-10-13, 67 of 86 aal1
sessions had refreshed more than an hour after creation, so the setting is
not ending password-only sessions for accounts without a factor. Whether it
applies to enrolled accounts is unverified.

## Lost phone: resetting a user

No recovery codes. An admin with Supabase access removes the factor, after
confirming the person's identity out of band. This is a production data
change, so it needs Blake.

- Dashboard: Authentication → Users → the user → remove the MFA factor, or
- SQL: `delete from auth.mfa_factors where user_id = '<user uuid>';`

The user then signs in with their password alone and can turn it on again.

## Limit: the front door only (open)

The code is enforced by the sign-in and password pages, not by the database.
After a correct password, the session already exists at `aal1`. Someone who
knows the password and goes straight to an app URL instead of entering the
code still reads whatever RLS allows. Until the database check below is
applied, don't tell customers that two-step login is *enforced*.

Don't set `MFA_ENROLLMENT_OPEN` until this ships. Next step (migration, needs Blake's approval to apply): a restrictive RLS
policy on every RLS table, plus `storage.objects`, that refuses `aal1` only
for users holding a verified factor:

```sql
-- sketch, not applied
(select coalesce(auth.jwt()->>'aal', 'aal1')) = 'aal2'
  or not exists (select 1 from auth.mfa_factors f
                 where f.user_id = (select auth.uid()) and f.status = 'verified')
```

That still leaves SECURITY DEFINER RPCs and edge functions that check
`auth.getUser()` and then use the service role. Each one needs its own `aal`
check, or must be shown not to need one.
