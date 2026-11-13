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
//   AFFILIATE_DB_MUTATION=boundaddress  a mailed token follows a later edit of its affiliate's address
//   AFFILIATE_DB_MUTATION=rls           RLS left off affiliate_attributions
//   AFFILIATE_DB_MUTATION=pausedclaim   a paused affiliate can claim a launch
//   AFFILIATE_DB_MUTATION=anylaunch     an affiliate can claim another program's launch
//   AFFILIATE_DB_MUTATION=anyorders     the order list is the program's, not the affiliate's
//   AFFILIATE_DB_MUTATION=autoshareflag a launch is shared into a program that turned sharing off
//   AFFILIATE_DB_MUTATION=autosharepast a launch that already happened is shared
//   AFFILIATE_DB_MUTATION=autosharecrossco a launch is shared into another company's program
//   AFFILIATE_DB_MUTATION=autoshareagain editing a launch brings back one that was unshared
//   AFFILIATE_DB_MUTATION=autoshareproduct adding a product to an unshared launch shares it again
//   AFFILIATE_DB_MUTATION=autosharefails a failed share fails the launch save
//   AFFILIATE_DB_MUTATION=seedgate      anyone in the company can approve a product request
//   AFFILIATE_DB_MUTATION=seedcountsseed the seed order counts toward its own goal
//   AFFILIATE_DB_MUTATION=seedrefund    a sale counts before its refund window has passed
//   AFFILIATE_DB_MUTATION=seedanyproduct sales of other products count toward the goal
//   AFFILIATE_DB_MUTATION=seedotheraff  another affiliate's sales count toward the goal
//   AFFILIATE_DB_MUTATION=seedtwice     the payback can be written twice
//   AFFILIATE_DB_MUTATION=seedprorate   an order's refund is prorated across its products
//   AFFILIATE_DB_MUTATION=seedrefunded  a refunded or cancelled seed order still pays back
//   AFFILIATE_DB_MUTATION=seedpaystored the payback ignores a partial refund of the seed order
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
//   PayPal payouts (20261113050000):
//   AFFILIATE_DB_MUTATION=connread      a client role may read the company's PayPal credentials
//   AFFILIATE_DB_MUTATION=payoutsecret  the status view discloses client_secret
//   AFFILIATE_DB_MUTATION=sendinflight  a payout already in flight may be sent again
//   AFFILIATE_DB_MUTATION=sendunknown   an attempt that never answered may be retried blind
//   AFFILIATE_DB_MUTATION=unclaimedpaid an unclaimed payment is recorded as paid
//   AFFILIATE_DB_MUTATION=terminalrewrite a later poll may rewrite a terminal attempt
//   AFFILIATE_DB_MUTATION=sendtenant    a payout belonging to another company may be sent
//   AFFILIATE_DB_MUTATION=sendgrant     authenticated may execute the send functions
//   AFFILIATE_DB_MUTATION=voidinflight a payout with an attempt in flight may still be voided
//   AFFILIATE_DB_MUTATION=voidlock    voiding does not serialise against the send claim
//   AFFILIATE_DB_MUTATION=sandboxpaid a sandbox result marks a real payout paid
//   AFFILIATE_DB_MUTATION=sandboxblock a sandbox attempt blocks the real payment
//   AFFILIATE_DB_MUTATION=recordlock  the attempt is judged without being locked

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
-- The MCP/API role. Production has it, and the verify blocks ask whether it
-- can call a portal function, so it must exist here or the check errors.
create role silo_integration;
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
create function refresh_chat_schema_catalog() returns void language sql as $$ select $$;
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
-- The store the portal builds an affiliate's links against. Only the four
-- columns affiliate_portal_feed() reads.
create table shopify_connections (
  id uuid primary key default gen_random_uuid(), company_entity_id uuid not null,
  shop_domain text not null, is_active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table shopify_connections enable row level security;
-- The launch calendar and a launch's products, only the columns the
-- auto-share triggers read (20261113080000). Any member of the company may
-- save a launch, which is the point: sharing must not need affiliate rights.
create table launch_calendar (
  id uuid primary key default gen_random_uuid(), company_entity_id uuid not null,
  title text, launch_date date, launch_image_url text, landing_page_url text
);
alter table launch_calendar enable row level security;
create policy launch_calendar_rw on launch_calendar for all to authenticated
  using (company_entity_id = active_company_id()) with check (company_entity_id = active_company_id());
create table launch_product_readiness (
  id uuid primary key default gen_random_uuid(), company_entity_id uuid not null,
  launch_id uuid not null references launch_calendar(id) on delete cascade, product_title text
);
alter table launch_product_readiness enable row level security;
-- An order's lines, only the columns product seeding reads (20261113093000).
create table shopify_order_lines (
  id bigint generated by default as identity primary key, company_entity_id uuid not null,
  shop_domain text, order_id text not null, title text, quantity integer not null default 1,
  price numeric not null default 0, discount_allocated numeric
);
create policy launch_product_readiness_rw on launch_product_readiness for all to authenticated
  using (company_entity_id = active_company_id()) with check (company_entity_id = active_company_id());
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
  feed: '20261110150000_affiliate_portal_feed.sql',
  brands: '20261110190000_affiliate_portal_brands.sql',
  photo: '20261111020000_affiliate_rep_photo_outreach_message.sql',
  // Last, like production: it reads pg_constraint and attaches the composite
  // twins to whatever single-column affiliate references exist by then, so it
  // has to see every table above. affiliate_feed_items (feed, above) is the
  // one 20261110086000's DO block never covered, which is why this exists.
  twins: '20261111181000_affiliate_same_company_twins_function.sql',
  // The partial index the order -> code match depends on (20261112220000).
  // It is in this list because check N1 runs the production "Affiliate
  // Studio" verify block against this schema, and that block fails MISSING
  // without the index -- which is the point: a database without it cannot
  // match an affiliate order inside the 8s statement timeout.
  matchindex: '20261112220000_affiliate_order_match_index.sql',
  // The first payout rail that actually sends money (20261113050000).
  paypal: '20261113050000_affiliate_paypal_payouts.sql',
  // Affiliates claim a launch, and read their own orders (20261113070000).
  // Last, as in production: its tail CALLS attach_affiliate_same_company_twins(),
  // so the function 20261111181000 creates has to exist first.
  claims: '20261113070000_affiliate_launch_claims_and_orders.sql',
  // A launch shares itself (20261113080000). After claims: it writes the
  // parent_source_id column claims adds, and its tail calls the twins function.
  autoshare: '20261113080000_affiliate_auto_share_launches.sql',
  // Product seeding (20261113093000).
  seeding: '20261113093000_affiliate_product_seeding.sql',
  // The sweep, corrected on review (20261113220000): refunds per product,
  // the seed order re-read before the payback.
  seedsweep: '20261113220000_affiliate_seed_sweep_refunds.sql',
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
  // A paused affiliate may read their portal but must not raise a hand: the
  // brand's launch page would then name someone who is not earning.
  case 'pausedclaim':
    mutate('claims', `     and a.status = 'active';
  if not found then
    raise exception 'affiliate_portal_claim: link is not valid'`, `     and a.status in ('active', 'paused');
  if not found then
    raise exception 'affiliate_portal_claim: link is not valid'`); break;
  // The claim must be checked against the token's OWN program, or one
  // company's affiliate claims another's launch.
  case 'anylaunch':
    mutate('claims', `     and f.company_entity_id = v_tok.company_entity_id
     and f.program_id = v_tok.program_id
     and f.kind = 'launch';`, `     and f.kind = 'launch';`); break;
  // The order list is one affiliate's own, not the program's.
  case 'anyorders':
    mutate('claims', `               where l.company_entity_id = v_tok.company_entity_id
                 and l.affiliate_id = v_tok.affiliate_id
                 and l.order_id is not null`, `               where l.company_entity_id = v_tok.company_entity_id
                 and l.order_id is not null`); break;
  // Auto-share (20261113080000).
  case 'autoshareflag': mutate('autoshare', '     and p.auto_share_launches\n', '\n'); break;
  case 'autosharepast': mutate('autoshare', '     and l.launch_date >= current_date\n', '\n'); break;
  case 'autosharecrossco': mutate('autoshare', '      on p.company_entity_id = l.company_entity_id\n', '      on true\n'); break;
  case 'autoshareagain': mutate('autoshare', `  if tg_op = 'UPDATE' and old.launch_date is not null then
    return null;
  end if;`, ''); break;
  case 'autoshareproduct': mutate('autoshare', '    perform public.affiliate_autoshare_launch_products(new.launch_id);', '    perform public.affiliate_autoshare_launch(new.launch_id);'); break;
  // Product seeding (20261113093000).
  case 'seedgate': mutate('seeding', `  if v_company is null or not public.can_manage_affiliate_programs() then
    raise exception 'affiliate_seed_decide:`, `  if v_company is null then
    raise exception 'affiliate_seed_decide:`); break;
  case 'seedcountsseed': mutate('seedsweep', '       and at.order_id <> v_c.seed_order_id\n', '\n'); break;
  case 'seedrefund': mutate('seedsweep', 'least(v_today - v_c.refund_days, v_c.goal_by)', 'v_c.goal_by'); break;
  case 'seedanyproduct': mutate('seedsweep', `           and upper(o.currency) = v_c.currency
           and lower(btrim(l.title)) = lower(btrim(v_c.product_title))
         group by`, `           and upper(o.currency) = v_c.currency
         group by`); break;
  case 'seedotheraff': mutate('seedsweep', '       and at.affiliate_id = v_c.affiliate_id\n', '\n'); break;
  case 'seedwholeorder': mutate('seedsweep', `     where l.company_entity_id = v_prog.company_entity_id and l.order_id = v_o.order_id
       and lower(btrim(l.title)) = lower(btrim(v_c.product_title));`, `     where l.company_entity_id = v_prog.company_entity_id and l.order_id = v_o.order_id;`); break;
  case 'seedprorate': mutate('seedsweep', 'greatest(0, x.product_net - x.refunded)', 'x.product_net * (1 - x.refunded / 400.0)'); break;
  case 'seedrefunded': mutate('seedsweep', 'if v_seen and v_kept <= 0 then', 'if false then'); break;
  case 'seedpaystored': mutate('seedsweep', "'manual_adjustment', v_kept,", "'manual_adjustment', v_c.seed_paid_cents,"); break;
  case 'seedtwice': mutate('seedsweep', `       and c.state = 'purchased'
     for update`, `       and c.state in ('purchased', 'earned')
     for update`); break;
  case 'autosharefails': mutate('autoshare', `  exception when others then
    raise warning 'affiliate_autoshare_launch skipped for launch %: %', new.id, sqlerrm;`, `  exception when division_by_zero then
    null;`); break;
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
  // The switch stops asking whether the source token was mailed, and whose
  // address it was mailed to -- the cycle-1 hole, in the function that hands
  // out the new session.
  case 'mailedonly':
    mutate('brands', 'select t.mailed_to_hash as key, a.id as affiliate_id',
      'select public.affiliate_contact_key(a.contact_email) as key, a.id as affiliate_id');
    mutate('brands', '     and t.mailed_to_hash is not null\n     and t.revoked_at is null',
      '     and t.revoked_at is null');
    mutate('brands', '     and public.affiliate_contact_key(a.contact_email) = t.mailed_to_hash;', ';'); break;
  // The menu identifies the rep by today's contact_email instead of the
  // address its token was mailed to -- the cycle-2 hole, which a manager
  // opens by editing that field after the link was sent.
  case 'boundaddress':
    mutate('brands', 'select a.id as affiliate_id, t.mailed_to_hash as key',
      'select a.id as affiliate_id, public.affiliate_contact_key(a.contact_email) as key');
    mutate('brands', '       and public.affiliate_contact_key(a.contact_email) = t.mailed_to_hash\n  )', '  )'); break;
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
    // BOTH attachment paths, or the mutation tests nothing: 20261111181000
    // moved the same loop into a function that runs after the portal
    // migration, so neutering only the portal copy leaves the function to
    // put every twin back. Its closing assertion goes too, so the suite
    // fails on the cross-company rejection this mutation is about rather
    // than on the migration refusing to apply.
    for (const k of ['portal', 'twins']) {
      mutate(k, "       and (cl.relname = 'affiliates' or cl.relname like 'affiliate\\_%')\n       and (pl.relname", "       and false\n       and (pl.relname");
    }
    mutate('twins', "  if to_regclass('public.affiliate_feed_items') is not null", '  if false'); break;
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
  case 'photohttp': mutate('photo', "photo_url ~ '^https://[^[:space:]\"''<>()\\\\]+$'", "true"); break;
  case 'nolink': mutate('photo', " and position('{signup_link}' in outreach_body) > 0", ''); break;
  // Without the partial index the order -> code match detoasts every order in
  // its window and is cancelled at 8s, so no affiliate order can ever reach
  // Studio -- and nothing else goes red. The verify block (check N1) is what
  // makes that visible on production.
  // The identifier is replaced EVERYWHERE in that migration, its
  // `comment on index` target included: renaming only the `create index`
  // left the comment pointing at an index that no longer exists, so setup
  // threw before check N1 ran and the mutation passed for the wrong reason --
  // which the CI wrapper (any nonzero exit, output suppressed) cannot tell
  // apart. Review cycle 1, P2.
  case 'nomatchindex':
    mutate('matchindex', 'shopify_orders_co_created_coded_idx', 'shopify_orders_unused_idx'); break;
  // PayPal payouts (20261113050000):
  case 'connread':
    mutate('paypal', 'revoke all on public.affiliate_payout_connections from anon, authenticated;',
      'grant select on public.affiliate_payout_connections to authenticated;'); break;
  case 'payoutsecret':
    mutate('paypal', `    (btrim(coalesce(c.client_id, '')) <> '' and btrim(coalesce(c.client_secret, '')) <> '') as credentials_set`,
      `    c.client_secret,
    (btrim(coalesce(c.client_id, '')) <> '' and btrim(coalesce(c.client_secret, '')) <> '') as credentials_set`); break;
  case 'sendinflight':
    mutate('paypal', `     and state in ('unknown','sent','unclaimed','paid')`,
      `     and state in ('definitely-not-a-state')`); break;
  case 'sendunknown':
    mutate('paypal', `     and state in ('unknown','sent','unclaimed','paid')`,
      `     and state in ('sent','unclaimed','paid')`); break;
  case 'unclaimedpaid':
    mutate('paypal', `  if p_state <> 'paid' then`, `  if p_state not in ('paid','unclaimed') then`); break;
  case 'terminalrewrite':
    mutate('paypal', `  if v_send.state in ('paid','returned','refused') and p_state <> v_send.state then`,
      '  if false then'); break;
  case 'sendtenant':
    mutate('paypal', `  if p_company is null or v_payout.company_entity_id is distinct from p_company then
    raise exception 'affiliate_payout_send_claim: that payout belongs to another company'
      using errcode = '42501';
  end if;`, '  -- tenant check removed'); break;
  case 'voidlock':
    mutate('paypal', `  perform public.affiliate_lock_program_money(
    (select program_id from public.affiliate_payouts where id = p_payout));`, '  -- lock removed'); break;
  case 'sandboxpaid':
    mutate('paypal', `  if v_send.environment <> 'live' then
    return;
  end if;`, '  -- sandbox settles too'); break;
  case 'sandboxblock':
    mutate('paypal', "     and (environment = 'live' or environment = p_environment)", '     and true'); break;
  case 'recordlock':
    mutate('paypal', 'where id = p_send for update;', 'where id = p_send;'); break;
  case 'voidinflight':
    mutate('paypal', `  select state into v_open
    from public.affiliate_payout_sends
   where payout_id = p_payout
     and state in ('unknown','sent','unclaimed')
   order by attempt desc
   limit 1;
  if v_open is not null then`, "  select null into v_open;\n  if false then"); break;
  case 'sendgrant':
    mutate('paypal', 'grant execute on function public.affiliate_payout_send_claim(uuid, uuid, text, uuid) to service_role;',
      'grant execute on function public.affiliate_payout_send_claim(uuid, uuid, text, uuid) to service_role, authenticated;'); break;
  default: throw new Error(`unknown mutation ${MUT}`);
}

// Each is applied TWICE, which is what pins every migration here as
// idempotent -- `create index if not exists` included.
for (const k of ['orders', 'core', 'ledger', 'portal', 'feed', 'brands', 'photo', 'twins', 'matchindex', 'paypal', 'claims', 'autoshare', 'seeding', 'seedsweep']) {
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

// Shared by K9..K9d: the rep's record at the OTHER company, and a
// look-alike address that must never match it.
let patB; let evil;
await check('K9 the brand menu is this email\'s records only, and a signup link gets none', async () => {
  await asSuper();
  // The same person, same address, on a SECOND company -- which is what
  // "reps two brands" is -- plus a look-alike address that must not match.
  const progB = (await one(`insert into affiliate_programs(company_entity_id,name,slug,status,commission_percent)
                            values ($1,'Creators','creators-b','active',10) returning id`, [B])).id;
  patB = (await one(`insert into affiliates(company_entity_id, program_id, display_name, contact_email, status, terms_version_accepted, terms_accepted_at)
                     values ($1,$2,'Sam','  SAM@Creator.test ','active',1,now()) returning id`, [B, progB])).id;
  // Terminated, and in a program of its own because one address can hold only
  // one record per program.
  const progBOld = (await one(`insert into affiliate_programs(company_entity_id,name,slug,status,commission_percent)
                               values ($1,'Retired','retired-b','active',10) returning id`, [B])).id;
  const gone = (await one(`insert into affiliates(company_entity_id, program_id, display_name, contact_email, status)
                           values ($1,$2,'Sam Old','sam@creator.test','terminated') returning id`, [B, progBOld])).id;
  evil = (await one(`insert into affiliates(company_entity_id, program_id, display_name, contact_email, status, terms_version_accepted, terms_accepted_at)
                           values ($1,$2,'Someone Else','sam@creator.test.evil','active',1,now()) returning id`, [B, progBOld])).id;
  // The rep's own session: minted the way sign-in mints, so the database
  // knows the raw token went only to the address on file.
  await db.query(`select public.affiliate_portal_issue_mailed_token($1,$2,$3,'hash-sam-portal', now() + interval '1 day','sam@creator.test')`, [A, progA, affSam]);
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
  assert.ok(!rows.some((r) => r.affiliate_id === evil), 'a look-alike address is not the same address');

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
    await assert.rejects(db.query(`select public.affiliate_portal_switch_token($1,$2,'hash-new', now() + interval '1 day')`, [h, patB]),
      /cannot switch brands/);
  }
  // The binding is the whole difference, and nothing sets it by default.
  assert.deepEqual(await all(`select token_hash, mailed_to_hash is not null as bound from affiliate_access_tokens
                               where token_hash in ('hash-sam-portal','hash-staff-issued','hash-accept-returned')
                               order by token_hash`), [
    { token_hash: 'hash-accept-returned', bound: false },
    { token_hash: 'hash-sam-portal', bound: true },
    { token_hash: 'hash-staff-issued', bound: false },
  ]);
  // A mint cannot bind a token to an address that is not the affiliate's, so
  // an edit racing the mint aborts it instead of binding the wrong recipient.
  await assert.rejects(db.query(`select public.affiliate_portal_issue_mailed_token($1,$2,$3,'hash-wrong', now() + interval '1 day','someone@else.test')`,
    [A, progA, affSam]), /not the address on this affiliate/);
});

await check('K9c changing the address AFTER the link was mailed closes the door', async () => {
  await asSuper();
  // The sequence review cycle 2 named: a manager of company A holds a
  // genuinely mailed link for an affiliate whose address they control, then
  // edits that affiliate's address to a victim who reps company B. The token
  // is still a real mailed token -- but it is bound to the address it was
  // mailed to, which this affiliate no longer carries, so it fails closed.
  // In a program of its own, which is what the attack would choose: one
  // address can hold only one record per program.
  const progA2 = (await one(`insert into affiliate_programs(company_entity_id,name,slug,status,commission_percent)
                             values ($1,'Side','side-a','active',10) returning id`, [A])).id;
  const mine = (await one(`insert into affiliates(company_entity_id, program_id, display_name, contact_email, status, terms_version_accepted, terms_accepted_at)
                           values ($1,$2,'Mine','manager@a.test','active',1,now()) returning id`, [A, progA2])).id;
  await db.query(`select public.affiliate_portal_issue_mailed_token($1,$2,$3,'hash-mine', now() + interval '1 day','manager@a.test')`, [A, progA2, mine]);
  assert.deepEqual((await all(`select affiliate_id from public.affiliate_portal_brands('hash-mine')`)).map((r) => r.affiliate_id), [mine],
    'before the edit it sees only its own record');

  await as(U.mgrA, A);
  const { rowCount } = await db.query(`update affiliates set contact_email = 'sam@creator.test' where id = $1`, [mine]);
  assert.equal(rowCount, 1, 'a manager really can rewrite the address on their own company');
  await asSuper();

  assert.equal((await all(`select * from public.affiliate_portal_brands('hash-mine')`)).length, 0,
    'the mailed link does not follow the field into another company');
  await assert.rejects(db.query(`select public.affiliate_portal_switch_token('hash-mine',$1,'hash-stolen', now() + interval '1 day')`, [patB]),
    /cannot switch brands/, 'and it cannot switch to the victim\'s record either');
  assert.equal((await all(`select * from affiliate_access_tokens where token_hash = 'hash-stolen'`)).length, 0, 'nothing was minted');
});

await check('K9d a switch moves only to a record on the same mailed address', async () => {
  await asSuper();
  const before = await all(`select id from affiliate_access_tokens where token_hash = 'hash-sam-portal'`);
  assert.equal(before.length, 1);
  // The rep's own record is not a destination, and neither is a stranger's.
  for (const target of [affSam, evil]) {
    await assert.rejects(db.query(`select public.affiliate_portal_switch_token('hash-sam-portal',$1,'hash-no', now() + interval '1 day')`, [target]),
      /not on this account/);
  }
  // The sibling is, and the new token inherits the same binding.
  await db.query(`select public.affiliate_portal_switch_token('hash-sam-portal',$1,'hash-switched', now() + interval '1 day')`, [patB]);
  const t = await one(`select affiliate_id, company_entity_id, purpose, mailed_to_hash from affiliate_access_tokens where token_hash = 'hash-switched'`);
  assert.equal(t.affiliate_id, patB);
  assert.equal(t.company_entity_id, B, 'the new session belongs to the other company, and only to it');
  assert.equal(t.purpose, 'portal');
  assert.equal(t.mailed_to_hash, (await one(`select public.affiliate_contact_key('SAM@Creator.test ') as k`)).k,
    'bound to the same address, normalized, so a second switch works');
});

await check('K10 the brand menu is service-role only', async () => {
  await as(U.ownerA, A);
  // Said once more as a privilege, because the signed-in role above is only
  // one of the two client roles the browser can reach the database as.
  await asSuper();
  const granted = await all(`select r as role, f as fn
                               from unnest(array['anon','authenticated']) r,
                                    unnest(array['public.affiliate_portal_brands(text)',
                                                 'public.affiliate_portal_issue_mailed_token(uuid,uuid,uuid,text,timestamptz,text)',
                                                 'public.affiliate_portal_switch_token(text,uuid,text,timestamptz)']) f
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

// ── P: a rep's photo and the program's outreach message (20261111020000) ──
await check('P1 a rep photo must be an https address; a removed photo is a flag, not a blank', async () => {
  await asSuper();
  const aff = (await one(`insert into affiliates(company_entity_id, program_id, display_name, contact_email)
    values ($1, $2, 'Photo Rep', 'photo-rep@example.com') returning id, photo_url, photo_hidden`, [A, progA]));
  assert.equal(aff.photo_url, null);
  assert.equal(aff.photo_hidden, false, 'a new rep shows the photo found for them');
  await db.query('update affiliates set photo_url = $1 where id = $2', ['https://x.supabase.co/storage/v1/object/public/affiliate-feed-images/a/b.jpg?v=1', aff.id]);
  for (const bad of ['http://example.com/a.jpg', 'javascript:alert(1)', 'https://e.com/a.jpg" onerror="x']) {
    await assert.rejects(db.query('update affiliates set photo_url = $1 where id = $2', [bad, aff.id]), /affiliates_photo_url_https/, bad);
  }
  await db.query('delete from affiliates where id = $1', [aff.id]);
});

await check('P2 a program outreach message must keep {signup_link}; blank means SILO\'s own', async () => {
  await asSuper();
  await db.query('update affiliate_programs set outreach_subject = null, outreach_body = null where id = $1', [progA]);
  await db.query('update affiliate_programs set outreach_subject = $1, outreach_body = $2 where id = $3', ['Hi from us', 'Join here: {signup_link}', progA]);
  await assert.rejects(db.query('update affiliate_programs set outreach_body = $1 where id = $2', ['No link at all', progA]), /affiliate_programs_outreach_message/);
  await assert.rejects(db.query('update affiliate_programs set outreach_subject = $1 where id = $2', ['  ', progA]), /affiliate_programs_outreach_message/);
  await db.query('update affiliate_programs set outreach_subject = null, outreach_body = null where id = $1', [progA]);
});


// ── L: PayPal payouts -- the first rail that moves money ─────────────────
// The money is the COMPANY's, from their own PayPal to their own affiliates.
// What is tested here is the three things that make that safe: the credential
// is unreadable by every client role, one payout can never be in flight
// twice, and "paid" is something the provider said rather than something a
// person clicked.
const payProg = await seedProgram(U.ownerA, A, 'paypal-rail', { payout_method: 'paypal_payouts' });
let payAff;
let payPayout;

await check('L1 the company PayPal credential is readable by no client role', async () => {
  await asSuper();
  await db.query(`insert into affiliate_payout_connections
      (company_entity_id, provider, environment, client_id, client_secret, account_email, payouts_enabled)
    values ($1, 'paypal', 'sandbox', 'client-abc', 'secret-xyz', 'pay@a.test', true)`, [A]);
  for (const role of ['authenticated', 'anon']) {
    await db.exec(`reset role; set role ${role};`);
    await assert.rejects(db.query('select client_secret from affiliate_payout_connections'),
      /permission denied/, `${role} may not read the credential`);
  }
  await asSuper();
});

await check('L2 members see whether payouts are connected, never the credential', async () => {
  await as(U.memberA, A);
  const row = await one('select * from affiliate_payout_connection_status_v');
  assert.equal(row.credentials_set, true, 'the view says it is configured');
  assert.equal(row.account_email, 'pay@a.test');
  assert.ok(!('client_secret' in row), 'client_secret is not a column of the status view');
  assert.ok(!('client_id' in row), 'client_id is not a column of the status view');
  // Another company's connection is not visible through the definer view.
  await as(U.ownerB, B);
  assert.equal((await all('select * from affiliate_payout_connection_status_v')).length, 0);
});

await check('L3 the send functions are service-role only', async () => {
  for (const user of [U.ownerA, U.finA]) {
    await as(user, A);
    for (const fn of ['affiliate_payout_send_claim', 'affiliate_payout_send_record']) {
      assert.equal(
        (await one(`select has_function_privilege($1, p.oid, 'execute') as can
                      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.proname = $2`, ['authenticated', fn])).can,
        false, `${fn} is not executable by authenticated`);
    }
  }
  await asSuper();
});

await check('L4 a payout cannot be sent before it is approved, or without an address', async () => {
  await asSuper();
  payAff = (await one(`insert into affiliates(company_entity_id, program_id, display_name, contact_email, status,
      terms_version_accepted, terms_accepted_at)
    values ($1, $2, 'PayPal Rep', 'rep@paypal.test', 'active', 1, now()) returning id`, [A, payProg])).id;
  payPayout = (await one(`insert into affiliate_payouts
      (company_entity_id, program_id, affiliate_id, currency, amount_cents, method, status)
    values ($1, $2, $3, 'USD', 5000, 'paypal_payouts', 'draft') returning id`, [A, payProg, payAff])).id;

  await db.exec('set role service_role');
  await assert.rejects(db.query('select affiliate_payout_send_claim($1, $4, $2, $3)', [payPayout, 'sandbox', U.finA, A]),
    /only once it is approved/, 'a draft is not sendable');

  await asSuper();
  await db.query(`update affiliate_payouts set status = 'approved', approved_by = $2, approved_at = now()
    where id = $1`, [payPayout, U.finA]);

  await db.exec('set role service_role');
  await assert.rejects(db.query('select affiliate_payout_send_claim($1, $4, $2, $3)', [payPayout, 'sandbox', U.finA, A]),
    /has not given a PayPal address/, 'no address, no payment');

  await asSuper();
  await db.query(`insert into affiliate_payout_accounts
      (company_entity_id, affiliate_id, provider, payout_email) values ($1, $2, 'paypal', $3)`,
    [A, payAff, 'rep@paypal.test']);
});

await check('L4b another company\'s payout cannot be sent, even by the service role', async () => {
  await db.exec('reset role; set role service_role');
  // The id reaches this function from a request body and RLS does not apply to
  // the service role, so the company it was given is the only thing standing
  // between company B and paying company A's affiliate out of B's PayPal.
  await assert.rejects(db.query('select affiliate_payout_send_claim($1, $2, $3, $4)', [payPayout, B, 'sandbox', U.ownerB]),
    /belongs to another company/);
  await assert.rejects(db.query('select affiliate_payout_send_claim($1, $2, $3, $4)', [payPayout, null, 'sandbox', U.finA]),
    /belongs to another company/, 'and no company at all is not a pass');
  assert.equal((await one('select count(*)::int as n from affiliate_payout_sends where payout_id = $1', [payPayout])).n, 0,
    'no attempt was reserved');
});

await check('L4c nothing can be sent for an amount of nothing', async () => {
  // There is no guard for this in the send path ON PURPOSE: affiliate_payouts
  // refuses the row itself, so a zero or negative payout cannot exist to be
  // sent. That is the invariant the send path leans on, so it is asserted here.
  await asSuper();
  await assert.rejects(db.query(`insert into affiliate_payouts
      (company_entity_id, program_id, affiliate_id, currency, amount_cents, method, status)
    values ($1, $2, $3, 'USD', 0, 'paypal_payouts', 'draft')`, [A, payProg, payAff]),
    /amount_cents/, 'a payout of zero cannot be stored');
  await assert.rejects(db.query(`insert into affiliate_payouts
      (company_entity_id, program_id, affiliate_id, currency, amount_cents, method, status)
    values ($1, $2, $3, 'USD', -500, 'paypal_payouts', 'draft')`, [A, payProg, payAff]),
    /amount_cents/, 'nor a negative one');
});

await check('L5 one payout is never in flight twice', async () => {
  await db.exec('reset role; set role service_role');
  const claim = (await one('select affiliate_payout_send_claim($1, $4, $2, $3) as r', [payPayout, 'sandbox', U.finA, A])).r;
  assert.equal(claim.attempt, 1);
  assert.equal(claim.payout_email, 'rep@paypal.test');
  assert.equal(claim.amount_cents, 5000);
  // Deterministic, so the same attempt replayed is the same request to PayPal.
  assert.match(claim.request_id, /^silo-[0-9a-f]{32}-1$/);
  assert.equal(claim.sender_batch_id, claim.request_id);

  // The row exists BEFORE the provider is called, and it is state unknown:
  // the call may have been accepted, so another attempt is refused until it
  // has been reconciled.
  const send = await one('select * from affiliate_payout_sends where id = $1', [claim.send_id]);
  assert.equal(send.state, 'unknown');
  await assert.rejects(db.query('select affiliate_payout_send_claim($1, $4, $2, $3)', [payPayout, 'sandbox', U.finA, A]),
    /never reported an answer/, 'a timed-out attempt blocks a blind retry');

  // Accepted but not yet successful: still no second attempt.
  await db.query('select affiliate_payout_send_record($1, $2, $3, $4, $5)',
    [claim.send_id, 'sent', 'BATCH1', 'ITEM1', 'PENDING']);
  await assert.rejects(db.query('select affiliate_payout_send_claim($1, $4, $2, $3)', [payPayout, 'sandbox', U.finA, A]),
    /already has an attempt in state sent/);

  // Sent to an address with no PayPal account. Money has left, nobody has it,
  // and it comes back after 30 days -- so this is NOT paid.
  await db.query('select affiliate_payout_send_record($1, $2, $3, $4, $5)',
    [claim.send_id, 'unclaimed', 'BATCH1', 'ITEM1', 'UNCLAIMED']);
  assert.equal((await one('select status from affiliate_payouts where id = $1', [payPayout])).status, 'approved',
    'an unclaimed payment is not a paid payout');
});

await check('L5b a payout with a LIVE attempt in flight cannot be voided', async () => {
  // Voiding releases the commission entries so the next build can claim them.
  // With a real payment at the provider that is the same commission paid
  // twice. Its own payout, so L6 still has the attempt above to finish with.
  await asSuper();
  const vp = (await one(`insert into affiliate_payouts
      (company_entity_id, program_id, affiliate_id, currency, amount_cents, method, status, approved_by, approved_at)
    values ($1, $2, $3, 'USD', 700, 'paypal_payouts', 'approved', $4, now()) returning id`, [A, payProg, payAff, U.finA])).id;
  await db.exec('set role service_role');
  const vc = (await one('select affiliate_payout_send_claim($1, $2, $3, $4) as r', [vp, A, 'live', U.finA])).r;
  await db.query('select affiliate_payout_send_record($1, $2, $3, $4, $5)', [vc.send_id, 'sent', 'BATCHV', 'ITEMV', 'PENDING']);

  await as(U.finA, A);
  await assert.rejects(db.query(`select public.affiliate_void_payout($1, 'changed my mind')`, [vp]),
    /attempt in state sent/);
  assert.equal((await one('select status from affiliate_payouts where id = $1', [vp])).status, 'approved',
    'and it is still the payout it was');

  // Once the attempt is settled -- here the money came back -- the payout is
  // ordinary again, and can be voided or sent afresh.
  await db.exec('reset role; set role service_role');
  await db.query('select affiliate_payout_send_record($1, $2, $3, $4, $5)', [vc.send_id, 'returned', 'BATCHV', 'ITEMV', 'RETURNED']);
  await as(U.finA, A);
  await db.query(`select public.affiliate_void_payout($1, 'came back from PayPal')`, [vp]);
  assert.equal((await one('select status from affiliate_payouts where id = $1', [vp])).status, 'void');

  // A SANDBOX attempt does not hold a payout hostage: no money moved, and
  // nothing was settled from it (review cycle 1, finding 3).
  await asSuper();
  const sbx = (await one(`insert into affiliate_payouts
      (company_entity_id, program_id, affiliate_id, currency, amount_cents, method, status, approved_by, approved_at)
    values ($1, $2, $3, 'USD', 650, 'paypal_payouts', 'approved', $4, now()) returning id`, [A, payProg, payAff, U.finA])).id;
  await db.exec('set role service_role');
  const sc = (await one('select affiliate_payout_send_claim($1, $2, $3, $4) as r', [sbx, A, 'sandbox', U.finA])).r;
  await db.query('select affiliate_payout_send_record($1, $2, $3, $4, $5)', [sc.send_id, 'sent', 'BATCHS', 'ITEMS', 'PENDING']);
  await as(U.finA, A);
  await db.query(`select public.affiliate_void_payout($1, 'rehearsal only')`, [sbx]);
  assert.equal((await one('select status from affiliate_payouts where id = $1', [sbx])).status, 'void');

  // An attempt that never answered and is older than the provider's 30-day
  // duplicate window can no longer be reconciled by asking again, so a void
  // with a reason is the only way out of it. A FRESH one still cannot.
  await asSuper();
  const sp = (await one(`insert into affiliate_payouts
      (company_entity_id, program_id, affiliate_id, currency, amount_cents, method, status, approved_by, approved_at)
    values ($1, $2, $3, 'USD', 800, 'paypal_payouts', 'approved', $4, now()) returning id`, [A, payProg, payAff, U.finA])).id;
  await db.exec('set role service_role');
  const stale = (await one('select affiliate_payout_send_claim($1, $2, $3, $4) as r', [sp, A, 'live', U.finA])).r;
  await as(U.finA, A);
  await assert.rejects(db.query(`select public.affiliate_void_payout($1, 'give up')`, [sp]),
    /attempt in state unknown/, 'an attempt that has just been made is checked, not voided');
  await asSuper();
  await db.query(`update affiliate_payout_sends set created_at = now() - interval '45 days' where id = $1`, [stale.send_id]);
  await as(U.finA, A);
  await db.query(`select public.affiliate_void_payout($1, 'never showed up at PayPal')`, [sp]);
  assert.equal((await one('select status from affiliate_payouts where id = $1', [sp])).status, 'void',
    'and a month later it can be let go of');
  await asSuper();
});

await check('L6 a sandbox payment settles nothing, and a live one is the provider\'s word', async () => {
  await db.exec('reset role; set role service_role');
  const send = await one('select id, environment from affiliate_payout_sends where payout_id = $1 order by attempt desc limit 1', [payPayout]);
  assert.equal(send.environment, 'sandbox');
  await db.query('select affiliate_payout_send_record($1, $2, $3, $4, $5, null, null, $6, $7)',
    [send.id, 'paid', 'BATCH1', 'ITEM1', 'SUCCESS', 25, U.finA]);

  // PayPal's sandbox moves no money. The attempt is paid -- that is the truth
  // about the rehearsal -- and the commission is still owed.
  const afterSandbox = await one('select * from affiliate_payouts where id = $1', [payPayout]);
  assert.equal(afterSandbox.status, 'approved', 'a sandbox success does not extinguish a real commission');
  assert.equal(afterSandbox.external_reference, null);
  assert.equal(afterSandbox.paid_evidence, null);
  assert.equal(Number((await one('select fee_cents from affiliate_payout_sends where id = $1', [send.id])).fee_cents), 25);

  // And it does not make the real payment unsendable: a live attempt may still
  // be claimed on the same payout.
  const live = (await one('select affiliate_payout_send_claim($1, $2, $3, $4, $5) as r', [payPayout, A, 'live', U.finA, 'fp-live-app'])).r;
  assert.equal(live.attempt, 2);
  assert.equal(live.connection_fingerprint, 'fp-live-app', 'the attempt records which PayPal app made it');

  // The live one IS settlement, with PayPal's own ids as the evidence.
  await db.query('select affiliate_payout_send_record($1, $2, $3, $4, $5, null, null, $6, $7)',
    [live.send_id, 'paid', 'BATCH2', 'ITEM2', 'SUCCESS', 25, U.finA]);
  const p = await one('select * from affiliate_payouts where id = $1', [payPayout]);
  assert.equal(p.status, 'marked_paid');
  assert.equal(p.external_reference, 'ITEM2');
  assert.match(p.paid_evidence, /PayPal Payouts \(live\): item ITEM2 in batch BATCH2/);
  assert.equal(p.marked_paid_by, U.finA);

  // A later poll must not rewrite a fact. This is how a paid payout would
  // otherwise quietly become unpaid.
  await assert.rejects(db.query('select affiliate_payout_send_record($1, $2)', [live.send_id, 'returned']),
    /already paid and cannot become returned/);

  // A live attempt blocks everything, sandbox included: real money is in
  // flight and nothing else may touch the payout.
  await asSuper();
  const both = (await one(`insert into affiliate_payouts
      (company_entity_id, program_id, affiliate_id, currency, amount_cents, method, status, approved_by, approved_at)
    values ($1, $2, $3, 'USD', 900, 'paypal_payouts', 'approved', $4, now()) returning id`, [A, payProg, payAff, U.finA])).id;
  await db.exec('set role service_role');
  await db.query('select affiliate_payout_send_claim($1, $2, $3, $4)', [both, A, 'live', U.finA]);
  await assert.rejects(db.query('select affiliate_payout_send_claim($1, $2, $3, $4)', [both, A, 'sandbox', U.finA]),
    /never reported an answer/, 'a live attempt in flight blocks a sandbox one too');
});

await check('L6c an unclaimed LIVE payment is still not a paid payout', async () => {
  // PayPal pays an email address. An address with no PayPal account leaves the
  // item UNCLAIMED -- the money has left the company and nobody has it -- for
  // 30 days before it comes back. L5 proves this in sandbox; it has to hold
  // where the money is real, which is the only place settlement happens.
  await asSuper();
  const uc = (await one(`insert into affiliate_payouts
      (company_entity_id, program_id, affiliate_id, currency, amount_cents, method, status, approved_by, approved_at)
    values ($1, $2, $3, 'USD', 450, 'paypal_payouts', 'approved', $4, now()) returning id`, [A, payProg, payAff, U.finA])).id;
  await db.exec('set role service_role');
  const c = (await one('select affiliate_payout_send_claim($1, $2, $3, $4) as r', [uc, A, 'live', U.finA])).r;
  await db.query('select affiliate_payout_send_record($1, $2, $3, $4, $5)', [c.send_id, 'unclaimed', 'BATCHU', 'ITEMU', 'UNCLAIMED']);
  const p = await one('select status, external_reference from affiliate_payouts where id = $1', [uc]);
  assert.equal(p.status, 'approved', 'unclaimed is not paid');
  assert.equal(p.external_reference, null);
  await asSuper();
});

await check('L6b the money paths that must hold a lock, hold it', async () => {
  // Concurrency cannot be executed here -- PGlite is one backend -- so these
  // are asserted structurally against the committed function bodies. Each is
  // the lock a review found missing (cycle 1, findings 1 and 4).
  const voidDef = (await one(`select pg_get_functiondef(to_regprocedure('public.affiliate_void_payout(uuid,text)')) as d`)).d;
  const lockAt = voidDef.indexOf('affiliate_lock_program_money');
  const readAt = voidDef.indexOf('from public.affiliate_payout_sends');
  assert.ok(lockAt > -1, 'void takes the program money lock');
  assert.ok(readAt > -1 && lockAt < readAt,
    'and takes it BEFORE reading the attempts, or a claim can slip in between');
  assert.ok(voidDef.indexOf('delete from public.affiliate_payout_items') > lockAt,
    'and still holds it when the items are released');

  const recDef = (await one(`select pg_get_functiondef(to_regprocedure('public.affiliate_payout_send_record(uuid,text,text,text,text,text,text,bigint,uuid)')) as d`)).d;
  assert.match(recDef, /where id = p_send for update/,
    'the attempt is locked before its terminal transition is judged');
});

await check('L7 a refused attempt is safe to try again; the manual path still refuses this method', async () => {
  await asSuper();
  const aff2 = (await one(`insert into affiliates(company_entity_id, program_id, display_name, contact_email, status,
      terms_version_accepted, terms_accepted_at)
    values ($1, $2, 'Second Rep', 'rep2@paypal.test', 'active', 1, now()) returning id`, [A, payProg])).id;
  await db.query(`insert into affiliate_payout_accounts
      (company_entity_id, affiliate_id, provider, payout_email) values ($1, $2, 'paypal', $3)`,
    [A, aff2, 'rep2@paypal.test']);
  const po = (await one(`insert into affiliate_payouts
      (company_entity_id, program_id, affiliate_id, currency, amount_cents, method, status, approved_by, approved_at)
    values ($1, $2, $3, 'USD', 1200, 'paypal_payouts', 'approved', $4, now()) returning id`,
    [A, payProg, aff2, U.finA])).id;

  await db.exec('set role service_role');
  const first = (await one('select affiliate_payout_send_claim($1, $4, $2, $3) as r', [po, 'sandbox', U.finA, A])).r;
  await db.query('select affiliate_payout_send_record($1, $2, null, null, $3, $4, $5)',
    [first.send_id, 'refused', 'DENIED', 'RECEIVER_UNREGISTERED', 'that address is not a PayPal account']);
  assert.equal((await one('select status from affiliate_payouts where id = $1', [po])).status, 'approved',
    'a refusal leaves the payout approved, ready to try again');
  const second = (await one('select affiliate_payout_send_claim($1, $4, $2, $3) as r', [po, 'sandbox', U.finA, A])).r;
  assert.equal(second.attempt, 2, 'a refused attempt may be followed by another');
  assert.notEqual(second.request_id, first.request_id, 'and it is a NEW key, because PayPal rejects a reused one');

  // The human path is unchanged: nobody may assert a machine payment happened.
  await as(U.finA, A);
  await assert.rejects(
    db.query('select affiliate_mark_payout_paid($1, $2, $3)', [po, 'ref', 'evidence']),
    /is not implemented/, 'a PayPal payout cannot be marked paid by hand');
  await asSuper();
});

await check('L8 the rail is a value the schema accepts, and junk still is not', async () => {
  await asSuper();
  await assert.rejects(db.query(`update affiliate_programs set payout_method = 'venmo-vibes' where id = $1`, [payProg]),
    /payout_method/);
  await assert.rejects(db.query(`insert into affiliate_payout_accounts
      (company_entity_id, affiliate_id, provider, payout_email) values ($1, $2, 'carrier-pigeon', $3)`,
    [A, payAff, 'x@y.test']), /provider/);
  await assert.rejects(db.query(`insert into affiliate_payout_accounts
      (company_entity_id, affiliate_id, provider, payout_email) values ($1, $2, 'paypal', $3)`,
    [A, payAff, 'not-an-address']), /payout_email|email_shape/);
});

// ── N: the daily drift check reads ok on this schema ─────────────────────
// ── L: claiming a launch, and the affiliate's own orders (20261113070000) ──
// A claim is a SIGNAL -- it pays nothing and is not exclusive. The order list
// is the one line 20261110086000 drew and Blake asked to move: the
// affiliate's own side of each order, and nothing of the customer's.
let feedLaunch; let feedPast; let feedProduct;
await check('L1 a launch shared with a program carries its products and its claim state', async () => {
  await as(U.ownerA, A);
  feedLaunch = (await one(
    `insert into affiliate_feed_items(company_entity_id, program_id, kind, source_id, title, event_on)
     values ($1,$2,'launch','L1','Spring drop', current_date + 20) returning id`, [A, progA])).id;
  feedPast = (await one(
    `insert into affiliate_feed_items(company_entity_id, program_id, kind, source_id, title, event_on)
     values ($1,$2,'launch','L2','Old drop', current_date - 20) returning id`, [A, progA])).id;
  feedProduct = (await one(
    `insert into affiliate_feed_items(company_entity_id, program_id, kind, source_id, title, parent_source_id)
     values ($1,$2,'product','launch:L1:Wool cap','Wool cap','L1') returning id`, [A, progA])).id;
  await as(null, null);
  const f = (await one(`select public.affiliate_portal_feed('hash-pat') as f`)).f;
  const titles = f.items.map((i) => i.title);
  assert.deepEqual(titles, ['Spring drop'], 'the past launch is gone and the product is not a card of its own');
  assert.equal(f.items[0].claimed, false);
  assert.deepEqual(f.items[0].push.map((x) => x.title), ['Wool cap']);
  assert.ok(f.items[0].id, 'each item carries its id, so the portal can claim it');
});

await check('L2 claiming is idempotent, reversible, and records the launch it was for', async () => {
  await as(null, null);
  assert.equal((await one(`select public.affiliate_portal_claim('hash-pat',$1,true) as r`, [feedLaunch])).r.claimed, true);
  assert.equal((await one(`select public.affiliate_portal_claim('hash-pat',$1,true) as r`, [feedLaunch])).r.claimed, true);
  await asSuper();
  const rows = await all('select affiliate_id, launch_source_id from affiliate_launch_claims');
  assert.equal(rows.length, 1, 'claiming twice is one claim');
  assert.deepEqual([rows[0].affiliate_id, rows[0].launch_source_id], [affPat, 'L1']);
  await as(null, null);
  const f = (await one(`select public.affiliate_portal_feed('hash-pat') as f`)).f;
  assert.equal(f.items[0].claimed, true, 'the feed says so');
  assert.equal((await one(`select public.affiliate_portal_claim('hash-pat',$1,false) as r`, [feedLaunch])).r.claimed, false);
  await asSuper();
  assert.equal(Number((await one('select count(*) as n from affiliate_launch_claims')).n), 0);
  await as(null, null);
  await db.query(`select public.affiliate_portal_claim('hash-pat',$1,true)`, [feedLaunch]);
});

await check('L3 a claim is refused for a past launch, a product, a paused rep and another program', async () => {
  await as(null, null);
  await assert.rejects(db.query(`select public.affiliate_portal_claim('hash-pat',$1,true)`, [feedPast]), /already happened/);
  await assert.rejects(db.query(`select public.affiliate_portal_claim('hash-pat',$1,true)`, [feedProduct]), /no such launch/);
  // Company B's affiliate, holding their own valid portal link, cannot claim
  // company A's launch -- the id being guessable is the whole point.
  await asSuper();
  const affB = (await one(
    `insert into affiliates(company_entity_id, program_id, display_name, contact_email, status, terms_version_accepted, terms_accepted_at)
     values ($1,$2,'Bee','bee@b.test','active',1,now()) returning id`, [B, progB])).id;
  await db.query(`select public.affiliate_issue_access_token($1,$2,'portal','hash-bee',now() + interval '30 days',$3)`, [B, progB, affB]);
  await as(null, null);
  await assert.rejects(db.query(`select public.affiliate_portal_claim('hash-bee',$1,true)`, [feedLaunch]), /no such launch/);
  // A paused rep may look at their portal, but not put their hand up.
  await asSuper();
  await db.query(`update affiliates set status = 'paused' where id = $1`, [affPat]);
  await as(null, null);
  assert.ok((await one(`select public.affiliate_portal_feed('hash-pat') as f`)).f, 'a paused rep still has a feed');
  await assert.rejects(db.query(`select public.affiliate_portal_claim('hash-pat',$1,true)`, [feedLaunch]), /link is not valid/);
  await asSuper();
  await db.query(`update affiliates set status = 'active' where id = $1`, [affPat]);
});

await check('L4 the order list is this affiliate\'s own orders, and carries no customer data', async () => {
  await as(null, null);
  const o = (await one(`select public.affiliate_portal_orders('hash-pat') as o`)).o;
  assert.ok(Array.isArray(o.orders) && o.orders.length > 0, 'orders are returned');
  assert.equal(Number(o.total), o.orders.length, 'the total counts orders, not ledger lines');
  for (const row of o.orders) {
    assert.ok(row.order_id, 'every row is an order');
    assert.ok(Array.isArray(row.entries) && row.entries.length > 0, 'with the lines behind it');
  }
  const text = JSON.stringify(o);
  assert.ok(!text.includes('customer'), 'no customer data');
  // Another company's affiliate sees nothing of A's.
  const mine = o.orders.map((x) => x.order_id).sort();
  const theirs = ((await one(`select public.affiliate_portal_orders('hash-bee') as o`)).o.orders || []).map((x) => x.order_id);
  for (const id of theirs) assert.ok(!mine.includes(id), 'no cross-company order');
  // The source is the ledger: this function must never read the orders table.
  const src = (await one(`select pg_get_functiondef('public.affiliate_portal_orders(text, integer, integer)'::regprocedure) as d`)).d;
  assert.ok(!src.includes('shopify_orders'), 'built on the ledger, not the orders table');
});

await check('L5 paging is bounded and stable', async () => {
  await as(null, null);
  const page = async (lim, off) => (await one(`select public.affiliate_portal_orders('hash-pat',$1,$2) as o`, [lim, off])).o;
  const full = await page(50, 0);
  if (full.orders.length > 1) {
    const first = await page(1, 0);
    const second = await page(1, 1);
    assert.equal(first.orders.length, 1);
    assert.notEqual(first.orders[0].order_id, second.orders[0].order_id, 'page two is not page one');
  }
  const wild = await page(100000, -5);
  assert.equal(Number(wild.limit), 200, 'the page size is capped');
  assert.equal(Number(wild.offset), 0, 'a negative offset is zero');
  assert.deepEqual((await page(1, 9999)).orders, [], 'past the end is empty, not an error');
});

await check('L6 no client role may claim, read orders or read the feed', async () => {
  for (const role of ['anon', 'authenticated']) {
    for (const fn of ['public.affiliate_portal_feed(text)', 'public.affiliate_portal_claim(text, uuid, boolean)',
      'public.affiliate_portal_orders(text, integer, integer)']) {
      await asSuper();
      const r = await one(`select has_function_privilege($1, $2, 'execute') as can`, [role, fn]);
      assert.equal(r.can, false, `${role} can call ${fn}`);
    }
  }
  // And a signed-in member cannot write a claim for themselves.
  await as(U.memberA, A);
  await assert.rejects(db.query(
    `insert into affiliate_launch_claims(company_entity_id, program_id, affiliate_id, feed_item_id, launch_source_id)
     values ($1,$2,$3,$4,'L1')`, [A, progA, affPat, feedLaunch]), 'a member can write a claim');
  const seen = await all('select id from affiliate_launch_claims');
  assert.equal(seen.length, 1, 'but a member of the company may read them, for the launch page');
  await as(U.ownerB, B);
  assert.equal((await all('select id from affiliate_launch_claims')).length, 0, 'and another company reads none');
});

await check('L7 unsharing a launch withdraws its claims and its products', async () => {
  await as(U.ownerA, A);
  await db.query('delete from affiliate_feed_items where id = $1', [feedLaunch]);
  await asSuper();
  assert.equal(Number((await one('select count(*) as n from affiliate_launch_claims')).n), 0);
});

// ── M: a launch shares itself (20261113080000) ───────────────────────────
// Saving a launch puts it, and its products, in the feed of every active
// program of the same company that asks for it. Saved by a plain member, who
// has no affiliate rights: the company is the authority, not the caller.
const feedOf = async (prog) => {
  await asSuper();
  return all(`select kind, source_id, title, image_url, product_path, event_on::text as event_on, parent_source_id
                from affiliate_feed_items where program_id = $1 and (kind = 'launch' or parent_source_id is not null)
               order by kind, source_id`, [prog]);
};
let autoLaunch;
await check('M1 a new launch shares itself, with its products, into its own company only', async () => {
  await as(U.memberA, A);
  autoLaunch = (await one(
    `insert into launch_calendar(company_entity_id, title, launch_date, launch_image_url, landing_page_url)
     values ($1, 'Holiday drop', current_date + 10, 'https://cdn.test/h.png', 'https://brand.test/collections/holiday?utm=x') returning id`, [A])).id;
  await db.query(`insert into launch_product_readiness(company_entity_id, launch_id, product_title)
                  values ($1,$2,'Snow cap'), ($1,$2,'Snow cap'), ($1,$2,'  '), ($1,$2,'Scarf')`, [A, autoLaunch]);
  const f = await feedOf(progA);
  const card = f.find((x) => x.kind === 'launch' && x.source_id === autoLaunch);
  assert.ok(card, 'the launch is in the feed');
  assert.equal(card.title, 'Holiday drop');
  assert.equal(card.image_url, 'https://cdn.test/h.png');
  assert.equal(card.product_path, '/collections/holiday', 'the landing page becomes a plain path on the store');
  assert.deepEqual(f.filter((x) => x.parent_source_id === autoLaunch).map((x) => x.title).sort(), ['Scarf', 'Snow cap'],
    'each product once, blank ones skipped');
  assert.equal((await feedOf(progB)).filter((x) => x.source_id === autoLaunch || x.parent_source_id === autoLaunch).length, 0,
    'another company never sees it');
});

await check('M2 a past launch, a draft program, and a program that turned sharing off are left alone', async () => {
  await as(U.ownerA, A);
  const draftProg = (await one(`insert into affiliate_programs(company_entity_id, name, slug, status, commission_percent, currency)
                                values ($1,'Draft','draft-auto','draft',10,'USD') returning id`, [A])).id;
  const offProg = (await one(`insert into affiliate_programs(company_entity_id, name, slug, status, commission_percent, currency, auto_share_launches)
                              values ($1,'Off','off-auto','active',10,'USD', false) returning id`, [A])).id;
  await as(U.memberA, A);
  const past = (await one(`insert into launch_calendar(company_entity_id, title, launch_date) values ($1,'Old',current_date - 3) returning id`, [A])).id;
  const next = (await one(`insert into launch_calendar(company_entity_id, title, launch_date) values ($1,'Next',current_date + 3) returning id`, [A])).id;
  assert.equal((await feedOf(progA)).filter((x) => x.source_id === past).length, 0, 'a launch that already happened is not shared');
  assert.ok((await feedOf(progA)).some((x) => x.source_id === next));
  assert.equal((await feedOf(draftProg)).length, 0, 'a draft program gets nothing');
  assert.equal((await feedOf(offProg)).length, 0, 'a program with sharing off gets nothing');
});

await check('M3 a launch is shared once: unsharing it by hand is final', async () => {
  await as(U.memberA, A);
  await db.query(`update launch_calendar set title = 'Holiday drop!' where id = $1`, [autoLaunch]);
  const cards = (await feedOf(progA)).filter((x) => x.kind === 'launch' && x.source_id === autoLaunch);
  assert.equal(cards.length, 1, 'saving it again writes nothing new');
  assert.equal(cards[0].title, 'Holiday drop', 'and never rewrites what an affiliate was told');
  await as(U.ownerA, A);
  await db.query(`delete from affiliate_feed_items where program_id = $1 and (source_id = $2 or parent_source_id = $2)`, [progA, autoLaunch]);
  await as(U.memberA, A);
  await db.query(`update launch_calendar set launch_date = current_date + 11, title = 'Holiday drop' where id = $1`, [autoLaunch]);
  await db.query(`insert into launch_product_readiness(company_entity_id, launch_id, product_title) values ($1,$2,'Mittens')`, [A, autoLaunch]);
  assert.equal((await feedOf(progA)).filter((x) => x.source_id === autoLaunch || x.parent_source_id === autoLaunch).length, 0,
    'an edit or a new product does not bring an unshared launch back');
  // A launch saved without a date is shared when it first gets one.
  const undated = (await one(`insert into launch_calendar(company_entity_id, title) values ($1,'Someday') returning id`, [A])).id;
  assert.equal((await feedOf(progA)).filter((x) => x.source_id === undated).length, 0);
  await db.query(`update launch_calendar set launch_date = current_date + 30 where id = $1`, [undated]);
  assert.ok((await feedOf(progA)).some((x) => x.source_id === undated), 'and shared once it has a date');
});

await check('M4 a failed share never fails the launch save, and no client role can share by hand', async () => {
  await asSuper();
  await db.exec(`alter table affiliate_feed_items add constraint m4_refuse check (title is distinct from 'Refused')`);
  try {
    await as(U.memberA, A);
    const id = (await one(`insert into launch_calendar(company_entity_id, title, launch_date) values ($1,'Refused',current_date + 5) returning id`, [A])).id;
    assert.ok(id, 'the launch saved');
    assert.equal((await feedOf(progA)).filter((x) => x.source_id === id).length, 0, 'and was simply not shared');
  } finally {
    await asSuper();
    await db.exec('alter table affiliate_feed_items drop constraint m4_refuse');
  }
  for (const role of ['anon', 'authenticated', 'silo_integration']) {
    for (const fn of ['affiliate_autoshare_launch(uuid)', 'affiliate_autoshare_launch_products(uuid)']) {
      assert.equal((await one(`select has_function_privilege($1, $2, 'execute') as x`, [role, `public.${fn}`])).x, false, `${role} ${fn}`);
    }
  }
});

// ── S: product seeding (20261113093000) ──────────────────────────────────
// Ask (portal) -> a manager approves (makes a one-use code) -> the seed order
// -> that product's sales on the affiliate's own code, refund window passed,
// seed order excluded -> the half back, once, as a ledger line.
const SEED_CODE_TODAY = async () => (await one(`select (now() at time zone 'America/Los_Angeles')::date::text as d`)).d;
let seedShared; let seedPrivate;
await check('S1 an affiliate asks for a shared product or a private one; clients cannot write a claim', async () => {
  await as(U.ownerA, A);
  const item = (await one(`insert into affiliate_feed_items(company_entity_id, program_id, kind, source_id, title, product_path)
                           values ($1,$2,'product','snow-cap','Snow cap','/products/snow-cap') returning id`, [A, progA])).id;
  await as(null, null);
  const r1 = (await one(`select public.affiliate_portal_seed_request('hash-pat',$1,null,null) as r`, [item])).r;
  assert.equal(r1.state, 'requested');
  seedShared = r1.id;
  const again = (await one(`select public.affiliate_portal_seed_request('hash-pat',$1,null,null) as r`, [item])).r;
  assert.equal(again.id, seedShared, 'asking twice for the same product is one request');
  seedPrivate = (await one(`select public.affiliate_portal_seed_request('hash-pat',null,'  Trail jacket ','size M') as r`)).r.id;
  await assert.rejects(db.query(`select public.affiliate_portal_seed_request('hash-pat',null,'   ',null)`), /name the product/);
  await assert.rejects(db.query(`select public.affiliate_portal_seed_request('nope',null,'x',null)`), /not valid/);
  await asSuper();
  const c = await one('select product_title, product_path, discount_percent::int as pct, multiple::int as mult, refund_days from affiliate_seed_claims where id = $1', [seedShared]);
  assert.deepEqual(c, { product_title: 'Snow cap', product_path: '/products/snow-cap', pct: 50, mult: 3, refund_days: 14 }, 'the program terms are frozen on the claim');
  await as(U.ownerA, A);
  await assert.rejects(db.query(`insert into affiliate_seed_claims(company_entity_id, program_id, affiliate_id, product_title, discount_percent, multiple, refund_days, goal_days)
                                 values ($1,$2,$3,'x',50,3,14,90)`, [A, progA, affPat]), /permission denied/);
  await assert.rejects(db.query(`update affiliate_seed_claims set state = 'earned' where id = $1`, [seedShared]), /permission denied/);
  for (const fn of ['affiliate_portal_seed_request(text,uuid,text,text)', 'affiliate_portal_seeds(text)', 'affiliate_seed_sweep(uuid)']) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await one(`select has_function_privilege($1, $2, 'execute') as x`, [role, `public.${fn}`])).x, false, `${role} ${fn}`);
    }
  }
});

await check('S2 only a manager answers; approving makes a one-use code locked to the affiliate', async () => {
  await asSuper();
  if (!(await one('select 1 as x from affiliate_payout_accounts where affiliate_id = $1', [affPat]))) {
    await db.query(`insert into affiliate_payout_accounts(company_entity_id, affiliate_id, provider, payout_email) values ($1,$2,'paypal','Pat.Pay@PayPal.test')`, [A, affPat]);
  }
  await as(U.memberA, A);
  await assert.rejects(db.query('select public.affiliate_seed_decide($1, true)', [[seedShared]]), /only an Affiliate Studio manager/);
  await as(U.ownerB, B);
  assert.equal((await one('select public.affiliate_seed_decide($1, true) as r', [[seedShared]])).r.decided, 0, 'another company decides nothing');
  await as(U.ownerA, A);
  const r = (await one('select public.affiliate_seed_decide($1, true) as r', [[seedShared]])).r;
  assert.deepEqual(r, { decided: 1, skipped: 0 });
  const c = await one('select state, code, customer_email from affiliate_seed_claims where id = $1', [seedShared]);
  assert.equal(c.state, 'approved');
  assert.match(c.code, /^PATSEED[0-9A-F]{5}$/);
  assert.equal(c.customer_email, 'pat.pay@paypal.test', 'locked to the payout email, where the payback goes');
  assert.equal((await one('select public.affiliate_seed_decide($1, false) as r', [[seedPrivate]])).r.decided, 1);
  assert.equal((await one('select state from affiliate_seed_claims where id = $1', [seedPrivate])).state, 'declined');
  assert.equal((await one('select public.affiliate_seed_decide($1, true) as r', [[seedPrivate]])).r.decided, 0, 'an answer is final');
  await as(null, null);
  const portal = (await one(`select public.affiliate_portal_seeds('hash-pat') as r`)).r;
  const mine = portal.claims.find((x) => x.id === seedShared);
  assert.equal(mine.code, null, 'the code is not handed out before it exists in the shop');
  assert.equal(mine.email, 'pat.pay@paypal.test', 'but they are told which email to buy with');
});

await check('S3 the seed order sets the goal; only that product, their own code, past the refund window, counts', async () => {
  await asSuper();
  // Time travel: the claim was approved 60 days ago.
  await db.query(`update affiliate_seed_claims set decided_at = now() - interval '60 days' where id = $1`, [seedShared]);
  const code = (await one('select code from affiliate_seed_claims where id = $1', [seedShared])).code;
  const ord = async (id, codes, daysAgo, subtotal, lines, refunded = 0) => {
    await db.query(`insert into shopify_orders(company_entity_id, shop_domain, order_id, order_number, currency, subtotal_price, refunded_subtotal, discount_codes, shopify_created_at)
                    values ($1,'a.myshopify.com',$2,$3,'USD',$4,$5,$6::jsonb, now() - ($7 || ' days')::interval)`,
      [A, id, '#' + id, subtotal, refunded, JSON.stringify(codes), String(daysAgo)]);
    for (const [title, qty, price, disc] of lines) {
      await db.query(`insert into shopify_order_lines(company_entity_id, shop_domain, order_id, title, quantity, price, discount_allocated) values ($1,'a.myshopify.com',$2,$3,$4,$5,$6)`,
        [A, id, title, qty, price, disc]);
    }
  };
  const attr = async (id, aff, daysAgo, basis = 'single_affiliate_code') => db.query(
    `insert into affiliate_attributions(company_entity_id, program_id, affiliate_id, shop_domain, order_id, order_day, order_currency, codes_on_order, basis)
     values ($1,$2,$3,'a.myshopify.com',$4,(now() at time zone 'America/Los_Angeles')::date - $5::int,'USD',1,$6)`, [A, progA, aff, id, daysAgo, basis]);
  // The seed purchase: $40 cap at 50% = $20 paid, plus a sock at full price.
  // It ALSO carries Pat's affiliate code, so it is an attributed order -- and
  // must still not count toward its own goal.
  await ord('S-SEED', [code.toLowerCase(), 'PATAFF'], 50, 32, [['Snow cap', 1, 40, 20], ['Sock', 1, 12, 0]]);
  await attr('S-SEED', affPat, 50);
  let r = (await one('select public.affiliate_seed_sweep($1) as r', [progA])).r;
  assert.equal(r.purchased, 1);
  let c = await one('select state, seed_paid_cents::int as paid, goal_cents::int as goal, progress_cents::int as prog from affiliate_seed_claims where id = $1', [seedShared]);
  assert.deepEqual(c, { state: 'purchased', paid: 2000, goal: 6000, prog: 0 }, 'they get back what they paid for THAT item (not the sock); the goal is 3x what they paid; the seed order counts nothing');
  // Sales: 30 days ago, 2 caps at $40 = $80, half refunded -> $40 counts.
  await ord('S-1', ['PATAFF'], 30, 80, [['Snow cap', 2, 40, 0]], 40); await attr('S-1', affPat, 30);
  // Another product on Pat's code: does not count.
  await ord('S-2', ['PATAFF'], 30, 500, [['Trail jacket', 1, 500, 0]]); await attr('S-2', affPat, 30);
  // Sam's sale of the cap: not Pat's.
  await ord('S-3', ['SAMAFF'], 30, 400, [['Snow cap', 10, 40, 0]]); await attr('S-3', affSam, 30);
  // Pat's cap sale 5 days ago: still inside the 14-day refund window.
  await ord('S-4', ['PATAFF'], 5, 400, [['Snow cap', 10, 40, 0]]); await attr('S-4', affPat, 5);
  // Mixed carts. Refunds are stored per order, so an order's refund comes off
  // this product's lines in full, never prorated: a cap bought with a jacket
  // and then refunded counts nothing (a share of the order would credit $36).
  await ord('S-6', ['PATAFF'], 30, 400, [['Snow cap', 1, 40, 0], ['Trail jacket', 1, 360, 0]], 40); await attr('S-6', affPat, 30);
  r = (await one('select public.affiliate_seed_sweep($1) as r', [progA])).r;
  c = await one('select state, progress_cents::int as prog from affiliate_seed_claims where id = $1', [seedShared]);
  assert.deepEqual(c, { state: 'purchased', prog: 4000 }, '$40 of $60: refunds netted, other products, other affiliates and fresh sales left out');
  assert.equal(r.earned, 0);
});

await check('S4 reaching the goal writes the payback once, through the ledger and nothing else', async () => {
  await asSuper();
  // Two more caps, 20 days ago: $40 + $80 = $120 >= $60.
  await db.query(`insert into shopify_orders(company_entity_id, shop_domain, order_id, currency, subtotal_price, discount_codes, shopify_created_at)
                  values ($1,'a.myshopify.com','S-5','USD',80,'["PATAFF"]'::jsonb, now() - interval '20 days')`, [A]);
  await db.query(`insert into shopify_order_lines(company_entity_id, shop_domain, order_id, title, quantity, price) values ($1,'a.myshopify.com','S-5','snow cap ',2,40)`, [A]);
  await db.query(`insert into affiliate_attributions(company_entity_id, program_id, affiliate_id, shop_domain, order_id, order_day, order_currency, codes_on_order, basis)
                  values ($1,$2,$3,'a.myshopify.com','S-5',(now() at time zone 'America/Los_Angeles')::date - 20,'USD',1,'single_affiliate_code')`, [A, progA, affPat]);
  const before = Number((await one(`select count(*) as n from affiliate_commission_ledger where memo like 'Product seeding%'`)).n);
  const r = (await one('select public.affiliate_seed_sweep($1) as r', [progA])).r;
  assert.equal(r.earned, 1);
  await one('select public.affiliate_seed_sweep($1) as r', [progA]);
  await one('select public.affiliate_seed_sweep($1) as r', [progA]);
  const lines = await all(`select amount_cents::int as amt, kind, order_id, order_day from affiliate_commission_ledger where memo like 'Product seeding%'`);
  assert.equal(lines.length - before, 1, 'three sweeps, one payback');
  assert.deepEqual(lines[lines.length - 1], { amt: 2000, kind: 'manual_adjustment', order_id: null, order_day: null }, 'exactly what they paid, payable at once, not an order');
  const c = await one('select state, reimbursement_ledger_id is not null as paid from affiliate_seed_claims where id = $1', [seedShared]);
  assert.deepEqual(c, { state: 'earned', paid: true });
  await as(null, null);
  const portal = (await one(`select public.affiliate_portal_seeds('hash-pat') as r`)).r;
  assert.equal(portal.claims.find((x) => x.id === seedShared).state, 'earned');
  assert.equal(portal.offer.percent, 50);
});

await check('S4b a seed order refunded or cancelled before the goal pays back only what is still paid', async () => {
  await asSuper();
  const claim = (title, code, order) => one(`insert into affiliate_seed_claims(company_entity_id, program_id, affiliate_id, product_title, discount_percent, multiple, refund_days, goal_days,
                           state, code, customer_email, seed_order_id, seed_order_day, currency, seed_paid_cents, goal_cents, goal_by)
                         values ($1,$2,$3,$4,50,3,14,90,'purchased',$5,'p@x.test',$6,current_date - 40,'USD',2000,6000,current_date + 50)
                         returning id`, [A, progA, affPat, title, code, order]).then((x) => x.id);
  const ord = async (id, daysAgo, refunded, lines, cancelled = false) => {
    await db.query(`insert into shopify_orders(company_entity_id, shop_domain, order_id, currency, subtotal_price, refunded_subtotal, discount_codes, shopify_created_at, cancelled_at)
                    values ($1,'a.myshopify.com',$2,'USD',0,$3,'["PATAFF"]'::jsonb, now() - ($4 || ' days')::interval, case when $5 then now() end)`,
      [A, id, refunded, String(daysAgo), cancelled]);
    for (const [title, qty, price, disc] of lines) {
      await db.query(`insert into shopify_order_lines(company_entity_id, shop_domain, order_id, title, quantity, price, discount_allocated) values ($1,'a.myshopify.com',$2,$3,$4,$5,$6)`,
        [A, id, title, qty, price, disc]);
    }
  };
  // Each seed order: a $40 shell at 50% = $20. Rain: returned in full. Mud:
  // the order cancelled. Wind: $17 refunded off a cart that also held a $12
  // sock -- at most $3 of the shell is still paid for.
  const rain = await claim('Rain shell', 'PATSEEDRAIN', 'S-RAIN'); await ord('S-RAIN', 40, 20, [['Rain shell', 1, 40, 20]]);
  const mud = await claim('Mud shell', 'PATSEEDMUD', 'S-MUD'); await ord('S-MUD', 40, 0, [['Mud shell', 1, 40, 20]], true);
  const wind = await claim('Wind shell', 'PATSEEDWIND', 'S-WIND'); await ord('S-WIND', 40, 17, [['Wind shell', 1, 40, 20], ['Sock', 1, 12, 0]]);
  // Then each goal is reached: $80 of each shell sold on Pat's code.
  for (const t of ['Rain', 'Mud', 'Wind']) {
    await ord(`S-${t}-SALE`, 20, 0, [[`${t} shell`, 2, 40, 0]]);
    await db.query(`insert into affiliate_attributions(company_entity_id, program_id, affiliate_id, shop_domain, order_id, order_day, order_currency, codes_on_order, basis)
                    values ($1,$2,$3,'a.myshopify.com',$4,(now() at time zone 'America/Los_Angeles')::date - 20,'USD',1,'single_affiliate_code')`, [A, progA, affPat, `S-${t}-SALE`]);
  }
  await one('select public.affiliate_seed_sweep($1) as r', [progA]);
  const st = async (id) => one(`select c.state, c.progress_cents::int as prog, l.amount_cents::int as amt
                                  from affiliate_seed_claims c left join affiliate_commission_ledger l on l.id = c.reimbursement_ledger_id where c.id = $1`, [id]);
  assert.deepEqual(await st(rain), { state: 'cancelled', prog: 8000, amt: null }, 'a returned seed product pays nothing back, goal or not');
  assert.deepEqual(await st(mud), { state: 'cancelled', prog: 8000, amt: null }, 'a cancelled seed order pays nothing back');
  assert.deepEqual(await st(wind), { state: 'earned', prog: 8000, amt: 300 }, 'a partly refunded seed order pays back only what is still paid');
});

await check('S5 a claim past its goal date and refund window expires, paying nothing', async () => {
  await asSuper();
  const id = (await one(`insert into affiliate_seed_claims(company_entity_id, program_id, affiliate_id, product_title, discount_percent, multiple, refund_days, goal_days,
                           state, code, customer_email, seed_order_id, seed_order_day, currency, seed_paid_cents, goal_cents, goal_by)
                         values ($1,$2,$3,'Old hat',50,3,14,90,'purchased','PATSEEDOLD1','p@x.test','S-OLD',current_date - 200,'USD',1000,3000,current_date - 110)
                         returning id`, [A, progA, affPat])).id;
  const r = (await one('select public.affiliate_seed_sweep($1) as r', [progA])).r;
  assert.equal(r.expired, 1);
  assert.equal((await one('select state from affiliate_seed_claims where id = $1', [id])).state, 'expired');
});

// The verify_v2_schema.sql blocks for this module, run as written. A guard a
// mutation removes must also turn the production drift check red.
await check('N1 verify_v2_schema.sql reads ok for order codes and Affiliate Studio', async () => {
  await asSuper();
  const verify = await readFile(new URL('../../supabase/verify_v2_schema.sql', import.meta.url), 'utf8');
  for (const name of ['Shopify order discount codes', 'Affiliate Studio', 'Affiliate rep photo and outreach message',
    'Affiliate PayPal payouts', 'Affiliate launch claims', 'Affiliate auto-share launches', 'Affiliate product seeding']) {
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
