// scripts/tests/affiliate-studio-database.test.mjs
//
// Affiliate Studio's database (20261110083000, 084000, 085000, 086000, 190000) on real
// PostgreSQL (PGlite). Every migration is EXECUTED verbatim, twice, because
// apply_all_post_merge.sql re-runs them. Supabase's default grants are
// emulated BEFORE the migrations run, so every revoke they rely on is tested
// rather than assumed.
//
// What this proves, by section:
//   A  tenant isolation: company A never reads or writes company B's rows
//   B  authority: read / manage / money are three different gates
//   C  link tokens are invisible to every client role, and the portal
//      functions are service-role only
//   D  suppression outranks outreach approval, with one normalisation
//   E  outreach "sent" cannot be recorded without a person and evidence
//   F  one code cannot earn for two affiliates over overlapping dates
//   G  attribution: precedence, windows, grace, currency, unmeasured refunds,
//      cancelled orders, case folding, zero-decimal currency, business-day
//      timezone, idempotence, and no cross-program takeover
//   H  accrual: percent and fixed, idempotent, refund adjustments (including
//      after payout), inactive affiliates, unknown bases, append-only ledger
//   I  period approval is the money gate, enforced by trigger
//   J  payouts: refund hold, review gate, single claim per entry, manual-only
//      payment recording, void releases claims, negative balances
//   K  the affiliate portal: unknown/expired tokens, stale terms, idempotent
//      acceptance, statement contains no order ids, open vs invite-only
//      intake, suppression on applications, cross-company token minting
//
// Mutations (CI runs each and requires the suite to FAIL):
//   AFFILIATE_DB_MUTATION=anyemail      the brand menu matches records on any email, not the one on file
//   AFFILIATE_DB_MUTATION=mailedonly    the brand menu answers a portal token its requester holds
//   AFFILIATE_DB_MUTATION=rls           RLS left off affiliate_attributions
//   AFFILIATE_DB_MUTATION=company       programs select policy without the company filter
//   AFFILIATE_DB_MUTATION=gate          can_manage_affiliate_programs() is true for anyone
//   AFFILIATE_DB_MUTATION=moneygate     period approval accepts the manager gate
//   AFFILIATE_DB_MUTATION=uniqueorder   attributions are not unique per order
//   AFFILIATE_DB_MUTATION=crossprogram  a second program's run takes over an order
//   AFFILIATE_DB_MUTATION=appendonly    the ledger append-only trigger is gone
//   AFFILIATE_DB_MUTATION=evidence      "sent" no longer needs evidence
//   AFFILIATE_DB_MUTATION=suppression   suppressed recipients can be approved
//   AFFILIATE_DB_MUTATION=tokenread     authenticated may read token hashes
//   AFFILIATE_DB_MUTATION=clamp         a refund larger than the subtotal goes negative
//   AFFILIATE_DB_MUTATION=hold          positive entries are payable inside the refund hold
//   AFFILIATE_DB_MUTATION=manualonly    a non-manual payout can be recorded as paid
//   AFFILIATE_DB_MUTATION=minor         zero-decimal currencies are multiplied by 100
//   AFFILIATE_DB_MUTATION=overlap       one code may earn for two affiliates at once
//   AFFILIATE_DB_MUTATION=staleterms    acceptance of a superseded terms version
//   AFFILIATE_DB_MUTATION=portalgrant   authenticated may execute a portal function
//   AFFILIATE_DB_MUTATION=periodguard   a manager may approve a period with a plain UPDATE
//   AFFILIATE_DB_MUTATION=claimonce     one ledger entry may be claimed by two payouts
//   AFFILIATE_DB_MUTATION=termsbump     editing the terms text keeps the old version number
//   AFFILIATE_DB_MUTATION=normalize     a suppression is stored exactly as typed
//   Review cycle 1 of #1177:
//   AFFILIATE_DB_MUTATION=cancelreverse cancelled orders are skipped again, so no reversal
//   AFFILIATE_DB_MUTATION=cancelretired a cancelled order whose code was retired keeps its commission
//   AFFILIATE_DB_MUTATION=inactiveneg   a paused affiliate's refunds are skipped
//   AFFILIATE_DB_MUTATION=stalepayout   a draft built before a refund can be approved
//   AFFILIATE_DB_MUTATION=periodinsert  a period may be inserted already approved
//   AFFILIATE_DB_MUTATION=periodreopen  an approved period may be reopened
//   AFFILIATE_DB_MUTATION=samecompany   references are not tied to one company
//   AFFILIATE_DB_MUTATION=applyoverwrite an application replaces a reviewed email
//   AFFILIATE_DB_MUTATION=exportconfirm the export confirms payouts that are no longer approved
//   AFFILIATE_DB_MUTATION=managedco     the staff gate returns the company without judging it
//   AFFILIATE_DB_MUTATION=moneylock     accrual takes no program lock

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const MUT = process.env.AFFILIATE_DB_MUTATION || '';
const db = new PGlite();
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
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
  finA:    '10000000-0000-0000-0000-000000000004',
  ownerB:  '10000000-0000-0000-0000-000000000005',
  mgrAB:   '10000000-0000-0000-0000-000000000006',
};

// ── Fixture: only auth/company plumbing and shopify_orders. Everything
// Affiliate Studio comes from the repository SQL. ─────────────────────────
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create function gen_random_uuid() returns uuid language sql as
  $$ select md5(random()::text || clock_timestamp()::text)::uuid $$;
create table entities(id uuid primary key, title text);
create table profiles(id uuid primary key, email text, is_active boolean not null default true,
  role text, department text, active_company_id uuid);
create table entity_memberships(entity_id uuid, user_id uuid, role text);
create function active_company_id() returns uuid language sql stable security definer as
  $$ select active_company_id from profiles where id = auth.uid() $$;
create function is_exec_or_owner() returns boolean language sql stable security definer as $$
  select exists (select 1 from profiles p
    left join entity_memberships em on em.user_id = p.id and em.entity_id = p.active_company_id
    where p.id = auth.uid() and p.is_active
      and (case when em.role is not null then em.role = 'owner_admin' else p.role = 'owner' end))
$$;
create function attach_stamp_company_entity_id_triggers() returns void language sql as $$ select $$;
create table company_settings(company_entity_id uuid primary key, business_timezone text);
create function silo_company_timezone(p uuid) returns text language sql stable security definer as
  $$ select coalesce((select business_timezone from company_settings where company_entity_id = p), 'America/Los_Angeles') $$;
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
  unique (shop_domain, order_id)
);
alter table shopify_orders enable row level security;
create policy shopify_orders_active_select on shopify_orders for select to authenticated
  using (company_entity_id = active_company_id());
-- The live job-type constraint, spelled as production spells it: an ARRAY of
-- literals, which is what the migration's append parses.
create table sync_jobs (id uuid primary key default gen_random_uuid(), company_entity_id uuid,
  job_type text not null, status text,
  constraint sync_jobs_job_type_check check (job_type = any (array['shopify'::text, 'klaviyo'::text])));
-- Supabase's own defaults: every client role is granted everything on every
-- table. The migrations must revoke what they mean to withhold.
grant all on all tables in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
`);

// ── The migrations, with this run's mutation applied ──────────────────────
const files = {
  orders: '20261110083000_shopify_order_discount_codes.sql',
  core: '20261110084000_affiliate_studio.sql',
  ledger: '20261110085000_affiliate_studio_ledger.sql',
  portal: '20261110086000_affiliate_portal.sql',
  brands: '20261110190000_affiliate_portal_brands.sql',
};
const sql = {};
for (const [k, f] of Object.entries(files)) {
  sql[k] = await readFile(new URL(`../../supabase/migrations/${f}`, import.meta.url), 'utf8');
}
function mutate(key, from, to) {
  assert.ok(sql[key].includes(from), `mutation ${MUT}: pattern not found in ${files[key]}`);
  sql[key] = sql[key].split(from).join(to);
}
switch (MUT) {
  case '': break;
  case 'rls': mutate('ledger', 'alter table public.affiliate_attributions enable row level security;', ''); break;
  case 'company':
    mutate('core', `create policy affiliate_programs_select on public.affiliate_programs
  for select to authenticated
  using (company_entity_id = public.active_company_id());`, `create policy affiliate_programs_select on public.affiliate_programs
  for select to authenticated
  using (true);`); break;
  case 'gate':
    mutate('core', `  select public.is_exec_or_owner()
      or exists (`, `  select true or exists (`); break;
  case 'moneygate':
    mutate('ledger', `     or not public.can_approve_affiliate_commissions() then
    raise exception 'affiliate_approve_period: approving`, `     or not public.can_manage_affiliate_programs() then
    raise exception 'affiliate_approve_period: approving`); break;
  case 'uniqueorder':
    mutate('ledger', `create unique index if not exists affiliate_attributions_order_identity
  on public.affiliate_attributions (company_entity_id, shop_domain, order_id);`,
    `create unique index if not exists affiliate_attributions_order_identity
  on public.affiliate_attributions (company_entity_id, shop_domain, order_id, program_id);`);
    mutate('ledger', 'on conflict (company_entity_id, shop_domain, order_id) do update',
      'on conflict (company_entity_id, shop_domain, order_id, program_id) do update'); break;
  case 'crossprogram':
    mutate('ledger', '      where affiliate_attributions.program_id = excluded.program_id\n', '\n'); break;
  case 'appendonly':
    mutate('ledger', `create trigger affiliate_ledger_append_only_trg
  before update or delete on public.affiliate_commission_ledger
  for each row execute function public.affiliate_ledger_append_only();`, ''); break;
  case 'evidence':
    mutate('core', `    state not in ('sent','replied','declined','bounced')
    or (sent_marked_by is not null and sent_marked_at is not null
        and btrim(coalesce(sent_evidence,'')) <> '')`, '    true'); break;
  case 'suppression':
    mutate('core', `  return not exists (
    select 1
    from public.affiliate_suppressions s`, `  return true or not exists (
    select 1
    from public.affiliate_suppressions s`); break;
  case 'tokenread':
    mutate('core', 'revoke all on public.affiliate_access_tokens from anon, authenticated;',
      'revoke all on public.affiliate_access_tokens from anon;'); break;
  case 'clamp':
    mutate('ledger', 'then greatest(round((s.subtotal_price - s.refunded_subtotal) * s.minor)::bigint, 0)',
      'then round((s.subtotal_price - s.refunded_subtotal) * s.minor)::bigint'); break;
  case 'hold':
    mutate('ledger', '       or (l.order_day + v_prog.refund_hold_days) <= v_through', '       or true'); break;
  case 'manualonly':
    mutate('ledger', "  if v_method <> 'manual' then", '  if false then'); break;
  case 'minor':
    mutate('ledger', "  select case when upper(coalesce(p_currency, '')) in (", "  select case when false and upper(coalesce(p_currency, '')) in ("); break;
  case 'overlap':
    mutate('core', `  if new.status = 'active' and exists (`, `  if false and exists (`); break;
  case 'staleterms':
    mutate('portal', '  if p_terms_version is distinct from v_prog.terms_version then', '  if false then'); break;
  case 'mailedonly':
    mutate('brands', '       and t.mailed_only\n', ''); break;
  case 'anyemail':
    mutate('brands', 'on lower(btrim(a.contact_email)) = me.email', 'on true'); break;
  case 'portalgrant':
    mutate('portal', 'revoke all on function public.affiliate_portal_resolve(text) from public, anon, authenticated;',
      'revoke all on function public.affiliate_portal_resolve(text) from anon;'); break;
  case 'periodguard':
    mutate('ledger', `create trigger affiliate_periods_guard_trg
  before insert or update on public.affiliate_commission_periods
  for each row execute function public.affiliate_periods_guard();`, ''); break;
  case 'claimonce':
    mutate('ledger', `create unique index if not exists affiliate_payout_items_entry_once
  on public.affiliate_payout_items (ledger_entry_id);`, '');
    mutate('ledger', `     and not exists (
       select 1 from public.affiliate_payout_items i where i.ledger_entry_id = l.id
     )`, '     and true'); break;
  case 'termsbump':
    mutate('core', `create trigger affiliate_programs_terms_guard_trg
  before update on public.affiliate_programs
  for each row execute function public.affiliate_programs_terms_guard();`, ''); break;
  case 'normalize':
    mutate('core', `create trigger affiliate_suppressions_normalize_trg
  before insert on public.affiliate_suppressions
  for each row execute function public.affiliate_suppressions_normalize();`, ''); break;
  case 'cancelreverse':
    mutate('ledger', `      and jsonb_array_length(o.discount_codes) > 0
`, `      and jsonb_array_length(o.discount_codes) > 0
      and o.cancelled_at is null
`);
    mutate('ledger', '     and o.cancelled_at is not null;', '     and false;'); break;
  case 'cancelretired':
    mutate('ledger', '     and o.cancelled_at is not null;', '     and false;'); break;
  case 'inactiveneg':
    mutate('ledger', "    if r.affiliate_status <> 'active' and v_delta > 0 then", "    if r.affiliate_status <> 'active' then"); break;
  case 'stalepayout':
    mutate('ledger', '  if v_newer < 0 then', '  if false then'); break;
  case 'periodinsert':
    mutate('ledger', "    if new.status <> 'open' or new.approved_by is not null or new.approved_at is not null\n       or new.submitted_by is not null or new.submitted_at is not null then", "    if false then"); break;
  case 'periodreopen':
    mutate('ledger', "  if old.status in ('approved','paid')\n     and (", "  if false\n     and ("); break;
  case 'samecompany':
    mutate('portal', "       and (cl.relname = 'affiliates' or cl.relname like 'affiliate\\_%')\n       and (pl.relname", "       and false\n       and (pl.relname"); break;
  case 'applyoverwrite':
    mutate('portal', `       contact_email = case
         when affiliate_prospects.status in ('new','qualified')
           then coalesce(affiliate_prospects.contact_email, excluded.contact_email)
         else affiliate_prospects.contact_email end,`, `       contact_email = coalesce(excluded.contact_email, affiliate_prospects.contact_email),`); break;
  case 'exportconfirm':
    mutate('ledger', `       and program_id = p_program
       and status = 'approved';`, `       and program_id = p_program
       and status in ('approved', 'void');`);
    mutate('ledger', `     and p.export_batch_id = v_batch
     and p.status = 'exported';`, `     and p.export_batch_id = v_batch;`); break;
  case 'managedco':
    mutate('core', `   where c.id is not null
     and public.can_manage_affiliate_programs()`, `   where c.id is not null`); break;
  case 'moneylock':
    mutate('ledger', `  perform public.affiliate_lock_program_money(p_program);

  if p_period is not null then`, `
  if p_period is not null then`); break;
  default: throw new Error(`unknown mutation ${MUT}`);
}

for (const k of ['orders', 'core', 'ledger', 'portal', 'brands']) {
  await db.exec(sql[k]);
  await db.exec(sql[k]);
}

// ── Identities ────────────────────────────────────────────────────────────
await db.exec(`
insert into entities values ('${A}','Brand A'),('${B}','Brand B');
insert into company_settings values ('${A}','America/Los_Angeles'),('${B}','Asia/Tokyo');
insert into auth.users values ${Object.values(U).map((u) => `('${u}')`).join(',')};
insert into profiles(id,email,role,department,active_company_id) values
  ('${U.ownerA}','owner@a.test','owner',null,'${A}'),
  ('${U.mgrA}','mgr@a.test','member',null,'${A}'),
  ('${U.memberA}','member@a.test','member',null,'${A}'),
  ('${U.finA}','fin@a.test','member','finance','${A}'),
  ('${U.ownerB}','owner@b.test','owner',null,'${B}'),
  ('${U.mgrAB}','both@ab.test','member',null,'${A}');
insert into entity_memberships values
  ('${A}','${U.ownerA}','owner_admin'), ('${A}','${U.mgrA}','admin'),
  ('${A}','${U.memberA}','member'), ('${A}','${U.finA}','admin'),
  ('${B}','${U.ownerB}','owner_admin'), ('${A}','${U.mgrAB}','admin'), ('${B}','${U.mgrAB}','admin');
`);

async function as(user, company) {
  await db.exec('reset role');
  if (user) {
    await db.query('update profiles set active_company_id = $1 where id = $2', [company, user]);
    await db.exec(`set role authenticated; select set_config('test.uid', '${user}', false);`);
  } else {
    await db.exec(`set role service_role; select set_config('test.uid', '', false);`);
  }
}
async function asSuper() {
  await db.exec(`reset role; select set_config('test.uid', '', false);`);
}
const one = async (q, p = []) => (await db.query(q, p)).rows[0];
const all = async (q, p = []) => (await db.query(q, p)).rows;

// Seed both companies with a program as their own owners.
async function seedProgram(user, company, slug, extra = {}) {
  await as(user, company);
  const cols = { name: `${slug} program`, slug, status: 'active', commission_percent: 10, currency: 'USD', ...extra };
  const keys = Object.keys(cols);
  const row = await one(
    `insert into affiliate_programs(company_entity_id, ${keys.join(',')}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(',')}) returning id`,
    [company, ...keys.map((k) => cols[k])]);
  return row.id;
}

// ── A + B: tenant isolation and authority ─────────────────────────────────
const progA = await seedProgram(U.ownerA, A, 'creators', { terms_markdown: 'Be nice.', terms_version: 1 });
const progB = await seedProgram(U.ownerB, B, 'creators', { currency: 'JPY' });

await check('A1 the same program slug in two companies is two programs', async () => {
  assert.notEqual(progA, progB);
});

await check('A2 a company reads only its own programs', async () => {
  await as(U.memberA, A);
  const rows = await all('select id, company_entity_id from affiliate_programs');
  assert.deepEqual(rows.map((r) => r.id), [progA]);
  await as(U.ownerB, B);
  assert.deepEqual((await all('select id from affiliate_programs')).map((r) => r.id), [progB]);
});

await check('A3 a company cannot write into another company', async () => {
  await as(U.ownerA, A);
  await assert.rejects(db.query(
    `insert into affiliate_programs(company_entity_id,name,slug,commission_percent) values ($1,'x','hostile',5)`, [B]));
  const upd = await db.query(`update affiliate_programs set name = 'pwned' where id = $1`, [progB]);
  assert.equal(upd.affectedRows, 0, 'an UPDATE across companies must touch zero rows');
});

await check('B1 a plain member reads but cannot manage', async () => {
  await as(U.memberA, A);
  assert.equal((await one('select public.can_manage_affiliate_programs() as v')).v, false);
  await assert.rejects(db.query(
    `insert into affiliate_programs(company_entity_id,name,slug,commission_percent) values ($1,'x','member-made',5)`, [A]));
});

await check('B2 an explicit manager grant confers management, for that company only', async () => {
  await as(U.ownerA, A);
  await db.query('insert into affiliate_program_managers(company_entity_id,user_id) values ($1,$2),($1,$3)', [A, U.mgrA, U.mgrAB]);
  await as(U.mgrA, A);
  assert.equal((await one('select public.can_manage_affiliate_programs() as v')).v, true);
  await as(U.mgrAB, B);
  assert.equal((await one('select public.can_manage_affiliate_programs() as v')).v, false,
    'a grant at company A must not make anyone a manager at company B');
});

await check('B3 management and money are different authorities', async () => {
  await as(U.mgrA, A);
  assert.equal((await one('select public.can_approve_affiliate_commissions() as v')).v, false);
  await as(U.finA, A);
  assert.equal((await one('select public.can_approve_affiliate_commissions() as v')).v, true);
  assert.equal((await one('select public.can_manage_affiliate_programs() as v')).v, false);
});

await check('B4 a commission must be configured for its kind', async () => {
  await as(U.ownerA, A);
  await assert.rejects(db.query(
    `insert into affiliate_programs(company_entity_id,name,slug,commission_kind) values ($1,'x','nofee','fixed_per_order')`, [A]));
});

// ── Affiliates, prospects, outreach ───────────────────────────────────────
await as(U.mgrA, A);
const prospect = (await one(
  `insert into affiliate_prospects(company_entity_id, program_id, display_name, platform, handle, profile_url, source, source_url, evidence, confidence, confidence_basis)
   values ($1,$2,'Coach Pat','youtube','@coachpat','https://youtube.com/@coachpat','serp','https://search.example/q', '{"title":"Coach Pat"}', 0.6, 'title and snippet name the niche')
   returning id`, [A, progA])).id;

await check('D0 a confidence score cannot be stored without a basis', async () => {
  await assert.rejects(db.query(
    `insert into affiliate_prospects(company_entity_id, program_id, handle, confidence) values ($1,$2,'@x',0.9)`, [A, progA]));
});

await check('D0b the same creator found twice is one prospect', async () => {
  await assert.rejects(db.query(
    `insert into affiliate_prospects(company_entity_id, program_id, handle, profile_url) values ($1,$2,'@other','HTTPS://YouTube.com/@CoachPat ')`,
    [A, progA]), /duplicate|unique/i);
});

await check('D1 a suppressed address cannot be approved for outreach, however it is spelled', async () => {
  await as(U.memberA, A);
  // Any member may record an opt-out.
  await db.query(`insert into affiliate_suppressions(company_entity_id, kind, value_normalized, reason) values ($1,'email','optout@creator.test','opted_out')`, [A]);
  await as(U.mgrA, A);
  await db.query(`insert into affiliate_outreach_drafts(company_entity_id, program_id, prospect_id, recipient_email, subject, body)
                  values ($1,$2,$3,'  OptOut@Creator.test ','Hi','Body')`, [A, progA, prospect]);
  await assert.rejects(db.query(
    `update affiliate_outreach_drafts set state = 'approved', approved_by = $1, approved_at = now() where prospect_id = $2`,
    [U.mgrA, prospect]), /suppression/);
});

await check('D2 a suppressed domain blocks every address at it; nothing supplied is not permission', async () => {
  await as(U.mgrA, A);
  await db.query(`insert into affiliate_suppressions(company_entity_id, kind, value_normalized) values ($1,'domain','blocked.test')`, [A]);
  assert.equal((await one(`select public.affiliate_outreach_can_contact($1,$2,'anyone@BLOCKED.test') as v`, [A, progA])).v, false);
  assert.equal((await one(`select public.affiliate_outreach_can_contact($1,$2,'fine@ok.test') as v`, [A, progA])).v, true);
  assert.equal((await one(`select public.affiliate_outreach_can_contact($1,$2) as v`, [A, progA])).v, false);
});

await check('D2b an opt-out typed loosely still matches: the value is normalised on the way in', async () => {
  await as(U.memberA, A);
  await db.query(`insert into affiliate_suppressions(company_entity_id, kind, value_normalized) values ($1,'handle','  @Loud_Creator ')`, [A]);
  await db.query(`insert into affiliate_suppressions(company_entity_id, kind, value_normalized) values ($1,'profile_url','https://www.TikTok.com/@Loud_Creator/')`, [A]);
  assert.equal((await one(`select value_normalized v from affiliate_suppressions where kind = 'handle' and company_entity_id = $1`, [A])).v, 'loud_creator');
  assert.equal((await one(`select public.affiliate_outreach_can_contact($1,$2,null,'loud_creator') as v`, [A, progA])).v, false);
  assert.equal((await one(`select public.affiliate_outreach_can_contact($1,$2,null,null,'tiktok.com/@loud_creator') as v`, [A, progA])).v, false);
  await assert.rejects(db.query(`insert into affiliate_suppressions(company_entity_id, kind, value_normalized) values ($1,'email','   ')`, [A]));
});

await check('D3 a member cannot ask about another company\'s suppression list', async () => {
  await as(U.memberA, A);
  await assert.rejects(db.query(`select public.affiliate_outreach_can_contact($1,$2,'x@y.test')`, [B, progB]), /not a member/);
});

await check('D4 only a manager may remove a suppression, and nobody may edit one', async () => {
  await as(U.memberA, A);
  const del = await db.query(`delete from affiliate_suppressions where company_entity_id = $1`, [A]);
  assert.equal(del.affectedRows, 0, 'a member must not be able to remove an opt-out');
  await assert.rejects(db.query(`update affiliate_suppressions set value_normalized = 'x' where company_entity_id = $1`, [A]));
});

await check('E1 "sent" cannot be recorded without a person and evidence', async () => {
  await as(U.mgrA, A);
  await db.query(`update affiliate_outreach_drafts set recipient_email = 'pat@coach.test' where prospect_id = $1`, [prospect]);
  await db.query(`update affiliate_outreach_drafts set state = 'approved', approved_by = $1, approved_at = now() where prospect_id = $2`, [U.mgrA, prospect]);
  await assert.rejects(db.query(`update affiliate_outreach_drafts set state = 'exported' where prospect_id = $1`, [prospect]),
    'exported needs a batch');
  const batch = (await one(`insert into affiliate_outreach_batches(company_entity_id, program_id, row_count) values ($1,$2,1) returning id`, [A, progA])).id;
  await db.query(`update affiliate_outreach_drafts set state = 'exported', batch_id = $1, exported_at = now() where prospect_id = $2`, [batch, prospect]);
  await assert.rejects(db.query(`update affiliate_outreach_drafts set state = 'sent' where prospect_id = $1`, [prospect]),
    'sent with no evidence must be refused');
  await db.query(`update affiliate_outreach_drafts set state = 'sent', sent_marked_by = $1, sent_marked_at = now(), sent_evidence = 'Gmail, sent folder 2026-11-10' where prospect_id = $2`, [U.mgrA, prospect]);
});

// Affiliates for attribution.
await as(U.mgrA, A);
const newAff = async (name, email, extra = '') => (await one(
  `insert into affiliates(company_entity_id, program_id, display_name, contact_email, status, terms_version_accepted, terms_accepted_at${extra ? ',' + extra.split('=')[0] : ''})
   values ($1,$2,$3,$4,'active',1,now()${extra ? ',' + extra.split('=')[1] : ''}) returning id`, [A, progA, name, email])).id;
const affPat = await newAff('Pat', 'pat@coach.test');
const affSam = await newAff('Sam', 'sam@creator.test');
const affFix = (await one(
  `insert into affiliates(company_entity_id, program_id, display_name, contact_email, status, terms_version_accepted, terms_accepted_at, commission_kind, commission_fixed_cents)
   values ($1,$2,'Flat Fee','flat@creator.test','active',1,now(),'fixed_per_order',700) returning id`, [A, progA])).id;
const affPaused = (await one(
  `insert into affiliates(company_entity_id, program_id, display_name, contact_email, status, terms_version_accepted, terms_accepted_at)
   values ($1,$2,'Paused','paused@creator.test','paused',1,now()) returning id`, [A, progA])).id;

await check('C0 an affiliate cannot be active without an accepted terms version', async () => {
  await assert.rejects(db.query(
    `insert into affiliates(company_entity_id, program_id, display_name, contact_email, status) values ($1,$2,'x','x@x.test','active')`, [A, progA]));
});

// ── F: codes ──────────────────────────────────────────────────────────────
await check('F1 codes are folded, and one code cannot earn for two affiliates at once', async () => {
  await as(U.mgrA, A);
  const c = await one(`insert into affiliate_codes(company_entity_id, program_id, affiliate_id, code, starts_on) values ($1,$2,$3,' pat10 ','2026-10-01') returning code`, [A, progA, affPat]);
  assert.equal(c.code, 'PAT10');
  await assert.rejects(db.query(
    `insert into affiliate_codes(company_entity_id, program_id, affiliate_id, code, starts_on, ends_on) values ($1,$2,$3,'PAT10','2026-10-15','2026-12-31')`,
    [A, progA, affSam]), /already assigned/);
});
await as(U.mgrA, A);
await db.query(`insert into affiliate_codes(company_entity_id, program_id, affiliate_id, code, starts_on, ends_on) values
  ($1,$2,$3,'SAM15','2026-10-01','2026-10-31'),
  ($1,$2,$4,'FLAT','2026-10-01',null),
  ($1,$2,$5,'PAUSED','2026-10-01',null),
  ($1,$2,$3,'SAMALT','2026-10-01',null)`, [A, progA, affSam, affFix, affPaused]);

// ── G: attribution ────────────────────────────────────────────────────────
// Orders are written as the sync writes them (service role). Times are UTC;
// company A's business day is Pacific.
await asSuper();
const order = (id, created, codes, subtotal, refunded, currency = 'USD', extra = {}) => ({
  id, created, codes, subtotal, refunded, currency, ...extra,
});
const orders = [
  order('1001', '2026-11-01T18:00:00Z', ['PAT10'], 50, 0),               // single code
  order('1002', '2026-11-01T18:00:00Z', ['WELCOME', 'pat10'], 80, 0),    // first_affiliate_code, case folded
  order('1003', '2026-11-01T18:00:00Z', ['PAT10', 'SAMALT'], 60, 0),     // two affiliates -> ambiguous
  order('1004', '2026-11-03T18:00:00Z', ['SAM15'], 40, 0),               // SAM15 ended 10-31 -> outside window
  order('1005', '2026-11-01T18:00:00Z', ['PAT10'], 30, 0, 'CAD'),        // currency mismatch
  order('1006', '2026-11-01T18:00:00Z', ['PAT10'], 30, null),            // refunds not measured
  order('1007', '2026-11-01T18:00:00Z', null, 99, 0),                    // codes not measured at all
  order('1008', '2026-11-01T18:00:00Z', ['PAT10'], 70, 0, 'USD', { cancelled: true }),
  order('1009', '2026-11-02T05:00:00Z', ['PAT10'], 20, 0),               // 21:00 Pacific on Nov 1
  order('1010', '2026-11-01T18:00:00Z', ['FLAT'], 25, 0),                // fixed fee
  order('1011', '2026-11-01T18:00:00Z', ['PAUSED'], 25, 0),              // paused affiliate
  order('1012', '2026-11-01T18:00:00Z', ['PAT10'], 10, 15),              // refund > subtotal
];
for (const o of orders) {
  await db.query(
    `insert into shopify_orders(company_entity_id, shop_domain, order_id, order_number, currency, subtotal_price, refunded_subtotal, discount_codes, shopify_created_at, cancelled_at)
     values ($1,'a.myshopify.com',$2,$3,$4,$5,$6,$7,$8,$9)`,
    [A, o.id, `#${o.id}`, o.currency, o.subtotal, o.refunded, o.codes ? JSON.stringify(o.codes) : null, o.created, o.cancelled ? o.created : null]);
}
// Company B: a JPY order with a code that collides with A's code text.
await db.query(
  `insert into shopify_orders(company_entity_id, shop_domain, order_id, currency, subtotal_price, refunded_subtotal, discount_codes, shopify_created_at)
   values ($1,'b.myshopify.com','2001','JPY',5000,0,'["PAT10"]','2026-11-01T03:00:00Z')`, [B]);

await check('G0 the order-code view keeps NULL and [] apart and never invents a row', async () => {
  await as(U.memberA, A);
  const ids = (await all(`select distinct order_id from shopify_order_discount_codes_v`)).map((r) => r.order_id);
  assert.ok(!ids.includes('1007'), 'an order whose codes were never measured has no code rows');
  assert.ok(!ids.includes('2001'), 'company B\'s order is invisible to company A');
  const refundUnknown = await one(`select net_subtotal from shopify_order_discount_codes_v where order_id = '1006'`);
  assert.equal(refundUnknown.net_subtotal, null, 'an unmeasured refund makes the base unknown, not the subtotal');
});

await check('G1 nobody but a manager of the program\'s company may resolve', async () => {
  await as(U.memberA, A);
  await assert.rejects(db.query(`select public.affiliate_resolve_attributions($1,'2026-11-01','2026-11-05')`, [progA]), /not permitted/);
  await as(U.ownerB, B);
  await assert.rejects(db.query(`select public.affiliate_resolve_attributions($1,'2026-11-01','2026-11-05')`, [progA]), /not permitted/);
});

let resolved;
await check('G2 precedence, windows, currency and unmeasured refunds', async () => {
  await as(U.mgrA, A);
  resolved = (await one(`select public.affiliate_resolve_attributions($1,'2026-11-01','2026-11-05') as r`, [progA])).r;
  const rows = Object.fromEntries((await all(`select * from affiliate_attributions where company_entity_id = $1`, [A])).map((r) => [r.order_id, r]));
  assert.equal(rows['1001'].basis, 'single_affiliate_code');
  assert.equal(rows['1001'].affiliate_id, affPat);
  assert.equal(Number(rows['1001'].commissionable_cents), 5000);
  assert.equal(rows['1002'].basis, 'first_affiliate_code', 'a lower-case code on the order still matches');
  assert.equal(rows['1002'].matched_code, 'PAT10');
  assert.equal(rows['1003'].basis, 'ambiguous_multiple_affiliate_codes');
  assert.equal(rows['1003'].affiliate_id, null);
  assert.equal(rows['1004'].basis, 'code_outside_window');
  assert.equal(rows['1005'].basis, 'currency_mismatch');
  assert.equal(rows['1005'].commissionable_cents, null);
  assert.equal(rows['1006'].basis, 'refunds_not_measured');
  assert.equal(rows['1006'].commissionable_cents, null);
  assert.ok(!rows['1007'], 'unmeasured codes are not attributed');
  assert.equal(rows['1008'].basis, 'order_cancelled', 'a cancelled order is recorded as a known zero, not skipped');
  assert.equal(Number(rows['1008'].commissionable_cents), 0);
  assert.equal(rows['1009'].order_day instanceof Date ? rows['1009'].order_day.toISOString().slice(0, 10) : String(rows['1009'].order_day).slice(0, 10),
    '2026-11-01', '21:00 Pacific belongs to the Pacific business day, not the UTC one');
  assert.equal(Number(rows['1012'].commissionable_cents), 0, 'a refund larger than the subtotal clamps at zero');
  assert.ok(!Object.values(rows).some((r) => r.company_entity_id !== A));
});

await check('G3 the grace window extends a code past its end date', async () => {
  await as(U.ownerA, A);
  await db.query(`update affiliate_programs set attribution_window_days = 5 where id = $1`, [progA]);
  await as(U.mgrA, A);
  await db.query(`select public.affiliate_resolve_attributions($1,'2026-11-01','2026-11-05')`, [progA]);
  const r = await one(`select basis, affiliate_id from affiliate_attributions where order_id = '1004'`);
  assert.equal(r.basis, 'single_affiliate_code');
  assert.equal(r.affiliate_id, affSam);
});

await check('G4 re-resolving is idempotent: one row per order, ever', async () => {
  await as(U.mgrA, A);
  const before = Number((await one(`select count(*) as n from affiliate_attributions`)).n);
  await db.query(`select public.affiliate_resolve_attributions($1,'2026-11-01','2026-11-05')`, [progA]);
  await db.query(`select public.affiliate_resolve_attributions($1,'2026-11-01','2026-11-05')`, [progA]);
  const after = Number((await one(`select count(*) as n from affiliate_attributions`)).n);
  assert.equal(after, before);
  const dupes = await all(`select order_id, count(*) from affiliate_attributions group by 1 having count(*) > 1`);
  assert.equal(dupes.length, 0);
});

await check('G5 a second program cannot take over an order another program owns', async () => {
  await as(U.ownerA, A);
  const prog2 = (await one(`insert into affiliate_programs(company_entity_id,name,slug,status,commission_percent) values ($1,'Second','second','active',50) returning id`, [A])).id;
  const aff2 = (await one(`insert into affiliates(company_entity_id, program_id, display_name, contact_email, status, terms_version_accepted, terms_accepted_at)
                           values ($1,$2,'Poacher','poach@x.test','active',1,now()) returning id`, [A, prog2])).id;
  await db.query(`insert into affiliate_codes(company_entity_id, program_id, affiliate_id, code, starts_on) values ($1,$2,$3,'WELCOME','2026-10-01')`, [A, prog2, aff2]);
  const r = (await one(`select public.affiliate_resolve_attributions($1,'2026-11-01','2026-11-05') as r`, [prog2])).r;
  assert.ok(r.conflict_other_program >= 1, 'the takeover must be counted');
  const owner = await one(`select program_id, affiliate_id from affiliate_attributions where order_id = '1002'`);
  assert.equal(owner.program_id, progA, 'order 1002 stays with the program that first attributed it');
  assert.equal(owner.affiliate_id, affPat);
  await db.query(`update affiliate_codes set status = 'retired' where program_id = $1`, [prog2]);
  await db.query(`update affiliate_programs set status = 'closed' where id = $1`, [prog2]);
});

await check('G6 a zero-decimal currency is not multiplied by 100', async () => {
  await as(U.ownerB, B);
  const affB = (await one(`insert into affiliates(company_entity_id, program_id, display_name, contact_email, status, terms_version_accepted, terms_accepted_at)
                           values ($1,$2,'Ken','ken@b.test','active',1,now()) returning id`, [B, progB])).id;
  await db.query(`insert into affiliate_codes(company_entity_id, program_id, affiliate_id, code, starts_on) values ($1,$2,$3,'PAT10','2026-10-01')`, [B, progB, affB]);
  await db.query(`select public.affiliate_resolve_attributions($1,'2026-10-25','2026-11-05')`, [progB]);
  const r = await one(`select commissionable_cents, company_entity_id, order_day from affiliate_attributions where order_id = '2001'`);
  assert.equal(Number(r.commissionable_cents), 5000, '¥5000 is 5000 minor units');
  assert.equal(r.company_entity_id, B);
  assert.equal(String(r.order_day instanceof Date ? r.order_day.toISOString() : r.order_day).slice(0, 10), '2026-11-01',
    '03:00 UTC is noon in Tokyo -- each company\'s own business day');
});

await check('G7 codes seen on a real order are stamped verified', async () => {
  await as(U.memberA, A);
  const pat = await one(`select verified_at, first_seen_order_id from affiliate_codes where code = 'PAT10' and company_entity_id = $1`, [A]);
  assert.ok(pat.verified_at, 'PAT10 was seen');
  const never = await one(`select verified_at from affiliate_codes where code = 'SAMALT'`);
  assert.equal(never.verified_at, null, 'SAMALT only appeared on an ambiguous order, so it was never credited');
});

await check('G8 attributions are client-unwritable', async () => {
  await as(U.ownerA, A);
  await assert.rejects(db.query(`update affiliate_attributions set commissionable_cents = 999999`));
  await assert.rejects(db.query(`delete from affiliate_attributions`));
});

// ── H: accrual ────────────────────────────────────────────────────────────
let accrual;
await check('H1 accrual: percent and fixed, unknown bases and inactive affiliates skipped', async () => {
  await as(U.mgrA, A);
  accrual = (await one(`select public.affiliate_accrue_commissions($1,'2026-11-01','2026-11-05') as r`, [progA])).r;
  const byOrder = Object.fromEntries((await all(`select order_id, amount_cents, kind from affiliate_commission_ledger where company_entity_id = $1`, [A]))
    .map((r) => [r.order_id, r]));
  assert.equal(Number(byOrder['1001'].amount_cents), 500, '10% of $50.00');
  assert.equal(Number(byOrder['1002'].amount_cents), 800);
  assert.equal(Number(byOrder['1010'].amount_cents), 700, 'flat fee override');
  assert.ok(!byOrder['1011'], 'a paused affiliate earns nothing new');
  assert.ok(!byOrder['1005'] && !byOrder['1006'], 'an unknown base accrues nothing');
  assert.ok(!byOrder['1012'], 'a zero base accrues nothing');
  assert.ok(accrual.skipped_inactive_affiliate >= 1);
  assert.ok(accrual.skipped_unknown_base >= 2);
});

await check('H2 accruing again appends nothing', async () => {
  await as(U.mgrA, A);
  const before = Number((await one(`select count(*) as n from affiliate_commission_ledger`)).n);
  const r = (await one(`select public.affiliate_accrue_commissions($1,'2026-11-01','2026-11-05') as r`, [progA])).r;
  assert.equal(r.entries_accrued + r.entries_reduced, 0);
  assert.equal(Number((await one(`select count(*) as n from affiliate_commission_ledger`)).n), before);
});

await check('H3 the ledger cannot be edited or deleted by anyone, the service role included', async () => {
  await as(null, null);
  await assert.rejects(db.query(`update affiliate_commission_ledger set amount_cents = 1`), /append-only/);
  await assert.rejects(db.query(`delete from affiliate_commission_ledger`), /append-only/);
});

await check('H4 a manual adjustment needs the money gate and a memo', async () => {
  await as(U.mgrA, A);
  await assert.rejects(db.query(
    `insert into affiliate_commission_ledger(company_entity_id, program_id, affiliate_id, kind, amount_cents, currency, source, memo)
     values ($1,$2,$3,'manual_adjustment',100,'USD','manual','bonus')`, [A, progA, affPat]));
  await as(U.finA, A);
  await assert.rejects(db.query(
    `insert into affiliate_commission_ledger(company_entity_id, program_id, affiliate_id, kind, amount_cents, currency, source)
     values ($1,$2,$3,'manual_adjustment',100,'USD','manual')`, [A, progA, affPat]));
  await assert.rejects(db.query(
    `insert into affiliate_commission_ledger(company_entity_id, program_id, affiliate_id, kind, amount_cents, currency, source, memo)
     values ($1,$2,$3,'accrual',100,'USD','manual','x')`, [A, progA, affPat]), 'a client may not forge an accrual');
});

// ── J (part 1): refund hold and payouts ───────────────────────────────────
await check('J1 nothing is payable inside the refund hold', async () => {
  await as(U.ownerA, A);
  await db.query(`update affiliate_programs set refund_hold_days = 30 where id = $1`, [progA]);
  await as(U.mgrA, A);
  await assert.rejects(db.query(`select public.affiliate_build_payout($1, '2026-11-10')`, [affPat]), /nothing payable/);
});

let payout1;
await check('J2 build after the hold; approval is the money gate and checks the total', async () => {
  await as(U.mgrA, A);
  payout1 = (await one(`select public.affiliate_build_payout($1, '2026-12-15') as id`, [affPat])).id;
  const p = await one(`select amount_cents, status, method from affiliate_payouts where id = $1`, [payout1]);
  assert.equal(p.status, 'draft');
  assert.equal(p.method, 'manual');
  assert.equal(Number(p.amount_cents), 500 + 800 + 200, 'orders 1001, 1002 and 1009');
  await assert.rejects(db.query(`select public.affiliate_approve_payout($1)`, [payout1]), /can_approve/);
  await assert.rejects(db.query(`insert into affiliate_payouts(company_entity_id, program_id, affiliate_id, currency, amount_cents) values ($1,$2,$3,'USD',1)`,
    [A, progA, affPat]), 'a client cannot create a payout row directly');
});

await check('J3 one ledger entry can be claimed by one payout', async () => {
  await as(U.mgrA, A);
  await assert.rejects(db.query(`select public.affiliate_build_payout($1, '2026-12-15')`, [affPat]), /nothing payable/);
});

await check('J4 a non-manual payout cannot be recorded as paid; manual needs reference and evidence', async () => {
  await as(U.finA, A);
  await db.query(`select public.affiliate_approve_payout($1)`, [payout1]);
  await asSuper();
  await db.query(`update affiliate_payouts set method = 'stripe_connect_express' where id = $1`, [payout1]);
  await as(U.finA, A);
  await assert.rejects(db.query(`select public.affiliate_mark_payout_paid($1,'tr_123','stripe dashboard')`, [payout1]), /not implemented/);
  await asSuper();
  await db.query(`update affiliate_payouts set method = 'manual' where id = $1`, [payout1]);
  await as(U.finA, A);
  await assert.rejects(db.query(`select public.affiliate_mark_payout_paid($1,'','')`, [payout1]), /reference AND evidence/);
  await as(U.mgrA, A);
  await assert.rejects(db.query(`select public.affiliate_mark_payout_paid($1,'ACH-1','bank statement')`, [payout1]), /can_approve/);
  await as(U.finA, A);
  await db.query(`select public.affiliate_mark_payout_paid($1,'ACH-1','bank statement line 2026-12-16')`, [payout1]);
});

await check('H5/J5 a refund after payout appends a negative entry and a negative balance', async () => {
  await asSuper();
  await db.query(`update shopify_orders set refunded_subtotal = 50 where order_id = '1001'`);
  await as(U.mgrA, A);
  await db.query(`select public.affiliate_resolve_attributions($1,'2026-11-01','2026-11-05')`, [progA]);
  const r = (await one(`select public.affiliate_accrue_commissions($1,'2026-11-01','2026-11-05') as r`, [progA])).r;
  assert.equal(r.entries_reduced, 1);
  const neg = await one(`select amount_cents, kind from affiliate_commission_ledger where order_id = '1001' and amount_cents < 0`);
  assert.equal(Number(neg.amount_cents), -500);
  assert.equal(neg.kind, 'refund_adjustment');
  const orig = await one(`select amount_cents from affiliate_commission_ledger where order_id = '1001' and amount_cents > 0`);
  assert.equal(Number(orig.amount_cents), 500, 'the original accrual is untouched');
  const bal = await one(`select earned_cents, paid_cents, unclaimed_cents from affiliate_balances_v where affiliate_id = $1`, [affPat]);
  assert.equal(Number(bal.paid_cents), 1500);
  assert.equal(Number(bal.unclaimed_cents), -500, 'a refund after payout is money owed back, shown as such');
});

await check('H6 a fully refunded order takes back a flat fee', async () => {
  await asSuper();
  await db.query(`update shopify_orders set refunded_subtotal = 25 where order_id = '1010'`);
  await as(U.mgrA, A);
  await db.query(`select public.affiliate_resolve_attributions($1,'2026-11-01','2026-11-05')`, [progA]);
  await db.query(`select public.affiliate_accrue_commissions($1,'2026-11-01','2026-11-05')`, [progA]);
  const sum = await one(`select sum(amount_cents) as s from affiliate_commission_ledger where order_id = '1010'`);
  assert.equal(Number(sum.s), 0);
});

// ── I: periods ────────────────────────────────────────────────────────────
let period;
await check('I1 a manager may open and submit a period but not approve it', async () => {
  await as(U.mgrA, A);
  period = (await one(`insert into affiliate_commission_periods(company_entity_id, program_id, period_start, period_end) values ($1,$2,'2026-11-06','2026-11-30') returning id`, [A, progA])).id;
  await db.query(`select public.affiliate_submit_period($1)`, [period]);
  await assert.rejects(db.query(`update affiliate_commission_periods set status = 'approved', approved_by = $1, approved_at = now() where id = $2`, [U.mgrA, period]),
    /approve through/);
  await assert.rejects(db.query(`select public.affiliate_approve_period($1)`, [period]), /can_approve/);
});

await check('J6 an entry in an unapproved period is not payable; approval releases it', async () => {
  await asSuper();
  await db.query(`insert into shopify_orders(company_entity_id, shop_domain, order_id, currency, subtotal_price, refunded_subtotal, discount_codes, shopify_created_at)
                  values ($1,'a.myshopify.com','1020','USD',100,0,'["SAM15"]','2026-11-07T18:00:00Z')`, [A]);
  await as(U.ownerA, A);
  await db.query(`update affiliate_codes set ends_on = null where code = 'SAM15'`);
  await as(U.mgrA, A);
  await db.query(`select public.affiliate_resolve_attributions($1,'2026-11-06','2026-11-30')`, [progA]);
  await db.query(`select public.affiliate_accrue_commissions($1,'2026-11-06','2026-11-30')`, [progA]);
  const e = await one(`select period_id from affiliate_commission_ledger where order_id = '1020'`);
  assert.equal(e.period_id, period, 'the entry lands in the period containing its order day');
  // Sam's 1004 entry (no period) is payable after the hold; 1020 is not until approval.
  const p = (await one(`select public.affiliate_build_payout($1, '2027-01-31') as id`, [affSam])).id;
  const amt = Number((await one(`select amount_cents from affiliate_payouts where id = $1`, [p])).amount_cents);
  assert.equal(amt, 400, 'only order 1004 -- 1020 waits for its period');
  await as(U.finA, A);
  await db.query(`select public.affiliate_void_payout($1,'rebuild after period approval')`, [p]);
  await db.query(`select public.affiliate_approve_period($1,'reviewed')`, [period]);
  await as(U.mgrA, A);
  const p2 = (await one(`select public.affiliate_build_payout($1, '2027-01-31') as id`, [affSam])).id;
  assert.equal(Number((await one(`select amount_cents from affiliate_payouts where id = $1`, [p2])).amount_cents), 1400,
    'voiding released 1004 and approval released 1020');
  await assert.rejects(db.query(`select public.affiliate_accrue_commissions($1,'2026-11-06','2026-11-30',$2)`, [progA, period]),
    /already approved/, 'an approved period takes no new entries');
});

// ── C + K: tokens and the portal ──────────────────────────────────────────
await check('C1 no client role can read a token hash; the state view hides it', async () => {
  await as(null, null);
  await db.query(`select public.affiliate_issue_access_token($1,$2,'portal','hash-pat',now() + interval '30 days',$3)`, [A, progA, affPat]);
  await as(U.ownerA, A);
  await assert.rejects(db.query(`select token_hash from affiliate_access_tokens`));
  const cols = (await all(`select column_name from information_schema.columns where table_name = 'affiliate_access_token_state_v'`)).map((r) => r.column_name);
  assert.ok(!cols.includes('token_hash'));
  assert.equal((await all(`select * from affiliate_access_token_state_v`)).length, 1);
  await as(U.ownerB, B);
  assert.equal((await all(`select * from affiliate_access_token_state_v`)).length, 0, 'the definer view filters by company');
});

await check('C2 the portal functions are service-role only', async () => {
  await as(U.ownerA, A);
  await assert.rejects(db.query(`select * from public.affiliate_portal_resolve('hash-pat')`), /permission denied/);
  await assert.rejects(db.query(`select public.affiliate_portal_statement('hash-pat')`), /permission denied/);
  await assert.rejects(db.query(`select public.affiliate_issue_access_token($1,$2,'portal','x',now() + interval '1 day',$3)`, [A, progA, affPat]), /permission denied/);
});

await check('K9 the brand menu is this email\'s records only, and a signup link gets none', async () => {
  await asSuper();
  // The same person, same address, on a SECOND company -- which is what
  // "reps two brands" is -- plus a look-alike address that must not match.
  const progB = (await one(`insert into affiliate_programs(company_entity_id,name,slug,status,commission_percent)
                            values ($1,'Creators','creators-b','active',10) returning id`, [B])).id;
  const patB = (await one(`insert into affiliates(company_entity_id, program_id, display_name, contact_email, status, terms_version_accepted, terms_accepted_at)
                           values ($1,$2,'Sam','  SAM@Creator.test ','active',1,now()) returning id`, [B, progB])).id;
  // Terminated, and in a program of its own because one address can hold only
  // one record per program.
  const progBOld = (await one(`insert into affiliate_programs(company_entity_id,name,slug,status,commission_percent)
                               values ($1,'Retired','retired-b','active',10) returning id`, [B])).id;
  const gone = (await one(`insert into affiliates(company_entity_id, program_id, display_name, contact_email, status)
                           values ($1,$2,'Sam Old','sam@creator.test','terminated') returning id`, [B, progBOld])).id;
  await db.query(`insert into affiliates(company_entity_id, program_id, display_name, contact_email, status, terms_version_accepted, terms_accepted_at)
                  values ($1,$2,'Someone Else','sam@creator.test.evil','active',1,now())`, [B, progBOld]);
  // The rep's own session: minted the way sign-in mints, so the database
  // knows the raw token went only to the address on file.
  await db.query(`select public.affiliate_portal_issue_mailed_token($1,$2,$3,'hash-sam-portal', now() + interval '1 day')`, [A, progA, affSam]);
  // Opened, so the next mint for this affiliate cannot revoke it: a refusal
  // below must come from mailed_only, never from a revoked link.
  await db.query(`update affiliate_access_tokens set first_used_at = now() where token_hash = 'hash-sam-portal'`);
  await db.query(`insert into affiliate_access_tokens(company_entity_id, program_id, affiliate_id, purpose, token_hash, expires_at)
                  values ($1,$2,$3,'signup','hash-sam-signup', now() + interval '1 day')`, [A, progA, affSam]);

  const rows = await all(`select * from public.affiliate_portal_brands('hash-sam-portal')`);
  assert.deepEqual(rows.map((r) => r.affiliate_id).sort(), [affSam, patB].sort());
  assert.equal(rows.find((r) => r.affiliate_id === affSam).is_current, true);
  assert.equal(rows.find((r) => r.affiliate_id === patB).is_current, false);
  assert.ok(!rows.some((r) => r.affiliate_id === gone), 'a terminated record is not a brand to switch to');
  assert.ok(!rows.some((r) => String(r.contact_email).includes('evil')), 'a look-alike address is not the same address');

  // A signup link is part-way through accepting ONE brand: no session, no menu.
  assert.equal((await all(`select * from public.affiliate_portal_brands('hash-sam-signup')`)).length, 0);
  assert.equal((await all(`select * from public.affiliate_portal_brands('nope')`)).length, 0);
});

await check('K9b a portal token its requester holds, not the mailbox, gets no brands', async () => {
  await asSuper();
  // Exactly what affiliate-invite's staff `portal_link` mints: a manager of
  // THIS company holds the raw URL (mailing it is optional), and what signup
  // acceptance hands back has the same shape. Either would otherwise carry a
  // manager of one company into another company's portal.
  await db.query(`select public.affiliate_issue_access_token($1,$2,'portal','hash-staff-issued', now() + interval '1 day',$3,null,$4)`,
    [A, progA, affSam, U.mgrA]);
  await db.query(`update affiliate_access_tokens set first_used_at = now() where token_hash = 'hash-staff-issued'`);
  await db.query(`select public.affiliate_issue_access_token($1,$2,'portal','hash-accept-returned', now() + interval '1 day',$3)`,
    [A, progA, affSam]);
  for (const h of ['hash-staff-issued', 'hash-accept-returned']) {
    assert.equal((await all(`select * from public.affiliate_portal_brands($1)`, [h])).length, 0,
      `${h} must not enumerate another company`);
  }
  // mailed_only is the whole difference, and nothing grants it by default.
  assert.deepEqual(await all(`select token_hash, mailed_only from affiliate_access_tokens
                               where token_hash in ('hash-sam-portal','hash-staff-issued','hash-accept-returned')
                               order by token_hash`), [
    { token_hash: 'hash-accept-returned', mailed_only: false },
    { token_hash: 'hash-sam-portal', mailed_only: true },
    { token_hash: 'hash-staff-issued', mailed_only: false },
  ]);
});

await check('K10 the brand menu is service-role only', async () => {
  await as(U.ownerA, A);
  await assert.rejects(db.query(`select * from public.affiliate_portal_brands('hash-pat-portal')`), /permission denied/);
  // Said once more as a privilege, because the signed-in role above is only
  // one of the two client roles the browser can reach the database as.
  await asSuper();
  const granted = await all(`select r as role, f as fn
                               from unnest(array['anon','authenticated']) r,
                                    unnest(array['public.affiliate_portal_brands(text)',
                                                 'public.affiliate_portal_issue_mailed_token(uuid,uuid,uuid,text,timestamptz)']) f
                              where has_function_privilege(r, f, 'execute')`);
  assert.deepEqual(granted, []);
});

await check('K1 unknown, expired and revoked links resolve to no row', async () => {
  await as(null, null);
  assert.equal((await all(`select * from public.affiliate_portal_resolve('nope')`)).length, 0);
  await asSuper();
  await db.query(`insert into affiliate_access_tokens(company_entity_id, program_id, affiliate_id, purpose, token_hash, expires_at)
                  values ($1,$2,$3,'portal','hash-old', now() - interval '1 minute')`, [A, progA, affPat]);
  await as(null, null);
  assert.equal((await all(`select * from public.affiliate_portal_resolve('hash-old')`)).length, 0);
  const live = await all(`select * from public.affiliate_portal_resolve('hash-pat')`);
  assert.equal(live.length, 1);
  assert.equal(live[0].company_title, 'Brand A');
});

await check('K2 a link cannot be minted for another company\'s affiliate', async () => {
  await as(null, null);
  await assert.rejects(db.query(`select public.affiliate_issue_access_token($1,$2,'portal','hash-x',now() + interval '1 day',$3)`, [B, progB, affPat]),
    /does not belong/);
});

await check('K3 stale terms are refused; current terms activate; acceptance is idempotent', async () => {
  await as(U.mgrA, A);
  const invitee = (await one(`insert into affiliates(company_entity_id, program_id, display_name, contact_email, status, from_prospect_id)
                              values ($1,$2,'Coach Pat 2','pat2@coach.test','invited',$3) returning id`, [A, progA, prospect])).id;
  await as(null, null);
  await db.query(`select public.affiliate_issue_access_token($1,$2,'signup','hash-signup',now() + interval '7 days',$3)`, [A, progA, invitee]);
  await as(U.ownerA, A);
  const before = (await one(`select terms_version from affiliate_programs where id = $1`, [progA])).terms_version;
  // A version number alone does not move; the text moving moves it.
  await db.query(`update affiliate_programs set terms_version = terms_version + 5 where id = $1`, [progA]);
  assert.equal((await one(`select terms_version from affiliate_programs where id = $1`, [progA])).terms_version, before);
  await db.query(`update affiliate_programs set terms_markdown = 'Be nicer.' where id = $1`, [progA]);
  const bumped = await one(`select terms_version, terms_updated_at from affiliate_programs where id = $1`, [progA]);
  assert.equal(bumped.terms_version, before + 1, 'editing the terms text must bump the version');
  assert.ok(bumped.terms_updated_at);
  assert.equal(before + 1, 2);
  await as(null, null);
  await assert.rejects(db.query(`select public.affiliate_portal_accept_terms('hash-signup','Pat',1)`), /updated/);
  const r = (await one(`select public.affiliate_portal_accept_terms('hash-signup','Pat',2,'{"ip":"203.0.113.9"}') as r`)).r;
  assert.equal(r.status, 'active');
  const a = await one(`select status, terms_version_accepted from affiliates where id = $1`, [invitee]);
  assert.equal(a.status, 'active');
  assert.equal(a.terms_version_accepted, 2);
  assert.equal((await all(`select * from public.affiliate_portal_resolve('hash-signup')`)).length, 0, 'the signup link is spent');
  const p = await one(`select status from affiliate_prospects where id = $1`, [prospect]);
  assert.equal(p.status, 'signed_up');
});

await check('K4 the statement shows earnings but no order ids', async () => {
  await as(null, null);
  const s = (await one(`select public.affiliate_portal_statement('hash-pat') as s`)).s;
  assert.equal(s.currency, 'USD');
  assert.ok(Number(s.totals.earned_cents) > 0);
  assert.ok(Array.isArray(s.codes) && s.codes.some((c) => c.code === 'PAT10'));
  const text = JSON.stringify(s);
  for (const id of ['1001', '1002', '1009', '#1001']) assert.ok(!text.includes(`"${id}"`), `order ${id} leaked into the statement`);
  assert.ok(!text.includes('customer'), 'no customer data');
});

await check('K5 invite-only refuses applications; open intake creates a prospect, never an affiliate', async () => {
  await as(null, null);
  await assert.rejects(db.query(`select public.affiliate_portal_apply($1,'creators','new@c.test','New Person')`, [A]), /not accepting/);
  await as(U.ownerA, A);
  await db.query(`update affiliate_programs set intake_mode = 'open' where id = $1`, [progA]);
  await as(null, null);
  const before = Number((await one(`select count(*) as n from affiliates where company_entity_id = $1`, [A])).n);
  const r = (await one(`select public.affiliate_portal_apply($1,'creators','New@C.test','New Person','instagram','@newperson') as r`, [A])).r;
  assert.ok(r.prospect_id);
  assert.equal(Number((await one(`select count(*) as n from affiliates where company_entity_id = $1`, [A])).n), before);
  const p = await one(`select source, status, contact_email from affiliate_prospects where id = $1`, [r.prospect_id]);
  assert.deepEqual([p.source, p.status, p.contact_email], ['applied', 'new', 'new@c.test']);
  await assert.rejects(db.query(`select public.affiliate_portal_apply($1,'creators','someone@blocked.test','Blocked','web','@blocked')`, [A]),
    /cannot be added/, 'a suppressed domain cannot re-enter the pipeline through the form');
  await assert.rejects(db.query(`select public.affiliate_portal_apply($1,'creators','x@y.test','X')`, [B]), /not accepting/,
    'company B has no open program by that slug');
  const unknown = await db.query(`select public.affiliate_portal_apply($1,'no-such-slug','x@y.test','X')`, [A]).catch((e) => e);
  const closed = await db.query(`select public.affiliate_portal_apply($1,'creators','x@y.test','X')`, [B]).catch((e) => e);
  assert.equal(unknown.message, closed.message, 'an unknown slug and a closed program must be indistinguishable');
  assert.equal(unknown.code, closed.code);
  await assert.rejects(db.query(`select public.affiliate_portal_apply($1,'creators','js@c.test','JS','web',null,'javascript:alert(1)')`, [A]), /https/,
    'a script URL cannot be submitted as a profile link');
  await asSuper();
  await assert.rejects(db.query(`insert into affiliate_prospects(company_entity_id, program_id, handle, profile_url) values ($1,$2,'@js','javascript:alert(1)')`, [A, progA]),
    /check/i, 'no writer, the service role included, can store a script URL');
});

// ── M: discovery bookkeeping ───────────────────────────────────────────────
await check('M1 sync_jobs learns affiliate_discovery without losing what it had', async () => {
  await as(null, null);
  for (const t of ['shopify', 'klaviyo', 'affiliate_discovery']) {
    await db.query(`insert into sync_jobs(company_entity_id, job_type, status) values ($1,$2,'ok')`, [A, t]);
  }
  await assert.rejects(db.query(`insert into sync_jobs(company_entity_id, job_type, status) values ($1,'nonsense','ok')`, [A]));
});

await check('M2 discovery run rows are a measurement: no client may write one', async () => {
  await as(U.ownerA, A);
  await assert.rejects(db.query(
    `insert into affiliate_discovery_runs(company_entity_id, program_id, run_id, provider, results_returned) values ($1,$2,gen_random_uuid(),'dataforseo',999)`,
    [A, progA]));
  await as(null, null);
  await db.query(`insert into affiliate_discovery_runs(company_entity_id, program_id, run_id, provider, status) values ($1,$2,gen_random_uuid(),'dataforseo','ok')`, [A, progA]);
  await as(U.ownerB, B);
  assert.equal((await all(`select * from affiliate_discovery_runs`)).length, 0);
});

// ── L: views keep tenants apart ───────────────────────────────────────────
await check('L1 every reading view is tenant-scoped', async () => {
  await as(U.ownerB, B);
  for (const v of ['affiliate_balances_v', 'affiliate_performance_v', 'affiliate_program_health_v', 'shopify_order_discount_codes_v']) {
    const rows = await all(`select company_entity_id from ${v}`);
    assert.ok(rows.every((r) => r.company_entity_id === B), `${v} leaked company A into company B`);
  }
  const reloptions = await all(`select c.relname, c.reloptions from pg_class c where c.relname in
    ('affiliate_balances_v','affiliate_performance_v','affiliate_program_health_v','shopify_order_discount_codes_v')`);
  for (const r of reloptions) assert.ok(String(r.reloptions).includes('security_invoker=true'), `${r.relname} must be security_invoker`);
});

// ── R: review cycle 1 regressions ────────────────────────────────────────
// Each check below is a defect the first independent review found, pinned so
// it cannot come back.
const orderA = async (id, day, code, subtotal, refunded = 0) => {
  await asSuper();
  await db.query(`insert into shopify_orders(company_entity_id, shop_domain, order_id, currency, subtotal_price, refunded_subtotal, discount_codes, shopify_created_at)
                  values ($1,'a.myshopify.com',$2,'USD',$3,$4,$5,$6)`, [A, id, subtotal, refunded, JSON.stringify([code]), `${day}T18:00:00Z`]);
};
const settle = async () => {
  await as(U.mgrA, A);
  await db.query(`select public.affiliate_resolve_attributions($1,'2026-11-01','2026-11-05')`, [progA]);
  return (await one(`select public.affiliate_accrue_commissions($1,'2026-11-01','2026-11-05') as r`, [progA])).r;
};
const ledgerSum = async (orderId) => Number((await one(`select coalesce(sum(amount_cents),0) as s from affiliate_commission_ledger where order_id = $1`, [orderId])).s);
const newActive = async (name, code) => {
  await as(U.mgrA, A);
  const id = (await one(`insert into affiliates(company_entity_id, program_id, display_name, contact_email, status, terms_version_accepted, terms_accepted_at)
    values ($1,$2,$3,$4,'active',1,now()) returning id`, [A, progA, name, `${name.toLowerCase()}@creator.test`])).id;
  await db.query(`insert into affiliate_codes(company_entity_id, program_id, affiliate_id, code, starts_on) values ($1,$2,$3,$4,'2026-10-01')`, [A, progA, id, code]);
  return id;
};

await check('R1 an order cancelled AFTER its commission accrued is reversed', async () => {
  await newActive('Cleo', 'CLEO');
  await orderA('1030', '2026-11-02', 'CLEO', 40);
  await settle();
  assert.equal(await ledgerSum('1030'), 400);
  await asSuper();
  await db.query(`update shopify_orders set cancelled_at = now() where order_id = '1030'`);
  const r = await settle();
  assert.ok(r.entries_reduced >= 1);
  assert.equal(await ledgerSum('1030'), 0, 'the cancellation takes the commission back');
  const a = await one(`select basis, commissionable_cents from affiliate_attributions where order_id = '1030'`);
  assert.deepEqual([a.basis, Number(a.commissionable_cents)], ['order_cancelled', 0]);
});

await check('R1b a cancelled order is reversed even after its code was retired', async () => {
  await newActive('Ivo', 'IVO');
  await orderA('1036', '2026-11-02', 'IVO', 30);
  await settle();
  assert.equal(await ledgerSum('1036'), 300);
  await as(U.mgrA, A);
  await db.query(`update affiliate_codes set status = 'retired' where code = 'IVO' and company_entity_id = $1`, [A]);
  await asSuper();
  await db.query(`update shopify_orders set cancelled_at = now() where order_id = '1036'`);
  await settle();
  assert.equal(await ledgerSum('1036'), 0, 'retiring the code does not keep a cancelled sale payable');
  const a = await one(`select basis, commissionable_cents, affiliate_id is not null as has_aff from affiliate_attributions where order_id = '1036'`);
  assert.deepEqual([a.basis, Number(a.commissionable_cents), a.has_aff], ['order_cancelled', 0, true]);
});

await check('R2 a refund still reverses commission for an affiliate who was paused since', async () => {
  const rae = await newActive('Rae', 'RAE');
  await orderA('1031', '2026-11-02', 'RAE', 60);
  await settle();
  assert.equal(await ledgerSum('1031'), 600);
  await as(U.mgrA, A);
  await db.query(`update affiliates set status = 'paused' where id = $1`, [rae]);
  await asSuper();
  await db.query(`update shopify_orders set refunded_subtotal = 60 where order_id = '1031'`);
  await settle();
  assert.equal(await ledgerSum('1031'), 0, 'paused means no NEW earnings, not keeping refunded ones');
  // And paused still earns nothing new.
  await orderA('1032', '2026-11-03', 'RAE', 50);
  await settle();
  assert.equal(await ledgerSum('1032'), 0);
});

await check('R3 a refund that lands between building and approving a payout blocks the approval', async () => {
  const quinn = await newActive('Quinn', 'QUINN');
  await orderA('1033', '2026-11-02', 'QUINN', 100);
  await settle();
  await as(U.mgrA, A);
  const draft = (await one(`select public.affiliate_build_payout($1, '2027-02-01') as id`, [quinn])).id;
  await asSuper();
  await db.query(`update shopify_orders set refunded_subtotal = 100 where order_id = '1033'`);
  await settle();
  await as(U.finA, A);
  await assert.rejects(db.query(`select public.affiliate_approve_payout($1)`, [draft]), /arrived after this draft was built/);
  assert.equal((await one(`select status from affiliate_payouts where id = $1`, [draft])).status, 'draft');
});

await check('R4 a period cannot be born approved, and an approved one cannot be reopened', async () => {
  await as(U.mgrA, A);
  await assert.rejects(db.query(`insert into affiliate_commission_periods(company_entity_id, program_id, period_start, period_end, status, approved_by, approved_at)
    values ($1,$2,'2027-01-01','2027-01-31','approved',$3,now())`, [A, progA, U.mgrA]), /starts open/);
  await assert.rejects(db.query(`update affiliate_commission_periods set status = 'open' where id = $1`, [period]), /cannot be reopened/);
  await assert.rejects(db.query(`update affiliate_commission_periods set period_end = '2026-12-31' where id = $1`, [period]), /cannot be reopened/);
  await assert.rejects(db.query(`update affiliate_commission_periods set approved_at = now() where id = $1`, [period]), /approve through/);
  await db.query(`update affiliate_commission_periods set note = 'reviewed twice' where id = $1`, [period]);
});

await check('R5 a row cannot point at another company\'s program, affiliate or prospect', async () => {
  await as(U.ownerA, A);
  await assert.rejects(db.query(`insert into affiliates(company_entity_id, program_id, display_name, contact_email) values ($1,$2,'x','x@cross.test')`, [A, progB]),
    /same_co|violates foreign key/);
  await asSuper();
  await assert.rejects(db.query(`insert into affiliates(company_entity_id, program_id, display_name, contact_email) values ($1,$2,'x','x@cross.test')`, [A, progB]),
    /same_co|violates foreign key/, 'not even the service role can store the inconsistent pair');
  const n = Number((await one(`select count(*) as n from pg_constraint where contype = 'f' and conname like '%\_same\_co'`)).n);
  assert.ok(n >= 15, `every affiliate-to-affiliate reference has a company twin (found ${n})`);
});

await check('R6 an anonymous application never replaces a reviewed prospect\'s email', async () => {
  await asSuper();
  await db.query(`update affiliate_prospects set status = 'approved', contact_email = 'pat@coach.test' where id = $1`, [prospect]);
  await as(U.ownerA, A);
  await db.query(`update affiliate_programs set intake_mode = 'open' where id = $1`, [progA]);
  await as(null, null);
  await db.query(`select public.affiliate_portal_apply($1,'creators','evil@attacker.test','Not Pat','youtube','@coachpat','https://youtube.com/@coachpat')`, [A]);
  const p = await one(`select contact_email, display_name, status, evidence from affiliate_prospects where id = $1`, [prospect]);
  assert.equal(p.contact_email, 'pat@coach.test');
  assert.equal(p.display_name, 'Coach Pat');
  assert.equal(p.status, 'approved');
  assert.equal(p.evidence.last_application.applicant_email, 'evil@attacker.test', 'the application is kept for a person to read');
});

await check('R7 a period\'s total is the whole period, from the database', async () => {
  await as(U.mgrA, A);
  const v = await one(`select amount_cents, entry_count from affiliate_period_totals_v where period_id = $1`, [period]);
  const l = await one(`select sum(amount_cents) as s, count(*) as n from affiliate_commission_ledger where period_id = $1`, [period]);
  assert.equal(Number(v.amount_cents), Number(l.s));
  assert.equal(Number(v.entry_count), Number(l.n));
  await as(U.ownerB, B);
  assert.equal((await all(`select * from affiliate_period_totals_v`)).length, 0, 'tenant-scoped through the ledger RLS');
});

await check('R8 the payment file is built only from payouts the database just confirmed', async () => {
  const una = await newActive('Una', 'UNA');
  await orderA('1034', '2026-11-02', 'UNA', 100);
  const vic = await newActive('Vic', 'VIC');
  await orderA('1035', '2026-11-02', 'VIC', 100);
  await settle();
  await as(U.mgrA, A);
  const p1 = (await one(`select public.affiliate_build_payout($1, '2027-02-01') as id`, [una])).id;
  const p2 = (await one(`select public.affiliate_build_payout($1, '2027-02-01') as id`, [vic])).id;
  await as(U.finA, A);
  await db.query(`select public.affiliate_approve_payout($1)`, [p1]);
  await db.query(`select public.affiliate_approve_payout($1)`, [p2]);
  // Someone else voids p2 while this page still shows it as approved.
  await db.query(`select public.affiliate_void_payout($1,'duplicate')`, [p2]);
  await as(U.mgrA, A);
  const r = (await one(`select public.affiliate_claim_payout_export($1, $2::uuid[]) as r`, [progA, `{${p1},${p2}}`])).r;
  assert.deepEqual(r.payouts.map((x) => x.id), [p1], 'the voided payout is not in the file');
  assert.deepEqual(r.skipped, [p2]);
  assert.equal((await one(`select status from affiliate_payouts where id = $1`, [p1])).status, 'exported');
  const again = (await one(`select public.affiliate_claim_payout_export($1, null, $2) as r`, [progA, r.batch_id])).r;
  assert.deepEqual(again.payouts, r.payouts, 'a lost file downloads again exactly as confirmed');
  await assert.rejects(db.query(`select public.affiliate_claim_payout_export($1, $2::uuid[])`, [progA, `{${p2}}`]), /still approved/);
  assert.equal((await one(`select public.affiliate_set_payout_export_fingerprint($1,'abc') as n`, [r.batch_id])).n, 1);
});

await check('R9 the staff gate returns the company it judged, or nothing', async () => {
  await as(U.mgrA, A);
  assert.equal((await one(`select public.affiliate_managed_company() as c`)).c, A);
  await as(U.memberA, A);
  assert.equal((await one(`select public.affiliate_managed_company() as c`)).c, null);
  await as(U.mgrAB, B);
  assert.equal((await one(`select public.affiliate_managed_company() as c`)).c, null, 'a manager of A is not one of B');
});

await check('R10 accrual, payout build and approval take the program money lock', async () => {
  // Concurrency itself cannot be exercised on single-connection PGlite; the
  // lock is pinned by structure instead.
  await asSuper();
  for (const f of ['affiliate_accrue_commissions(uuid,date,date,uuid)', 'affiliate_build_payout(uuid,date)',
                   'affiliate_approve_payout(uuid)', 'affiliate_claim_payout_export(uuid,uuid[],uuid)']) {
    const src = (await one(`select pg_get_functiondef('public.${f}'::regprocedure) as s`)).s;
    assert.match(src, /affiliate_lock_program_money\(/, f);
  }
});

// ── N: the daily drift check reads ok on this schema ─────────────────────
// The verify_v2_schema.sql blocks for this module, run as written. A guard a
// mutation removes must also turn the production drift check red.
await check('N1 verify_v2_schema.sql reads ok for order codes and Affiliate Studio', async () => {
  await asSuper();
  const verify = await readFile(new URL('../../supabase/verify_v2_schema.sql', import.meta.url), 'utf8');
  for (const name of ['Shopify order discount codes', 'Affiliate Studio']) {
    const start = verify.indexOf(`select '${name}' as check_name`);
    assert.ok(start > 0, `the ${name} check exists`);
    const end = verify.indexOf(';', verify.indexOf('end as status', start));
    const row = await one(verify.slice(start, end));
    assert.equal(row.status, 'ok', `${name}: ${row.status}`);
  }
});

await asSuper();
console.log(`affiliate-studio-database: ${passed} checks passed${MUT ? ` (mutation ${MUT} -- this should not happen)` : ''}`);
if (MUT) process.exit(0);
