import assert from 'node:assert/strict';
import { SYNC_STAMP, feedIsQuiet } from '../lib/freshness-quiet.mjs';

const dayEnded = new Date('2026-10-02T07:00:00Z'); // Pacific midnight starting 2026-10-02
const shop = (at, extra = {}) => ({ sync_enabled: true, meta: at ? { last_sales_sync_at: at } : {}, ...extra });
const ads = (at, extra = {}) => ({ sync_enabled: true, meta: at ? { last_sync_at: at } : {}, ...extra });
let n = 0; const t = (name, fn) => { fn(); console.log(`ok ${++n} - ${name}`); };

t('the stamp keys are the ones the syncs write on success', () => {
  assert.equal(SYNC_STAMP.shopify_connections, 'last_sales_sync_at');
  assert.equal(SYNC_STAMP.ad_platform_connections, 'last_sync_at');
});
t('Bat Nutz: synced after the day ended, nothing new to report -> quiet', () => {
  assert.equal(feedIsQuiet([shop('2026-10-03T02:06:43.566Z')], 'last_sales_sync_at', dayEnded), true);
  assert.equal(feedIsQuiet([ads('2026-10-02T23:38:45Z'), ads('2026-10-02T23:38:47Z')], 'last_sync_at', dayEnded), true);
});
t('a sync that last succeeded before the day ended is stale (dropped run)', () => {
  assert.equal(feedIsQuiet([shop('2026-10-02T06:59:59Z')], 'last_sales_sync_at', dayEnded), false);
});
t('one connection behind is enough to be stale', () => {
  assert.equal(feedIsQuiet([ads('2026-10-02T23:38:45Z'), ads('2026-09-30T10:00:00Z')], 'last_sync_at', dayEnded), false);
});
t('no stamp, a garbage stamp, the wrong key, or no connections are never quiet', () => {
  assert.equal(feedIsQuiet([shop(null)], 'last_sales_sync_at', dayEnded), false);
  assert.equal(feedIsQuiet([shop('not a date')], 'last_sales_sync_at', dayEnded), false);
  assert.equal(feedIsQuiet([ads('2026-10-02T23:38:45Z')], 'last_sales_sync_at', dayEnded), false);
  assert.equal(feedIsQuiet([], 'last_sync_at', dayEnded), false);
  assert.equal(feedIsQuiet(null, 'last_sync_at', dayEnded), false);
  assert.equal(feedIsQuiet([ads('2026-10-02T23:38:45Z')], 'last_sync_at', new Date('x')), false);
});
t('a connection with sync switched off is not expected to sync', () => {
  assert.equal(feedIsQuiet([ads('2026-10-02T23:38:45Z'), ads(null, { sync_enabled: false })], 'last_sync_at', dayEnded), true);
  assert.equal(feedIsQuiet([ads(null, { sync_enabled: false })], 'last_sync_at', dayEnded), false);
});
console.log(`${n} freshness quiet checks passed`);
