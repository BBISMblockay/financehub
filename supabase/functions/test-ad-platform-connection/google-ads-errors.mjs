/* A Google Ads API refusal, said as its CODE and what to do about it.
 *
 * Every Google Ads refusal is a 403 "The caller does not have permission" at
 * the top level; the part that tells a developer-token problem from an
 * account-access problem is errors[].errorCode, nested three levels down.
 * The test used to print the first 300 characters of the body, which ends
 * just before that field -- so the one fact that decides the fix was always
 * cut off (seen 2026-09-28 on Baseballism's Ads connection). */

const ADVICE = {
  DEVELOPER_TOKEN_NOT_APPROVED:
    "SILO's Google Ads developer token has only test-account access. Apply for Basic access in the Google Ads API Center.",
  DEVELOPER_TOKEN_PROHIBITED:
    "Google has not approved SILO's developer token for this use. Check the token's status in the Google Ads API Center.",
  USER_PERMISSION_DENIED:
    'The Google account used to connect cannot read this Ads account. Reconnect with a login that has access to it, or, if it sits under a manager (MCC) account, that manager account must be set as the login customer.',
  CUSTOMER_NOT_ENABLED:
    'This Ads account is not enabled (cancelled, suspended or never set up).',
  NOT_ADS_USER:
    'The Google account used to connect has no Google Ads access at all. Reconnect with one that does.',
};

/** { code, message } from a Google Ads error body, or null when it is not one. */
export function parseGoogleAdsError(bodyText) {
  let json;
  try { json = JSON.parse(bodyText); } catch { return null; }
  const details = json?.error?.details;
  if (!Array.isArray(details)) return null;
  for (const d of details) {
    for (const e of d?.errors ?? []) {
      const codeObj = e?.errorCode;
      if (codeObj && typeof codeObj === 'object') {
        const code = Object.values(codeObj).find((v) => typeof v === 'string');
        if (code) return { code, message: typeof e.message === 'string' ? e.message : '' };
      }
    }
  }
  return null;
}

/** One line: "<what> <status> CODE: Google's message -- what to do". Falls
 *  back to the start of the raw body when the body carries no error code. */
export function describeGoogleAdsError(what, status, bodyText) {
  const parsed = parseGoogleAdsError(bodyText);
  if (!parsed) return `${what} ${status}: ${String(bodyText ?? '').slice(0, 300)}`;
  const advice = ADVICE[parsed.code];
  return `${what} ${status} ${parsed.code}${parsed.message ? `: ${parsed.message}` : ''}${advice ? ` -- ${advice}` : ''}`;
}
