// scripts/tests/affiliate-content-offers-database.test.mjs
//
// Content offers and post numbers (20261125230000) on real PostgreSQL
// (PGlite), applied TWICE because apply_all_post_merge.sql re-runs every
// migration.
//
// What this proves:
//   A  only a payout approver in the active company makes or withdraws an offer
//   B  nothing is owed until the affiliate accepts: then one ledger line, the
//      post is used, and a replay pays nothing more
//   C  declining, a withdrawn offer, and a decision on the post after the
//      offer each leave nothing payable
//   D  the token decides whose post it is: another affiliate's link, a view-as
//      link and an expired link are refused; the portal read hides a dead offer
//   E  grants and the stats shape: anon cannot offer, clients cannot answer,
//      a thumbnail from any other host is refused
//
// Mutations (CI runs each and requires the suite to FAIL):
//   CONTENT_OFFER_DB_MUTATION=anongrant   anon keeps Supabase's default EXECUTE on the offer
//   CONTENT_OFFER_DB_MUTATION=nomoney     the payout approval gate on an offer is dropped
//   CONTENT_OFFER_DB_MUTATION=overtaken   a decision after the offer no longer voids it
//   CONTENT_OFFER_DB_MUTATION=paytwice    a replayed accept writes a second ledger line
//   CONTENT_OFFER_DB_MUTATION=preview     a view-as (preview) link can accept
//   CONTENT_OFFER_DB_MUTATION=anyhost     the thumbnail host check is dropped

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUT = process.env.CONTENT_OFFER_DB_MUTATION || '';
const db = new PGlite();

const CO_A = '11111111-1111-1111-1111-111111111111';
const CO_B = '22222222-2222-2222-2222-222222222222';
const PROG = '33333333-3333-3333-3333-333333333333';
const AFF = '44444444-4444-4444-4444-444444444444';
const AFF2 = '55555555-5555-5555-5555-555555555555';
const MGR = '99999999-9999-9999-9999-999999999999';
const P1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const P2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const P3 = 'aaaaaaaa-0000-0000-0000-000000000003';
const P4 = 'aaaaaaaa-0000-0000-0000-000000000004';
const PB = 'bbbbbbbb-0000-0000-0000-000000000001';

await db.exec(`
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql as
  $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create function active_company_id() returns uuid language sql as
  $$ select nullif(current_setting('test.company', true), '')::uuid $$;
create function can_manage_affiliate_programs() returns boolean language sql as
  $$ select coalesce(current_setting('test.mgr', true), '') = 'yes' $$;
create function can_approve_affiliate_commissions() returns boolean language sql as
  $$ select coalesce(current_setting('test.money', true), '') = 'yes' $$;
create function refresh_chat_schema_catalog() returns void language sql as $$ select $$;
create table profiles(id uuid primary key);
insert into profiles values ('${MGR}');
create table affiliate_programs(id uuid primary key, company_entity_id uuid not null, currency text, content_bonus_cents bigint);
create table affiliates(id uuid primary key, company_entity_id uuid not null, program_id uuid, status text);
create table affiliate_access_tokens(token_hash text primary key, company_entity_id uuid, program_id uuid, affiliate_id uuid,
  purpose text, revoked_at timestamptz, expires_at timestamptz);
create table affiliate_commission_ledger(id uuid primary key default gen_random_uuid(), company_entity_id uuid, program_id uuid,
  affiliate_id uuid, kind text, source text, amount_cents bigint, currency text, memo text, created_by uuid);
create table affiliate_content_submissions(
  id uuid primary key, company_entity_id uuid not null, program_id uuid not null, affiliate_id uuid not null,
  kind text not null, storage_path text, file_type text, link_url text, caption text,
  state text not null default 'submitted', bonus_cents bigint, currency text,
  bonus_ledger_id uuid references affiliate_commission_ledger(id),
  submitted_at timestamptz not null default now(), decided_at timestamptz, decided_by uuid,
  constraint affiliate_content_bonus check (
    (bonus_ledger_id is null and bonus_cents is null)
    or (bonus_ledger_id is not null and bonus_cents > 0 and currency ~ '^[A-Z]{3}$' and state = 'used')));
alter table affiliate_content_submissions enable row level security;
create policy s on affiliate_content_submissions for select using (company_entity_id = active_company_id());
grant select on all tables in schema public to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
insert into affiliate_programs values ('${PROG}', '${CO_A}', 'USD', 2500);
insert into affiliates values ('${AFF}', '${CO_A}', '${PROG}', 'active'), ('${AFF2}', '${CO_A}', '${PROG}', 'active');
insert into affiliate_access_tokens values
  ('tok', '${CO_A}', '${PROG}', '${AFF}', 'portal', null, now() + interval '1 day'),
  ('tok2', '${CO_A}', '${PROG}', '${AFF2}', 'portal', null, now() + interval '1 day'),
  ('view', '${CO_A}', '${PROG}', '${AFF}', 'preview', null, now() + interval '1 day'),
  ('old', '${CO_A}', '${PROG}', '${AFF}', 'portal', null, now() - interval '1 day');
insert into affiliate_content_submissions (id, company_entity_id, program_id, affiliate_id, kind, link_url, caption) values
  ('${P1}', '${CO_A}', '${PROG}', '${AFF}', 'link', 'https://www.youtube.com/watch?v=abc', 'Reel'),
  ('${P2}', '${CO_A}', '${PROG}', '${AFF}', 'link', 'https://www.tiktok.com/@a/video/1', null),
  ('${P3}', '${CO_A}', '${PROG}', '${AFF}', 'link', 'https://x.test/3', null),
  ('${P4}', '${CO_A}', '${PROG}', '${AFF}', 'link', 'https://x.test/4', null),
  ('${PB}', '${CO_B}', '${PROG}', '${AFF}', 'link', 'https://x.test/b', null);
`);

let sql = await readFile(new URL('../../supabase/migrations/20261125230000_affiliate_content_offers_stats.sql', import.meta.url), 'utf8');
// PGlite has no profiles FK target issue; the file's FK is kept as written.
function mutate(from, to) {
  assert.ok(sql.includes(from), `mutation ${MUT}: pattern not found`);
  sql = sql.split(from).join(to);
}
switch (MUT) {
  case '': break;
  case 'anongrant': mutate('revoke all on function public.affiliate_content_offer(uuid, bigint) from public, anon;', 'revoke all on function public.affiliate_content_offer(uuid, bigint) from public;'); break;
  case 'nomoney': mutate('  if not public.can_approve_affiliate_commissions() then\n    raise exception \'affiliate_content_offer', '  if false then\n    raise exception \'affiliate_content_offer'); break;
  case 'overtaken': mutate("     or (v_c.decided_at is not null and v_c.decided_at > v_c.offered_at) then\n    raise exception 'affiliate_portal_content_answer", "     then\n    raise exception 'affiliate_portal_content_answer"); break;
  case 'paytwice': mutate("  if v_c.offer_state in ('accepted', 'declined') then\n    return", "  if v_c.offer_state = 'declined' then\n    return");
    mutate("  if v_c.offer_state is distinct from 'open' or v_c.state not in ('submitted', 'approved')", "  if v_c.offer_state not in ('open', 'accepted')"); break;
  case 'preview': mutate("   where t.token_hash = p_token_hash and t.purpose = 'portal'\n     and t.revoked_at is null and t.expires_at > now() and t.affiliate_id is not null\n     and a.status = 'active';", "   where t.token_hash = p_token_hash and t.purpose in ('portal', 'preview')\n     and t.revoked_at is null and t.expires_at > now() and t.affiliate_id is not null\n     and a.status = 'active';"); break;
  case 'anyhost': mutate("(thumbnail_url is null or thumbnail_url ~ '^https://i[0-9]?\\.ytimg\\.com/[A-Za-z0-9_./-]{1,200}$')", '(true)'); break;
  default: throw new Error(`unknown mutation ${MUT}`);
}
await db.exec(sql);
await db.exec(sql);   // apply_all re-runs it

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAILED: ${name}\n`, e); process.exit(1); }
}
async function as(role, { company = CO_A, mgr = true, money = true } = {}, fn) {
  await db.exec(`set test.uid = '${MGR}'; set test.company = '${company || ''}'; set test.mgr = '${mgr ? 'yes' : 'no'}'; set test.money = '${money ? 'yes' : 'no'}'; set role ${role};`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}
const refused = async (fn) => { try { await fn(); return false; } catch { return true; } };
const offer = (id, cents) => db.query('select public.affiliate_content_offer($1::uuid, $2::bigint) as r', [id, cents]);
const answer = (tok, id, yes) => as('service_role', {}, () => db.query('select public.affiliate_portal_content_answer($1, $2::uuid, $3) as r', [tok, id, yes]));
const row = async (id) => (await db.query(`select * from affiliate_content_submissions where id = '${id}'`)).rows[0];
const ledger = async () => (await db.query(`select * from affiliate_commission_ledger order by amount_cents`)).rows;
await db.exec('grant execute on all functions in schema public to service_role; grant select on all tables in schema public to service_role;');

await test('A: only a payout approver in the active company makes or withdraws an offer', async () => {
  assert.ok(await as('authenticated', { money: false }, () => refused(() => offer(P1, 35000))), 'a manager without payout approval');
  assert.ok(await as('authenticated', { mgr: false }, () => refused(() => offer(P1, 35000))), 'not a Studio manager');
  assert.ok(await as('authenticated', {}, () => refused(() => offer(PB, 35000))), "another company's post");
  assert.ok(await as('authenticated', {}, () => refused(() => offer(P1, 0))), 'no amount');
  assert.equal((await row(P1)).offer_state, null);
  const r = (await as('authenticated', {}, () => offer(P1, 35000))).rows[0].r;
  assert.equal(r.offer_state, 'open');
  const p = await row(P1);
  assert.equal(Number(p.offer_cents), 35000); assert.equal(p.offer_currency, 'USD', 'the program currency');
  assert.equal(p.offered_by, MGR);
  assert.equal((await ledger()).length, 0, 'an offer owes nothing yet');
});

await test('B: accepting writes one ledger line and uses the post; a replay pays nothing more', async () => {
  const r = (await answer('tok', P1, true)).rows[0].r;
  assert.equal(r.offer_state, 'accepted');
  const p = await row(P1);
  assert.equal(p.state, 'used'); assert.equal(Number(p.bonus_cents), 35000); assert.ok(p.bonus_ledger_id);
  assert.equal(p.decided_by, MGR, 'the person who made the offer decided it');
  const l = await ledger();
  assert.equal(l.length, 1); assert.equal(Number(l[0].amount_cents), 35000); assert.equal(l[0].kind, 'manual_adjustment'); assert.equal(l[0].created_by, MGR);
  const again = (await answer('tok', P1, true)).rows[0].r;
  assert.equal(again.offer_state, 'accepted', 'a replay answers the same');
  assert.equal((await ledger()).length, 1, 'and pays nothing more');
  assert.ok(await as('authenticated', {}, () => refused(() => offer(P1, 100))), 'a bought post takes no new offer');
});

await test('C: declined, withdrawn and overtaken offers leave nothing payable', async () => {
  await as('authenticated', {}, () => offer(P2, 1000));
  assert.equal((await answer('tok', P2, false)).rows[0].r.offer_state, 'declined');
  assert.ok(await refused(() => answer('tok', P2, true)) || (await row(P2)).state !== 'used', 'a declined offer cannot be accepted after');
  assert.equal((await row(P2)).state, 'submitted');

  await as('authenticated', {}, () => offer(P3, 1000));
  assert.equal((await as('authenticated', {}, () => offer(P3, null))).rows[0].r.offer_state, 'withdrawn');
  assert.ok(await refused(() => answer('tok', P3, true)), 'a withdrawn offer');

  await as('authenticated', {}, () => offer(P4, 1000));
  // The brand judges the post again after offering (here: Not used, then Keep after all).
  await db.exec(`update affiliate_content_submissions set state = 'approved', decided_at = now() + interval '1 minute' where id = '${P4}'`);
  assert.ok(await refused(() => answer('tok', P4, true)), 'a decision after the offer voids it');
  assert.equal((await ledger()).length, 1, 'still only the one accepted offer');
});

await test('D: the token decides whose post it is; the portal read hides a dead offer', async () => {
  await db.exec(`update affiliate_content_submissions set decided_at = null where id = '${P4}'`);
  assert.ok(await refused(() => answer('tok2', P4, true)), "another affiliate's link");
  assert.ok(await refused(() => answer('view', P4, true)), 'a view-as link is read-only');
  assert.ok(await refused(() => answer('old', P4, true)), 'an expired link');
  const read = (await as('service_role', {}, () => db.query("select public.affiliate_portal_content('tok') as r"))).rows[0].r;
  const by = Object.fromEntries(read.items.map((x) => [x.id, x]));
  assert.equal(by[P1].offer_state, 'accepted'); assert.equal(by[P2].offer_state, 'declined');
  assert.equal(by[P3].offer_state, null, 'withdrawn is not shown'); assert.equal(by[P3].offer_cents, null);
  assert.equal(by[P4].offer_state, 'open', 'still open once nothing overtook it');
  await db.exec(`update affiliate_content_submissions set decided_at = now() + interval '1 minute' where id = '${P4}'`);
  const read2 = (await as('service_role', {}, () => db.query("select public.affiliate_portal_content('view') as r"))).rows[0].r;
  assert.equal(read2.items.find((x) => x.id === P4).offer_state, null, 'an overtaken offer is not shown as open');
});

await test('E: grants and the stats shape', async () => {
  const r = await db.query(`select has_function_privilege('anon', 'public.affiliate_content_offer(uuid,bigint)', 'execute') a,
    has_function_privilege('authenticated', 'public.affiliate_portal_content_answer(text,uuid,boolean)', 'execute') b,
    has_function_privilege('anon', 'public.affiliate_portal_content_answer(text,uuid,boolean)', 'execute') c,
    has_function_privilege('authenticated', 'public.affiliate_portal_content(text)', 'execute') d`);
  assert.equal(r.rows[0].a, false, 'anon cannot offer');
  assert.equal(r.rows[0].b, false, 'a signed-in client cannot answer for an affiliate');
  assert.equal(r.rows[0].c, false);
  assert.equal(r.rows[0].d, false, 'the portal read stays service-role only');
  await db.exec(`update affiliate_content_submissions set thumbnail_url = 'https://i.ytimg.com/vi/abc/hqdefault.jpg', view_count = 1200, stats_source = 'youtube_api' where id = '${P1}'`);
  assert.ok(await refused(() => db.exec(`update affiliate_content_submissions set thumbnail_url = 'https://evil.test/x.jpg' where id = '${P1}'`)), 'only the platform image host');
  assert.ok(await refused(() => db.exec(`update affiliate_content_submissions set view_count = -1 where id = '${P1}'`)), 'no negative counts');
});

await test('F: the verify check reads ok on the applied schema', async () => {
  const v = await readFile(new URL('../../supabase/verify_v2_schema.sql', import.meta.url), 'utf8');
  const block = v.slice(v.indexOf('-- Content offers and post numbers (20261125230000)'), v.indexOf('-- End affiliate content offer checks.'));
  assert.ok(block.includes("select 'Affiliate content offers'"), 'the check is in verify_v2_schema.sql');
  const r = await db.query(block);
  assert.equal(r.rows[0].status, 'ok', r.rows[0].status);
});

console.log(`\naffiliate-content-offers-database: ${passed} passed`);
