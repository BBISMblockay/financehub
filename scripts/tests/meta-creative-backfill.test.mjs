/* The Meta creative destination backfill.
 *
 * WHY IT EXISTS. The nightly asks Meta about creatives only for ad ids with
 * insights rows in its trailing window (days_back ?? 30). Measured on
 * production 2026-09-16: 126 of 4,079 stored creatives had ever been asked
 * about, 82 resolved, and $5,304,686 of SHARE spend sat on ads never
 * requested. This backfill reaches them.
 *
 * What is proven here, in order of how much it would cost to get wrong:
 *   1. IT ONLY EVER ADDS. Re-asking about an ad Meta now answers with no
 *      link must not blank a destination the nightly already resolved, and a
 *      failed page-post pass must not blank recovered copy. A backfill that
 *      DELETES data is far worse than one that misses some -- and the same
 *      mistake is easy to make twice, because the nightly legitimately
 *      writes whole rows.
 *   2. A chunk is WRITTEN before the next is fetched, and a mid-run failure
 *      keeps everything already written while reporting how far it got.
 *      Otherwise a rate-limit on ad 3,900 throws away 3,899 ads of work.
 *   3. An ad with no row yet gets a FULL row -- a partial insert would leave
 *      ad_name/object_type null forever, since the nightly will never
 *      revisit an ad outside its window either.
 *   4. Account discovery is strictly ADDITIVE: a listing failure falls back
 *      to stored ids rather than losing the backfill.
 *
 * Mutations (each must make this file FAIL):
 *   META_BF_MUTATION=blanks-links    (writes unresolved links over stored ones)
 *   META_BF_MUTATION=blanks-bodies   (writes null copy back)
 *   META_BF_MUTATION=batch-at-end    (all writes deferred to the end of the run)
 *   META_BF_MUTATION=discover-throws (a listing failure kills the run)
 *   META_BF_MUTATION=silent-truncation (the page ceiling truncates without a word)
 *
 * No network, no database. Run:
 *   node scripts/tests/meta-creative-backfill.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORE = join(ROOT, 'scripts/lib/ad-platforms-sync-core.mjs');
const mutation = process.env.META_BF_MUTATION || '';
assert.ok(['', 'blanks-links', 'blanks-bodies', 'batch-at-end', 'discover-throws', 'silent-truncation'].includes(mutation),
  `Unknown mutation ${mutation}`);

let source = readFileSync(CORE, 'utf8');
if (mutation === 'blanks-links') {
  // Rule 1 removed: every returned ad's link is written, resolved or not.
  source = source.replace(
    '.filter((c) => knownIds.has(String(c.adId)) && c.linkUrl)',
    '.filter((c) => knownIds.has(String(c.adId)))');
} else if (mutation === 'blanks-bodies') {
  source = source.replace(
    '.filter((c) => knownIds.has(String(c.adId)) && c.body)',
    '.filter((c) => knownIds.has(String(c.adId)))');
} else if (mutation === 'batch-at-end') {
  // EVERY write deferred to the end of the run, which is the tempting shape
  // (one big upsert, fewer round trips) and the one that loses 3,899 ads of
  // work when ad 3,900 rate-limits. Deferring only SOME writes would leave
  // the interleaving intact and prove nothing, so all three column sets go.
  const defer = (rowsVar, counter) => {
    const before = `      if (${rowsVar}.length) {\n        result.${counter} += await upsertInChunks(\n`
      + `          supabase, 'meta_ad_creatives', ${rowsVar}, 'company_entity_id,ad_id');\n      }`;
    assert.ok(source.includes(before), `mutation hook missing for ${rowsVar}`);
    source = source.replace(before,
      `      if (${rowsVar}.length) { __deferred.push(${rowsVar}); result.${counter} += ${rowsVar}.length; }`);
  };
  defer('newRows', 'new_creative_rows');
  defer('linkRows', 'link_rows_written');
  defer('bodyRows', 'body_rows_written');
  source = source.replace(
    '  const ids = [...new Set((adIds || []).map(String))];\n  const chunksPlanned',
    '  const __deferred = [];\n  const ids = [...new Set((adIds || []).map(String))];\n  const chunksPlanned');
  source = source.replace(
    '  return result;\n}',
    '  for (const rows of __deferred) await upsertInChunks(supabase, \'meta_ad_creatives\', rows, \'company_entity_id,ad_id\');\n  return result;\n}');
} else if (mutation === 'silent-truncation') {
  // The page ceiling stops the walk without a word -- a backfill reporting
  // success over a fraction of the account.
  source = source.replace('    if (url) {\n      console.warn(', '    if (false) {\n      console.warn(');
} else if (mutation === 'discover-throws') {
  source = source.replace(
    "    console.warn(`[warn] Meta account ad listing failed, backfilling stored ids only: ${err.message || err}`);\n    return null;",
    '    throw err;');
}
if (mutation) assert.notEqual(source, readFileSync(CORE, 'utf8'), 'mutation did not apply');

const dir = mkdtempSync(join(tmpdir(), 'meta-bf-'));
const sibling = pathToFileURL(join(ROOT, 'scripts/lib/shopify-sync-core.mjs')).href;
const copy = join(dir, 'ad-platforms-sync-core.mjs');
writeFileSync(copy, source.replace("from './shopify-sync-core.mjs'", `from '${sibling}'`));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const { runMetaCreativeBackfill, fetchMetaAccountAdIds } = await import(pathToFileURL(copy).href);

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }

const CONNECTION = {
  access_token: 'tok', meta_ad_account_id: 'act_1',
  company_entity_id: 'co-1', display_name: 'Meta',
};

/** Records every upsert, in order, so a test can assert both WHAT was written
 *  and WHEN relative to the fetches. */
function fakeSupabase({ failOnCall = null } = {}) {
  const writes = [];
  let calls = 0;
  return {
    writes,
    from(table) {
      return {
        upsert: async (rows) => {
          calls += 1;
          if (failOnCall === calls) return { error: { message: 'boom' } };
          writes.push({ table, rows });
          return { error: null };
        },
      };
    },
  };
}

/** A fake Graph batch endpoint returning the given ads, plus a fetch counter
 *  so ordering of fetch vs. write is observable. */
function fakeGraph({ ads, onBatch = () => {}, failBatch = null, listPages = null }) {
  let batchNo = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    // Account ad listing (GET, no batch body).
    if (u.includes('/ads?') && !opts.body) {
      if (listPages === 'fail') {
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'too big', code: 1487 } }) };
      }
      const page = Number(new URL(u).searchParams.get('__page') || 0);
      const pages = listPages || [];
      const body = { data: (pages[page] || []).map((id) => ({ id })) };
      if (page + 1 < pages.length) {
        body.paging = { next: `${u.split('?')[0]}?__page=${page + 1}&access_token=t` };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    }
    const params = new URLSearchParams(String(opts.body || ''));
    const batch = JSON.parse(params.get('batch') || '[]');
    batchNo += 1;
    onBatch(batchNo);
    if (failBatch === batchNo) {
      return { ok: false, status: 500, text: async () => JSON.stringify({ error: { message: 'rate limited', code: 99 } }) };
    }
    const items = batch.map((b) => {
      const id = b.relative_url.split('?')[0].split('/').pop();
      const ad = ads[id];
      if (!ad) return { code: 404, body: JSON.stringify({ error: { message: 'not found' } }) };
      return { code: 200, body: JSON.stringify(ad) };
    });
    return { ok: true, status: 200, text: async () => JSON.stringify(items) };
  };
}

const adWithLink = (id, url) => ({
  id, name: `ad ${id}`, campaign_id: 'c1', adset_id: 's1', effective_status: 'ACTIVE',
  creative: {
    id: `cr${id}`, object_type: 'SHARE', body: 'copy',
    asset_feed_spec: { link_urls: [{ website_url: url }] },
  },
});
const adNoLink = (id, { body = null } = {}) => ({
  id, name: `ad ${id}`, campaign_id: 'c1', adset_id: 's1', effective_status: 'PAUSED',
  creative: { id: `cr${id}`, object_type: 'VIDEO', body },
});

const rowsFor = (db, adId) => db.writes.flatMap((w) => w.rows).filter((r) => r.ad_id === adId);

// ── 1. It only ever adds ────────────────────────────────────────────────────

await test('an ad that resolves no link is never written back over a stored one', async () => {
  fakeGraph({ ads: { a1: adNoLink('a1') } });
  const db = fakeSupabase();
  await runMetaCreativeBackfill(db, CONNECTION, {
    adIds: ['a1'], knownIds: new Set(['a1']), chunkSize: 50,
  });
  const written = rowsFor(db, 'a1');
  assert.equal(written.filter((r) => 'link_url' in r).length, 0,
    'an unresolved link must not be written onto an existing row');
});

await test('a resolved link IS written onto an existing row, with its source', async () => {
  fakeGraph({ ads: { a1: adWithLink('a1', 'https://www.baseballism.com/collections/sale') } });
  const db = fakeSupabase();
  const r = await runMetaCreativeBackfill(db, CONNECTION, {
    adIds: ['a1'], knownIds: new Set(['a1']), chunkSize: 50,
  });
  const linkRow = rowsFor(db, 'a1').find((x) => 'link_url' in x);
  assert.ok(linkRow, 'a resolved link must be written');
  assert.equal(linkRow.link_url, 'https://www.baseballism.com/collections/sale');
  assert.equal(linkRow.link_url_source, 'asset_feed');
  assert.equal(r.links_resolved, 1);
});

await test('link_url and link_url_source are written as a pair, never one alone', async () => {
  fakeGraph({ ads: { a1: adWithLink('a1', 'https://www.baseballism.com/x') } });
  const db = fakeSupabase();
  await runMetaCreativeBackfill(db, CONNECTION, {
    adIds: ['a1'], knownIds: new Set(['a1']), chunkSize: 50,
  });
  for (const row of db.writes.flatMap((w) => w.rows)) {
    if ('link_url' in row || 'link_url_source' in row) {
      assert.equal(row.link_url == null, row.link_url_source == null,
        'link_url and link_url_source must be null or non-null together');
    }
  }
});

await test('copy that came back null is never written back over stored copy', async () => {
  fakeGraph({ ads: { a1: adNoLink('a1', { body: null }) } });
  const db = fakeSupabase();
  await runMetaCreativeBackfill(db, CONNECTION, {
    adIds: ['a1'], knownIds: new Set(['a1']), chunkSize: 50,
  });
  const bodyWrites = rowsFor(db, 'a1').filter((r) => 'body' in r);
  assert.equal(bodyWrites.length, 0, 'a null body must not be written onto an existing row');
});

await test('recovered copy IS written back', async () => {
  fakeGraph({ ads: { a1: adNoLink('a1', { body: 'recovered words' }) } });
  const db = fakeSupabase();
  const r = await runMetaCreativeBackfill(db, CONNECTION, {
    adIds: ['a1'], knownIds: new Set(['a1']), chunkSize: 50,
  });
  const bodyRow = rowsFor(db, 'a1').find((x) => 'body' in x);
  assert.equal(bodyRow.body, 'recovered words');
  assert.equal(r.body_rows_written, 1);
});

// ── 2. Chunk durability ─────────────────────────────────────────────────────

await test('each chunk is written before the next is fetched', async () => {
  const order = [];
  fakeGraph({
    ads: { a1: adWithLink('a1', 'https://x.com/1'), a2: adWithLink('a2', 'https://x.com/2') },
    onBatch: (n) => order.push(`fetch${n}`),
  });
  const db = fakeSupabase();
  const origFrom = db.from.bind(db);
  db.from = (t) => ({ upsert: async (rows) => { order.push('write'); return origFrom(t).upsert(rows); } });
  await runMetaCreativeBackfill(db, CONNECTION, {
    adIds: ['a1', 'a2'], knownIds: new Set(['a1', 'a2']), chunkSize: 1,
  });
  // Collapsed: one chunk legitimately issues several upserts (links, bodies,
  // new rows are separate column sets and so separate statements). What must
  // hold is that ALL of a chunk's writes land before the next fetch.
  const shape = order.filter((step, i) => step !== order[i - 1]);
  assert.deepEqual(shape, ['fetch1', 'write', 'fetch2', 'write'],
    'a chunk must be durable before the next is fetched');
});

await test('a mid-run failure keeps what landed and reports how far it got', async () => {
  fakeGraph({
    ads: { a1: adWithLink('a1', 'https://x.com/1'), a2: adWithLink('a2', 'https://x.com/2') },
    failBatch: 2,
  });
  const db = fakeSupabase();
  const r = await runMetaCreativeBackfill(db, CONNECTION, {
    adIds: ['a1', 'a2'], knownIds: new Set(['a1', 'a2']), chunkSize: 1,
  });
  assert.equal(r.chunks_completed, 1, 'chunk 1 completed');
  assert.equal(r.chunks_planned, 2);
  assert.ok(r.failed, 'the failure is reported, not swallowed');
  assert.equal(r.failed.chunk, 2);
  assert.equal(rowsFor(db, 'a1').length > 0, true, 'chunk 1 rows stay written');
});

// ── 3. Unknown ads get a full row ───────────────────────────────────────────

await test('an ad with no stored row gets a FULL row, not a partial one', async () => {
  fakeGraph({ ads: { new1: adWithLink('new1', 'https://www.baseballism.com/new') } });
  const db = fakeSupabase();
  const r = await runMetaCreativeBackfill(db, CONNECTION, {
    adIds: ['new1'], knownIds: new Set(), chunkSize: 50,
  });
  const row = rowsFor(db, 'new1')[0];
  for (const col of ['ad_name', 'object_type', 'campaign_id', 'adset_id', 'creative_id',
    'effective_status', 'link_url', 'body', 'company_entity_id', 'synced_at']) {
    assert.ok(col in row, `a new row must carry ${col}`);
  }
  assert.equal(row.object_type, 'SHARE');
  assert.equal(r.new_creative_rows, 1);
});

await test('a returned preview IS written onto an existing row; a missing one is not', async () => {
  fakeGraph({ ads: {
    a1: { ...adNoLink('a1'), preview_shareable_link: 'https://fb.me/a1' },
    a2: adNoLink('a2'),
  } });
  const db = fakeSupabase();
  const r = await runMetaCreativeBackfill(db, CONNECTION, {
    adIds: ['a1', 'a2'], knownIds: new Set(['a1', 'a2']), chunkSize: 50,
  });
  const p1 = rowsFor(db, 'a1').filter((x) => 'preview_shareable_link' in x);
  assert.deepEqual(p1.map((x) => x.preview_shareable_link), ['https://fb.me/a1']);
  assert.equal(rowsFor(db, 'a2').filter((x) => 'preview_shareable_link' in x).length, 0,
    'no preview came back, so nothing may be written over a stored one');
  assert.equal(r.preview_rows_written, 1);
  assert.equal(r.previews_returned, 1);
});

await test('a brand-new row carries its preview', async () => {
  fakeGraph({ ads: { new1: { ...adWithLink('new1', 'https://www.baseballism.com/new'),
    preview_shareable_link: 'https://fb.me/new1' } } });
  const db = fakeSupabase();
  await runMetaCreativeBackfill(db, CONNECTION, {
    adIds: ['new1'], knownIds: new Set(), chunkSize: 50,
  });
  assert.equal(rowsFor(db, 'new1')[0].preview_shareable_link, 'https://fb.me/new1');
});

await test('a deleted ad (per-item 404) is skipped without failing the chunk', async () => {
  fakeGraph({ ads: { a1: adWithLink('a1', 'https://x.com/1') } });
  const db = fakeSupabase();
  const r = await runMetaCreativeBackfill(db, CONNECTION, {
    adIds: ['a1', 'gone'], knownIds: new Set(['a1', 'gone']), chunkSize: 50,
  });
  assert.equal(r.failed, null, 'one dead ad must not fail the chunk');
  assert.equal(r.ads_returned, 1);
  assert.equal(r.links_resolved, 1);
});

// ── 4. Discovery is additive ────────────────────────────────────────────────

await test('account discovery pages through every ad id', async () => {
  fakeGraph({ ads: {}, listPages: [['x1', 'x2'], ['x3']] });
  const ids = await fetchMetaAccountAdIds(CONNECTION, { pageSize: 2 });
  assert.deepEqual(ids, ['x1', 'x2', 'x3']);
});

await test('a failed account listing returns null rather than throwing', async () => {
  fakeGraph({ ads: {}, listPages: 'fail' });
  const ids = await fetchMetaAccountAdIds(CONNECTION);
  assert.equal(ids, null, 'discovery must degrade, not kill the backfill');
});

await test('discovery de-duplicates ids', async () => {
  fakeGraph({ ads: {}, listPages: [['x1', 'x1'], ['x1', 'x2']] });
  const ids = await fetchMetaAccountAdIds(CONNECTION, { pageSize: 2 });
  assert.deepEqual(ids, ['x1', 'x2']);
});

await test('hitting the page ceiling is reported, never silent', async () => {
  // Three pages available, a ceiling of two: the walk stops short and must
  // SAY so. A listing that truncates quietly is how a backfill reports
  // success over a fraction of the account.
  fakeGraph({ ads: {}, listPages: [['p1'], ['p2'], ['p3']] });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const ids = await fetchMetaAccountAdIds(CONNECTION, { pageSize: 1, maxPages: 2 });
    assert.deepEqual(ids, ['p1', 'p2'], 'what was collected is still returned');
    assert.ok(warnings.some((w) => /ceiling/i.test(w)),
      'stopping at the page ceiling must warn');
  } finally { console.warn = realWarn; }
});

await test('a complete walk does NOT warn about the ceiling', async () => {
  fakeGraph({ ads: {}, listPages: [['p1'], ['p2']] });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    await fetchMetaAccountAdIds(CONNECTION, { pageSize: 1, maxPages: 50 });
    assert.equal(warnings.filter((w) => /ceiling/i.test(w)).length, 0,
      'a walk that finished must not claim truncation');
  } finally { console.warn = realWarn; }
});

await test('a connection with no ad account id discovers nothing, quietly', async () => {
  fakeGraph({ ads: {} });
  const ids = await fetchMetaAccountAdIds({ access_token: 't' });
  assert.equal(ids, null);
});

// ── Bookkeeping ─────────────────────────────────────────────────────────────

await test('ads are de-duplicated before any request is made', async () => {
  let batches = 0;
  fakeGraph({ ads: { a1: adWithLink('a1', 'https://x.com/1') }, onBatch: () => { batches += 1; } });
  const db = fakeSupabase();
  const r = await runMetaCreativeBackfill(db, CONNECTION, {
    adIds: ['a1', 'a1', 'a1'], knownIds: new Set(['a1']), chunkSize: 50,
  });
  assert.equal(r.ads_requested, 1);
  assert.equal(batches, 1);
});

await test('an empty candidate set does no work at all', async () => {
  let batches = 0;
  fakeGraph({ ads: {}, onBatch: () => { batches += 1; } });
  const db = fakeSupabase();
  const r = await runMetaCreativeBackfill(db, CONNECTION, { adIds: [], knownIds: new Set() });
  assert.equal(batches, 0);
  assert.equal(db.writes.length, 0);
  assert.equal(r.chunks_planned, 0);
  assert.equal(r.failed, null);
});

console.log(`\n${passed} assertions passed`);
