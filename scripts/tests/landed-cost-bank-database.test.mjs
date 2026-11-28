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
//   BANK_MUTATION=no-correct        a duplicated invoice is carried forward, not split
//   BANK_MUTATION=no-amount-match   an invoice with no reference is never recognised
//   BANK_MUTATION=no-bill-guard     costing may rewrite or delete an AP-sourced bill
//   BANK_MUTATION=no-detach-flag    a deleted container's freight respreads silently
//   BANK_MUTATION=no-costing-sync   the stored PO totals stop following the bills
//   BANK_MUTATION=no-line-recost    the per-SKU shares keep their old figures
//   BANK_MUTATION=no-receipt        the correction leaves no record of what moved
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
  // What nothing explains is dropped, so a PO silently loses its freight.
  mutate(`    insert into public.landed_cost_bills (
      company_entity_id, source, kind, vendor_name, bill_ref, bill_date, amount, notes
    ) values (
      po.company_entity_id, 'legacy',`, `    continue;
    insert into public.landed_cost_bills (
      company_entity_id, source, kind, vendor_name, bill_ref, bill_date, amount, notes
    ) values (
      po.company_entity_id, 'legacy',`);
}
if (mutation === 'no-correct') {
  // Back to carrying each PO's typed figure forward unchanged -- which is
  // exactly the queue of duplicates Blake refused.
  mutate('    select p.bill_id, array_agg(p.po_header_id order by p.po_header_id) as po_ids\n      from picked p group by p.bill_id',
         '    select p.bill_id, array_agg(p.po_header_id) as po_ids\n      from picked p where false group by p.bill_id');
}
if (mutation === 'no-amount-match') {
  mutate("         and t.freight_amount = b.amount\n       where not exists (select 1 from by_ref r where r.bill_id = b.id)",
         "         and false\n       where not exists (select 1 from by_ref r where r.bill_id = b.id)");
}
if (mutation === 'no-bill-guard') {
  mutate(`create trigger zz_landed_cost_bill_guard
  before update or delete on public.landed_cost_bills`,
         `create trigger zz_landed_cost_bill_guard
  before insert on public.landed_cost_bills`);
}
if (mutation === 'no-detach-flag') {
  mutate('    new.shipment_detached := true;', '    new.shipment_detached := false;');
}
if (mutation === 'no-line-recost') {
  mutate(' where f.line_id = cl.id;', ' where f.line_id = cl.id and false;');
}
if (mutation === 'no-receipt') {
  mutate(`     and not exists (select 1 from public.landed_cost_backfill_log l
                      where l.po_header_id = pc.po_header_id);`,
         `     and not exists (select 1 from public.landed_cost_backfill_log l
                      where l.po_header_id = pc.po_header_id) and false;`);
}
if (mutation === 'no-costing-sync') {
  mutate(`create trigger zz_landed_cost_sync_po_costing
  after insert or update or delete on public.landed_cost_allocations
  for each row execute function public.landed_cost_sync_po_costing();`, '');
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
    fob_unit numeric, freight_alloc numeric, duty_alloc numeric, misc_alloc numeric,
    landed_unit numeric, landed_ext numeric, updated_at timestamptz default now(),
    company_entity_id uuid);
`);

// ── The production cases, by name ──────────────────────────────────────────
// MasterCap-84/87/88/89: one $5,531 invoice, typed as $999.75 on each (short).
// MasterCap-78-S/82:     one $3,839.99 invoice, typed IN FULL on both.
// MasterCap-79/80:       a $7,887.50 invoice typed IN FULL on both, with no
//                        reference -- recognised by its amount instead.
// KCMTAR-34:             freight with no reference and no invoice to match.
const PO = {
  m84: 'c0000000-0000-4000-8000-000000000084',
  m87: 'c0000000-0000-4000-8000-000000000087',
  m88: 'c0000000-0000-4000-8000-000000000088',
  m89: 'c0000000-0000-4000-8000-000000000089',
  m78: 'c0000000-0000-4000-8000-000000000078',
  m82: 'c0000000-0000-4000-8000-000000000082',
  m79: 'c0000000-0000-4000-8000-000000000079',
  m80: 'c0000000-0000-4000-8000-000000000080',
  kcm: 'c0000000-0000-4000-8000-000000000034',
  other: 'd0000000-0000-4000-8000-00000000000b',
};

await db.exec(`
  insert into public.po_headers(id, po_name, company_entity_id) values
    ('${PO.m84}','MasterCap-84','${CO_A}'), ('${PO.m87}','MasterCap-87','${CO_A}'),
    ('${PO.m88}','MasterCap-88','${CO_A}'), ('${PO.m89}','MasterCap-89','${CO_A}'),
    ('${PO.m78}','MasterCap-78-S','${CO_A}'), ('${PO.m82}','MasterCap-82','${CO_A}'),
    ('${PO.m79}','MasterCap-79','${CO_A}'), ('${PO.m80}','MasterCap-80','${CO_A}'),
    ('${PO.kcm}','KCMTAR-34','${CO_A}'),
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
    ('inventory_freight','ARJFK260900741','Air Tiger', 7887.50, null, '${CO_A}'),
    ('invoice_vendor_payment','NOT-FREIGHT','Someone', 100.00, null, '${CO_A}');

  insert into public.po_costing(po_header_id, freight_amount, freight_invoice_ref, freight_carrier, company_entity_id, updated_at) values
    ('${PO.m84}', 999.75, 'ARJFK261001106','Air Tiger','${CO_A}', now() - interval '6 min'),
    ('${PO.m87}', 999.75, 'ARJFK261001106','Air Tiger','${CO_A}', now() - interval '5 min'),
    ('${PO.m88}', 999.75, 'ARJFK261001106','Air Tiger','${CO_A}', now() - interval '4 min'),
    ('${PO.m89}', 999.75, 'ARJFK261001106','Air Tiger','${CO_A}', now() - interval '3 min'),
    ('${PO.m78}',3839.99, 'ARJFK260801268','Air Tiger','${CO_A}', now() - interval '2 min'),
    ('${PO.m82}',3839.99, 'ARJFK260801268','Air Tiger','${CO_A}', now() - interval '1 min'),
    ('${PO.m79}',7887.50, '', null,'${CO_A}', now()),
    ('${PO.m80}',7887.50, '', null,'${CO_A}', now() + interval '1 min'),
    ('${PO.kcm}',3894.95, '', null,'${CO_A}', now() + interval '2 min');

  -- MasterCap-87's lines carry the landed cost in unit_cost, which is what the
  -- old "Push landed to PO lines" default did on production (134 lines).
  insert into public.po_costing(po_header_id, company_entity_id) values ('${PO.other}', '${CO_B}');
  insert into public.po_costing_lines(po_costing_id, po_line_id, fob_unit, freight_alloc, landed_unit, landed_ext, company_entity_id)
  select pc.id, pl.id, 10, 249.9375, 12.50, 1250, '${CO_A}'
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
  assert.equal(bills.length, 3, 'three freight invoices, and only those');
  assert.deepEqual(bills.map((b) => b.bill_ref),
    ['ARJFK260801268', 'ARJFK260900741', 'ARJFK261001106']);
  assert.equal(n(bills[2].amount), 5531);
});

await test('every dollar of freight paid is allocated exactly once', async () => {
  // The whole point. Not "nothing moves" -- the typed numbers were WRONG, and
  // Blake asked for them corrected rather than queued: "if cogs math is wrong
  // by 59k need it to auto correct not create some new queue to work".
  const rows = await all(`
    select b.bill_ref, b.source, b.amount, v.allocated, v.allocation_state
      from public.v_landed_cost_bill_balance v
      join public.landed_cost_bills b on b.id = v.bill_id
     where b.source = 'payment_request' order by b.bill_ref`);
  assert.equal(rows.length, 3, 'three paid freight invoices');
  for (const r of rows) {
    assert.equal(n(r.allocated), n(r.amount),
      `${r.bill_ref}: an invoice is spent for exactly what was paid`);
    assert.equal(r.allocation_state, 'allocated');
  }
});

await test('an invoice typed in full on two POs is split, not kept twice', async () => {
  // $3,839.99 paid once, typed on BOTH MasterCap-78-S and MasterCap-82:
  // $7,679.98 of COGS against $3,839.99 of real money.
  const rows = await all(`
    select ph.po_name, a.amount, a.notes from public.landed_cost_allocations a
      join public.landed_cost_bills b on b.id = a.bill_id
      join public.po_headers ph on ph.id = a.po_header_id
     where b.bill_ref = 'ARJFK260801268' order by ph.po_name`);
  assert.deepEqual(rows.map((r) => r.po_name), ['MasterCap-78-S', 'MasterCap-82']);
  assert.equal(rows.reduce((t, r) => t + n(r.amount), 0), 3839.99, 'they total the invoice');
  assert.match(rows[0].notes, /entered in full on 2 purchase orders/);

  const stored = await all(`select freight_amount from public.po_costing
                             where po_header_id in ('${PO.m78}','${PO.m82}')`);
  assert.deepEqual(stored.map((r) => n(r.freight_amount)).sort((x, y) => x - y), [1919.99, 1920.00],
    'the stored total follows the allocation, so reports do not read the old figure');
});

await test('an invoice with NO reference is recognised by its amount', async () => {
  // MasterCap-79 and -80 each carry $7,887.50 with the reference field blank.
  // One paid invoice is exactly $7,887.50. N identical copies of one amount is
  // the signature of this mistake, so it is matched and split.
  const rows = await all(`
    select ph.po_name, a.amount from public.landed_cost_allocations a
      join public.landed_cost_bills b on b.id = a.bill_id
      join public.po_headers ph on ph.id = a.po_header_id
     where b.bill_ref = 'ARJFK260900741' order by ph.po_name`);
  assert.deepEqual(rows.map((r) => r.po_name), ['MasterCap-79', 'MasterCap-80']);
  assert.deepEqual(rows.map((r) => n(r.amount)), [3943.75, 3943.75],
    'neither PO has a costed line, so it splits evenly rather than weighing one at zero');
});

await test('a single PO whose amount happens to match is NOT matched by amount', async () => {
  // Only the reference may claim an invoice for one PO. Otherwise any PO whose
  // freight coincided with some invoice would be silently reattributed.
  const kcm = await one(`
    select b.source, b.amount, a.amount as allocated, b.notes
      from public.landed_cost_allocations a
      join public.landed_cost_bills b on b.id = a.bill_id
     where a.po_header_id = '${PO.kcm}'`);
  assert.equal(kcm.source, 'legacy', 'nothing explains it, so it keeps its own bill');
  assert.equal(n(kcm.allocated), 3894.95, 'and keeps its number exactly');
  assert.match(kcm.notes, /No paid freight invoice matches it/);
});

await test('the under-recorded invoice is made whole', async () => {
  // $5,531 paid, $999.75 typed on each of four POs = $3,999. $1,532 of freight
  // was in nobody's COGS at all.
  const rows = await all(`
    select ph.po_name, a.amount from public.landed_cost_allocations a
      join public.landed_cost_bills b on b.id = a.bill_id
      join public.po_headers ph on ph.id = a.po_header_id
     where b.bill_ref = 'ARJFK261001106' order by ph.po_name`);
  assert.equal(rows.reduce((t, r) => t + n(r.amount), 0), 5531);
  // Only MasterCap-87 has costed lines, so the even split applies.
  assert.equal(rows.length, 4, 'all four POs that typed it');
});

await test('nothing is left unallocated anywhere', async () => {
  const stray = await all(`
    select pc.po_header_id from public.po_costing pc
     where coalesce(pc.freight_amount, 0) > 0
       and not exists (select 1 from public.landed_cost_allocations a
                        where a.po_header_id = pc.po_header_id)`);
  assert.deepEqual(stray, [], 'every PO with freight has a bill behind it');
});

await test('the overwritten factory costs are restored, and only those', async () => {
  const rows = await all(`select id, unit_cost from public.po_lines
                           where po_header_id = '${PO.m87}' order by sku_snapshot`);
  assert.deepEqual(rows.slice(0, 3).map((r) => n(r.unit_cost)), [10, 10, 10],
    'lines sitting at their landed cost go back to FOB');
  assert.equal(n(rows[3].unit_cost), 11.11, 'a line somebody typed is left alone');
});

await test('the stored per-line shares are restated, and total the PO', async () => {
  // po_costing_lines is reportable too. Leaving the old per-SKU split behind
  // would have the screen and every report disagreeing about one PO.
  const rows = await all(`
    select cl.freight_alloc, cl.landed_unit, cl.landed_ext, pl.qty, cl.fob_unit
      from public.po_costing_lines cl
      join public.po_costing pc on pc.id = cl.po_costing_id
      join public.po_lines pl on pl.id = cl.po_line_id
     where pc.po_header_id = '${PO.m87}' order by pl.sku_snapshot`);
  assert.equal(rows.length, 4);
  const freight = n((await one(
    `select freight_amount from public.po_costing where po_header_id = '${PO.m87}'`)).freight_amount);
  const summed = Math.round(rows.reduce((t, r) => t + n(r.freight_alloc), 0) * 100) / 100;
  assert.equal(summed, freight, 'the line shares total the PO freight to the cent');
  assert.notEqual(n(rows[0].freight_alloc), 249.9375, 'and are not the figure stored before');
  for (const r of rows) {
    assert.equal(n(r.landed_ext),
      Math.round((n(r.fob_unit) * n(r.qty) + n(r.freight_alloc)) * 100) / 100,
      'landed_ext follows its own share');
  }
});

await test('the correction writes a receipt naming the rule that matched', async () => {
  const rows = await all(`
    select po_name, freight_before, freight_after, matched_by, bill_ref
      from public.landed_cost_backfill_log order by po_name`);
  assert.equal(rows.length, 9, 'one row per PO that had freight');

  const byName = Object.fromEntries(rows.map((r) => [r.po_name, r]));
  assert.equal(byName['MasterCap-78-S'].matched_by, 'reference');
  assert.equal(n(byName['MasterCap-78-S'].freight_before), 3839.99);
  assert.ok(n(byName['MasterCap-78-S'].freight_after) < 3839.99, 'and it says what it became');

  // The inference, which is the one worth checking by eye.
  assert.equal(byName['MasterCap-79'].matched_by, 'identical amount');
  assert.equal(byName['MasterCap-79'].bill_ref, 'ARJFK260900741');

  assert.equal(byName['KCMTAR-34'].matched_by, 'unmatched');
  assert.equal(n(byName['KCMTAR-34'].freight_before), 3894.95);
  assert.equal(n(byName['KCMTAR-34'].freight_after), 3894.95, 'an unmatched PO is not moved');
});

await test('the receipt is this company\'s only, and nobody can write it', async () => {
  await db.exec(`
    alter table public.landed_cost_backfill_log force row level security;
    grant usage on schema public to authenticated;
  `);
  await db.exec('set role authenticated');
  await asUser(BRUNO);
  const seen = await all('select po_name from public.landed_cost_backfill_log');
  assert.deepEqual(seen, [], 'another company sees none of it');
  await asUser(ALICE);
  const mine = await all('select po_name from public.landed_cost_backfill_log');
  assert.ok(mine.length > 0, 'and this company sees its own');
  const err = await refused(
    `insert into public.landed_cost_backfill_log(company_entity_id, po_header_id, matched_by)
       values ($1, $2, 'reference')`, [CO_A, PO.m84]);
  assert.ok(err, 'a browser role cannot forge a correction record');
  await db.exec('reset role');
});

await test('a bill cannot be spent for more than it holds', async () => {
  await asUser(ALICE);
  // A bill of its own, because the backfill now spends every paid invoice in
  // full -- there is deliberately no room left on any of them.
  const bill = await one(
    `insert into public.landed_cost_bills(company_entity_id, source, kind, bill_ref, amount)
       values ($1, 'manual', 'freight', 'TEST-ROOM', 2000.00) returning id`, [CO_A]);
  const err = await refused(
    `insert into public.landed_cost_allocations(company_entity_id, bill_id, po_header_id, amount)
       values ($1, $2, $3, 2000.01)`, [CO_A, bill.id, PO.m79]);
  assert.ok(err && /overspend/.test(err), `expected a refusal, got ${err}`);

  // Exactly what it holds is fine, and then nothing more is.
  await db.query(
    `insert into public.landed_cost_allocations(company_entity_id, bill_id, po_header_id, amount)
       values ($1, $2, $3, 2000.00)`, [CO_A, bill.id, PO.m79]);
  const err2 = await refused(
    `insert into public.landed_cost_allocations(company_entity_id, bill_id, po_header_id, amount)
       values ($1, $2, $3, 0.01)`, [CO_A, bill.id, PO.m80]);
  assert.ok(err2 && /overspend/.test(err2), `expected a refusal at one cent over, got ${err2}`);
  await db.query(`delete from public.landed_cost_allocations where bill_id = $1`, [bill.id]);
  await db.query(`delete from public.landed_cost_bills where id = $1`, [bill.id]);
});

await test("an allocation cannot name another PO's container", async () => {
  await asUser(ALICE);
  const bill = await one(`select id from public.landed_cost_bills where source='legacy' and amount = 3894.95 limit 1`);
  const err = await refused(
    `insert into public.landed_cost_allocations(company_entity_id, bill_id, po_header_id, shipment_id, amount)
       values ($1, $2, $3, '22220000-0000-4000-8000-000000000001', 1)`, [CO_A, bill.id, PO.m88]);
  assert.ok(err && /does not belong/.test(err), `expected a refusal, got ${err}`);
});

await test("a bill cannot be spent on another company's PO", async () => {
  await asUser(ALICE);
  const bill = await one(`select id from public.landed_cost_bills where source='legacy' and amount = 3894.95 limit 1`);
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

await test('an AP-sourced bill cannot be edited or deleted from costing', async () => {
  await asUser(ALICE);
  const bill = await one(`select id from public.landed_cost_bills
                           where bill_ref = 'ARJFK260801268' and source = 'payment_request'`);
  const err = await refused(`update public.landed_cost_bills set amount = 9999 where id = $1`, [bill.id]);
  assert.ok(err && /change the request, not the bill/.test(err),
    `raising an AP bill's amount must be refused, got ${err}`);

  const err2 = await refused(`delete from public.landed_cost_bills where id = $1`, [bill.id]);
  assert.ok(err2 && /allocated to a purchase order/.test(err2),
    `deleting a spent bill must be refused, got ${err2}`);

  // Reclassifying what the bill IS, and annotating it, stay costing decisions.
  await db.query(`update public.landed_cost_bills set kind = 'brokerage', notes = 'checked'
                   where id = $1`, [bill.id]);
  const after = await one(`select kind, amount from public.landed_cost_bills where id = $1`, [bill.id]);
  assert.equal(after.kind, 'brokerage');
  assert.equal(n(after.amount), 3839.99, 'and the amount is still what AP says');
  await db.query(`update public.landed_cost_bills set kind = 'freight' where id = $1`, [bill.id]);
});

await test('deleting a container flags its freight instead of respreading it', async () => {
  // shipment_id is ON DELETE SET NULL and a null shipment means "the whole PO".
  // Left alone, deleting one of two containers would spread that container's
  // freight over BOTH containers' units with nobody deciding anything.
  await asUser(ALICE);
  const bill = await one(
    `insert into public.landed_cost_bills(company_entity_id, source, kind, bill_ref, amount)
       values ($1, 'manual', 'freight', 'TEST-BOX', 500.00) returning id`, [CO_A]);
  await db.query(
    `insert into public.landed_cost_allocations(company_entity_id, bill_id, po_header_id, shipment_id, amount)
       values ($1, $2, $3, '22220000-0000-4000-8000-000000000002', 500.00)`, [CO_A, bill.id, PO.m87]);

  await db.query(`delete from public.incoming_shipments where id = '22220000-0000-4000-8000-000000000002'`);

  const row = await one(`select shipment_id, shipment_detached, amount
                           from public.landed_cost_allocations where bill_id = $1`, [bill.id]);
  assert.equal(row.shipment_id, null);
  assert.equal(row.shipment_detached, true, 'flagged for reassignment, not silently whole-PO');
  assert.equal(n(row.amount), 500, 'and the money is still on this PO');

  const view = await one(`select shipment_detached from public.v_po_landed_cost_allocations
                           where bill_id = $1`, [bill.id]);
  assert.equal(view.shipment_detached, true, 'the page can see it');
});

await test('the stored PO totals follow an allocation on ANY PO, not just the open one', async () => {
  // The cache po_costing.freight_amount is reportable: Ask SILO and saved
  // reports read it. Allocating one invoice across four POs used to refresh
  // only the PO somebody had open.
  await asUser(ALICE);
  const before = n((await one(
    `select freight_amount from public.po_costing where po_header_id = $1`, [PO.m84])).freight_amount);
  const bill = await one(`select id from public.landed_cost_bills
                           where bill_ref = 'ARJFK261001106' and source = 'payment_request'`);

  await db.query(`select * from public.silo_allocate_landed_cost_bill($1, $2::jsonb)`,
    [bill.id, JSON.stringify([{ po_header_id: PO.m84, amount: 5531 }])]);

  const m84 = n((await one(
    `select freight_amount from public.po_costing where po_header_id = $1`, [PO.m84])).freight_amount);
  assert.equal(m84, 5531, 'the PO that gained the whole bill');
  assert.notEqual(m84, before);

  // And the POs it was taken off, which nobody had open, agree with the bank.
  const drift = await all(`
    select pc.po_header_id, pc.freight_amount, coalesce(t.freight_allocated, 0) as allocated
      from public.po_costing pc
      left join public.v_po_landed_cost_totals t on t.po_header_id = pc.po_header_id
     where pc.freight_amount is distinct from coalesce(t.freight_allocated, 0)`);
  assert.deepEqual(drift, [], 'no PO is left holding a stale freight total');
});

console.log(`\n${checks} checks passed`);
await db.close();
