// scripts/tests/receiving-mcp-database.test.mjs
//
// receiving:write (20261117220000) on real PostgreSQL (PGlite): the person's
// own AI reads a purchase order's lines and records a DRAFT shipment receipt
// against them; a person confirms it in PO Report, and THAT is what creates
// the shipment.
//
// The migration runs twice (apply_all_post_merge.sql re-runs it). The
// developer-platform plumbing it builds on (grants, the scope gate, the write
// ledger) and the PO / shipment tables are a fixture with the live shapes,
// including incoming_shipments' real policies and audit trigger as production
// carries them (read live 2026-11-17).
//
// What this proves:
//   S  the scope: offered by consent, its own paths, refused without it
//   D  drafting: the grant's company (never a session's), lines checked
//      against THAT PO, qty and status validated, "Via <app>", one write
//      against the cap, the same key returns the first draft
//   E  the evidence a person is shown: ordered vs receiving, over-receipt,
//      the lines left out, the document's own text and a text/SKU mismatch
//   N  inert: a pending draft creates no shipment and changes no PO
//   C  confirming is the CONFIRMING PERSON's write, under their RLS: the
//      shipment is stamped with them, and a person who may not change that PO
//      gets the shipment and an honest "status not applied"
//   R  confirming twice changes nothing; a discarded draft stays discarded
//   G  no client role may call the connection's tools
//
// Mutations (CI runs each and requires the suite to FAIL):
//   RECEIVING_MUTATION=not-offered      consent does not offer receiving:write
//   RECEIVING_MUTATION=no-path          the record path is not on the allowlist
//   RECEIVING_MUTATION=no-scope         the tools do not require the scope
//   RECEIVING_MUTATION=session-company  the company follows the session
//   RECEIVING_MUTATION=any-po-line      a line from another PO is accepted
//   RECEIVING_MUTATION=no-cap           the daily write cap is not checked
//   RECEIVING_MUTATION=no-idem          a retry queues a second draft
//   RECEIVING_MUTATION=ignore-pause     a paused connection still writes
//   RECEIVING_MUTATION=confirm-definer  confirming runs as the definer
//   RECEIVING_MUTATION=po-status-silent a refused PO status reports as applied
//   RECEIVING_MUTATION=confirm-twice    a confirmed draft can be confirmed again
//   RECEIVING_MUTATION=any-po-status    the AI may set any PO status
//   RECEIVING_MUTATION=no-match-flag    a text/SKU mismatch is not flagged
//   RECEIVING_MUTATION=no-grants        the browser cannot answer a draft at all
//   RECEIVING_MUTATION=po-shrinks       a PO line deleted since drafting is ignored
//
// Run:  npm ci --prefix scripts/tests/finance-db --ignore-scripts
//       node scripts/tests/receiving-mcp-database.test.mjs
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUT = process.env.RECEIVING_MUTATION || '';
const db = new PGlite();
let passed = 0;
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (err) { console.error(`FAIL ${name}\n  ${err?.message || err}`); throw err; }
}
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const rows = async (sql, params) => (await db.query(sql, params)).rows;
async function refused(sql, params, fragment) {
  try { await db.query(sql, params); }
  catch (err) {
    assert.ok(String(err.message).includes(fragment),
      `refused for the wrong reason: ${err.message} (wanted ${fragment})`);
    return err;
  }
  throw new Error(`expected a refusal containing "${fragment}"`);
}

const A = '00000000-0000-0000-0000-00000000000a';   // company A
const B = '00000000-0000-0000-0000-00000000000b';   // company B
const U = {
  adminA:  '10000000-0000-0000-0000-000000000001',  // may change POs
  memberA: '10000000-0000-0000-0000-000000000002',  // may log shipments, not POs
  ownerB:  '10000000-0000-0000-0000-000000000003',
};
const G = {
  recv:    '30000000-0000-0000-0000-000000000001',  // adminA, receiving:write
  reads:   '30000000-0000-0000-0000-000000000002',  // adminA, reads only
  paused:  '30000000-0000-0000-0000-000000000003',
  otherCo: '30000000-0000-0000-0000-000000000004',  // ownerB, receiving:write
};

// ── Fixture: the live shapes this migration builds on ─────────────────────
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create role silo_integration; create role silo_revoked;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role, silo_integration;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create function gen_random_uuid() returns uuid language sql as
  $$ select md5(random()::text || clock_timestamp()::text)::uuid $$;
create table entities(id uuid primary key, title text);
create table profiles(id uuid primary key, email text, is_active boolean not null default true,
  role text, active_company_id uuid);
create table entity_memberships(entity_id uuid, user_id uuid, role text);
create function active_company_id() returns uuid language sql stable security definer as
  $$ select active_company_id from public.profiles where id = auth.uid() $$;
create function is_admin_user() returns boolean language sql stable security definer as $$
  select exists (select 1 from public.profiles p
    left join public.entity_memberships em on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid() and p.is_active
      and (case when em.role is not null then em.role in ('owner_admin','admin')
                else lower(coalesce(p.role,'')) in ('owner','admin') end)) $$;
create function silo_company_timezone(p uuid) returns text language sql stable as
  $$ select 'America/Los_Angeles' $$;
create function set_updated_at() returns trigger language plpgsql as
  $$ begin new.updated_at := now(); return new; end $$;
create function attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
create function refresh_chat_schema_catalog() returns void language sql as $$ select $$;
-- Ask SILO / describe_tables' catalog, which the migration writes meaning into.
create table silo_chat_schema_catalog(relname text primary key, description text,
  keywords text[], is_hidden boolean default false, updated_at timestamptz);
insert into silo_chat_schema_catalog(relname) values
  ('incoming_shipment_drafts'), ('incoming_shipment_draft_lines');
create function stamp_company_entity_id() returns trigger language plpgsql as $$
  begin
    if new.company_entity_id is null then new.company_entity_id := public.active_company_id(); end if;
    return new;
  end $$;

-- Purchasing, as production has it.
create table factories(id uuid primary key default gen_random_uuid(), factory_name text,
  company_entity_id uuid);
create table po_headers(id uuid primary key default gen_random_uuid(), po_name text,
  factory_id uuid references factories(id), order_date date, expected_arrival_date date,
  status text not null default 'Draft', company_entity_id uuid, created_by uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table po_lines(id uuid primary key default gen_random_uuid(),
  po_header_id uuid not null references po_headers(id) on delete cascade,
  title_snapshot text, variant_title_snapshot text, sku_snapshot text,
  qty numeric(12,2) not null default 0, company_entity_id uuid);
alter table po_headers enable row level security;
alter table po_lines enable row level security;
create policy po_headers_active_select on po_headers for select to authenticated
  using (company_entity_id = (select active_company_id()) and ((select is_admin_user()) or created_by = (select auth.uid())));
create policy po_headers_active_update on po_headers for update to authenticated
  using (company_entity_id = (select active_company_id()) and ((select is_admin_user()) or created_by = (select auth.uid())))
  with check (company_entity_id = (select active_company_id()) and ((select is_admin_user()) or created_by = (select auth.uid())));
create policy po_lines_active_select on po_lines for select to authenticated
  using (company_entity_id = (select active_company_id()));

create table incoming_shipments(
  id uuid primary key default gen_random_uuid(),
  po_header_id uuid not null references po_headers(id) on delete cascade,
  shipment_status text not null default 'Not Shipped'
    constraint incoming_shipments_status_chk
    check (shipment_status in ('Not Shipped','Booked','Shipped','In Transit','Delayed','Delivered','Received')),
  ship_date date, eta date, received_date date,
  tracking_number text, carrier text, container_ref text, warehouse_location text,
  received_by text, notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  company_entity_id uuid references entities(id), created_by uuid, updated_by uuid, booking_id uuid);
create table incoming_shipment_lines(
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references incoming_shipments(id) on delete cascade,
  po_line_id uuid not null references po_lines(id) on delete cascade,
  qty numeric(12,2), notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  company_entity_id uuid references entities(id), created_by uuid, updated_by uuid,
  constraint incoming_shipment_lines_unique unique (shipment_id, po_line_id));
alter table incoming_shipments enable row level security;
alter table incoming_shipment_lines enable row level security;
create policy incoming_shipments_active_select on incoming_shipments for select
  using (company_entity_id = (select active_company_id()));
create policy incoming_shipments_active_insert on incoming_shipments for insert
  with check (company_entity_id = (select active_company_id()));
create policy incoming_shipment_lines_active_select on incoming_shipment_lines for select
  using (company_entity_id = (select active_company_id()));
create policy incoming_shipment_lines_active_insert on incoming_shipment_lines for insert
  with check (company_entity_id = (select active_company_id()));
create trigger stamp_company_entity_id before insert on incoming_shipments
  for each row execute function stamp_company_entity_id();
create trigger stamp_company_entity_id before insert on incoming_shipment_lines
  for each row execute function stamp_company_entity_id();
-- 20260923160000: the audit trigger that makes a confirmation the person's.
create function stamp_shipment_audit() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.created_by := auth.uid(); new.updated_by := auth.uid(); end if;
  else
    new.created_by := old.created_by; new.updated_by := auth.uid();
  end if;
  return new;
end $$;
create trigger trg_incoming_shipments_audit before insert or update on incoming_shipments
  for each row execute function stamp_shipment_audit();
create trigger trg_incoming_shipment_lines_audit before insert or update on incoming_shipment_lines
  for each row execute function stamp_shipment_audit();

-- The developer platform as production has it (20261020030000 onward).
create function silo_api_is_integration() returns boolean language sql stable as
  $$ select current_setting('test.integration', true) = 'on' $$;
create function silo_api_claims() returns jsonb language sql stable as
  $$ select coalesce(nullif(current_setting('test.claims', true), '')::jsonb, '{}'::jsonb) $$;
create table silo_api_grants(
  id uuid primary key default gen_random_uuid(),
  client_id text, app_key text, slot integer, user_id uuid, company_entity_id uuid,
  auth_session_id uuid, generation integer default 1,
  scopes text[] not null default '{}', consented_aal text, consented_at timestamptz,
  expires_at timestamptz, revoked_at timestamptz, last_used_at timestamptz,
  updated_at timestamptz, writes_paused_at timestamptz);
create function silo_api_grant() returns setof silo_api_grants language sql stable as $$
  select g.* from public.silo_api_grants g
   where g.id = nullif(current_setting('test.grant_id', true), '')::uuid and g.revoked_at is null $$;
create function silo_api_require_scope(p_scope text) returns void
language plpgsql volatile security definer set search_path = '' as $fn$
begin
  if not public.silo_api_is_integration() then return; end if;
  if not exists (select 1 from public.silo_api_grant()) then raise exception 'integration_revoked'; end if;
  if not exists (select 1 from public.silo_api_grant() g where p_scope = any(g.scopes)) then
    raise exception 'insufficient_scope';
  end if;
end $fn$;
create function silo_api_app_key(p text) returns text language sql stable as $$ select 'app:' || coalesce(p,'') $$;
create function silo_api_app_name(p_client_id text, p_app_key text) returns text language sql stable as
  $$ select 'Claude' $$;
create function silo_api_app_connection_limit() returns integer language sql immutable as $$ select 3 $$;
create function silo_api_write_cap() returns integer language sql stable as
  $$ select coalesce(nullif(current_setting('test.cap', true), '')::integer, 50) $$;
create table silo_api_writes (
  id uuid primary key default gen_random_uuid(), company_entity_id uuid not null,
  grant_id uuid references silo_api_grants(id) on delete set null, user_id uuid,
  via text not null, kind text not null, target_id uuid, idempotency_key text,
  created_at timestamptz not null default now(),
  constraint silo_api_writes_kind_check check (kind in ('task')));

grant all on all tables in schema public to anon, authenticated, service_role;
-- Deliberately NOT a default privilege for future tables: the tables this
-- migration creates must carry their own grants, as production's do, or a
-- policy nobody can exercise would pass this suite.
alter default privileges in schema public grant all on tables to service_role;
grant execute on function auth.uid() to anon, authenticated, service_role, silo_integration;
grant execute on function active_company_id() to anon, authenticated, service_role, silo_integration;
grant execute on function is_admin_user() to authenticated, service_role;
`);

let sql = await readFile(new URL('../../supabase/migrations/20261117220000_receiving_write_scope.sql', import.meta.url), 'utf8');
const mut = (from, to) => {
  assert.ok(sql.includes(from), `mutation ${MUT}: pattern not found`);
  sql = sql.split(from).join(to);
};
switch (MUT) {
  case '': break;
  case 'not-offered':
    mut("'codes:create', 'receiving:write']", "'codes:create']"); break;
  case 'no-path':
    mut("    '/rpc/silo_api_record_shipment_receipt')", "    '/rpc/silo_api_never')"); break;
  case 'no-scope':
    mut("  perform public.silo_api_require_scope('receiving:write');", "  perform 1;"); break;
  case 'session-company':
    mut('  v_company := v_grant.company_entity_id;\n  v_user    := v_grant.user_id;',
        '  v_company := coalesce(public.active_company_id(), v_grant.company_entity_id);\n  v_user    := v_grant.user_id;'); break;
  case 'any-po-line':
    mut('     and l.po_header_id = v_po.id\n     and l.company_entity_id = v_company;', '     ;'); break;
  case 'no-cap':
    mut('  if v_used >= public.silo_api_write_cap() then', '  if false then'); break;
  case 'no-idem':
    mut('  if v_existing is not null then\n    return public.silo_receiving_draft_json(v_existing, true);\n  end if;', ''); break;
  case 'ignore-pause':
    mut('  if v_grant.writes_paused_at is not null then', '  if false then'); break;
  case 'confirm-definer':
    mut('returns json\nlanguage plpgsql\nvolatile\nsecurity invoker\nset search_path = \'\'\nas $$\ndeclare\n  v_d        public.incoming_shipment_drafts;',
        'returns json\nlanguage plpgsql\nvolatile\nsecurity definer\nset search_path = \'\'\nas $$\ndeclare\n  v_d        public.incoming_shipment_drafts;'); break;
  case 'po-status-silent':
    mut('    get diagnostics v_rows = row_count;\n    v_postat := v_rows > 0;', '    v_postat := true;'); break;
  case 'confirm-twice':
    mut("  if v_d.state <> 'pending' then\n    return json_build_object('draft_id', v_d.id, 'state', v_d.state, 'changed', false,\n      'shipment_id', v_d.applied_shipment_id,", "  if false then\n    return json_build_object('draft_id', v_d.id, 'state', v_d.state, 'changed', false,\n      'shipment_id', v_d.applied_shipment_id,"); break;
  case 'any-po-status':
    mut("  if v_postat is not null and v_postat not in ('Partially Received', 'Received') then", '  if false then'); break;
  case 'no-grants':
    mut('grant select, update, delete on public.incoming_shipment_drafts to authenticated;',
        'grant select on public.incoming_shipment_drafts to authenticated;'); break;
  case 'po-shrinks':
    mut("  if v_lines = 0 or (v_d.line_count is not null and v_lines <> v_d.line_count) then", '  if false then'); break;
  case 'no-match-flag':
    mut("               else 'check'\n             end as match", "               else 'sku_exact'\n             end as match"); break;
  default: throw new Error(`unknown mutation ${MUT}`);
}

// apply_all_post_merge.sql re-runs every migration: it must be idempotent.
for (let i = 0; i < 2; i += 1) await db.exec(sql);

// ── Data ──────────────────────────────────────────────────────────────────
await db.exec(`
insert into entities(id, title) values ('${A}', 'Company A'), ('${B}', 'Company B');
insert into auth.users(id) values ('${U.adminA}'), ('${U.memberA}'), ('${U.ownerB}');
insert into profiles(id, email, role, active_company_id) values
  ('${U.adminA}',  'admin@a.test',  'admin', '${A}'),
  ('${U.memberA}', 'member@a.test', 'user',  '${A}'),
  ('${U.ownerB}',  'owner@b.test',  'owner', '${B}');
insert into entity_memberships(entity_id, user_id, role) values
  ('${A}', '${U.adminA}', 'admin'), ('${A}', '${U.memberA}', 'member'), ('${B}', '${U.ownerB}', 'owner_admin');
insert into silo_api_grants(id, client_id, app_key, slot, user_id, company_entity_id, scopes, consented_at, expires_at) values
  ('${G.recv}',   'c1', 'app:c1', 0, '${U.adminA}', '${A}', array['reports:read','data:read','receiving:write'], now(), now() + interval '90 days'),
  ('${G.reads}',  'c2', 'app:c2', 0, '${U.adminA}', '${A}', array['reports:read','data:read'], now(), now() + interval '90 days'),
  ('${G.paused}', 'c3', 'app:c3', 0, '${U.adminA}', '${A}', array['receiving:write'], now(), now() + interval '90 days'),
  ('${G.otherCo}','c4', 'app:c4', 0, '${U.ownerB}', '${B}', array['receiving:write'], now(), now() + interval '90 days');
update silo_api_grants set writes_paused_at = now() where id = '${G.paused}';

insert into factories(id, factory_name, company_entity_id) values
  ('40000000-0000-0000-0000-000000000001', 'Factory One', '${A}');
insert into po_headers(id, po_name, factory_id, order_date, status, company_entity_id, created_by) values
  ('50000000-0000-0000-0000-000000000001', 'PO-1', '40000000-0000-0000-0000-000000000001', date '2026-10-01', 'Sent to Factory', '${A}', '${U.adminA}'),
  ('50000000-0000-0000-0000-000000000002', 'PO-2', '40000000-0000-0000-0000-000000000001', date '2026-10-02', 'Draft', '${A}', '${U.adminA}'),
  ('50000000-0000-0000-0000-000000000009', 'PO-B', null, date '2026-10-03', 'Sent to Factory', '${B}', '${U.ownerB}');
insert into po_lines(id, po_header_id, title_snapshot, variant_title_snapshot, sku_snapshot, qty, company_entity_id) values
  ('60000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'Bad Day Hoodie', 'Youth S', 'BB-YS-BadDayHoodie-Youth', 160, '${A}'),
  ('60000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000001', 'Bad Day Hoodie', 'Youth M', 'BB-YM-BadDayHoodie-Youth', 360, '${A}'),
  ('60000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-000000000001', 'Bad Day Hoodie', 'Youth L', 'BB-YL-BadDayHoodie-Youth', 290, '${A}'),
  ('60000000-0000-0000-0000-000000000004', '50000000-0000-0000-0000-000000000002', 'Other Hoodie', 'Youth S', 'XX-YS-Other', 50, '${A}'),
  ('60000000-0000-0000-0000-000000000009', '50000000-0000-0000-0000-000000000009', 'B Tee', 'M', 'B-M-Tee', 10, '${B}');
`);

const PO = '50000000-0000-0000-0000-000000000001';
const L1 = '60000000-0000-0000-0000-000000000001';
const L2 = '60000000-0000-0000-0000-000000000002';
const L3 = '60000000-0000-0000-0000-000000000003';
const OTHER_PO_LINE = '60000000-0000-0000-0000-000000000004';

const asConnection = async (grantId) => db.exec(`
  reset role;
  select set_config('test.integration', 'on', false);
  select set_config('test.grant_id', '${grantId}', false);
  select set_config('test.uid', '', false);
  set role silo_integration;`);
const asPerson = async (uid) => db.exec(`
  reset role;
  select set_config('test.integration', 'off', false);
  select set_config('test.grant_id', '', false);
  select set_config('test.uid', '${uid}', false);
  set role authenticated;`);
const asService = async () => db.exec(`
  reset role;
  select set_config('test.integration', 'off', false);
  select set_config('test.grant_id', '', false);
  select set_config('test.uid', '', false);`);

// ── S: the scope ──────────────────────────────────────────────────────────
await check('consent offers receiving:write, and the three tool paths are allowed', async () => {
  await asService();
  const src = await one(`select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'silo_api_consent'`);
  assert.ok(src.prosrc.includes("'receiving:write'"), 'the consent allowlist offers the scope');
  const paths = await one(`select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'silo_api_path_allowed'`);
  for (const fn of ['silo_api_pos_awaiting_receipt', 'silo_api_po_lines_for_receiving', 'silo_api_record_shipment_receipt']) {
    assert.ok(paths.prosrc.includes('/rpc/' + fn), `${fn} is on the path allowlist`);
  }
  // Everything the codes:create scope already had is still offered.
  for (const s of ['reports:read', 'data:read', 'work:write', 'outreach:send', 'codes:create']) {
    assert.ok(src.prosrc.includes(`'${s}'`), `${s} is still offered`);
  }
});

await check('the two new tables carry their meaning in the catalog a bot reads', async () => {
  await asService();
  const r = await rows(`select relname, description from silo_chat_schema_catalog
    where relname in ('incoming_shipment_drafts', 'incoming_shipment_draft_lines') order by relname`);
  assert.equal(r.length, 2);
  for (const row of r) {
    assert.ok(/nothing/i.test(row.description),
      `${row.relname}: a bot must be told a drafted row is not a received unit`);
  }
});

await check('a connection without the scope is refused', async () => {
  await asConnection(G.reads);
  await refused(`select public.silo_api_po_lines_for_receiving($1)`, [PO], 'insufficient_scope');
  await refused(`select public.silo_api_record_shipment_receipt($1, $2::jsonb, 'k1')`,
    [PO, JSON.stringify([{ po_line_id: L1, qty: 10 }])], 'insufficient_scope');
});

await check('a paused connection may not write', async () => {
  await asConnection(G.paused);
  await refused(`select public.silo_api_record_shipment_receipt($1, $2::jsonb, 'k-paused')`,
    [PO, JSON.stringify([{ po_line_id: L1, qty: 10 }])], 'writes_paused');
});

await check('no client role may call the tools or the internal helpers', async () => {
  for (const [role, fn, args] of [
    ['authenticated', 'silo_api_record_shipment_receipt', `'${PO}', '[]'::jsonb, 'k'`],
    ['anon', 'silo_api_record_shipment_receipt', `'${PO}', '[]'::jsonb, 'k'`],
    ['authenticated', 'silo_api_po_lines_for_receiving', `'${PO}'`],
    ['authenticated', 'silo_api_pos_awaiting_receipt', `null, 5`],
    ['authenticated', 'silo_api_receiving_grant', ''],
    ['authenticated', 'silo_receiving_draft_json', `'${PO}'`],
  ]) {
    const r = await one(`select bool_or(has_function_privilege($1, p.oid, 'execute')) ok
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname = $2`, [role, fn]);
    assert.equal(r.ok, false, `${role} must not execute ${fn} (${args ? 'args' : 'no args'})`);
  }
});

await check('the drafts carry their own table grants: the browser may answer one, nobody else may read it', async () => {
  await asService();
  for (const [role, priv, want] of [
    ['authenticated', 'select', true], ['authenticated', 'update', true], ['authenticated', 'delete', true],
    ['authenticated', 'insert', false],
    ['anon', 'select', false], ['silo_integration', 'select', false], ['silo_revoked', 'select', false],
  ]) {
    const r = await one(`select has_table_privilege($1, 'public.incoming_shipment_drafts', $2) ok`, [role, priv]);
    assert.equal(r.ok, want, `${role} ${priv} on the drafts table`);
  }
  const l = await one(`select has_table_privilege('authenticated', 'public.incoming_shipment_draft_lines', 'select') ok,
    has_table_privilege('anon', 'public.incoming_shipment_draft_lines', 'select') anon_ok`);
  assert.equal(l.ok, true);
  assert.equal(l.anon_ok, false);
});

// ── D: drafting ───────────────────────────────────────────────────────────
await check('the PO lines come back with ids, ordered quantities and nothing received yet', async () => {
  await asConnection(G.recv);
  const r = await one(`select public.silo_api_po_lines_for_receiving($1) j`, [PO]);
  const j = r.j;
  assert.equal(j.purchase_order.po_name, 'PO-1');
  assert.equal(j.lines.length, 3);
  const l1 = j.lines.find((x) => x.po_line_id === L1);
  assert.equal(Number(l1.ordered), 160);
  assert.equal(Number(l1.received_so_far), 0);
  assert.equal(j.shipments_already_logged.length, 0);
  assert.ok(String(j.how_to_record).includes('DRAFT'), 'the instruction says a person confirms it');
});

await check('another company\'s PO is invisible to this connection', async () => {
  await asConnection(G.recv);
  await refused(`select public.silo_api_po_lines_for_receiving($1)`,
    ['50000000-0000-0000-0000-000000000009'], 'unknown_po');
  await refused(`select public.silo_api_record_shipment_receipt($1, $2::jsonb, 'k-crosso')`,
    ['50000000-0000-0000-0000-000000000009', JSON.stringify([{ po_line_id: '60000000-0000-0000-0000-000000000009', qty: 1 }])],
    'unknown_po');
});

await check('a line from another PO is refused, and nothing is left behind', async () => {
  await asConnection(G.recv);
  await refused(`select public.silo_api_record_shipment_receipt($1, $2::jsonb, 'k-badline')`,
    [PO, JSON.stringify([{ po_line_id: L1, qty: 10 }, { po_line_id: OTHER_PO_LINE, qty: 5 }])],
    'unknown_po_line');
  await asService();
  const n = await one(`select count(*)::int n from incoming_shipment_drafts`);
  assert.equal(n.n, 0, 'the refused call rolled its draft back');
});

await check('a repeated line, a zero quantity, a bad status and a bad PO status are each refused', async () => {
  await asConnection(G.recv);
  await refused(`select public.silo_api_record_shipment_receipt($1, $2::jsonb, 'k-dup')`,
    [PO, JSON.stringify([{ po_line_id: L1, qty: 10 }, { po_line_id: L1, qty: 5 }])], 'repeated_po_line');
  await refused(`select public.silo_api_record_shipment_receipt($1, $2::jsonb, 'k-zero')`,
    [PO, JSON.stringify([{ po_line_id: L1, qty: 0 }])], 'invalid_qty');
  await refused(`select public.silo_api_record_shipment_receipt($1, $2::jsonb, 'k-status', 'Arrived')`,
    [PO, JSON.stringify([{ po_line_id: L1, qty: 10 }])], 'invalid_shipment_status');
  await refused(`select public.silo_api_record_shipment_receipt(
      p_po_header_id => $1, p_lines => $2::jsonb, p_idempotency_key => 'k-postat',
      p_set_po_status => 'Cancelled')`,
    [PO, JSON.stringify([{ po_line_id: L1, qty: 10 }])], 'invalid_po_status');
  await refused(`select public.silo_api_record_shipment_receipt(
      p_po_header_id => $1, p_lines => $2::jsonb, p_idempotency_key => 'k-basis', p_qty_basis => 'guessed')`,
    [PO, JSON.stringify([{ po_line_id: L1, qty: 10 }])], 'invalid_qty_basis');
  await refused(`select public.silo_api_record_shipment_receipt($1, '[]'::jsonb, 'k-empty')`,
    [PO], 'lines_required');
  await refused(`select public.silo_api_record_shipment_receipt($1, $2::jsonb, '  ')`,
    [PO, JSON.stringify([{ po_line_id: L1, qty: 10 }])], 'idempotency_key_required');
});

let draft;
await check('a receipt is drafted: the grant\'s company, "Via <app>", one write, the person\'s link', async () => {
  await asConnection(G.recv);
  const r = await one(`select public.silo_api_record_shipment_receipt(
      p_po_header_id => $1,
      p_lines => $2::jsonb,
      p_idempotency_key => 'kcmtar-38',
      p_shipment_status => 'Delivered',
      p_qty_basis => 'expected',
      p_ship_date => date '2026-10-23',
      p_received_date => date '2026-11-16',
      p_container_ref => 'KCMTAR-38/39/42',
      p_warehouse_location => 'WH3',
      p_received_by => 'Bennet',
      p_notes => 'Combined shipment, counts from the packing list.',
      p_set_po_status => 'Received',
      p_source_label => 'Slack #receiving 11/17',
      p_source_url => 'https://example.slack.com/archives/C1/p1700000000') j`,
    [PO, JSON.stringify([
      { po_line_id: L1, qty: 180, source_text: 'BB-YS-BadDayHoodie-Youth' },
      { po_line_id: L2, qty: 366, source_text: 'bad day hoodie youth m' },
    ])]);
  const j = r.j;
  draft = j.draft_id;
  assert.equal(j.state, 'pending');
  assert.equal(j.replayed, false);
  assert.equal(j.via, 'Claude');
  assert.equal(j.qty_basis, 'expected');
  assert.equal(j.suggested_po_status, 'Received');
  assert.equal(j.source_label, 'Slack #receiving 11/17');
  assert.equal(j.confirm_in_silo, '/v2/po-report.html?receipt=' + draft);
  assert.ok(String(j.what_happens_next).includes('Nothing has changed in SILO'));

  await asService();
  const d = await one(`select company_entity_id, requested_by, via_app, state, grant_id from incoming_shipment_drafts where id = $1`, [draft]);
  assert.equal(d.company_entity_id, A, 'the company comes from the grant');
  assert.equal(d.requested_by, U.adminA);
  assert.equal(d.grant_id, G.recv);
  const w = await rows(`select kind, via, target_id from silo_api_writes where grant_id = $1`, [G.recv]);
  assert.equal(w.length, 1, 'exactly one write was spent');
  assert.equal(w[0].kind, 'shipment_receipt');
  assert.equal(w[0].via, 'app');
  assert.equal(w[0].target_id, draft);
});

await check('the same key returns the first draft and spends nothing more', async () => {
  await asConnection(G.recv);
  const r = await one(`select public.silo_api_record_shipment_receipt($1, $2::jsonb, 'kcmtar-38') j`,
    [PO, JSON.stringify([{ po_line_id: L3, qty: 1 }])]);
  assert.equal(r.j.draft_id, draft, 'the same key is the same draft');
  assert.equal(r.j.replayed, true);
  assert.equal(r.j.lines.length, 2, 'the retry did not add a line');
  await asService();
  const w = await one(`select count(*)::int n from silo_api_writes where grant_id = $1`, [G.recv]);
  assert.equal(w.n, 1);
});

await check('the connection\'s daily write cap holds', async () => {
  await asService();
  await db.query(`select set_config('test.cap', '1', false)`);
  await asConnection(G.recv);
  await refused(`select public.silo_api_record_shipment_receipt($1, $2::jsonb, 'k-capped')`,
    [PO, JSON.stringify([{ po_line_id: L3, qty: 5 }])], 'write_cap_reached');
  await asService();
  await db.query(`select set_config('test.cap', '50', false)`);
});

// ── E: what the person is shown ───────────────────────────────────────────
await check('the draft shows ordered vs receiving, the over-receipt, the lines left out and the text matched', async () => {
  await asService();
  const r = await one(`select public.silo_receiving_draft_json($1, false) j`, [draft]);
  const j = r.j;
  assert.equal(Number(j.totals.units_receiving), 546);
  assert.equal(Number(j.totals.units_ordered_on_those_lines), 520);
  assert.equal(Number(j.totals.variance_units), 26);
  assert.equal(j.over_receipt_lines.length, 2, 'both lines receive more than they ordered');
  assert.deepEqual(j.po_lines_not_in_this_receipt, ['BB-YL-BadDayHoodie-Youth']);
  const exact = j.lines.find((x) => x.sku === 'BB-YS-BadDayHoodie-Youth');
  assert.equal(exact.match, 'sku_exact');
  const byTitle = j.lines.find((x) => x.sku === 'BB-YM-BadDayHoodie-Youth');
  assert.equal(byTitle.match, 'title_part', 'the document named the title, not the SKU');
  assert.equal(byTitle.source_text, 'bad day hoodie youth m');
  assert.equal(j.lines_to_check.length, 0);
});

await check('a line whose document text resembles neither the SKU nor the title is flagged for a person', async () => {
  await asConnection(G.recv);
  const r = await one(`select public.silo_api_record_shipment_receipt(
      p_po_header_id => $1, p_lines => $2::jsonb, p_idempotency_key => 'k-fuzzy') j`,
    [PO, JSON.stringify([{ po_line_id: L3, qty: 5, source_text: 'blue crewneck 2XL' }])]);
  assert.equal(r.j.lines[0].match, 'check');
  assert.equal(r.j.lines_to_check.length, 1);
  assert.ok(String(r.j.tell_the_person).includes('not sure'), 'the model is told to say so');
  await asPerson(U.adminA);
  await db.query(`select public.silo_receiving_reject_draft($1, 'wrong item')`, [r.j.draft_id]);
});

// ── N: a pending draft is inert ───────────────────────────────────────────
await check('a pending draft creates no shipment and changes no PO', async () => {
  await asService();
  const s = await one(`select count(*)::int n from incoming_shipments`);
  assert.equal(s.n, 0);
  const l = await one(`select count(*)::int n from incoming_shipment_lines`);
  assert.equal(l.n, 0);
  const h = await one(`select status from po_headers where id = $1`, [PO]);
  assert.equal(h.status, 'Sent to Factory');
});

await check('a connection cannot confirm its own draft, and cannot see the drafts table', async () => {
  const r = await one(`select bool_or(has_function_privilege('silo_integration', p.oid, 'execute')) ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname = 'silo_receiving_confirm_draft'`);
  assert.equal(r.ok, false);
  const t = await one(`select has_table_privilege('silo_integration', 'public.incoming_shipment_drafts', 'select') ok`);
  assert.equal(t.ok, false, 'the integration role has no table grants at all');
});

// ── C: confirming is the confirming person's write ────────────────────────
await check('a member of the company sees the waiting draft; another company does not', async () => {
  await asPerson(U.memberA);
  const r = await one(`select public.silo_receiving_pending_drafts() j`);
  assert.equal(r.j.length, 1);
  assert.equal(r.j[0].draft_id, draft);
  await asPerson(U.ownerB);
  const b = await one(`select public.silo_receiving_pending_drafts() j`);
  assert.equal(b.j.length, 0, 'the drafts are scoped by their own RLS');
});

await check('a member who may not change the PO still records the shipment, and is told the status was not applied', async () => {
  await asPerson(U.memberA);
  const r = await one(`select public.silo_receiving_confirm_draft($1) j`, [draft]);
  const j = r.j;
  assert.equal(j.changed, true);
  assert.equal(j.state, 'applied');
  assert.equal(j.po_status_requested, 'Received');
  assert.equal(j.po_status_applied, false, 'the PO\'s own policy refused it, and the answer says so');
  assert.ok(String(j.message).includes('not changed'));

  await asService();
  const h = await one(`select status from po_headers where id = $1`, [PO]);
  assert.equal(h.status, 'Sent to Factory', 'the PO is untouched');
  const s = await one(`select * from incoming_shipments where id = $1`, [j.shipment_id]);
  assert.equal(s.created_by, U.memberA, 'the shipment is the confirming person\'s, not the robot\'s');
  assert.equal(s.company_entity_id, A);
  assert.equal(s.shipment_status, 'Delivered');
  assert.equal(s.container_ref, 'KCMTAR-38/39/42');
  assert.ok(String(s.notes).includes('expected counts'), 'an expected count says so on the shipment');
  const lines = await rows(`select po_line_id, qty, created_by from incoming_shipment_lines where shipment_id = $1 order by qty`, [j.shipment_id]);
  assert.equal(lines.length, 2);
  assert.equal(Number(lines[0].qty), 180);
  assert.equal(lines[0].created_by, U.memberA);
});

await check('confirming again changes nothing', async () => {
  await asPerson(U.memberA);
  const r = await one(`select public.silo_receiving_confirm_draft($1) j`, [draft]);
  assert.equal(r.j.changed, false);
  assert.equal(r.j.state, 'applied');
  await asService();
  const n = await one(`select count(*)::int n from incoming_shipments`);
  assert.equal(n.n, 1, 'no second shipment');
});

await check('a discarded draft stays discarded and records who discarded it', async () => {
  await asConnection(G.recv);
  const d = await one(`select public.silo_api_record_shipment_receipt(
      p_po_header_id => $1, p_lines => $2::jsonb, p_idempotency_key => 'k-discard') j`,
    [PO, JSON.stringify([{ po_line_id: L3, qty: 290 }])]);
  await asPerson(U.adminA);
  const r = await one(`select public.silo_receiving_reject_draft($1, 'duplicate of the first delivery') j`, [d.j.draft_id]);
  assert.equal(r.j.state, 'rejected');
  const again = await one(`select public.silo_receiving_confirm_draft($1) j`, [d.j.draft_id]);
  assert.equal(again.j.changed, false);
  assert.equal(again.j.state, 'rejected');
  await asService();
  const row = await one(`select rejected_by, reject_reason from incoming_shipment_drafts where id = $1`, [d.j.draft_id]);
  assert.equal(row.rejected_by, U.adminA);
  assert.equal(row.reject_reason, 'duplicate of the first delivery');
  const n = await one(`select count(*)::int n from incoming_shipments`);
  assert.equal(n.n, 1);
});

await check('a PO line removed after the draft was written stops the confirmation', async () => {
  await asConnection(G.recv);
  const d = await one(`select public.silo_api_record_shipment_receipt(
      p_po_header_id => $1, p_lines => $2::jsonb, p_idempotency_key => 'k-shrink') j`,
    [PO, JSON.stringify([{ po_line_id: L1, qty: 1 }, { po_line_id: L2, qty: 2 }])]);
  assert.equal(Number(d.j.totals.lines_when_drafted), 2);
  await asService();
  await db.query(`delete from po_lines where id = $1`, [L2]);
  await asPerson(U.adminA);
  await refused(`select public.silo_receiving_confirm_draft($1)`, [d.j.draft_id], 'po_changed');
  await asService();
  const n = await one(`select count(*)::int n from incoming_shipments`);
  assert.equal(n.n, 1, 'and records nothing');
  // Put the line back for the checks that follow.
  await db.query(`insert into po_lines(id, po_header_id, title_snapshot, variant_title_snapshot, sku_snapshot, qty, company_entity_id)
    values ($1, $2, 'Bad Day Hoodie', 'Youth M', 'BB-YM-BadDayHoodie-Youth', 360, $3)`, [L2, PO, A]);
  await asPerson(U.adminA);
  await db.query(`select public.silo_receiving_reject_draft($1, 'PO changed')`, [d.j.draft_id]);
});

await check('an admin\'s confirmation does apply the suggested PO status', async () => {
  await asConnection(G.recv);
  const d = await one(`select public.silo_api_record_shipment_receipt(
      p_po_header_id => $1, p_lines => $2::jsonb, p_idempotency_key => 'k-admin',
      p_qty_basis => 'counted', p_set_po_status => 'Partially Received') j`,
    [PO, JSON.stringify([{ po_line_id: L3, qty: 290 }])]);
  await asPerson(U.adminA);
  const r = await one(`select public.silo_receiving_confirm_draft($1) j`, [d.j.draft_id]);
  assert.equal(r.j.po_status_applied, true);
  await asService();
  const h = await one(`select status from po_headers where id = $1`, [PO]);
  assert.equal(h.status, 'Partially Received');
  const s = await one(`select notes from incoming_shipments where id = $1`, [r.j.shipment_id]);
  assert.equal(s.notes, null, 'a counted receipt adds no caveat of its own');
});

await check('once a shipment exists, the lines tool says how much it already covers', async () => {
  await asConnection(G.recv);
  const r = await one(`select public.silo_api_po_lines_for_receiving($1) j`, [PO]);
  const l1 = r.j.lines.find((x) => x.po_line_id === L1);
  assert.equal(Number(l1.received_so_far), 180);
  assert.equal(r.j.shipments_already_logged.length, 2);
  assert.equal(r.j.drafts_waiting_for_a_person.length, 0);
});

await check('the open POs are listed, and a draft, a closed PO and another company are reflected correctly', async () => {
  await asConnection(G.recv);
  const r = await one(`select public.silo_api_pos_awaiting_receipt(null, 25) j`);
  const names = r.j.purchase_orders.map((p) => p.po_name);
  assert.ok(names.includes('PO-1'), 'an open PO is listed');
  assert.ok(!names.includes('PO-2'), 'a Draft PO is not');
  assert.ok(!names.includes('PO-B'), 'another company\'s PO is not');
  const po1 = r.j.purchase_orders.find((p) => p.po_name === 'PO-1');
  assert.equal(Number(po1.lines), 3);
  assert.equal(Number(po1.shipments_logged), 2);
  assert.equal(Number(po1.drafts_waiting), 0);
  const search = await one(`select public.silo_api_pos_awaiting_receipt('Factory One', 25) j`);
  assert.equal(search.j.purchase_orders.length, 1, 'search matches the factory name too');
});

console.log(`\n${passed} checks passed${MUT ? ` (mutation ${MUT} did NOT fail the suite — that is a bug)` : ''}`);
if (MUT) { console.error('\nFAILED: the mutation should have broken a check'); process.exit(1); }
