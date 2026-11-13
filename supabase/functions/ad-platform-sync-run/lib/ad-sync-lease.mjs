// One server-held lease per ad connection, shared by scheduled/manual/bootstrap
// runners. A missing migration is an error, never permission to run unlocked.
export async function withAdSyncLease({ db, connection, run, owner = crypto.randomUUID(),
  seconds = 900, everyMs = 60_000, setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval, onLost = () => {} }) {
  // This rollout protects native Meta only; other providers keep their existing path.
  if (connection.platform !== 'meta_ads') return run();
  const args = { p_connection_id: connection.id, p_company_id: connection.company_entity_id,
    p_owner: owner, p_lease_seconds: seconds };
  const claim = await db.rpc('claim_ad_sync_lease', args);
  if (claim.error) throw new Error(`Cannot claim ad sync lease: ${claim.error.message}`);
  if (claim.data !== true) return { connection: connection.id, skipped: 'sync_already_running' };
  let lost = null;
  let renewing = false;
  const timer = setIntervalImpl(async () => {
    if (renewing || lost) return;
    renewing = true;
    try {
      const result = await db.rpc('renew_ad_sync_lease', args);
      if (result.error || result.data !== true) {
        lost = new Error('Ad sync lease lost; stop this runner before further writes');
        onLost(lost);
      }
    } catch (err) {
      lost = new Error(`Ad sync lease renewal failed: ${err.message}`);
      onLost(lost);
    } finally { renewing = false; }
  }, everyMs);
  timer.unref?.();
  try {
    const result = await run();
    if (lost) throw lost;
    return result;
  } finally {
    clearIntervalImpl(timer);
    // Compare the owner in SQL: an old runner must never release a successor.
    const released = await db.rpc('release_ad_sync_lease', {
      p_connection_id: connection.id, p_company_id: connection.company_entity_id, p_owner: owner,
    });
    if (released.error && !lost) throw new Error(`Cannot release ad sync lease: ${released.error.message}`);
  }
}
