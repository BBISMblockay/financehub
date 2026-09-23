process.on('uncaughtException', (error) => { console.error('\nFAILED:', error.message); process.exit(1); });
process.on('unhandledRejection', (error) => { console.error('\nFAILED:', error?.message || error); process.exit(1); });

// 20260923160000_incoming_shipment_audit.sql against a real PostgreSQL: the
// PO Report's shipment tables record who created and who last changed each
// row, from the session and never from the client; created_by never moves;
// a write with no session records no person; existing rows stay unattributed.
// Run: node scripts/tests/incoming-shipment-audit-database.test.mjs
// (needs `npm ci --prefix scripts/tests/finance-db --ignore-scripts`)
// Mutation: SHIPMENT_AUDIT_MUTATION=trust-client keeps a client-sent
// created_by/updated_by (the stamp_created_by "fill a NULL" behaviour).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const root = new URL('../../', import.meta.url);
let migration = await readFile(new URL('supabase/migrations/20260923160000_incoming_shipment_audit.sql', root), 'utf8');
if (process.env.SHIPMENT_AUDIT_MUTATION === 'trust-client') {
  const from = `    if auth.uid() is not null then
      new.created_by := auth.uid();
      new.updated_by := auth.uid();
    end if;`;
  assert.ok(migration.includes(from), 'mutation anchor');
  migration = migration.replace(from, `    new.created_by := coalesce(new.created_by, auth.uid());
    new.updated_by := coalesce(new.updated_by, auth.uid());`)
    .replace('    new.created_by := old.created_by;\n    new.updated_by := auth.uid();', '    new.updated_by := coalesce(new.updated_by, auth.uid());');
}
const db = new PGlite();
let checks = 0;
const test = async (name, fn) => { await fn(); checks += 1; console.log(`ok ${checks} - ${name}`); };
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const FORGED = '33333333-3333-4333-8333-333333333333';
const asUser = (uid) => db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid || '']);

await db.exec(`
  create schema if not exists auth;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  end $$;
  create table public.incoming_shipments(id uuid primary key default gen_random_uuid(), po_header_id uuid,
    shipment_status text, tracking_number text, created_at timestamptz default now(), updated_at timestamptz default now());
  create table public.incoming_shipment_lines(id uuid primary key default gen_random_uuid(),
    shipment_id uuid references public.incoming_shipments(id) on delete cascade, qty numeric,
    created_at timestamptz default now(), updated_at timestamptz default now());
  insert into public.incoming_shipments(shipment_status) values ('Shipped');
`);
await db.exec(migration);
await db.exec(migration);

await test('applies twice: four columns, two triggers', async () => {
  const c = await one(`select count(*)::int n from information_schema.columns where table_schema='public'
    and table_name in ('incoming_shipments','incoming_shipment_lines') and column_name in ('created_by','updated_by')`);
  assert.equal(c.n, 4);
  const t = await one(`select count(*)::int n from pg_trigger where tgname in ('trg_incoming_shipments_audit','trg_incoming_shipment_lines_audit') and not tgisinternal`);
  assert.equal(t.n, 2);
});

await test('a shipment from before the migration stays unattributed', async () => {
  const r = await one(`select created_by, updated_by from public.incoming_shipments where shipment_status='Shipped'`);
  assert.equal(r.created_by, null); assert.equal(r.updated_by, null);
});

let shipment;
await test('creating a shipment and a line stamps the signed-in person, ignoring a forged value', async () => {
  await asUser(ALICE);
  const s = await one(`insert into public.incoming_shipments(shipment_status, created_by, updated_by) values ('Not Shipped', $1, $1) returning *`, [FORGED]);
  shipment = s.id;
  assert.equal(s.created_by, ALICE); assert.equal(s.updated_by, ALICE);
  const l = await one(`insert into public.incoming_shipment_lines(shipment_id, qty, created_by) values ($1, 10, $2) returning *`, [shipment, FORGED]);
  assert.equal(l.created_by, ALICE); assert.equal(l.updated_by, ALICE);
});

await test('an edit by someone else records them and keeps the creator', async () => {
  await asUser(BOB);
  const s = await one(`update public.incoming_shipments set shipment_status='In Transit', created_by=$2, updated_by=$2 where id=$1 returning *`, [shipment, FORGED]);
  assert.equal(s.created_by, ALICE); assert.equal(s.updated_by, BOB);
  const l = await one(`update public.incoming_shipment_lines set qty=12 where shipment_id=$1 returning *`, [shipment]);
  assert.equal(l.created_by, ALICE); assert.equal(l.updated_by, BOB);
});

await test('a write with no session records no person rather than the previous editor', async () => {
  await asUser(null);
  const s = await one(`update public.incoming_shipments set tracking_number='1Z' where id=$1 returning *`, [shipment]);
  assert.equal(s.created_by, ALICE); assert.equal(s.updated_by, null);
  const n = await one(`insert into public.incoming_shipments(shipment_status, created_by) values ('Shipped', $1) returning *`, [BOB]);
  assert.equal(n.created_by, BOB, 'a service-role import may name the person it writes for');
});

await test('nobody can call the trigger function directly', async () => {
  const r = await one(`select has_function_privilege('authenticated', 'public.stamp_shipment_audit()', 'execute') a,
    has_function_privilege('anon', 'public.stamp_shipment_audit()', 'execute') b`);
  assert.equal(r.a, false); assert.equal(r.b, false);
});

await test('the trigger still fires for a signed-in browser role (the revoke does not block it)', async () => {
  await db.exec(`grant select, insert, update on public.incoming_shipments, public.incoming_shipment_lines to authenticated`);
  await asUser(ALICE);
  await db.exec('set role authenticated');
  try {
    const s = await one(`insert into public.incoming_shipments(shipment_status) values ('Delivered') returning created_by, updated_by`);
    assert.equal(s.created_by, ALICE); assert.equal(s.updated_by, ALICE);
  } finally { await db.exec('reset role'); }
});

console.log(`\n${checks} checks passed`);
