/* The destination columns, executed against the real migrations.
 *
 * Companion to meta-creative-links.test.mjs, which covers the sync side. This
 * half proves the database keeps the promises the sync cannot:
 *   1. link_url and link_url_source are null or non-null TOGETHER, enforced
 *      by a constraint a service-role write cannot dodge -- the sync pairs
 *      them in one object, but nothing stops a backfill or a hand-written
 *      update from setting one alone, and an unattributed URL cannot be told
 *      apart from a page-post URL standing in for a landing page.
 *   2. link_path is GENERATED from link_url, so the two cannot drift, and
 *      strips query and fragment -- utm tags do not make a new landing page.
 *   3. meta_ad_performance_v keeps its existing columns IN ORDER and gains
 *      the new ones at the end. CREATE OR REPLACE VIEW cannot reorder, so a
 *      careless edit here fails loudly rather than silently reshaping every
 *      reader.
 *   4. wow_creatives still carries thruplays/leads -- the fields production
 *      had and this repo's migration file did NOT. That is the drift this
 *      change reconciles, and the assertion that stops it being re-dropped.
 *   5. The Ask SILO catalog description is APPENDED to, never replaced.
 *
 * Mutations (each must make this file FAIL):
 *   META_LINK_DB_MUTATION=no-together-check   (the paired-null constraint removed)
 *   META_LINK_DB_MUTATION=path-keeps-query    (link_path stops stripping ?query)
 *   META_LINK_DB_MUTATION=catalog-replaces    (the catalog description overwrites)
 *
 * Run:  node scripts/tests/meta-creative-links-database.test.mjs
 * Needs:  npm ci --prefix scripts/tests/finance-db
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const mutation = process.env.META_LINK_DB_MUTATION || '';
assert.ok(['', 'no-together-check', 'path-keeps-query', 'catalog-replaces'].includes(mutation),
  `Unknown mutation ${mutation}`);

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
const co = randomUUID();
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };
const refused = async (fn, pattern, what) => {
  await assert.rejects(fn, pattern, what); passed += 1; console.log(`ok ${passed} - refused: ${what}`);
};

await db.exec(await readFile(new URL('./finance-db/bootstrap.sql', import.meta.url), 'utf8'));
// The ad tables carry an FK to the connection that synced them. Not the
// subject here -- the real table holds live OAuth tokens and its own policies
// -- so it is a fixture, like auth/profiles in bootstrap.sql.
await db.exec(`create table public.ad_platform_connections (
  id uuid primary key, company_entity_id uuid references public.entities(id), platform text);
-- Campaign grain. Present only because the funnel-events migration widens it
-- in the same file that widens the ad-grain table; nothing here reads it.
create table public.marketing_kpis_daily (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid references public.entities(id), day_date date);`);
for (const name of [
  '20260811000000_meta_ad_creative_performance.sql',
  '20260811120000_meta_funnel_events.sql',
  '20260902000000_meta_creative_body_source.sql',
  '20260902010000_ad_level_thruplays_leads.sql',
  '20260902020000_meta_ad_performance_v_thruplays.sql',
]) await db.exec(await read('supabase/migrations/' + name));

// wow_creatives' two dependencies, stubbed: the window helper and the
// objective grouper. Both are tested where they live; here they only need to
// return the right shape so the function compiles and runs.
await db.exec(`
  create function public.wow_window(p_report_date date, p_grain text default 'week')
    returns table(s date, e date, ps date, pe date) language sql stable as $$
      select p_report_date - 6, p_report_date, p_report_date - 13, p_report_date - 7;
  $$;
  create function public.meta_campaign_group(p_name text) returns text language sql immutable as $$
    select case when p_name ilike '%purchase%' then 'purchase' else 'thruplay' end;
  $$;
`);

// A catalog row that already carries a caveat, so "appended, not replaced"
// is testable rather than assumed.
const PRIOR = 'Meta ad-level daily performance joined to creative metadata. Coverage is much shorter than campaign history; check min(day_date) first.';
await q('insert into silo_chat_schema_catalog(relname, description, keywords) values($1,$2,$3)',
  ['meta_ad_performance_v', PRIOR, ['creative', 'ad level']]);

let linkSql = await read('supabase/migrations/20260915140000_meta_creative_link_url.sql');
let wowSql = await read('supabase/migrations/20260915150000_wow_creatives_link.sql');
if (mutation === 'path-keeps-query') {
  linkSql = linkSql.replace("regexp_replace(link_url, '^https?://[^/?#]+', ''), '[?#].*$', ''",
    "regexp_replace(link_url, '^https?://[^/?#]+', ''), '(?!)', ''");
} else if (mutation === 'no-together-check') {
  linkSql = linkSql.replace('check ((link_url is null) = (link_url_source is null))', 'check (true)');
} else if (mutation === 'catalog-replaces') {
  linkSql = linkSql.replace("set description = coalesce(description, '')\n     ||", 'set description =');
}
// Applied TWICE: these run against production by hand, and a migration that
// is not re-runnable is one nobody can safely re-apply after a partial
// failure.
await db.exec(linkSql); await db.exec(linkSql);
await db.exec(wowSql); await db.exec(wowSql);

await q("insert into entities(id,title) values($1,'Test A')", [co]);

const insertCreative = (adId, fields = {}) => {
  const cols = ['company_entity_id', 'ad_id', ...Object.keys(fields)];
  const vals = [co, adId, ...Object.values(fields)];
  return q(`insert into meta_ad_creatives(${cols.join(',')})
            values(${cols.map((_, i) => '$' + (i + 1)).join(',')})`, vals);
};

await test('link_path is generated from link_url, query and fragment stripped', async () => {
  const cases = [
    ['https://baseballism.com/collections/new', '/collections/new'],
    ['https://baseballism.com/collections/new?utm_source=fb&utm_medium=paid', '/collections/new'],
    ['https://baseballism.com/products/tee#reviews', '/products/tee'],
    ['https://baseballism.com', '/'],
    ['https://baseballism.com/', '/'],
    ['https://baseballism.com/?utm_source=fb', '/'],
    ['https://www.facebook.com/123/posts/456', '/123/posts/456'],
  ];
  let n = 0;
  for (const [url, expected] of cases) {
    const adId = `path${n++}`;
    await insertCreative(adId, { link_url: url, link_url_source: 'link_data' });
    const row = await one('select link_path from meta_ad_creatives where ad_id=$1', [adId]);
    assert.equal(row.link_path, expected, `${url} -> ${row.link_path}, expected ${expected}`);
  }
});

await test('a null link_url has a null link_path, never an empty string', async () => {
  await insertCreative('nolink', { ad_name: 'no destination resolved' });
  const row = await one("select link_path, link_url, link_url_source from meta_ad_creatives where ad_id='nolink'");
  assert.equal(row.link_path, null);
  assert.equal(row.link_url, null);
  assert.equal(row.link_url_source, null);
});

await test('link_path follows link_url on update -- they cannot drift', async () => {
  await insertCreative('drift', { link_url: 'https://baseballism.com/a', link_url_source: 'link_data' });
  await q("update meta_ad_creatives set link_url='https://baseballism.com/b?x=1' where ad_id='drift'");
  const row = await one("select link_path from meta_ad_creatives where ad_id='drift'");
  assert.equal(row.link_path, '/b');
});

await refused(
  () => insertCreative('urlonly', { link_url: 'https://baseballism.com/x' }),
  /link_source_together/,
  'a url with no source',
);

await refused(
  () => insertCreative('sourceonly', { link_url_source: 'link_data' }),
  /link_source_together/,
  'a source with no url',
);

await test('meta_ad_performance_v keeps its column ORDER and appends the new ones', async () => {
  const cols = (await q(`select column_name from information_schema.columns
    where table_schema='public' and table_name='meta_ad_performance_v'
    order by ordinal_position`)).map((r) => r.column_name);
  // Verbatim from production on 2026-09-15, before this change.
  const before = ['company_entity_id', 'day_date', 'account_id', 'campaign_id', 'campaign_name',
    'adset_id', 'adset_name', 'ad_id', 'ad_name', 'impressions', 'clicks', 'spend', 'conversions',
    'conversion_value', 'view_content', 'add_to_cart', 'initiate_checkout', 'thumbnail_url',
    'creative_title', 'creative_body', 'creative_type', 'effective_status', 'thruplays', 'leads',
    'creative_body_source'];
  assert.deepEqual(cols.slice(0, before.length), before, 'existing columns must not move');
  assert.deepEqual(cols.slice(before.length),
    ['link_url', 'link_url_source', 'link_url_tags', 'link_path']);
});

await test('the view still propagates RLS to its caller', async () => {
  const opt = await one(`select reloptions from pg_class where relname='meta_ad_performance_v'`);
  assert.ok(String(opt.reloptions).includes('security_invoker=true'),
    `security_invoker lost: ${opt.reloptions}`);
});

await test('wow_creatives returns the destination beside the ad', async () => {
  await q(`insert into meta_ad_performance_daily
    (company_entity_id, account_id, day_date, campaign_id, campaign_name, ad_id, ad_name, spend, conversions, conversion_value, clicks, impressions, row_hash)
    values ($1,'act_1',current_date,'c1','Purchase — Prospecting','ad_link','Linked ad',100,2,400,50,1000,'h1')`, [co]);
  await insertCreative('ad_link', {
    link_url: 'https://baseballism.com/collections/bts?utm_campaign=bts',
    link_url_source: 'link_data', ad_name: 'Linked ad',
  });
  const out = await one('select wow_creatives(current_date,$1,50) as j', ['week']);
  const ad = out.j.groups[0].ads[0];
  assert.equal(ad.link, 'https://baseballism.com/collections/bts?utm_campaign=bts');
  assert.equal(ad.link_source, 'link_data');
  assert.equal(ad.link_path, '/collections/bts');
  assert.equal(out.j.groups[0].ads_with_link, 1, 'the group counts how many resolved a destination');
});

await test('wow_creatives still carries thruplays and leads (the prod drift)', async () => {
  // Production had these and 20260901170000 did not. Rebuilding this function
  // from the repo file alone would have deleted the Thruplays and Subscribers
  // headlines the report reads by name, with nothing in the diff to show it.
  const out = await one('select wow_creatives(current_date,$1,50) as j', ['week']);
  const g = out.j.groups[0];
  for (const k of ['thruplays', 'leads', 'cost_per_thruplay', 'cost_per_lead']) {
    assert.ok(k in g, `group lost ${k}`);
    assert.ok(k in g.ads[0], `ad lost ${k}`);
  }
});

await test('wow_creatives runs as INVOKER so company RLS still applies', async () => {
  const p = await one(`select prosecdef from pg_proc where proname='wow_creatives'`);
  assert.equal(p.prosecdef, false, 'wow_creatives must not be SECURITY DEFINER');
});

await test('the Ask SILO catalog description is appended to, not replaced', async () => {
  const row = await one("select description, keywords from silo_chat_schema_catalog where relname='meta_ad_performance_v'");
  assert.ok(row.description.startsWith(PRIOR),
    'the existing description (and its caveats) must survive');
  assert.ok(row.description.includes('link_url_source'), 'the new caveat must be present');
  assert.ok(row.keywords.includes('creative'), 'existing keywords kept');
  assert.ok(row.keywords.includes('landing page'), 'new keywords added');
});

await test('re-running the migration does not append the caveat twice', async () => {
  const row = await one("select description from silo_chat_schema_catalog where relname='meta_ad_performance_v'");
  // Counted on a phrase that appears exactly once in the appended text --
  // 'link_url_source' itself occurs twice in one append, which is how this
  // assertion first read as a double-append when it was not one.
  const hits = row.description.split('Also carries each ad').length - 1;
  assert.equal(hits, 1, `caveat appended ${hits} times`);
});

console.log(`\n${passed} assertions passed${mutation ? ` (mutation: ${mutation})` : ''}`);
await db.close();
