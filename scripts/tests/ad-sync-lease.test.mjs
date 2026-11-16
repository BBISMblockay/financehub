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
