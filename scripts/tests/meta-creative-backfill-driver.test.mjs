/* The backfill DRIVER, executed for real.
 *
 * scripts/tests/meta-creative-backfill.test.mjs covers runMetaCreativeBackfill.
 * That is the core, and passing helpers is exactly the state in which a
 * temporal-dead-zone reference shipped inside an orchestrator callback here on
 * 2026-09-09: 91 passing assertions on the function, none on the five lines
 * that called it. So this file runs scripts/meta-creative-backfill.mjs ITSELF
 * -- its connection load, its candidate selection, its PostgREST paging, its
 * sync_jobs bookkeeping and its exit code -- against a stubbed Supabase and a
 * stubbed Graph API.
 *
 * What is proven here:
 *   1. The default `missing` mode asks only about creatives with no
 *      destination or no preview link, so a re-run after a partial failure resumes rather than
 *      re-walking 4,000 ads.
 *   2. Stored creatives are paged past PostgREST's 1,000-row cap. A single
 *      unpaged select would silently backfill the first 1,000 ads and report
 *      success -- the failure mode with no symptom.
 *   3. sync_jobs gets a running row and then a terminal status, and a failed
 *      run exits non-zero.
 *   4. mode=all re-asks about every stored creative.
 *
 * No network, no database. Run:
 *   node scripts/tests/meta-creative-backfill-driver.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DRIVER = join(ROOT, 'scripts/meta-creative-backfill.mjs');
const dir = mkdtempSync(join(tmpdir(), 'meta-bf-drv-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

/** State the stubbed Supabase exposes back to the test. */
const state = {
  creatives: [],
  connections: [],
  jobs: [],
  upserts: [],
  pageSizeSeen: [],
};

writeFileSync(join(dir, 'supabase-stub.mjs'), `
export function createClient() {
  const S = globalThis.__BF_STATE__;
  return {
    from(table) {
      const q = {
        _filters: {}, _range: null,
        select() { return q; },
        eq(col, val) { q._filters[col] = val; return q; },
        order() { return q; },
        range(a, b) { q._range = [a, b]; return q; },
        single: async () => {
          // sync_jobs insert ... select('id').single()
          return { data: { id: 'job-' + (S.jobs.length) }, error: null };
        },
        insert(row) { S.jobs.push({ ...row, status: row.status }); return q; },
        update(patch) { q._patch = patch; q._isUpdate = true; return q; },
        upsert: async (rows) => { S.upserts.push({ table, rows }); return { error: null }; },
        then: undefined,
      };
      // A select resolves when awaited.
      q.then = (res, rej) => {
        let data = [];
        if (table === 'ad_platform_connections') data = S.connections;
        else if (table === 'meta_ad_creatives') {
          const [a, b] = q._range || [0, 999];
          S.pageSizeSeen.push([a, b]);
          data = S.creatives.slice(a, b + 1);
        } else if (table === 'sync_jobs') {
          if (q._isUpdate && S.failJobUpdate) {
            return Promise.resolve({ data: null, error: { message: 'terminal update boom' } }).then(res, rej);
          }
          if (q._patch) { S.jobs[S.jobs.length - 1] = { ...S.jobs[S.jobs.length - 1], ...q._patch }; }
          data = [];
        }
        return Promise.resolve({ data, error: null }).then(res, rej);
      };
      return q;
    },
  };
}
`);

/* Mutations (each must make this file FAIL):
 *   META_BF_DRV_MUTATION=ignores-job-error  (terminal sync_jobs error discarded)
 *   META_BF_DRV_MUTATION=unpaged-load       (stored creatives read in one page)
 */
const mutation = process.env.META_BF_DRV_MUTATION || '';
assert.ok(['', 'ignores-job-error', 'unpaged-load'].includes(mutation),
  `Unknown mutation ${mutation}`);

let src = readFileSync(DRIVER, 'utf8')
  .replace("from '@supabase/supabase-js'", `from '${pathToFileURL(join(dir, 'supabase-stub.mjs')).href}'`)
  .replace("from './lib/ad-platforms-sync-core.mjs'",
    `from '${pathToFileURL(join(ROOT, 'scripts/lib/ad-platforms-sync-core.mjs')).href}'`);

if (mutation === 'ignores-job-error') {
  // The finding cycle 1 raised: the terminal update is awaited and its error
  // thrown away, so a run whose job row is stuck on 'running' still prints
  // [ok] and exits 0.
  const before = 'const { error: jobUpdateErr } = await supabase.from(\'sync_jobs\').update({';
  assert.ok(src.includes(before), 'mutation hook missing for ignores-job-error');
  src = src.replace(before, 'const { error: _ignored } = await supabase.from(\'sync_jobs\').update({')
           .replace('  if (jobUpdateErr) {', '  if (false) {');
} else if (mutation === 'unpaged-load') {
  // A single unpaged select: the backfill would cover the first 1,000 ads and
  // report success, the failure mode with no symptom.
  const before = '    if (data.length < PAGE) break;';
  assert.ok(src.includes(before), 'mutation hook missing for unpaged-load');
  src = src.replace(before, '    break;');
}
if (mutation) assert.notEqual(src, readFileSync(DRIVER, 'utf8'), 'mutation did not apply');

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }

const adWithLink = (id) => ({
  id, name: `ad ${id}`, campaign_id: 'c1', adset_id: 's1', effective_status: 'ACTIVE',
  creative: {
    id: `cr${id}`, object_type: 'SHARE', body: 'copy',
    asset_feed_spec: { link_urls: [{ website_url: `https://www.baseballism.com/${id}` }] },
  },
});

/** Runs the driver as a module, with env applied, returning what it did. */
async function runDriver(env, opts) {
  const { creatives, listPages = [] } = opts;
  state.creatives = creatives;
  state.connections = [{
    id: 'conn-1', company_entity_id: 'co-1', display_name: 'Meta',
    access_token: 'tok', meta_ad_account_id: 'act_1', platform: 'meta_ads',
  }];
  state.jobs = []; state.upserts = []; state.pageSizeSeen = [];
  state.failJobUpdate = opts.failJobUpdate || false;
  globalThis.__BF_STATE__ = state;

  const asked = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/ads?') && !opts.body) {
      const page = Number(new URL(u).searchParams.get('__page') || 0);
      const body = { data: (listPages[page] || []).map((id) => ({ id })) };
      if (page + 1 < listPages.length) body.paging = { next: `${u.split('?')[0]}?__page=${page + 1}` };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    }
    const batch = JSON.parse(new URLSearchParams(String(opts.body || '')).get('batch') || '[]');
    const items = batch.map((b) => {
      const id = b.relative_url.split('?')[0].split('/').pop();
      asked.push(id);
      return { code: 200, body: JSON.stringify(adWithLink(id)) };
    });
    return { ok: true, status: 200, text: async () => JSON.stringify(items) };
  };

  const prev = {};
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
  process.env.SUPABASE_URL = 'https://stub';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';

  // Fresh module each run: top-level env reads happen at import time.
  const file = join(dir, `driver-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, src);
  let exitCode = 0;
  const realExit = process.exit;
  process.exit = (c) => { exitCode = c ?? 0; throw new Error('__EXIT__'); };
  // The driver's own `main().catch(... process.exit(1))` runs AFTER import
  // resolves, so the sentinel thrown by the stubbed exit surfaces as an
  // unhandled rejection and would kill this test process. Swallow only the
  // sentinel; anything else is a real failure and must still propagate.
  const onUnhandled = (err) => {
    if (!String(err?.message).includes('__EXIT__')) throw err;
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    await import(pathToFileURL(file).href);
    // main() is not awaited by the module, so let it (and any rejection it
    // produces) settle BEFORE the handler above is removed.
    await new Promise((r) => setTimeout(r, 40));
  } catch (e) { if (!String(e.message).includes('__EXIT__')) throw e; }
  finally {
    process.exit = realExit;
    process.off('unhandledRejection', onUnhandled);
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return { asked, exitCode };
}

await test('default mode asks only about creatives missing a destination or a preview', async () => {
  const { asked } = await runDriver(
    { META_BACKFILL_DISCOVER: 'false' },
    { creatives: [
      { ad_id: 'has', link_url: 'https://x/1', preview_shareable_link: 'https://fb.me/a', synced_at: '2026-09-16' },
      { ad_id: 'missing1', link_url: null, preview_shareable_link: 'https://fb.me/b', synced_at: '2026-09-15' },
      { ad_id: 'missing2', link_url: null, synced_at: '2026-09-14' },
      // Has a destination, has never had its preview asked for: every ad
      // stored before 2026-09-23. One Meta read answers both gaps.
      { ad_id: 'nopreview', link_url: 'https://x/2', preview_shareable_link: null, synced_at: '2026-09-13' },
    ] });
  assert.deepEqual(asked.sort(), ['missing1', 'missing2', 'nopreview'],
    'an ad with both a destination and a preview must not be re-asked in the default mode');
});

await test('mode=all re-asks about every stored creative', async () => {
  const { asked } = await runDriver(
    { META_BACKFILL_MODE: 'all', META_BACKFILL_DISCOVER: 'false' },
    { creatives: [
      { ad_id: 'has', link_url: 'https://x/1', synced_at: '2026-09-16' },
      { ad_id: 'missing1', link_url: null, synced_at: '2026-09-15' },
    ] });
  assert.deepEqual(asked.sort(), ['has', 'missing1']);
});

await test('stored creatives are paged past the 1,000-row PostgREST cap', async () => {
  const many = Array.from({ length: 2300 }, (_, i) => ({
    ad_id: `a${i}`, link_url: null, synced_at: '2026-09-16',
  }));
  const { asked } = await runDriver(
    { META_BACKFILL_DISCOVER: 'false', META_BACKFILL_CHUNK: '1000' },
    { creatives: many });
  assert.equal(asked.length, 2300,
    'all 2,300 stored creatives must be reached, not just the first page');
  assert.ok(state.pageSizeSeen.length >= 3, 'the select must page');
});

await test('discovery reaches ads that were never stored', async () => {
  const { asked } = await runDriver(
    { META_BACKFILL_DISCOVER: 'true' },
    {
      creatives: [{ ad_id: 'stored', link_url: null, synced_at: '2026-09-16' }],
      listPages: [['stored', 'unseen1', 'unseen2']],
    });
  assert.deepEqual(asked.sort(), ['stored', 'unseen1', 'unseen2']);
});

await test('a run records a sync_jobs row and finishes it as success', async () => {
  await runDriver({ META_BACKFILL_DISCOVER: 'false' },
    { creatives: [{ ad_id: 'm1', link_url: null, synced_at: '2026-09-16' }] });
  assert.equal(state.jobs.length, 1, 'one job row per connection');
  assert.equal(state.jobs[0].job_type, 'meta_creative_backfill');
  assert.equal(state.jobs[0].status, 'success', 'the job must be closed out, not left running');
});

await test('nothing to backfill does no work and records no job', async () => {
  const { asked } = await runDriver({ META_BACKFILL_DISCOVER: 'false' },
    { creatives: [{ ad_id: 'has', link_url: 'https://x/1', preview_shareable_link: 'https://fb.me/a', synced_at: '2026-09-16' }] });
  assert.equal(asked.length, 0);
  assert.equal(state.jobs.length, 0, 'an empty run must not open a sync_jobs row');
});

await test('LIMIT caps how many ads a run asks about', async () => {
  const many = Array.from({ length: 50 }, (_, i) => ({
    ad_id: `a${i}`, link_url: null, synced_at: '2026-09-16',
  }));
  const { asked } = await runDriver(
    { META_BACKFILL_DISCOVER: 'false', META_BACKFILL_LIMIT: '5' }, { creatives: many });
  assert.equal(asked.length, 5);
});

await test('a failed terminal sync_jobs update is NOT reported as success', async () => {
  // The data writes land, then closing out the job row fails. Discarding that
  // error would print [ok] and exit 0 while sync_jobs still says 'running' --
  // a status someone diagnosing a half-finished backfill has to trust. The
  // run must fail loudly instead.
  const { exitCode } = await runDriver(
    { META_BACKFILL_DISCOVER: 'false' },
    {
      creatives: [{ ad_id: 'm1', link_url: null, synced_at: '2026-09-16' }],
      failJobUpdate: true,
    });
  assert.notEqual(exitCode, 0, 'a run whose job row could not be closed must exit non-zero');
  assert.ok(state.upserts.length > 0, 'and the creative writes that DID land are still written');
});

console.log(`\n${passed} assertions passed${mutation ? ` (mutation: ${mutation})` : ''}`);
