/**
 * Which ad-platform sync failures are the CLIENT'S to fix, not SILO's.
 *
 * One connection whose account the client cancelled (BlockayOps' Google Ads,
 * CUSTOMER_NOT_ENABLED since 2026-09-30) turned every Ad Platforms KPI Sync run
 * red while every other connection synced -- an alarm nobody at SILO can act
 * on, which trains everyone to ignore the alarm. These failures still record
 * an 'error' sync_jobs row and print loudly; they just do not fail the run.
 *
 * Deliberately a short allowlist of codes that only the account owner can
 * change. Anything SILO can fix -- the developer token
 * (DEVELOPER_TOKEN_NOT_APPROVED / _PROHIBITED), a 5xx, a bug -- is not here and
 * still fails the run. When unsure, a failure is SILO's.
 */
const RULES = [
  // Google Ads errorCode values (see test-ad-platform-connection/google-ads-errors.mjs).
  [/\bCUSTOMER_NOT_ENABLED\b/, 'Google Ads account is not enabled (cancelled, suspended or never set up)'],
  [/\bCUSTOMER_NOT_FOUND\b/, 'Google Ads account does not exist'],
  [/\bUSER_PERMISSION_DENIED\b/, 'the connected Google login cannot read this Ads account'],
  [/\bNOT_ADS_USER\b/, 'the connected Google login has no Google Ads access'],
  // Google OAuth: the client revoked SILO's access or the grant expired.
  [/Google token refresh[\s\S]*\binvalid_grant\b/, 'Google access was revoked or expired -- reconnect'],
  [/No refresh token/, 'never finished connecting -- reconnect'],
  // Meta: token invalidated (password change, removed app, expired user token).
  [/"type"\s*:\s*"OAuthException"[\s\S]*"code"\s*:\s*190\b|"code"\s*:\s*190\b[\s\S]*"OAuthException"/, 'Meta access token is no longer valid -- reconnect'],
];

/** A short reason when the failure is the client's to fix, else null. */
export function clientSideReason(message) {
  const text = String(message ?? '');
  for (const [pattern, reason] of RULES) if (pattern.test(text)) return reason;
  return null;
}
