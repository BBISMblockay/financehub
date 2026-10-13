/**
 * Which ad-platform sync failures are the CLIENT'S to fix, not SILO's.
 *
 * One connection whose account the client cancelled (BlockayOps' Google Ads,
 * CUSTOMER_NOT_ENABLED since 2026-09-30) turned every Ad Platforms KPI Sync run
 * red while every other connection synced -- an alarm nobody at SILO can act
 * on, which trains everyone to ignore the alarm. These failures still record
 * an 'error' sync_jobs row and print loudly; they just do not fail the run.
 *
 * The same shape covers Bat Nutz's Meta ad account, which Meta blocked from
 * the API on 2026-10-07: 34 of 34 scheduled runs red for one dead account.
 *
 * A client-side failure is also STAMPED on the connection
 * (meta.client_side_block, written by ad-platforms-sync.mjs) so the
 * independent freshness alarm can tell "this feed lags because its sync never
 * ran" from "this feed lags because the client's account is dead" -- without
 * that stamp the dead account turns a second workflow red forever. See
 * lib/freshness-quiet.mjs.
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
  // Meta: the AD ACCOUNT is blocked from the API (restricted, disabled or
  // closed by Meta). Pinned to the message, not to code 200 on its own:
  // code 200 is Meta's whole permissions family, and the rest of it --
  // "requires the 'pages_read_engagement' permission", a feature SILO's app
  // never had reviewed -- is SILO's to fix and must still fail the run.
  // Account-scoped by evidence: Bat Nutz has returned this on every run since
  // 2026-10-07 while the other Meta connections sync through the same app.
  [/"message"\s*:\s*"API access blocked\.?"[\s\S]*"OAuthException"|"OAuthException"[\s\S]*"message"\s*:\s*"API access blocked\.?"/, 'Meta has blocked API access to this ad account -- the account owner must resolve it with Meta'],
];

/** A short reason when the failure is the client's to fix, else null. */
export function clientSideReason(message) {
  const text = String(message ?? '');
  for (const [pattern, reason] of RULES) if (pattern.test(text)) return reason;
  return null;
}

/**
 * Close a sync_jobs row, THROWING when the write fails. PostgREST reports a
 * failed update as { error } rather than throwing, and a client-side failure
 * is only allowed to leave the run green because its 'error' row is the
 * durable record -- so a lost write must surface as a SILO failure (review
 * cycle 2, #859), not a green run with the job stuck at 'running'.
 */
export function makeFinishJob(supabase) {
  return async function finishJob(jobId, status, payload) {
    const update = { status, finished_at: new Date().toISOString() };
    if (status === 'success') update.result = payload;
    else update.error = String(payload?.error || payload).slice(0, 2000);
    const res = await supabase.from('sync_jobs').update(update).eq('id', jobId);
    if (res?.error) throw new Error(`sync_jobs update failed for job ${jobId}: ${res.error.message}`);
  };
}

/**
 * Run every connection; decide whether the RUN failed. A connection whose
 * failure is client-side (clientSideReason) is reported, not fatal. Every
 * other failure -- including the audit write above failing while recording
 * a client-side error -- sets hadError.
 */
export async function runConnections(connections, syncOne, labelOf = (c) => String(c?.id)) {
  let hadError = false;
  const clientSide = [];
  const results = [];
  for (const connection of connections) {
    try {
      results.push(await syncOne(connection));
    } catch (err) {
      const error = String(err?.message || err);
      const reason = clientSideReason(error);
      if (reason) clientSide.push({ connection, reason });
      else hadError = true;
      results.push({ connection: labelOf(connection), error, ...(reason ? { client_side: reason } : {}) });
    }
  }
  return { hadError, clientSide, results };
}
