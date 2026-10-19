// Isolated PostgreSQL tests for claim_auto_invite / finish_auto_invite
// (supabase/migrations/*_onboarding_interest_auto_invite.sql). PGlite is one
// connection: it proves the rules, not real multi-connection interleaving; the
// advisory lock is what protects the cap there.
// Run: node scripts/tests/onboarding-interest-auto-invite-database.test.mjs
// Optional mutation: AUTO_INVITE_DB_MUTATION=no-cap|supersede|public-grant|no-revoke
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const db = new PGlite();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
const dir = new URL('../../supabase/migrations/', import.meta.url);
const files = await readdir(dir);
let sql = await readFile(new URL(files.find((f) => f.endsWith('_onboarding_interest_auto_invite.sql')), dir), 'utf8');
const queueSql = await readFile(new URL(files.find((f) => f.endsWith('_onboarding_interest_queue.sql')), dir), 'utf8');

const mutation = process.env.AUTO_INVITE_DB_MUTATION || '';
const swaps = {
  'no-cap': ['>= p_daily_cap then', '>= 1000000 then'],
  supersede: ["where lower(email) = v_email and status = 'pending' and expires_at > now()) then", 'where false) then'],
  'public-grant': ['to service_role;\ngrant execute on function public.finish', 'to service_role, anon;\ngrant execute on function public.finish'],
  'no-revoke': ["update public.platform_invites set status = 'revoked' where id = p_invite_id;", 'null;'],
};
if (mutation) { assert.ok(swaps[mutation]); const [a, b] = swaps[mutation]; assert.ok(sql.includes(a), a); sql = sql.replace(a, b); }

await db.exec(`
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth; create schema extensions;
grant usage on schema public, auth, extensions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create table auth.users(id uuid primary key);
create function extensions.gen_random_bytes(n int) returns bytea language sql volatile as
  $$ select decode(substr(md5(random()::text || clock_timestamp()::text) || md5(random()::text), 1, n * 2), 'hex') $$;
create function extensions.digest(t text, algo text) returns bytea language sql immutable as
  $$ select sha256(convert_to(t, 'UTF8')) $$;
create table public.platform_admins(user_id uuid primary key);
create function public.is_platform_admin() returns boolean language sql stable as $$ select false $$;
create table public.platform_invites (
  id uuid primary key default gen_random_uuid(), email text not null, suggested_company text,
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  invited_by uuid references auth.users(id), expires_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now());
`);
await db.exec(queueSql);
await db.exec(sql);
await db.exec(sql); // idempotent

let n = 0;
const lead = async (email, company = 'Acme') =>
  q("insert into onboarding_interest_queue(name, company_name, email) values ('Pat', $1, $2) returning id", [company, email]);
const claim = async (email, cap = 100) => (await one('select public.claim_auto_invite($1, $2) as r', [email, cap])).r;
const ok = (name) => console.log(`ok ${++n} - ${name}`);

{
  await lead('a@example.com', 'Acme Co');
  const r = await claim('A@Example.com');
  assert.equal(r.claimed, true);
  assert.equal(r.email, 'a@example.com');
  assert.equal(r.company_name, 'Acme Co');
  assert.match(r.token, /^[0-9a-f]{48}$/);
  const inv = await one('select * from platform_invites where id = $1', [r.invite_id]);
  assert.equal(inv.status, 'pending');
  assert.equal(inv.suggested_company, 'Acme Co');
  assert.equal(inv.invited_by, null);
  assert.notEqual(inv.token_hash, r.token, 'only the hash is stored');
  assert.ok((await one("select auto_invited_at from onboarding_interest_queue where email='a@example.com'")).auto_invited_at);
  ok('claims a pending lead once, stores only the token hash, stamps the lead');
}
{
  assert.deepEqual(await claim('a@example.com'), { claimed: false, reason: 'already_handled' });
  assert.deepEqual(await claim('nobody@example.com'), { claimed: false, reason: 'no_lead' });
  assert.deepEqual(await claim('', 100), { claimed: false, reason: 'invalid' });
  assert.deepEqual(await claim('a@example.com', 0), { claimed: false, reason: 'invalid' });
  assert.equal((await one('select count(*)::int c from platform_invites')).c, 1);
  ok('a repeat, an unknown address and bad input mint nothing');
}
{
  await lead('b@example.com');
  await q("update onboarding_interest_queue set status='contacted' where email='b@example.com'");
  assert.equal((await claim('b@example.com')).reason, 'already_handled');
  ok('a lead a person already handled is left alone');
}
{
  await lead('c@example.com');
  await q("insert into platform_invites(email, token_hash) values ('c@example.com', 'manualhash')");
  assert.equal((await claim('c@example.com')).reason, 'invite_exists');
  assert.equal((await one("select status from platform_invites where token_hash='manualhash'")).status, 'pending',
    'the hand-sent invite is not revoked');
  ok('never supersedes an invite a person already sent');
}
{
  // Cap: leads stamped within the last day count; older ones do not.
  await lead('d@example.com');
  await lead('e@example.com');
  assert.equal((await one("select count(*)::int c from onboarding_interest_queue where auto_invited_at > now() - interval '1 day'")).c, 1);
  assert.equal((await claim('d@example.com', 2)).claimed, true);
  assert.equal((await claim('e@example.com', 2)).reason, 'cap');
  await q("update onboarding_interest_queue set auto_invited_at = now() - interval '2 days' where email in ('a@example.com','d@example.com')");
  assert.equal((await claim('e@example.com', 2)).claimed, true);
  ok('the daily cap refuses past the limit and releases after a day');
}
{
  await lead('f@example.com');
  const r = await claim('f@example.com');
  await db.query('select public.finish_auto_invite($1, true)', [r.invite_id]);
  assert.equal((await one("select status from onboarding_interest_queue where email='f@example.com'")).status, 'contacted');
  assert.equal((await one('select status from platform_invites where id=$1', [r.invite_id])).status, 'pending');
  ok('a sent invite marks the lead contacted and stays usable');
}
{
  await lead('g@example.com');
  const r = await claim('g@example.com');
  await db.query('select public.finish_auto_invite($1, false)', [r.invite_id]);
  assert.equal((await one("select status from onboarding_interest_queue where email='g@example.com'")).status, 'pending');
  assert.equal((await one('select status from platform_invites where id=$1', [r.invite_id])).status, 'revoked');
  assert.ok((await one("select auto_invited_at from onboarding_interest_queue where email='g@example.com'")).auto_invited_at,
    'a failed send still counts toward the cap');
  await db.query('select public.finish_auto_invite($1, true)', [r.invite_id]); // already revoked: no-op
  assert.equal((await one("select status from onboarding_interest_queue where email='g@example.com'")).status, 'pending');
  ok('an unsent invite is revoked, the lead stays pending, and the cap still counts it');
}
{
  for (const role of ['anon', 'authenticated']) {
    for (const call of ["public.claim_auto_invite('a@example.com', 100)", 'public.finish_auto_invite(gen_random_uuid(), true)']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query(`select ${call}`), /permission denied/, `${role} cannot call ${call}`);
      await db.exec('reset role');
    }
  }
  await db.exec('set role service_role');
  await db.query("select public.claim_auto_invite('nobody@example.com', 100)");
  await db.exec('reset role');
  ok('only service_role can call either function');
}
console.log(`${n} auto-invite database checks passed`);
