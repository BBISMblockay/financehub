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
 *   META_LINK_MUTATION=effective-first   (asset_feed wins over the ad's own link_data)
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
assert.ok(['', 'no-item-check', 'effective-first', 'no-url-guard', 'drops-by-order'].includes(mutation),
  `Unknown mutation ${mutation}`);

// The module is loaded from source so a mutation can be applied to the real
// file's text rather than to a copy of the logic -- a test that re-implements
// the thing it guards proves nothing about the shipped file.
let source = readFileSync(CORE, 'utf8');
if (mutation === 'no-item-check') {
  source = source.replace(
    'if (activeFields.size && metaBatchRejectedFields(data)) {',
    'if (false && metaBatchRejectedFields(data)) {');
} else if (mutation === 'drops-by-order') {
  // The defect cycle 1 of #709 found: the field Meta NAMES is parsed and then
  // ignored, and a fixed order decides what goes. That is how a refusal of
  // object_url cost asset_feed_spec, which Meta was happy to serve.
  source = source.replace(
    '  const key = normalizeRefusedField(named);\n  if (key && active.has(key)) { active.delete(key); return key; }',
    '  const key = null;\n  if (key && active.has(key)) { active.delete(key); return key; }');
} else if (mutation === 'effective-first') {
  // A resolved destination (asset_feed) placed ABOVE the link the advertiser
  // typed on the ad. The ordering is the whole design of resolveCreativeLink.
  source = source.replace(
    "    ['link_data', spec.link_data?.link],",
    "    ['asset_feed', creative?.asset_feed_spec?.link_urls?.[0]?.website_url],\n    ['link_data', spec.link_data?.link],");
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
/** Mirrors CREATIVE_OPTIONAL_FIELDS: what an unnamed refusal can still narrow. */
const CREATIVE_OPTIONALS = ['object_url', 'url_tags', 'asset_feed_spec'];

/* Which optional fields a request actually asked for, matched as WHOLE tokens.
 *
 * Substring matching is wrong here and quietly so: 'effective_object_url'
 * CONTAINS 'object_url', so a fake testing `asked.includes('object_url')` goes
 * on refusing after object_url has been dropped, and only stops once
 * effective_object_url goes too. That made a passing test out of the exact
 * ladder behaviour this suite exists to reject. A field is delimited by ',',
 * '{' or '}' in the Graph field list, so the boundaries are explicit. */
const requestedOptionals = (asked) => new Set(
  CREATIVE_OPTIONALS.filter((f) => asksFor(asked, f)));
/** Whole-token test for one field in a Graph field list. Assertions need this
 *  as much as the fake does, for the same 'effective_object_url' reason. */
const asksFor = (asked, field) => new RegExp(`[,{]${field}[,}{]`).test(asked);

/* A fake Graph batch endpoint.
 *
 * `ads` maps ad id -> the ad object Meta would return. `rejectFields` names
 * fields that, when requested, make every item in the batch fail the way Meta
 * actually fails an unknown field: HTTP 200 on the POST, code 400 per item. */
function fakeGraph({ ads, rejectFields = [], rejectMessage = null, onRequest = () => {} }) {
  const requests = [];
  globalThis.fetch = async (url, opts = {}) => {
    const body = String(opts.body || '');
    const params = new URLSearchParams(body);
    const batch = JSON.parse(params.get('batch') || '[]');
    const asked = decodeURIComponent(batch[0]?.relative_url || '');
    requests.push(asked);
    onRequest(asked);
    const present = requestedOptionals(asked);
    // A refusal is always caused by ONE field being present -- rejectMessage
    // only changes whether the error NAMES it. A fake that refuses while any
    // optional field is present is not modelling Meta, it is modelling a
    // request that can never succeed.
    // link_urls is only reachable through asset_feed_spec's nested selection.
    const refused = rejectFields.find((f) => present.has(f)
      || (f === 'link_urls' && present.has('asset_feed_spec')));
    const items = batch.map((b) => {
      const id = b.relative_url.split('?')[0].split('/').pop();
      if (refused) {
        return {
          code: 400,
          body: JSON.stringify({ error: {
            message: rejectMessage
              || `(#100) Tried accessing nonexisting field (${refused}) on node type (AdCreative)`,
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
      // object_url belongs in this list: without it the fake serves a field the
      // request never asked for, and a test can then pass against code that
      // never requested it.
      for (const f of CREATIVE_OPTIONALS) {
        if (!present.has(f)) delete served.creative[f];
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

await test('a SHARE ad resolves through asset_feed_spec', async () => {
  // Measured 2026-09-16: all 82 resolved ads were object_type SHARE and every
  // one came from asset_feed_spec. This file used to assert that a SHARE ad
  // falls back to effective_object_url -- which this account refuses outright,
  // so that test described a path that has never run in production.
  fakeGraph({ ads: { 1: AD('1', {
    id: 'cr1', object_type: 'SHARE',
    asset_feed_spec: { link_urls: [{ website_url: 'https://www.baseballism.com/collections/sale' }] },
  }) } });
  const rows = byId(await fetchMetaAdCreatives(CONNECTION, ['1']));
  assert.equal(rows['1'].linkUrl, 'https://www.baseballism.com/collections/sale');
  assert.equal(rows['1'].linkUrlSource, 'asset_feed');
});

await test('the advertiser\'s own link outranks the resolved destination', async () => {
  // A resolved destination is LAST on purpose: on a page-post ad Meta can
  // resolve one to the post. Where the ad carries its own link, that wins.
  fakeGraph({ ads: { 1: AD('1', {
    id: 'cr1',
    object_story_spec: { link_data: { link: 'https://baseballism.com/real-destination' } },
    asset_feed_spec: { link_urls: [{ website_url: 'https://www.facebook.com/123/posts/456' }] },
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

await test('a refused field is dropped and KEEPS every creative row', async () => {
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
  assert.ok(asksFor(asked[0], 'asset_feed_spec'), 'first attempt asks for the optional fields');
  assert.ok(!asksFor(asked[asked.length - 1], 'asset_feed_spec'), 'retry drops the refused field');
  assert.ok(asksFor(asked[asked.length - 1], 'object_story_spec'), 'retry keeps the base fields');
});

await test('A REFUSED url_tags MUST NOT COST asset_feed_spec', async () => {
  // The v1 production failure, in the shape it would take today: one refused
  // field must not take the destination fields with it. asset_feed_spec is the
  // one that matters -- it supplies every resolved link on this account.
  const asked = fakeGraph({
    ads: { 1: AD('1', {
      id: 'cr1', object_type: 'SHARE',
      asset_feed_spec: { link_urls: [{ website_url: 'https://www.baseballism.com/collections/sale' }] },
    }) },
    rejectFields: ['url_tags'],
  });
  const rows = byId(await fetchMetaAdCreatives(CONNECTION, ['1']));
  assert.equal(rows['1'].linkUrl, 'https://www.baseballism.com/collections/sale',
    'the destination must survive a refusal of a different field');
  assert.equal(rows['1'].linkUrlSource, 'asset_feed');
  const last = asked[asked.length - 1];
  assert.ok(!asksFor(last, 'url_tags'), 'the refused field is dropped');
  assert.ok(asksFor(last, 'asset_feed_spec'), 'the field that matters is NOT dropped with it');
});

await test('object_url still answers when an ad has no asset feed', async () => {
  // It resolved nothing on the live account (82 of 82 came from asset_feed),
  // but it is accepted by the API and is a real destination field, so it stays
  // requested. Dropping it because one window produced none would be the same
  // guess-from-one-run that got effective_object_url called a lifeline.
  fakeGraph({
    ads: { 1: AD('1', { id: 'cr1', object_type: 'SHARE',
      object_url: 'https://www.baseballism.com/collections/tees' }) },
  });
  const rows = byId(await fetchMetaAdCreatives(CONNECTION, ['1']));
  assert.equal(rows['1'].linkUrl, 'https://www.baseballism.com/collections/tees');
  assert.equal(rows['1'].linkUrlSource, 'object_url');
});

await test('a refused object_url MUST NOT COST asset_feed_spec', async () => {
  // Cycle 1 of #709, P1. The fixed ladder always dropped asset_feed_spec
  // first, so refusing the NEWLY ADDED object_url cost a field Meta accepts:
  // step 1 dropped asset_feed_spec and retried the same bad field, step 2
  // finally dropped object_url. A Dynamic Creative ad whose only destination
  // is asset_feed_spec.link_urls then stored null against a field that was
  // never the problem -- the same "one bad field costs another" the tier
  // ladder was introduced to remove.
  const asked = fakeGraph({
    ads: { 1: AD('1', {
      id: 'cr1',
      asset_feed_spec: { link_urls: [{ website_url: 'https://baseballism.com/collections/dco' }] },
    }) },
    rejectFields: ['object_url'],
  });
  const rows = byId(await fetchMetaAdCreatives(CONNECTION, ['1']));
  assert.equal(rows['1'].linkUrl, 'https://baseballism.com/collections/dco',
    'an asset-feed destination must survive a refusal of a different field');
  assert.equal(rows['1'].linkUrlSource, 'asset_feed');
  const last = asked[asked.length - 1];
  assert.ok(!asksFor(last, 'object_url'), 'the refused field is dropped');
  assert.ok(asksFor(last, 'asset_feed_spec'), 'the accepted field is NOT dropped with it');
  assert.equal(asked.length, 2, 'one refusal, one retry -- not a walk down a ladder');
});

await test('a refusal naming a SUBfield drops the field that carries it', async () => {
  // A nested selection can be refused by its subfield name. Without the alias
  // nothing recognisable is named and the fallback order runs instead -- which
  // now protects asset_feed_spec, so the wrong field would go.
  const asked = fakeGraph({
    ads: { 1: AD('1', { id: 'cr1', object_type: 'SHARE',
      object_url: 'https://www.baseballism.com/x' }) },
    rejectFields: ['link_urls'],
  });
  const rows = byId(await fetchMetaAdCreatives(CONNECTION, ['1']));
  assert.equal(rows['1'].linkUrl, 'https://www.baseballism.com/x');
  const last = asked[asked.length - 1];
  assert.ok(!asksFor(last, 'asset_feed_spec'), 'link_urls resolves to asset_feed_spec');
  assert.ok(asksFor(last, 'object_url'), 'and nothing else is dropped');
});

await test('an UNNAMED refusal drops the LEAST costly field, keeping the destinations', async () => {
  // The only case the ordered list is for, and the order was inverted on
  // 2026-09-16: asset_feed_spec used to go first as "the riskiest", which on
  // this account would discard every destination it has. url_tags is UTM
  // metadata and goes first now.
  const asked = fakeGraph({
    ads: { 1: AD('1', {
      id: 'cr1', object_type: 'SHARE',
      asset_feed_spec: { link_urls: [{ website_url: 'https://www.baseballism.com/y' }] },
    }) },
    // url_tags is the culprit, and the message does not name it.
    rejectFields: ['url_tags'],
    rejectMessage: '(#100) Syntax error on the fields parameter',
  });
  const rows = byId(await fetchMetaAdCreatives(CONNECTION, ['1']));
  assert.equal(rows['1'].linkUrl, 'https://www.baseballism.com/y',
    'the field supplying every destination survives an unnamed refusal');
  assert.ok(asksFor(asked[asked.length - 1], 'asset_feed_spec'), 'asset_feed_spec is kept');
});

await test('several refusals drop exactly those fields and keep the rest', async () => {
  const asked = fakeGraph({
    ads: { 1: AD('1', { id: 'cr1', object_type: 'SHARE',
      url_tags: 'utm_campaign=x' }) },
    rejectFields: ['asset_feed_spec', 'object_url'],
  });
  await fetchMetaAdCreatives(CONNECTION, ['1']);
  // One attempt per refused field, plus the one that finally succeeds.
  assert.equal(asked.length, 3, `expected one retry per refused field, saw ${asked.length}`);
  const last = asked[asked.length - 1];
  assert.ok(asksFor(last, 'url_tags'), 'url_tags is kept: it was never the refused field');
  for (const f of ['asset_feed_spec', 'object_url']) {
    assert.ok(!asksFor(last, f), `${f} should have been dropped`);
  }
});

await test('losing every optional field still leaves the base fields and their links', async () => {
  // Found by writing the test above, and worth pinning rather than
  // discovering again later. object_story_spec is in the BASE tier -- it was
  // already fetched for copy -- so an ad carrying its own link still resolves
  // one after a refusal. Only object_url/url_tags/asset_feed_spec
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
    rejectFields: ['asset_feed_spec', 'object_url', 'url_tags'],
  });
  const rows = byId(await fetchMetaAdCreatives(CONNECTION, ['1', '2']));
  assert.equal(rows['1'].linkUrl, 'https://baseballism.com/x', 'a spec link still resolves');
  assert.equal(rows['1'].linkUrlSource, 'link_data');
  assert.equal(rows['2'].linkUrl, null, 'the SHARE fallback is gone with the tier');
  assert.equal(rows['2'].linkUrlSource, null);
});

await test('a dropped field is not re-requested for the rest of the run', async () => {
  // 120 ads = three batches. Re-asking for a field Meta has already refused
  // costs a wasted round trip per batch and, worse, makes coverage depend on
  // batch order.
  const ads = {};
  for (let i = 1; i <= 120; i++) ads[i] = AD(String(i), { id: `cr${i}`, body: `copy ${i}` });
  const asked = fakeGraph({ ads, rejectFields: ['asset_feed_spec'] });
  const rows = await fetchMetaAdCreatives(CONNECTION, Object.keys(ads));
  assert.equal(rows.length, 120, 'every ad still returns a row');
  const withRefused = asked.filter((a) => asksFor(a, 'asset_feed_spec'));
  assert.equal(withRefused.length, 1, `refused field re-requested ${withRefused.length} times`);
  // And every later batch still asks for the tier BELOW it, not the base.
  assert.ok(asksFor(asked[asked.length - 1], 'object_url'),
    'an accepted field must survive another field being refused');
});

await test('an ordinary per-item failure does NOT narrow the field set', async () => {
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

// ── the two field lists, which have now been wrong twice ──────────────────
// Read out of the SHIPPED source text rather than re-declared here: a copy of
// the lists in the test would agree with itself while the module drifted.
const listFrom = (name) => {
  const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(source);
  assert.ok(m, `${name} not found in the module`);
  return m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
};

await test('the drop order keeps the field that supplies every destination for LAST', async () => {
  // Measured 2026-09-16: asset_feed_spec produced 82 of 82 resolved links on
  // the live account. It was TWICE written down as "the riskiest" and dropped
  // FIRST -- an unnamed refusal would have discarded every destination the
  // account has. This assertion exists because the belief was wrong twice and
  // a comment did not stop it.
  const order = listFrom('CREATIVE_DROP_ORDER');
  assert.equal(order[order.length - 1], 'asset_feed_spec',
    `asset_feed_spec must be dropped last, saw order: ${order.join(',')}`);
});

await test('every optional field is droppable, and nothing droppable is unrequested', async () => {
  // A field added to one list and not the other is a silent hole: an unnamed
  // refusal could never narrow past it, and the run would keep re-sending a
  // field it cannot drop.
  const optional = listFrom('CREATIVE_OPTIONAL_FIELDS');
  const order = listFrom('CREATIVE_DROP_ORDER');
  assert.deepEqual([...optional].sort(), [...order].sort(),
    `the two lists must cover the same fields; optional=${optional} order=${order}`);
});

await test('effective_object_url is not requested and not read', async () => {
  // The account refuses it as an unknown field. Requesting it cost a retry and
  // a [warn] on every run; READING it was dead code that read like coverage,
  // and is what made it look like the page-post ads' lifeline.
  assert.ok(!listFrom('CREATIVE_OPTIONAL_FIELDS').includes('effective_object_url'),
    'effective_object_url must not be requested');
  assert.ok(!/\['effective_object_url',/.test(source),
    'effective_object_url must not be a resolver candidate while it is unrequested');
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
