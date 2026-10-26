// The three organic reads added 2026-10-26: the Instagram ACCOUNT (profile
// fields), its ACCOUNT-level insights, and the Facebook Page's OWN published
// posts. Meta's App Review rejected instagram_basic,
// instagram_manage_insights and pages_read_engagement because none of them
// was visible anywhere in SILO.
//
// What these tests are actually defending:
//   1. Each new read FAILS SOFT. They were bolted onto the job that fills the
//      marketing reports every night, and on 2026-08-28 one retired Page
//      metric erased a successful Instagram pull from the summary. A new read
//      must never be able to cost the rows that did come back.
//   2. A window TOTAL never becomes a daily row, and a day bucket is labelled
//      with the day it describes -- not the day its end_time names.
//   3. No future-dated row, ever (87 zero-filled future rows once reached
//      facebook_page_insights_daily, and a zero reads as a measurement).
//   4. The Page's own posts come from /published_posts, never /feed: /feed
//      returns visitors' posts and needs pages_read_user_content, which SILO
//      neither holds nor submitted.
//
// Mutation-tested: each guard is broken in turn and a test must fail. Run
//   node scripts/tests/meta-organic-account-and-posts.test.mjs --mutate=N
// for N in 1..5; every one must exit non-zero.
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
  // The day shift: label a bucket with its own end_time instead of the day before.
  source = source.replace(
    "        const day = isoDateOnly(addDays(new Date(`${endDay}T00:00:00Z`), -1));\n        if (!day || day < window.startDate || day >= window.endDate) continue;\n        days.push({ day, reach:",
    "        const day = endDay;\n        if (!day || day < window.startDate || day >= window.endDate) continue;\n        days.push({ day, reach:");
} else if (mutation === 2) {
  // The future-row clamp.
  source = source.replace(
    'if (!day || day < window.startDate || day >= window.endDate) continue;\n        days.push({ day, reach:',
    'if (!day) continue;\n        days.push({ day, reach:');
} else if (mutation === 3) {
  // Fail soft: let a refused profile read throw instead of returning null.
  source = source.replace(
      "      if (!isMetaUnknownFieldError(err)) {\n        console.warn('[warn] Instagram account profile unavailable:', err.message);\n        return null;\n      }",
      '      if (!isMetaUnknownFieldError(err)) { throw err; }');
} else if (mutation === 4) {
  // Store the window totals even when the totals call returned no metric.
  source = source.replace('    if (Object.keys(by).length) {', '    if (true) {');
} else if (mutation === 5) {
  // Read the Page's feed instead of its own published posts.
  source = source.replace('/published_posts?', '/feed?');
}
if (mutation) assert.notEqual(source, readFileSync(CORE, 'utf8'), 'mutation did not apply');

const dir = mkdtempSync(join(tmpdir(), 'meta-organic-'));
const sibling = pathToFileURL(join(ROOT, 'scripts/lib/shopify-sync-core.mjs')).href;
const copy = join(dir, 'ad-platforms-sync-core.mjs');
writeFileSync(copy, source.replace("from './shopify-sync-core.mjs'", `from '${sibling}'`));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const {
  fetchInstagramAccountProfile, fetchInstagramAccountInsights, fetchFacebookPagePosts, runMetaOrganicSync,
} = await import(pathToFileURL(copy).href);

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}

const CONN = {
  company_entity_id: 'co-1', access_token: 'tok',
  instagram_business_account_id: 'ig1', facebook_page_id: 'p1',
};
const WINDOW = { startDate: '2026-10-01', endDate: '2026-10-05' };

/** Swap global fetch for one that answers from `routes` (path -> handler) and
 *  records every call, so a test can assert what was NOT requested too. */
function withFetch(routes) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v[\d.]+\//, '');
    calls.push({ path, params: u.searchParams });
    for (const [key, handler] of Object.entries(routes)) {
      if (path === key) {
        const r = await handler(u.searchParams);
        // Meta reports a refused field as a 400 with a JSON error body, NOT a
        // transport failure -- and the difference matters here: a thrown fetch
        // goes through fetchWithRetry's five attempts, so a test that threw
        // would be measuring the retry loop rather than the negotiation.
        if (r instanceof Error) {
          return new Response(JSON.stringify({ error: { message: r.message, code: 100 } }), { status: 400 });
        }
        return new Response(JSON.stringify(r), { status: 200 });
      }
    }
    return new Response(JSON.stringify({ error: { message: `(#100) Unsupported get request for field ${path}`, code: 100 } }), { status: 400 });
  };
  return { calls, restore() { globalThis.fetch = real; } };
}

// ── 1. The Instagram account ────────────────────────────────────────────────
await test('profile: the account fields, and a refused field narrows the set rather than losing the account', async () => {
  const f = withFetch({ ig1: () => ({ id: 'ig1', username: 'demo', name: 'Demo Co', biography: 'bio', followers_count: 1234, media_count: 56 }) });
  try {
    const p = await fetchInstagramAccountProfile(CONN);
    assert.equal(p.username, 'demo');
    assert.equal(p.followersCount, 1234);
    assert.equal(p.mediaCount, 56);
    assert.deepEqual(p.droppedFields, []);
  } finally { f.restore(); }

  // Meta refuses the WHOLE request for one unknown field. Dropping exactly the
  // field it names keeps the handle and the follower count, which is what the
  // reporting header needs; a fixed field list would lose all of it.
  let asked = 0;
  const f2 = withFetch({
    ig1: (params) => {
      asked += 1;
      if (params.get('fields').includes('biography')) {
        return new Error('Graph: (#100) Tried accessing nonexisting field (biography) on node type (IGUser)');
      }
      return { id: 'ig1', username: 'demo', followers_count: 7 };
    },
  });
  try {
    const p = await fetchInstagramAccountProfile(CONN);
    assert.equal(p.username, 'demo');
    assert.deepEqual(p.droppedFields, ['biography']);
    assert.equal(asked, 2, 'asked again with the narrowed field set');
  } finally { f2.restore(); }
});

await test('profile: a non-field failure returns null and never throws', async () => {
  const f = withFetch({ ig1: () => new Error('Graph: (#190) token expired') });
  try { assert.equal(await fetchInstagramAccountProfile(CONN), null); } finally { f.restore(); }
  // Not configured is not an error either: nothing to fetch.
  assert.equal(await fetchInstagramAccountProfile({ access_token: 'tok' }), null);
  assert.equal(await fetchInstagramAccountProfile({ instagram_business_account_id: 'ig1' }), null);
});

// ── 2. Account-level insights ───────────────────────────────────────────────
await test('account insights: reach becomes daily rows labelled with the day they describe; totals stay a window total', async () => {
  const f = withFetch({
    'ig1/insights': (params) => (params.get('metric_type') === 'time_series'
      ? { data: [{ name: 'reach', values: [
        // end_time marks the END of the bucket, so these describe 10-01..10-03.
        { end_time: '2026-10-02T07:00:00+0000', value: 100 },
        { end_time: '2026-10-03T07:00:00+0000', value: 200 },
        { end_time: '2026-10-04T07:00:00+0000', value: 300 },
        // Past the window: a bucket stamped endDate describes endDate-1, so
        // [startDate, endDate) is exactly the complete days -- and a bucket
        // beyond that must never become a row.
        { end_time: '2026-10-09T07:00:00+0000', value: 999 },
      ] }] }
      : { data: [
        { name: 'views', total_value: { value: 4321 } },
        { name: 'accounts_engaged', total_value: { value: 77 } },
        { name: 'total_interactions', total_value: { value: 88 } },
      ] }),
  });
  try {
    const { days, totals } = await fetchInstagramAccountInsights(CONN, WINDOW);
    assert.deepEqual(days, [
      { day: '2026-10-01', reach: 100 }, { day: '2026-10-02', reach: 200 }, { day: '2026-10-03', reach: 300 },
    ]);
    assert.ok(!days.some((d) => d.day >= WINDOW.endDate), 'no row at or past endDate');
    assert.deepEqual(totals, {
      views: 4321, accountsEngaged: 77, totalInteractions: 88,
      windowStart: '2026-10-01', windowEnd: '2026-10-05',
    });
    // The window the totals cover travels WITH them: "views" without it is
    // wrong by however wide the window happens to be.
    assert.ok(totals.windowStart && totals.windowEnd);
  } finally { f.restore(); }
});

await test('account insights: the deprecated and threshold metrics are never requested', async () => {
  const f = withFetch({ 'ig1/insights': () => ({ data: [] }) });
  try {
    await fetchInstagramAccountInsights(CONN, WINDOW);
    const metrics = f.calls.map((c) => c.params.get('metric')).join(',');
    // impressions is deprecated (v22+, and every version since 2025-04-21);
    // follows_and_unfollows and the demographics metrics vanish below 100
    // followers/engagements, and a metric that vanishes reads as a zero.
    for (const m of ['impressions', 'follows_and_unfollows', 'follower_demographics', 'engaged_audience_demographics']) {
      assert.ok(!metrics.split(',').includes(m), `${m} must not be requested`);
    }
  } finally { f.restore(); }
});

await test('account insights: each half fails on its own; an empty totals reply stores nothing', async () => {
  const f = withFetch({
    'ig1/insights': (params) => (params.get('metric_type') === 'time_series'
      ? new Error('Graph: (#100) The value must be a valid insights metric')
      : { data: [{ name: 'views', total_value: { value: 5 } }] }),
  });
  try {
    const r = await fetchInstagramAccountInsights(CONN, WINDOW);
    assert.deepEqual(r.days, [], 'the reach failure cost only reach');
    assert.equal(r.totals.views, 5, 'the totals still landed');
  } finally { f.restore(); }

  // An empty `data` array is NOT three measured zeroes.
  const f2 = withFetch({
    'ig1/insights': (params) => (params.get('metric_type') === 'time_series' ? { data: [] } : { data: [] }),
  });
  try {
    const r = await fetchInstagramAccountInsights(CONN, WINDOW);
    assert.equal(r.totals, null, 'no metric returned means no totals row, not a row of nulls');
  } finally { f2.restore(); }
});

// ── 3. The Page's own posts ─────────────────────────────────────────────────
await test('page posts: published_posts with the PAGE token, never /feed', async () => {
  const f = withFetch({
    'p1/published_posts': (params) => {
      assert.equal(params.get('access_token'), 'PAGE-TOKEN', 'the Page token, not the system user token');
      return { data: [{
        id: 'p1_1', message: 'Opening day', permalink_url: 'https://facebook.com/p1_1',
        created_time: '2026-10-02T12:00:00+0000', full_picture: 'https://img/1',
        likes: { summary: { total_count: 7 } }, comments: { summary: { total_count: 2 } }, shares: { count: 1 },
      }, {
        // A post with no shares object at all, and no message: Meta OMITS
        // `shares` rather than sending zero, and a photo post has no text.
        id: 'p1_2', created_time: '2026-10-01T12:00:00+0000', likes: { summary: { total_count: 0 } },
      }] };
    },
  });
  try {
    const posts = await fetchFacebookPagePosts(CONN, 'PAGE-TOKEN');
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[0], {
      postId: 'p1_1', pageId: 'p1', message: 'Opening day', permalink: 'https://facebook.com/p1_1',
      fullPicture: 'https://img/1', postedAt: '2026-10-02T12:00:00+0000', likes: 7, comments: 2, shares: 1,
    });
    // Absent is null, never 0: "Meta did not return it" is not "there were none".
    assert.equal(posts[1].shares, null);
    assert.equal(posts[1].comments, null);
    assert.equal(posts[1].likes, 0, 'a returned zero IS zero');
    assert.ok(f.calls.every((c) => !c.path.endsWith('/feed')),
      '/feed returns visitors\' posts and needs pages_read_user_content, which SILO does not hold');
  } finally { f.restore(); }
});

await test('page posts: no Page token means no posts, not a failure', async () => {
  assert.deepEqual(await fetchFacebookPagePosts(CONN, null), []);
  assert.deepEqual(await fetchFacebookPagePosts({ access_token: 'tok' }, 'PAGE-TOKEN'), []);
});

await test('page posts: the walk stops at max, and a refused field restarts with a narrowed set', async () => {
  const f = withFetch({
    'p1/published_posts': (params) => ({
      data: [{ id: `a${params.get('after') || 0}` }, { id: `b${params.get('after') || 0}` }],
      paging: { next: `https://graph.facebook.com/v25.0/p1/published_posts?${new URLSearchParams({ ...Object.fromEntries(params), after: 'X' })}` },
    }),
  });
  try {
    const posts = await fetchFacebookPagePosts(CONN, 'PAGE-TOKEN', { max: 3, pageSize: 2 });
    assert.equal(posts.length, 3, 'stops mid-page at the cap rather than finishing it');
  } finally { f.restore(); }

  let seen = [];
  const f2 = withFetch({
    'p1/published_posts': (params) => {
      const fields = params.get('fields');
      seen.push(fields);
      if (fields.includes('full_picture')) {
        return new Error('Graph: (#100) Tried accessing nonexisting field (full_picture) on node type (PagePost)');
      }
      return { data: [{ id: 'p1_1', message: 'hi' }] };
    },
  });
  try {
    const posts = await fetchFacebookPagePosts(CONN, 'PAGE-TOKEN');
    assert.equal(posts[0].message, 'hi');
    assert.equal(seen.length, 2);
    assert.ok(!seen[1].includes('full_picture'), 'asked again without the refused field');
    // The retry starts from the FIRST page: a paging cursor encodes the request
    // it was issued for, so it is not valid against a narrowed field set.
    assert.ok(!seen[1].includes('after'), 'the narrowed retry does not reuse the old cursor');
  } finally { f2.restore(); }
});

// ── 4. The wiring: a new read can never cost an old one ─────────────────────
function fakeSupabase() {
  const writes = [];
  const api = {
    from(table) {
      const b = {
        upsert(payload) { writes.push({ table, payload }); return Promise.resolve({ data: null, error: null }); },
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

await test('organic sync: all three new reads failing leaves the media and Page rows untouched', async () => {
  const { api, writes } = fakeSupabase();
  const f = withFetch({
    'ig1/media': () => ({ data: [{ id: 'm1', media_type: 'IMAGE', timestamp: '2026-10-02T00:00:00+0000' }] }),
    'm1/insights': () => ({ data: [{ name: 'views', values: [{ value: 9 }] }] }),
    // Every one of the three new reads fails, each in a different way.
    ig1: () => new Error('Graph: (#190) token expired'),
    'ig1/insights': () => new Error('Graph: (#100) The value must be a valid insights metric'),
    p1: (params) => (params.get('fields') === 'access_token'
      ? new Error('Graph: (#190) not assigned to this Page')
      : { fan_count: 321 }),
    'p1/insights': () => ({ data: [{ name: 'page_media_view', values: [{ end_time: '2026-10-03T07:00:00+0000', value: 50 }] }] }),
  });
  try {
    const r = await runMetaOrganicSync(api, CONN, { now: new Date('2026-10-05T12:00:00Z'), daysBackOverride: 4 });
    // The two things that worked before this change still work.
    assert.ok(writes.some((w) => w.table === 'instagram_media_insights'), 'media rows still written');
    assert.ok(writes.some((w) => w.table === 'facebook_page_insights_daily'), 'Page insight rows still written');
    assert.equal(r.media_fetched, 1);
    // And the new reads report their failure instead of throwing it.
    assert.equal(r.ig_profile_upserted, 0);
    assert.equal(r.page_posts_upserted, 0);
    assert.ok(!writes.some((w) => w.table === 'instagram_account_profile'));
    assert.ok(!writes.some((w) => w.table === 'facebook_page_posts'));
  } finally { f.restore(); }
});

await test('organic sync: a clean run writes the account, its daily reach and the Page posts', async () => {
  const { api, writes } = fakeSupabase();
  const f = withFetch({
    'ig1/media': () => ({ data: [] }),
    ig1: () => ({ id: 'ig1', username: 'demo', name: 'Demo Co', biography: 'bio', followers_count: 1234, media_count: 56 }),
    'ig1/insights': (params) => (params.get('metric_type') === 'time_series'
      ? { data: [{ name: 'reach', values: [{ end_time: '2026-10-03T07:00:00+0000', value: 900 }] }] }
      : { data: [{ name: 'views', total_value: { value: 4321 } }] }),
    p1: (params) => (params.get('fields') === 'access_token' ? { access_token: 'PAGE-TOKEN' } : { fan_count: 321 }),
    'p1/insights': () => ({ data: [] }),
    'p1/published_posts': () => ({ data: [{ id: 'p1_1', message: 'Opening day', created_time: '2026-10-02T12:00:00+0000' }] }),
  });
  try {
    const r = await runMetaOrganicSync(api, CONN, { now: new Date('2026-10-05T12:00:00Z'), daysBackOverride: 4 });
    const prof = writes.find((w) => w.table === 'instagram_account_profile');
    assert.equal(prof.payload.username, 'demo');
    assert.equal(prof.payload.followers_count, 1234);
    assert.equal(prof.payload.views_window, 4321);
    assert.equal(prof.payload.window_start, '2026-10-01');
    const igDays = writes.find((w) => w.table === 'instagram_account_insights_daily');
    assert.deepEqual(igDays.payload.map((x) => [x.day_date, x.reach]), [['2026-10-02', 900]]);
    assert.ok(igDays.payload.every((x) => x.row_hash), 'daily rows upsert on row_hash, like their sibling table');
    const posts = writes.find((w) => w.table === 'facebook_page_posts');
    assert.equal(posts.payload[0].post_id, 'p1_1');
    assert.equal(r.ig_profile_upserted, 1);
    assert.equal(r.ig_username, 'demo');
    assert.equal(r.page_posts_upserted, 1);
  } finally { f.restore(); }
});

await test('organic sync: the window totals are omitted, not nulled, when the totals call returns nothing', async () => {
  const { api, writes } = fakeSupabase();
  const f = withFetch({
    'ig1/media': () => ({ data: [] }),
    ig1: () => ({ id: 'ig1', username: 'demo', followers_count: 10 }),
    'ig1/insights': () => ({ data: [] }),
    p1: () => ({ fan_count: 1 }),
    'p1/insights': () => ({ data: [] }),
  });
  try {
    await runMetaOrganicSync(api, CONN, { now: new Date('2026-10-05T12:00:00Z'), daysBackOverride: 4 });
    const prof = writes.find((w) => w.table === 'instagram_account_profile');
    // Omitting the keys leaves whatever an earlier run stored; writing nulls
    // would blank a real reading, which "backfills ONLY ADD" forbids.
    for (const k of ['views_window', 'accounts_engaged_window', 'total_interactions_window', 'window_start', 'window_end']) {
      assert.ok(!(k in prof.payload), `${k} must be absent, not null`);
    }
  } finally { f.restore(); }
});

// ── 5. The vendored copy ────────────────────────────────────────────────────
await test('the edge function ships a byte-identical copy of the sync core', () => {
  assert.equal(
    readFileSync(join(ROOT, 'supabase/functions/ad-platform-sync-run/lib/ad-platforms-sync-core.mjs'), 'utf8'),
    readFileSync(CORE, 'utf8'),
    'supabase/functions/ad-platform-sync-run/lib/ad-platforms-sync-core.mjs is a VERBATIM copy (scripts/CLAUDE.md) — re-copy it',
  );
});

console.log(`\n${passed} passed`);
