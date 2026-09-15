/* Where a Meta ad sends the customer, resolved from the creative.
 *
 * Asked for directly (Sammie, 2026-09-15): see the landing page an ad takes
 * the customer to. meta_ad_creatives stored the thumbnail, the copy, the
 * format and the status, and nothing about the destination.
 *
 * What is proven here, in order of how much it would cost to get wrong:
 *   1. The DOWNGRADE. These reads go through the Graph batch API, where a
 *      field Meta does not accept is not a thrown error -- the outer POST
 *      returns 200 and every item inside comes back non-200, which the
 *      existing loop skips silently. Without the per-item check, a bad field
 *      writes 4,000 creative rows with null links, null COPY, and no warning:
 *      indistinguishable from an account whose ads have no destinations. This
 *      is the failure that has already happened once here, on `description`
 *      in the page-post pass, and it took 100 of 113 reads down.
 *   2. Source priority, and that link_url / link_url_source are null or
 *      non-null TOGETHER. An unattributed URL cannot be told apart from a
 *      page-post URL standing in for a landing page.
 *   3. Only http(s) is stored -- the same single gate v3 puts between a
 *      stored value and an href.
 *   4. A refused link tier still returns every creative row with its copy.
 *
 * Mutations (each must make this file FAIL):
 *   META_LINK_MUTATION=no-item-check     (per-item downgrade removed)
 *   META_LINK_MUTATION=effective-first   (effective_object_url wins over link_data)
 *   META_LINK_MUTATION=no-url-guard      (any string accepted as a URL)
 *
 * No network, no database. Run:
 *   node scripts/tests/meta-creative-links.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORE = join(ROOT, 'scripts/lib/ad-platforms-sync-core.mjs');
const mutation = process.env.META_LINK_MUTATION || '';
assert.ok(['', 'no-item-check', 'effective-first', 'no-url-guard', 'tier-collapses'].includes(mutation),
  `Unknown mutation ${mutation}`);

// The module is loaded from source so a mutation can be applied to the real
// file's text rather than to a copy of the logic -- a test that re-implements
// the thing it guards proves nothing about the shipped file.
let source = readFileSync(CORE, 'utf8');
if (mutation === 'no-item-check') {
  source = source.replace(
    'if (linkTier < CREATIVE_BASE_TIER && metaBatchRejectedFields(data)) {',
    'if (false && metaBatchRejectedFields(data)) {');
} else if (mutation === 'tier-collapses') {
  // The shipped defect: one refused field drops the whole link set instead of
  // stepping down by one. This is what produced "0/126 resolved" in
  // production, so a test that does not fail here is not guarding it.
  source = source.replace('      linkTier += 1;\n        continue;\n      }\n      // The mode that matters',
                          '      linkTier = CREATIVE_BASE_TIER;\n        continue;\n      }\n      // The mode that matters');
  source = source.replace("          + `${named ? ` (field: ${named})` : ''}, stepping down`);\n        linkTier += 1;",
                          "          + `${named ? ` (field: ${named})` : ''}, stepping down`);\n        linkTier = CREATIVE_BASE_TIER;");
} else if (mutation === 'effective-first') {
  source = source.replace(
    "    ['link_data', spec.link_data?.link],",
    "    ['effective_object_url', creative?.effective_object_url],\n    ['link_data', spec.link_data?.link],");
} else if (mutation === 'no-url-guard') {
  source = source.replace(
    'if (!/^https?:\\/\\/[^\\s<>"\']+$/i.test(v)) continue;',
    'if (!v) continue;');
}
if (mutation) assert.notEqual(source, readFileSync(CORE, 'utf8'), 'mutation did not apply');
// Loaded from a temp copy rather than a data: URL, which cannot resolve the
// module's own relative imports. The sibling import is absolutized so the copy
// still binds to the REAL shopify-sync-core.
const dir = mkdtempSync(join(tmpdir(), 'meta-links-'));
const sibling = pathToFileURL(join(ROOT, 'scripts/lib/shopify-sync-core.mjs')).href;
const copy = join(dir, 'ad-platforms-sync-core.mjs');
writeFileSync(copy, source.replace("from './shopify-sync-core.mjs'", `from '${sibling}'`));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const { fetchMetaAdCreatives } = await import(pathToFileURL(copy).href);

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }

const CONNECTION = { access_token: 'tok', meta_ad_account_id: 'act_1' };

/* A fake Graph batch endpoint.
 *
 * `ads` maps ad id -> the ad object Meta would return. `rejectFields` names
 * fields that, when requested, make every item in the batch fail the way Meta
 * actually fails an unknown field: HTTP 200 on the POST, code 400 per item. */
function fakeGraph({ ads, rejectFields = [], onRequest = () => {} }) {
  const requests = [];
  globalThis.fetch = async (url, opts = {}) => {
    const body = String(opts.body || '');
    const params = new URLSearchParams(body);
    const batch = JSON.parse(params.get('batch') || '[]');
    const asked = decodeURIComponent(batch[0]?.relative_url || '');
    requests.push(asked);
    onRequest(asked);
    const refused = rejectFields.find((f) => asked.includes(f));
    const items = batch.map((b) => {
      const id = b.relative_url.split('?')[0].split('/').pop();
      if (refused) {
        return {
          code: 400,
          body: JSON.stringify({ error: {
            message: `(#100) Tried accessing nonexisting field (${refused}) on node type (AdCreative)`,
            type: 'OAuthException', code: 100,
          } }),
        };
      }
      const ad = ads[id];
      if (!ad) return { code: 404, body: JSON.stringify({ error: { message: 'not found' } }) };
      // Return only what was ASKED for. Meta does not volunteer a field that
      // was not requested, and a fake that does would make the downgrade
      // tests pass against a version that never downgraded.
      const served = { ...ad, creative: { ...(ad.creative || {}) } };
      for (const f of ['effective_object_url', 'url_tags', 'asset_feed_spec']) {
        if (!asked.includes(f)) delete served.creative[f];
      }
      return { code: 200, body: JSON.stringify(served) };
    });
    return { ok: true, status: 200, text: async () => JSON.stringify(items) };
  };
  return requests;
}

const AD = (id, creative, extra = {}) => ({
  id, name: `Ad ${id}`, effective_status: 'ACTIVE',
  campaign_id: 'c1', adset_id: 's1', creative, ...extra,
});
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.adId, r]));

await test('link_data.link is the destination for a link ad', async () => {
  fakeGraph({ ads: { 1: AD('1', {
    id: 'cr1',
    object_story_spec: { link_data: { link: 'https://baseballism.com/collections/new', message: 'hi' } },
  }) } });
  const rows = byId(await fetchMetaAdCreatives(CONNECTION, ['1']));
  assert.equal(rows['1'].linkUrl, 'https://baseballism.com/collections/new');
  assert.equal(rows['1'].linkUrlSource, 'link_data');
});

await test('a video ad resolves through its call to action', async () => {
  fakeGraph({ ads: { 1: AD('1', {
    id: 'cr1',
    object_story_spec: { video_data: {
      message: 'watch', call_to_action: { type: 'SHOP_NOW', value: { link: 'https://baseballism.com/products/tee' } },
    } },
  }) } });
  const rows = byId(await fetchMetaAdCreatives(CONNECTION, ['1']));
  assert.equal(rows['1'].linkUrl, 'https://baseballism.com/products/tee');
  assert.equal(rows['1'].linkUrlSource, 'video_cta');
});

await test('a carousel resolves to its first card that has a link', async () => {
  fakeGraph({ ads: { 1: AD('1', {
    id: 'cr1',
    object_story_spec: { link_data: { child_attachments: [
      { name: 'no link here' },
      { link: 'https://baseballism.com/collections/hats' },
      { link: 'https://baseballism.com/collections/tees' },
    ] } },
  }) } });
  const rows = byId(await fetchMetaAdCreatives(CONNECTION, ['1']));
  assert.equal(rows['1'].linkUrl, 'https://baseballism.com/collections/hats');
  assert.equal(rows['1'].linkUrlSource, 'carousel_card');
});

await test('a SHARE ad falls back to effective_object_url', async () => {
  // 63% of this account. Without this source the feature covers a third of
  // the ads and reads as "most of our ads go nowhere".
  fakeGraph({ ads: { 1: AD('1', {
    id: 'cr1', object_type: 'SHARE',
    effective_object_story_id: '123_456',
    effective_object_url: 'https://baseballism.com/collections/sale',
  }) } });
  const rows = byId(await fetchMetaAdCreatives(CONNECTION, ['1']));
  assert.equal(rows['1'].linkUrl, 'https://baseballism.com/collections/sale');
  assert.equal(rows['1'].linkUrlSource, 'effective_object_url');
});

await test('the advertiser\'s own link outranks the resolved destination', async () => {
  // effective_object_url is LAST on purpose: on a page-post ad Meta may
  // resolve it to the post. Where the ad carries its own link, that wins.
  fakeGraph({ ads: { 1: AD('1', {
    id: 'cr1',
    object_story_spec: { link_data: { link: 'https://baseballism.com/real-destination' } },
    effective_object_url: 'https://www.facebook.com/123/posts/456',
  }) } });
  const rows = byId(await fetchMetaAdCreatives(CONNECTION, ['1']));
  assert.equal(rows['1'].linkUrl, 'https://baseballism.com/real-destination');
  assert.equal(rows['1'].linkUrlSource, 'link_data');
});

await test('a non-http destination is stored as no destination', async () => {
  for (const bad of ['fb://profile/123', 'javascript:alert(1)', '//evil.example.com',
                     'https://a b.com/x', 'data:text/html,<script>']) {
    fakeGraph({ ads: { 1: AD('1', { id: 'cr1', object_story_spec: { link_data: { link: bad } } }) } });
    const rows = byId(await fetchMetaAdCreatives(CONNECTION, ['1']));
    assert.equal(rows['1'].linkUrl, null, `${bad} must not be stored`);
    assert.equal(rows['1'].linkUrlSource, null, `${bad} must not carry a source`);
  }
});

await test('url and source are null or non-null together, always', async () => {
  fakeGraph({ ads: {
    1: AD('1', { id: 'a', object_story_spec: { link_data: { link: 'https://baseballism.com/x' } } }),
    2: AD('2', { id: 'b', object_story_spec: {} }),
    3: AD('3', { id: 'c', object_story_spec: { link_data: { link: 'notaurl' } } }),
  } });
  const rows = await fetchMetaAdCreatives(CONNECTION, ['1', '2', '3']);
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.linkUrl == null, r.linkUrlSource == null,
      `${r.adId}: url ${r.linkUrl} vs source ${r.linkUrlSource}`);
  }
});

await test('url_tags rides along, unparsed', async () => {
  fakeGraph({ ads: { 1: AD('1', {
    id: 'cr1',
    object_story_spec: { link_data: { link: 'https://baseballism.com/x' } },
    url_tags: 'utm_source=facebook&utm_medium=paid&utm_campaign=bts',
  }) } });
  const rows = byId(await fetchMetaAdCreatives(CONNECTION, ['1']));
  assert.equal(rows['1'].linkUrlTags, 'utm_source=facebook&utm_medium=paid&utm_campaign=bts');
});

await test('a refused link field downgrades and KEEPS every creative row', async () => {
  // The whole point. 200 outside, 400 on every item inside. The old loop
  // skipped those silently, so without the per-item check this would have
  // written a full set of rows with no copy and no links, warning about
  // nothing.
  const asked = fakeGraph({
    ads: { 1: AD('1', { id: 'cr1', body: 'real copy',
      object_story_spec: { link_data: { link: 'https://baseballism.com/x' } } }) },
    rejectFields: ['asset_feed_spec'],
  });
  const rows = byId(await fetchMetaAdCreatives(CONNECTION, ['1']));
  assert.equal(rows['1'].body, 'real copy', 'copy must survive a refused link tier');
  assert.ok(asked.length >= 2, 'the batch must be retried without the link fields');
  assert.ok(asked[0].includes('asset_feed_spec'), 'first attempt asks for the link tier');
  assert.ok(!asked[asked.length - 1].includes('asset_feed_spec'), 'retry drops the link tier');
  assert.ok(asked[asked.length - 1].includes('object_story_spec'), 'retry keeps the base tier');
});

await test('A REFUSED asset_feed_spec MUST NOT COST effective_object_url', async () => {
  // THE PRODUCTION FAILURE, 2026-09-15, first real run:
  //   [meta] creative links: 0/126 resolved (none) — link fields REFUSED
  //
  // The first version put effective_object_url, url_tags and
  // asset_feed_spec{link_urls} in ONE tier. Meta refused the set, the code
  // dropped all three, and the field 63% of this account depends on went with
  // the one field that was actually unacceptable. Zero of 126 ads resolved a
  // destination -- the feature did nothing at all.
  //
  // Stepping down ONE tier at a time is the fix, and this is its guard.
  const asked = fakeGraph({
    ads: { 1: AD('1', {
      id: 'cr1', object_type: 'SHARE',
      effective_object_url: 'https://baseballism.com/collections/sale',
    }) },
    rejectFields: ['asset_feed_spec'],
  });
  const rows = byId(await fetchMetaAdCreatives(CONNECTION, ['1']));
  assert.equal(rows['1'].linkUrl, 'https://baseballism.com/collections/sale',
    'a page-post ad must still resolve after asset_feed_spec is refused');
  assert.equal(rows['1'].linkUrlSource, 'effective_object_url');
  const last = asked[asked.length - 1];
  assert.ok(!last.includes('asset_feed_spec'), 'the refused field is dropped');
  assert.ok(last.includes('effective_object_url'), 'the field that matters is NOT dropped with it');
});

await test('object_url answers when effective_object_url is the refused one', async () => {
  // Which of the two a given API version accepts is not knowable from here,
  // so both are asked for and the tiers drop them separately.
  const asked = fakeGraph({
    ads: { 1: AD('1', { id: 'cr1', object_type: 'SHARE',
      object_url: 'https://baseballism.com/collections/tees' }) },
    rejectFields: ['effective_object_url'],
  });
  const rows = byId(await fetchMetaAdCreatives(CONNECTION, ['1']));
  assert.equal(rows['1'].linkUrl, 'https://baseballism.com/collections/tees');
  assert.equal(rows['1'].linkUrlSource, 'object_url');
  assert.ok(asked[asked.length - 1].includes('object_url'), 'object_url survives');
});

await test('the run walks down ONE tier per refusal, not straight to the base', async () => {
  const asked = fakeGraph({
    ads: { 1: AD('1', { id: 'cr1', object_type: 'SHARE',
      url_tags: 'utm_campaign=x' }) },
    rejectFields: ['asset_feed_spec', 'effective_object_url', 'object_url'],
  });
  await fetchMetaAdCreatives(CONNECTION, ['1']);
  // Four attempts: all -> minus asset_feed -> minus effective -> minus object.
  assert.ok(asked.length >= 4, `expected a stepped walk, saw ${asked.length} attempts`);
  const last = asked[asked.length - 1];
  assert.ok(last.includes('url_tags'), 'url_tags is kept: it was never the refused field');
  for (const f of ['asset_feed_spec', 'effective_object_url', 'object_url']) {
    assert.ok(!last.includes(f), `${f} should have been dropped`);
  }
});

await test('the downgrade is PARTIAL: spec links survive, the SHARE fallback does not', async () => {
  // Found by writing the test above, and worth pinning rather than
  // discovering again later. object_story_spec is in the BASE tier -- it was
  // already fetched for copy -- so an ad carrying its own link still resolves
  // one after a refusal. Only effective_object_url/url_tags/asset_feed_spec
  // are lost, which is precisely the 63% of this account that is SHARE.
  //
  // So "links refused" is not "no links": it is a coverage collapse onto one
  // ad shape. The run's log line says REFUSED for exactly this reason -- the
  // resulting table looks like a working sync with a strange distribution.
  fakeGraph({
    ads: {
      1: AD('1', { id: 'a', object_story_spec: { link_data: { link: 'https://baseballism.com/x' } } }),
      2: AD('2', { id: 'b', object_type: 'SHARE', effective_object_url: 'https://baseballism.com/y' }),
    },
    // Every link-tier field refused, so the run bottoms out at the base tier.
    rejectFields: ['asset_feed_spec', 'effective_object_url', 'object_url', 'url_tags'],
  });
  const rows = byId(await fetchMetaAdCreatives(CONNECTION, ['1', '2']));
  assert.equal(rows['1'].linkUrl, 'https://baseballism.com/x', 'a spec link still resolves');
  assert.equal(rows['1'].linkUrlSource, 'link_data');
  assert.equal(rows['2'].linkUrl, null, 'the SHARE fallback is gone with the tier');
  assert.equal(rows['2'].linkUrlSource, null);
});

await test('the downgrade holds for the rest of the run', async () => {
  // 120 ads = three batches. Re-asking for a field Meta has already refused
  // costs a wasted round trip per batch and, worse, makes coverage depend on
  // batch order.
  const ads = {};
  for (let i = 1; i <= 120; i++) ads[i] = AD(String(i), { id: `cr${i}`, body: `copy ${i}` });
  const asked = fakeGraph({ ads, rejectFields: ['asset_feed_spec'] });
  const rows = await fetchMetaAdCreatives(CONNECTION, Object.keys(ads));
  assert.equal(rows.length, 120, 'every ad still returns a row');
  const withRefused = asked.filter((a) => a.includes('asset_feed_spec'));
  assert.equal(withRefused.length, 1, `refused field re-requested ${withRefused.length} times`);
  // And every later batch still asks for the tier BELOW it, not the base.
  assert.ok(asked[asked.length - 1].includes('effective_object_url'),
    'the run must settle one tier down, not collapse to base');
});

await test('an ordinary per-item failure does NOT downgrade the field set', async () => {
  // A deleted ad or a permission error on one creative is normal. Treating
  // it as a refused field would silently drop links for the whole run.
  const asked = fakeGraph({ ads: {
    1: AD('1', { id: 'cr1', object_story_spec: { link_data: { link: 'https://baseballism.com/x' } } }),
    // id 2 is absent -> the fake returns 404 for it, like a deleted ad
  } });
  const rows = byId(await fetchMetaAdCreatives(CONNECTION, ['1', '2']));
  assert.equal(rows['1'].linkUrl, 'https://baseballism.com/x');
  assert.equal(asked.length, 1, 'no retry for an ordinary item failure');
});

// ── the integrated path, which is where this kind of change actually breaks ──
// Everything above exercises fetchMetaAdCreatives. NOTHING above proves the
// orchestrator carries its output to the database -- and a helper passing in
// isolation while its five calling lines have no coverage is exactly the state
// in which a temporal-dead-zone reference shipped here in 2026-09. So this
// drives the real runMetaAdLevelSync with a fake Meta and a fake Supabase and
// reads what would have been WRITTEN.
const { runMetaAdLevelSync } = await import(pathToFileURL(copy).href);

function fakeSupabase() {
  const writes = {};
  return {
    writes,
    from(table) {
      return { upsert: async (rows) => {
        (writes[table] ||= []).push(...rows);
        return { error: null };
      } };
    },
  };
}

/** Insights first (the ad-level spend rows), then the creative batch. */
function fakeMetaForSync({ ads, insights }) {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/insights?')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: insights }) };
    }
    const params = new URLSearchParams(String(opts.body || ''));
    const batch = JSON.parse(params.get('batch') || '[]');
    const asked = decodeURIComponent(batch[0]?.relative_url || '');
    const items = batch.map((b) => {
      const id = b.relative_url.split('?')[0].split('/').pop();
      const ad = ads[id];
      if (!ad) return { code: 404, body: JSON.stringify({ error: { message: 'not found' } }) };
      const served = { ...ad, creative: { ...(ad.creative || {}) } };
      for (const f of ['effective_object_url', 'url_tags', 'asset_feed_spec']) {
        if (!asked.includes(f)) delete served.creative[f];
      }
      return { code: 200, body: JSON.stringify(served) };
    });
    return { ok: true, status: 200, text: async () => JSON.stringify(items) };
  };
}

await test('runMetaAdLevelSync writes the destination onto the creative row', async () => {
  fakeMetaForSync({
    insights: [{ account_id: 'act_1', date_start: '2026-09-14', campaign_id: 'c1',
      campaign_name: 'Purchase', adset_id: 's1', adset_name: 'Prospecting',
      ad_id: '1', ad_name: 'Linked ad', impressions: '1000', clicks: '50', spend: '100.00' }],
    ads: { 1: AD('1', {
      id: 'cr1', body: 'copy',
      object_story_spec: { link_data: { link: 'https://baseballism.com/collections/bts' } },
      url_tags: 'utm_campaign=bts',
    }) },
  });
  const sb = fakeSupabase();
  const res = await runMetaAdLevelSync(sb, {
    id: 'conn', company_entity_id: 'co', access_token: 'tok',
    meta_ad_account_id: 'act_1', days_back: 1,
  }, { batchId: 'b1' });

  const row = (sb.writes.meta_ad_creatives || [])[0];
  assert.ok(row, 'no creative row was written at all');
  assert.equal(row.link_url, 'https://baseballism.com/collections/bts');
  assert.equal(row.link_url_source, 'link_data');
  assert.equal(row.link_url_tags, 'utm_campaign=bts');
  assert.equal(row.company_entity_id, 'co');
  assert.equal(res.creatives_upserted, 1);
});

await test('the written row never carries a url without its source', async () => {
  fakeMetaForSync({
    insights: [
      { account_id: 'act_1', date_start: '2026-09-14', ad_id: '1', ad_name: 'a', spend: '1' },
      { account_id: 'act_1', date_start: '2026-09-14', ad_id: '2', ad_name: 'b', spend: '1' },
    ],
    ads: {
      1: AD('1', { id: 'a', object_story_spec: { link_data: { link: 'https://baseballism.com/x' } } }),
      2: AD('2', { id: 'b', object_story_spec: { link_data: { link: 'mailto:someone@example.com' } } }),
    },
  });
  const sb = fakeSupabase();
  await runMetaAdLevelSync(sb, {
    id: 'conn', company_entity_id: 'co', access_token: 'tok',
    meta_ad_account_id: 'act_1', days_back: 1,
  }, { batchId: 'b1' });
  const rows = sb.writes.meta_ad_creatives || [];
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.link_url == null, r.link_url_source == null,
      `${r.ad_id}: ${r.link_url} / ${r.link_url_source}`);
  }
  // The database constraint would reject the other case, which is a failed
  // sync rather than a wrong number -- but failing the nightly is still a
  // failure, so the payload must be right before it gets there.
});

console.log(`\n${passed} assertions passed${mutation ? ` (mutation: ${mutation})` : ''}`);
