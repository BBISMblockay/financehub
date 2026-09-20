// `entities` takes no client UPDATE, and the definer rename still works.
//
// The hole this closes was found by applying 20260920120000 to production and
// running its own verify check: `entities_update_member` is a permissive
// UPDATE policy over `is_entity_member(id)`, which has no role filter, so any
// member of a company -- a viewer included -- could rewrite its own row's
// title, entity_key, meta and entity_type from the browser.
//
// Two properties, and the second is the one that makes this safe to ship:
//
//   1. A member, of any role, can no longer UPDATE the row. Asserted for a
//      viewer AND for an owner_admin, because the point is not "viewers are
//      too junior" -- it is that NO browser session writes this table.
//   2. set_workspace_company_name() still renames it. A SECURITY DEFINER
//      function executes as its owner and is unaffected by a policy or a grant
//      on `authenticated`; if that were wrong, this migration would take the
//      rename away with the hole, and the Company tab would silently stop
//      working.
//
// This migration closes the hole TWICE -- the policies go and the grant goes --
// which means neither layer is observable through behaviour alone: with either
// one applied, the UPDATE is already refused. That is the property worth having
// and it makes a single-layer mutation invisible, exactly as the removal
// function's unreachable last-owner backstop was. So the two layers are pinned
// STRUCTURALLY, by asking pg_policy and has_table_privilege directly, and the
// mutations below break those assertions rather than the behavioural ones.
//
// Mutations (each must make a specific assertion fail):
//   ENTITIES_MUTATION=policies-kept   (the two UPDATE policies are not dropped)
//   ENTITIES_MUTATION=grant-kept      (the policies go, the table grant stays)
//
// Run: node scripts/tests/entities-update-lockdown.test.mjs
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', (e && e.message) || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const mutation = process.env.ENTITIES_MUTATION || '';
assert.ok(['', 'policies-kept', 'grant-kept'].includes(mutation), `Unknown mutation: ${mutation}`);

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };
const refused = async (fn, pattern, what) => {
  await assert.rejects(fn, pattern, what);
  passed += 1; console.log(`ok ${passed} - refused: ${what}`);
};

async function as(user, fn, role = 'authenticated') {
  await db.exec('set role ' + role);
  await q("select set_config('request.jwt.claim.sub',$1,false)", [user || '']);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const rpc = async (name, args) =>
  Object.values(await one(`select ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')})`, args))[0];

const owner = randomUUID();
const viewer = randomUUID();
const company = randomUUID();

await db.exec(await readFile(new URL('./onboarding-db-bootstrap.sql', import.meta.url), 'utf8'));

// Production's two UPDATE policies, verbatim from pg_policy (2026-09-20). The
// bootstrap carries only the SELECT policy, so the hole has to be built here
// before it can be closed -- otherwise this file would prove nothing.
await db.exec(`
  create or replace function public.can_access_entity(eid uuid) returns boolean
  language sql stable security definer set search_path to 'public','pg_temp' set row_security to 'off'
  as $ce$
    select exists (select 1 from public.entities e where e.id = eid and e.created_by = auth.uid())
        or public.is_entity_member(eid);
  $ce$;
  create policy entities_update_member on public.entities
    for update to authenticated using (public.is_entity_member(id))
    with check (public.is_entity_member(id));
  create policy entities_update_access on public.entities
    for update to authenticated using (public.can_access_entity(id))
    with check (public.can_access_entity(id));
  grant update on public.entities to authenticated;
`);

await q(`insert into auth.users(id,email) values ($1,'owner@blockay.com'),($2,'viewer@blockay.com')`,
  [owner, viewer]);
await q(`insert into public.entities(id,module,entity_type,entity_key,source,title,meta)
         values ($1,'finance_hub','company','blockay-ops','seed','Blockay Ops','{}'::jsonb)`, [company]);
await q(`update public.profiles set role='owner', department='exec', active_company_id=$2 where id=$1`,
  [owner, company]);
await q(`update public.profiles set role='user', department='ops', active_company_id=$2 where id=$1`,
  [viewer, company]);
await q(`insert into public.entity_memberships(entity_id,user_id,role)
         values ($1,$2,'owner_admin'),($1,$3,'viewer')`, [company, owner, viewer]);

await db.exec(await readFile(new URL('supabase/migrations/20260918120000_company_onboarding.sql', root), 'utf8'));
await db.exec(await readFile(new URL('supabase/migrations/20260920120000_workspace_settings_admin.sql', root), 'utf8'));

// ── The hole, before it is closed ───────────────────────────────────────────
await test('a viewer CAN rewrite the company row before this migration', async () => {
  const rows = await as(viewer, () => q(
    `update public.entities set entity_key='baseballism', title='Not Yours' where id=$1 returning entity_key`,
    [company]));
  assert.equal(rows.length, 1,
    'the fixture must reproduce the production hole, or closing it proves nothing');
  assert.equal(rows[0].entity_key, 'baseballism');
  await q(`update public.entities set entity_key='blockay-ops', title='Blockay Ops' where id=$1`, [company]);
});

// ── Apply the migration under test ──────────────────────────────────────────
let sql = await readFile(new URL('supabase/migrations/20260920130000_entities_update_lockdown.sql', root), 'utf8');
if (mutation === 'policies-kept') {
  sql = sql.replace(/drop policy if exists entities_update_(member|access) on public\.entities;/g, '');
} else if (mutation === 'grant-kept') {
  sql = sql.replace(/revoke update on public\.entities from authenticated;/, '');
}
await db.exec(sql);
if (!mutation) await db.exec(sql);   // idempotent: applied twice on a clean run

// ── 1. Both layers, pinned where they live ──────────────────────────────────
// Behaviour cannot tell these apart -- either alone refuses the write -- so a
// future edit dropping one would leave every other assertion here green.
await test('both the UPDATE policies and the table grant are gone', async () => {
  const policies = await q(`select polname from pg_policy
                             where polrelid='public.entities'::regclass and polcmd in ('w','*')`);
  assert.deepEqual(policies.map((r) => r.polname), [],
    'an UPDATE policy on entities survived; RLS cannot scope to columns, so one is enough to reopen this');
  const grant = await one(`select has_table_privilege('authenticated','public.entities','update') as g`);
  assert.equal(grant.g, false,
    'authenticated still holds UPDATE; a future permissive policy would reopen this on its own');
  // The read path is a separate privilege and must survive.
  assert.equal((await one(`select has_table_privilege('authenticated','public.entities','select') as g`)).g,
    true, 'SELECT must be untouched -- config.js resolves the active company through it');
});

// ── 2. No browser session writes this table, whatever its role ──────────────
for (const [who, label] of [[viewer, 'viewer'], [owner, 'owner_admin']]) {
  await test(`a ${label} can no longer rewrite the company row`, async () => {
    // Two distinct refusals are possible and both are correct: no grant is a
    // hard error, no policy is a silent zero rows. Accept either, because
    // which one fires is a detail and "the row did not change" is not.
    let rows = [];
    try {
      rows = await as(who, () => q(
        `update public.entities set entity_key='baseballism' where id=$1 returning entity_key`, [company]));
    } catch (e) {
      assert.match(e.message, /permission denied|denied for table/i, `${label}: unexpected error`);
    }
    assert.equal(rows.length, 0, `${label} still wrote the row`);
    assert.equal((await one(`select entity_key from public.entities where id=$1`, [company])).entity_key,
      'blockay-ops', `${label} changed entity_key, which decides whose menu a company is served`);
  });
}

// ── 3. The definer path still works, which is what makes this safe ──────────
await test('set_workspace_company_name still renames it, and only for an owner', async () => {
  await as(owner, () => rpc('set_workspace_company_name', ['Blockay Operations']));
  const e = await one(`select title, entity_key from public.entities where id=$1`, [company]);
  assert.equal(e.title, 'Blockay Operations', 'a definer function is unaffected by the revoke');
  assert.equal(e.entity_key, 'blockay-ops', 'and still writes only the one column');
});

await refused(
  () => as(viewer, () => rpc('set_workspace_company_name', ['Mine Now'])),
  /only an owner can rename/,
  'a viewer renaming through the definer function');

// ── 4. Reads are untouched ──────────────────────────────────────────────────
await test('members can still READ their company row', async () => {
  const rows = await as(viewer, () => q(`select title from public.entities where id=$1`, [company]));
  assert.equal(rows.length, 1, 'revoking update must not touch select -- config.js resolves the company here');
});

console.log(`\n${passed} assertions passed${mutation ? ` (mutation: ${mutation})` : ''}.`);
