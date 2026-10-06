// A new Meta connection's first-year import (scripts/lib/meta-history-backfill.mjs)
// and its wiring into scripts/ad-platforms-sync.mjs.
//
// The rules that matter: only a connection CARRYING the flag is widened (an
// established account is never re-pulled for a year), the 2-hourly refresh
// never consumes the flag (it skips Page posts, so it cannot finish the
// import), and a connection that keeps failing stops after a bounded number
// of attempts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  planMetaHistory, metaHistoryComplete, metaAfterHistory, META_HISTORY_DAYS, META_HISTORY_MAX_ATTEMPTS,
} from '../lib/meta-history-backfill.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}

const meta = (m) => ({ platform: 'meta_ads', meta: m });

await test('a new Meta connection imports a year on a full run', () => {
  assert.deepEqual(planMetaHistory(meta({ history_backfill_pending: true }), { daysBack: null }),
    { backfill: true, daysBack: META_HISTORY_DAYS });
  assert.equal(META_HISTORY_DAYS, 365);
});

await test('an established connection (no flag) is never widened', () => {
  for (const m of [{}, { last_sync_at: '2026-10-01' }, { history_backfill_pending: false }, null]) {
    assert.deepEqual(planMetaHistory(meta(m), { daysBack: null }), { backfill: false, daysBack: null });
  }
});

await test('the 2-hourly refresh leaves the flag for the nightly', () => {
  assert.deepEqual(planMetaHistory(meta({ history_backfill_pending: true }), { skipOrganic: true, daysBack: 3 }),
    { backfill: false, daysBack: 3 });
});

await test('only Meta; a manual run asking for MORE than a year keeps its wider window', () => {
  assert.equal(planMetaHistory({ platform: 'google_ads', meta: { history_backfill_pending: true } }).backfill, false);
  assert.equal(planMetaHistory(meta({ history_backfill_pending: true }), { daysBack: 730 }).daysBack, 730);
  assert.equal(planMetaHistory(meta({ history_backfill_pending: true }), { daysBack: 30 }).daysBack, 365);
});

await test('complete only when ad-level AND organic landed', () => {
  assert.equal(metaHistoryComplete({ ad_level: { ad_rows_upserted: 3 }, organic: { configured: false } }), true);
  assert.equal(metaHistoryComplete({ ad_level: { error: 'x' }, organic: {} }), false);
  assert.equal(metaHistoryComplete({ ad_level: {}, organic: { error: 'x' } }), false);
  assert.equal(metaHistoryComplete({ ad_level: {}, organic: { media_upserted: 4, page_error: 'Page Insights 500' } }), false,
    'a failed Page Insights pull is caught inside organic, not thrown, and still leaves history missing');
});

await test('a Page Insights failure keeps the flag and counts the attempt', () => {
  const result = { ad_level: { ad_rows_upserted: 3 }, organic: { media_upserted: 4, page_error: 'Page Insights 500' } };
  const after = metaAfterHistory({ history_backfill_pending: true },
    { backfill: true, succeeded: metaHistoryComplete(result), at: 'T' });
  assert.deepEqual(after, { history_backfill_pending: true, history_backfill_attempts: 1 });
});

await test('success clears the flag, records when, and keeps the rest of meta', () => {
  const after = metaAfterHistory({ history_backfill_pending: true, history_backfill_attempts: 1, keep: 1 },
    { backfill: true, succeeded: true, at: 'T' });
  assert.deepEqual(after, { keep: 1, history_backfill_pending: false, history_backfilled_at: 'T', history_backfill_days: 365 });
});

await test('a failure keeps the flag and counts the attempt; the last allowed attempt gives up', () => {
  let m = { history_backfill_pending: true };
  for (let i = 1; i < META_HISTORY_MAX_ATTEMPTS; i += 1) {
    m = metaAfterHistory(m, { backfill: true, succeeded: false, at: `T${i}` });
    assert.equal(m.history_backfill_pending, true);
    assert.equal(m.history_backfill_attempts, i);
  }
  m = metaAfterHistory(m, { backfill: true, succeeded: false, at: 'TX' });
  assert.equal(m.history_backfill_pending, false);
  assert.equal(m.history_backfill_gave_up_at, 'TX');
  assert.equal(planMetaHistory(meta({ history_backfill_pending: true, history_backfill_attempts: META_HISTORY_MAX_ATTEMPTS })).backfill,
    false, 'an exhausted connection is not widened even if the flag were left on');
});

await test('a run that was not an import leaves meta untouched', () => {
  assert.deepEqual(metaAfterHistory({ history_backfill_pending: true }, { backfill: false, succeeded: true, at: 'T' }),
    { history_backfill_pending: true });
});

// ── wiring: the nightly orchestrator and the page ─────────────────────────
const sync = readFileSync(new URL('../ad-platforms-sync.mjs', import.meta.url), 'utf8');
const page = readFileSync(new URL('../../v2/integrations.html', import.meta.url), 'utf8');

await test('the orchestrator plans with the organic-skip flag and the dispatch window', () => {
  assert.match(sync, /planMetaHistory\(connection, \{ skipOrganic: SKIP_ORGANIC, daysBack: DAYS_BACK \}\)/);
});

await test('all three Meta pulls use the planned window, not the raw env', () => {
  for (const fn of ['runConnectionSync\\(supabase, GOOGLE_ENV, connection', 'runMetaAdLevelSync\\(supabase, connection', 'runMetaOrganicSync\\(supabase, connection']) {
    const m = sync.match(new RegExp(`${fn}, \\{[\\s\\S]{0,120}?daysBackOverride: (\\w+)`));
    assert.ok(m, fn);
    assert.equal(m[1], 'runDaysBack', `${fn} must use runDaysBack`);
  }
});

await test('success and failure both write the history state back', () => {
  assert.match(sync, /metaAfterHistory\(connection\.meta, \{\s*backfill: history\.backfill, succeeded: metaHistoryComplete\(result\)/);
  assert.match(sync, /if \(history\.backfill\) \{[\s\S]{0,400}metaAfterHistory\(connection\.meta, \{ backfill: true, succeeded: false/);
});

await test('Integrations flags a NEW Meta connection, and only on insert', () => {
  const inserts = page.match(/meta: \{ history_backfill_pending: true \}/g) || [];
  assert.equal(inserts.length, 1);
  const i = page.indexOf('meta: { history_backfill_pending: true }');
  const before = page.slice(Math.max(0, i - 600), i);
  assert.match(before, /\.from\('ad_platform_connections'\)\.insert\(\{[\s\S]*platform: 'meta_ads'/);
});

console.log(`\nmeta-history-backfill: ${passed} passed`);
