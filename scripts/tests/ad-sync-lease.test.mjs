import assert from 'node:assert/strict';
import { withAdSyncLease } from '../lib/ad-sync-lease.mjs';
const connection = { platform: 'meta_ads', id: 'connection', company_entity_id: 'company' };
function harness(claim = true, renewal = true) {
  const calls = []; let tick; let cleared = false; let ran = 0; let lost = 0;
  return { calls, get tick() { return tick; }, get cleared() { return cleared; }, get ran() { return ran; }, get lost() { return lost; },
    args: { connection, owner: 'owner', db: { rpc: async (name, args) => {
      calls.push([name, args]);
      if (name === 'claim_ad_sync_lease') return claim instanceof Error ? { error: claim } : { data: claim };
      if (name === 'renew_ad_sync_lease') return { data: renewal };
      return { data: true };
    } }, run: async () => { ran++; return 'worked'; },
    setIntervalImpl: (fn) => { tick = fn; return {}; }, clearIntervalImpl: () => { cleared = true; }, onLost: () => { lost++; } },
  };
}
let h = harness();
assert.equal(await withAdSyncLease(h.args), 'worked');
assert.equal(h.ran, 1); assert.equal(h.cleared, true);
assert.deepEqual(h.calls.map(([name]) => name), ['claim_ad_sync_lease','release_ad_sync_lease']);
assert.equal(h.calls[0][1].p_company_id, 'company');
assert.equal(h.calls[1][1].p_owner, 'owner');
h = harness(false);
assert.equal((await withAdSyncLease(h.args)).skipped, 'sync_already_running');
assert.equal(h.ran, 0); assert.equal(h.calls.length, 1);
h = harness(new Error('missing function'));
await assert.rejects(withAdSyncLease(h.args), /Cannot claim/); assert.equal(h.ran, 0);
h = harness(true, false);
h.args.run = async () => { await h.tick(); return 'stale'; };
await assert.rejects(withAdSyncLease(h.args), /lease lost/); assert.equal(h.lost, 1);
h = harness(); h.args.run = async () => { throw new Error('provider down'); };
await assert.rejects(withAdSyncLease(h.args), /provider down/); assert.equal(h.cleared, true);
console.log('ad-sync-lease: claim, overlap, fail-closed, ownership and loss checks passed');

h = harness(new Error('missing function')); h.args.connection = { ...connection, platform: 'google_ads' };
assert.equal(await withAdSyncLease(h.args), 'worked'); assert.equal(h.calls.length, 0);

// ── A renewal still in flight when the work ends ─────────────────────────
// clearInterval does not finish a renewal already awaiting its RPC. The
// release then deletes OUR OWN row, so a renewal landing after it reads the
// lease as gone and reported ownership loss on a wholly successful run --
// process.exit(1) in the scheduled runner, an abort in the edge function,
// both turning a finished sync into a failure. The renewal is now awaited
// BEFORE the release, and an answer arriving after teardown says nothing.
function slowRenewal({ renewal = true, run, delayMs = 10 }) {
  const order = []; let lost = 0; let tick; let inFlightAtEnd = false;
  const db = { rpc: async (name) => {
    order.push(name);
    if (name === 'renew_ad_sync_lease') {
      await new Promise((r) => setTimeout(r, delayMs));
      return { data: renewal };
    }
    return { data: true };
  } };
  const args = {
    connection, owner: 'owner', db,
    setIntervalImpl: (fn) => { tick = fn; return {}; },
    clearIntervalImpl: () => {},
    onLost: () => { lost++; },
    run: async () => {
      tick();                                     // a renewal starts...
      await new Promise((r) => setTimeout(r, 0)); // ...and is still in flight
      inFlightAtEnd = true;
      return run();
    },
  };
  return { args, order, get lost() { return lost; }, get inFlightAtEnd() { return inFlightAtEnd; } };
}

// 1. The renewal lands after the work and says we still hold it: success.
{
  const t = slowRenewal({ run: async () => 'worked' });
  assert.equal(await withAdSyncLease(t.args), 'worked', 'a successful run stays successful');
  assert.ok(t.inFlightAtEnd);
  assert.equal(t.lost, 0, 'no ownership loss for a lease we released ourselves');
  assert.deepEqual(t.order, ['claim_ad_sync_lease', 'renew_ad_sync_lease', 'release_ad_sync_lease'],
    'the renewal is awaited before the release, so the release is last');
}

// 2. The same race, but the lease really was taken: that must still be loud,
//    because the work wrote while someone else held it. Judged BEFORE the
//    release, while the answer still means something.
{
  const t = slowRenewal({ renewal: false, run: async () => 'stale' });
  await assert.rejects(withAdSyncLease(t.args), /lease lost/, 'a genuinely lost lease still fails the run');
  assert.equal(t.lost, 1);
}

// 3. The work throws with a renewal outstanding: the provider error is what
//    propagates, and the late renewal cannot add a loss on top of it.
{
  const t = slowRenewal({ renewal: false, run: async () => { throw new Error('provider down'); } });
  await assert.rejects(withAdSyncLease(t.args), /provider down/, 'the real error survives');
  assert.equal(t.lost, 0, 'a renewal answered after teardown reports nothing');
  assert.deepEqual(t.order, ['claim_ad_sync_lease', 'renew_ad_sync_lease', 'release_ad_sync_lease']);
}
console.log('ad-sync-lease: a renewal outstanding at teardown cannot fail a successful run');
