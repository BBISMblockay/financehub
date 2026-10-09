// Invite authority and the retired open policies (20261008120000), executed
// against the real migrations as real roles in PGlite.
//
// The finding (security audit 2026-10-08): create_org_invite was gated by
// is_admin(), which passes for every membership `admin`, and it accepted
// p_role = 'owner' and any department. Redeeming turned that into membership
// owner_admin, global role owner, and department finance / exec / admin --
// which alone satisfies can_manage_journal_entries() and the comp / payment
// gates. So an admin could hand a second account authority they do not hold.
//
// Proven here:
//   1. An admin still invites users and admins into ordinary departments (the
//      everyday path on v2/settings-team.html is unchanged).
//   2. An admin cannot invite an owner, nor into finance / exec / admin, in any
//      casing or padding.
//   3. An owner_admin can do both.
//   4. A legacy owner with no membership in the company keeps owner authority
//      (the same fallback every other gate uses); a legacy owner who IS a plain
//      member there does not.
//   5. The retired `using (true)` PO / Launch policies are dropped even after the
//      migrations that create them have run (the apply_all_post_merge order).
//   6. anon cannot execute generate_next_po_name; authenticated still can.
//   7. sample-notify (review cycles 1-2): notify_sample_events() signs every
//      call with the Vault secret and a per-transition event_id, fires on
//      exactly the transitions it did before, and sample_notification_claims
//      is service-only with a primary key that lets exactly one claim win.
//
// Mutations (each must make a specific assertion fail):
//   INVITE_MUTATION=no-owner-guard   (the owner-role check removed)
//   INVITE_MUTATION=no-dept-guard    (the department check removed)
//   INVITE_MUTATION=dept-case        (the department compared without lower())
//   INVITE_MUTATION=keep-open-policy (the policy drop removed)
//   INVITE_MUTATION=keep-anon-po     (the generate_next_po_name revoke removed)
//   INVITE_MUTATION=unsigned-trigger (the trigger stops sending the secret header)
//   INVITE_MUTATION=claims-no-pk     (the claims table loses its primary key)
//   INVITE_MUTATION=claims-readable  (the claims revoke removed)
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e && e.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const mutation = process.env.INVITE_MUTATION || '';
assert.ok(['', 'no-owner-guard', 'no-dept-guard', 'dept-case', 'keep-open-policy', 'keep-anon-po',
  'unsigned-trigger', 'claims-no-pk', 'claims-readable'].includes(mutation),
  `Unknown invite mutation: ${mutation}`);

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
const invite = (email, role, dept) =>
  one('select public.create_org_invite($1,$2,$3) as r', [email, role, dept]).then((x) => x.r);

await db.exec(await readFile(new URL('./onboarding-db-bootstrap.sql', import.meta.url), 'utf8'));

// The pre-existing objects 20261008120000 touches, in the shape the original
// migrations left them: a PO table carrying the open policies, and the
// invoker-rights PO naming function with PUBLIC's default EXECUTE.
await db.exec(`
  create table public.po_headers (id uuid primary key default gen_random_uuid(), company_entity_id uuid);
  alter table public.po_headers enable row level security;
  create policy po_headers_select_auth on public.po_headers for select to authenticated using (true);
  create policy po_headers_active_select on public.po_headers for select to authenticated
    using (company_entity_id = public.active_company_id());
  create table public.launch_comments (id uuid primary key default gen_random_uuid(), company_entity_id uuid);
  alter table public.launch_comments enable row level security;
  create policy launch_comments_select_auth on public.launch_comments for select to authenticated using (true);
  create policy launch_comments_auth_all on public.launch_comments for all to authenticated using (true) with check (true);
  create policy launch_comments_active_select on public.launch_comments for select to authenticated
    using (company_entity_id = public.active_company_id());
  create function public.generate_next_po_name(p_factory_id uuid) returns text language sql as $$ select 'X-1' $$;
  grant execute on function public.generate_next_po_name(uuid) to public;

  -- pg_net and Vault as the trigger sees them: http_post records each call.
  create schema net;
  create table net.calls (id serial primary key, url text, body jsonb, headers jsonb);
  create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
    headers jsonb default '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer default 5000)
  returns bigint language plpgsql as $f$
  begin insert into net.calls(url, body, headers) values (url, body, headers); return 1; end $f$;
  create schema vault;
  create table vault.decrypted_secrets (name text, decrypted_secret text);
  insert into vault.decrypted_secrets values ('sample_notify_trigger_secret', 's3cret');
  create table public.product_samples (
    id uuid primary key default gen_random_uuid(), company_entity_id uuid, product_title text,
    sample_status text, size_requests text, request_source text, assigned_to uuid);
`);

await db.exec(await readFile(new URL('supabase/migrations/20260714200000_org_invites.sql', root), 'utf8'));

let migration = await readFile(new URL('supabase/migrations/20261008120000_security_audit_db_hardening.sql', root), 'utf8');
const mutate = (from, to) => {
  assert.ok(migration.includes(from), `mutation anchor not found: ${from.slice(0, 60)}`);
  migration = migration.replace(from, to);
};
if (mutation === 'no-owner-guard') mutate("if v_role = 'owner' and not v_sender_is_owner then", "if false then");
if (mutation === 'no-dept-guard') mutate("if lower(v_department) in ('finance', 'exec', 'admin') and not v_sender_is_owner then", 'if false then');
if (mutation === 'dept-case') mutate("if lower(v_department) in ('finance', 'exec', 'admin')", "if v_department in ('finance', 'exec', 'admin')");
if (mutation === 'keep-open-policy') mutate("execute format('drop policy if exists %I on public.%I', t || '_select_auth', t);", 'null;');
if (mutation === 'keep-anon-po') mutate('revoke all on function public.generate_next_po_name(uuid) from public, anon;', '');
if (mutation === 'unsigned-trigger') mutate("'x-silo-trigger-secret', coalesce(", "'x-unsigned', coalesce(");
if (mutation === 'claims-no-pk') mutate('  created_at timestamptz not null default now(),\n  primary key (sample_id, event_type, claim_key)\n', '  created_at timestamptz not null default now()\n');
if (mutation === 'claims-readable') mutate('revoke all on public.sample_notification_claims from public, anon, authenticated;', '');
await db.exec(migration);

// ── Cast ─────────────────────────────────────────────────────────────────────
const co = randomUUID();
const owner = randomUUID();        // membership owner_admin
const admin = randomUUID();        // membership admin, global role admin
const execAdmin = randomUUID();    // membership admin whose GLOBAL role is executive (is_admin passes)
const legacyOwner = randomUUID();  // global owner, no membership in co
const memberOwner = randomUUID();  // global owner from elsewhere, plain MEMBER in co
const member = randomUUID();       // membership member

await q(`insert into auth.users(id,email) values ($1,'o@x.test'),($2,'a@x.test'),($3,'e@x.test'),($4,'l@x.test'),($5,'m@x.test'),($6,'p@x.test')`,
  [owner, admin, execAdmin, legacyOwner, memberOwner, member]);
await q(`insert into public.entities(id,module,entity_type,entity_key,source,title) values ($1,'finance_hub','company','co','seed','Co')`, [co]);
for (const [id, role] of [[owner, 'admin'], [admin, 'admin'], [execAdmin, 'executive'], [legacyOwner, 'owner'], [memberOwner, 'owner'], [member, 'user']]) {
  await q('update public.profiles set role=$2::public.app_role, active_company_id=$3, is_active=true where id=$1', [id, role, co]);
}
await q(`insert into public.entity_memberships(entity_id,user_id,role) values ($1,$2,'owner_admin'),($1,$3,'admin'),($1,$4,'admin'),($1,$5,'member'),($1,$6,'member')`,
  [co, owner, admin, execAdmin, memberOwner, member]);

const refused = async (user, args, pattern, what) => {
  await as(user, () => assert.rejects(() => invite(...args), pattern, what));
  passed += 1; console.log(`ok ${passed} - refused: ${what}`);
};

// ── 1. The everyday path ────────────────────────────────────────────────────
await test('an admin invites a user into ops', async () => {
  const r = await as(admin, () => invite('new1@x.test', 'user', 'ops'));
  assert.equal(r.role, 'user'); assert.equal(r.department, 'ops'); assert.ok(r.token);
});
await test('an admin invites an admin into marketing', async () => {
  const r = await as(admin, () => invite('new2@x.test', 'admin', 'marketing'));
  assert.equal(r.role, 'admin'); assert.equal(r.department, 'marketing');
});
await test('a blank department still defaults to ops', async () => {
  const r = await as(admin, () => invite('new3@x.test', 'user', '  '));
  assert.equal(r.department, 'ops');
});

// ── 2. What an admin can no longer grant ────────────────────────────────────
await refused(admin, ['esc1@x.test', 'owner', 'ops'], /only an owner can invite another owner/, 'admin -> owner role');
await refused(admin, ['esc2@x.test', 'user', 'finance'], /only an owner can invite into the finance department/, 'admin -> finance department');
await refused(admin, ['esc3@x.test', 'user', 'exec'], /only an owner can invite into the exec department/, 'admin -> exec department');
await refused(admin, ['esc4@x.test', 'admin', 'admin'], /only an owner can invite into the admin department/, 'admin -> admin department');
await refused(admin, ['esc5@x.test', 'user', ' Finance '], /only an owner can invite into the finance department/, 'admin -> padded mixed-case Finance');
await refused(execAdmin, ['esc6@x.test', 'user', 'exec'], /only an owner can invite/, 'membership admin with a global executive role -> exec');
await refused(memberOwner, ['esc7@x.test', 'owner', 'ops'], /not authorized|only an owner/, 'global owner who is a plain member here -> owner');
await test('no refused invite was stored', async () => {
  const { n } = await one(`select count(*)::int as n from public.org_invites where email like 'esc%'`);
  assert.equal(n, 0);
});

// ── 3 / 4. Owners keep full authority ───────────────────────────────────────
await test('an owner_admin invites an owner into finance', async () => {
  const r = await as(owner, () => invite('own1@x.test', 'owner', 'finance'));
  assert.equal(r.role, 'owner'); assert.equal(r.department, 'finance');
});
await test('a legacy global owner with no membership here invites into exec', async () => {
  const r = await as(legacyOwner, () => invite('own2@x.test', 'user', 'exec'));
  assert.equal(r.department, 'exec');
});
await refused(member, ['m1@x.test', 'user', 'ops'], /not authorized/, 'a member cannot invite at all (unchanged)');

// ── 5. Retired open policies ────────────────────────────────────────────────
await test('the using(true) PO and Launch policies are gone; the scoped ones remain', async () => {
  const rows = await q(`select polname from pg_policy where polrelid in ('public.po_headers'::regclass,'public.launch_comments'::regclass) order by 1`);
  assert.deepEqual(rows.map((r) => r.polname), ['launch_comments_active_select', 'po_headers_active_select']);
});

// ── 6. PO naming ────────────────────────────────────────────────────────────
await test('anon cannot execute generate_next_po_name; authenticated can', async () => {
  const r = await one(`select has_function_privilege('anon','public.generate_next_po_name(uuid)','execute') as anon,
                              has_function_privilege('authenticated','public.generate_next_po_name(uuid)','execute') as auth`);
  assert.equal(r.anon, false); assert.equal(r.auth, true);
});

// ── 7. sample-notify trigger and claims ─────────────────────────────────────
await db.exec(`create trigger trg_sample_notify after insert or update on public.product_samples
               for each row execute function public.notify_sample_events();`);
const calls = async () => (await q('select body, headers from net.calls order by id')).map((r) => r);
await test('the trigger signs each call and sends a per-transition event_id', async () => {
  await q(`insert into public.product_samples(company_entity_id, product_title, sample_status, assigned_to)
           values ($1, 'Tee', 'requested', $2)`, [co, admin]);
  await q(`insert into public.product_samples(company_entity_id, product_title, sample_status, request_source, size_requests)
           values ($1, 'Cap', 'received', 'catalog_photo_request', 'M, L')`, [co]);
  const c = await calls();
  assert.deepEqual(c.map((x) => x.body.type), ['SAMPLE_REQUESTED', 'SAMPLE_SIZE_REQUEST']);
  for (const x of c) {
    assert.equal(x.headers['x-silo-trigger-secret'], 's3cret');
    assert.match(String(x.body.event_id), /^[0-9a-f-]{36}$/);
  }
  assert.notEqual(c[0].body.event_id, c[1].body.event_id);
});
await test('the trigger still fires only on the same transitions as before', async () => {
  await q('delete from net.calls');
  await q(`update public.product_samples set product_title = 'Cap 2' where product_title = 'Cap'`);
  assert.equal((await calls()).length, 0, 'a non-size edit sends nothing');
  await q(`update public.product_samples set size_requests = 'M, L, XL' where product_title = 'Cap 2'`);
  const c = await calls();
  assert.deepEqual(c.map((x) => x.body.type), ['SAMPLE_SIZE_REQUEST'], 'a size change sends one size request');
  await q(`insert into public.product_samples(company_entity_id, product_title, sample_status) values ($1, 'Unrouted', 'requested')`, [co]);
  assert.equal((await calls()).length, 1, 'an unrouted insert sends nothing');
});
await test('with no Vault secret the header is empty, never absent or null', async () => {
  await q('delete from net.calls'); await q('delete from vault.decrypted_secrets');
  await q(`insert into public.product_samples(company_entity_id, product_title, sample_status, assigned_to) values ($1, 'NoSecret', 'requested', $2)`, [co, admin]);
  const [c] = await calls();
  assert.equal(c.headers['x-silo-trigger-secret'], '');
  assert.equal(c.headers['Content-Type'], 'application/json');
});
await test('sample_notification_claims: service-only, and exactly one claim per key wins', async () => {
  const r = await one(`select relrowsecurity as rls,
      has_table_privilege('anon','public.sample_notification_claims','select') as anon_sel,
      has_table_privilege('authenticated','public.sample_notification_claims','select') as auth_sel,
      has_table_privilege('authenticated','public.sample_notification_claims','insert') as auth_ins
    from pg_class where oid = 'public.sample_notification_claims'::regclass`);
  assert.deepEqual(r, { rls: true, anon_sel: false, auth_sel: false, auth_ins: false });
  const sid = randomUUID();
  await q(`insert into public.sample_notification_claims(sample_id, event_type, claim_key) values ($1,'SAMPLE_REQUESTED','insert')`, [sid]);
  await assert.rejects(
    () => q(`insert into public.sample_notification_claims(sample_id, event_type, claim_key) values ($1,'SAMPLE_REQUESTED','insert')`, [sid]),
    (e) => e.code === '23505', 'a second claim for the same delivery must fail with a unique violation');
});

// ── The migration is idempotent ─────────────────────────────────────────────
await test('re-running the migration is a no-op', async () => {
  await db.exec(migration);
  const r = await as(admin, () => invite('again@x.test', 'user', 'ops'));
  assert.equal(r.department, 'ops');
});

console.log(`\n${passed} passed`);
