process.on('uncaughtException', (error) => { console.error('\nFAILED:', error.message); process.exit(1); });
process.on('unhandledRejection', (error) => { console.error('\nFAILED:', error?.message || error); process.exit(1); });

// 20261128040000_landed_cost_bill_bank.sql against a real PostgreSQL.
//
// The bank is the answer to a measured production failure: with freight typed
// as a number on a PO, one forwarder invoice covering several POs was entered
// IN FULL on each of them. $27,502 of the $66,929 of freight in landed cost
// was the same money counted more than once, while 19 of 25 freight invoices
// had never reached a PO at all.
//
// What this suite pins:
//   - a freight payment request mirrors into the bank, and follows it
//   - a bill cannot be spent for more than it holds, by any route
//   - an allocation cannot name another PO's container, or another company's PO
//   - re-stating a split is atomic: a refusal leaves the old split intact
//   - the backfill MOVES NO NUMBER: every PO keeps the freight it had
//   - the PO lines whose factory cost was overwritten with landed cost are
//     restored, and only those
//
// Run: node scripts/tests/landed-cost-bank-database.test.mjs
// (needs `npm ci --prefix scripts/tests/finance-db --ignore-scripts`)
//
// Mutations (each must fail a check):
//   BANK_MUTATION=no-guard          the over-allocation guard never fires
//   BANK_MUTATION=no-shipment-check a bill may name another PO's container
//   BANK_MUTATION=no-tenant-check   a bill may be spent on another company's PO
//   BANK_MUTATION=no-legacy         the backfill drops a PO that cannot match a bill
//   BANK_MUTATION=no-restore        the overwritten factory costs are left alone
//   BANK_MUTATION=no-dup-index      the same bill may go on the same PO twice
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const root = new URL('../../', import.meta.url);
const MIGRATION = 'supabase/migrations/20261128040000_landed_cost_bill_bank.sql';
let migration = await readFile(new URL(MIGRATION, root), 'utf8');

const mutation = process.env.BANK_MUTATION || '';
const mutate = (from, to) => {
  assert.ok(migration.includes(from), `mutation anchor not found: ${from.slice(0, 70)}`);
  migration = migration.replace(from, to);
};
if (mutation === 'no-guard') {
  mutate('  if v_other + new.amount > v_bill.amount + 0.005 then', '  if false then');
}
if (mutation === 'no-shipment-check') {
  mutate('    if v_sh_po is null or v_sh_po is distinct from new.po_header_id then', '    if false then');
}
if (mutation === 'no-tenant-check') {
  mutate('  if v_po_co is null or v_po_co is distinct from v_bill.company_entity_id then', '  if false then');
}
if (mutation === 'no-legacy') {
  // The duplicate keeps no bill at all, so its PO silently loses its freight.
  mutate(`    if v_bill is null then
      insert into public.landed_cost_bills (`, `    if v_bill is null then
      continue;
    end if;
    if false then
      insert into public.landed_cost_bills (`);
}
if (mutation === 'no-restore') {
  mutate('   and abs(p.unit_cost - l.landed_unit) < 0.005', '   and false');
}
if (mutation === 'no-dup-index') {
  // Without it, one bill can be put on the same PO twice -- the exact shape of
  // the production failure, just under the allocation ceiling each time.
  mutate(`create unique index if not exists landed_cost_allocations_po_key
  on public.landed_cost_allocations (bill_id, po_header_id)
  where shipment_id is null;`, '');
}

const db = new PGlite();
let checks = 0;
const test = async (name, fn) => { await fn(); checks += 1; console.log(`ok ${checks} - ${name}`); };
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const all = async (sql, params) => (await db.query(sql, params)).rows;
const n = (v) => (v == null ? null : Number(v));
const refused = async (sql, params) => {
  try { await db.query(sql, params); return null; }
  catch (err) { return String(err.message || err); }
};

const CO_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const CO_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BRUNO = '22222222-2222-4222-8222-222222222222';
const asUser = (uid) => db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid || '']);

// ── The production shape this migration lands on ───────────────────────────
await db.exec(`
  create schema if not exists auth;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create table auth.users(id uuid primary key);
  insert into auth.users values ('${ALICE}'), ('${BRUNO}');
  do $$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  end $$;

  create table public.entities(id uuid primary key, name text);
  insert into public.entities values ('${CO_A}','Company A'), ('${CO_B}','Company B');

  create table public.profiles(id uuid primary key, active_company_id uuid, can_cost boolean default true);
  insert into public.profiles values ('${ALICE}','${CO_A}', true), ('${BRUNO}','${CO_B}', true);

  create function public.active_company_id() returns uuid language sql stable security definer as
    $$ select active_company_id from public.profiles where id = auth.uid() $$;
  create function public.po_costing_can_write() returns boolean language sql stable security definer as
    $$ select coalesce((select can_cost from public.profiles where id = auth.uid()), false) $$;
  create function public.set_updated_at() returns trigger language plpgsql as
    $$ begin new.updated_at = now(); return new; end $$;
  create function public.stamp_company_entity_id() returns trigger language plpgsql as
    $$ begin
         if new.company_entity_id is null then new.company_entity_id := public.active_company_id(); end if;
         return new;
       end $$;
  create function public.attach_stamp_company_entity_id_triggers() returns void language plpgsql as
    $$ begin null; end $$;
  create function public.refresh_chat_schema_catalog() returns void language plpgsql as
    $$ begin null; end $$;

  create table public.po_headers(id uuid primary key default gen_random_uuid(), po_name text,
    status text default 'Draft', internal_notes text,
    company_entity_id uuid references public.entities(id), created_at timestamptz default now());
  create table public.po_lines(id uuid primary key default gen_random_uuid(),
    po_header_id uuid not null references public.po_headers(id) on delete cascade,
    sku_snapshot text, title_snapshot text, variant_title_snapshot text,
    unit_cost numeric, qty numeric, retail_price numeric, line_notes text,
    company_entity_id uuid, created_at timestamptz default now());
  create table public.incoming_shipments(id uuid primary key default gen_random_uuid(),
    po_header_id uuid references public.po_headers(id) on delete cascade,
    shipment_status text, ship_date date, eta date, received_date date, container_ref text,
    carrier text, company_entity_id uuid, created_at timestamptz default now());
  create table public.incoming_shipment_lines(id uuid primary key default gen_random_uuid(),
    shipment_id uuid references public.incoming_shipments(id) on delete cascade,
    po_line_id uuid references public.po_lines(id) on delete cascade, qty numeric,
    company_entity_id uuid);
  create table public.payment_requests(id uuid primary key default gen_random_uuid(),
    vendor_name text, vendor_name_manual text, request_type text not null,
    invoice_number text, internal_po_number text, amount_due numeric not null,
    due_date date, date_completed date, submitted_at timestamptz not null default now(),
    created_at timestamptz not null default now(), created_by uuid,
    company_entity_id uuid references public.entities(id));
  create table public.po_costing(id uuid primary key default gen_random_uuid(),
    po_header_id uuid unique references public.po_headers(id) on delete cascade,
    phase text default 'fob', freight_amount numeric(14,2) default 0, duty_pct numeric(8,4) default 0,
    misc_amount numeric(14,2) default 0, alloc_method text default 'proportional',
    freight_invoice_ref text, freight_carrier text, fob_total numeric, duty_amount numeric,
    landed_total numeric, shipped_at timestamptz, company_entity_id uuid,
    updated_at timestamptz default now());
  create table public.po_costing_lines(id uuid primary key default gen_random_uuid(),
    po_costing_id uuid references public.po_costing(id) on delete cascade,
    po_line_id uuid unique references public.po_lines(id) on delete cascade,
    fob_unit numeric, landed_unit numeric, company_entity_id uuid);
`);

// ── The production cases, by name ──────────────────────────────────────────
// MasterCap-84/87/88/89: one $5,531 invoice, typed as $999.75 on each (short).
// MasterCap-78-S/82:     one $3,839.99 invoice, typed IN FULL on both.
// MasterCap-79/80:       a $7,887.50 invoice with no reference typed at all.
const PO = {
  m84: 'c0000000-0000-4000-8000-000000000084',
  m87: 'c0000000-0000-4000-8000-000000000087',
  m88: 'c0000000-0000-4000-8000-000000000088',
  m89: 'c0000000-0000-4000-8000-000000000089',
  m78: 'c0000000-0000-4000-8000-000000000078',
  m82: 'c0000000-0000-4000-8000-000000000082',
  m79: 'c0000000-0000-4000-8000-000000000079',
  m80: 'c0000000-0000-4000-8000-000000000080',
  other: 'd0000000-0000-4000-8000-00000000000b',
};

await db.exec(`
  insert into public.po_headers(id, po_name, company_entity_id) values
    ('${PO.m84}','MasterCap-84','${CO_A}'), ('${PO.m87}','MasterCap-87','${CO_A}'),
    ('${PO.m88}','MasterCap-88','${CO_A}'), ('${PO.m89}','MasterCap-89','${CO_A}'),
    ('${PO.m78}','MasterCap-78-S','${CO_A}'), ('${PO.m82}','MasterCap-82','${CO_A}'),
    ('${PO.m79}','MasterCap-79','${CO_A}'), ('${PO.m80}','MasterCap-80','${CO_A}'),
    ('${PO.other}','OtherCo-1','${CO_B}');

  insert into public.po_lines(id, po_header_id, sku_snapshot, unit_cost, qty, company_entity_id) values
    ('11110000-0000-4000-8000-000000000001','${PO.m87}','A', 10, 100, '${CO_A}'),
    ('11110000-0000-4000-8000-000000000002','${PO.m87}','B', 10, 100, '${CO_A}'),
    ('11110000-0000-4000-8000-000000000003','${PO.m87}','C', 10, 100, '${CO_A}'),
    ('11110000-0000-4000-8000-000000000004','${PO.m87}','D', 10, 100, '${CO_A}');

  -- MasterCap-87 ships in two containers: A+B, then C+D.
  insert into public.incoming_shipments(id, po_header_id, shipment_status, container_ref, company_entity_id) values
    ('22220000-0000-4000-8000-000000000001','${PO.m87}','Received','BOX-1','${CO_A}'),
    ('22220000-0000-4000-8000-000000000002','${PO.m87}','In Transit','BOX-2','${CO_A}');
  insert into public.incoming_shipment_lines(shipment_id, po_line_id, qty, company_entity_id) values
    ('22220000-0000-4000-8000-000000000001','11110000-0000-4000-8000-000000000001',100,'${CO_A}'),
    ('22220000-0000-4000-8000-000000000001','11110000-0000-4000-8000-000000000002',100,'${CO_A}'),
    ('22220000-0000-4000-8000-000000000002','11110000-0000-4000-8000-000000000003',100,'${CO_A}'),
    ('22220000-0000-4000-8000-000000000002','11110000-0000-4000-8000-000000000004',100,'${CO_A}');

  insert into public.payment_requests(request_type, invoice_number, vendor_name, amount_due, internal_po_number, company_entity_id) values
    ('inventory_freight','ARJFK261001106','Air Tiger', 5531.00, 'MasterCap-84, MasterCap-87', '${CO_A}'),
    ('inventory_freight','ARJFK260801268','Air Tiger', 3839.99, 'MasterCap-78-S, MasterCap-82', '${CO_A}'),
    ('invoice_vendor_payment','NOT-FREIGHT','Someone', 100.00, null, '${CO_A}');

  insert into public.po_costing(po_header_id, freight_amount, freight_invoice_ref, freight_carrier, company_entity_id, updated_at) values
    ('${PO.m84}', 999.75, 'ARJFK261001106','Air Tiger','${CO_A}', now() - interval '6 min'),
    ('${PO.m87}', 999.75, 'ARJFK261001106','Air Tiger','${CO_A}', now() - interval '5 min'),
    ('${PO.m88}', 999.75, 'ARJFK261001106','Air Tiger','${CO_A}', now() - interval '4 min'),
    ('${PO.m89}', 999.75, 'ARJFK261001106','Air Tiger','${CO_A}', now() - interval '3 min'),
    ('${PO.m78}',3839.99, 'ARJFK260801268','Air Tiger','${CO_A}', now() - interval '2 min'),
    ('${PO.m82}',3839.99, 'ARJFK260801268','Air Tiger','${CO_A}', now() - interval '1 min'),
    ('${PO.m79}',7887.50, '', null,'${CO_A}', now()),
    ('${PO.m80}',7887.50, '', null,'${CO_A}', now() + interval '1 min');

  -- MasterCap-87's lines carry the landed cost in unit_cost, which is what the
  -- old "Push landed to PO lines" default did on production (134 lines).
  insert into public.po_costing(po_header_id, company_entity_id) values ('${PO.other}', '${CO_B}');
  insert into public.po_costing_lines(po_costing_id, po_line_id, fob_unit, landed_unit, company_entity_id)
  select pc.id, pl.id, 10, 12.50, '${CO_A}'
    from public.po_costing pc join public.po_lines pl on pl.po_header_id = pc.po_header_id
   where pc.po_header_id = '${PO.m87}';
  update public.po_lines set unit_cost = 12.50 where po_header_id = '${PO.m87}';
`);

// One line is deliberately set to something that is NEITHER its FOB nor its
// landed cost: somebody typed it. The restore must leave it alone.
await db.exec(`update public.po_lines set unit_cost = 11.11 where id = '11110000-0000-4000-8000-000000000004';`);

const FREIGHT_BEFORE = Object.fromEntries(
  (await all('select po_header_id, freight_amount from public.po_costing where freight_amount > 0'))
    .map((r) => [r.po_header_id, n(r.freight_amount)]),
);

await db.exec(migration);

// ───────────────────────────────────────────────────────────────────────────

await test('a freight payment request is a bill; other request types are not', async () => {
  const bills = await all(`select bill_ref, amount, source from public.landed_cost_bills
                            where source = 'payment_request' order by bill_ref`);
  assert.equal(bills.length, 2, 'two freight invoices, and only those');
  assert.deepEqual(bills.map((b) => b.bill_ref), ['ARJFK260801268', 'ARJFK261001106']);
  assert.equal(n(bills[1].amount), 5531);
});

await test('the backfill moves no number: every PO keeps the freight it had', async () => {
  const after = await all(`
    select pc.po_header_id, pc.freight_amount typed, coalesce(t.freight_allocated, 0) allocated
      from public.po_costing pc
      left join public.v_po_landed_cost_totals t on t.po_header_id = pc.po_header_id
     where pc.freight_amount > 0`);
  assert.equal(after.length, Object.keys(FREIGHT_BEFORE).length);
  for (const row of after) {
    assert.equal(n(row.typed), FREIGHT_BEFORE[row.po_header_id], 'the typed figure is untouched');
    assert.equal(n(row.allocated), FREIGHT_BEFORE[row.po_header_id],
      `${row.po_header_id}: allocation must reproduce the freight it had`);
  }
});

await test('the duplicate is visible as a legacy bill beside the paid one', async () => {
  // $3,839.99 was paid once and typed on two POs. The first fits the paid bill;
  // the second has to go somewhere a person can see it.
  const rows = await all(`
    select b.source, b.amount, v.allocated, v.remaining, v.po_names
      from public.v_landed_cost_bill_balance v
      join public.landed_cost_bills b on b.id = v.bill_id
     where coalesce(b.bill_ref,'') = 'ARJFK260801268' order by b.source`);
  assert.equal(rows.length, 2, 'the paid bill and a legacy stub');
  assert.equal(rows[0].source, 'legacy');
  assert.equal(rows[1].source, 'payment_request');
  assert.equal(n(rows[1].allocated), 3839.99, 'the paid bill is fully spent');
});

await test('an invoice typed with no reference becomes one legacy bill per PO', async () => {
  const rows = await all(`
    select v.allocated, v.po_names from public.v_landed_cost_bill_balance v
      join public.landed_cost_bills b on b.id = v.bill_id
     where b.source = 'legacy' and b.amount = 7887.50 order by v.po_names`);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.po_names), ['MasterCap-79', 'MasterCap-80']);
});

await test('the shortfall on a real invoice is visible as money left over', async () => {
  // $5,531 paid, $999.75 x 4 = $3,999 typed. $1,532 of freight was nowhere.
  const row = await one(`select amount, allocated, remaining, allocation_state
                           from public.v_landed_cost_bill_balance
                          where bill_ref = 'ARJFK261001106' and source = 'payment_request'`);
  assert.equal(n(row.allocated), 3999);
  assert.equal(n(row.remaining), 1532);
  assert.equal(row.allocation_state, 'partial');
});

await test('the overwritten factory costs are restored, and only those', async () => {
  const rows = await all(`select id, unit_cost from public.po_lines
                           where po_header_id = '${PO.m87}' order by sku_snapshot`);
  assert.deepEqual(rows.slice(0, 3).map((r) => n(r.unit_cost)), [10, 10, 10],
    'lines sitting at their landed cost go back to FOB');
  assert.equal(n(rows[3].unit_cost), 11.11, 'a line somebody typed is left alone');
});

await test('a bill cannot be spent for more than it holds', async () => {
  await asUser(ALICE);
  const bill = await one(`select id from public.landed_cost_bills
                           where bill_ref = 'ARJFK261001106' and source = 'payment_request'`);
  const err = await refused(
    `insert into public.landed_cost_allocations(company_entity_id, bill_id, po_header_id, amount)
       values ($1, $2, $3, 2000)`, [CO_A, bill.id, PO.m79]);
  assert.ok(err && /overspend/.test(err), `expected a refusal, got ${err}`);

  // Exactly what is left is fine, and then nothing more is.
  await db.query(
    `insert into public.landed_cost_allocations(company_entity_id, bill_id, po_header_id, amount)
       values ($1, $2, $3, 1532.00)`, [CO_A, bill.id, PO.m79]);
  const err2 = await refused(
    `insert into public.landed_cost_allocations(company_entity_id, bill_id, po_header_id, amount)
       values ($1, $2, $3, 0.01)`, [CO_A, bill.id, PO.m80]);
  assert.ok(err2 && /overspend/.test(err2), `expected a refusal at one cent over, got ${err2}`);
  await db.query(`delete from public.landed_cost_allocations where po_header_id = $1 and amount = 1532.00`, [PO.m79]);
});

await test("an allocation cannot name another PO's container", async () => {
  await asUser(ALICE);
  const bill = await one(`select id from public.landed_cost_bills where source='legacy' and amount = 7887.50 limit 1`);
  const err = await refused(
    `insert into public.landed_cost_allocations(company_entity_id, bill_id, po_header_id, shipment_id, amount)
       values ($1, $2, $3, '22220000-0000-4000-8000-000000000001', 1)`, [CO_A, bill.id, PO.m88]);
  assert.ok(err && /does not belong/.test(err), `expected a refusal, got ${err}`);
});

await test("a bill cannot be spent on another company's PO", async () => {
  await asUser(ALICE);
  const bill = await one(`select id from public.landed_cost_bills where source='legacy' and amount = 7887.50 limit 1`);
  const err = await refused(
    `insert into public.landed_cost_allocations(company_entity_id, bill_id, po_header_id, amount)
       values ($1, $2, $3, 1)`, [CO_A, bill.id, PO.other]);
  assert.ok(err && /different companies/.test(err), `expected a refusal, got ${err}`);
});

await test('re-stating a split is atomic: a refusal leaves the old one intact', async () => {
  await asUser(ALICE);
  const bill = await one(`select id, amount from public.landed_cost_bills
                           where bill_ref = 'ARJFK261001106' and source = 'payment_request'`);
  const before = await all(`select po_header_id, amount from public.landed_cost_allocations
                             where bill_id = $1 order by amount`, [bill.id]);
  assert.equal(before.length, 4);

  const err = await refused(`select * from public.silo_allocate_landed_cost_bill($1, $2::jsonb)`,
    [bill.id, JSON.stringify([{ po_header_id: PO.m87, amount: 9999 }])]);
  assert.ok(err, 'an overspending re-split must be refused');

  const after = await all(`select po_header_id, amount from public.landed_cost_allocations
                            where bill_id = $1 order by amount`, [bill.id]);
  assert.deepEqual(after.map((r) => n(r.amount)), before.map((r) => n(r.amount)),
    'the split that was there must survive the refusal');
});

await test('a split that fits is applied whole, down to the cent', async () => {
  await asUser(ALICE);
  const bill = await one(`select id from public.landed_cost_bills
                           where bill_ref = 'ARJFK261001106' and source = 'payment_request'`);
  // The real split of that invoice across the four POs it names, by factory
  // value: it has to total $5,531.00 exactly.
  const rows = [
    { po_header_id: PO.m87, amount: 3650.62, method: 'value' },
    { po_header_id: PO.m88, amount: 742.34, method: 'value' },
    { po_header_id: PO.m89, amount: 578.45, method: 'value' },
    { po_header_id: PO.m84, amount: 559.59, method: 'value' },
  ];
  const out = await all(`select * from public.silo_allocate_landed_cost_bill($1, $2::jsonb)`,
    [bill.id, JSON.stringify(rows)]);
  assert.equal(out.length, 4);
  const bal = await one(`select allocated, remaining, allocation_state
                           from public.v_landed_cost_bill_balance where bill_id = $1`, [bill.id]);
  assert.equal(n(bal.allocated), 5531);
  assert.equal(n(bal.remaining), 0);
  assert.equal(bal.allocation_state, 'allocated');
});

await test('a split may name a container, and the view says which', async () => {
  await asUser(ALICE);
  const bill = await one(`select id from public.landed_cost_bills
                           where bill_ref = 'ARJFK260801268' and source = 'payment_request'`);
  await db.query(`select * from public.silo_allocate_landed_cost_bill($1, $2::jsonb)`,
    [bill.id, JSON.stringify([
      { po_header_id: PO.m87, shipment_id: '22220000-0000-4000-8000-000000000001', amount: 2000, method: 'units' },
      { po_header_id: PO.m87, shipment_id: '22220000-0000-4000-8000-000000000002', amount: 1839.99, method: 'units' },
    ])]);
  const rows = await all(`select container_ref, amount from public.v_po_landed_cost_allocations
                           where bill_id = $1 order by amount desc`, [bill.id]);
  assert.deepEqual(rows.map((r) => r.container_ref), ['BOX-1', 'BOX-2']);
  assert.equal(n(rows[0].amount), 2000);
});

await test('AP correcting the invoice moves the bill with it', async () => {
  await db.query(`update public.payment_requests set amount_due = 6000 where invoice_number = 'ARJFK261001106'`);
  const row = await one(`select amount, remaining from public.v_landed_cost_bill_balance
                          where bill_ref = 'ARJFK261001106' and source = 'payment_request'`);
  assert.equal(n(row.amount), 6000);
  assert.equal(n(row.remaining), 469);
});

await test('a correction BELOW what is allocated is shown, not hidden', async () => {
  await db.query(`update public.payment_requests set amount_due = 1000 where invoice_number = 'ARJFK261001106'`);
  const row = await one(`select remaining, allocation_state from public.v_landed_cost_bill_balance
                          where bill_ref = 'ARJFK261001106' and source = 'payment_request'`);
  assert.equal(n(row.remaining), -4531);
  assert.equal(row.allocation_state, 'over', 'somebody has to see this and fix it');
  await db.query(`update public.payment_requests set amount_due = 5531 where invoice_number = 'ARJFK261001106'`);
});

await test('a request retyped away from freight drops its bill only while unspent', async () => {
  await db.exec(`insert into public.payment_requests(request_type, invoice_number, vendor_name, amount_due, company_entity_id)
                 values ('inventory_freight','SPARE-1','Carrier', 500, '${CO_A}')`);
  assert.ok(await one(`select id from public.landed_cost_bills where bill_ref = 'SPARE-1'`));
  await db.query(`update public.payment_requests set request_type = 'invoice_vendor_payment' where invoice_number = 'SPARE-1'`);
  assert.equal(await one(`select id from public.landed_cost_bills where bill_ref = 'SPARE-1'`), undefined,
    'an unspent bill goes with it');

  const spent = await one(`select id from public.landed_cost_bills
                            where bill_ref = 'ARJFK260801268' and source = 'payment_request'`);
  await db.query(`update public.payment_requests set request_type = 'invoice_vendor_payment' where invoice_number = 'ARJFK260801268'`);
  assert.ok(await one(`select id from public.landed_cost_bills where id = $1`, [spent.id]),
    'a bill already paying for a PO stays, or that PO loses its landed cost');
  await db.query(`update public.payment_requests set request_type = 'inventory_freight' where invoice_number = 'ARJFK260801268'`);
});

await test('RLS keeps one company out of another company\'s bank', async () => {
  await db.exec(`
    alter table public.landed_cost_bills force row level security;
    alter table public.landed_cost_allocations force row level security;
    grant usage on schema public to authenticated;
  `);
  await db.exec(`set role authenticated`);
  await asUser(BRUNO);
  const seen = await all(`select id from public.landed_cost_bills`);
  assert.equal(seen.length, 0, "Company B sees none of Company A's bills");
  await asUser(ALICE);
  const mine = await all(`select id from public.landed_cost_bills`);
  assert.ok(mine.length > 0, 'Company A sees its own');
  await db.exec(`reset role`);
});

await test('the same bill cannot be put on the same PO twice', async () => {
  // The production failure typed one invoice onto four POs. Within one PO the
  // same shape is a bill allocated to it twice, and the unique index -- not the
  // amount guard -- is what refuses that while there is still budget left.
  await asUser(ALICE);
  await db.exec(`insert into public.payment_requests(request_type, invoice_number, vendor_name, amount_due, company_entity_id)
                 values ('inventory_freight','DUP-1','Carrier', 900, '${CO_A}')`);
  const bill = await one(`select id from public.landed_cost_bills where bill_ref = 'DUP-1'`);
  await db.query(`insert into public.landed_cost_allocations(company_entity_id, bill_id, po_header_id, amount)
                  values ($1, $2, $3, 100)`, [CO_A, bill.id, PO.m80]);
  const err = await refused(
    `insert into public.landed_cost_allocations(company_entity_id, bill_id, po_header_id, amount)
       values ($1, $2, $3, 100)`, [CO_A, bill.id, PO.m80]);
  assert.ok(err && /duplicate key|unique/i.test(err), `expected a refusal, got ${err}`);

  // Per CONTAINER is a different target, and that one is allowed.
  await db.query(`insert into public.landed_cost_allocations(company_entity_id, bill_id, po_header_id, shipment_id, amount)
                  values ($1, $2, $3, '22220000-0000-4000-8000-000000000001', 100)`, [CO_A, bill.id, PO.m87]);
  const err2 = await refused(
    `insert into public.landed_cost_allocations(company_entity_id, bill_id, po_header_id, shipment_id, amount)
       values ($1, $2, $3, '22220000-0000-4000-8000-000000000001', 100)`, [CO_A, bill.id, PO.m87]);
  assert.ok(err2 && /duplicate key|unique/i.test(err2), 'and not the same container twice');
});

await test('neither anon nor a plain select reaches the guard functions', async () => {
  const grants = await all(`
    select grantee from information_schema.routine_privileges
     where specific_schema = 'public'
       and routine_name in ('landed_cost_allocation_guard', 'landed_cost_bill_sync')`);
  assert.deepEqual(grants.filter((g) => ['anon', 'authenticated'].includes(g.grantee)), [],
    'a trigger function is nobody\'s to call directly');

  // Revoking those two roles by name is not enough. Postgres grants EXECUTE on
  // every new function to PUBLIC, and information_schema does not show a PUBLIC
  // grant at all -- so a migration that revokes only anon and authenticated
  // leaves both of them holding EXECUTE through PUBLIC, and this test passed
  // while they did. A null proacl means the default (PUBLIC may execute); an
  // aclitem whose grantee is empty is an explicit PUBLIC grant.
  const open = await all(`
    select p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('landed_cost_allocation_guard', 'landed_cost_bill_sync',
                         'silo_allocate_landed_cost_bill')
       and (p.proacl is null
            or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))`);
  assert.deepEqual(open.map((r) => r.proname), [],
    'PUBLIC still holds EXECUTE, so every role does');
});

console.log(`\n${checks} checks passed`);
await db.close();
