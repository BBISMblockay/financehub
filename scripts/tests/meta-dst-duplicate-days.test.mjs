// Meta returns a day OUTSIDE the window it was asked for, and that duplicate
// killed a whole year's import.
//
// Süti connected Meta on 2026-11-17. Its first 365-day import failed three
// times with
//     ON CONFLICT DO UPDATE command cannot affect row a second time
// and then gave up, leaving 227 days (2026-03-05..2026-10-17, ~$217k of spend)
// with no rows at all. Measured live against the account that failed
// (act_290068470557765, timezone America/Los_Angeles):
//
//   since=2026-03-08&until=2026-03-08  ->  rows for 2026-03-08 AND 2026-03-09
//   since=2026-03-02&until=2026-03-08  ->  the 7 days asked for, plus eight
//                                          2026-03-09 campaign rows
//
// 2026-03-08 is the US spring-forward day: that local day is 23 hours long, so
// Meta's 24-hour step walks past local midnight and emits the following day as
// well. The next chunk (2026-03-09..) then returns 2026-03-09 again, both
// copies land in the same in-memory batch, and the two rows carry the same
// row_hash -- which one INSERT ... ON CONFLICT cannot touch twice. The two
// copies measured identical on every metric, so this is one day read twice,
// not two readings that disagree.
//
// What these tests defend:
//   1. A fetch returns AT MOST ONE row per identity (account x campaign x day,
//      account x ad x day), however many chunks returned that day.
//   2. The copy kept is the one from the chunk whose range CONTAINS the day --
//      in BOTH directions, not merely "the last one seen", because an overrun
//      backwards would otherwise overwrite a correct reading with a stray one.
//   3. Identical duplicates collapse silently-ish; duplicates that DISAGREE are
//      counted and warned about, never dropped quietly.
//   4. End to end, over a window big enough to need several 500-row upsert
//      batches, no batch ever carries one row_hash twice -- the fake database
//      here refuses that exactly as Postgres does -- and no day is lost.
//   5. A day that only ever arrives out of range is still kept: the fix
//      collapses duplicates, it does not discard data outside the window.
//   6. dedupeOnConflictKey is the last line: a duplicate from any future source
//      costs a warning and the last row of that key, not the whole write.
//
// Mutation-tested: each guard is broken in turn and a test must fail. Run
//   node scripts/tests/meta-dst-duplicate-days.test.mjs --mutate=N
// for N in 1..4; every one must exit non-zero.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CORE = join(ROOT, 'scripts/lib/ad-platforms-sync-core.mjs');
const mutation = Number((process.argv.find((a) => a.startsWith('--mutate=')) || '').split('=')[1] || 0);

let source = readFileSync(CORE, 'utf8');
if (mutation === 1) {
  // Stop collapsing altogether: every row gets its own key, so both copies of
  // the duplicated day survive into the upsert batch.
  source = source.replace(
    '      const key = keyOf(row);\n      const prev = byKey.get(key);',
    '      const key = `${keyOf(row)}|${byKey.size}`;\n      const prev = byKey.get(key);');
} else if (mutation === 2) {
  // Keep the first copy seen instead of preferring the in-range one.
  source = source.replace(
    '      if (inRange || !prev.inRange) byKey.set(key, { row, inRange });',
    '      if (false) byKey.set(key, { row, inRange });');
} else if (mutation === 3) {
  // Treat every row as in range: the rule degrades to "last one wins", which
  // is wrong whenever the stray copy arrives after the real one.
  source = source.replace(
    '        }, { inRange: r.date_start >= since && r.date_start <= until });\n      }\n      url = data.paging?.next ?? null;\n    }\n    s = new Date(e.getTime() + 86400000);\n  }\n  return collected.rows();\n}\n\n/** Ad-level Meta insights',
    '        }, { inRange: true });\n      }\n      url = data.paging?.next ?? null;\n    }\n    s = new Date(e.getTime() + 86400000);\n  }\n  return collected.rows();\n}\n\n/** Ad-level Meta insights');
} else if (mutation === 4) {
  // Remove the last-line guard in front of the upserts.
  source = source.replace('  if (!dropped) return rows;', '  return rows;');
}
if (mutation) assert.notEqual(source, readFileSync(CORE, 'utf8'), 'mutation did not apply');

const dir = mkdtempSync(join(tmpdir(), 'meta-dst-dupes-'));
const sibling = pathToFileURL(join(ROOT, 'scripts/lib/shopify-sync-core.mjs')).href;
const copy = join(dir, 'ad-platforms-sync-core.mjs');
writeFileSync(copy, source.replace("from './shopify-sync-core.mjs'", `from '${sibling}'`));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const {
  fetchMetaAdsRows, fetchMetaAdLevelRows, dedupeOnConflictKey, runConnectionSync,
} = await import(pathToFileURL(copy).href);

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}

const CONN = {
  id: 'conn-1',
  company_entity_id: 'co-1',
  platform: 'meta_ads',
  access_token: 'tok',
  meta_ad_account_id: 'act_123',
  days_back: 30,
};
const DST_DAY = '2026-03-08';      // US spring forward, 23 hours long
const OVERRUN = '2026-03-09';      // the day Meta hands back uninvited

const addDay = (d, n) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400000)
  .toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round(
  (new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

/** A Meta stand-in that reproduces the measured behaviour: it answers the days
 * asked for, and when `until` is the spring-forward day it adds the next day
 * too. `spendFor` lets a test make the two copies of a day disagree. */
function metaFetch({ campaigns = ['c1'], level = 'campaign', spendFor = () => '10.00',
  extraTrailingDay = true, extraLeadingDay = false } = {}) {
  const requests = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const range = JSON.parse(u.searchParams.get('time_range'));
    requests.push(range);
    const days = [];
    for (let d = range.since; d <= range.until; d = addDay(d, 1)) days.push(d);
    if (extraTrailingDay && range.until === DST_DAY) days.push(addDay(range.until, 1));
    if (extraLeadingDay && range.since === OVERRUN) days.unshift(addDay(range.since, -1));
    const data = [];
    for (const day of days) {
      for (const c of campaigns) {
        data.push({
          account_id: 'act_123',
          account_name: 'Demo',
          date_start: day,
          date_stop: day,
          campaign_id: c,
          campaign_name: `Campaign ${c}`,
          ...(level === 'ad' ? { ad_id: `ad-${c}`, ad_name: `Ad ${c}`, adset_id: `as-${c}`, adset_name: 'Set' } : {}),
          impressions: '100',
          clicks: '5',
          spend: spendFor(day, c, range),
          actions: [{ action_type: 'omni_purchase', value: '1' }],
          action_values: [{ action_type: 'omni_purchase', value: '50.00' }],
        });
      }
    }
    return new Response(JSON.stringify({ data }), { status: 200 });
  };
  return { requests, restore() { globalThis.fetch = real; } };
}

/** Postgres's own rule: one INSERT ... ON CONFLICT may not touch a row twice.
 * A payload carrying the same conflict key twice is rejected exactly as the
 * live database rejected Süti's import. */
function fakeSupabase() {
  const writes = [];
  const api = {
    from(table) {
      const b = {
        upsert(payload, opts) {
          const key = opts?.onConflict || 'row_hash';
          const seen = new Set();
          for (const row of payload) {
            if (seen.has(row[key])) {
              return Promise.resolve({ data: null, error: {
                message: 'ON CONFLICT DO UPDATE command cannot affect row a second time' } });
            }
            seen.add(row[key]);
          }
          writes.push({ table, payload });
          return Promise.resolve({ data: null, error: null });
        },
        select() { return b; },
        eq() { return b; },
        order() { return b; },
        limit() { return Promise.resolve({ data: [], error: null }); },
        then(res, rej) { return Promise.resolve({ data: [], error: null }).then(res, rej); },
      };
      return b;
    },
  };
  return { api, writes };
}
const rowsFor = (writes, table) => writes.filter((w) => w.table === table).flatMap((w) => w.payload);

function captureWarnings() {
  const real = console.warn;
  const lines = [];
  console.warn = (...args) => { lines.push(args.join(' ')); };
  return { lines, restore() { console.warn = real; } };
}

// ── 1. One row per identity, however many chunks returned the day ───────────
await test('campaign level: the day Meta hands back twice is fetched once', async () => {
  const meta = metaFetch({ campaigns: ['c1', 'c2'] });
  try {
    const rows = await fetchMetaAdsRows(CONN, { startDate: '2026-03-02', endDate: '2026-03-15' });
    // The stub was asked for two chunks and overran the first one.
    assert.deepEqual(meta.requests, [
      { since: '2026-03-02', until: '2026-03-08' },
      { since: '2026-03-09', until: '2026-03-15' },
    ]);
    const keys = rows.map((r) => `${r.campaignId}|${r.day}`);
    assert.equal(new Set(keys).size, keys.length, 'a campaign-day was fetched twice');
    assert.equal(rows.filter((r) => r.day === OVERRUN).length, 2, 'both campaigns kept for the duplicated day');
    assert.equal(new Set(rows.map((r) => r.day)).size, 14, 'every day in the window survives');
  } finally { meta.restore(); }
});

await test('ad level: same guard, one row per ad-day', async () => {
  // chunkDays = 1 at ad level, so the overrun lands on the very next request.
  const meta = metaFetch({ campaigns: ['c1', 'c2'], level: 'ad' });
  try {
    const rows = await fetchMetaAdLevelRows(CONN, { startDate: '2026-03-07', endDate: '2026-03-10' });
    const keys = rows.map((r) => `${r.adId}|${r.day}`);
    assert.equal(new Set(keys).size, keys.length, 'an ad-day was fetched twice');
    assert.equal(new Set(rows.map((r) => r.day)).size, 4);
  } finally { meta.restore(); }
});

// ── 2/3. Which copy survives, and saying so when they disagree ──────────────
await test('identical copies collapse, and the warning says they agreed', async () => {
  const meta = metaFetch({ campaigns: ['c1'] });
  const warn = captureWarnings();
  try {
    const rows = await fetchMetaAdsRows(CONN, { startDate: '2026-03-02', endDate: '2026-03-15' });
    assert.equal(rows.filter((r) => r.day === OVERRUN).length, 1);
    const line = warn.lines.find((l) => l.includes('campaign level'));
    assert.ok(line, 'a collapse must be reported');
    assert.match(line, /collapsed 1 duplicate/);
    assert.match(line, /identical metrics/);
  } finally { warn.restore(); meta.restore(); }
});

await test('copies that disagree: the chunk that CONTAINS the day wins, in both directions', async () => {
  // The stray copy of 2026-03-09 (from the chunk ending on the DST day) says
  // 99.99; the chunk that actually covers 2026-03-09 says 10.00 and must win.
  // The stray copy of 2026-03-08 arrives LATER, from the chunk starting on the
  // 9th, so "last one wins" would take it -- the containing chunk must win.
  const meta = metaFetch({
    campaigns: ['c1'],
    extraLeadingDay: true,
    spendFor: (day, _c, range) => (
      (day === OVERRUN && range.until === DST_DAY) || (day === DST_DAY && range.since === OVERRUN)
        ? '99.99' : '10.00'),
  });
  const warn = captureWarnings();
  try {
    const rows = await fetchMetaAdsRows(CONN, { startDate: '2026-03-02', endDate: '2026-03-15' });
    const spendOn = (d) => rows.find((r) => r.day === d).spend;
    assert.equal(spendOn(OVERRUN), '10.00', 'kept the stray copy of the overrun day');
    assert.equal(spendOn(DST_DAY), '10.00', 'kept the stray copy of the DST day');
    const line = warn.lines.find((l) => l.includes('campaign level'));
    assert.match(line, /collapsed 2 duplicate/);
    assert.match(line, /2 of them reported DIFFERENT metrics/);
  } finally { warn.restore(); meta.restore(); }
});

// ── 5. A day only ever seen out of range is still data ──────────────────────
await test('a day returned only outside the window is kept, not discarded', async () => {
  const meta = metaFetch({ campaigns: ['c1'] });
  try {
    // The window ENDS on the DST day, so nothing else ever asks for the 9th.
    const rows = await fetchMetaAdsRows(CONN, { startDate: '2026-03-02', endDate: DST_DAY });
    assert.equal(rows.filter((r) => r.day === OVERRUN).length, 1, 'out-of-range data must not be thrown away');
  } finally { meta.restore(); }
});

// ── 4. End to end, across several 500-row upsert batches ────────────────────
await test('runConnectionSync: 60 campaigns over 19 days, no batch repeats a row_hash', async () => {
  const campaigns = Array.from({ length: 60 }, (_, i) => `c${i + 1}`);
  const meta = metaFetch({ campaigns });
  const db = fakeSupabase();
  try {
    // Pacific "today" is 2026-03-20; 18 days back starts on 2026-03-02, so a
    // 7-day chunk ends exactly on the spring-forward day, as Süti's did.
    const res = await runConnectionSync(db.api, {}, CONN, {
      batchId: 'b1',
      now: new Date('2026-03-20T18:00:00Z'),
      daysBackOverride: 18,
    });
    assert.deepEqual(res.window, { startDate: '2026-03-02', endDate: '2026-03-20' });
    const rows = rowsFor(db.writes, 'marketing_kpis_daily');
    const days = daysBetween('2026-03-02', '2026-03-20') + 1;
    assert.equal(rows.length, days * campaigns.length, 'every campaign-day written exactly once');
    assert.ok(db.writes.filter((w) => w.table === 'marketing_kpis_daily').length >= 3,
      'the batch must be big enough to need several upsert calls');
    assert.equal(new Set(rows.map((r) => r.row_hash)).size, rows.length);
    assert.equal(rows.filter((r) => r.day_date === OVERRUN).length, campaigns.length);
  } finally { meta.restore(); }
});

// ── 6. The last line in front of any upsert ─────────────────────────────────
await test('dedupeOnConflictKey: keeps the last row of a repeated key and says so', () => {
  const warn = captureWarnings();
  try {
    const rows = [
      { row_hash: 'h1', spend: 1 },
      { row_hash: 'h2', spend: 2 },
      { row_hash: 'h1', spend: 3 },
    ];
    const out = dedupeOnConflictKey(rows, 'row_hash', 'some_table');
    assert.deepEqual(out, [{ row_hash: 'h1', spend: 3 }, { row_hash: 'h2', spend: 2 }]);
    assert.match(warn.lines.join('\n'), /1 row\(s\) shared a row_hash/);
    // Untouched when there is nothing to collapse.
    const clean = [{ row_hash: 'h1' }, { row_hash: 'h2' }];
    assert.equal(dedupeOnConflictKey(clean, 'row_hash', 'some_table'), clean);
  } finally { warn.restore(); }
});

console.log(`\n${passed} tests passed`);
