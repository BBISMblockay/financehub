import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SYNC_STAMP, CLIENT_BLOCK, feedIsQuiet, feedExcuse, feedBlockers, feedFullyBlocked, enabledProducers, producesFeed, expectedCompanies } from '../lib/freshness-quiet.mjs';

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
t('Search Console does not write marketing_kpis_daily, so its stamp is ignored either way', () => {
  const T = 'ad_platform_connections';
  const sc = (at) => ads(at, { platform: 'search_console' });
  const meta = (at) => ads(at, { platform: 'meta_ads' });
  // Fresh campaign connection + a stale/missing Search Console stamp: quiet.
  assert.equal(feedIsQuiet([meta('2026-10-02T23:38:45Z'), sc(null)], 'last_sync_at', dayEnded, T), true);
  assert.equal(feedIsQuiet([meta('2026-10-02T23:38:45Z'), sc('2026-09-01T00:00:00Z')], 'last_sync_at', dayEnded, T), true);
  // Search-Console-only company: a fresh Search Console stamp is NOT a quiet marketing feed.
  assert.equal(feedIsQuiet([sc('2026-10-02T23:38:45Z')], 'last_sync_at', dayEnded, T), false);
  // A stale campaign connection is still stale beside a fresh Search Console one.
  assert.equal(feedIsQuiet([meta('2026-09-30T00:00:00Z'), sc('2026-10-02T23:38:45Z')], 'last_sync_at', dayEnded, T), false);
  // Company discovery uses the same predicate.
  assert.equal(producesFeed(T, { platform: 'search_console' }), false);
  for (const p of ['google_ads', 'meta_ads', 'tiktok_ads', 'ga4', 'some_new_platform']) assert.equal(producesFeed(T, { platform: p }), true, p);
  assert.equal(producesFeed('shopify_connections', { shop_domain: 'x' }), true);
  assert.equal(producesFeed(T, null), false);
});
t('a company whose only campaign connection is switched off is not expected to have marketing data', () => {
  const T = 'ad_platform_connections';
  const row = (company, platform, sync_enabled = true) => ({ company_entity_id: company, platform, sync_enabled });
  assert.deepEqual(expectedCompanies(T, [
    row('disabled-only', 'google_ads', false),
    row('sc-only', 'search_console'),
    row('mixed', 'search_console'), row('mixed', 'meta_ads'),
    row('mixed', 'meta_ads'),
  ]), ['mixed']);
  assert.deepEqual(expectedCompanies('shopify_connections', [{ company_entity_id: 'a', sync_enabled: true }, { company_entity_id: 'b', sync_enabled: false }]), ['a']);
  assert.deepEqual(expectedCompanies(T, null), []);
});
t('the client-side block key is the one ad-platforms-sync writes', () => {
  assert.equal(CLIENT_BLOCK.ad_platform_connections, 'client_side_block');
  assert.equal(CLIENT_BLOCK.shopify_connections, undefined);
});
t("BlockayOps: a connection the client's own account killed is not SILO's alarm", () => {
  const T = 'ad_platform_connections';
  const blocked = (at, platform = 'google_ads') => ({
    sync_enabled: true, platform,
    meta: { client_side_block: { reason: 'Google Ads account is not enabled', at } },
  });
  const ga4 = (at) => ads(at, { platform: 'ga4' });
  // The live shape on 2026-10-13: GA4 synced, Google Ads blocked, feed at 10-05.
  assert.equal(feedExcuse([ga4('2026-10-02T23:09:37Z'), blocked('2026-10-02T23:09:40Z')], 'last_sync_at', dayEnded, T), 'client-blocked');
  // A block is only an excuse for as long as the sync keeps attempting it.
  assert.equal(feedExcuse([ga4('2026-10-02T23:09:37Z'), blocked('2026-10-01T23:09:40Z')], 'last_sync_at', dayEnded, T), null);
  // Blocked connection beside a connection whose sync did not run: still stale.
  assert.equal(feedExcuse([ga4('2026-09-30T00:00:00Z'), blocked('2026-10-02T23:09:40Z')], 'last_sync_at', dayEnded, T), null);
  // A malformed or absent block stamp excuses nothing.
  assert.equal(feedExcuse([{ sync_enabled: true, platform: 'google_ads', meta: { client_side_block: { reason: 'x' } } }], 'last_sync_at', dayEnded, T), null);
  assert.equal(feedExcuse([{ sync_enabled: true, platform: 'google_ads', meta: { client_side_block: { reason: 'x', at: 'not a date' } } }], 'last_sync_at', dayEnded, T), null);
  // The newest stamp decides: a fresh success outranks the block it cleared,
  // and a fresh block outranks the older success it followed.
  const healed = { sync_enabled: true, platform: 'google_ads', meta: { last_sync_at: '2026-10-02T23:00:00Z', client_side_block: null } };
  assert.equal(feedExcuse([healed], 'last_sync_at', dayEnded, T), 'quiet');
  const broke = { sync_enabled: true, platform: 'google_ads', meta: { last_sync_at: '2026-09-28T23:00:00Z', client_side_block: { reason: 'x', at: '2026-10-02T23:00:00Z' } } };
  assert.equal(feedExcuse([broke], 'last_sync_at', dayEnded, T), 'client-blocked');
  // Shopify has no block key, so a stamp-shaped meta there cannot excuse it.
  assert.equal(feedExcuse([{ sync_enabled: true, meta: { client_side_block: { reason: 'x', at: '2026-10-02T23:00:00Z' } } }], 'last_sales_sync_at', dayEnded, 'shopify_connections'), null);
  // And without a connTable there is no block key to read at all.
  assert.equal(feedExcuse([blocked('2026-10-02T23:09:40Z')], 'last_sync_at', dayEnded), null);
});
t('feedIsQuiet still answers the yes/no question for both excuses', () => {
  const T = 'ad_platform_connections';
  assert.equal(feedIsQuiet([ads('2026-10-02T23:38:45Z', { platform: 'meta_ads' })], 'last_sync_at', dayEnded, T), true);
  assert.equal(feedExcuse([ads('2026-10-02T23:38:45Z', { platform: 'meta_ads' })], 'last_sync_at', dayEnded, T), 'quiet');
  assert.equal(feedIsQuiet([{ sync_enabled: true, platform: 'meta_ads', meta: { client_side_block: { reason: 'blocked', at: '2026-10-02T23:38:45Z' } } }], 'last_sync_at', dayEnded, T), true);
});
t('a SILO-side failure after a block is not excused by it (cycle 1, #957)', () => {
  const T = 'ad_platform_connections';
  // ad-platforms-sync.mjs clears the block on any non-client failure, so the
  // connection's newest stamp is the 500, not yesterday's block. Here that is
  // a connection with no usable stamp at all: nothing excuses it.
  const cleared = { sync_enabled: true, platform: 'google_ads', meta: { client_side_block: null } };
  assert.equal(feedExcuse([cleared], 'last_sync_at', dayEnded, T), null);
  // And beside a healthy connection, one cleared connection still alarms.
  const ga4 = (at) => ads(at, { platform: 'ga4' });
  assert.equal(feedExcuse([ga4('2026-10-02T23:09:37Z'), cleared], 'last_sync_at', dayEnded, T), null);
});
t('feedBlockers names only the connections whose current block was read', () => {
  const T = 'ad_platform_connections';
  const blocked = (at, platform, extra = {}) => ({
    sync_enabled: true, platform, meta: { client_side_block: { reason: `${platform} is dead`, at } }, ...extra,
  });
  const current = blocked('2026-10-02T23:09:40Z', 'google_ads');
  const stale = blocked('2026-09-20T00:00:00Z', 'tiktok_ads');
  const switchedOff = blocked('2026-10-02T23:09:40Z', 'meta_ads', { sync_enabled: false });
  const notAProducer = blocked('2026-10-02T23:09:40Z', 'search_console');
  const superseded = { sync_enabled: true, platform: 'ga4', meta: { last_sync_at: '2026-10-02T23:30:00Z', client_side_block: { reason: 'old', at: '2026-10-02T23:00:00Z' } } };
  assert.deepEqual(
    feedBlockers([current, stale, switchedOff, notAProducer, superseded], 'last_sync_at', dayEnded, T),
    [current],
  );
  // No block key for the table, a bad date, or nothing at all: nobody.
  assert.deepEqual(feedBlockers([current], 'last_sales_sync_at', dayEnded, 'shopify_connections'), []);
  assert.deepEqual(feedBlockers([current], 'last_sync_at', dayEnded), []);
  assert.deepEqual(feedBlockers([current], 'last_sync_at', new Date('x'), T), []);
  assert.deepEqual(feedBlockers(null, 'last_sync_at', dayEnded, T), []);
});
t('feedFullyBlocked: a healthy sibling producer means the feed is not fully blocked (cycle 2)', () => {
  const T = 'ad_platform_connections';
  const K = 'last_sync_at';
  const blocked = (platform) => ({
    sync_enabled: true, platform, meta: { client_side_block: { reason: `${platform} is dead`, at: '2026-10-02T23:09:40Z' } },
  });
  const fresh = (platform) => ads('2026-10-02T23:09:37Z', { platform });
  // The mixed case: Meta blocked, GA4 syncing. The FEED is client-blocked
  // (its lag is explained), but GA4 can still finish yesterday's rows, so a
  // partial day must not be waived.
  assert.equal(feedExcuse([blocked('meta_ads'), fresh('ga4')], K, dayEnded, T), 'client-blocked');
  assert.equal(feedFullyBlocked([blocked('meta_ads'), fresh('ga4')], K, dayEnded, T), false);
  // Every producer blocked: nothing is left to correct the day.
  assert.equal(feedFullyBlocked([blocked('meta_ads'), blocked('google_ads')], K, dayEnded, T), true);
  // Connections that are not judged do not count either way: a switched-off
  // one and a Search Console one must not make a blocked feed look mixed.
  assert.equal(feedFullyBlocked([
    blocked('meta_ads'),
    { ...fresh('ga4'), sync_enabled: false },
    fresh('search_console'),
  ], K, dayEnded, T), true);
  // A stale block is not a current one, so the feed is not fully blocked.
  const staleBlock = { sync_enabled: true, platform: 'google_ads', meta: { client_side_block: { reason: 'old', at: '2026-09-20T00:00:00Z' } } };
  assert.equal(feedFullyBlocked([staleBlock], K, dayEnded, T), false);
  // No producers at all is never an excuse.
  assert.equal(feedFullyBlocked([], K, dayEnded, T), false);
  assert.equal(feedFullyBlocked([fresh('search_console')], K, dayEnded, T), false);
});
t('enabledProducers is the one definition the other rules share', () => {
  const T = 'ad_platform_connections';
  const rows = [
    { sync_enabled: true, platform: 'meta_ads' },
    { sync_enabled: false, platform: 'google_ads' },
    { sync_enabled: true, platform: 'search_console' },
    null,
  ];
  assert.deepEqual(enabledProducers(rows, T), [rows[0]]);
  // Without a table nothing is excluded by platform, only by the toggle.
  assert.deepEqual(enabledProducers(rows), [rows[0], rows[2]]);
  assert.deepEqual(enabledProducers(null, T), []);
});
// The two scripts either side of the stamp. The rules above are only worth
// anything if the sync writes the stamp the way they read it and the alarm
// consults them where it has to, so the wiring is pinned here too -- the
// helpers can be perfect while the call path ignores them.
const sync = readFileSync(new URL('../ad-platforms-sync.mjs', import.meta.url), 'utf8');
const alarm = readFileSync(new URL('../check-sales-freshness.mjs', import.meta.url), 'utf8');

t('the sync records the LAST attempt: a block when client-side, null otherwise', () => {
  // Written on any failure that could change the stamp, not only a
  // client-side one -- otherwise a SILO-side failure after a block leaves
  // "blocked" standing as the newest outcome.
  // UNCONDITIONAL: not guarded by what this run's snapshot happened to see,
  // because overlapping runs load the snapshot at different times and the
  // loser would skip the write (cycle 2).
  assert.equal(/if \([^)]*hadBlock[^)]*\)/.test(sync), false, 'the write must not be guarded by a stale snapshot');
  assert.match(sync, /failedMeta\.client_side_block = block \? \{ reason: block, at: new Date\(\)\.toISOString\(\) \} : null;/);
  // ... and it is reached on any failure, not only a backfill one.
  assert.match(sync, /const block = clientSideReason\(message\);\n(?:\s*\/\/[^\n]*\n)*\s*const failedMeta = history\.backfill/);
  // Both success paths clear it: the campaign one and Search Console's.
  assert.equal((sync.match(/client_side_block: null/g) || []).length, 2);
});

t('the alarm consults the excuse for a partial day, and only a block excuses one', () => {
  assert.match(alarm, /if \(!lagOk \|\| partial\) \{/);
  assert.match(alarm, /if \(partial && !\(excuse === 'client-blocked'\s*\n?\s*&& feedFullyBlocked\(/);
  // The warning is built from the helper, not from a second predicate.
  assert.match(alarm, /feedBlockers\(conns, SYNC_STAMP\[feed\.connTable\], dayEndedAt, feed\.connTable\)/);
});

console.log(`${n} freshness quiet checks passed`);
