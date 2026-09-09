/* runCollectionsSync: the properties that are the opposite of what the
 * shortest implementation does.
 *
 * The one that matters most is deletion gating. "Upsert what came back and
 * mark the rest deleted" is the natural shape, and it converts a single
 * timeout into "every collection was removed" -- the same
 * absent-from-what-I-fetched-means-not-real error that started this whole
 * workstream, one layer below where it was found. Asserting it in prose is
 * worth nothing, so this drives a real mid-pagination failure through the
 * function with a fake Shopify and a fake Supabase and checks what actually
 * got written.
 *
 * No network, no database, no install. Run:
 *   node scripts/tests/collections-sync.test.mjs
 */
import { runCollectionsSync, resolveOnlineStorePublication, shopifyNumericId } from '../lib/shopify-sync-core.mjs';
import { createFakeSupabase } from './lib/fake-supabase.mjs';

let failures = 0;
let count = 0;
function test(name, fn) {
  count++;
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok   ${name}`))
    .catch((err) => { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); });
}
function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function ok(cond, what) { if (!cond) throw new Error(what); }

const CONNECTION = {
  company_entity_id: 'company-1',
  shop_domain: 'test.myshopify.com',
  access_token: 'unused',
};

// The fake applies filters against stored rows (scripts/tests/lib/
// fake-supabase.mjs) -- the earlier version ignored predicates, so a sweep
// assertion proved only that a sweep ran, not which rows it touched.
const fakeSupabase = createFakeSupabase;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const collectionNode = (n, extra = {}) => ({
  id: `gid://shopify/Collection/${n}`,
  legacyResourceId: String(n),
  handle: `collection-${n}`,
  title: `Collection ${n}`,
  description: '',
  updatedAt: '2026-09-01T00:00:00Z',
  sortOrder: 'BEST_SELLING',
  templateSuffix: null,
  seo: { title: null, description: null },
  ruleSet: null,
  productsCount: { count: 1 },
  resourcePublications: { nodes: [] },
  products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: `gid://shopify/Product/${n}` }] },
  ...extra,
});

// Shape verified against the live Baseballism shop 2026-09-09: publications
// carry catalog: null, and the online store is identified by the CHANNEL
// handle, whose numeric id pairs with its publication.
const PUBLICATION_OK = {
  channels: {
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [
      { id: 'gid://shopify/Channel/1861820', handle: 'online_store', app: { handle: 'online_store' } },
      { id: 'gid://shopify/Channel/1861824', handle: 'pos', app: { handle: 'pos' } },
    ],
  },
  publications: { nodes: [
    { id: 'gid://shopify/Publication/1861820' },
    { id: 'gid://shopify/Publication/1861824' },
  ] },
};

console.log('\n-- a run that dies mid-pagination must not delete anything --');

await test('a mid-pagination failure leaves completed_at unset and sweeps nothing', async () => {
  const supabase = fakeSupabase();
  let call = 0;
  const gql = async (_conn, query) => {
    call++;
    if (query.includes('OnlineStorePublication')) return PUBLICATION_OK;
    if (call === 2) {
      return { collections: { pageInfo: { hasNextPage: true, endCursor: 'CURSOR' }, nodes: [collectionNode(1)] } };
    }
    throw new Error('rate limited on page 2');
  };

  let threw = null;
  try { await runCollectionsSync(supabase, CONNECTION, { gql }); }
  catch (err) { threw = err; }

  ok(threw, 'the failure must propagate, not be swallowed');
  eq(threw.message, 'rate limited on page 2', 'error surfaced');

  const runUpdates = supabase.calls.updates.filter((u) => u.table === 'shopify_collection_sync_runs');
  eq(runUpdates.length, 1, 'exactly one run update (the failure record)');
  ok(runUpdates[0].patch.error, 'the run records the error');
  ok(!('completed_at' in runUpdates[0].patch), 'completed_at must NOT be set on a failed run');

  const sweeps = supabase.calls.updates.filter((u) => 'missing_since' in u.patch);
  eq(sweeps.length, 0, 'no missing_since sweep may run after a partial fetch');
});

await test('page 1 rows are still written -- a partial run stores what it saw', async () => {
  const supabase = fakeSupabase();
  let call = 0;
  const gql = async (_conn, query) => {
    call++;
    if (query.includes('OnlineStorePublication')) return PUBLICATION_OK;
    if (call === 2) {
      return { collections: { pageInfo: { hasNextPage: true, endCursor: 'C' }, nodes: [collectionNode(1)] } };
    }
    throw new Error('boom');
  };
  await runCollectionsSync(supabase, CONNECTION, { gql }).catch(() => {});
  const collectionUpserts = supabase.calls.upserts.filter((u) => u.table === 'shopify_collections');
  eq(collectionUpserts.length, 1, 'the page that did arrive is upserted');
  eq(collectionUpserts[0].rows[0].handle, 'collection-1', 'row content');
});

console.log('\n-- a clean run completes, then sweeps, in that order --');

await test('a complete run sets completed_at and then sweeps', async () => {
  const supabase = fakeSupabase();
  const gql = async (_conn, query) => {
    if (query.includes('OnlineStorePublication')) return PUBLICATION_OK;
    return { collections: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [collectionNode(1)] } };
  };
  const result = await runCollectionsSync(supabase, CONNECTION, { gql });

  eq(result.complete, true, 'result marked complete');
  eq(result.publication_resolved, true, 'publication resolved');

  const updates = supabase.calls.updates;
  const completedIdx = updates.findIndex((u) => 'completed_at' in u.patch);
  const firstSweepIdx = updates.findIndex((u) => 'missing_since' in u.patch);
  ok(completedIdx !== -1, 'completed_at is set');
  ok(firstSweepIdx !== -1, 'the sweep runs');
  ok(completedIdx < firstSweepIdx,
    'completed_at must be stamped BEFORE the sweep, so a crash between them leaves stale-but-true data rather than a sweep with nothing justifying it');
  eq(updates.filter((u) => 'missing_since' in u.patch).length, 2, 'both tables swept');
});

console.log('\n-- unresolved publication is unknown, never false --');

await test('publication lookup failure writes null + an error, not false', async () => {
  const supabase = fakeSupabase();
  const gql = async (_conn, query) => {
    if (query.includes('OnlineStorePublication')) throw new Error('403 from Shopify');
    ok(!query.includes('publishedOnPublication'),
      'with no publication id the field must be omitted, not passed null');
    return { collections: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [collectionNode(1)] } };
  };
  const result = await runCollectionsSync(supabase, CONNECTION, { gql });

  eq(result.publication_resolved, false, 'publication not resolved');
  const row = supabase.calls.upserts.find((u) => u.table === 'shopify_collections').rows[0];
  eq(row.published_to_online_store, null, 'unknown is null, NOT false');
  ok(row.publication_error, 'the reason is recorded');
});

await test('the live shape resolves: channel handle -> derived publication id', async () => {
  const res = await resolveOnlineStorePublication(CONNECTION, { gql: async () => PUBLICATION_OK });
  eq(res.id, 'gid://shopify/Publication/1861820', 'derived from the online_store channel id');
});

// The bug this replaced: matching on Publication.catalog.title resolved
// nothing on the real shop, because every publication returns catalog null.
test('catalog.title is not used -- publications with null catalog still resolve', () => {
  ok(PUBLICATION_OK.publications.nodes.every((p) => !('catalog' in p)),
    'the fixture matches the live shape, where catalog is absent/null');
});

await test('a derived publication id that is not a real publication is unknown', async () => {
  const orphanChannel = {
    channels: { pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ id: 'gid://shopify/Channel/999', handle: 'online_store', app: { handle: 'online_store' } }] },
    publications: { nodes: [{ id: 'gid://shopify/Publication/1861820' }] },
  };
  const res = await resolveOnlineStorePublication(CONNECTION, { gql: async () => orphanChannel });
  ok(!res.id, 'an unconfirmed derivation is not used');
  ok(/no matching publication/.test(res.error), 'says why');
});

await test('an INTERRUPTED channel walk is unknown, never "not published"', async () => {
  let call = 0;
  const gql = async () => {
    call++;
    if (call === 1) {
      return {
        channels: { pageInfo: { hasNextPage: true, endCursor: 'C1' },
                    nodes: [{ id: 'gid://shopify/Channel/5', handle: 'pos', app: { handle: 'pos' } }] },
        publications: { nodes: [{ id: 'gid://shopify/Publication/5' }] },
      };
    }
    throw new Error('rate limited paging channels');
  };
  const res = await resolveOnlineStorePublication(CONNECTION, { gql });
  ok(!res.id, 'a partial channel list must not resolve');
  ok(/rate limited/.test(res.error), 'the reason survives');
});

await test('a COMPLETE walk that finds no online store is still unknown, not false', async () => {
  const noOnlineStore = {
    channels: { pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ id: 'gid://shopify/Channel/5', handle: 'pos', app: { handle: 'pos' } }] },
    publications: { nodes: [{ id: 'gid://shopify/Publication/5' }] },
  };
  const res = await resolveOnlineStorePublication(CONNECTION, { gql: async () => noOnlineStore });
  ok(!res.id, 'no id');
  ok(/no channel with handle online_store/.test(res.error), 'says why');
});

// The other half of the rule: false is only ever written when the
// publication DID resolve, so the per-collection boolean is trustworthy.
await test('only a resolved publication permits a false; otherwise null', async () => {
  const supabase = fakeSupabase();
  const gql = async (_conn, query) => {
    if (query.includes('OnlineStorePublication')) return PUBLICATION_OK;
    return { collections: { pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [collectionNode(1, { publishedOnPublication: false })] } };
  };
  await runCollectionsSync(supabase, CONNECTION, { gql });
  const row = supabase.rows('shopify_collections')[0];
  eq(row.published_to_online_store, false, 'a resolved publication may record false');
  eq(row.publication_error, null, 'and carries no error');
});

console.log('\n-- membership is paginated to completion --');

await test('a multi-page collection fetches every product page', async () => {
  const supabase = fakeSupabase();
  const gql = async (_conn, query, vars) => {
    if (query.includes('OnlineStorePublication')) return PUBLICATION_OK;
    if (query.includes('CollectionProducts')) {
      return { collection: { products: {
        pageInfo: { hasNextPage: vars.cursor !== 'P2', endCursor: 'P2' },
        nodes: [{ id: 'gid://shopify/Product/extra' }],
      } } };
    }
    return { collections: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [collectionNode(1, {
      products: { pageInfo: { hasNextPage: true, endCursor: 'P1' }, nodes: [{ id: 'gid://shopify/Product/1' }] },
    })] } };
  };
  const result = await runCollectionsSync(supabase, CONNECTION, { gql });
  eq(result.memberships_seen, 3, 'first page plus both follow-up pages');
});

await test('a failure while paging membership fails the run rather than truncating it', async () => {
  const supabase = fakeSupabase();
  const gql = async (_conn, query) => {
    if (query.includes('OnlineStorePublication')) return PUBLICATION_OK;
    if (query.includes('CollectionProducts')) throw new Error('timeout paging products');
    return { collections: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [collectionNode(1, {
      products: { pageInfo: { hasNextPage: true, endCursor: 'P1' }, nodes: [{ id: 'gid://shopify/Product/1' }] },
    })] } };
  };
  let threw = null;
  try { await runCollectionsSync(supabase, CONNECTION, { gql }); } catch (err) { threw = err; }
  ok(threw, 'partial membership must fail the run');
  eq(supabase.calls.updates.filter((u) => 'missing_since' in u.patch).length, 0, 'and sweep nothing');
});

console.log('\n-- seo nulls stay null --');

await test('an inherited (null) seo override is not backfilled from the title', async () => {
  const supabase = fakeSupabase();
  const gql = async (_conn, query) => {
    if (query.includes('OnlineStorePublication')) return PUBLICATION_OK;
    return { collections: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [collectionNode(1)] } };
  };
  await runCollectionsSync(supabase, CONNECTION, { gql });
  const row = supabase.calls.upserts.find((u) => u.table === 'shopify_collections').rows[0];
  eq(row.seo_title_override, null, 'null means inherits, and must survive as null');
  eq(row.title, 'Collection 1', 'the title itself is still recorded');
});


console.log('\n-- the sweep marks the right rows, not merely "some rows" --');

await test('a completed run marks only what it did NOT see', async () => {
  const supabase = fakeSupabase();
  // A stale row from an earlier era: last_seen_at long past, still present.
  supabase.from('shopify_collections').insert({
    company_entity_id: CONNECTION.company_entity_id,
    shop_domain: CONNECTION.shop_domain,
    shopify_collection_id: 'gid://shopify/Collection/999',
    handle: 'retired-collection',
    last_seen_at: '2020-01-01T00:00:00.000Z',
    last_seen_run_id: 'run-ancient',
    missing_since: null,
  });

  const gql = async (_conn, query) => {
    if (query.includes('OnlineStorePublication')) return PUBLICATION_OK;
    return { collections: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [collectionNode(1)] } };
  };
  await runCollectionsSync(supabase, CONNECTION, { gql });

  const rows = supabase.rows('shopify_collections');
  const seen = rows.find((r) => r.handle === 'collection-1');
  const stale = rows.find((r) => r.handle === 'retired-collection');
  eq(seen.missing_since, null, 'a collection this run SAW must not be marked missing');
  ok(stale.missing_since, 'a collection this run did not see IS marked missing');
});

await test('a row belonging to another shop is never swept', async () => {
  const supabase = fakeSupabase();
  supabase.from('shopify_collections').insert({
    company_entity_id: CONNECTION.company_entity_id,
    shop_domain: 'other-shop.myshopify.com',
    shopify_collection_id: 'gid://shopify/Collection/777',
    handle: 'other-shops-collection',
    last_seen_at: '2020-01-01T00:00:00.000Z',
    missing_since: null,
  });
  const gql = async (_conn, query) => {
    if (query.includes('OnlineStorePublication')) return PUBLICATION_OK;
    return { collections: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [collectionNode(1)] } };
  };
  await runCollectionsSync(supabase, CONNECTION, { gql });
  const other = supabase.rows('shopify_collections').find((r) => r.handle === 'other-shops-collection');
  eq(other.missing_since, null, 'the sweep is scoped to this shop');
});

console.log('\n-- overlapping runs must not delete each other\'s data --');

// The nightly workflow deliberately permits overlapping runs (its
// concurrency group was tried and removed). Sweeping on
// last_seen_run_id != runId is wrong under that: B re-stamps a row while A
// is still walking, then A completes and marks it missing because the id
// isn't A's -- deleting a live collection. Sweeping on
// last_seen_at < A.started_at survives it.
await test('a run interleaved inside another does not get its rows swept', async () => {
  const supabase = fakeSupabase();
  let ranB = false;

  // A must NOT re-see collection 1 after B stamps it -- otherwise A's own
  // upsert overwrites B's run id and the race never materialises. (The first
  // version of this test did exactly that and passed against the BROKEN
  // sweep, which is why it is written this way.) So A sees 1 then 2, while
  // B sees both.
  const gqlA = async (_conn, query, vars) => {
    if (query.includes('OnlineStorePublication')) return PUBLICATION_OK;
    if (!vars.cursor) {
      return { collections: { pageInfo: { hasNextPage: true, endCursor: 'C1' }, nodes: [collectionNode(1)] } };
    }
    if (!ranB) {
      ranB = true;
      await sleep(5); // distinguishable timestamps for B's writes
      const gqlB = async (_c, q) => {
        if (q.includes('OnlineStorePublication')) return PUBLICATION_OK;
        return { collections: { pageInfo: { hasNextPage: false, endCursor: null },
                                nodes: [collectionNode(1), collectionNode(2)] } };
      };
      await runCollectionsSync(supabase, CONNECTION, { gql: gqlB });
      await sleep(5);
    }
    return { collections: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [collectionNode(2)] } };
  };

  await sleep(5);
  await runCollectionsSync(supabase, CONNECTION, { gql: gqlA });

  const one = supabase.rows('shopify_collections').find((r) => r.handle === 'collection-1');
  ok(one, 'collection 1 exists');
  eq(one.missing_since, null,
    'collection 1 was seen by A (page 1) and re-stamped by B, so A\'s sweep must leave it alone; ' +
    'sweeping on last_seen_run_id marks it missing here and deletes live data');
});

console.log('\n-- membership joins products_master --');

await test('membership stores the NUMERIC product id, not the GID', async () => {
  const supabase = fakeSupabase();
  const gql = async (_conn, query) => {
    if (query.includes('OnlineStorePublication')) return PUBLICATION_OK;
    return { collections: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [collectionNode(7)] } };
  };
  await runCollectionsSync(supabase, CONNECTION, { gql });
  const member = supabase.rows('shopify_collection_products')[0];
  eq(member.shopify_product_id, '7',
    'products_master.shopify_product_id is Shopify\'s REST numeric id; a GID here joins to nothing');
  ok(!String(member.shopify_product_id).startsWith('gid://'), 'no GID leaked through');
});

await test('shopifyNumericId is idempotent and handles both dialects', () => {
  eq(shopifyNumericId('gid://shopify/Product/123'), '123', 'gid');
  eq(shopifyNumericId('123'), '123', 'already numeric');
  eq(shopifyNumericId(shopifyNumericId('gid://shopify/Product/123')), '123', 'applied twice');
  eq(shopifyNumericId(null), null, 'null');
});

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
