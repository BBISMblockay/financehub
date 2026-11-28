// scripts/tests/po-email-mcp-database.test.mjs
//
// po_email:send (20261128050000) on real PostgreSQL (PGlite): a purchase
// order goes to its factory as an email the PERSON'S OWN AI sends from the
// PERSON'S OWN mailbox, with the PO attached. Blake, 2026-11-28: "email mcp
// prompt for their pos unsent etc ... it would attach said pos with drafted
// copy based on po factors etc".
//
// The migration runs twice (apply_all_post_merge.sql re-runs it). The
// developer-platform plumbing it builds on (grants, the scope gate, the write
// ledger, the purchasing authority rule) is a fixture with the live shapes.
//
// What this proves:
//   S  the scope: offered by consent, its own two paths, refused without it,
//      refused when writing is paused, refused to a browser session
//   D  the drafted copy is built from the PO's own factors -- dates, styles,
//      units, the new-product flag, the factory's terms, the other POs still
//      open with that factory -- and names what is missing
//   Q  queueing is a PERSON's act, under the same authority as moving that
//      PO's step, and one PO can have only one live email at a time
//   C  the claim: marks the row claimed, spends exactly one write, mints a
//      document link whose RAW token is never stored, and replays on the same
//      idempotency key instead of taking more
//   M  the send: evidence required, only the connection that claimed it may
//      record it, the PO moves to the company's vendor-send step, the
//      document link is retired, and a second call replays
//   V  which step that is, is COMPANY DATA: the flagged one, else the first
//      open ai_settable step, and no status name anywhere in the code
//   R  another company's queue does not exist to this connection
//
// Mutations (CI runs each and requires the suite to FAIL):
//   PO_EMAIL_MUTATION=not-offered    consent does not offer po_email:send
//   PO_EMAIL_MUTATION=no-path        the claim path is not on the allowlist
//   PO_EMAIL_MUTATION=no-scope       the tools do not require the scope
//   PO_EMAIL_MUTATION=ignore-pause   a paused connection still claims
//   PO_EMAIL_MUTATION=raw-token      the raw document token is stored as-is
//   PO_EMAIL_MUTATION=no-cap         the daily write cap is not checked
//   PO_EMAIL_MUTATION=no-idem        a retry claims a second time
//   PO_EMAIL_MUTATION=any-grant      any connection may mark an email sent
//   PO_EMAIL_MUTATION=no-evidence    a send is recorded without evidence
//   PO_EMAIL_MUTATION=keep-token     the document link survives the send
//   PO_EMAIL_MUTATION=two-live       a PO can have two live emails at once
//   PO_EMAIL_MUTATION=any-company    another company's queue is reachable
//
// Run:  npm ci --prefix scripts/tests/finance-db --ignore-scripts
//       node scripts/tests/po-email-mcp-database.test.mjs
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUT = process.env.PO_EMAIL_MUTATION || '';
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
  adminA:  '10000000-0000-0000-0000-000000000001',
  memberA: '10000000-0000-0000-0000-000000000002',  // may act only on POs they created
  ownerB:  '10000000-0000-0000-0000-000000000003',
};
const G = {
  mail:    '30000000-0000-0000-0000-000000000001',  // adminA, po_email:send
  reads:   '30000000-0000-0000-0000-000000000002',  // adminA, reads only
  paused:  '30000000-0000-0000-0000-000000000003',
  second:  '30000000-0000-0000-0000-000000000004',  // adminA, po_email:send, a second app
  otherCo: '30000000-0000-0000-0000-000000000005',  // ownerB
};
const PO = {
  ready:   '40000000-0000-0000-0000-000000000001',  // A, adminA's, has lines
  other:   '40000000-0000-0000-0000-000000000002',  // A, still open with the same factory
  theirs:  '40000000-0000-0000-0000-000000000003',  // B
};
const FAC = { a: '50000000-0000-0000-0000-00000000000a', b: '50000000-0000-0000-0000-00000000000b' };

// ── Fixture: the live shapes this migration builds on ─────────────────────
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create role silo_integration; create role silo_revoked;
create schema auth;
create schema extensions;
grant usage on schema auth, extensions to anon, authenticated, service_role, silo_integration;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create function gen_random_uuid() returns uuid language sql as
  $$ select md5(random()::text || clock_timestamp()::text)::uuid $$;

-- pgcrypto is not available in PGlite. These stand in for the two calls the
-- migration makes, with the properties the migration relies on: bytes that
-- differ per call, and a digest that is not its input.
create function extensions.gen_random_bytes(n integer) returns bytea language sql volatile as
  $$ select decode(md5(random()::text || clock_timestamp()::text) || md5(random()::text), 'hex') $$;
create function extensions.digest(t text, alg text) returns bytea language sql immutable as
  $$ select decode(md5('digest:' || t) || md5('digest2:' || t), 'hex') $$;

create table entities(id uuid primary key, title text);
create table profiles(id uuid primary key, email text, is_active boolean not null default true,
  role text, active_company_id uuid);
create table entity_memberships(entity_id uuid, user_id uuid, role text);
create function active_company_id() returns uuid language sql stable security definer as
  $$ select active_company_id from public.profiles where id = auth.uid() $$;

create table company_settings(
  company_entity_id uuid primary key, legal_name text,
  address_line1 text, address_line2 text, city text, region text, postal_code text, country text, phone text,
  purchasing_contact_name text, purchasing_contact_phone text, purchasing_contact_email text);

create table factories(
  id uuid primary key, factory_name text, short_code text, contact_name text, contact_email text,
  phone text, payment_terms text, shipping_terms text, address text, notes text, country text,
  is_active boolean default true, company_entity_id uuid);

create table po_headers(
  id uuid primary key, po_name text, factory_id uuid references factories(id),
  order_date date, req_ship_date date, expected_arrival_date date, status text,
  notes text, internal_notes text, is_new_product_po boolean not null default false,
  created_by uuid, company_entity_id uuid);

create table po_lines(
  id uuid primary key default gen_random_uuid(), po_header_id uuid references po_headers(id) on delete cascade,
  title_snapshot text, sku_snapshot text, variant_title_snapshot text, qty numeric, company_entity_id uuid);

create table po_status_options(
  id uuid primary key default gen_random_uuid(), company_entity_id uuid, name text, sort_order integer,
  is_open boolean not null default false, ai_settable boolean not null default false,
  needs_receipt boolean not null default false, is_final boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid);

create table silo_api_grants(
  id uuid primary key, client_id text, app_key text, slot integer, user_id uuid,
  company_entity_id uuid, auth_session_id uuid, generation integer, scopes text[],
  consented_aal text, consented_at timestamptz default now(), expires_at timestamptz,
  revoked_at timestamptz, last_used_at timestamptz, writes_paused_at timestamptz);

create table silo_api_writes(
  id uuid primary key default gen_random_uuid(), company_entity_id uuid, grant_id uuid, user_id uuid,
  via text, kind text, target_id uuid, created_at timestamptz not null default now(),
  -- The live CHECK as 20261125234500 left it. The migration must EXTEND it:
  -- without that, every claim fails on the write ledger in production and
  -- nowhere else. (It did, until this constraint was put in the fixture.)
  constraint silo_api_writes_kind_check check (
    kind in ('task', 'outreach_claim', 'code_created', 'shipment_receipt', 'po_status')));

-- The connection's identity, as the live helpers resolve it.
create function silo_api_is_integration() returns boolean language sql stable as
  $$ select coalesce(nullif(current_setting('test.grant', true), ''), '') <> '' $$;
create function silo_api_grant() returns setof silo_api_grants language sql stable as
  $$ select * from public.silo_api_grants g
      where g.id = nullif(current_setting('test.grant', true), '')::uuid
        and g.revoked_at is null $$;
create function silo_api_require_scope(p text) returns void language plpgsql volatile as $$
declare v_has boolean;
begin
  select p = any(g.scopes) into v_has from public.silo_api_grant() g limit 1;
  if not coalesce(v_has, false) then
    raise exception 'insufficient_scope: this connection was not given %', p
      using errcode = 'insufficient_privilege';
  end if;
end $$;
create function silo_api_app_name(a text, b text) returns text language sql stable as
  $$ select coalesce(nullif(a, ''), nullif(b, ''), 'an application') $$;
create function silo_api_app_key(p text) returns text language sql stable as $$ select lower(p) $$;
create function silo_api_app_connection_limit() returns integer language sql stable as $$ select 3 $$;
create function silo_api_write_cap() returns integer language sql stable as
  $$ select coalesce(nullif(current_setting('test.cap', true), '')::integer, 50) $$;
create function silo_api_claims() returns jsonb language sql stable as
  $$ select jsonb_build_object('aal', coalesce(nullif(current_setting('test.aal', true), ''), 'aal1')) $$;

-- po_headers' own UPDATE rule, as 20261125234500 states it.
create function silo_api_may_set_po_status(p_user uuid, p_company uuid, p_po_header_id uuid)
returns boolean language sql stable security definer as $$
  select exists (
    select 1
      from public.po_headers h
      join public.profiles p on p.id = p_user and coalesce(p.is_active, true) = true
      left join public.entity_memberships em on em.user_id = p_user and em.entity_id = p_company
     where h.id = p_po_header_id
       and h.company_entity_id = p_company
       and (h.created_by = p_user
            or case when em.role is not null then em.role in ('owner_admin','admin')
                    else p.role in ('owner','admin') end))
$$;
create function attach_stamp_company_entity_id_triggers() returns void language sql volatile as $$ select $$;
grant usage on schema public to anon, authenticated, silo_integration, silo_revoked;
`);

// ── Seed ───────────────────────────────────────────────────────────────────
await db.exec(`
insert into entities values ('${A}','Company A'), ('${B}','Company B');
insert into auth.users values ('${U.adminA}'), ('${U.memberA}'), ('${U.ownerB}');
insert into profiles (id, email, role, active_company_id) values
  ('${U.adminA}','admin@a.test','admin','${A}'),
  ('${U.memberA}','member@a.test','member','${A}'),
  ('${U.ownerB}','owner@b.test','owner','${B}');
insert into entity_memberships values ('${A}','${U.adminA}','admin'), ('${A}','${U.memberA}','member'),
  ('${B}','${U.ownerB}','owner_admin');
insert into company_settings (company_entity_id, legal_name, purchasing_contact_name, purchasing_contact_email)
  values ('${A}','Company A Inc.','Blake','purchasing@a.test');
insert into factories (id, factory_name, contact_name, contact_email, payment_terms, shipping_terms, company_entity_id)
  values ('${FAC.a}','Incotexco','Ana','ana@incotexco.test','30/70','FOB Cartagena','${A}'),
         ('${FAC.b}','Other Factory',null,null,null,null,'${B}');
insert into po_status_options (company_entity_id, name, sort_order, is_open, ai_settable, needs_receipt, is_final) values
  ('${A}','Draft',10,false,false,false,false),
  ('${A}','Sent to Factory',30,true,true,false,false),
  ('${A}','In Production',50,true,true,false,false),
  ('${A}','Received',90,false,false,true,true),
  ('${B}','Draft',10,false,false,false,false),
  ('${B}','Sent to Factory',30,true,true,false,false);
insert into po_headers (id, po_name, factory_id, order_date, req_ship_date, expected_arrival_date, status, notes, is_new_product_po, created_by, company_entity_id) values
  ('${PO.ready}','A-1150','${FAC.a}','2026-11-25','2027-01-22','2027-03-08','Draft','Use the new neck label.',true,'${U.adminA}','${A}'),
  ('${PO.other}','A-1098','${FAC.a}','2026-11-02',null,'2027-02-18','In Production',null,false,'${U.adminA}','${A}'),
  ('${PO.theirs}','B-900','${FAC.b}','2026-11-01',null,null,'Draft',null,false,'${U.ownerB}','${B}');
insert into po_lines (po_header_id, title_snapshot, sku_snapshot, variant_title_snapshot, qty) values
  ('${PO.ready}','Vintage Tee','VT-NVY','M',900),
  ('${PO.ready}','Field Hoodie','FH-CHR','L',650);
insert into silo_api_grants (id, client_id, app_key, slot, user_id, company_entity_id, generation, scopes, expires_at) values
  ('${G.mail}','app-mail','app-mail',0,'${U.adminA}','${A}',1,array['reports:read','po_email:send'], now() + interval '90 days'),
  ('${G.reads}','app-read','app-read',0,'${U.adminA}','${A}',1,array['reports:read'], now() + interval '90 days'),
  ('${G.paused}','app-paused','app-paused',1,'${U.adminA}','${A}',1,array['po_email:send'], now() + interval '90 days'),
  ('${G.second}','app-two','app-two',2,'${U.adminA}','${A}',1,array['po_email:send'], now() + interval '90 days'),
  ('${G.otherCo}','app-b','app-b',0,'${U.ownerB}','${B}',1,array['po_email:send'], now() + interval '90 days');
update silo_api_grants set writes_paused_at = now() where id = '${G.paused}';
`);

// ── The migration, applied twice ──────────────────────────────────────────
let sql = await readFile(new URL('../../supabase/migrations/20261128050000_po_email_send_scope.sql', import.meta.url), 'utf8');

if (MUT === 'not-offered') sql = sql.replace(", 'po_email:send']", "]");
if (MUT === 'no-path') sql = sql.replace("    '/rpc/silo_api_po_emails_to_send',\n", '');
if (MUT === 'no-scope') sql = sql.replace("perform public.silo_api_require_scope('po_email:send');", '');
if (MUT === 'ignore-pause') {
  sql = sql.replace(`  if v_grant.writes_paused_at is not null then
    raise exception 'writes_paused: writing is switched off for this connection in Connected apps'
      using errcode = 'insufficient_privilege';
  end if;`, '');
}
if (MUT === 'raw-token') {
  sql = sql.replace("doc_token_hash = encode(extensions.digest(v_raw, 'sha256'), 'hex'),", 'doc_token_hash = v_raw,');
}
if (MUT === 'no-cap') {
  sql = sql.replace(`    if v_room <= 0 then
      raise exception 'write_cap_reached: this connection has used its % writes for today', public.silo_api_write_cap()
        using errcode = 'check_violation';
    end if;
    v_limit := least(greatest(coalesce(p_limit, 10), 1), 10, v_room);`,
    '    v_limit := least(greatest(coalesce(p_limit, 10), 1), 10);');
}
if (MUT === 'no-kind') {
  sql = sql.replace(",\n                  'po_email_claim'", '');
}
if (MUT === 'no-idem') sql = sql.replace('  if v_key is not null then\n    v_replay := exists (', '  if false then\n    v_replay := exists (');
if (MUT === 'any-grant') {
  sql = sql.replace("if v_e.status <> 'claimed' or v_e.claimed_by_grant_id is distinct from v_grant.id then",
                    "if v_e.status <> 'claimed' then");
}
if (MUT === 'no-evidence') {
  sql = sql.replace(`  if v_evidence = '' then
    raise exception 'evidence_required: pass the sent message''s id (or another reference a person can look up)'
      using errcode = 'check_violation';
  end if;`, '');
  sql = sql.replace("check (status <> 'sent' or (sent_at is not null and btrim(coalesce(sent_evidence, '')) <> ''))",
                    'check (true)');
}
if (MUT === 'keep-token') {
  sql = sql.replace(`         doc_token_hash = null,
         doc_token_expires_at = null,
         updated_at = now()`, '         updated_at = now()');
}
if (MUT === 'two-live') {
  sql = sql.replace(`create unique index if not exists po_vendor_emails_one_live_per_po
  on public.po_vendor_emails (po_header_id)
  where status in ('queued', 'claimed');`, '');
}
if (MUT === 'any-company') {
  sql = sql.replace(`   where e.id = p_draft_id
     and e.company_entity_id = v_company;`, '   where e.id = p_draft_id;');
}

await db.exec(sql);
await db.exec(sql);   // apply_all_post_merge.sql re-runs it

// `set local test.grant = ...` will not parse (grant is a reserved word).
const asGrant = async (g) => db.exec(`select set_config('test.grant', '${g}', true)`);
const asPerson = async (uid) => db.exec(`select set_config('test.uid', '${uid}', true), set_config('test.grant', '', true)`);

// ── S · the scope ──────────────────────────────────────────────────────────
await check('S1 consent offers po_email:send', async () => {
  const def = await one(`select pg_get_functiondef(p.oid) d from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'silo_api_consent'`);
  assert.ok(def.d.includes("'po_email:send'"), 'the scope is not on the consent allowlist');
});

await check('S2 both tools have their own path', async () => {
  const def = await one(`select pg_get_functiondef(p.oid) d from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'silo_api_path_allowed'`);
  assert.ok(def.d.includes('/rpc/silo_api_po_emails_to_send'), 'the claim path is not allowed');
  assert.ok(def.d.includes('/rpc/silo_api_mark_po_email_sent'), 'the send path is not allowed');
  // and the ones that were already there are still there
  assert.ok(def.d.includes('/rpc/silo_api_set_po_status'), 'an existing path was dropped');
});

await check('S3 no browser role may call either tool', async () => {
  for (const role of ['anon', 'authenticated']) {
    for (const fn of ['silo_api_po_emails_to_send(integer, text)', 'silo_api_mark_po_email_sent(uuid, text)']) {
      const r = await one(`select has_function_privilege('${role}', 'public.${fn}', 'execute') ok`);
      assert.equal(r.ok, false, `${role} can execute ${fn}`);
    }
  }
  const r = await one(`select has_function_privilege('silo_integration', 'public.silo_api_po_emails_to_send(integer, text)', 'execute') ok`);
  assert.equal(r.ok, true, 'a connection cannot call the tool at all');
});

await check('S3b the write ledger accepts a PO-email claim', async () => {
  const c = await one(`select pg_get_constraintdef(oid) d from pg_constraint
    where conname = 'silo_api_writes_kind_check' and conrelid = 'public.silo_api_writes'::regclass`);
  assert.ok(c.d.includes('po_email_claim'),
    'the CHECK was not extended, so every claim fails on the write ledger in production');
  for (const kind of ['task', 'outreach_claim', 'code_created', 'shipment_receipt', 'po_status']) {
    assert.ok(c.d.includes(kind), `the CHECK was replaced and lost ${kind}`);
  }
});

// ── D · the drafted copy ───────────────────────────────────────────────────
await check('D1 the draft is built from the PO\'s own factors', async () => {
  await asPerson(U.adminA);
  const r = await one(`select public.po_vendor_email_draft('${PO.ready}') d`);
  const d = r.d;
  assert.equal(d.to_email, 'ana@incotexco.test');
  assert.equal(d.units, 1550);
  assert.equal(d.styles, 2);
  assert.ok(d.subject.includes('A-1150'), 'the subject names the PO');
  assert.ok(d.subject.includes('1,550 units'), 'and its units');
  assert.ok(d.body.includes('Hi Ana,'), 'it greets the factory contact');
  assert.ok(d.body.includes('22 Jan 2027'), 'it carries the requested ship date');
  assert.ok(d.body.includes('new product'), 'it says a sample is needed');
  assert.ok(d.body.includes('30/70'), 'it carries the payment terms');
  assert.ok(d.body.includes('A-1098'), 'it mentions the PO still open with that factory');
  assert.ok(d.body.includes('Use the new neck label.'), 'it carries the PO notes');
  assert.ok(d.body.includes('purchasing@a.test'), 'it signs off with the purchasing contact');
  assert.equal(d.attachment_filename, 'A-1150.pdf');
  assert.deepEqual(d.missing, []);
});

await check('D2 what is missing is named, not invented', async () => {
  await db.exec(`update factories set contact_email = null where id = '${FAC.a}'`);
  const r = await one(`select public.po_vendor_email_draft('${PO.ready}') d`);
  assert.equal(r.d.to_email, null);
  assert.ok(r.d.missing.includes('factory contact email'), 'the gap is reported');
  await db.exec(`update factories set contact_email = 'ana@incotexco.test' where id = '${FAC.a}'`);
});

// ── V · which step means "the factory has it" ─────────────────────────────
await check('V1 the send step is the flagged one, else the first open ai_settable step', async () => {
  let r = await one(`select public.po_vendor_send_step('${A}') s`);
  assert.equal(r.s, 'Sent to Factory', 'unflagged, it is the first open ai_settable step');
  await db.exec(`update po_status_options set is_vendor_send = true where company_entity_id = '${A}' and name = 'In Production'`);
  r = await one(`select public.po_vendor_send_step('${A}') s`);
  assert.equal(r.s, 'In Production', 'the flag wins, whatever the step is called');
  await db.exec(`update po_status_options set is_vendor_send = false where company_entity_id = '${A}'`);
  // A company with no open ai_settable step at all moves nothing.
  await db.exec(`update po_status_options set ai_settable = false where company_entity_id = '${B}'`);
  r = await one(`select public.po_vendor_send_step('${B}') s`);
  assert.equal(r.s, null, 'no step, so nothing to move a PO to');
  await db.exec(`update po_status_options set ai_settable = true where company_entity_id = '${B}' and name = 'Sent to Factory'`);
});

// ── Q · queueing is a person's act ────────────────────────────────────────
const queue = async (po, co = A, fac = FAC.a) => db.query(
  `insert into po_vendor_emails (company_entity_id, po_header_id, factory_id, to_email, subject, body, status)
   values ($1, $2, $3, 'ana@incotexco.test', 'A-1150', 'body text', 'queued') returning id`,
  [co, po, fac]);

// `set local role` only lasts a transaction, and a superuser bypasses RLS --
// so each of these runs AS the browser role, inside one.
const asBrowser = async (uid) => {
  await db.exec('begin');
  await db.exec(`set local role authenticated`);
  await db.exec(`select set_config('test.uid', '${uid}', true)`);
};

await check('Q1 a person queues an email for a PO they may change', async () => {
  await asBrowser(U.adminA);
  const r = await queue(PO.ready);
  assert.ok(r.rows[0].id, 'the admin could queue it');
  await db.exec('commit');
});

await check('Q2 a PO has only one live email at a time', async () => {
  await asBrowser(U.adminA);
  await refused(
    `insert into po_vendor_emails (company_entity_id, po_header_id, factory_id, to_email, subject, body, status)
     values ('${A}', '${PO.ready}', '${FAC.a}', 'ana@incotexco.test', 'again', 'body', 'queued')`,
    [], 'po_vendor_emails_one_live_per_po');
  await db.exec('rollback');
});

await check('Q3 someone who may not change that PO may not queue its email', async () => {
  await asBrowser(U.memberA);
  await refused(
    `insert into po_vendor_emails (company_entity_id, po_header_id, factory_id, to_email, subject, body, status)
     values ('${A}', '${PO.other}', '${FAC.a}', 'ana@incotexco.test', 'A-1098', 'body', 'queued')`,
    [], 'row-level security');
  await db.exec('rollback');
});

await check('Q4 an address without an @ is not an address', async () => {
  await asBrowser(U.adminA);
  await refused(
    `insert into po_vendor_emails (company_entity_id, po_header_id, factory_id, to_email, subject, body, status)
     values ('${A}', '${PO.other}', '${FAC.a}', 'not-an-address', 's', 'b', 'queued')`,
    [], 'po_vendor_emails_to_email_check');
  await db.exec('rollback');
});

// ── S · refusals before anything is taken ─────────────────────────────────
await check('S4 a connection without the scope takes nothing', async () => {
  await db.exec('begin');
  await asGrant(G.reads);
  await refused(`select public.silo_api_po_emails_to_send(10, 'k1')`, [], 'insufficient_scope');
  await db.exec('rollback');
});

await check('S5 a paused connection takes nothing', async () => {
  await db.exec('begin');
  await asGrant(G.paused);
  await refused(`select public.silo_api_po_emails_to_send(10, 'k2')`, [], 'writes_paused');
  await db.exec('rollback');
});

await check('S6 a signed-in person is not a connection', async () => {
  await db.exec('begin');
  await db.exec(`select set_config('test.grant', '', true)`);
  await refused(`select public.silo_api_po_emails_to_send(10, 'k3')`, [], 'insufficient_scope');
  await db.exec('rollback');
});

// ── C · the claim ─────────────────────────────────────────────────────────
let firstClaim = null;
await check('C1 the claim hands over the copy, mints a link, and spends one write', async () => {
  await db.exec('begin');
  await asGrant(G.mail);
  const r = await one(`select public.silo_api_po_emails_to_send(10, 'claim-1') j`);
  firstClaim = r.j;
  assert.equal(firstClaim.claimed.length, 1, 'one email was waiting');
  const c = firstClaim.claimed[0];
  assert.equal(c.to, 'ana@incotexco.test');
  assert.equal(c.subject, 'A-1150');
  assert.equal(c.attachment.filename, 'A-1150.pdf');
  assert.equal(c.attachment.media_type, 'application/pdf');
  assert.ok(/^\/functions\/v1\/po-document\?t=[0-9a-f]{32,}$/.test(c.attachment.url_path),
    `the attachment link is a path with a token, got ${c.attachment.url_path}`);
  assert.equal(firstClaim.moves_po_to, 'Sent to Factory', 'it says where the PO will go');
  assert.ok(firstClaim.next_step.includes('mark_po_email_sent'), 'it says what to do next');

  const row = await one(`select status, claimed_by_grant_id, claimed_by_app, doc_token_hash, doc_token_expires_at
                           from po_vendor_emails where id = $1`, [c.draft_id]);
  assert.equal(row.status, 'claimed');
  assert.equal(row.claimed_by_grant_id, G.mail);
  assert.ok(row.doc_token_expires_at, 'the link expires');

  const raw = c.attachment.url_path.split('t=')[1];
  assert.notEqual(row.doc_token_hash, raw, 'the RAW token is stored, so anyone reading the table could fetch the PO');

  const w = await rows(`select kind from silo_api_writes where grant_id = '${G.mail}'`);
  assert.equal(w.length, 1, 'exactly one write was spent');
  assert.equal(w[0].kind, 'po_email_claim');
  await db.exec('commit');
});

await check('C2 the same key replays instead of taking more, with a fresh link', async () => {
  await db.exec('begin');
  await asGrant(G.mail);
  const r = await one(`select public.silo_api_po_emails_to_send(10, 'claim-1') j`);
  assert.equal(r.j.replayed, true, 'it is the same claim');
  assert.equal(r.j.claimed.length, 1);
  assert.equal(r.j.claimed[0].draft_id, firstClaim.claimed[0].draft_id, 'the same email came back');
  assert.notEqual(r.j.claimed[0].attachment.url_path, firstClaim.claimed[0].attachment.url_path,
    'the link is re-minted');
  const w = await rows(`select 1 from silo_api_writes where grant_id = '${G.mail}'`);
  assert.equal(w.length, 1, 'a replay spends nothing');
  await db.exec('commit');
});

await check('C3 an empty queue says so rather than failing', async () => {
  await db.exec('begin');
  await asGrant(G.second);
  const r = await one(`select public.silo_api_po_emails_to_send(10, 'claim-x') j`);
  assert.equal(r.j.claimed.length, 0);
  assert.ok(String(r.j.note).includes('No purchase-order emails'), 'it points the person at SILO');
  await db.exec('commit');
});

await check('C4 the daily cap stops a claim', async () => {
  await db.exec('begin');
  await asGrant(G.mail);
  await db.exec(`select set_config('test.cap', '1', true)`);
  await db.exec(`insert into po_vendor_emails (company_entity_id, po_header_id, factory_id, to_email, subject, body, status)
                 values ('${A}', '${PO.other}', '${FAC.a}', 'ana@incotexco.test', 'A-1098', 'body', 'queued')`);
  await refused(`select public.silo_api_po_emails_to_send(10, 'claim-2')`, [], 'write_cap_reached');
  await db.exec('rollback');
});

// ── M · recording the send ────────────────────────────────────────────────
await check('M1 evidence is required', async () => {
  await db.exec('begin');
  await asGrant(G.mail);
  await refused(`select public.silo_api_mark_po_email_sent('${firstClaim.claimed[0].draft_id}', '  ')`, [], 'evidence_required');
  await db.exec('rollback');
});

await check('M2 only the connection that took it may record it', async () => {
  await db.exec('begin');
  await asGrant(G.second);
  await refused(`select public.silo_api_mark_po_email_sent('${firstClaim.claimed[0].draft_id}', 'msg-1')`, [], 'not_claimed');
  await db.exec('rollback');
});

await check('M3 another company\'s email does not exist to this connection', async () => {
  await db.exec('begin');
  await asGrant(G.otherCo);
  await refused(`select public.silo_api_mark_po_email_sent('${firstClaim.claimed[0].draft_id}', 'msg-1')`, [], 'unknown_draft');
  await db.exec('rollback');
});

await check('M4 the send is recorded, the PO moves on, and the link is retired', async () => {
  await db.exec('begin');
  await asGrant(G.mail);
  const r = await one(`select public.silo_api_mark_po_email_sent('${firstClaim.claimed[0].draft_id}', 'gmail-msg-1') j`);
  assert.equal(r.j.recorded, true);
  assert.equal(r.j.replayed, false);
  assert.equal(r.j.po_moved_to, 'Sent to Factory', 'the PO moved to the company\'s own step');

  const row = await one(`select status, sent_evidence, sent_via, doc_token_hash, doc_token_expires_at
                           from po_vendor_emails where id = $1`, [firstClaim.claimed[0].draft_id]);
  assert.equal(row.status, 'sent');
  assert.equal(row.sent_evidence, 'gmail-msg-1');
  assert.equal(row.doc_token_hash, null, 'the document link outlived the send');
  assert.equal(row.doc_token_expires_at, null);

  const po = await one(`select status from po_headers where id = '${PO.ready}'`);
  assert.equal(po.status, 'Sent to Factory');
  await db.exec('commit');
});

await check('M5 recording it again returns the first record', async () => {
  await db.exec('begin');
  await asGrant(G.mail);
  const r = await one(`select public.silo_api_mark_po_email_sent('${firstClaim.claimed[0].draft_id}', 'gmail-msg-2') j`);
  assert.equal(r.j.replayed, true);
  assert.equal(r.j.evidence, 'gmail-msg-1', 'the first evidence stands');
  const n = await rows(`select 1 from po_headers where id = '${PO.ready}' and status = 'Sent to Factory'`);
  assert.equal(n.length, 1);
  await db.exec('commit');
});

await check('M6 a sent email frees the PO for another one later', async () => {
  const r = await queue(PO.ready);
  assert.ok(r.rows[0].id, 'the PO can be emailed again once the last one is sent');
  await db.exec(`delete from po_vendor_emails where id = '${r.rows[0].id}'`);
});

// ── R · what a person reads afterwards ────────────────────────────────────
await check('R1 a person reads only their own company\'s queue', async () => {
  await db.exec(`insert into po_vendor_emails (company_entity_id, po_header_id, factory_id, to_email, subject, body, status)
                 values ('${B}', '${PO.theirs}', '${FAC.b}', 'them@b.test', 'B-900', 'body', 'queued')`);
  await asBrowser(U.adminA);
  const mine = await rows(`select company_entity_id from po_vendor_emails`);
  assert.ok(mine.length > 0, 'the person sees their own');
  assert.ok(mine.every((r) => r.company_entity_id === A), 'another company\'s queue leaked');
  await db.exec('rollback');
});

// ── the production check itself ───────────────────────────────────────────
await check('verify_v2_schema.sql\'s own check passes against this schema', async () => {
  // The block the drift check runs on production every day. Running it here
  // proves it parses and agrees with what the migration builds, rather than
  // meeting reality for the first time as a red workflow.
  const verify = await readFile(new URL('../../supabase/verify_v2_schema.sql', import.meta.url), 'utf8');
  const at = verify.indexOf("-- A purchase order emailed to its factory by the person's OWN AI");
  assert.ok(at > 0, 'the check is in verify_v2_schema.sql');
  const end = verify.indexOf('end as status;', at);
  const r = await one(verify.slice(at, end + 'end as status;'.length));
  assert.equal(r.status, 'ok', `verify says: ${r.status}`);
});

console.log(`\n${passed} checks passed`);
process.exit(0);
