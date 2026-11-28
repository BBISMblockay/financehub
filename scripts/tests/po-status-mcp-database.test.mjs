// scripts/tests/po-status-mcp-database.test.mjs
//
// po_status:write (20261125234500) on real PostgreSQL (PGlite): the person's
// own AI moves a purchase order to one of the steps their company allows, and
// SILO applies it THERE AND THEN -- Blake, 2026-11-25: "if they approve in
// their llm to mark as something, it shouldn't require them to then go into
// silo to approve second time." So everything that would have been a second
// confirmation is a fence in the database, and this is the suite for it.
//
// The migration runs twice (apply_all_post_merge.sql re-runs it). The
// developer-platform plumbing it builds on (grants, the scope gate, the write
// ledger) and the purchasing tables are a fixture with the live shapes,
// including po_headers' real UPDATE policy and po_status_history's real
// trigger stack as production carries them (read live 2026-11-25).
//
// What this proves:
//   S  the scope: offered by consent, its own paths, refused without it,
//      refused when writing is paused, and callable by no browser role
//   D  the steps are COMPANY DATA: seeded per company, every status already in
//      use has a row, and only an ai_settable row may be set
//   A  arrival still needs a person: a needs_receipt step is refused with a
//      pointer to record_shipment_receipt
//   P  authority is the APPROVING PERSON's, against the GRANT's company: an
//      admin may move any PO, a member only one they created, and a PO in
//      another company does not exist to this connection
//   W  the write: applied immediately, counted once against the cap, the same
//      key replays instead of moving the PO twice, already-there spends nothing
//   H  the evidence: po_status_changes carries the reason and the app, and the
//      PO's own history row is stamped with the approving person and "Via <app>"
//      rather than the trigger's defaults (the PO's creator, the session's
//      company)
//   R  what the person reads afterwards is their own company's only
//
// Mutations (CI runs each and requires the suite to FAIL):
//   PO_STATUS_MUTATION=not-offered       consent does not offer po_status:write
//   PO_STATUS_MUTATION=no-path           the set path is not on the allowlist
//   PO_STATUS_MUTATION=no-scope          the tools do not require the scope
//   PO_STATUS_MUTATION=ignore-pause      a paused connection still writes
//   PO_STATUS_MUTATION=session-company   the company follows the session
//   PO_STATUS_MUTATION=any-step          any step may be set, not just ai_settable
//   PO_STATUS_MUTATION=receipt-step      a step meaning units arrived is settable
//   PO_STATUS_MUTATION=unknown-step      a step this company does not have is set
//   PO_STATUS_MUTATION=no-authority      the approving person's authority is not checked
//   PO_STATUS_MUTATION=no-cap            the daily write cap is not checked
//   PO_STATUS_MUTATION=no-idem           a retry moves the PO a second time
//   PO_STATUS_MUTATION=no-history-stamp  the history row keeps the trigger's defaults
//   PO_STATUS_MUTATION=trigger-keeps-creator  a person's own change is still logged as the PO's creator
//   PO_STATUS_MUTATION=no-odd-seed       a status already in use gets no step row
//   PO_STATUS_MUTATION=no-lazy-seed      a workspace with no steps yet gets none
//   PO_STATUS_MUTATION=no-revoke        anon keeps Supabase's default grants on the tables
//   PO_STATUS_MUTATION=person-reads-all  the person's card reads other companies
//
// Run:  npm ci --prefix scripts/tests/finance-db --ignore-scripts
//       node scripts/tests/po-status-mcp-database.test.mjs
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUT = process.env.PO_STATUS_MUTATION || '';
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
  adminA:  '10000000-0000-0000-0000-000000000001',  // may change any PO in A
  memberA: '10000000-0000-0000-0000-000000000002',  // may change only POs they created
  ownerB:  '10000000-0000-0000-0000-000000000003',
};
const G = {
  step:    '30000000-0000-0000-0000-000000000001',  // adminA, po_status:write
  reads:   '30000000-0000-0000-0000-000000000002',  // adminA, reads only
  paused:  '30000000-0000-0000-0000-000000000003',
  member:  '30000000-0000-0000-0000-000000000004',  // memberA, po_status:write
  otherCo: '30000000-0000-0000-0000-000000000005',  // ownerB, po_status:write
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
create table silo_chat_schema_catalog(relname text primary key, description text,
  keywords text[], is_hidden boolean default false, updated_at timestamptz);
insert into silo_chat_schema_catalog(relname) values
  ('po_status_options'), ('po_status_changes');

-- Purchasing, as production has it.
create table factories(id uuid primary key default gen_random_uuid(), factory_name text,
  company_entity_id uuid);
create table po_headers(id uuid primary key default gen_random_uuid(), po_name text,
  factory_id uuid references factories(id), order_date date, expected_arrival_date date,
  status text not null default 'Draft', company_entity_id uuid, created_by uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table po_lines(id uuid primary key default gen_random_uuid(),
  po_header_id uuid not null references po_headers(id) on delete cascade,
  title_snapshot text, sku_snapshot text, qty numeric(12,2) not null default 0,
  company_entity_id uuid);
create table po_status_history(id uuid primary key default gen_random_uuid(),
  po_header_id uuid not null references po_headers(id) on delete cascade,
  old_status text, new_status text, changed_by uuid,
  changed_at timestamptz not null default now(), note text, company_entity_id uuid);
alter table po_headers enable row level security;
alter table po_status_history enable row level security;
create policy po_headers_active_select on po_headers for select to authenticated
  using (company_entity_id = (select active_company_id()) and ((select is_admin_user()) or created_by = (select auth.uid())));
create policy po_headers_active_update on po_headers for update to authenticated
  using (company_entity_id = (select active_company_id()) and ((select is_admin_user()) or created_by = (select auth.uid())))
  with check (company_entity_id = (select active_company_id()) and ((select is_admin_user()) or created_by = (select auth.uid())));
create policy po_status_history_active_all on po_status_history for all
  using (company_entity_id = active_company_id() and is_admin_user())
  with check (company_entity_id = active_company_id() and is_admin_user());

-- The real trigger stack on these two tables (read live 2026-11-25). Both of
-- its defaults are wrong for a connection, which is the point: changed_by is
-- the PO's CREATOR, and the company stamp reads the session.
create function stamp_company_entity_id() returns trigger language plpgsql security definer as $$
  begin
    if new.company_entity_id is null then new.company_entity_id := public.active_company_id(); end if;
    return new;
  end $$;
create function stamp_changed_by() returns trigger language plpgsql security definer as $$
  begin
    if new.changed_by is null then new.changed_by := auth.uid(); end if;
    return new;
  end $$;
create function log_po_status_change() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.po_status_history (po_header_id, old_status, new_status, changed_by, note)
      values (new.id, null, new.status, new.created_by, 'Initial status');
    return new;
  end if;
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    insert into public.po_status_history (po_header_id, old_status, new_status, changed_by, note)
      values (new.id, old.status, new.status, new.created_by, null);
  end if;
  return new;
end $$;
create trigger stamp_company_entity_id before insert on po_status_history
  for each row execute function stamp_company_entity_id();
create trigger stamp_changed_by before insert on po_status_history
  for each row execute function stamp_changed_by();
create trigger trg_po_headers_status_history after insert or update on po_headers
  for each row execute function log_po_status_change();
create trigger trg_po_headers_updated_at before update on po_headers
  for each row execute function set_updated_at();

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
-- Production's default privileges, faithfully: Supabase re-grants EVERY new
-- public table to anon and authenticated, so a migration that only grants and
-- never revokes leaves anon holding the table. That is exactly what shipped in
-- 20261125234500 and what 20261126000500 takes back, and this suite missed it
-- because the fixture used to leave these two out.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role, silo_integration;
grant execute on function active_company_id() to anon, authenticated, service_role, silo_integration;
grant execute on function is_admin_user() to authenticated, service_role;
`);

// ── Data BEFORE the migration: the seed has to find these ─────────────────
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
  ('${G.step}',    'c1', 'app:c1', 0, '${U.adminA}',  '${A}', array['reports:read','data:read','po_status:write'], now(), now() + interval '90 days'),
  ('${G.reads}',   'c2', 'app:c2', 0, '${U.adminA}',  '${A}', array['reports:read','data:read'], now(), now() + interval '90 days'),
  ('${G.paused}',  'c3', 'app:c3', 0, '${U.adminA}',  '${A}', array['po_status:write'], now(), now() + interval '90 days'),
  ('${G.member}',  'c4', 'app:c4', 0, '${U.memberA}', '${A}', array['po_status:write'], now(), now() + interval '90 days'),
  ('${G.otherCo}', 'c5', 'app:c5', 0, '${U.ownerB}',  '${B}', array['po_status:write'], now(), now() + interval '90 days');
update silo_api_grants set writes_paused_at = now() where id = '${G.paused}';

insert into factories(id, factory_name, company_entity_id) values
  ('40000000-0000-0000-0000-000000000001', 'Factory One', '${A}');
insert into po_headers(id, po_name, factory_id, order_date, status, company_entity_id, created_by) values
  ('50000000-0000-0000-0000-000000000001', 'PO-1', '40000000-0000-0000-0000-000000000001', date '2026-10-01', 'Draft', '${A}', '${U.adminA}'),
  ('50000000-0000-0000-0000-000000000002', 'PO-2', '40000000-0000-0000-0000-000000000001', date '2026-10-02', 'In Production', '${A}', '${U.adminA}'),
  ('50000000-0000-0000-0000-000000000003', 'PO-3', '40000000-0000-0000-0000-000000000001', date '2026-10-03', 'Closed', '${A}', '${U.adminA}'),
  -- A status no default list names: the seed has to carry it over, or PO
  -- Builder could not show the PO that is at it.
  ('50000000-0000-0000-0000-000000000004', 'PO-4', '40000000-0000-0000-0000-000000000001', date '2026-10-04', 'At the embroiderer', '${A}', '${U.memberA}'),
  ('50000000-0000-0000-0000-000000000005', 'PO-5', '40000000-0000-0000-0000-000000000001', date '2026-10-05', 'Draft', '${A}', '${U.adminA}'),
  ('50000000-0000-0000-0000-000000000009', 'PO-B', null, date '2026-10-06', 'Draft', '${B}', '${U.ownerB}');
insert into po_lines(id, po_header_id, title_snapshot, sku_snapshot, qty, company_entity_id) values
  ('60000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'Hoodie', 'BB-YS-Hoodie', 160, '${A}');
`);

let sql = await readFile(new URL('../../supabase/migrations/20261125234500_po_status_write_scope.sql', import.meta.url), 'utf8');
const mut = (from, to) => {
  assert.ok(sql.includes(from), `mutation ${MUT}: pattern not found`);
  sql = sql.split(from).join(to);
};
switch (MUT) {
  case '': break;
  case 'not-offered':
    mut("'receiving:write', 'po_status:write']", "'receiving:write']"); break;
  case 'no-path':
    mut("    '/rpc/silo_api_set_po_status')", "    '/rpc/silo_api_never')"); break;
  case 'no-scope':
    mut("  perform public.silo_api_require_scope('po_status:write');", '  perform 1;'); break;
  case 'ignore-pause':
    mut('  if v_grant.writes_paused_at is not null then', '  if false then'); break;
  case 'session-company':
    mut('  v_company := v_grant.company_entity_id;\n  v_user    := v_grant.user_id;\n  v_app     := public.silo_api_app_name(v_grant.client_id, v_grant.app_key);',
        '  v_company := coalesce(public.active_company_id(), v_grant.company_entity_id);\n  v_user    := v_grant.user_id;\n  v_app     := public.silo_api_app_name(v_grant.client_id, v_grant.app_key);'); break;
  case 'any-step':
    mut('  if not v_opt.ai_settable then', '  if false then'); break;
  case 'receipt-step':
    mut('  if v_opt.needs_receipt then', '  if false then'); break;
  case 'unknown-step':
    mut('  if v_opt.name is null then', '  if false then'); break;
  case 'no-authority':
    mut('  if not public.silo_api_may_set_po_status(v_user, v_company, v_po.id) then', '  if false then'); break;
  case 'no-cap':
    mut('  if v_used >= public.silo_api_write_cap() then', '  if false then'); break;
  case 'no-idem':
    mut('  if v_prior.id is not null then', '  if false then'); break;
  case 'trigger-keeps-creator':
    mut("      new.id, old.status, new.status, coalesce(auth.uid(), new.created_by), null,\n      new.company_entity_id",
        "      new.id, old.status, new.status, new.created_by, null,\n      new.company_entity_id"); break;
  case 'no-history-stamp':
    mut('  if v_hist is not null then', '  if false then'); break;
  case 'no-lazy-seed':
    mut('  if exists (select 1 from public.po_status_options o where o.company_entity_id = p_company) then\n    return;\n  end if;',
        '  return;'); break;
  case 'no-odd-seed':
    mut("select distinct h.company_entity_id, btrim(h.status), 200, true, false, false",
        "select distinct h.company_entity_id, btrim(h.status), 200, true, false, false where false"); break;
  case 'no-revoke': break;   // handled where the second migration is read
  case 'person-reads-all':
    mut('security invoker\nset search_path = \'\'\nas $$\n  select coalesce(json_agg(x order by x.created_at desc), \'[]\'::json)',
        'security definer\nset search_path = \'\'\nas $$\n  select coalesce(json_agg(x order by x.created_at desc), \'[]\'::json)'); break;
  default: throw new Error(`unknown mutation ${MUT}`);
}

// 20261126000500 takes back what Supabase's default privileges handed anon and
// authenticated on the two tables above. It is part of the same feature, so it
// is applied here and carries its own mutation.
let grantSql = await readFile(
  new URL('../../supabase/migrations/20261126000500_po_status_tables_revoke_defaults.sql', import.meta.url), 'utf8');
if (MUT === 'no-revoke') {
  const from = 'revoke all on public.po_status_options from anon, silo_integration, silo_revoked;';
  assert.ok(grantSql.includes(from), 'mutation no-revoke: pattern not found');
  grantSql = grantSql.split('revoke').join('-- revoke');
}

// apply_all_post_merge.sql re-runs every migration: it must be idempotent.
for (let i = 0; i < 2; i += 1) await db.exec(sql + '\n' + grantSql);

const PO_DRAFT = '50000000-0000-0000-0000-000000000001';
const PO_PROD  = '50000000-0000-0000-0000-000000000002';
const PO_CLOSED = '50000000-0000-0000-0000-000000000003';
const PO_ODD   = '50000000-0000-0000-0000-000000000004';
const PO_SPARE = '50000000-0000-0000-0000-000000000005';
const PO_B     = '50000000-0000-0000-0000-000000000009';

/* An OAuth token carries the approving person's own sub, so auth.uid() inside
   a connection's call IS that person -- and their browser session's active
   company may be a different company from the one the grant is bound to.
   Emulating that is what makes "the company comes from the grant" testable at
   all. */
const APPROVER = { [G.step]: U.adminA, [G.reads]: U.adminA, [G.paused]: U.adminA,
  [G.member]: U.memberA, [G.otherCo]: U.ownerB };
const asConnection = async (grantId) => db.exec(`
  reset role;
  select set_config('test.integration', 'on', false);
  select set_config('test.grant_id', '${grantId}', false);
  select set_config('test.uid', '${APPROVER[grantId]}', false);
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

/* Reading the truth without disturbing who the test is pretending to be: a
   connection has no table privileges of its own (production's silo_integration
   holds none either -- the definer tools are the whole door), so these peek as
   the owner and then hand the role back. */
async function peek(fn) {
  const prev = (await one(`select current_user cu`)).cu;
  await db.exec('reset role;');
  try { return await fn(); }
  finally { if (prev !== 'postgres') await db.exec(`set role ${prev};`); }
}
const statusOf = (po) => peek(async () =>
  (await one(`select status from po_headers where id = $1`, [po])).status);
const writeCount = (grant) => peek(async () =>
  Number((await one(`select count(*) n from silo_api_writes where grant_id = $1`, [grant])).n));

// ── S: the scope ──────────────────────────────────────────────────────────
await check('consent offers po_status:write, and the three tool paths are allowed', async () => {
  await asService();
  const src = await one(`select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'silo_api_consent'`);
  assert.ok(src.prosrc.includes("'po_status:write'"), 'the consent allowlist offers the scope');
  const paths = await one(`select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'silo_api_path_allowed'`);
  for (const fn of ['silo_api_po_status_options', 'silo_api_pos_for_status', 'silo_api_set_po_status']) {
    assert.ok(paths.prosrc.includes('/rpc/' + fn), `${fn} is on the path allowlist`);
  }
  // Everything the receiving scope already had is still offered.
  for (const s of ['reports:read', 'data:read', 'work:write', 'outreach:send', 'codes:create', 'receiving:write']) {
    assert.ok(src.prosrc.includes(`'${s}'`), `${s} is still offered`);
  }
});

await check('a step set by a connection counts against its daily writes', async () => {
  await asService();
  const r = await one(`select pg_get_constraintdef(oid) d from pg_constraint
    where conname = 'silo_api_writes_kind_check' and conrelid = 'public.silo_api_writes'::regclass`);
  assert.ok(r.d.includes("'po_status'"), 'the ledger accepts the new kind of write');
  for (const kind of ['task', 'shipment_receipt']) {
    assert.ok(r.d.includes(`'${kind}'`), `${kind} is still accepted`);
  }
});

await check('the two new tables carry their meaning in the catalog a bot reads', async () => {
  await asService();
  const r = await rows(`select relname, description from silo_chat_schema_catalog
    where relname in ('po_status_options', 'po_status_changes') order by relname`);
  assert.equal(r.length, 2);
  const byName = Object.fromEntries(r.map((x) => [x.relname, x.description || '']));
  assert.ok(/needs_receipt/.test(byName.po_status_options),
    'a bot must be told which steps mean units arrived');
  assert.ok(/po_status_history/.test(byName.po_status_changes),
    'a bot must be told where the transition itself lives');
});

await check('a connection without the scope is refused', async () => {
  await asConnection(G.reads);
  await refused(`select public.silo_api_po_status_options()`, [], 'insufficient_scope');
  await refused(`select public.silo_api_pos_for_status(null, 10)`, [], 'insufficient_scope');
  await refused(`select public.silo_api_set_po_status($1, 'Sent to Factory', 'k-noscope')`,
    [PO_DRAFT], 'insufficient_scope');
});

await check('a paused connection may not set a step', async () => {
  await asConnection(G.paused);
  await refused(`select public.silo_api_set_po_status($1, 'Sent to Factory', 'k-paused')`,
    [PO_DRAFT], 'writes_paused');
  assert.equal(await statusOf(PO_DRAFT), 'Draft');
});

await check('no client role may call the tools or the internal helpers', async () => {
  await asService();
  for (const [role, fn] of [
    ['authenticated', 'silo_api_set_po_status'],
    ['anon', 'silo_api_set_po_status'],
    ['authenticated', 'silo_api_po_status_options'],
    ['authenticated', 'silo_api_pos_for_status'],
    ['authenticated', 'silo_api_po_status_grant'],
    ['authenticated', 'silo_api_may_set_po_status'],
    ['anon', 'silo_po_status_changes_recent'],
    ['silo_integration', 'silo_po_status_changes_recent'],
  ]) {
    const r = await one(`select bool_or(has_function_privilege($1, p.oid, 'execute')) ok
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname = $2`, [role, fn]);
    assert.equal(r.ok, false, `${role} must not execute ${fn}`);
  }
  // And the tables: the person's own reads are policies, never a direct read
  // by a connection or by anon.
  for (const [role, table, priv] of [
    ['anon', 'po_status_options', 'select'],
    ['anon', 'po_status_changes', 'select'],
    ['silo_integration', 'po_status_options', 'select'],
    ['silo_integration', 'po_status_changes', 'select'],
    ['authenticated', 'po_status_changes', 'insert'],
    ['authenticated', 'po_status_changes', 'update'],
    ['authenticated', 'po_status_changes', 'delete'],
    // TRUNCATE is the one RLS does NOT cover: a signed-in role holding it
    // could empty every company's step list in one statement.
    ['authenticated', 'po_status_options', 'truncate'],
    ['authenticated', 'po_status_changes', 'truncate'],
    ['anon', 'po_status_options', 'truncate'],
    ['anon', 'po_status_changes', 'truncate'],
  ]) {
    const r = await one(`select has_table_privilege($1, $2, $3) ok`, [role, 'public.' + table, priv]);
    assert.equal(r.ok, false, `${role} must not ${priv} ${table}`);
  }
});

// ── D: the steps are company data ─────────────────────────────────────────
await check('every company with POs is seeded, and a status already in use is carried over', async () => {
  await asService();
  const seeded = await rows(`select name, is_open, ai_settable, needs_receipt from po_status_options
    where company_entity_id = $1 order by sort_order, name`, [A]);
  const names = seeded.map((r) => r.name);
  for (const n of ['Draft', 'Sent to Factory', 'In Production', 'Received', 'Closed', 'Cancelled']) {
    assert.ok(names.includes(n), `${n} is seeded`);
  }
  assert.ok(names.includes('At the embroiderer'),
    'a status a PO already carries must be a step, or PO Builder cannot show that PO');
  // Company B has POs too, and gets its own rows -- never A's.
  const bCount = Number((await one(`select count(*) n from po_status_options where company_entity_id = $1`, [B])).n);
  assert.ok(bCount >= 11, 'company B is seeded in its own right');
  // No step is both settable by a connection and an arrival.
  const bad = Number((await one(`select count(*) n from po_status_options where ai_settable and needs_receipt`)).n);
  assert.equal(bad, 0, 'an arrival step is never settable by a connection');
  // Re-running the migration did not duplicate a step.
  const dupes = Number((await one(`select count(*) n from (
    select company_entity_id, name from po_status_options group by 1,2 having count(*) > 1) d`)).n);
  assert.equal(dupes, 0, 'the seed is idempotent');
});

await check('a workspace that had no POs when this was applied is seeded on first use', async () => {
  // Its first PO may well be created by someone who is not an admin, so
  // leaving the list to an admin would leave a new workspace with nothing the
  // builder or an AI could offer.
  await asService();
  await db.query(`delete from po_status_options where company_entity_id = $1`, [B]);
  await asConnection(G.otherCo);
  const r = await one(`select public.silo_api_po_status_options() j`);
  assert.ok(r.j.steps.length >= 11, 'the default steps appear on first use');
  // And an edited list is never "restored": a withdrawn step stays withdrawn.
  await asService();
  await db.query(`delete from po_status_options where company_entity_id = $1 and name = 'Shipped'`, [B]);
  await asConnection(G.otherCo);
  const again = await one(`select public.silo_api_po_status_options() j`);
  assert.ok(!again.j.steps.some((x) => x.status === 'Shipped'),
    'a company that removed a step does not get it back');
});

await check('the options tool tells the AI which steps it may set, and which need a delivery', async () => {
  await asConnection(G.step);
  const r = await one(`select public.silo_api_po_status_options() j`);
  const steps = r.j.steps;
  const settable = steps.filter((s) => s.ai_settable).map((s) => s.status);
  assert.deepEqual(settable.sort(), ['Confirmed', 'In Production', 'In Transit', 'Sent to Factory', 'Shipped'].sort(),
    'only the progress steps are settable');
  for (const s of steps) {
    if (['Received', 'Partially Received'].includes(s.status)) {
      assert.equal(s.needs_receipt, true, `${s.status} needs a confirmed delivery`);
      assert.equal(s.ai_settable, false, `${s.status} is not settable`);
    }
  }
  assert.ok(/record_shipment_receipt/.test(r.j.how_to_use), 'the answer points arrivals at the receipt tool');
  assert.ok(/no second confirmation|applies it immediately/i.test(r.j.how_to_use),
    'the answer says the change is live, so the AI asks first');
});

await check('the POs listed are the ones that can still move -- a draft included, a closed one not', async () => {
  await asConnection(G.step);
  const r = await one(`select public.silo_api_pos_for_status(null, 50) j`);
  const names = r.j.purchase_orders.map((p) => p.po_name);
  assert.ok(names.includes('PO-1'), 'a draft PO is listed: "the factory has it now" is its next step');
  assert.ok(names.includes('PO-2'), 'an in-production PO is listed');
  assert.ok(!names.includes('PO-3'), 'a closed PO is not listed');
  assert.ok(!names.includes('PO-B'), 'another company\'s PO is not listed');
  const po1 = r.j.purchase_orders.find((p) => p.po_name === 'PO-1');
  assert.equal(po1.you_may_set_its_step, true, 'an admin\'s connection may move it');
  assert.ok(r.j.steps_you_may_set.includes('Sent to Factory'), 'the answer names the steps it may set');
});

// ── W + H: the write and its evidence ─────────────────────────────────────
await check('setting a step applies it immediately, once', async () => {
  await asConnection(G.step);
  const r = await one(`select public.silo_api_set_po_status($1, 'Sent to Factory', 'k-1',
    'Factory confirmed the order by email', 'Factory email', 'https://mail.example.com/t/1') j`, [PO_DRAFT]);
  assert.equal(r.j.applied, true);
  assert.equal(r.j.changed, true);
  assert.equal(r.j.old_status, 'Draft');
  assert.equal(r.j.new_status, 'Sent to Factory');
  assert.equal(r.j.via, 'Claude');
  assert.ok(/live now|nobody has to confirm/i.test(r.j.say), 'the answer tells the person it is done');
  assert.equal(await statusOf(PO_DRAFT), 'Sent to Factory', 'the PO moved in SILO');
  assert.equal(await writeCount(G.step), 1, 'one write against the cap');
});

await check('the change is on the record: the reason, the document, the app and the person', async () => {
  await asService();
  const c = await one(`select * from po_status_changes where po_header_id = $1`, [PO_DRAFT]);
  assert.equal(c.old_status, 'Draft');
  assert.equal(c.new_status, 'Sent to Factory');
  assert.equal(c.reason, 'Factory confirmed the order by email');
  assert.equal(c.source_label, 'Factory email');
  assert.equal(c.source_url, 'https://mail.example.com/t/1');
  assert.equal(c.via_app, 'Claude');
  assert.equal(c.requested_by, U.adminA, 'the person whose connection it is');
  assert.equal(c.company_entity_id, A, 'the grant\'s company, not a session\'s');
  assert.equal(c.grant_id, G.step);
});

await check('a person\'s own status change in SILO records THEM, not the PO\'s creator', async () => {
  // The trigger stamped new.created_by for every change, so history named
  // whoever opened the PO. Corrected in this migration, for every writer --
  // the builder, a script and this scope alike.
  // PO-4 was created by the member; the ADMIN moves it, so "the creator" and
  // "whoever changed it" are different people and the bug is visible.
  const before = await statusOf(PO_ODD);
  await asPerson(U.adminA);
  await db.query(`update po_headers set status = 'Shipped' where id = $1`, [PO_ODD]);
  const h = await peek(async () => await one(`select * from po_status_history
    where po_header_id = $1 order by changed_at desc, id desc limit 1`, [PO_ODD]));
  assert.equal(h.new_status, 'Shipped', 'the change was recorded');
  assert.equal(h.changed_by, U.adminA, 'the person who made the change, not the PO\'s creator');
  assert.notEqual(h.changed_by, U.memberA, 'which is a different person here');
  assert.equal(h.company_entity_id, A, 'and the PO\'s own company');

  // A writer with no session at all (a sync script, the service role) keeps
  // today's behaviour rather than writing a null.
  await asService();
  await db.query(`update po_headers set status = 'In Transit' where id = $1`, [PO_ODD]);
  const h2 = await one(`select changed_by, company_entity_id from po_status_history
    where po_header_id = $1 order by changed_at desc, id desc limit 1`, [PO_ODD]);
  assert.equal(h2.changed_by, U.memberA, 'falls back to the PO\'s creator, never null');
  assert.equal(h2.company_entity_id, A, 'and the company is still the PO\'s');
  await db.query(`update po_headers set status = $2 where id = $1`, [PO_ODD, before]);
});

await check('the PO\'s own history row names the approving person and the app, not the trigger\'s defaults', async () => {
  await asService();
  const h = await one(`select * from po_status_history
    where po_header_id = $1 and new_status = 'Sent to Factory' order by changed_at desc limit 1`, [PO_DRAFT]);
  assert.ok(h, 'the transition is in po_status_history');
  assert.equal(h.changed_by, U.adminA, 'who changed it, not who created the PO');
  assert.equal(h.company_entity_id, A, 'the grant\'s company');
  assert.ok(/^Via Claude/.test(h.note || ''), `the note names the app: ${h.note}`);
  assert.ok(/Factory confirmed/.test(h.note || ''), 'the note carries the reason');
});

await check('the same key replays instead of moving the PO a second time', async () => {
  await asConnection(G.step);
  const r = await one(`select public.silo_api_set_po_status($1, 'In Production', 'k-1') j`, [PO_DRAFT]);
  assert.equal(r.j.replayed, true, 'a retry is the first change, whatever it now asks for');
  assert.equal(r.j.new_status, 'Sent to Factory');
  assert.equal(await statusOf(PO_DRAFT), 'Sent to Factory', 'the PO did not move again');
  assert.equal(await writeCount(G.step), 1, 'and no second write was spent');
  const changes = await peek(async () =>
    Number((await one(`select count(*) n from po_status_changes where po_header_id = $1`, [PO_DRAFT])).n));
  assert.equal(changes, 1, 'and only one change was recorded');
});

await check('a step the PO is already at changes nothing and spends nothing', async () => {
  await asConnection(G.step);
  const r = await one(`select public.silo_api_set_po_status($1, 'Sent to Factory', 'k-already') j`, [PO_DRAFT]);
  assert.equal(r.j.applied, false);
  assert.equal(r.j.reason, 'already_set');
  assert.equal(await writeCount(G.step), 1, 'a no-op is not a write');
});

// ── A + D: what a connection may never set ────────────────────────────────
await check('a step that means units arrived is refused, with the receipt tool named', async () => {
  await asConnection(G.step);
  const err = await refused(`select public.silo_api_set_po_status($1, 'Received', 'k-recv')`,
    [PO_PROD], 'needs_receipt');
  assert.ok(/record_shipment_receipt/.test(err.message), 'the refusal says what to do instead');
  await refused(`select public.silo_api_set_po_status($1, 'Partially Received', 'k-part')`,
    [PO_PROD], 'needs_receipt');
  assert.equal(await statusOf(PO_PROD), 'In Production');
  assert.equal(await writeCount(G.step), 1, 'a refusal spends no write');
});

await check('approving, closing and cancelling stay a person\'s', async () => {
  await asConnection(G.step);
  for (const s of ['Approved', 'Closed', 'Cancelled', 'Draft']) {
    await refused(`select public.silo_api_set_po_status($1, $2, $3)`,
      [PO_PROD, s, 'k-' + s], 'status_not_settable');
  }
  assert.equal(await statusOf(PO_PROD), 'In Production');
});

await check('a step this company does not have is refused, not invented', async () => {
  await asConnection(G.step);
  await refused(`select public.silo_api_set_po_status($1, 'Sent to the moon', 'k-moon')`,
    [PO_PROD], 'unknown_status');
  // A step withdrawn from the list stops being settable, with no deploy.
  await asService();
  await db.query(`update po_status_options set is_active = false
    where company_entity_id = $1 and name = 'Shipped'`, [A]);
  await asConnection(G.step);
  await refused(`select public.silo_api_set_po_status($1, 'Shipped', 'k-withdrawn')`,
    [PO_PROD], 'unknown_status');
  await asService();
  await db.query(`update po_status_options set is_active = true
    where company_entity_id = $1 and name = 'Shipped'`, [A]);
  // And a company can let a connection set a step of its own naming, as data.
  await db.query(`update po_status_options set ai_settable = true
    where company_entity_id = $1 and name = 'At the embroiderer'`, [A]);
  await asConnection(G.step);
  const r = await one(`select public.silo_api_set_po_status($1, 'At the embroiderer', 'k-own') j`, [PO_PROD]);
  assert.equal(r.j.new_status, 'At the embroiderer', 'the company\'s own step is settable because its data says so');
  assert.equal(await statusOf(PO_PROD), 'At the embroiderer');
});

// ── P: authority is the approving person's ────────────────────────────────
await check('a member\'s connection may move only a PO they created', async () => {
  await asConnection(G.member);
  // PO-5 was created by the admin: the member may not change it in SILO, so
  // neither may their connection.
  await refused(`select public.silo_api_set_po_status($1, 'Sent to Factory', 'k-m1')`,
    [PO_SPARE], 'not_permitted');
  assert.equal(await statusOf(PO_SPARE), 'Draft');
  assert.equal(await writeCount(G.member), 0);
  // PO-4 is their own.
  const r = await one(`select public.silo_api_set_po_status($1, 'In Production', 'k-m2') j`, [PO_ODD]);
  assert.equal(r.j.applied, true);
  assert.equal(await statusOf(PO_ODD), 'In Production');
  // And the list told them so beforehand.
  const list = await one(`select public.silo_api_pos_for_status('PO-', 50) j`);
  const byName = Object.fromEntries(list.j.purchase_orders.map((p) => [p.po_name, p.you_may_set_its_step]));
  assert.equal(byName['PO-5'], false, 'the list says which POs this connection cannot move');
});

await check('the company is the grant\'s, never the approver\'s session', async () => {
  // The approving person is looking at company B in the browser; the grant is
  // bound to A. A PO in B does not exist to this connection, and a PO in A is
  // still theirs to move.
  await asService();
  await db.query(`update profiles set active_company_id = $1 where id = $2`, [B, U.adminA]);
  await asConnection(G.step);
  await refused(`select public.silo_api_set_po_status($1, 'Sent to Factory', 'k-cross')`,
    [PO_B], 'unknown_po');
  const r = await one(`select public.silo_api_set_po_status($1, 'Sent to Factory', 'k-a-while-on-b') j`, [PO_SPARE]);
  assert.equal(r.j.applied, true);
  const co = await peek(async () => (await one(
    `select company_entity_id from po_status_changes where idempotency_key = 'k-a-while-on-b'`)).company_entity_id);
  assert.equal(co, A, 'recorded against the grant\'s company');
  assert.equal(await statusOf(PO_B), 'Draft', 'the other company\'s PO never moved');
  await asService();
  await db.query(`update profiles set active_company_id = $1 where id = $2`, [A, U.adminA]);
});

await check('a connection whose approver left the company is refused', async () => {
  await asService();
  await db.query(`delete from entity_memberships where user_id = $1 and entity_id = $2`, [U.memberA, A]);
  await asConnection(G.member);
  await refused(`select public.silo_api_set_po_status($1, 'Shipped', 'k-gone')`, [PO_ODD], 'not_a_member');
  await asService();
  await db.query(`insert into entity_memberships(entity_id, user_id, role) values ($1, $2, 'member')`, [A, U.memberA]);
});

await check('the daily cap stops the next step', async () => {
  await asService();
  await db.query(`select set_config('test.cap', '1', false)`);
  await asConnection(G.member);
  await db.query(`select set_config('test.cap', '1', false)`);
  await refused(`select public.silo_api_set_po_status($1, 'Shipped', 'k-cap')`, [PO_ODD], 'write_cap_reached');
  assert.equal(await statusOf(PO_ODD), 'In Production', 'the PO did not move');
  await db.query(`select set_config('test.cap', '', false)`);
});

// ── R: what the person reads afterwards ───────────────────────────────────
await check('the card in PO Report shows this company\'s changes, and only its own', async () => {
  await asPerson(U.adminA);
  const r = await one(`select public.silo_po_status_changes_recent(14, 50) j`);
  const list = r.j;
  assert.ok(list.length >= 2, 'the person sees what the app set');
  for (const c of list) {
    assert.ok(['PO-1', 'PO-2', 'PO-4', 'PO-5'].includes(c.po_name), `only company A's POs: ${c.po_name}`);
  }
  const first = list.find((c) => c.po_name === 'PO-1');
  assert.equal(first.via_app, 'Claude');
  assert.equal(first.reason, 'Factory confirmed the order by email');
  assert.equal(first.requested_by_email, 'admin@a.test');

  // Company B's owner sees none of it: B's own POs were never moved.
  await asPerson(U.ownerB);
  const rb = await one(`select public.silo_po_status_changes_recent(14, 50) j`);
  assert.equal(rb.j.length, 0, 'another company sees nothing');
});

await check('the browser can seed only the company it is looking at', async () => {
  await asService();
  await db.query(`delete from po_status_options where company_entity_id = $1`, [B]);
  // The company-taking form is the definer tools' own; a browser role cannot
  // call it, so it cannot seed (or touch) another company.
  const priv = await one(`select bool_or(has_function_privilege('authenticated', p.oid, 'execute')) ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'po_status_options_ensure' and p.pronargs = 1`);
  assert.equal(priv.ok, false, 'authenticated must not call the form that takes a company id');
  // The zero-argument form seeds the ACTIVE company and nothing else.
  await asPerson(U.adminA);
  await db.query(`select public.po_status_options_ensure()`);
  const mine = await peek(async () =>
    Number((await one(`select count(*) n from po_status_options where company_entity_id = $1`, [A])).n));
  const theirs = await peek(async () =>
    Number((await one(`select count(*) n from po_status_options where company_entity_id = $1`, [B])).n));
  assert.ok(mine >= 11, 'company A still has its own list');
  assert.equal(theirs, 0, 'and company B was not seeded by someone else\'s browser');
  await asConnection(G.otherCo);
  await one(`select public.silo_api_po_status_options() j`);
  const after = await peek(async () =>
    Number((await one(`select count(*) n from po_status_options where company_entity_id = $1`, [B])).n));
  assert.ok(after >= 11, 'B\'s own connection seeds B');
});

await check('PO Builder can read its steps; only an admin can change the list', async () => {
  await asPerson(U.memberA);
  const seen = await rows(`select name from po_status_options order by sort_order`);
  assert.ok(seen.length >= 11, 'a member reads the list the dropdown is built from');
  await refused(`insert into po_status_options(company_entity_id, name) values ($1, 'Member step')`,
    [A], 'policy');
  await asPerson(U.adminA);
  await db.query(`insert into po_status_options(company_entity_id, name, sort_order) values ($1, 'Admin step', 120)`, [A]);
  const after = await one(`select count(*) n from po_status_options where name = 'Admin step'`);
  assert.equal(Number(after.n), 1, 'an admin names their own step without a deploy');
  // Another company's list is invisible either way.
  const other = await one(`select count(*) n from po_status_options where company_entity_id = $1`, [B]);
  assert.equal(Number(other.n), 0, 'RLS keeps each company\'s list its own');
});

// ── V: the production check itself ────────────────────────────────────────
await check('verify_v2_schema.sql\'s own check passes against this schema', async () => {
  await asService();
  // The block the drift check runs on production every day. Running it here
  // proves it parses and that it agrees with what the migration builds --
  // otherwise its first contact with reality is a red workflow.
  const verify = await readFile(new URL('../../supabase/verify_v2_schema.sql', import.meta.url), 'utf8');
  const at = verify.indexOf("-- A purchase order's step set by a connected AI");
  assert.ok(at > 0, 'the check is in verify_v2_schema.sql');
  // Only this check's own statement: anything appended to the file after it
  // would otherwise arrive here as a second command in one prepared statement.
  let block = verify.slice(at);
  const mine = /\nselect '[^']+' as check_name,/.exec(block);
  const next = /\nselect '[^']+' as check_name,/.exec(block.slice(mine.index + 1));
  if (next) block = block.slice(0, mine.index + 1 + next.index + 1);
  // Trailing comment lines head the NEXT check, so they are not part of this one.
  block = block.split('\n').reduceRight((acc, l) => (acc.length || !/^\s*(--.*)?$/.test(l) ? [l, ...acc] : acc), []).join('\n').trim();
  assert.ok(block.endsWith(';'), 'could not extract the verify block');
  const r = await one(block);
  assert.equal(r.status, 'ok', `verify says: ${r.status}`);
});

await asService();
console.log(`\n1..${passed}\n# all ${passed} checks passed`);
