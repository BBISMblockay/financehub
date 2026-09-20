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
//
// Run: node scripts/tests/notification-sender.test.mjs
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', (e && e.message) || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const mutation = process.env.SENDER_MUTATION || '';
assert.ok(['', 'fallback-to-silo', 'no-purpose', 'no-sanitize', 'write-open'].includes(mutation),
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
let sql = await readFile(
  new URL('supabase/migrations/20260920170000_notification_reply_contacts.sql', root), 'utf8');
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

console.log(`\n${passed} assertions passed${mutation ? ` (mutation: ${mutation})` : ''}.`);
