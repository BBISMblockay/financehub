/* Two-step login gate for edge functions that act with the service role.
 *
 * 20261014000000 enforces two-step login on the Data API: a PostgREST
 * pre-request hook refuses every request from an aal1 session of a user who
 * holds a verified authenticator factor. An edge function that checks the
 * caller with auth.getUser() and then reads or writes ONLY through the
 * service-role client never sends the caller's token to PostgREST, so the hook
 * never sees it. This module is that missing call: it asks PostgREST, AS THE
 * CALLER, whether their session is good enough (mfa_session_satisfied()).
 * The pre-request hook answers 403 mfa_required first for an unsatisfied
 * session; the function's own `true` covers the case where the hook were ever
 * switched off.
 *
 * Fails CLOSED: no answer, a network error, a missing function (migration not
 * applied) or anything but `true` refuses the request. So the migration must
 * be applied BEFORE functions carrying this gate are deployed.
 *
 * Call it right after auth.getUser() succeeds and before the first
 * service-role read or write. Returns { ok: true } or
 * { ok: false, status, code, message } for the caller to send back.
 *
 * Verbatim copy in each gated function's directory (pinned by
 * scripts/tests/mfa-gate.test.mjs). Edit this one and re-copy.
 */

export const MFA_REQUIRED_MESSAGE = 'Enter the code from your authenticator app to continue.';

/**
 * @param {{ supabaseUrl?: string | null, anonKey?: string | null, authorization?: string | null,
 *           fetchImpl?: typeof fetch }} args
 * @returns {Promise<{ ok: boolean, status?: number, code?: string, message?: string }>}
 */
export async function checkMfaSession({ supabaseUrl, anonKey, authorization, fetchImpl = undefined }) {
  const doFetch = fetchImpl || fetch;
  if (!supabaseUrl || !anonKey || !authorization || !/^Bearer\s+\S+/i.test(authorization)) {
    return { ok: false, status: 401, code: 'unauthorized', message: 'Sign in again.' };
  }
  let res;
  try {
    res = await doFetch(`${String(supabaseUrl).replace(/\/+$/, '')}/rest/v1/rpc/mfa_session_satisfied`, {
      method: 'POST',
      headers: { apikey: anonKey, Authorization: authorization, 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch (_) {
    return { ok: false, status: 503, code: 'mfa_check_failed', message: 'Could not check two-step login. Try again.' };
  }
  let body = null;
  try { body = await res.json(); } catch (_) { body = null; }
  if (res.ok && body === true) return { ok: true };
  if ((res.ok && body === false) || (res.status === 403 && body && body.code === 'mfa_required')) {
    return { ok: false, status: 403, code: 'mfa_required', message: MFA_REQUIRED_MESSAGE };
  }
  if (res.status === 401) return { ok: false, status: 401, code: 'unauthorized', message: 'Sign in again.' };
  return { ok: false, status: 503, code: 'mfa_check_failed', message: 'Could not check two-step login. Try again.' };
}
