/* scripts/meta-creative-images.mjs, executed for real against a stubbed
 * Supabase (with storage) and a stubbed Graph API / CDN.
 *
 * The archive core has its own suite (creative-image-archive.test.mjs); this
 * one runs the DRIVER -- connection load, candidate selection across PostgREST
 * pages, chunking, sync_jobs bookkeeping and exit code -- because a helper
 * passing in isolation is exactly the state in which a broken orchestrator
 * shipped here before (2026-09-09).
 *
 * Proven:
 *   1. Stored creatives are read past the 1,000-row page cap, and only the
 *      ones without a current image are asked about.
 *   2. The run is recorded: a running sync_jobs row, then success with counts.
 *   3. A run in which nothing archived and something failed (a missing bucket)
 *      is an ERROR and exits non-zero -- not a green run with 0 images.
 *   4. The access token never appears in the log.
 *   5. Two Meta accounts in one company: each connection's token is used only
 *      for its own account's ads, and an ad with no account id is claimed by
 *      neither (it is attributable only when the company has one connection).
 *
 * Mutations (each must make this file FAIL):
 *   META_IMG_DRV_MUTATION=unpaged      (reads one page of creatives)
 *   META_IMG_DRV_MUTATION=green-empty  (an all-failed run reports success)
 *
 * No network, no database. Run: node scripts/tests/meta-creative-images-driver.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DRIVER = join(ROOT, 'scripts/meta-creative-images.mjs');
const dir = mkdtempSync(join(tmpdir(), 'meta-img-drv-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const mutation = process.env.META_IMG_DRV_MUTATION || '';
assert.ok(['', 'unpaged', 'green-empty'].includes(mutation), `Unknown mutation ${mutation}`);

const TOKEN = 'EAAdrivertokenABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CO = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7';
const state = {};
writeFileSync(join(dir, 'supabase-stub.mjs'), `
export function createClient() {
  const S = globalThis.__IMG_STATE__;
  return {
    storage: { from: () => ({ upload: async (path) => S.failUpload
      ? { error: { message: 'Bucket not found' } }
      : (S.uploads.push(path), { data: { path }, error: null }) }) },
    from(table) {
      const q = { f: [], rng: null, patch: null, insertRow: null };
      const run = () => {
        if (table === 'ad_platform_connections') return { data: S.connections, error: null };
        if (table === 'sync_jobs') {
          if (q.insertRow) { S.jobs.push({ ...q.insertRow }); return { data: { id: 'job-1' }, error: null }; }
          if (q.patch) Object.assign(S.jobs[S.jobs.length - 1], q.patch);
          return { data: [], error: null };
        }
        let rows = S.creatives.filter((r) => q.f.every(([op, c, v]) => op === 'in' ? v.includes(String(r[c])) : String(r[c]) === String(v)));
        if (q.patch) { rows.forEach((r) => Object.assign(r, q.patch)); return { data: rows.map((r) => ({ ad_id: r.ad_id })), error: null }; }
        if (q.rng) { S.pages.push(q.rng); rows = rows.slice(q.rng[0], q.rng[1] + 1); }
        return { data: rows.map((r) => ({ ...r })), error: null };
      };
      Object.assign(q, {
        select() { return q; }, order() { return q; },
        eq(c, v) { q.f.push(['eq', c, v]); return q; },
        in(c, v) { q.f.push(['in', c, v.map(String)]); return q; },
        range(a, b) { q.rng = [a, b]; return q; },
        insert(r) { q.insertRow = r; return q; },
        update(p) { q.patch = p; return q; },
        single: async () => run(),
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
      });
      return q;
    },
  };
}
`);

let src = readFileSync(DRIVER, 'utf8')
  .replace("from '@supabase/supabase-js'", `from '${pathToFileURL(join(dir, 'supabase-stub.mjs')).href}'`)
  .replace("from './lib/ad-platforms-sync-core.mjs'", `from '${pathToFileURL(join(ROOT, 'scripts/lib/ad-platforms-sync-core.mjs')).href}'`)
  .replace("from './lib/creative-image-archive.mjs'", `from '${pathToFileURL(join(ROOT, 'scripts/lib/creative-image-archive.mjs')).href}'`);
if (mutation === 'unpaged') {
  assert.ok(src.includes('    if (data.length < PAGE) break;'));
  src = src.replace('    if (data.length < PAGE) break;', '    break;');
} else if (mutation === 'green-empty') {
  assert.ok(src.includes('(total.archived === 0 && total.failed > 0)'));
  src = src.replace('(total.archived === 0 && total.failed > 0)', 'false');
}

function jpeg() {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0),
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x04, 0x38, 3, ...Array(9).fill(0), 0xff, 0xd9]);
}

async function run({ creatives, failUpload = false, connections = null }) {
  Object.assign(state, {
    creatives, failUpload, uploads: [], jobs: [], pages: [], byToken: [],
    connections: connections || [{ id: 'conn-1', company_entity_id: CO, display_name: 'Meta', access_token: TOKEN, platform: 'meta_ads', meta_ad_account_id: 'act_1' }],
  });
  state.expectJobs = (connections || [1]).length;
  globalThis.__IMG_STATE__ = state;
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://graph.facebook.com/')) {
      const id = decodeURIComponent(u.split('/').pop().split('?')[0]);
      asked.push(id);
      (state.byToken ||= []).push([new URL(u).searchParams.get('access_token'), id]);
      return { ok: true, status: 200, text: async () => JSON.stringify({ thumbnail_url: `https://scontent.xx.fbcdn.net/${id}.jpg` }) };
    }
    const b = jpeg();
    return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(0) };
  };
  const logs = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => logs.push(a.join(' ')); console.error = console.log; console.warn = console.log;
  process.env.SUPABASE_URL = 'https://stub'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  const file = join(dir, `driver-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, src);
  let exitCode = 0;
  const realExit = process.exit;
  process.exit = (c) => { exitCode = c ?? 0; throw new Error('__EXIT__'); };
  const onUnhandled = (err) => { if (!String(err?.message).includes('__EXIT__')) throw err; };
  process.on('unhandledRejection', onUnhandled);
  try {
    await import(pathToFileURL(file).href);
    // main() is not awaited by the module: wait until the run records its
    // end (or exits), never on a fixed sleep a slower machine outruns.
    for (let i = 0; i < 400; i += 1) {
      const job = state.jobs[state.jobs.length - 1];
      const done = state.jobs.filter((j) => j.finished_at).length;
      if ((done && done >= state.expectJobs) || exitCode) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 25));
  } catch (e) { if (!String(e.message).includes('__EXIT__')) throw e; }
  finally {
    process.exit = realExit; process.off('unhandledRejection', onUnhandled);
    Object.assign(console, orig);
  }
  return { asked, exitCode, logs };
}

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`not ok - ${name}`); throw e; }
};
const creative = (i, extra = {}) => ({ company_entity_id: CO, ad_id: `ad${i}`, creative_id: `cr${i}`, image_path: null,
  image_creative_id: null, image_attempted_at: null, image_error: null, synced_at: '2026-09-01', ...extra });

await test('reads past the 1,000-row page and asks only about ads without a current image', async () => {
  const rows = Array.from({ length: 1003 }, (_, i) => creative(i));
  rows[0] = creative(0, { image_path: `${CO}/${'a'.repeat(64)}.jpg`, image_creative_id: 'cr0',
    image_sha256: 'a'.repeat(64), image_archived_at: '2026-09-01' });
  const { asked, exitCode } = await run({ creatives: rows });
  assert.equal(exitCode, 0);
  assert.ok(asked.includes('cr1002'), 'an ad on the second page was reached');
  assert.ok(!asked.includes('cr0'), 'an archived ad is not asked again');
  assert.equal(asked.length, 1002);
  assert.equal(state.jobs[0].status, 'success');
  assert.equal(state.jobs[0].result.archived, 1002);
  assert.equal(state.jobs[0].result.mode, 'images');
});

await test('nothing archived and everything failed is an error run that exits non-zero', async () => {
  const { exitCode, logs } = await run({ creatives: [creative(1), creative(2)], failUpload: true });
  assert.equal(state.jobs[0].status, 'error');
  assert.match(state.jobs[0].error, /Bucket not found/);
  assert.equal(exitCode, 1);
  assert.ok(!logs.join('\n').includes(TOKEN), 'the token never reaches the log');
});

await test('two accounts: each token asks only for its own account; an unattributed ad is claimed by neither', async () => {
  const TOKEN_B = 'EAAsecondtokenABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const { exitCode } = await run({
    connections: [
      { id: 'conn-a', company_entity_id: CO, display_name: 'A', access_token: TOKEN, platform: 'meta_ads', meta_ad_account_id: 'act_1' },
      { id: 'conn-b', company_entity_id: CO, display_name: 'B', access_token: TOKEN_B, platform: 'meta_ads', meta_ad_account_id: '2' },
    ],
    creatives: [creative('a1', { account_id: 'act_1' }), creative('b1', { account_id: 'act_2' }), creative('n1', { account_id: null })],
  });
  assert.equal(exitCode, 0);
  const pairs = state.byToken.map(([t, id]) => `${t === TOKEN ? 'A' : t === TOKEN_B ? 'B' : '?'}:${id}`).sort();
  assert.deepEqual(pairs, ['A:cra1', 'B:crb1'], 'A never asks for B\'s ad, nor B for A\'s, and nobody claims n1');
  const b1 = state.creatives.find((r) => r.ad_id === 'adb1');
  assert.ok(b1.image_path && !b1.image_error, 'B\'s ad was archived by B, never backed off by A');
});

console.log(`\n${passed} passed`);
