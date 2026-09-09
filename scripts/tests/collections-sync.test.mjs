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
import { runCollectionsSync, resolveOnlineStorePublication } from '../lib/shopify-sync-core.mjs';

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

/** Minimal stand-in for the supabase client surface this function touches:
 *  .from(t).insert(...).select(...).single(), .from(t).upsert(rows, opts),
 *  and .from(t).update(patch).eq().eq().is().neq(). Records every call so a
 *  test can assert on what was written -- and, more importantly, on what
 *  was NOT. */
function fakeSupabase() {
  const calls = { inserts: [], upserts: [], updates: [] };
  const chainable = (record) => {
    const chain = {
      eq: () => chain, is: () => chain, neq: () => chain,
      then: (resolve) => resolve({ error: null }),
    };
    return chain;
  };
  return {
    calls,
    from(table) {
      return {
        insert(row) {
          calls.inserts.push({ table, row });
          return { select: () => ({ single: async () => ({ data: { id: 'run-1' }, error: null }) }) };
        },
        upsert(rows, opts) {
          calls.upserts.push({ table, rows, opts });
          return Promise.resolve({ error: null });
        },
        update(patch) {
          calls.updates.push({ table, patch });
          return chainable();
        },
      };
    },
  };
}

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

const PUBLICATION_OK = {
  publications: { nodes: [{ id: 'gid://shopify/Publication/1', catalog: { title: 'Online Store' } }] },
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

await test('an ambiguous publication match is unknown too', async () => {
  const two = {
    publications: { nodes: [
      { id: 'gid://shopify/Publication/1', catalog: { title: 'Online Store' } },
      { id: 'gid://shopify/Publication/2', catalog: { title: 'Online Store (staging)' } },
    ] },
  };
  const res = await resolveOnlineStorePublication(CONNECTION, { gql: async () => two });
  ok(!res.id, 'no id chosen when two match');
  ok(/cannot pick one/.test(res.error), 'says why');
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

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
