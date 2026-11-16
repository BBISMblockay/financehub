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
  // The renewal in flight, if any, and whether teardown has begun. Both exist
  // for the same race: clearInterval does not finish a renewal that is already
  // awaiting its RPC, so without them the release below can delete the lease
  // first, that renewal then reads its own row as gone, and onLost fires after
  // a wholly successful run -- which in the scheduled runner is process.exit(1)
  // and in the edge function an abort, both turning success into failure.
  let renewal = null;
  let stopped = false;
  const timer = setIntervalImpl(async () => {
    if (renewal || lost || stopped) return;
    renewal = (async () => {
      try {
        const result = await db.rpc('renew_ad_sync_lease', args);
        // Ownership can only be LOST while we still claim to hold it. After
        // teardown the answer says nothing: we released it ourselves.
        if (stopped) return;
        if (result.error || result.data !== true) {
          lost = new Error('Ad sync lease lost; stop this runner before further writes');
          onLost(lost);
        }
      } catch (err) {
        if (stopped) return;
        lost = new Error(`Ad sync lease renewal failed: ${err.message}`);
        onLost(lost);
      } finally { renewal = null; }
    })();
    await renewal;
  }, everyMs);
  timer.unref?.();
  try {
    const result = await run();
    // Before judging the run, let an outstanding renewal land: it may be the
    // one that finds the lease taken, and its answer is still meaningful here
    // because nothing has been released yet.
    if (renewal) await renewal;
    if (lost) throw lost;
    return result;
  } finally {
    // Order matters: no further renewals, then wait for the one in flight to
    // settle, and only then release. A renewal that returns after this point
    // cannot report ownership loss, because `stopped` is already true.
    stopped = true;
    clearIntervalImpl(timer);
    if (renewal) await renewal.catch(() => {});
    // Compare the owner in SQL: an old runner must never release a successor.
    const released = await db.rpc('release_ad_sync_lease', {
      p_connection_id: connection.id, p_company_id: connection.company_entity_id, p_owner: owner,
    });
    if (released.error && !lost) throw new Error(`Cannot release ad sync lease: ${released.error.message}`);
  }
}
