// The entity admin gate is scoped to the entity being acted on.
//
// Found by impersonating the new BlockayOps admin against production
// (2026-09-20): operational isolation held, but `entities` returned all three
// tenants. The cause is is_owner_admin(), which has no entity_id predicate --
// it asks "do I hold an owner/admin membership ANYWHERE" and then answers true
// for EVERY entity. It gated entities_select_access (via can_access_entity)
// and was the ENTIRE qual of entities_delete_admin_only.
//
// The fixture below reproduces BOTH the wide gate and the four policies built
// on it before applying the migration, because closing a hole that was never
// built proves nothing. The delete here succeeds pre-migration, which models
// the case that actually matters: a YOUNG tenant. Baseballism survives today
// only because ~70 child FKs are NO ACTION and populated -- accidental
// protection that a company founded last week does not have.
//
// The stale vocabulary is tested in both directions. Per-company roles are
// owner_admin|admin|member|viewer and 'owner' matches no production row, so
// is_entity_admin -- correctly scoped but testing role in ('owner','admin') --
// locked every owner_admin out of their own company while is_owner_admin let
// every admin into every company.
//
// Grants and policies are pinned STRUCTURALLY as well as behaviourally: the
// migration closes the delete path twice (the policy goes AND the grant goes),
// so with either layer alone the behaviour is already correct and a
// single-layer regression would be invisible. Same reasoning as
// entities-update-lockdown.test.mjs.
//
// Mutations (each must make a specific assertion fail):
//   GATE_MUTATION=gate-unscoped    (can_access_entity keeps the wide branch)
//   GATE_MUTATION=vocabulary-kept  (is_entity_admin keeps role in ('owner','admin'))
//   GATE_MUTATION=grant-kept       (the entities INSERT/DELETE grants stay)
//   GATE_MUTATION=policy-kept      (the policy stays AND the drop is attempted:
//                                   Postgres itself refuses, because a policy is
//                                   a dependency -- the migration cannot apply
//                                   while a caller survives)
//   GATE_MUTATION=policy-and-gate-kept (the policy stays and the drop is skipped,
//                                   so the structural assertion is what fires)
//   GATE_MUTATION=gate-inlined     (the function goes, its PREDICATE is inlined
//                                   into can_access_entity -- proves the
//                                   BEHAVIOURAL disclosure assertion catches a
//                                   reopening that every structural one passes)
//
// Run: node scripts/tests/entity-admin-gate-scope.test.mjs
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', (e && e.message) || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const mutation = process.env.GATE_MUTATION || '';
assert.ok(['', 'gate-unscoped', 'vocabulary-kept', 'grant-kept', 'policy-kept',
  'policy-and-gate-kept', 'gate-inlined'].includes(mutation),
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
// Either refusal is correct: no grant is a hard error, no policy is a silent
// zero rows. Which one fires is a detail; "the row did not change" is not.
async function tryWrite(user, sql, params) {
  try { return await as(user, () => q(sql, params)); }
  catch (e) {
    assert.match(e.message, /permission denied|denied for table/i, `unexpected error: ${e.message}`);
    return [];
  }
}

const bAdmin = randomUUID();   // membership 'admin' of BlockayOps ONLY
const bOwner = randomUUID();   // membership 'owner_admin' of BlockayOps
const other  = randomUUID();   // owner of the other tenant
const blockay = randomUUID();
const baseballism = randomUUID();
// A tenant founded last week: no members, nothing pointing at it. The delete
// assertions use THIS one deliberately. Baseballism cannot be deleted here for
// the same reason it cannot in production -- profiles.active_company_id is a
// NO ACTION FK -- so asserting the refusal against it would pass whether or
// not this migration is applied, which is a test that proves nothing.
const young = randomUUID();

await db.exec(await readFile(new URL('./onboarding-db-bootstrap.sql', import.meta.url), 'utf8'));

// ── Production's gate and the policies built on it, verbatim from pg_proc /
//    pg_policy (2026-09-20). The bootstrap ships neither. ──────────────────
await db.exec(`
  create function public.is_owner_admin() returns boolean
  language sql stable security definer set search_path to 'public','pg_temp' set row_security to 'off'
  as $f$
    select exists (select 1 from public.entity_memberships m
                    where m.user_id = auth.uid() and m.role in ('owner','admin'));
  $f$;
  create function public.is_entity_admin(p_entity_id uuid) returns boolean
  language sql stable security definer set search_path to 'public','pg_temp' set row_security to 'off'
  as $f$
    select exists (select 1 from public.entity_memberships m
                    where m.entity_id = p_entity_id and m.user_id = auth.uid()
                      and m.role in ('owner','admin'));
  $f$;
  create table public.entity_state (
    entity_id uuid primary key references public.entities(id) on delete cascade,
    assigned_to uuid references auth.users(id));
  create table public.entity_comments (
    id uuid primary key default gen_random_uuid(),
    entity_id uuid references public.entities(id) on delete cascade,
    body text, created_by uuid references auth.users(id));
  create table public.files (
    id uuid primary key default gen_random_uuid(),
    entity_id uuid references public.entities(id) on delete cascade,
    name text, uploaded_by uuid references auth.users(id));
  create function public.can_access_entity(eid uuid) returns boolean
  language sql stable security definer set search_path to 'public','pg_temp' set row_security to 'off'
  as $f$
    select public.is_owner_admin()
        or exists (select 1 from public.entities e where e.id = eid and e.created_by = auth.uid())
        or exists (select 1 from public.entity_state s
                    where s.entity_id = eid and s.assigned_to = auth.uid())
        or public.is_entity_member(eid);
  $f$;
  create policy entities_select_access on public.entities
    for select to authenticated using (public.can_access_entity(id));
  create policy entities_delete_admin on public.entities
    for delete to authenticated using (public.is_entity_admin(id));
  create policy entities_delete_admin_only on public.entities
    for delete to authenticated using (public.is_owner_admin());
  grant insert, delete on public.entities to authenticated;

  alter table public.entity_state enable row level security;
  create policy state_delete_admin on public.entity_state
    for delete to authenticated using (public.is_entity_admin(entity_id));
  create policy entity_state_delete_admin_only on public.entity_state
    for delete to authenticated using (public.is_owner_admin());
  grant select, delete on public.entity_state to authenticated;

  alter table public.entity_comments enable row level security;
  create policy comments_select_access on public.entity_comments
    for select to authenticated using (public.can_access_entity(entity_id));
  create policy comments_delete_admin on public.entity_comments
    for delete to authenticated using (public.is_entity_admin(entity_id));
  create policy entity_comments_delete_admin_or_author on public.entity_comments
    for delete to authenticated using (public.is_owner_admin() or created_by = auth.uid());
  grant select, delete on public.entity_comments to authenticated;

  alter table public.files enable row level security;
  create policy files_select_access on public.files
    for select to authenticated using (entity_id is null or public.can_access_entity(entity_id));
  create policy files_delete_admin on public.files
    for delete to authenticated using (entity_id is not null and public.is_entity_admin(entity_id));
  create policy files_delete_admin_or_uploader on public.files
    for delete to authenticated using (public.is_owner_admin() or uploaded_by = auth.uid());
  grant select, delete on public.files to authenticated;
`);

await q(`insert into auth.users(id,email) values ($1,'admin@blockay.com'),($2,'owner@blockay.com'),($3,'blake@baseballism.com')`,
  [bAdmin, bOwner, other]);
await q(`insert into public.entities(id,module,entity_type,entity_key,source,title,meta,created_by)
         values ($1,'finance_hub','company','blockay-ops','seed','BlockayOps','{}'::jsonb,$4),
                ($2,'finance_hub','company','baseballism','seed','Baseballism','{}'::jsonb,$4),
                ($3,'finance_hub','company','young-co','seed','Young Co','{}'::jsonb,$4)`,
  [blockay, baseballism, young, other]);
await q(`update public.profiles set active_company_id=$2 where id=$1`, [bAdmin, blockay]);
await q(`update public.profiles set active_company_id=$2 where id=$1`, [bOwner, blockay]);
await q(`update public.profiles set active_company_id=$2 where id=$1`, [other, baseballism]);
await q(`insert into public.entity_memberships(entity_id,user_id,role)
         values ($1,$2,'admin'),($1,$3,'owner_admin'),($4,$5,'owner_admin')`,
  [blockay, bAdmin, bOwner, baseballism, other]);
await q(`insert into public.entity_comments(entity_id,body,created_by) values ($1,'mine',$2)`,
  [blockay, bAdmin]);
await q(`insert into public.files(entity_id,name,uploaded_by) values ($1,'mine.pdf',$2)`,
  [blockay, bAdmin]);

// ── The hole, before it is closed ───────────────────────────────────────────
await test('a BlockayOps-only admin CAN see every tenant before this migration', async () => {
  const rows = await as(bAdmin, () => q(`select title from public.entities order by title`));
  assert.deepEqual(rows.map((r) => r.title), ['Baseballism', 'BlockayOps', 'Young Co'],
    'the fixture must reproduce the production disclosure, or closing it proves nothing');
});

await test('a BlockayOps-only admin CAN delete a young tenant before this migration', async () => {
  const rows = await as(bAdmin, () => q(
    `delete from public.entities where id=$1 returning title`, [young]));
  assert.equal(rows.length, 1, 'the fixture must reproduce the production delete path');
  await q(`insert into public.entities(id,module,entity_type,entity_key,source,title,meta,created_by)
           values ($1,'finance_hub','company','young-co','seed','Young Co','{}'::jsonb,$2)`,
    [young, other]);
});

await test('an owner_admin is locked out of their OWN company before this migration', async () => {
  const ok = await as(bOwner, () => one(`select public.is_entity_admin($1) as a`, [blockay]));
  assert.equal(ok.a, false,
    "the stale ('owner','admin') vocabulary must be reproduced -- it matches no owner_admin row");
});

// ── Apply the migration under test ──────────────────────────────────────────
let sql = await readFile(
  new URL('supabase/migrations/20260920160000_entity_admin_gate_company_scope.sql', root), 'utf8');
if (mutation === 'gate-unscoped') {
  sql = sql.replace('or public.is_entity_member(eid);',
                    'or public.is_owner_admin() or public.is_entity_member(eid);')
           .replace('drop function if exists public.is_owner_admin();', '');
} else if (mutation === 'vocabulary-kept') {
  sql = sql.replace("m.role in ('owner_admin', 'admin')", "m.role in ('owner', 'admin')");
} else if (mutation === 'grant-kept') {
  sql = sql.replace(/revoke insert, delete on public\.entities from (authenticated|anon);/g, '');
} else if (mutation === 'policy-kept') {
  sql = sql.replace(/drop policy if exists entities_delete_admin_only on public\.entities;.*$/m, '');
} else if (mutation === 'policy-and-gate-kept') {
  sql = sql.replace(/drop policy if exists entities_delete_admin_only on public\.entities;.*$/m, '')
           .replace('drop function if exists public.is_owner_admin();', '');
} else if (mutation === 'gate-inlined') {
  sql = sql.replace('or public.is_entity_member(eid);',
    `or exists (select 1 from public.entity_memberships m
                 where m.user_id = auth.uid() and m.role in ('owner','admin'))
     or public.is_entity_member(eid);`);
}
await db.exec(sql);
if (!mutation) await db.exec(sql);   // idempotent: applied twice on a clean run

// ── 1. The wide gate is gone, pinned where it lives ─────────────────────────
await test('is_owner_admin() no longer exists and nothing references it', async () => {
  const fn = await q(`select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                       where n.nspname='public' and p.proname='is_owner_admin'`);
  assert.equal(fn.length, 0,
    'the zero-argument gate survived; it cannot be scoped to a row, so the next caller reopens this');
  // Postgres tracks a policy as a dependency of the function it calls, so a
  // surviving caller makes the drop above fail outright (GATE_MUTATION=policy-kept
  // shows it). This assertion is not that check repeated -- it is what catches
  // the gate being REINTRODUCED later alongside a policy, which the dependency
  // guard would happily allow.
  const refs = await q(`select polrelid::regclass::text||'.'||polname as p from pg_policy
                         where coalesce(pg_get_expr(polqual,polrelid),'') like '%is_owner_admin()%'`);
  assert.deepEqual(refs.map((r) => r.p), [],
    'a policy still names the unscoped gate; policies are OR\'d, so one is enough to reopen this');
});

await test('entities takes no client INSERT or DELETE, and SELECT still works', async () => {
  for (const priv of ['insert', 'delete']) {
    assert.equal((await one(`select has_table_privilege('authenticated','public.entities',$1) as g`,
      [priv])).g, false,
      `authenticated still holds ${priv.toUpperCase()}; a future permissive policy reopens this alone`);
  }
  assert.equal((await one(`select has_table_privilege('authenticated','public.entities','select') as g`)).g,
    true, 'SELECT must survive -- config.js resolves the active company through it');
});

// ── 2. Behaviour: one tenant, one view ──────────────────────────────────────
await test('a BlockayOps-only admin now sees ONLY BlockayOps', async () => {
  const rows = await as(bAdmin, () => q(`select title from public.entities order by title`));
  assert.deepEqual(rows.map((r) => r.title), ['BlockayOps'],
    'another tenant is still listed -- this is the disclosure the migration exists to close');
});

await test('a BlockayOps-only admin can no longer delete a young tenant', async () => {
  const rows = await tryWrite(bAdmin, `delete from public.entities where id=$1 returning title`, [young]);
  assert.equal(rows.length, 0, 'the cross-tenant delete is still reachable');
  assert.equal((await one(`select count(*)::int c from public.entities where id=$1`, [young])).c, 1,
    'the other tenant row was destroyed');
});

await test('nor found a new tenant from the browser', async () => {
  const rows = await tryWrite(bAdmin,
    `insert into public.entities(module,entity_type,entity_key,source,title,meta,created_by)
     values ('finance_hub','company','mine','seed','Mine','{}'::jsonb,$1) returning id`, [bAdmin]);
  assert.equal(rows.length, 0, 'founding a tenant is platform-invite gated, not a client INSERT');
});

// ── 3. The vocabulary fix, in both directions ───────────────────────────────
await test('an owner_admin is an admin of their OWN company and no other', async () => {
  assert.equal((await as(bOwner, () => one(`select public.is_entity_admin($1) as a`, [blockay]))).a,
    true, 'owner_admin is still locked out of their own company by the stale vocabulary');
  assert.equal((await as(bOwner, () => one(`select public.is_entity_admin($1) as a`, [baseballism]))).a,
    false, 'owner_admin of one company must not be an admin of another');
});

// ── 4. The author/uploader clauses are preserved, not swept up ──────────────
await test('an author still deletes their own comment; a stranger does not', async () => {
  assert.equal((await tryWrite(other, `delete from public.entity_comments where created_by=$1 returning id`,
    [bAdmin])).length, 0, 'another tenant deleted a comment it cannot see');
  assert.equal((await tryWrite(bAdmin, `delete from public.entity_comments where created_by=$1 returning id`,
    [bAdmin])).length, 1, 'the author clause was swept up with the admin half');
});

await test('an uploader still deletes their own file', async () => {
  assert.equal((await tryWrite(bAdmin, `delete from public.files where uploaded_by=$1 returning id`,
    [bAdmin])).length, 1, 'the uploader clause was swept up with the admin half');
});

// ── 5. Regression: members still read their own company ─────────────────────
await test('a member still reads their own company row', async () => {
  assert.equal((await as(bAdmin, () => q(`select title from public.entities where id=$1`, [blockay]))).length,
    1, 'config.js resolves the active company through this read');
});

console.log(`\n${passed} assertions passed${mutation ? ` (mutation: ${mutation})` : ''}.`);
