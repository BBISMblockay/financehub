// AI credit billing, executed against the real migrations as real roles.
//
// What is proven here is not that the tables exist -- it is the properties
// that make a credit balance safe to charge against:
//
//   1. NO CLIENT TOUCHES THE LEDGER. anon and authenticated cannot read the
//      tables or call a metering/grant RPC. The only client path is
//      ai_credit_summary(), scoped to the active company, customer dollars only.
//   2. NOTHING IS CHARGED THAT WAS NOT HELD, NOTHING IS HELD THAT IS NOT THERE.
//   3. ONLY SUCCESS CHARGES. failed / timed_out / cancelled / interrupted = 0.
//   4. EVERY GRANT AND CHARGE IS IDEMPOTENT: duplicate webhooks, a second
//      settle, a replayed request id.
//   5. THE LEDGER RECONCILES with the balances and the open holds.
//
// Pricing values below are TEST FIXTURES, not SILO's configuration.
//
// Mutations (each must make the suite fail):
//   AI_CREDIT_MUTATION=no-hold-check      (a hold is taken whatever is available)
//   AI_CREDIT_MUTATION=failure-charges    (a failed operation is charged)
//   AI_CREDIT_MUTATION=settle-twice       (a settled reservation settles again)
//   AI_CREDIT_MUTATION=grant-any-invoice  (a proration/manual invoice grants credit)
//   AI_CREDIT_MUTATION=charge-uncapped    (a charge may exceed its hold)
//   AI_CREDIT_MUTATION=summary-open       (summary does not require membership)
//   AI_CREDIT_MUTATION=included-rolls-over (last period's allowance survives a renewal)
//   AI_CREDIT_MUTATION=expiry-ignores-holds (expiry takes included credit an open hold needs)
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e && e.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const mutation = process.env.AI_CREDIT_MUTATION || '';
const MUTATIONS = {
  'included-rolls-over': [`      perform public.ai_credit_expire_included(p_company, v_start);`, ``],
  'expiry-ignores-holds': [`  select greatest(0, coalesce(p_acct.included_micros, 0)
                     - greatest(0, coalesce(p_acct.held_micros, 0) - coalesce(p_acct.purchased_micros, 0)));`,
    `  select greatest(0, coalesce(p_acct.included_micros, 0));`],
  'no-hold-check': [`  if avail < need then
    return jsonb_build_object('ok', false, 'mode', s.mode, 'reason', 'insufficient_credit',`,
    `  if false then
    return jsonb_build_object('ok', false, 'mode', s.mode, 'reason', 'insufficient_credit',`],
  'failure-charges': [`    if p_outcome = 'succeeded' then
      charge := least(coalesce(computed, 0), r.held_micros);
    end if;`, `    charge := least(coalesce(computed, 0), r.held_micros);
    p_outcome := 'succeeded';`],
  'settle-twice': [`  if r.status = 'settled' then
    return jsonb_build_object('ok', true, 'repeated', true,`,
    `  if false then
    return jsonb_build_object('ok', true, 'repeated', true,`],
  'grant-any-invoice': [`  if coalesce(p_invoice->>'billing_reason','') not in ('subscription_create','subscription_cycle') then`,
    `  if false then`],
  'charge-uncapped': [`      charge := least(coalesce(computed, 0), r.held_micros);`, `      charge := coalesce(computed, 0);`],
  'summary-open': [`  if v_uid is null or v_co is null or not exists (
      select 1 from public.profiles p
        join public.entity_memberships m on m.user_id = p.id and m.entity_id = v_co
       where p.id = v_uid and p.is_active) then`, `  if false then`],
};
assert.ok(mutation === '' || mutation in MUTATIONS, `Unknown mutation ${mutation}`);

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

async function as(user, fn, role = 'authenticated') {
  await db.exec('set role ' + role);
  await q("select set_config('request.jwt.claim.sub',$1,false)", [user || '']);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const svc = (fn) => as(null, fn, 'service_role');
const call = async (fn, args) => (await one(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args)).r;

// ── Cast ──────────────────────────────────────────────────────────────────
const owner = randomUUID(), member = randomUUID(), disabled = randomUUID(), rival = randomUUID();
const A = randomUUID(), B = randomUUID();
await db.exec(await read('scripts/tests/stripe-db-bootstrap.sql'));
await q(`insert into auth.users(id,email) values ($1,'o@a.test'),($2,'m@a.test'),($3,'d@a.test'),($4,'r@b.test')`,
  [owner, member, disabled, rival]);
await q(`insert into public.entities(id,module,entity_type,entity_key,title) values
  ($1,'finance_hub','company','a','A'),($2,'finance_hub','company','b','B')`, [A, B]);
await q(`insert into public.profiles(id,email,role,is_active,active_company_id) values
  ($1,'o@a.test','owner',true,$5),($2,'m@a.test','user',true,$5),($3,'d@a.test','user',false,$5),($4,'r@b.test','owner',true,$6)`,
  [owner, member, disabled, rival, A, B]);
await q(`insert into public.entity_memberships(entity_id,user_id,role) values
  ($1,$3,'owner_admin'),($1,$4,'member'),($1,$5,'member'),($2,$6,'owner_admin')`, [A, B, owner, member, disabled, rival]);

await db.exec(await read('supabase/migrations/20260919120000_stripe_billing_and_connect.sql'));
let sql = await read('supabase/migrations/20261001120000_ai_credit_billing.sql');
if (mutation) {
  const [before, after] = MUTATIONS[mutation];
  assert.ok(sql.includes(before), `mutation ${mutation} matched nothing`);
  sql = sql.replace(before, () => after);
}
await db.exec(sql);
await db.exec(sql); // idempotent

// Test fixtures (NOT SILO's configuration): 1.5x, simple round rates.
const MODEL = 'claude-test';
await q(`insert into public.billing_plans(plan_key,title,stripe_price_id,unit_amount_cents,included_ai_credit_micros)
  values ('silo','Silo Plan','price_silo',50000,30000000)`);
await q(`insert into public.billing_subscriptions(company_entity_id,stripe_customer_id,stripe_subscription_id,plan_key,status,
  current_period_start,current_period_end) values ($1,'cus_A','sub_A','silo','active',now()-interval '1 day',now()+interval '29 days'),
  ($2,'cus_B','sub_B','silo','active',now()-interval '1 day',now()+interval '29 days')`, [A, B]);
await q(`insert into public.ai_provider_rates(model,effective_from,input_micros_per_token,output_micros_per_token,
  cache_read_micros_per_token,cache_write_5m_micros_per_token,cache_write_1h_micros_per_token,web_search_micros_per_request)
  values ($1, now()-interval '1 day', 2, 10, 0.2, 2.5, 4, 10000)`, [MODEL]);
await q(`insert into public.ai_credit_packs(pack_key,title,stripe_price_id,unit_amount_cents,credit_micros)
  values ('p50','$50 credit','price_p50',5000,50000000)`);

const setMode = (mode) => q(`insert into public.ai_billing_settings(id,mode,customer_multiplier_bps) values (true,$1,15000)
  on conflict (id) do update set mode = excluded.mode`, [mode]);
const open = (req, { company = A, user = owner, input = 1000, output = 1000, web = 0, calls = 1, feature = 'ask_silo', model = MODEL } = {}) =>
  svc(() => call('ai_credit_open', [req, company, user, feature, model, input, output, web, calls, null]));
const step = (req, usage, input = 1000, output = 1000) => svc(() => call('ai_credit_step', [req, usage, input, output, 0]));
const settle = (req, usage, outcome = 'succeeded') => svc(() => call('ai_credit_settle', [req, usage, outcome, null]));
const account = (company = A) => one('select * from public.ai_credit_accounts where company_entity_id=$1', [company]);
const reconciled = async () => {
  const rows = await q('select * from public.ai_credit_reconcile()');
  for (const r of rows) assert.equal(r.ok, true, `ledger does not reconcile for ${r.company_entity_id}: ${JSON.stringify(r)}`);
};
const invoice = (over = {}) => ({
  id: 'in_' + randomUUID().slice(0, 8), customer: 'cus_A', status: 'paid', amount_paid: 50000,
  billing_reason: 'subscription_cycle', subscription: 'sub_A',
  lines: { data: [{ price: { id: 'price_silo' }, period: { start: 1790000000, end: 1792592000 } }] }, ...over,
});
const session = (over = {}) => ({
  id: 'cs_' + randomUUID().slice(0, 8), mode: 'payment', payment_status: 'paid', customer: 'cus_A',
  payment_intent: 'pi_' + randomUUID().slice(0, 8),
  metadata: { silo_purpose: 'ai_credit_topup', silo_company_entity_id: A, silo_credit_pack: 'p50' }, ...over,
});

// ── 1. Boundary ─────────────────────────────────────────────────────────────
await test('clients cannot read the ledger, balances, holds or private pricing', async () => {
  for (const role of ['anon', 'authenticated']) {
    for (const t of ['ai_credit_ledger', 'ai_credit_accounts', 'ai_credit_reservations', 'ai_provider_rates', 'ai_billing_settings']) {
      await assert.rejects(() => as(owner, () => q(`select * from public.${t}`), role), /permission denied/, `${role} read ${t}`);
    }
  }
});

await test('clients cannot call any metering or grant function', async () => {
  for (const role of ['anon', 'authenticated']) {
    for (const f of ['ai_credit_open(uuid,uuid,uuid,text,text,bigint,bigint,integer,integer,text)',
      'ai_credit_step(uuid,jsonb,bigint,bigint,integer)', 'ai_credit_settle(uuid,jsonb,text,text)',
      'ai_credit_sweep(uuid,interval)', 'ai_credit_grant_included(uuid,jsonb)', 'ai_credit_grant_purchase(uuid,jsonb)',
      'ai_credit_add(uuid,text,bigint,text,text,text,text,text,text,text,timestamptz,timestamptz)', 'ai_credit_reconcile(uuid)',
      'ai_credit_expire_included(uuid,timestamptz)']) {
      assert.equal((await one('select has_function_privilege($1,$2,\'execute\') ok', [role, 'public.' + f])).ok, false, `${role} ${f}`);
    }
  }
  assert.equal((await one("select has_function_privilege('anon','public.ai_credit_summary()','execute') ok")).ok, false);
});

await test('top-up packs are a readable catalogue; clients cannot write them', async () => {
  const rows = await as(member, () => q('select pack_key from public.ai_credit_packs'));
  assert.deepEqual(rows.map((r) => r.pack_key), ['p50']);
  await assert.rejects(() => as(owner, () => q("update public.ai_credit_packs set credit_micros = 1")), /permission denied/);
});

// ── 2. Modes ────────────────────────────────────────────────────────────────
await test('with no settings row the feature is OFF and writes nothing', async () => {
  const r = await open(randomUUID());
  assert.deepEqual(r, { ok: true, mode: 'off' });
  assert.equal((await one('select count(*)::int n from public.ai_credit_reservations')).n, 0);
  const s = await as(owner, () => call('ai_credit_summary', []));
  assert.equal(s.state, 'unconfigured');
  assert.equal(s.available_micros, null, 'no account must read as unknown, not $0');
});

await test('shadow mode prices usage without holding or deducting', async () => {
  await setMode('shadow');
  const req = randomUUID();
  assert.equal((await open(req)).ok, true);
  const out = await settle(req, { input: 1000, output: 100 });
  // 1000*2 + 100*10 = 3000 provider micros -> 4500 customer
  assert.equal(out.charged_micros, 0);
  assert.equal(out.customer_cost_micros, 4500);
  assert.equal((await one('select count(*)::int n from public.ai_credit_ledger')).n, 0);
  assert.equal(await account(), undefined);
});

await test('an abandoned shadow-mode operation is swept too, never left pending', async () => {
  const stale = randomUUID();
  await open(stale);
  await q("update public.ai_credit_reservations set last_activity_at = now() - interval '1 hour' where id=$1", [stale]);
  const next = randomUUID();
  await open(next);
  const r = await one('select status, outcome from public.ai_credit_reservations where id=$1', [stale]);
  assert.deepEqual([r.status, r.outcome], ['settled', 'interrupted']);
  await settle(next, null, 'cancelled');
});

// ── 3. Grants ───────────────────────────────────────────────────────────────
await setMode('enforce');
await test('an empty balance refuses before any model call', async () => {
  const r = await open(randomUUID());
  assert.equal(r.ok, false); assert.equal(r.reason, 'insufficient_credit');
});

await test('a paid period invoice grants the plan allowance exactly once', async () => {
  const inv = invoice();
  assert.equal((await svc(() => call('ai_credit_grant_included', [A, inv]))).granted, true);
  // Duplicate webhook, a different invoice for the same period (re-delivery after an edit): no second grant.
  assert.equal((await svc(() => call('ai_credit_grant_included', [A, inv]))).reason, 'already_granted');
  assert.equal((await svc(() => call('ai_credit_grant_included', [A, { ...inv, id: 'in_other' }]))).reason, 'already_granted');
  assert.equal(Number((await account()).included_micros), 30000000);
  await reconciled();
});

await test('unpaid, zero-amount, proration and manual invoices grant nothing', async () => {
  const cases = [
    [{ status: 'open' }, 'not_paid'], [{ amount_paid: 0 }, 'zero_amount'],
    [{ billing_reason: 'subscription_update' }, 'not_a_period_invoice'],
    [{ billing_reason: 'manual', subscription: null }, 'not_a_period_invoice'],
  ];
  for (const [over, reason] of cases) {
    const lines = { data: [{ price: { id: 'price_silo' }, period: { start: 1795000000 + Math.floor(Math.random() * 1e5), end: 1797600000 } }] };
    assert.equal((await svc(() => call('ai_credit_grant_included', [A, invoice({ ...over, lines })]))).reason, reason);
  }
  assert.equal(Number((await account()).included_micros), 30000000);
});

await test('the next period grants again and last period\'s allowance does NOT roll over (basil shape)', async () => {
  // Spend a little of period 1's allowance first, so the expiry is of a remainder.
  await svc(() => call('ai_credit_add', [A, 'purchase_grant', 1000000, 'purchase:pre-roll', null, null, null, null, null, 'pi_pre_roll', null, null]));
  const inv = invoice({ subscription: undefined, parent: { subscription_details: { subscription: 'sub_A' } },
    lines: { data: [{ pricing: { price_details: { price: 'price_silo' } }, period: { start: 1792592000, end: 1795184000 } }] } });
  assert.equal((await svc(() => call('ai_credit_grant_included', [A, inv]))).granted, true);
  const a = await account();
  assert.equal(Number(a.included_micros), 30000000, 'only the new period\'s allowance');
  assert.equal(Number(a.purchased_micros), 1000000, 'top-up credit rolls over untouched');
  const exp = await one(`select amount_micros from public.ai_credit_ledger where company_entity_id=$1 and entry_type='included_expiry'`, [A]);
  assert.equal(Number(exp.amount_micros), -30000000);
  // A replay of the new period's invoice neither grants nor expires again.
  assert.equal((await svc(() => call('ai_credit_grant_included', [A, inv]))).reason, 'already_granted');
  assert.equal(Number((await account()).included_micros), 30000000);
  await reconciled();
});

await test('an invoice for another company\'s customer is refused, not credited', async () => {
  await assert.rejects(() => svc(() => call('ai_credit_grant_included', [A, invoice({ customer: 'cus_B' })])), /not this company/);
});

await test('a paid top-up credits the PACK amount once per payment intent', async () => {
  const s = session({ amount_total: 1 }); // the amount on the session is never what is credited
  assert.equal((await svc(() => call('ai_credit_grant_purchase', [A, s]))).granted, true);
  assert.equal((await svc(() => call('ai_credit_grant_purchase', [A, s]))).reason, 'already_granted');
  // The async_payment_succeeded event for the same session/payment intent.
  assert.equal((await svc(() => call('ai_credit_grant_purchase', [A, { ...s, id: 'cs_again' }]))).reason, 'already_granted');
  assert.equal(Number((await account()).purchased_micros), 51000000);
  await reconciled();
});

await test('unpaid, foreign and non-top-up sessions credit nothing', async () => {
  assert.equal((await svc(() => call('ai_credit_grant_purchase', [A, session({ payment_status: 'unpaid' })]))).reason, 'not_paid');
  assert.equal((await svc(() => call('ai_credit_grant_purchase', [A, session({ mode: 'subscription' })]))).reason, 'not_a_topup');
  await assert.rejects(() => svc(() => call('ai_credit_grant_purchase', [A, session({ metadata: { silo_purpose: 'ai_credit_topup', silo_company_entity_id: B, silo_credit_pack: 'p50' } })])), /another company/);
  await assert.rejects(() => svc(() => call('ai_credit_grant_purchase', [A, session({ customer: 'cus_B' })])), /not this company/);
  assert.equal(Number((await account()).purchased_micros), 51000000);
});

// ── 4. Holds and charges ────────────────────────────────────────────────────
await test('a request holds, steps, and is charged only what it used -- included credit first', async () => {
  const req = randomUUID();
  const o = await open(req, { calls: 2 });
  // worst call: 1000*4 + 1000*10 = 14000 provider -> 21000 customer, x2
  assert.equal(o.ok, true); assert.equal(o.held_micros, 42000);
  assert.equal(Number((await account()).held_micros), 42000);
  const st = await step(req, { input: 1000, output: 500 }); // spent 7000*1.5=10500; target 10500+42000
  assert.equal(st.held_micros, 52500);
  await reconciled();
  const out = await settle(req, { input: 2000, output: 800, cache_read: 1000, web_search: 1 });
  // 2000*2 + 800*10 + 1000*0.2 + 10000 = 22200 -> 33300
  assert.equal(out.charged_micros, 33300);
  const a = await account();
  assert.equal(Number(a.held_micros), 0);
  assert.equal(Number(a.included_micros), 30000000 - 33300);
  assert.equal(Number(a.purchased_micros), 51000000);
  await reconciled();
});

await test('settle is idempotent: a second settle charges nothing more', async () => {
  const req = randomUUID();
  await open(req);
  await settle(req, { input: 100, output: 10 });
  const before = await account();
  const again = await settle(req, { input: 999999, output: 999999 });
  assert.equal(again.repeated, true);
  assert.deepEqual(await account(), before);
  await reconciled();
});

await test('a replayed request id is refused as a duplicate, never a second hold', async () => {
  const req = randomUUID();
  await open(req);
  const r = await open(req);
  assert.equal(r.reason, 'duplicate');
  assert.equal((await one('select count(*)::int n from public.ai_credit_reservations where id=$1', [req])).n, 1);
  await settle(req, null, 'cancelled');
  await reconciled();
});

await test('failed, timed-out, cancelled and interrupted operations are free', async () => {
  for (const outcome of ['failed', 'timed_out', 'cancelled', 'interrupted']) {
    const req = randomUUID();
    await open(req);
    const before = await account();
    const out = await settle(req, { input: 5000, output: 5000 }, outcome);
    assert.equal(out.charged_micros, 0, outcome);
    const after = await account();
    assert.equal(after.included_micros, before.included_micros, outcome);
    assert.equal(Number(after.held_micros), Number(before.held_micros) - 21000, outcome);
    // provider cost is still recorded, for SILO
    const r = await one('select provider_cost_micros from public.ai_credit_reservations where id=$1', [req]);
    assert.ok(Number(r.provider_cost_micros) > 0, `${outcome} records provider cost`);
  }
  await reconciled();
});

await test('a charge never exceeds its hold, even when usage overshoots the estimate', async () => {
  const req = randomUUID();
  await open(req); // holds 21000
  const out = await settle(req, { input: 100000, output: 100000 });
  assert.equal(out.charged_micros, 21000);
  const r = await one('select computed_charge_micros c from public.ai_credit_reservations where id=$1', [req]);
  assert.ok(Number(r.c) > 21000, 'the overshoot is recorded, and absorbed');
  await reconciled();
});

await test('charges spill from included into purchased credit, never below zero', async () => {
  // Drain included to a small remainder by granting B-free arithmetic on A.
  const a = await account();
  const included = Number(a.included_micros);
  const req = randomUUID();
  // Hold enough to cover the remainder + 1000 micros of purchased credit.
  const input = Math.ceil((included + 1000) / 1.5 / 4) + 10;
  assert.equal((await open(req, { input, output: 0 })).ok, true);
  const out = await settle(req, { input: Math.ceil((included + 1000) / 3) + 1, output: 0 });
  const b = await account();
  assert.equal(Number(b.included_micros), 0);
  assert.equal(Number(b.purchased_micros), 51000000 - (out.charged_micros - included));
  const entries = await q('select bucket, amount_micros from public.ai_credit_ledger where reservation_id=$1 order by bucket', [req]);
  assert.deepEqual(entries.map((e) => e.bucket), ['included', 'purchased']);
  await reconciled();
});

await test('concurrent holds cannot spend the same balance', async () => {
  // Leave exactly enough for one more 2-call hold on company B.
  await svc(() => call('ai_credit_add', [B, 'purchase_grant', 50000, 'purchase:test-b', null, null, null, null, null, 'pi_test_b', null, null]));
  const r1 = randomUUID(), r2 = randomUUID();
  const first = await open(r1, { company: B, user: rival, calls: 2 });
  const second = await open(r2, { company: B, user: rival, calls: 2 });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false); assert.equal(second.reason, 'insufficient_credit');
  assert.equal(second.available_micros, 50000 - 42000);
  await settle(r1, { input: 10, output: 10 });
  // A refused id was never recorded, so it can be retried once credit frees up.
  assert.equal((await open(r2, { company: B, user: rival, calls: 2 })).ok, true);
  await settle(r2, null, 'cancelled');
  await reconciled();
});

await test('a step that cannot grow keeps the existing hold for a final answer', async () => {
  const req = randomUUID();
  const o = await open(req, { company: B, user: rival, input: 10, output: 10 });
  assert.equal(o.ok, true);
  const st = await step(req, { input: 10, output: 10 }, 1000000, 8192);
  assert.equal(st.ok, false); assert.equal(st.reason, 'insufficient_credit');
  assert.equal(st.held_micros, o.held_micros);
  const out = await settle(req, { input: 10, output: 10 });
  assert.ok(out.charged_micros <= o.held_micros);
  await reconciled();
});

await test('an interrupted request is swept free and its hold returned', async () => {
  const req = randomUUID();
  await open(req);
  await q("update public.ai_credit_reservations set last_activity_at = now() - interval '1 hour' where id=$1", [req]);
  const heldBefore = Number((await account()).held_micros);
  assert.equal(await svc(() => call('ai_credit_sweep', [A, '15 minutes'])), 1);
  const r = await one('select status, outcome, charged_micros from public.ai_credit_reservations where id=$1', [req]);
  assert.deepEqual([r.status, r.outcome, Number(r.charged_micros)], ['settled', 'interrupted', 0]);
  assert.equal(Number((await account()).held_micros), heldBefore - 21000);
  await reconciled();
});

await test('a stranger, a disabled user and an unpriced model are refused', async () => {
  assert.equal((await open(randomUUID(), { user: rival })).reason, 'not_a_member');
  assert.equal((await open(randomUUID(), { user: disabled })).reason, 'not_a_member');
  assert.equal((await open(randomUUID(), { model: 'unknown-model' })).reason, 'unpriced_model');
});

// ── Included credit expires with its period; top-ups do not ───────────────
const C = randomUUID(), cOwner = randomUUID();
await q(`insert into auth.users(id,email) values ($1,'c@c.test')`, [cOwner]);
await q(`insert into public.entities(id,module,entity_type,entity_key,title) values ($1,'finance_hub','company','c','C')`, [C]);
await q(`insert into public.profiles(id,email,role,is_active,active_company_id) values ($1,'c@c.test','owner',true,$2)`, [cOwner, C]);
await q(`insert into public.entity_memberships(entity_id,user_id,role) values ($1,$2,'owner_admin')`, [C, cOwner]);
await q(`insert into public.billing_subscriptions(company_entity_id,stripe_customer_id,stripe_subscription_id,plan_key,status)
  values ($1,'cus_C','sub_C','silo','active')`, [C]);
const pastPeriod = { start: Math.floor(Date.now() / 1000) - 40 * 86400, end: Math.floor(Date.now() / 1000) - 10 * 86400 };

await test('a lapsed period\'s allowance reads as expired at once, and is removed on the next request', async () => {
  await svc(() => call('ai_credit_grant_included', [C, invoice({ customer: 'cus_C', subscription: 'sub_C',
    lines: { data: [{ price: { id: 'price_silo' }, period: pastPeriod }] } })]));
  await svc(() => call('ai_credit_add', [C, 'purchase_grant', 2000000, 'purchase:c', null, null, null, null, null, 'pi_c', null, null]));
  // Read-only summary: the allowance is shown as gone, the top-up is not.
  const before = await as(cOwner, () => call('ai_credit_summary', []));
  assert.equal(before.included_micros, 0);
  assert.equal(before.purchased_micros, 2000000);
  assert.equal(before.available_micros, 2000000);
  assert.equal(before.included_expires_at, null);
  assert.equal(Number((await account(C)).included_micros), 30000000, 'nothing written by a read');
  // The next request expires it in the ledger, then runs on top-up credit.
  const req = randomUUID();
  assert.equal((await open(req, { company: C, user: cOwner })).ok, true);
  const a = await account(C);
  assert.equal(Number(a.included_micros), 0);
  assert.equal(Number(a.purchased_micros), 2000000, 'top-up credit never expires');
  await settle(req, { input: 100, output: 10 });
  assert.equal(Number((await account(C)).purchased_micros), 2000000 - 450);
  await reconciled();
});

await test('included credit needed to cover an in-flight hold is not expired out from under it', async () => {
  const D = randomUUID(), dOwner = randomUUID();
  await q(`insert into auth.users(id) values ($1)`, [dOwner]);
  await q(`insert into public.entities(id,module,entity_type,entity_key,title) values ($1,'finance_hub','company','d','D')`, [D]);
  await q(`insert into public.profiles(id,role,is_active,active_company_id) values ($1,'owner',true,$2)`, [dOwner, D]);
  await q(`insert into public.entity_memberships(entity_id,user_id,role) values ($1,$2,'owner_admin')`, [D, dOwner]);
  await q(`insert into public.billing_subscriptions(company_entity_id,stripe_customer_id,stripe_subscription_id,plan_key,status)
    values ($1,'cus_D','sub_D','silo','active')`, [D]);
  const now = Math.floor(Date.now() / 1000);
  await svc(() => call('ai_credit_grant_included', [D, invoice({ customer: 'cus_D', subscription: 'sub_D',
    lines: { data: [{ price: { id: 'price_silo' }, period: { start: now - 86400, end: now + 3600 } }] } })]));
  const req = randomUUID();
  assert.equal((await open(req, { company: D, user: dOwner })).ok, true); // holds 21000 against included only
  // The period ends while the request is in flight.
  const expired = await svc(() => call('ai_credit_expire_included', [D, new Date(Date.now() + 7200e3).toISOString()]));
  assert.equal(Number(expired), 30000000 - 21000);
  assert.equal(Number((await account(D)).included_micros), 21000);
  const out = await settle(req, { input: 100, output: 10 });
  assert.equal(out.charged_micros, 450, 'the request still settles from what was kept for it');
  // The rest goes on the next pass (a second, numbered expiry of the same grant).
  assert.equal(Number(await svc(() => call('ai_credit_expire_included', [D, new Date(Date.now() + 7200e3).toISOString()]))), 21000 - 450);
  assert.equal(Number((await account(D)).included_micros), 0);
  await reconciled();
});

await test('ledger and rates are append-only', async () => {
  await assert.rejects(() => q('update public.ai_credit_ledger set amount_micros = 1'), /append-only/);
  await assert.rejects(() => q('delete from public.ai_credit_ledger'), /append-only/);
  await assert.rejects(() => q('update public.ai_provider_rates set input_micros_per_token = 0'), /immutable/);
});

// ── 5. The customer read path ───────────────────────────────────────────────
await test('summary shows the active company only, in customer dollars only', async () => {
  const s = await as(owner, () => call('ai_credit_summary', []));
  const a = await account();
  assert.equal(s.state, 'active');
  assert.equal(s.available_micros, Number(a.included_micros) + Number(a.purchased_micros) - Number(a.held_micros));
  assert.equal(s.plan_included_micros, 30000000);
  assert.equal(s.can_top_up, true);
  const ask = s.usage_by_feature.find((f) => f.feature === 'ask_silo');
  const charged = await one(`select sum(charged_micros)::bigint n from public.ai_credit_reservations
     where company_entity_id=$1 and feature='ask_silo' and outcome='succeeded' and enforced`, [A]);
  assert.equal(ask.charged_micros, Number(charged.n), 'usage card reconciles with the ledger');
  assert.equal(s.used_this_period_micros, Number(charged.n));
  const text = JSON.stringify(s);
  for (const leak of ['provider', 'multiplier', 'bps', 'rate', 'input_micros']) assert.ok(!text.includes(leak), `summary leaks ${leak}`);

  const sB = await as(rival, () => call('ai_credit_summary', []));
  assert.equal(sB.available_micros, Number((await account(B)).included_micros) + Number((await account(B)).purchased_micros) - Number((await account(B)).held_micros));
  assert.notEqual(sB.available_micros, s.available_micros);
});

await test('a member sees the balance but not the usage or purchase detail', async () => {
  const s = await as(member, () => call('ai_credit_summary', []));
  assert.equal(typeof s.available_micros, 'number');
  assert.equal(s.usage_by_feature, undefined);
  assert.equal(s.purchases, undefined);
  assert.equal(s.can_top_up, false);
});

await test('a disabled user and an outsider get no summary', async () => {
  await assert.rejects(() => as(disabled, () => call('ai_credit_summary', [])), /membership required/);
  const stranger = randomUUID();
  await q(`insert into auth.users(id) values ($1)`, [stranger]);
  await q(`insert into public.profiles(id,role,is_active,active_company_id) values ($1,'user',true,$2)`, [stranger, A]);
  await assert.rejects(() => as(stranger, () => call('ai_credit_summary', [])), /membership required/);
});

await test('verify_v2_schema.sql reports the AI credit ledger ok against this schema', async () => {
  const v = await read('supabase/verify_v2_schema.sql');
  const check = v.slice(v.lastIndexOf("select 'AI credit ledger'"));
  assert.equal((await one(check)).status, 'ok');
});

console.log(`\n${passed} assertions passed${mutation ? ` (mutation ${mutation})` : ''}`);
