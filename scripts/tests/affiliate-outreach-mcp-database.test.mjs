// scripts/tests/affiliate-outreach-mcp-database.test.mjs
//
// outreach:send (20261110093000) on real PostgreSQL (PGlite): a SILO AI
// connection takes affiliate outreach a person already APPROVED, sends it from
// the person's own mailbox (SILO sends nothing), and records each send.
//
// The four Affiliate Studio migrations run verbatim first, then this one,
// each twice (apply_all_post_merge.sql re-runs them). The developer-platform
// plumbing it builds on (grants, the scope gate, the write ledger) is a
// fixture with the live shapes.
//
// What this proves:
//   S  the scope: offered by consent, refused when not granted, its own paths
//   C  claim: approved email drafts of ONE active program, the grant's company
//      (never the session's), a working signup link whose hash alone is
//      stored, the affiliate record, "Via <app>" on the batch, one write per
//      draft, suppressed recipients skipped, drafts and other companies never
//   R  a retry with the same key returns the same drafts with fresh links,
//      revokes the first links, and spends nothing
//   L  the cap, a paused or revoked connection, and an approver who does not
//      manage affiliates
//   M  mark sent: only a draft this connection claimed, with evidence, as the
//      approver, tagged with the app; repeatable; refused after an opt-out
//   G  no client role can call the tools or their helpers
//
// Mutations (CI runs each and requires the suite to FAIL):
//   OUTREACH_MCP_MUTATION=session-company  the company follows the session
//   OUTREACH_MCP_MUTATION=no-manager-gate  any member's connection may claim
//   OUTREACH_MCP_MUTATION=drafts-too       unapproved drafts are claimed
//   OUTREACH_MCP_MUTATION=no-cap           the daily write cap is not checked
//   OUTREACH_MCP_MUTATION=no-claim-once    the same key claims a second batch
//   OUTREACH_MCP_MUTATION=mark-any         any exported draft may be marked
//   OUTREACH_MCP_MUTATION=ignore-pause     a paused connection still writes
//   OUTREACH_MCP_MUTATION=no-path          the claim path is not on the allowlist
//   OUTREACH_MCP_MUTATION=not-offered      consent does not offer the scope
//   OUTREACH_MCP_MUTATION=plain-token      the raw link is stored, not its hash
//   OUTREACH_MCP_MUTATION=authenticated    a signed-in browser may claim
//   OUTREACH_MCP_MUTATION=active-program   a paused program's drafts are claimed
//   OUTREACH_MCP_MUTATION=html-unescaped   the HTML version does not escape the draft
//   OUTREACH_MCP_MUTATION=html-no-button   the HTML button does not carry the signup link
//   OUTREACH_MCP_MUTATION=followup-by-prospect-only  a follow-up to a known email tries a second record
//   OUTREACH_MCP_MUTATION=followup-reopen-joined     an ended affiliate who had joined is reopened
//   OUTREACH_MCP_MUTATION=html-no-text-link          the email has no visible link under the button
//   OUTREACH_MCP_MUTATION=logo-not-passed            the claim does not pass the company logo to the email
//   OUTREACH_MCP_MUTATION=logo-any-folder            a stored logo may point at another company's folder
//   OUTREACH_MCP_MUTATION=logo-upload-any-folder     an owner may upload into another company's logo folder
//   OUTREACH_MCP_MUTATION=logo-upload-any-member     any member may upload the company logo
//
// Run:  npm ci --prefix scripts/tests/finance-db && node scripts/tests/affiliate-outreach-mcp-database.test.mjs
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUT = process.env.OUTREACH_MCP_MUTATION || '';
const db = new PGlite();
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}\n  ${err?.message || err}`);
    throw err;
  }
}

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const U = {
  ownerA:  '10000000-0000-0000-0000-000000000001',
  mgrA:    '10000000-0000-0000-0000-000000000002',
  memberA: '10000000-0000-0000-0000-000000000003',
  ownerB:  '10000000-0000-0000-0000-000000000005',
};
const CLIENT = '20000000-0000-0000-0000-000000000001';
const G = {
  send:    '30000000-0000-0000-0000-000000000001',  // mgrA, outreach:send
  other:   '30000000-0000-0000-0000-000000000002',  // ownerA, outreach:send (another connection)
  task:    '30000000-0000-0000-0000-000000000003',  // mgrA, work:write only
  member:  '30000000-0000-0000-0000-000000000004',  // memberA, outreach:send, not a manager
  paused:  '30000000-0000-0000-0000-000000000005',
  revoked: '30000000-0000-0000-0000-000000000006',
};

// ── Fixture ───────────────────────────────────────────────────────────────
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create role silo_integration; create role silo_revoked;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role, silo_integration;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create table auth.oauth_clients(id uuid primary key, client_name text, deleted_at timestamptz);
create function gen_random_uuid() returns uuid language sql as
  $$ select md5(random()::text || clock_timestamp()::text)::uuid $$;
create table entities(id uuid primary key, title text);
create table profiles(id uuid primary key, email text, is_active boolean not null default true,
  role text, department text, active_company_id uuid);
create table entity_memberships(entity_id uuid, user_id uuid, role text);
create function active_company_id() returns uuid language sql stable security definer as
  $$ select active_company_id from public.profiles where id = auth.uid() $$;
create function is_exec_or_owner() returns boolean language sql stable security definer as $$
  select exists (select 1 from public.profiles p
    left join public.entity_memberships em on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid() and p.is_active
      and (case when em.role is not null then em.role = 'owner_admin' else p.role = 'owner' end))
$$;
create function attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
create function refresh_chat_schema_catalog() returns void language sql as $$ select $$;
create table company_settings(company_entity_id uuid primary key, business_timezone text);
create function is_owner_admin_of_active_company() returns boolean language sql stable security definer as $$
  select exists (select 1 from public.entity_memberships em
    where em.user_id = auth.uid() and em.entity_id = public.active_company_id() and em.role = 'owner_admin') $$;
-- Storage as Supabase has it, for the logo bucket's policies.
create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
grant select, insert, update, delete on storage.objects to anon, authenticated;
create function storage.foldername(name text) returns text[] language sql immutable as
  $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
create function silo_company_timezone(p uuid) returns text language sql stable security definer as
  $$ select 'America/Los_Angeles' $$;
create table shopify_orders (
  id bigint generated by default as identity primary key,
  company_entity_id uuid not null, connection_id uuid, shop_domain text not null,
  order_id text not null, order_number text, source_name text, financial_status text,
  fulfillment_status text, cancelled_at timestamptz, cancel_reason text,
  customer_id text, customer_email text, customer_name text, currency text,
  subtotal_price numeric not null default 0, total_discounts numeric not null default 0,
  total_tax numeric not null default 0, total_shipping numeric not null default 0,
  total_price numeric not null default 0, tags text, location_id text,
  line_item_count integer not null default 0, shopify_created_at timestamptz,
  shopify_processed_at timestamptz, shopify_updated_at timestamptz,
  synced_at timestamptz, sync_batch_id text, created_at timestamptz not null default now(),
  unique (shop_domain, order_id));
create table sync_jobs (id uuid primary key default gen_random_uuid(), company_entity_id uuid,
  job_type text not null, status text,
  constraint sync_jobs_job_type_check check (job_type = any (array['shopify'::text])));

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
create function silo_api_app_key(p_client_id text) returns text language sql stable as
  $$ select 'app:' || coalesce(p_client_id, '') $$;
create function silo_api_app_connection_limit() returns integer language sql immutable as $$ select 3 $$;
create function silo_api_write_cap() returns integer language sql stable as
  $$ select coalesce(nullif(current_setting('test.cap', true), '')::integer, 50) $$;
create table silo_api_writes (
  id uuid primary key default gen_random_uuid(), company_entity_id uuid not null,
  grant_id uuid references silo_api_grants(id) on delete set null, user_id uuid,
  via text not null, kind text not null, target_id uuid, idempotency_key text,
  created_at timestamptz not null default now(),
  constraint silo_api_writes_kind_check check (kind in ('task')));
create function silo_api_consent(p_client_id text, p_scopes text[] default array['reports:read'])
returns uuid language plpgsql security definer set search_path = '' as $fn$
begin raise exception 'stub'; end $fn$;

grant all on all tables in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role, silo_integration;
`);

const files = {
  orders: '20261110083000_shopify_order_discount_codes.sql',
  core: '20261110084000_affiliate_studio.sql',
  ledger: '20261110085000_affiliate_studio_ledger.sql',
  portal: '20261110086000_affiliate_portal.sql',
  send: '20261110093000_affiliate_outreach_send_scope.sql',
  html: '20261110110000_affiliate_outreach_html.sql',
  followup: '20261110120000_affiliate_followup_outreach.sql',
  button: '20261110130000_affiliate_outreach_email_button.sql',
  logo: '20261110140000_company_logo.sql',
};
const sql = {};
for (const [k, f] of Object.entries(files)) {
  sql[k] = await readFile(new URL(`../../supabase/migrations/${f}`, import.meta.url), 'utf8');
}
function mutate(from, to) {
  // The claim tool is re-stated in the html migration (the live version), so
  // a guard is mutated wherever it appears.
  const hit = ['send', 'html', 'followup', 'button', 'logo'].filter((k) => sql[k].includes(from));
  assert.ok(hit.length, `mutation ${MUT}: pattern not found`);
  for (const k of hit) sql[k] = sql[k].split(from).join(to);
}
switch (MUT) {
  case '': break;
  case 'logo-not-passed':
    mutate("'html', public.affiliate_outreach_html(v_brand, v_d.body, v_link ->> 'url', v_logo),",
      "'html', public.affiliate_outreach_html(v_brand, v_d.body, v_link ->> 'url', null),"); break;
  case 'logo-any-folder':
    mutate("|| company_entity_id::text || '/logo-", "|| '[0-9a-f-]{36}' || '/logo-"); break;
  case 'logo-upload-any-folder':
    mutate(`  with check (
    bucket_id = 'company-logos'
    and (storage.foldername(name))[1] = public.active_company_id()::text
    and public.is_owner_admin_of_active_company());`, `  with check (
    bucket_id = 'company-logos'
    and public.is_owner_admin_of_active_company());`); break;
  case 'logo-upload-any-member':
    mutate(`  with check (
    bucket_id = 'company-logos'
    and (storage.foldername(name))[1] = public.active_company_id()::text
    and public.is_owner_admin_of_active_company());`, `  with check (
    bucket_id = 'company-logos'
    and (storage.foldername(name))[1] = public.active_company_id()::text);`); break;
  case 'session-company':
    mutate('  v_company := v_grant.company_entity_id;\n',
      '  v_company := coalesce(public.active_company_id(), v_grant.company_entity_id);\n'); break;
  case 'no-manager-gate':
    mutate('  if not public.affiliate_can_manage_for(v_grant.user_id, v_grant.company_entity_id) then', '  if false then'); break;
  case 'drafts-too':
    mutate("             else d.state = 'approved'", "             else d.state in ('approved', 'draft')"); break;
  case 'no-cap':
    mutate('    if v_room <= 0 then', '    v_room := 25;\n    if false then'); break;
  case 'no-claim-once':
    mutate(`create unique index if not exists affiliate_outreach_batches_claim_once
  on public.affiliate_outreach_batches (created_by_grant_id, idempotency_key)
  where created_by_grant_id is not null and idempotency_key is not null;`, '');
    mutate(`    on conflict (created_by_grant_id, idempotency_key)
      where created_by_grant_id is not null and idempotency_key is not null
      do nothing
`, '');
    mutate('    v_replay := v_batch is not null;', '    v_replay := false;'); break;
  case 'mark-any':
    mutate(" or v_d.created_by_grant_id is distinct from v_grant.id then", ' then'); break;
  case 'ignore-pause':
    mutate('  if v_grant.writes_paused_at is not null then', '  if false then'); break;
  case 'no-path':
    mutate("    '/rpc/silo_api_claim_outreach',\n", ''); break;
  case 'not-offered':
    mutate("array['reports:read', 'data:read', 'work:write', 'outreach:send']", "array['reports:read', 'data:read', 'work:write']"); break;
  case 'plain-token':
    mutate("    encode(sha256(convert_to(v_raw, 'UTF8')), 'hex'),", '    v_raw,'); break;
  case 'authenticated':
    mutate('grant execute on function public.silo_api_claim_outreach(uuid, integer, text) to silo_integration;',
      'grant execute on function public.silo_api_claim_outreach(uuid, integer, text) to silo_integration, authenticated;'); break;
  case 'active-program':
    mutate("         and pr.status = 'active'\n       order by d.approved_at", '       order by d.approved_at');
    mutate("       and d.program_id = v_program\n", "       and (d.program_id = v_program or true)\n"); break;
  case 'html-unescaped':
    mutate("  v_esc := replace(replace(replace(replace(v_body, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '\"', '&quot;');",
      '  v_esc := v_body;'); break;
  case 'html-no-button':
    mutate("'html', public.affiliate_outreach_html(v_brand, v_d.body, v_link ->> 'url'",
      "'html', public.affiliate_outreach_html(v_brand, v_d.body, ''"); break;
  case 'followup-by-prospect-only':
    mutate("  if v_aff is null then\n    select a.id, a.status, a.terms_accepted_at into v_aff, v_status, v_accepted", "  if false then\n    select a.id, a.status, a.terms_accepted_at into v_aff, v_status, v_accepted"); break;
  case 'followup-reopen-joined':
    mutate("    if v_accepted is not null then\n      raise exception 'ended_affiliate", "    if false then\n      raise exception 'ended_affiliate"); break;
  case 'html-no-text-link':
    mutate("    || '<p style=\"margin:0 0 18px;font-size:12px;line-height:1.5;color:#77828d\">Or open this link: '\n    || '<a href=\"' || v_url || '\" target=\"_blank\" style=\"color:#2f5fd0;word-break:break-all\">' || v_url || '</a></p>'\n", ''); break;
  default: throw new Error(`unknown mutation ${MUT}`);
}
for (const k of ['orders', 'core', 'ledger', 'portal', 'send', 'html', 'followup', 'button', 'logo']) {
  await db.exec(sql[k]);
  await db.exec(sql[k]);
}

const one = async (q, p = []) => (await db.query(q, p)).rows[0];
const all = async (q, p = []) => (await db.query(q, p)).rows;
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// ── Identities and data ───────────────────────────────────────────────────
await db.exec(`
insert into entities values ('${A}','Brand A'),('${B}','Brand B');
insert into auth.users values ${Object.values(U).map((u) => `('${u}')`).join(',')};
insert into profiles(id,email,role,active_company_id) values
  ('${U.ownerA}','owner@a.test','owner','${A}'), ('${U.mgrA}','mgr@a.test','member','${B}'),
  ('${U.memberA}','member@a.test','member','${A}'), ('${U.ownerB}','owner@b.test','owner','${B}');
insert into entity_memberships values
  ('${A}','${U.ownerA}','owner_admin'), ('${A}','${U.mgrA}','admin'), ('${B}','${U.mgrA}','owner_admin'),
  ('${A}','${U.memberA}','member'), ('${B}','${U.ownerB}','owner_admin');
insert into auth.oauth_clients values ('${CLIENT}', 'Claude', null);
insert into silo_api_grants(id, client_id, app_key, user_id, company_entity_id, scopes, revoked_at, writes_paused_at) values
  ('${G.send}',    '${CLIENT}', 'claude|', '${U.mgrA}',    '${A}', array['data:read','outreach:send'], null, null),
  ('${G.other}',   '${CLIENT}', 'claude|', '${U.ownerA}',  '${A}', array['outreach:send'], null, null),
  ('${G.task}',    '${CLIENT}', 'claude|', '${U.mgrA}',    '${A}', array['data:read','work:write'], null, null),
  ('${G.member}',  '${CLIENT}', 'claude|', '${U.memberA}', '${A}', array['outreach:send'], null, null),
  ('${G.paused}',  '${CLIENT}', 'claude|', '${U.mgrA}',    '${A}', array['outreach:send'], null, now()),
  ('${G.revoked}', '${CLIENT}', 'claude|', '${U.mgrA}',    '${A}', array['outreach:send'], now(), null);
`);
// mgrA manages affiliates in A by grant (not exec there). Their ACTIVE
// company is B, where they are owner -- so a tool that followed the session
// would act on B.
const prog = async (company, slug, status) => (await one(
  `insert into affiliate_programs(company_entity_id,name,slug,status,commission_percent,currency,terms_markdown)
   values ($1,$2,$3,$4,10,'USD','Be nice.') returning id`, [company, `${slug} program`, slug, status])).id;
const progA = await prog(A, 'creators', 'active');
const progPaused = await prog(A, 'resting', 'paused');
const progB = await prog(B, 'creators', 'active');
await db.query('insert into affiliate_program_managers(company_entity_id,user_id) values ($1,$2)', [A, U.mgrA]);

let n = 0;
async function draft(company, program, email, { state = 'approved', handle = null, body } = {}) {
  n += 1;
  const p = (await one(
    `insert into affiliate_prospects(company_entity_id, program_id, display_name, platform, handle, profile_url, contact_email, status)
     values ($1,$2,$3,'youtube',$4,$5,$6,'approved') returning id`,
    [company, program, `Creator ${n}`, handle || `@creator${n}`, `https://youtube.com/@creator${n}`, email])).id;
  const d = (await one(
    `insert into affiliate_outreach_drafts(company_entity_id, program_id, prospect_id, recipient_email, subject, body)
     values ($1,$2,$3,$4,'Join us', $5) returning id`,
    [company, program, p, email, body ?? 'Hi, join here: {signup_link}\nThanks'])).id;
  if (state !== 'draft') {
    await db.query(`update affiliate_outreach_drafts set state = 'approved', approved_by = $1, approved_at = now() - ($2 || ' minutes')::interval where id = $3`,
      [U.ownerA, String(100 - n), d]);
  }
  return { p, d };
}
const d1 = await draft(A, progA, 'One@Creator.test');
const d2 = await draft(A, progA, 'two@creator.test', { body: 'No placeholder here.' });
const dSupp = await draft(A, progA, 'stop@creator.test');
const dDraft = await draft(A, progA, 'notyet@creator.test', { state: 'draft' });
const dPaused = await draft(A, progPaused, 'paused@creator.test');
const dB = await draft(B, progB, 'b@creator.test');
await db.query(`insert into affiliate_suppressions(company_entity_id, kind, value_normalized, reason) values ($1,'email','stop@creator.test','opted_out')`, [A]);

/* One tool call as PostgREST makes it: the integration role, the grant's
   person as auth.uid(), the request path. */
async function tool(fn, args, { grant = G.send, uid = U.mgrA, path = `/rpc/${fn}`, role = 'silo_integration' } = {}) {
  await db.exec('reset role');
  await db.exec(`select set_config('test.grant_id', '${grant}', false), set_config('test.integration', 'on', false),
    set_config('test.uid', '${uid}', false), set_config('request.path', '${path}', false);`);
  await db.exec(`set role ${role}`);
  try {
    const r = await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as r`, args);
    return r.rows[0].r;
  } finally {
    await db.exec('reset role');
    await db.exec(`select set_config('test.integration', 'off', false), set_config('test.uid', '', false);`);
  }
}
const claim = (args = [null, 10, null], o) => tool('silo_api_claim_outreach', args, o);
const mark = (args, o) => tool('silo_api_mark_outreach_sent', args, o);

// ── S: the scope ──────────────────────────────────────────────────────────
await check('S1 consent offers outreach:send and still refuses a scope it does not know', async () => {
  await db.exec(`select set_config('test.uid', '${U.mgrA}', false),
    set_config('test.claims', '{"aal":"aal2"}', false), set_config('test.integration', 'off', false)`);
  await db.query('update profiles set active_company_id = $1 where id = $2', [A, U.mgrA]);
  const id = (await one(`select public.silo_api_consent('consent-only-client', array['reports:read','outreach:send']) as id`)).id;
  const g = await one('select scopes from silo_api_grants where id = $1', [id]);
  assert.deepEqual([...g.scopes].sort(), ['outreach:send', 'reports:read']);
  await assert.rejects(db.query(`select public.silo_api_consent('consent-only-client', array['outreach:blast'])`), /unknown_scope/);
  await db.query('update profiles set active_company_id = $1 where id = $2', [B, U.mgrA]);
  await db.exec(`select set_config('test.uid', '', false), set_config('test.claims', '', false)`);
});

await check('S2 both tools are on the API path allowlist, and nothing else was added', async () => {
  for (const path of ['/rpc/silo_api_claim_outreach', '/rpc/silo_api_mark_outreach_sent', '/rpc/silo_api_create_task']) {
    await db.exec(`select set_config('request.path', '${path}', false)`);
    assert.equal((await one('select public.silo_api_path_allowed() as v')).v, true, path);
  }
  for (const path of ['/rpc/affiliate_outreach_mint_signup', '/rpc/affiliate_can_manage_for', '/rpc/silo_api_outreach_grant']) {
    await db.exec(`select set_config('request.path', '${path}', false)`);
    assert.equal((await one('select public.silo_api_path_allowed() as v')).v, false, path);
  }
});

await check('S3 a connection without outreach:send is refused, even one that may open tasks', async () => {
  await assert.rejects(claim(undefined, { grant: G.task }), /insufficient_scope/);
  await assert.rejects(mark([d1.d, 'x'], { grant: G.task }), /insufficient_scope/);
});

// ── L: who may use it at all ──────────────────────────────────────────────
await check('L1 a paused, a revoked, and a non-manager connection claim nothing', async () => {
  await assert.rejects(claim(undefined, { grant: G.paused }), /writes_paused/);
  await assert.rejects(claim(undefined, { grant: G.revoked }), /integration_revoked/);
  await assert.rejects(claim(undefined, { grant: G.member, uid: U.memberA }), /not_an_affiliate_manager/);
  const st = await all(`select state from affiliate_outreach_drafts where company_entity_id = $1 and state <> 'approved' and state <> 'draft'`, [A]);
  assert.deepEqual(st, [], 'and nothing moved');
});

// ── C: claim ──────────────────────────────────────────────────────────────
let first;
await check('C1 claims the approved emails of one active program in the GRANT\'s company', async () => {
  first = await claim([null, 10, 'run-1']);
  const ids = first.claimed.map((c) => c.draft_id).sort();
  assert.deepEqual(ids, [d1.d, d2.d].sort(), 'approved, emailable, unsuppressed, this program only');
  assert.equal(first.program_id, progA);
  assert.equal(first.replayed, false);
  assert.equal(first.via, 'Claude');
  assert.ok(!ids.includes(dB.d) && !ids.includes(dDraft.d) && !ids.includes(dPaused.d));
  assert.deepEqual(first.skipped.map((x) => x.draft_id), [dSupp.d],
    'other programs\' and unapproved drafts are never even looked at; only the suppressed one is reported');
  const bState = await one('select state from affiliate_outreach_drafts where id = $1', [dB.d]);
  assert.equal(bState.state, 'approved', 'the session\'s own company (B) is untouched');
});

await check('C2 each message carries a working personal link, and only its hash is stored', async () => {
  const c1 = first.claimed.find((c) => c.draft_id === d1.d);
  const m = /^https:\/\/get-silo\.com\/v2\/affiliates\/join\.html\?t=([0-9a-f]{64})$/.exec(c1.signup_url);
  assert.ok(m, c1.signup_url);
  assert.match(m[1], /^[A-Za-z0-9_-]{32,128}$/, 'inside the portal\'s token pattern');
  assert.equal(c1.to, 'one@creator.test');
  assert.equal(c1.body, `Hi, join here: ${c1.signup_url}\nThanks`, 'the placeholder is filled');
  const c2 = first.claimed.find((c) => c.draft_id === d2.d);
  assert.ok(c2.body.endsWith(`\n\n${c2.signup_url}`), 'a template without the placeholder still carries the link');
  const tok = await one(`select t.token_hash, t.purpose, t.expires_at > now() + interval '13 days' as long_enough
    from affiliate_access_tokens t join affiliate_outreach_drafts d on d.token_id = t.id where d.id = $1`, [d1.d]);
  assert.equal(tok.purpose, 'signup');
  assert.equal(tok.token_hash, sha(m[1]), 'the portal resolves the link by its SHA-256');
  assert.ok(tok.long_enough);
  const raw = await one(`select count(*)::int as n from affiliate_access_tokens where token_hash = $1`, [m[1]]);
  assert.equal(raw.n, 0, 'the raw token is stored nowhere');
});

await check('C2b each message also comes as branded HTML with the link as a button', async () => {
  const c1 = first.claimed.find((c) => c.draft_id === d1.d);
  assert.ok(c1.html.includes('>Brand A</td>'), 'the company name heads the email');
  const btn = `<a href="${c1.signup_url}"`;
  assert.equal(c1.html.split(btn).length - 1, 2, 'a button and a text link, both to this person\'s own link, and no other');
  assert.ok(c1.html.includes('See the program and join &rarr;</a>'));
  assert.ok(/<td bgcolor="#14181d"[^>]*><a href=/.test(c1.html), 'the button is an email-safe table cell, not a bare styled link');
  assert.ok(c1.html.includes(`Or open this link: ${btn}`) && c1.html.includes(`>${c1.signup_url}</a>`),
    'the link is also shown as text, so a client that drops the button still leaves it visible');
  assert.ok(c1.html.includes('Hi, join here: </p>') && c1.html.includes('>Thanks</p>'), 'the approved words, around the button');
  assert.ok(!c1.html.includes('{signup_link}'));
  const c2 = first.claimed.find((c) => c.draft_id === d2.d);
  assert.equal(c2.html.split(`<a href="${c2.signup_url}"`).length - 1, 2, 'a template without the placeholder gets the button at the end');
  assert.ok(/body/.test(first.next_step) && /html/.test(first.next_step), 'next_step says to send both versions');
  const x = await one(`select public.affiliate_outreach_html('A & <B>', $1, 'https://get-silo.com/v2/affiliates/join.html?t=ab') as h`,
    ['Hi <script>alert(1)</script> "x" & y\n\nJoin: {signup_link}']);
  assert.ok(!x.h.includes('<script>') && x.h.includes('&lt;script&gt;alert(1)&lt;/script&gt; &quot;x&quot; &amp; y'),
    'the draft is escaped, so a message can never inject markup');
  assert.ok(x.h.includes('>A &amp; &lt;B&gt;</td>'), 'the company name is escaped too');
});

await check('C3 the rows say which connection, and the invited affiliate exists', async () => {
  const b = await one('select created_by_grant_id, created_by_app, row_count, exported_by, idempotency_key from affiliate_outreach_batches where id = $1', [first.batch_id]);
  assert.deepEqual(b, { created_by_grant_id: G.send, created_by_app: 'Claude', row_count: 2, exported_by: U.mgrA, idempotency_key: 'run-1' });
  const d = await one('select state, batch_id, changed_by from affiliate_outreach_drafts where id = $1', [d1.d]);
  assert.deepEqual(d, { state: 'exported', batch_id: first.batch_id, changed_by: U.mgrA });
  const a = await one(`select a.status, a.contact_email, p.status as prospect_status from affiliates a
    join affiliate_prospects p on p.affiliate_id = a.id where p.id = $1`, [d1.p]);
  assert.deepEqual(a, { status: 'invited', contact_email: 'one@creator.test', prospect_status: 'invited' });
  const w = await all(`select kind, target_id from silo_api_writes where grant_id = $1 order by target_id`, [G.send]);
  assert.deepEqual(w.map((x) => x.kind), ['outreach_claim', 'outreach_claim'], 'one write per message handed over');
});

await check('C4 a suppressed recipient is skipped with its reason and stays approved', async () => {
  const s = first.skipped.find((x) => x.draft_id === dSupp.d);
  assert.ok(s, JSON.stringify(first.skipped));
  assert.equal(s.reason, 'suppressed');
  assert.equal((await one('select state from affiliate_outreach_drafts where id = $1', [dSupp.d])).state, 'approved');
  assert.equal((await one('select count(*)::int as n from affiliates where from_prospect_id = $1', [dSupp.p])).n, 0,
    'and no affiliate record was left behind');
});

await check('C5 a program that is not active is refused by name, and an unknown one too', async () => {
  await assert.rejects(claim([progPaused, 10, null]), /program_not_active/);
  await assert.rejects(claim([progB, 10, null]), /unknown_program/, 'another company\'s program is not visible');
});

// ── R: retry ──────────────────────────────────────────────────────────────
await check('R1 the same key returns the same drafts with fresh links and spends nothing', async () => {
  const before = (await one('select count(*)::int as n from silo_api_writes where grant_id = $1', [G.send])).n;
  const oldTok = (await one('select token_id from affiliate_outreach_drafts where id = $1', [d1.d])).token_id;
  // More approved drafts arrive; a retry must not pick them up.
  await draft(A, progA, 'late@creator.test');
  const again = await claim([null, 10, 'run-1']);
  assert.equal(again.replayed, true);
  assert.equal(again.batch_id, first.batch_id);
  assert.deepEqual(again.claimed.map((c) => c.draft_id).sort(), first.claimed.map((c) => c.draft_id).sort());
  const c1 = again.claimed.find((c) => c.draft_id === d1.d);
  assert.notEqual(c1.signup_url, first.claimed.find((c) => c.draft_id === d1.d).signup_url);
  const old = await one('select revoked_at is not null as revoked from affiliate_access_tokens where id = $1', [oldTok]);
  assert.equal(old.revoked, true, 'the lost link no longer works');
  const after = (await one('select count(*)::int as n from silo_api_writes where grant_id = $1', [G.send])).n;
  assert.equal(after, before);
});

// ── L2: the cap ───────────────────────────────────────────────────────────
await check('L2 the daily cap stops a claim, and a claim never takes more than is left', async () => {
  const used = (await one('select count(*)::int as n from silo_api_writes where grant_id = $1', [G.send])).n;
  await db.exec(`select set_config('test.cap', '${used}', false)`);
  await assert.rejects(claim([null, 10, 'run-2']), /write_cap_reached/);
  await draft(A, progA, 'later@creator.test');
  await db.exec(`select set_config('test.cap', '${used + 1}', false)`);
  const r = await claim([null, 10, 'run-3']);
  assert.equal(r.claimed.length, 1, 'one write left, one email');
  await db.exec(`select set_config('test.cap', '', false)`);
});

// ── M: mark sent ──────────────────────────────────────────────────────────
await check('M1 marking sent needs evidence, and records the approver and the app', async () => {
  await assert.rejects(mark([d1.d, '  ']), /evidence_required/);
  const r = await mark([d1.d, 'gmail:18c2f0a9']);
  assert.deepEqual(r, { draft_id: d1.d, state: 'sent', replayed: false, evidence: 'gmail:18c2f0a9', via: 'Claude' });
  const d = await one('select state, sent_marked_by, sent_evidence, sent_by_grant_id, sent_via_app from affiliate_outreach_drafts where id = $1', [d1.d]);
  assert.deepEqual(d, { state: 'sent', sent_marked_by: U.mgrA, sent_evidence: 'gmail:18c2f0a9', sent_by_grant_id: G.send, sent_via_app: 'Claude' });
  const again = await mark([d1.d, 'gmail:other']);
  assert.equal(again.replayed, true);
  assert.equal(again.evidence, 'gmail:18c2f0a9', 'a repeat returns the first record and changes nothing');
});

await check('M2 only a draft THIS connection claimed can be marked by it', async () => {
  await assert.rejects(mark([d2.d, 'gmail:1'], { grant: G.other, uid: U.ownerA }), /not_claimed_here/,
    'another connection\'s claim');
  // A person exported one by hand.
  const { d } = await draft(A, progA, 'byhand@creator.test');
  const batch = (await one(`insert into affiliate_outreach_batches(company_entity_id, program_id, row_count, exported_at, exported_by)
    values ($1,$2,1,now(),$3) returning id`, [A, progA, U.ownerA])).id;
  await db.query(`update affiliate_outreach_drafts set state = 'exported', batch_id = $1, exported_at = now() where id = $2`, [batch, d]);
  await assert.rejects(mark([d, 'gmail:2']), /not_claimed_here/, 'a spreadsheet export');
  await assert.rejects(mark([dDraft.d, 'gmail:3']), /not_claimed_here/, 'an unapproved draft');
  await assert.rejects(mark([dB.d, 'gmail:4']), /unknown_draft/, 'another company\'s draft');
});

await check('M3 an opt-out that arrived after the claim refuses the record', async () => {
  await db.query(`insert into affiliate_suppressions(company_entity_id, kind, value_normalized, reason) values ($1,'email','two@creator.test','opted_out')`, [A]);
  await assert.rejects(mark([d2.d, 'gmail:5']), /suppression list/);
  assert.equal((await one('select state from affiliate_outreach_drafts where id = $1', [d2.d])).state, 'exported');
});

// ── G: grants ─────────────────────────────────────────────────────────────
await check('F1 a follow-up to an email the program already has reuses that record, and reopens an ended invite', async () => {
  const aff = (await one(`select a.id from affiliates a join affiliate_outreach_drafts d on d.prospect_id = a.from_prospect_id where d.id = $1`, [d1.d])).id;
  // A second prospect row for the same person (another channel), approved.
  const p2 = (await one(`insert into affiliate_prospects(company_entity_id, program_id, display_name, platform, handle, profile_url, contact_email, status)
    values ($1,$2,'Again','instagram','@again',null,'ONE@creator.test','approved') returning id`, [A, progA])).id;
  const mint = (p) => one(`select public.affiliate_outreach_mint_signup($1,$2,$3,'one@creator.test',$4) as r`, [A, progA, p, U.ownerA]);
  const r1 = (await mint(p2)).r;
  assert.equal(r1.affiliate_id, aff, 'the existing record for that email is reused, not duplicated');
  assert.equal((await one(`select count(*)::int as n from affiliates where program_id = $1 and lower(contact_email) = 'one@creator.test'`, [progA])).n, 1);
  await db.query(`update affiliates set status = 'terminated' where id = $1`, [aff]);
  const r2 = (await mint(p2)).r;
  assert.equal(r2.affiliate_id, aff);
  assert.equal((await one('select status from affiliates where id = $1', [aff])).status, 'invited', 'an ended invite is reopened');
  await db.query(`update affiliates set status = 'active', terms_accepted_at = now(), terms_version_accepted = 1 where id = $1`, [aff]);
  await assert.rejects(mint(p2), /already_affiliate/, 'an active affiliate gets no signup link');
  await db.query(`update affiliates set status = 'terminated' where id = $1`, [aff]);
  await assert.rejects(mint(p2), /ended_affiliate/, 'someone who joined and was ended is not reopened');
});

await check('B1 the company logo, when its owner set one, replaces the initial badge in the email', async () => {
  const host = 'https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/company-logos';
  const good = `${host}/${A}/logo-1762758000000.png`;
  await db.query(`insert into company_settings(company_entity_id, business_timezone) values ($1,'America/Los_Angeles'),($2,'America/Los_Angeles') on conflict do nothing`, [A, B]);
  for (const bad of [`${host}/${B}/logo-1762758000000.png`, `https://evil.test/storage/v1/object/public/company-logos/${A}/logo-1762758000000.png`,
    `${host}/${A}/logo-1762758000000.svg`, `http://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/company-logos/${A}/logo-1762758000000.png`]) {
    await assert.rejects(db.query('update company_settings set logo_url = $1 where company_entity_id = $2', [bad, A]),
      /company_settings_logo_url_check/, `refused: ${bad}`);
  }
  await db.query('update company_settings set logo_url = $1 where company_entity_id = $2', [good, A]);
  const dl = await draft(A, progA, 'logo@creator.test');
  const r = await claim([progA, 10, 'logo-key']);
  const c = r.claimed.find((x) => x.draft_id === dl.d);
  assert.ok(c, 'the new draft was claimed');
  assert.ok(c.html.includes(`<img src="${good}" height="36" alt="Brand A"`), 'the logo heads the email, with the name as its alt text');
  assert.ok(!c.html.includes('bgcolor="#14181d" style="background:#14181d;border-radius:8px;color:#ffffff'), 'and the initial badge is gone');
  assert.ok(c.html.includes('>Brand A</td>'), 'the name still shows next to it');
  const x = await one(`select public.affiliate_outreach_html('A', 'Hi', 'https://x.test/j', 'https://evil.test/p.png"onerror="x') as h`);
  assert.ok(!x.h.includes('<img') && !x.h.includes('evil.test'), 'an address that is not a logo in the bucket is never used');
  await db.query('update company_settings set logo_url = null where company_entity_id = $1', [A]);
});

await check('B2 only an owner of the active company uploads its logo, and only into its own folder', async () => {
  const up = async (uid, name) => {
    await db.exec(`select set_config('test.uid', '${uid}', false)`);
    await db.exec('set role authenticated');
    try { await db.query(`insert into storage.objects(bucket_id, name) values ('company-logos', $1)`, [name]); }
    finally { await db.exec('reset role'); await db.exec(`select set_config('test.uid', '', false)`); }
  };
  await up(U.ownerA, `${A}/logo-1762758000001.png`);
  await assert.rejects(up(U.ownerA, `${B}/logo-1762758000002.png`), /row-level security/, 'not into another company\'s folder');
  await assert.rejects(up(U.memberA, `${A}/logo-1762758000003.png`), /row-level security/, 'a member cannot change the logo');
  const b = await one(`select public, allowed_mime_types from storage.buckets where id = 'company-logos'`);
  assert.equal(b.public, true, 'public, so email clients and the join page can show it');
  assert.ok(!b.allowed_mime_types.some((m) => /svg/.test(m)), 'no SVG, which can carry script');
});

await check('G1 no browser or anonymous role can call the tools or their helpers', async () => {
  const fns = [
    'silo_api_claim_outreach(uuid, integer, text)', 'silo_api_mark_outreach_sent(uuid, text)',
    'affiliate_can_manage_for(uuid, uuid)', 'silo_api_app_name(text, text)', 'silo_api_outreach_grant()',
    'affiliate_outreach_mint_signup(uuid, uuid, uuid, text, uuid)', 'affiliate_outreach_html(text, text, text)',
    'affiliate_outreach_html(text, text, text, text)'];
  for (const f of fns) {
    for (const role of ['anon', 'authenticated', 'silo_revoked']) {
      assert.equal((await one(`select has_function_privilege('${role}', 'public.${f}', 'execute') as v`)).v, false, `${role} ${f}`);
    }
  }
  for (const f of fns.slice(2)) {
    assert.equal((await one(`select has_function_privilege('silo_integration', 'public.${f}', 'execute') as v`)).v, false,
      `helpers trust their arguments, so a connection may not call ${f}`);
  }
  for (const f of fns.slice(0, 2)) {
    assert.equal((await one(`select has_function_privilege('silo_integration', 'public.${f}', 'execute') as v`)).v, true, f);
  }
});

await check('G2 the tools are VOLATILE, or PostgREST runs them read-only', async () => {
  const r = await all(`select proname, provolatile from pg_proc where proname in ('silo_api_claim_outreach','silo_api_mark_outreach_sent') order by 1`);
  assert.deepEqual(r.map((x) => x.provolatile), ['v', 'v']);
});

console.log(`\n${passed} checks passed${MUT ? ` (mutation ${MUT} did not fail -- the suite is not testing it)` : ''}`);
