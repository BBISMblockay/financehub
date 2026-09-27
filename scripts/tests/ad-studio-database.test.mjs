// Ad Studio's database half (20260927190000) against a REAL PostgreSQL
// (PGlite), as authenticated users -- not a mock, not the service role.
//
// What it proves:
//   1. ad_studio_ads() returns SUMS for the caller's company only, over a
//      window that ends on the newest INGESTED day (not today); an ad with no
//      spend in the window is absent; never-measured thruplays stay NULL;
//      recent_* is the window's last 14 days and early_* the ad's own first 14
//      days of delivery; the objective comes from meta_campaign_group().
//   2. An archived image is returned only while it belongs to the creative the
//      ad runs now, and image_shared_by counts the OTHER ads using it.
//   3. The private bucket's only policy is the parent-row EXISTS: a member
//      reads an object their company's creative names, and nothing else.
//   4. The image columns keep their shape and travel together.
//   5. ad_ideas: company-scoped, created_by cannot be spoofed, the bar
//      (baseline_snapshot) is frozen once set, a live idea names its ads,
//      approval is stamped by the database, and delete is creator-or-admin.
//
// Run:  node scripts/tests/ad-studio-database.test.mjs
// Needs: npm ci --prefix scripts/tests/finance-db
// Mutations (each must fail at least one assertion):
//   AD_STUDIO_DB_MUTATION=policy-bucket-only   (storage policy drops the parent-row EXISTS)
//   AD_STUDIO_DB_MUTATION=snapshot-thaws       (baseline_snapshot can be rewritten)
//   AD_STUDIO_DB_MUTATION=stale-image-shown    (an image of a replaced creative is returned)
//   AD_STUDIO_DB_MUTATION=approval-from-client (approved_by is taken from the client)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const mutation = process.env.AD_STUDIO_DB_MUTATION || '';
assert.ok(['', 'policy-bucket-only', 'snapshot-thaws', 'stale-image-shown', 'approval-from-client'].includes(mutation),
  `Unknown mutation ${mutation}`);

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
const co = randomUUID(), otherCo = randomUUID();
const member = randomUUID(), admin = randomUUID(), outsider = randomUUID();
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`not ok - ${name}`); throw e; }
};
async function asUser(user, fn) {
  await db.exec('set role authenticated');
  await q("select set_config('request.jwt.claim.sub', $1, false)", [user]);
  try { return await fn(); }
  finally { await db.exec('reset role'); await q("select set_config('request.jwt.claim.sub', '', false)"); }
}
async function refused(fn, pattern, what) {
  let msg = null;
  try { await fn(); } catch (e) { msg = e.message; }
  assert.ok(msg !== null, `${what}: expected a refusal`);
  assert.match(msg, pattern, `${what}: ${msg}`);
}

// ── Foundation: the SEO bootstrap (auth, profiles, companies, the catalog with
// its real columns) plus Supabase's storage tables, then the real migrations.
await db.exec(await readFile(new URL('./seo-db-bootstrap.sql', import.meta.url), 'utf8'));
await db.exec(`
  create schema if not exists storage;
  create table storage.buckets (id text primary key, name text not null, public boolean not null default false);
  create table storage.objects (id uuid primary key default gen_random_uuid(),
    bucket_id text not null references storage.buckets(id), name text not null, owner uuid);
  alter table storage.objects enable row level security;
  grant usage on schema storage to authenticated, anon;
  grant select, insert, update, delete on storage.objects to authenticated;
  grant select on storage.buckets to authenticated;
  create table if not exists public.marketing_kpis_daily (
    id uuid primary key default gen_random_uuid(),
    company_entity_id uuid references public.entities(id), day_date date);
`);
for (const name of [
  '20260616060000_stamp_company_entity_id_on_insert.sql',
  '20260811000000_meta_ad_creative_performance.sql',
  '20260811120000_meta_funnel_events.sql',
  '20260902000000_meta_creative_body_source.sql',
  '20260902010000_ad_level_thruplays_leads.sql',
  '20260915140000_meta_creative_link_url.sql',
  '20260923150000_meta_creative_preview_link.sql',
]) {
  try { await db.exec(await read('supabase/migrations/' + name)); }
  catch (e) { throw new Error(`${name}: ${e.message}`); }
}
// meta_campaign_group's production body (20260901160000). That migration also
// patches wow_paid_media in place, which has no place in this fixture.
await db.exec(`
create or replace function public.meta_campaign_group(p_name text)
returns text language sql immutable as $$
  select case
    when coalesce(p_name,'') ~* '(thru.?play|video.?view|upper.?funnel|awareness|brand.?promotion)' then 'thruplay'
    when coalesce(p_name,'') ~* '\\mfollowers?\\M' then 'followers'
    when coalesce(p_name,'') ~* '(subscriber|follower|sign.?up|opt.?in|\\msms\\M|email|activation|\\mlead)' then 'subscribers'
    when coalesce(p_name,'') ~* '(traffic|landing.?page|link.?click|\\mlpv\\M|page.?view)' then 'traffic'
    when coalesce(p_name,'') ~* '(purchase|conversion|\\msale|catalog|dpa|retarget|prospect|advantage)' then 'purchase'
    else 'other'
  end;
$$;`);

let sql = await read('supabase/migrations/20260927190000_ad_studio.sql');
const swap = (from, to) => { assert.ok(sql.includes(from), `mutation anchor missing: ${from.slice(0, 60)}`); sql = sql.replace(from, to); };
if (mutation === 'policy-bucket-only') {
  swap(`and exists (select 1 from public.meta_ad_creatives c
                 where c.image_path = name)`, '');
} else if (mutation === 'snapshot-thaws') {
  swap("if old.baseline_snapshot is not null and new.baseline_snapshot is distinct from old.baseline_snapshot then",
    'if false then');
} else if (mutation === 'stale-image-shown') {
  sql = sql.replaceAll('case when c.image_creative_id is not distinct from c.creative_id then', 'case when true then');
} else if (mutation === 'approval-from-client') {
  swap(`  else
    new.approved_by := old.approved_by;
    new.approved_at := old.approved_at;
  end if;`, '  end if;');
}
// Applied TWICE: it runs against production by hand, and a migration nobody
// can safely re-run after a partial failure is one nobody will re-run.
await db.exec(sql); await db.exec(sql);

// ── Fixtures ────────────────────────────────────────────────────────────────
await q("insert into entities(id,title) values ($1,'Co'),($2,'Other')", [co, otherCo]);
await q('insert into auth.users(id) values ($1),($2),($3)', [member, admin, outsider]);
await q(`insert into profiles(id,name,role,active_company_id) values
  ($1,'Member','user',$4),($2,'Admin','admin',$4),($3,'Outsider','user',$5)`, [member, admin, outsider, co, otherCo]);
await q(`insert into entity_memberships(entity_id,user_id,role) values ($1,$2,'member'),($1,$3,'admin'),($4,$5,'member')`,
  [co, member, admin, otherCo, outsider]);

const THROUGH = '2026-09-20';
const day = (n) => { const d = new Date(`${THROUGH}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
async function perf(company, adId, dayDate, f) {
  await q(`insert into meta_ad_performance_daily
    (company_entity_id, account_id, day_date, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name,
     impressions, clicks, spend, conversions, conversion_value, thruplays, leads, row_hash)
    values ($1,'act',$2,'c',$3,'s','Set',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
  [company, dayDate, f.campaign, adId, f.name || adId, f.imp, f.clk, f.spend, f.conv ?? 0, f.value ?? 0,
    f.thruplays ?? null, f.leads ?? null, randomUUID()]);
}
// A: purchase ad, delivered 40 days, the last 5 inside "recent".
for (let n = 0; n < 40; n += 1) {
  await perf(co, 'A', day(n), { campaign: 'Prospecting Purchase', imp: 1000, clk: n < 14 ? 5 : 20, spend: 10, conv: 1, value: 40 });
}
// B: thruplay ad inside the window, measured on thruplays.
await perf(co, 'B', day(3), { campaign: 'Upper Funnel Thruplay', imp: 5000, clk: 10, spend: 50, thruplays: 900 });
// C: spent only BEFORE a 30-day window.
await perf(co, 'C', day(60), { campaign: 'Purchase', imp: 100, clk: 1, spend: 5 });
// D: in the window but never spent.
await perf(co, 'D', day(2), { campaign: 'Purchase', imp: 10, clk: 0, spend: 0 });
// Another company's ad, newer than anything here: must not move our window.
await perf(otherCo, 'X', '2026-09-26', { campaign: 'Purchase', imp: 10, clk: 1, spend: 99 });

const SHA = 'a'.repeat(64), SHA2 = 'b'.repeat(64);
const path = (c, s) => `${c}/${s}.jpg`;
async function creative(company, adId, f = {}) {
  await q(`insert into meta_ad_creatives (company_entity_id, ad_id, creative_id, object_type, body,
      image_path, image_sha256, image_width, image_height, image_creative_id, image_archived_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [company, adId, f.creative ?? `cr-${adId}`, f.type ?? 'PHOTO', f.body ?? null,
    f.sha ? path(company, f.sha) : null, f.sha ?? null, f.sha ? 1080 : null, f.sha ? 1080 : null,
    f.sha ? (f.imageCreative ?? f.creative ?? `cr-${adId}`) : null, f.sha ? new Date().toISOString() : null]);
}
await creative(co, 'A', { sha: SHA, body: 'Hook line' });
await creative(co, 'B', { sha: SHA2, creative: 'cr-B-v2', imageCreative: 'cr-B-v1', type: 'VIDEO' });
await creative(co, 'T1', { sha: SHA });
await creative(co, 'T2', { sha: SHA });
await creative(otherCo, 'X', { sha: SHA });
await q("insert into storage.objects(bucket_id,name) values ('ad-creative-images',$1),('ad-creative-images',$2),('ad-creative-images',$3),('ad-creative-images',$4)",
  [path(co, SHA), path(co, SHA2), path(otherCo, SHA), `${co}/${'c'.repeat(64)}.jpg`]);

// ── 1. ad_studio_ads ────────────────────────────────────────────────────────
await test('ad_studio_ads: sums for the caller\'s company over a window ending on the newest ingested day', async () => {
  const rows = await asUser(member, () => q('select * from ad_studio_ads(30)'));
  const ids = rows.map((r) => r.ad_id).sort();
  assert.deepEqual(ids, ['A', 'B'], 'C spent only before the window, D never spent, X is another company');
  const a = rows.find((r) => r.ad_id === 'A');
  assert.equal(new Date(a.data_through).toISOString().slice(0, 10), THROUGH,
    'the window ends on our newest day, not the other company\'s');
  assert.equal(new Date(a.window_start).toISOString().slice(0, 10), day(29), '30 days inclusive');
  assert.equal(Number(a.spend), 300, '30 days x $10');
  assert.equal(Number(a.impressions), 30000);
  assert.equal(Number(a.conversion_value), 1200);
  assert.equal(a.objective, 'purchase');
  assert.equal(a.thruplays, null, 'never measured stays NULL, never 0');
  assert.equal(Number(a.recent_spend), 140, 'the window\'s last 14 days');
  assert.equal(Number(a.recent_clicks), 70);
  assert.equal(Number(a.early_impressions), 14000, 'the ad\'s own first 14 days of delivery, before the window too');
  assert.equal(Number(a.early_clicks), 280);
  assert.equal(a.body, 'Hook line');
  const b = rows.find((r) => r.ad_id === 'B');
  assert.equal(b.objective, 'thruplay');
  assert.equal(Number(b.thruplays), 900);
});

await test('ad_studio_ads: an image is returned only for the creative the ad runs now; shared_by counts the others', async () => {
  const rows = await asUser(member, () => q('select ad_id, image_path, image_shared_by from ad_studio_ads(30)'));
  const a = rows.find((r) => r.ad_id === 'A');
  assert.equal(a.image_path, path(co, SHA));
  assert.equal(a.image_shared_by, 2, 'T1 and T2 use the same file; the other company\'s copy is not counted');
  const b = rows.find((r) => r.ad_id === 'B');
  assert.equal(b.image_path, null, 'B was edited to cr-B-v2; the stored image is cr-B-v1\'s');
});

await test('ad_studio_ads: anon cannot call it; the outsider sees only their own company', async () => {
  await db.exec('set role anon');
  try { await refused(() => q('select * from ad_studio_ads(30)'), /permission denied/, 'anon'); }
  finally { await db.exec('reset role'); }
  const rows = await asUser(outsider, () => q('select ad_id from ad_studio_ads(365)'));
  assert.deepEqual(rows.map((r) => r.ad_id), ['X']);
});

// ── 2. The private bucket ───────────────────────────────────────────────────
await test('bucket is private and a member reads only objects their company\'s creatives name', async () => {
  assert.equal((await one("select public from storage.buckets where id='ad-creative-images'")).public, false);
  const mine = await asUser(member, () => q("select name from storage.objects where bucket_id='ad-creative-images' order by name"));
  assert.deepEqual(mine.map((r) => r.name).sort(), [path(co, SHA), path(co, SHA2)].sort(),
    'the other company\'s object and an object no creative names are invisible');
  const theirs = await asUser(outsider, () => q("select name from storage.objects where bucket_id='ad-creative-images'"));
  assert.deepEqual(theirs.map((r) => r.name), [path(otherCo, SHA)]);
});

await test('no client can write to the bucket', async () => {
  await refused(() => asUser(admin, () => q("insert into storage.objects(bucket_id,name) values ('ad-creative-images',$1)", [path(co, 'd'.repeat(64))])),
    /row-level security/, 'insert');
  const del = await asUser(admin, () => q("delete from storage.objects where name=$1 returning id", [path(co, SHA)]));
  assert.equal(del.length, 0, 'delete removes nothing');
});

await test('image columns keep their shape and travel together', async () => {
  await refused(() => q("update meta_ad_creatives set image_path='../../etc/x.jpg' where ad_id='A'"), /image_path_shape/, 'path shape');
  await refused(() => q("update meta_ad_creatives set image_sha256=null where ad_id='A'"), /image_together/, 'path without hash');
  await refused(() => q("update meta_ad_creatives set image_archived_at=null where ad_id='A'"), /image_together/, 'path without time');
});

await test('clients still cannot write meta_ad_creatives (the image columns are the sync\'s)', async () => {
  const upd = await asUser(admin, () => q("update meta_ad_creatives set image_error='x' where ad_id='A' returning ad_id"));
  assert.equal(upd.length, 0);
});

// ── 3. ad_ideas ─────────────────────────────────────────────────────────────
const snapshot = { objective: 'purchase', metric: 'roas', value: 4, spend: 300, conversion_value: 1200, ad_ids: ['A'] };
let ideaId;
await test('a member files an idea for their own company; created_by is theirs and approval is empty', async () => {
  const row = await asUser(member, () => one(`insert into ad_ideas (company_entity_id, title, hook, baseline_ad_ids, baseline_snapshot, source)
    values ($1, 'Gus hoodie, new hook', 'It is hoodie weather', array['A'], $2, 'from_ad') returning *`, [co, snapshot]));
  ideaId = row.id;
  assert.equal(row.created_by, member);
  assert.equal(row.status, 'idea');
  assert.equal(row.approved_by, null);
});

await test('an idea cannot be filed for another company or as someone else', async () => {
  await refused(() => asUser(member, () => q("insert into ad_ideas (company_entity_id, title) values ($1,'x')", [otherCo])),
    /row-level security/, 'other company');
  await refused(() => asUser(member, () => q("insert into ad_ideas (company_entity_id, title, created_by) values ($1,'x',$2)", [co, admin])),
    /row-level security/, 'spoofed created_by');
});

await test('the outsider cannot see or touch it', async () => {
  assert.equal((await asUser(outsider, () => q('select id from ad_ideas'))).length, 0);
  assert.equal((await asUser(outsider, () => q("update ad_ideas set title='x' returning id"))).length, 0);
});

await test('the bar is frozen once set', async () => {
  await refused(() => asUser(admin, () => q("update ad_ideas set baseline_snapshot = $2 where id=$1", [ideaId, { ...snapshot, value: 1 }])),
    /frozen/, 'rewriting the bar');
  await refused(() => asUser(admin, () => q("update ad_ideas set baseline_ad_ids = array['B'] where id=$1", [ideaId])),
    /frozen with the bar/, 'swapping the baselines under the bar');
});

await test('approval is stamped by the database, not taken from the client', async () => {
  const row = await asUser(admin, () => one("update ad_ideas set status='approved', approved_by=$2 where id=$1 returning *", [ideaId, member]));
  assert.equal(row.approved_by, admin, 'whoever approved it, not the value sent');
  assert.ok(row.approved_at);
  const moved = await asUser(member, () => one("update ad_ideas set status='in_production', approved_by=$2 where id=$1 returning *", [ideaId, member]));
  assert.equal(moved.approved_by, admin, 'moving on keeps who approved it, whatever the client sends');
});

await test('a live idea must name the ads that carry it', async () => {
  await refused(() => asUser(member, () => q("update ad_ideas set status='live' where id=$1", [ideaId])), /live_names_ads/, 'live with no ads');
  const row = await asUser(member, () => one("update ad_ideas set status='live', live_ad_ids=array['B'] where id=$1 returning status", [ideaId]));
  assert.equal(row.status, 'live');
});

await test('an idea cannot change company, creator or creation time', async () => {
  await refused(() => q('update ad_ideas set company_entity_id=$2 where id=$1', [ideaId, otherCo]), /another company/, 'company');
  await refused(() => q('update ad_ideas set created_by=$2 where id=$1', [ideaId, admin]), /fixed/, 'creator');
});

await test('delete: another member cannot; the creator or an admin can', async () => {
  const other = await asUser(admin, () => one("insert into ad_ideas (company_entity_id, title) values ($1,'Admin idea') returning id", [co]));
  const blocked = await asUser(member, () => q('delete from ad_ideas where id=$1 returning id', [other.id]));
  assert.equal(blocked.length, 0, 'a member cannot delete someone else\'s idea');
  const byAdmin = await asUser(admin, () => q('delete from ad_ideas where id=$1 returning id', [ideaId]));
  assert.equal(byAdmin.length, 1, 'an admin can');
});

await test('Ask SILO\'s catalog knows the idea bank', async () => {
  const row = await one("select description, columns from silo_chat_schema_catalog where relname='ad_ideas'");
  assert.match(row.description, /FROZEN/);
  assert.equal((row.description.match(/Ad Studio's idea bank/g) || []).length, 1, 'applied twice, described once');
  assert.ok(row.columns.length > 5, 'the refresh gave it columns');
});

await test('verify_v2_schema.sql\'s ad_studio check reads ok on this schema', async () => {
  const verify = await read('supabase/verify_v2_schema.sql');
  const start = verify.indexOf('-- ── Ad Studio (20260927190000)');
  const end = verify.indexOf('end as ad_studio;', start);
  assert.ok(start > 0 && end > start, 'the check exists');
  const block = verify.slice(start, end + 'end as ad_studio;'.length);
  const row = await one(block.slice(block.indexOf('select')));
  assert.equal(row.ad_studio, 'ok');
});

console.log(`\n${passed} passed`);
