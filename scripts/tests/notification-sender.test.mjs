// A notification says who it is from, and a reply reaches the TENANT.
//
// Before this migration all ten mail functions held one global constant
// (`SILO_MAIL_FROM`, default `SILO <noreply@silo-baseballism.com>`) and NINE of
// the ten set no Reply-To at all. A global env string cannot carry a per-tenant
// display name, so the sender identity is resolved at send time instead.
//
// The property that matters is the LAST rung of the fallback chain: an
// unconfigured tenant must never make SILO the reply desk. That is the whole
// reason this table exists, and it is the one thing a plausible-looking
// implementation gets wrong -- omitting Reply-To looks harmless and silently
// routes every reply about an invoice to notifications@get-silo.com.
//
// Mutations (each must make a specific assertion fail):
//   SENDER_MUTATION=fallback-to-silo  (last rung falls back to a SILO address)
//   SENDER_MUTATION=no-purpose        (rung 1 skipped, everything gets general_ops)
//   SENDER_MUTATION=no-sanitize       (company title goes into the header raw)
//   SENDER_MUTATION=write-open        (any member may rewrite where replies go)
//   SENDER_MUTATION=verify-weak       (the VERIFIER goes back to matching the bare
//                                      table name, which the owner-admin fallback
//                                      also contains -- the false negative the
//                                      additional review found)
//   SENDER_MUTATION=cross-tenant-open (the resolver stops checking the caller's
//                                      own memberships -- a DEFINER function
//                                      taking a company id is an RLS bypass
//                                      unless it re-checks; found by the
//                                      independent review on PR #745)
//
// Run: node scripts/tests/notification-sender.test.mjs
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', (e && e.message) || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { splitSqlStatements } from '../lib/sql-statements.mjs';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const mutation = process.env.SENDER_MUTATION || '';
assert.ok(['', 'fallback-to-silo', 'no-purpose', 'no-sanitize', 'write-open',
  'cross-tenant-open', 'verify-weak'].includes(mutation),
  `Unknown mutation: ${mutation}`);

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

async function as(user, fn, role = 'authenticated') {
  await db.exec('set role ' + role);
  await q("select set_config('request.jwt.claim.sub',$1,false)", [user || '']);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const resolve = (company, purpose, actor = null) =>
  one('select * from public.resolve_notification_sender($1,$2,$3)', [company, purpose, actor]);

const owner = randomUUID();
const member = randomUUID();
const admin = randomUUID();
const company = randomUUID();

await db.exec(await readFile(new URL('./onboarding-db-bootstrap.sql', import.meta.url), 'utf8'));

// is_admin_user() verbatim from production (pg_proc, 2026-09-20); the bootstrap
// ships is_admin() but not this one. The stamp helper is stubbed because the
// migration ends by calling it and PGlite has no such table set.
await db.exec(`
  create function public.is_admin_user() returns boolean
  language sql stable security definer set search_path to 'public','pg_temp' as $f$
    select exists (
      select 1 from public.profiles p
      left join public.entity_memberships em
        on em.user_id = p.id and em.entity_id = p.active_company_id
      where p.id = auth.uid() and p.is_active = true
        and case when em.role is not null then em.role in ('owner_admin','admin')
                 else p.role::text in ('owner','admin') end);
  $f$;
  create function public.attach_stamp_company_entity_id_triggers() returns void
  language sql as $f$ select null::void $f$;
`);

await q(`insert into auth.users(id,email) values ($1,'owner@tenant.com'),($2,'rachel@tenant.com'),($3,'ops@tenant.com')`,
  [owner, member, admin]);
await q(`insert into public.entities(id,module,entity_type,entity_key,source,title,meta)
         values ($1,'finance_hub','company','baseballism','seed','Baseballism','{}'::jsonb)`, [company]);
for (const [u, r] of [[owner, 'owner'], [member, 'user'], [admin, 'admin']]) {
  await q(`update public.profiles set role=$2::app_role, active_company_id=$3, is_active=true where id=$1`,
    [u, r, company]);
}
await q(`insert into public.entity_memberships(entity_id,user_id,role)
         values ($1,$2,'owner_admin'),($1,$3,'member'),($1,$4,'admin')`,
  [company, owner, member, admin]);

// ── Apply the migration under test ──────────────────────────────────────────
const MIGRATION = await readFile(
  new URL('supabase/migrations/20260920190000_notification_reply_contacts.sql', root), 'utf8');
// Removing ONLY the caller guard. Shared by the cross-tenant-open mutation and
// by the verifier regression below, so both exercise the same edit.
const STRIP_GUARD = /  if v_actor is not null and not exists \([\s\S]*?  end if;\n\n/;
let sql = MIGRATION;
if (mutation === 'fallback-to-silo') {
  sql = sql.replace("v_source := case when v_reply is null then 'none' else 'owner_admin' end;",
    "v_reply := coalesce(v_reply, 'support@get-silo.com'); v_source := 'owner_admin';");
} else if (mutation === 'no-purpose') {
  sql = sql.replace("where c.company_entity_id = p_company_entity_id and c.purpose = p_purpose;",
    "where c.company_entity_id = p_company_entity_id and c.purpose = 'general_ops';");
} else if (mutation === 'no-sanitize') {
  sql = sql.replace(`regexp_replace(btrim(v_title), '["\\r\\n,<>]', '', 'g')`, 'btrim(v_title)');
} else if (mutation === 'write-open') {
  sql = sql.replace(/and public\.is_admin_user\(\)/g, '');
} else if (mutation === 'cross-tenant-open') {
  sql = sql.replace(STRIP_GUARD, '');
}
await db.exec(sql);
if (!mutation) await db.exec(sql);   // idempotent: applied twice on a clean run

// ── 1. The From header carries the tenant, the address stays SILO's ─────────
await test('From is "<Company> - SILO <notifications@get-silo.com>"', async () => {
  const r = await resolve(company, 'finance_ap');
  assert.equal(r.from_header, 'Baseballism - SILO <notifications@get-silo.com>');
});

await test('an unknown company still gets a valid, non-impersonating From', async () => {
  const r = await resolve(randomUUID(), 'finance_ap');
  assert.equal(r.from_header, 'SILO <notifications@get-silo.com>',
    'a missing title must not produce " - SILO <...>" or a null header');
});

// ── 2. The fallback chain, rung by rung ─────────────────────────────────────
await test('with nothing configured, a reply goes to an owner_admin — never to SILO', async () => {
  const r = await resolve(company, 'finance_ap');
  assert.equal(r.reply_to, 'owner@tenant.com');
  assert.equal(r.reply_to_source, 'owner_admin');
});

await test('the acting user outranks the owner_admin', async () => {
  const r = await resolve(company, 'finance_ap', 'rachel@tenant.com');
  assert.equal(r.reply_to, 'rachel@tenant.com');
  assert.equal(r.reply_to_source, 'actor');
});

await test('a general_ops contact outranks the acting user', async () => {
  await q(`insert into public.company_notification_contacts(company_entity_id,purpose,reply_to_email)
           values ($1,'general_ops','ops@tenant.com')`, [company]);
  const r = await resolve(company, 'finance_ap', 'rachel@tenant.com');
  assert.equal(r.reply_to, 'ops@tenant.com');
  assert.equal(r.reply_to_source, 'general_ops');
});

await test('the purpose contact outranks everything', async () => {
  await q(`insert into public.company_notification_contacts(company_entity_id,purpose,reply_to_email)
           values ($1,'finance_ap','finance@tenant.com')`, [company]);
  const r = await resolve(company, 'finance_ap', 'rachel@tenant.com');
  assert.equal(r.reply_to, 'finance@tenant.com');
  assert.equal(r.reply_to_source, 'purpose');
  // and a DIFFERENT purpose is unaffected by it
  const hr = await resolve(company, 'hr_comp');
  assert.equal(hr.reply_to, 'ops@tenant.com', 'finance_ap leaked into hr_comp');
});

// ── 3. SILO is never the reply desk, on ANY rung ────────────────────────────
await test('no rung of the chain ever answers with a SILO address', async () => {
  const empty = randomUUID();
  await q(`insert into public.entities(id,module,entity_type,entity_key,source,title,meta)
           values ($1,'finance_hub','company','fresh','seed','Fresh Co','{}'::jsonb)`, [empty]);
  const seen = [];
  for (const p of ['finance_ap', 'purchasing', 'hr_comp', 'general_ops', 'technical']) {
    seen.push((await resolve(company, p)).reply_to, (await resolve(empty, p)).reply_to);
  }
  for (const addr of seen) {
    if (addr === null) continue;   // "nobody to reply to" is honest; a SILO desk is not
    assert.doesNotMatch(addr, /get-silo\.com|silo-baseballism\.com/i,
      `reply-to resolved to a SILO address (${addr}) -- SILO becomes the reply desk for tenant operations`);
  }
  // A brand-new company with no members and no contacts has nobody: null, not SILO.
  assert.equal((await resolve(empty, 'finance_ap')).reply_to, null);
  assert.equal((await resolve(empty, 'finance_ap')).reply_to_source, 'none');
});

// ── 4. A company title cannot break the header ──────────────────────────────
await test('a title containing quotes or CRLF cannot inject a header', async () => {
  const evil = randomUUID();
  await q(`insert into public.entities(id,module,entity_type,entity_key,source,title,meta)
           values ($1,'finance_hub','company','evil','seed',$2,'{}'::jsonb)`,
    [evil, 'Acme", <a@b.c>\r\nBcc: victim@elsewhere.com']);
  const r = await resolve(evil, 'finance_ap');
  assert.doesNotMatch(r.from_header, /[\r\n"]/,
    'a quote or newline survived into the From header -- the header can be split');
  assert.equal(r.from_header,
    'Acme a@b.cBcc: victim@elsewhere.com - SILO <notifications@get-silo.com>');
  assert.equal((r.from_header.match(/</g) || []).length, 1, 'more than one angle bracket pair in From');
});

// ── 5. Who may redirect the replies ─────────────────────────────────────────
await test('a member can READ the contacts but not rewrite them', async () => {
  const read = await as(member, () => q('select purpose from public.company_notification_contacts'));
  assert.equal(read.length, 2, 'a member should see where replies go');
  let wrote = [];
  try {
    wrote = await as(member, () => q(
      `update public.company_notification_contacts set reply_to_email='attacker@elsewhere.com'
        where purpose='finance_ap' returning id`));
  } catch (e) {
    assert.match(e.message, /permission denied|denied for table/i);
  }
  assert.equal(wrote.length, 0, 'a non-admin member redirected the finance reply address');
  assert.equal((await one(`select reply_to_email from public.company_notification_contacts
                            where purpose='finance_ap'`)).reply_to_email, 'finance@tenant.com');
});

await test('an admin can set one', async () => {
  const rows = await as(admin, () => q(
    `insert into public.company_notification_contacts(company_entity_id,purpose,reply_to_email)
     values ($1,'purchasing','buying@tenant.com') returning id`, [company]));
  assert.equal(rows.length, 1, 'an admin must be able to configure contacts');
});

// ── 6. The resolver is not a way around RLS ─────────────────────────────────
// It is SECURITY DEFINER, it takes a company id, and it is granted to every
// authenticated user. Without a caller check that is a straight bypass: the
// direct table read is scoped by RLS, but the RPC would answer about anyone.
await test('an authenticated member of one company cannot resolve another', async () => {
  const otherCo = randomUUID();
  const otherOwner = randomUUID();
  await q(`insert into auth.users(id,email) values ($1,'owner@other.com')`, [otherOwner]);
  await q(`insert into public.entities(id,module,entity_type,entity_key,source,title,meta)
           values ($1,'finance_hub','company','other','seed','Other Co','{}'::jsonb)`, [otherCo]);
  await q(`update public.profiles set active_company_id=$2, is_active=true where id=$1`,
    [otherOwner, otherCo]);
  await q(`insert into public.entity_memberships(entity_id,user_id,role) values ($1,$2,'owner_admin')`,
    [otherCo, otherOwner]);
  await q(`insert into public.company_notification_contacts(company_entity_id,purpose,reply_to_email)
           values ($1,'finance_ap','secret-finance@other.com')`, [otherCo]);

  // The direct read is already scoped; this proves the fixture's RLS works, so
  // a leak through the RPC below is the RPC's, not the table's.
  const direct = await as(admin, () => q(
    `select reply_to_email from public.company_notification_contacts where company_entity_id=$1`,
    [otherCo]));
  assert.equal(direct.length, 0, 'RLS should already hide another company\'s contacts');

  await assert.rejects(
    () => as(admin, () => resolve(otherCo, 'finance_ap')),
    /Not a member of this company/,
    'an authenticated caller resolved a company it does not belong to -- this leaks that ' +
    'company\'s reply address, and its owner-admin email through the fallback');

  // And the same caller still resolves its OWN company.
  const own = await as(admin, () => resolve(company, 'finance_ap'));
  assert.equal(own.reply_to, 'finance@tenant.com', 'the caller lost access to its own company');
});

await test('the service role (every mail function) is not narrowed by that check', async () => {
  // auth.uid() is null for the service role, which is how all ten edge
  // functions call this. If that were held to memberships, every notification
  // would stop sending.
  const r = await resolve(company, 'finance_ap');
  assert.equal(r.reply_to, 'finance@tenant.com');
  assert.equal(r.from_header, 'Baseballism - SILO <notifications@get-silo.com>');
});

// ── 7. The VERIFIER can see the bug it exists to catch ──────────────────────
// Its first version asserted `prosrc like '%entity_memberships%'` -- but the
// owner-admin fallback reads that table too, so deleting the guard left the
// check green. A verifier that cannot fail against the vulnerable definition is
// worse than none, because it is credited as coverage. Found by the additional
// review Blake requested on #745. This executes the REAL statement out of
// verify_v2_schema.sql against both definitions rather than asserting its text.
await test('verify_v2_schema.sql goes CRITICAL when the caller guard is removed', async () => {
  let verifySql = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
  if (mutation === 'verify-weak') {
    // The original clause, restored verbatim: it matches a table name the
    // owner-admin fallback also uses, so it cannot tell the guard is gone.
    verifySql = verifySql.replace(
      /   not like '%Not a member of this company%'\n[\s\S]*?not like '%v_actor is not null%'\n   then 'CRITICAL: resolve_notification_sender does not gate its caller check on auth\.uid\(\)'/,
      "   not like '%entity_memberships%'\n   then 'CRITICAL: resolve_notification_sender does not check the caller''s own memberships'");
  }
  const matches = splitSqlStatements(verifySql)
    .filter((st) => st.text.includes("'Notification sender resolves per tenant'"));
  assert.equal(matches.length, 1,
    'expected exactly one sender check in the verify file; the statement could not be located');
  const check = matches[0].text;

  assert.equal((await one(check)).status, 'ok',
    'the committed resolver should pass its own check');

  const unguarded = MIGRATION.replace(STRIP_GUARD, '');
  assert.notEqual(unguarded, MIGRATION,
    'the guard-removal pattern matched nothing -- this test would prove nothing');
  await db.exec(unguarded);

  // The leak is real with the guard gone -- asserted here too, so the check's
  // verdict is tied to observable behaviour and not just to a source string.
  await assert.doesNotReject(
    () => as(admin, () => resolve(company, 'finance_ap')),
    'with the guard stripped the resolver must answer -- if it still refuses, the strip ' +
    'pattern is stale and the CRITICAL below would be proving nothing');

  assert.match((await one(check)).status, /^CRITICAL/,
    'the verifier stayed green against a resolver with no caller guard');

  await db.exec(MIGRATION);   // restore, so any later assertion sees the real thing
  assert.equal((await one(check)).status, 'ok', 'restoring the guard should go green again');
});

console.log(`\n${passed} assertions passed${mutation ? ` (mutation: ${mutation})` : ''}.`);
