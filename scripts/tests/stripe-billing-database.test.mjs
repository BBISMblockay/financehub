// Stripe billing + Connect, executed against the real migration as real roles.
//
// The scoped ask was "Stripe for SILO's subscription, and Connect so clients
// invoice their own customers". Most of what is proven here is not that the
// tables exist -- it is the properties that separate a MIRROR of an external
// money system from a second, contradictory one:
//
//   1. NO CLIENT WRITES A MIRROR. Not a finance user, not an owner-admin.
//      Every row arrives through a SECURITY DEFINER sync function from an
//      object Stripe returned. A client-writable invoice row is an invoice
//      SILO claims to have sent and Stripe has never heard of.
//   2. THE TWO STRIPE SURFACES CANNOT BE CROSSED. A platform event carrying a
//      connected account is refused rather than attributed; an account bound
//      to one company cannot be re-bound to another; an invoice cannot name
//      company A with company B's Stripe account.
//   3. AN OLDER FETCH NEVER OVERWRITES A NEWER ONE. Stripe does not order its
//      webhooks, so last-write-wins reverts paid invoices to open at random.
//      Proven twice: through the sync function, and through the trigger that
//      backstops a writer going round it (the service role bypasses RLS, so a
//      policy could never be that backstop).
//   4. A RETRY DOES NOT INVOICE A CUSTOMER TWICE. The lost response -- not the
//      failed transaction -- is the retry that actually happens.
//   5. THE INVOICING GATE IS NARROWER THAN is_admin_user(). 28 of 29
//      Baseballism profiles are membership 'admin'; if the two gates admitted
//      the same people, the separate function would be decoration.
//
// Mutations (each must make a specific assertion fail):
//   STRIPE_MUTATION=mirror-writable   (an insert policy for authenticated on the invoice mirror)
//   STRIPE_MUTATION=gate-is-admin     (can_manage_client_invoices := is_admin_user)
//   STRIPE_MUTATION=stale-wins        (both staleness guards removed)
//   STRIPE_MUTATION=account-rebind    (the account-already-owned check removed)
//   STRIPE_MUTATION=ledger-amnesia    (the idempotency claim always reports a fresh request)
//   STRIPE_MUTATION=platform-takes-account (a platform event with an account id is attributed)
//   STRIPE_MUTATION=lines-upserted    (invoice lines merged instead of replaced)
//   STRIPE_MUTATION=sync-open-to-anon (the revoke on the sync layer removed)
//   STRIPE_MUTATION=placeholder-claims-now (the checkout placeholder stamps now())
// Added after the cycle-2 review:
//   STRIPE_MUTATION=webhook-no-reclaim   (the event claim goes back to insert-or-nothing)
//   STRIPE_MUTATION=connect-rebind-allowed (a company may be moved to a second Stripe account)
//   STRIPE_MUTATION=connect-unclaimed    (concurrent first-time setup is unguarded)
// Added after the cycle-3 review:
//   STRIPE_MUTATION=lease-reads-terminal (a leased delivery reports as finished)
//   STRIPE_MUTATION=failed-always-fresh  (a failure that created a draft is re-claimable)
//   STRIPE_MUTATION=line-price-strict    (the decimal-string unit price read strictly again)
//   STRIPE_MUTATION=subscription-any-identity (a stale sub's terminal event overwrites the live one)
//   STRIPE_MUTATION=checkout-claim-unguarded  (two requests may both claim a checkout)
//   STRIPE_MUTATION=checkout-release-unscoped (a release ignores which session it saw)
//   STRIPE_MUTATION=checkout-takeover-rotates  (a takeover mints a new attempt id)
//   STRIPE_MUTATION=checkout-note-silent       (a note that lands nowhere reports success)
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e && e.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from './finance-db/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const mutation = process.env.STRIPE_MUTATION || '';
assert.ok([
  '', 'mirror-writable', 'gate-is-admin', 'stale-wins', 'account-rebind',
  'ledger-amnesia', 'platform-takes-account', 'lines-upserted', 'sync-open-to-anon',
  'placeholder-claims-now', 'webhook-no-reclaim', 'connect-rebind-allowed', 'connect-unclaimed',
  'lease-reads-terminal', 'failed-always-fresh', 'line-price-strict',
  'subscription-any-identity', 'checkout-claim-unguarded', 'checkout-release-unscoped',
  'checkout-takeover-rotates', 'checkout-note-silent',
].includes(mutation), `Unknown stripe mutation: ${mutation}`);

const db = new PGlite({ extensions: { pgcrypto } });
const root = new URL('../../', import.meta.url);
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };
const refused = async (fn, pattern, what) => {
  await assert.rejects(fn, pattern, what);
  passed += 1; console.log(`ok ${passed} - refused: ${what}`);
};

async function as(user, fn, role = 'authenticated') {
  await db.exec('set role ' + role);
  await q("select set_config('request.jwt.claim.sub',$1,false)", [user || '']);
  try { return await fn(); } finally { await db.exec('reset role'); }
}

// ── Cast ─────────────────────────────────────────────────────────────────────
const blake = randomUUID();       // owner_admin + department exec, company A
const finance = randomUUID();     // membership admin, department finance -- may invoice
const ops = randomUUID();         // membership admin, department ops -- may NOT invoice
const viewer = randomUUID();      // membership member, no department
const rival = randomUUID();       // owner_admin of company B
const companyA = randomUUID();
const companyB = randomUUID();

await db.exec(await readFile(new URL('./stripe-db-bootstrap.sql', import.meta.url), 'utf8'));
// Mutations that rewrite the migration TEXT (the rest run after it is applied).
const PRE_APPLY = new Set([
  'gate-is-admin', 'stale-wins', 'account-rebind', 'platform-takes-account', 'lines-upserted',
  'sync-open-to-anon', 'placeholder-claims-now', 'webhook-no-reclaim', 'connect-rebind-allowed',
  'connect-unclaimed', 'lease-reads-terminal', 'failed-always-fresh', 'line-price-strict',
  'subscription-any-identity', 'checkout-claim-unguarded', 'checkout-release-unscoped',
  'checkout-takeover-rotates', 'checkout-note-silent',
]);


await q(`insert into auth.users(id,email) values
  ($1,'blake@baseballism.com'),($2,'finance@baseballism.com'),
  ($3,'ops@baseballism.com'),($4,'viewer@baseballism.com'),($5,'owner@rival.test')`,
  [blake, finance, ops, viewer, rival]);
await q(`insert into public.entities(id,module,entity_type,entity_key,source,title) values
  ($1,'finance_hub','company','baseballism','seed','Baseballism'),
  ($2,'finance_hub','company','rival','seed','Rival Co')`, [companyA, companyB]);
await q(`insert into public.profiles(id,email,role,department,active_company_id) values
  ($1,'blake@baseballism.com','owner','exec',$6),
  ($2,'finance@baseballism.com','admin','finance',$6),
  ($3,'ops@baseballism.com','admin','ops',$6),
  ($4,'viewer@baseballism.com','user',null,$6),
  ($5,'owner@rival.test','owner','exec',$7)`,
  [blake, finance, ops, viewer, rival, companyA, companyB]);
await q(`insert into public.entity_memberships(entity_id,user_id,role) values
  ($1,$3,'owner_admin'),($1,$4,'admin'),($1,$5,'admin'),($1,$6,'member'),($2,$7,'owner_admin')`,
  [companyA, companyB, blake, finance, ops, viewer, rival]);

// ── Apply the migration under test ──────────────────────────────────────────
const sqlAsWritten = await readFile(
  new URL('supabase/migrations/20260919120000_stripe_billing_and_connect.sql', root), 'utf8');
let sql = sqlAsWritten;

if (mutation === 'gate-is-admin') {
  // The tempting simplification: reuse the gate 47 other policies already use.
  // A function replacement, not a string: `$$` in a replacement string is an
  // escape for a single `$`, which silently produced invalid SQL the first
  // time this mutation was written -- so it "failed" for the wrong reason.
  sql = sql.replace(
    /create or replace function public\.can_manage_client_invoices\(\)[\s\S]*?\n\$\$;/,
    () => [
      'create or replace function public.can_manage_client_invoices() returns boolean',
      "language sql stable security definer set search_path to 'public'",
      'as $$ select public.is_admin_user() $$;',
    ].join('\n'));
}
if (mutation === 'stale-wins') {
  sql = sql.replace(/if v_id is not null and v_existing > p_synced_at then return v_id; end if;/g, '')
           .replace(/if v_existing is not null and v_existing > p_synced_at then return; end if;/g, '')
           .replace(/if new\.stripe_synced_at < old\.stripe_synced_at then\n    return null;  -- skip the UPDATE entirely; the newer row stands\n  end if;/,
                    '');
}
if (mutation === 'account-rebind') {
  sql = sql.replace(
    /if v_owner is not null and v_owner <> p_company then\n    raise exception 'stripe_sync_connect_account[^\n]*\n  end if;/,
    '');
}
if (mutation === 'platform-takes-account') {
  sql = sql.replace(
    /if p_account is not null then\n      raise exception 'stripe_resolve_event_company: platform event carries account[^\n]*\n    end if;/,
    '');
}
if (mutation === 'lines-upserted') {
  sql = sql.replace('delete from public.stripe_invoice_lines where invoice_id = v_id;', '')
           .replace(`  from jsonb_array_elements(coalesce(p_payload->'lines'->'data', '[]'::jsonb)) as l
  where l->>'id' is not null;`,
                    `  from jsonb_array_elements(coalesce(p_payload->'lines'->'data', '[]'::jsonb)) as l
  where l->>'id' is not null
  on conflict (invoice_id, stripe_line_id) do nothing;`);
}
if (mutation === 'placeholder-claims-now') {
  sql = sql.replace("values (p_company, p_customer, 'incomplete', '-infinity'::timestamptz)",
                    () => "values (p_company, p_customer, 'incomplete', now())");
}
if (mutation === 'webhook-no-reclaim') {
  // The original: dedupe Stripe's retries, and silently swallow the retry the
  // endpoint asked for by returning 500.
  sql = sql.replace(
    /  on conflict \(stripe_event_id\) do update\n[\s\S]*?           and stripe_webhook_events\.received_at < now\(\) - interval '10 minutes'\);/,
    () => '  on conflict (stripe_event_id) do nothing;');
}
if (mutation === 'connect-rebind-allowed') {
  // The pre-fix state is BOTH halves: the guard gone AND the upsert assigning
  // the account id again. Removing only the guard proves nothing, because the
  // upsert no longer carries a new id forward -- which is itself deliberate,
  // so that relaxing the guard alone cannot quietly restore the rebind.
  const before = sql;
  sql = sql.replace(
    /  select stripe_account_id into v_bound\n[\s\S]*?      v_bound, v_account;\n  end if;\n/,
    () => '');
  assert.notEqual(sql, before, 'connect-rebind-allowed: the guard was not found to remove');
  sql = sql.replace(
    `  on conflict (company_entity_id) do update set
    -- stripe_account_id is deliberately NOT updated here. The guard above
    -- already refuses a different one, so assigning it could only ever be a
    -- no-op -- and leaving the assignment in place would quietly restore the
    -- rebind the moment somebody relaxed that guard.
    account_type      = excluded.account_type,`,
    () => `  on conflict (company_entity_id) do update set
    stripe_account_id = excluded.stripe_account_id,
    account_type      = excluded.account_type,`);
}
if (mutation === 'connect-unclaimed') {
  // The claim always succeeds, so two concurrent setups both create.
  sql = sql.replace(
    /create or replace function public\.stripe_claim_connect_setup\([\s\S]*?\n\$\$;/,
    () => [
      'create or replace function public.stripe_claim_connect_setup(p_company uuid, p_user uuid default null)',
      'returns table (outcome text, stripe_account_id text)',
      "language sql security definer set search_path to 'public'",
      'as $$ select \'claimed\'::text, null::text $$;',
    ].join('\n'));
}
if (mutation === 'lease-reads-terminal') {
  sql = sql.replace(
    "  if v_status in ('processed', 'ignored') then return 'terminal'; end if;\n  return 'leased';",
    () => "  return 'terminal';");
}
if (mutation === 'failed-always-fresh') {
  sql = sql.replace("  if r.status = 'failed' and r.stripe_object_id is null then",
                    () => "  if r.status = 'failed' then");
}
if (mutation === 'checkout-claim-unguarded') {
  // The claim degrades to "always yours", which is what no claim at all looks
  // like from the caller: both concurrent requests are told to create.
  sql = sql.replace(
    `    where public.billing_checkout_claims.stripe_session_id is null
      and public.billing_checkout_claims.claimed_at < now() - interval '10 minutes'
  returning (xmax = 0) into v_inserted;`,
    () => '  returning (xmax = 0) into v_inserted;');
}
if (mutation === 'checkout-takeover-rotates') {
  // The original bug: a takeover diverges from the dead attempt's Stripe key.
  sql = sql.replace(`    set claimed_by = excluded.claimed_by,
        claimed_at = now()`,
    () => `    set claimed_by = excluded.claimed_by,
        claimed_at = now(),
        attempt_id = gen_random_uuid()`);
}
if (mutation === 'checkout-note-silent') {
  sql = sql.replace('  return v_rows = 1;', () => '  return true;');
}
if (mutation === 'checkout-release-unscoped') {
  sql = sql.replace(`  delete from public.billing_checkout_claims
   where company_entity_id = p_company
     and stripe_session_id = p_session;`,
    () => `  delete from public.billing_checkout_claims where company_entity_id = p_company;`);
}
if (mutation === 'line-price-strict') {
  sql = sql.replace("public.stripe_decimal_cents(l,'unit_amount_excluding_tax')",
                    () => "public.stripe_cents(l,'unit_amount_excluding_tax')");
}
if (mutation === 'subscription-any-identity') {
  sql = sql.replace(/  if v_stored_sub is not null\n(?:.*\n)*?  then\n    return;\n  end if;\n/,
                    () => '');
}
if (mutation === 'sync-open-to-anon') {
  sql = sql.replace(
    "execute format('revoke all on function public.%s from public, anon, authenticated', f);", '');
}

// A pre-apply mutation that matched nothing is worse than no mutation: the
// suite passes, the CI loop reports "the guard survived deletion", and the
// real cause is a string that drifted. This caught `checkout-claim-unguarded`
// the moment its target gained a RETURNING clause.
assert.ok(!mutation || PRE_APPLY.has(mutation) === (sql !== sqlAsWritten),
  `mutation ${mutation} changed nothing -- its target string has drifted`);

await db.exec(sql);

await test('the migration is re-appliable (apply_all_post_merge.sql promises it)', async () => {
  await db.exec(sql);
});

// The post-apply mutations land AFTER the re-apply above: re-executing the
// migration would restore what they remove, and the suite would pass while
// claiming to have tested a mutant.
if (mutation === 'mirror-writable') {
  // The change somebody makes when the page needs to "just save a draft".
  await db.exec(`create policy stripe_invoices_write on public.stripe_invoices
                   for all to authenticated
                   using (company_entity_id = public.active_company_id())
                   with check (company_entity_id = public.active_company_id());
                 grant insert, update, delete on public.stripe_invoices to authenticated;`);
}
if (mutation === 'ledger-amnesia') {
  await db.exec(`create or replace function public.stripe_begin_invoice_request(
      p_request_id uuid, p_company uuid, p_account text, p_action text,
      p_user uuid default null, p_fingerprint text default null)
    returns table (already boolean, status text, stripe_object_id text)
    language sql security definer set search_path to 'public' as $$
      select false, 'pending'::text, null::text;
    $$;`);
}

// ── 1. The gate is narrower than is_admin_user() ────────────────────────────
await test('an ops admin passes is_admin_user() and is refused invoicing', async () => {
  await as(ops, async () => {
    assert.equal((await one('select public.is_admin_user() as v')).v, true,
      'fixture check: a membership admin must pass is_admin_user, or this proves nothing');
    assert.equal((await one('select public.can_manage_client_invoices() as v')).v, false,
      'a membership admin in ops must NOT be able to bill customers');
  });
});

await test('finance, exec and owner_admin may invoice', async () => {
  for (const u of [finance, blake]) {
    await as(u, async () => {
      assert.equal((await one('select public.can_manage_client_invoices() as v')).v, true);
    });
  }
});

// ── 2. Seed the connected accounts through the sync layer ───────────────────
const acctA = 'acct_A00000000000001';
const acctB = 'acct_B00000000000002';
const syncAccount = (company, account, extra = {}) => q(
  'select public.stripe_sync_connect_account($1,$2,$3)',
  [company, JSON.stringify({
    id: account, type: 'standard', country: 'US', default_currency: 'usd',
    charges_enabled: true, payouts_enabled: true, details_submitted: true,
    business_profile: { name: 'Test' }, requirements: { currently_due: [] },
    ...extra,
  }), new Date().toISOString()]);

await syncAccount(companyA, acctA);
await syncAccount(companyB, acctB);

await test('a connected account is recorded with its capabilities', async () => {
  const row = await one('select * from public.stripe_connect_accounts where company_entity_id=$1', [companyA]);
  assert.equal(row.stripe_account_id, acctA);
  assert.equal(row.charges_enabled, true);
  assert.ok(row.onboarding_completed_at, 'a chargeable account records when it became chargeable');
});

if (mutation !== 'account-rebind') {
  await refused(
    () => syncAccount(companyB, acctA),
    /already belongs to another company/,
    "company B cannot claim company A's Stripe account");
} else {
  await test('MUTANT: the rebind guard is gone (this run must fail below)', async () => {
    // The unique index on stripe_account_id still refuses the write, so the
    // tenant boundary survives -- but by accident, and the operator now sees a
    // raw constraint violation instead of a sentence naming the problem. This
    // asserts the readable refusal, which is what the check is for.
    await assert.rejects(() => syncAccount(companyB, acctA),
      /already belongs to another company/,
      'without the explicit check, only the unique index stands between two tenants');
  });
}

// ── 3. Invoices: the mirror, its tenancy, and its staleness guard ───────────
const invoicePayload = (id, over = {}) => ({
  id,
  customer: 'cus_1',
  customer_name: 'Acme Sporting Goods',
  customer_email: 'ap@acme.test',
  number: 'BB-0001',
  status: 'open',
  currency: 'usd',
  subtotal: 125000, total: 125000, amount_due: 125000, amount_paid: 0, amount_remaining: 125000,
  collection_method: 'send_invoice',
  due_date: Math.floor(Date.UTC(2026, 8, 1) / 1000),
  hosted_invoice_url: 'https://invoice.stripe.com/x',
  lines: { data: [
    { id: 'il_1', description: 'Spring order', quantity: 10, amount: 100000,
      price: { unit_amount: 10000 }, currency: 'usd' },
    { id: 'il_2', description: 'Freight', quantity: 1, amount: 25000,
      price: { unit_amount: 25000 }, currency: 'usd' },
  ] },
  ...over,
});

const syncInvoice = (company, account, payload, at) => one(
  'select public.stripe_sync_invoice($1,$2,$3,$4) as id',
  [company, account, JSON.stringify(payload), at]);

const t1 = '2026-09-19T10:00:00Z';
const t2 = '2026-09-19T10:05:00Z';
const invA = (await syncInvoice(companyA, acctA, invoicePayload('in_A1'), t1)).id;

await test('an invoice and its lines are mirrored from the Stripe object', async () => {
  const row = await one('select * from public.stripe_invoices where id=$1', [invA]);
  assert.equal(row.status, 'open');
  assert.equal(Number(row.total_cents), 125000, 'amounts stay in minor units');
  assert.equal(row.currency, 'usd');
  const lines = await q('select * from public.stripe_invoice_lines where invoice_id=$1 order by stripe_line_id', [invA]);
  assert.equal(lines.length, 2);
  assert.equal(Number(lines[0].amount_cents), 100000);
  assert.equal(Number(lines[0].unit_amount_cents), 10000);
});

await refused(
  () => syncInvoice(companyA, acctB, invoicePayload('in_X'), t1),
  /not the connected account for this company/,
  "an invoice cannot pair company A with company B's Stripe account");

await test('the newest fetch wins, whichever order the webhooks arrive in', async () => {
  // Paid arrives (t2), then a retry of the older open state (t1) lands after.
  await syncInvoice(companyA, acctA, invoicePayload('in_A1', {
    status: 'paid', amount_paid: 125000, amount_remaining: 0,
    status_transitions: { paid_at: 1758278400 },
  }), t2);
  await syncInvoice(companyA, acctA, invoicePayload('in_A1'), t1);
  const row = await one('select status, amount_remaining_cents from public.stripe_invoices where id=$1', [invA]);
  assert.equal(row.status, 'paid', 'a late retry of an older event must not un-pay an invoice');
  assert.equal(Number(row.amount_remaining_cents), 0);
});

await test('the trigger backstops a writer that goes round the sync function', async () => {
  // The service role bypasses RLS, so this is the only guard left for it.
  await q(`update public.stripe_invoices
              set status='open', stripe_synced_at=$2 where id=$1`, [invA, t1]);
  const row = await one('select status from public.stripe_invoices where id=$1', [invA]);
  assert.equal(row.status, 'paid', 'an update stamped older than the row must be dropped');
});

await test('lines are replaced, never merged -- a removed line disappears', async () => {
  const shrunk = invoicePayload('in_A1', {
    status: 'paid', amount_paid: 125000, amount_remaining: 0,
    subtotal: 100000, total: 100000, amount_due: 100000,
    lines: { data: [{ id: 'il_1', description: 'Spring order', quantity: 10, amount: 100000,
      price: { unit_amount: 10000 }, currency: 'usd' }] },
  });
  await syncInvoice(companyA, acctA, shrunk, '2026-09-19T11:00:00Z');
  const lines = await q('select stripe_line_id from public.stripe_invoice_lines where invoice_id=$1', [invA]);
  assert.equal(lines.length, 1,
    'a line dropped in Stripe must disappear here, or the mirror shows a total its lines do not add up to');
});

// ── 4. Tenant isolation and the read gates ──────────────────────────────────
await syncInvoice(companyB, acctB, invoicePayload('in_B1', { number: 'RV-0001' }), t1);

await test('a finance user sees only their own company\'s invoices', async () => {
  await as(finance, async () => {
    const rows = await q('select stripe_invoice_id from public.stripe_invoices');
    assert.deepEqual(rows.map((r) => r.stripe_invoice_id), ['in_A1']);
  });
  await as(rival, async () => {
    const rows = await q('select stripe_invoice_id from public.stripe_invoices');
    assert.deepEqual(rows.map((r) => r.stripe_invoice_id), ['in_B1']);
  });
});

await test('an ops admin sees no invoices at all, in either company', async () => {
  await as(ops, async () => {
    assert.equal((await q('select 1 from public.stripe_invoices')).length, 0);
    assert.equal((await q('select 1 from public.stripe_invoice_customers')).length, 0);
  });
});

await test('invoice LINES inherit the invoice\'s visibility, in both directions', async () => {
  // The line policy is an EXISTS against stripe_invoices with no company
  // clause of its own -- correct only because a policy's subquery is evaluated
  // under the caller's RLS. If that ever stopped holding, every company's line
  // detail would be readable, so it is asserted rather than assumed.
  await as(finance, async () => {
    const rows = await q('select 1 from public.stripe_invoice_lines');
    assert.ok(rows.length > 0, 'finance can read their own invoice lines');
  });
  await as(rival, async () => {
    // The rival has invoices of their own, so "sees nothing" would be the
    // wrong assertion -- what matters is that every line they see belongs to
    // an invoice they can see.
    const theirs = await q(`select distinct i.stripe_invoice_id
                              from public.stripe_invoice_lines l
                              join public.stripe_invoices i on i.id = l.invoice_id`);
    assert.deepEqual(theirs.map((r) => r.stripe_invoice_id), ['in_B1']);
    const all = await q('select count(*)::int as n from public.stripe_invoice_lines');
    assert.equal(all[0].n, 2, "no line of company A's invoices is visible");
  });
  await as(ops, async () => {
    assert.equal((await q('select 1 from public.stripe_invoice_lines')).length, 0,
      'a user who cannot see the invoice must not see its lines');
  });
});

await test('a plain member cannot read the subscription or the connected account', async () => {
  await as(viewer, async () => {
    assert.equal((await q('select 1 from public.stripe_connect_accounts')).length, 0);
    assert.equal((await q('select 1 from public.billing_subscriptions')).length, 0);
  });
});

await test('...but every member can see WHETHER invoicing works', async () => {
  await as(viewer, async () => {
    const rows = await q('select * from public.stripe_connect_status_v');
    assert.equal(rows.length, 1, 'the status view is what tells a non-admin why the page is empty');
    assert.equal(rows[0].charges_enabled, true);
    assert.ok(!('requirements' in rows[0]), 'the requirements payload is withheld');
    assert.ok(!('stripe_account_id' in rows[0]), 'the account id is withheld');
  });
  await as(rival, async () => {
    const rows = await q('select company_entity_id from public.stripe_connect_status_v');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].company_entity_id, companyB,
      'the definer view filters by active_company_id -- that filter IS the tenant boundary');
  });
});

await test('the status view cannot be written through', async () => {
  // A simple view is AUTO-UPDATABLE in Postgres, and this one is SECURITY
  // DEFINER over an RLS-protected table -- so Supabase's default GRANT ALL on
  // a new view would have let any member flip charges_enabled with RLS
  // bypassed. Found by verify_v2_schema.sql's own grant check during review.
  for (const role of ['anon', 'authenticated']) {
    for (const view of ['stripe_connect_status_v', 'stripe_invoices_v', 'billing_subscriptions_v']) {
      for (const priv of ['insert', 'update', 'delete']) {
        const { granted } = await one(
          'select has_table_privilege($1,$2,$3) as granted', [role, 'public.' + view, priv]);
        assert.equal(granted, false, `${role} can ${priv} through ${view}`);
      }
    }
  }
  await as(viewer, async () => {
    await assert.rejects(
      () => q('update public.stripe_connect_status_v set charges_enabled = false'),
      /permission denied/);
  });
});

await test('nobody client-side can read the webhook log', async () => {
  await as(blake, async () => {
    await assert.rejects(() => q('select 1 from public.stripe_webhook_events'), /permission denied/);
  });
});

// ── 5. No client writes a mirror ────────────────────────────────────────────
const writeAttempts = [
  ['stripe_invoices', `insert into public.stripe_invoices
     (company_entity_id, stripe_account_id, stripe_invoice_id, currency)
     values ('${companyA}','${acctA}','in_forged','usd')`],
  ['stripe_invoice_customers', `insert into public.stripe_invoice_customers
     (company_entity_id, stripe_account_id, stripe_customer_id, name)
     values ('${companyA}','${acctA}','cus_forged','Forged')`],
  ['billing_subscriptions', `insert into public.billing_subscriptions
     (company_entity_id, stripe_customer_id, status)
     values ('${companyA}','cus_forged','active')`],
  ['billing_plans', `insert into public.billing_plans (plan_key,title,stripe_price_id)
     values ('free','Free','price_forged')`],
  ['stripe_connect_accounts', `update public.stripe_connect_accounts
     set charges_enabled = true where company_entity_id = '${companyA}'`],
  ['stripe_invoices (update)', `update public.stripe_invoices set status='paid' where id='${invA}'`],
  ['stripe_invoices (delete)', `delete from public.stripe_invoices where id='${invA}'`],
];

for (const [what, statement] of writeAttempts) {
  if (mutation === 'mirror-writable' && what.startsWith('stripe_invoices')) {
    await test(`MUTANT: ${what} is writable (this run must fail)`, async () => {
      await as(blake, () => q(statement));
      const forged = await q("select 1 from public.stripe_invoices where stripe_invoice_id='in_forged'");
      assert.equal(forged.length, 0,
        'a client wrote the invoice mirror: SILO can now show an invoice Stripe never issued');
    });
    continue;
  }
  await test(`an owner-admin cannot write ${what} directly`, async () => {
    await as(blake, async () => {
      let wrote = true;
      try { await q(statement); } catch (e) { wrote = false; }
      if (wrote) {
        // A denied UPDATE/DELETE under RLS is zero rows, not an error, so the
        // absence of an exception is not by itself a pass.
        const after = await q("select 1 from public.stripe_invoices where stripe_invoice_id='in_forged'");
        assert.equal(after.length, 0, `${what} accepted a client write`);
      }
    });
    const stillPaid = await one('select status from public.stripe_invoices where id=$1', [invA]);
    assert.equal(stillPaid?.status, 'paid', `${what}: the mirror was modified by a client`);
  });
}

// ── 6. The sync layer is service-role only ──────────────────────────────────
const SYNC_FUNCTIONS = [
  'stripe_sync_invoice(uuid,text,jsonb,timestamptz)',
  'stripe_sync_subscription(uuid,jsonb,timestamptz)',
  'stripe_sync_connect_account(uuid,jsonb,timestamptz)',
  'stripe_sync_invoice_customer(uuid,text,jsonb,timestamptz)',
  'stripe_record_webhook_event(text,text,text,text,uuid,timestamptz)',
  'stripe_begin_checkout(uuid,text)',
  'stripe_begin_invoice_request(uuid,uuid,text,text,uuid,text)',
];

await test('no sync function is executable by anon or authenticated', async () => {
  // Supabase GRANTS EXECUTE to both on every new public function by default,
  // and these are SECURITY DEFINER -- so the revoke is the boundary, and the
  // fixture reproduces that default grant precisely so this can fail.
  for (const fn of SYNC_FUNCTIONS) {
    for (const role of ['anon', 'authenticated']) {
      const { granted } = await one(
        'select has_function_privilege($1,$2,\'execute\') as granted', [role, 'public.' + fn]);
      assert.equal(granted, false, `${role} can execute ${fn}`);
    }
  }
});

// ── 7. Event attribution ────────────────────────────────────────────────────
await q(`select public.stripe_begin_checkout($1,'cus_platform_A')`, [companyA]);

await test('a connect event is attributed by its account id', async () => {
  const { v } = await one(`select public.stripe_resolve_event_company('connect',$1,null) as v`, [acctA]);
  assert.equal(v, companyA);
});

await test('a platform event is attributed by its customer id', async () => {
  const { v } = await one(
    `select public.stripe_resolve_event_company('platform',null,'cus_platform_A') as v`);
  assert.equal(v, companyA);
});

await test('an unknown account resolves to nothing rather than to somebody', async () => {
  const { v } = await one(`select public.stripe_resolve_event_company('connect','acct_unknown',null) as v`);
  assert.equal(v, null, 'unresolved is recorded as unresolved, never guessed');
});

if (mutation !== 'platform-takes-account') {
  await refused(
    () => q(`select public.stripe_resolve_event_company('platform',$1,'cus_platform_A')`, [acctA]),
    /platform event carries account/,
    'a platform event carrying a connected account (crossed endpoint secrets)');
} else {
  await test('MUTANT: a crossed platform event is attributed (this run must fail)', async () => {
    const { v } = await one(
      `select public.stripe_resolve_event_company('platform',$1,'cus_platform_A') as v`, [acctA]);
    assert.equal(v, null,
      "a tenant's own Stripe activity was just attributed as SILO subscription revenue");
  });
}

await refused(
  () => q(`select public.stripe_resolve_event_company('connect',null,'cus_1')`),
  /no account id is mis-routed/,
  'a connect event with no account id');

await test('a webhook delivery is recorded once and only once', async () => {
  const first = await one(
    `select public.stripe_record_webhook_event('evt_1','connect','invoice.paid',$1,$2,now()) as v`,
    [acctA, companyA]);
  const second = await one(
    `select public.stripe_record_webhook_event('evt_1','connect','invoice.paid',$1,$2,now()) as v`,
    [acctA, companyA]);
  assert.equal(first.v, 'claimed', 'the first delivery is handled');
  assert.notEqual(second.v, 'claimed', "Stripe's retry of the same event is not handled twice");
});

await test('a failed delivery can be re-claimed; a handled one never is', async () => {
  // The endpoint returns 500 on a transient handler failure precisely so
  // Stripe will send the event again. With an insert-or-nothing claim that
  // retry was reported as a duplicate and the handler never ran -- so an
  // invoice.paid could be lost forever while the endpoint had explicitly
  // ASKED for the redelivery. This is that loop closed.
  const claimEvent = () => one(
    `select public.stripe_record_webhook_event('evt_retry','connect','invoice.paid',$1,$2,now()) as v`,
    [acctA, companyA]);

  assert.equal((await claimEvent()).v, 'claimed', 'first delivery is handled');
  assert.equal((await claimEvent()).v, 'leased',
    'a retry while it is in flight is not handled twice -- and is NOT terminal, so the caller '
    + 'must tell Stripe to come back rather than answering 200');

  await q(`select public.stripe_finish_webhook_event('evt_retry','error','boom')`);
  assert.equal((await claimEvent()).v, 'claimed',
    "after a transient failure, Stripe's retry must actually re-run the handler");

  await q(`select public.stripe_finish_webhook_event('evt_retry','processed')`);
  assert.equal((await claimEvent()).v, 'terminal',
    'a processed event is terminal -- re-running it is the double-processing the claim prevents');

  await q(`select public.stripe_finish_webhook_event('evt_retry','ignored')`);
  assert.equal((await claimEvent()).v, 'terminal', 'so is an ignored one');
});

await test('an unresolved event becomes re-claimable, because it can become resolvable', async () => {
  await one(`select public.stripe_record_webhook_event('evt_unres','connect','invoice.paid',$1,null,now()) as v`, [acctA]);
  await q(`select public.stripe_finish_webhook_event('evt_unres','unresolved','no company')`);
  const again = await one(
    `select public.stripe_record_webhook_event('evt_unres','connect','invoice.paid',$1,$2,now()) as v`,
    [acctA, companyA]);
  assert.equal(again.v, 'claimed',
    'a tenant finishing onboarding a minute later makes the same event resolvable');
  const row = await one(`select company_entity_id from public.stripe_webhook_events where stripe_event_id='evt_unres'`);
  assert.equal(row.company_entity_id, companyA, 'the retry may resolve a company the first attempt could not');
});

await test('a claim stuck in flight is re-claimable only once stale', async () => {
  await one(`select public.stripe_record_webhook_event('evt_stuck','connect','invoice.paid',$1,$2,now()) as v`, [acctA, companyA]);
  assert.equal((await one(`select public.stripe_record_webhook_event('evt_stuck','connect','invoice.paid',$1,$2,now()) as v`, [acctA, companyA])).v,
    'leased', 'a fresh in-flight claim still blocks -- and says so, so the caller can 4xx/5xx');
  await q(`update public.stripe_webhook_events set received_at = now() - interval '11 minutes'
            where stripe_event_id='evt_stuck'`);
  assert.equal((await one(`select public.stripe_record_webhook_event('evt_stuck','connect','invoice.paid',$1,$2,now()) as v`, [acctA, companyA])).v,
    'claimed', 'an edge function killed mid-handler must not claim the event forever');
});

// ── 7b. One company, one connected account ──────────────────────────────────
if (mutation !== 'connect-rebind-allowed') {
  await refused(
    () => syncAccount(companyA, 'acct_A_SECOND_0000002'),
    /already bound to/,
    'moving a company onto a second Stripe account (two tabs, two accounts)');
} else {
  await test('MUTANT: the same-company rebind guard is gone (this run must fail)', async () => {
    // Without the guard the rebind is stopped only by the composite FK from
    // the invoices already written against the first account -- so it fails
    // with a raw constraint violation, and a company that had not invoiced
    // anybody yet would be rebound silently. This asserts the readable
    // refusal, which is what the guard is for.
    await assert.rejects(() => syncAccount(companyA, 'acct_A_SECOND_0000002'),
      /already bound to/,
      'without the explicit guard, a company with no invoices yet is rebound with no error at all');
  });
}

await test('creating a connected account is claimed per company', async () => {
  const fresh = randomUUID();
  await q(`insert into public.entities(id,module,entity_type,entity_key,title)
           values ($1,'finance_hub','company','fresh','Fresh Co')`, [fresh]);

  const first = await one('select * from public.stripe_claim_connect_setup($1,null)', [fresh]);
  assert.equal(first.outcome, 'claimed');

  const second = await one('select * from public.stripe_claim_connect_setup($1,null)', [fresh]);
  assert.equal(second.outcome, 'in_flight',
    'the second tab must be refused, not allowed to open a second merchant account');

  // Stripe returned an account and the process died before the mirror write.
  await q(`select public.stripe_note_connect_setup_account($1,'acct_FRESH_000000001')`, [fresh]);
  const retry = await one('select * from public.stripe_claim_connect_setup($1,null)', [fresh]);
  assert.equal(retry.outcome, 'adopt');
  assert.equal(retry.stripe_account_id, 'acct_FRESH_000000001',
    'a retry adopts the account Stripe already made rather than creating another');

  // Even once stale, a claim carrying an account id is adopted, never retaken.
  await q(`update public.stripe_connect_setup_claims
              set claimed_at = now() - interval '11 minutes' where company_entity_id=$1`, [fresh]);
  const stale = await one('select * from public.stripe_claim_connect_setup($1,null)', [fresh]);
  assert.equal(stale.outcome, 'adopt',
    'staleness must not turn a real Stripe account into a second one');

  await syncAccount(fresh, 'acct_FRESH_000000001');
  await q('select public.stripe_release_connect_setup($1)', [fresh]);
  const bound = await one('select * from public.stripe_claim_connect_setup($1,null)', [fresh]);
  assert.equal(bound.outcome, 'already_bound');
});

await test('a stale claim with NO account recorded is retaken', async () => {
  const fresh2 = randomUUID();
  await q(`insert into public.entities(id,module,entity_type,entity_key,title)
           values ($1,'finance_hub','company','fresh2','Fresh Two')`, [fresh2]);
  await q('select * from public.stripe_claim_connect_setup($1,null)', [fresh2]);
  await q(`update public.stripe_connect_setup_claims
              set claimed_at = now() - interval '11 minutes' where company_entity_id=$1`, [fresh2]);
  const retaken = await one('select * from public.stripe_claim_connect_setup($1,null)', [fresh2]);
  assert.equal(retaken.outcome, 'claimed',
    'nothing was created, so a dead attempt must not block setup forever');
});

await test('the setup claim table is service-role only', async () => {
  await as(blake, async () => {
    await assert.rejects(() => q('select 1 from public.stripe_connect_setup_claims'), /permission denied/);
  });
});

await test('a lease is distinguishable from a finished delivery', async () => {
  // These two were one boolean, and the caller therefore answered 200 to both.
  // For a finished event that is right; for a lease it ends Stripe's retries
  // on an event nothing has processed -- which is what happens when a handler
  // fails AND its status write fails in the same database outage.
  await one(`select public.stripe_record_webhook_event('evt_lease','connect','invoice.paid',$1,$2,now()) as v`, [acctA, companyA]);
  const leased = await one(
    `select public.stripe_record_webhook_event('evt_lease','connect','invoice.paid',$1,$2,now()) as v`, [acctA, companyA]);
  assert.equal(leased.v, 'leased', 'no status was ever written, so nothing is finished');

  await q(`select public.stripe_finish_webhook_event('evt_lease','processed')`);
  const done = await one(
    `select public.stripe_record_webhook_event('evt_lease','connect','invoice.paid',$1,$2,now()) as v`, [acctA, companyA]);
  assert.equal(done.v, 'terminal');
});

// ── 8. The idempotency ledger ───────────────────────────────────────────────
const reqId = randomUUID();
const claim = (id = reqId, company = companyA, action = 'create_invoice') => one(
  `select * from public.stripe_begin_invoice_request($1,$2,$3,$4,null,'fp')`,
  [id, company, company === companyA ? acctA : acctB, action]);

if (mutation === 'ledger-amnesia') {
  await test('MUTANT: the ledger forgets (this run must fail)', async () => {
    await claim();
    await q(`select public.stripe_complete_invoice_request($1,'succeeded','in_first')`, [reqId]);
    const second = await claim();
    assert.equal(second.already, true,
      'a retried request id created a SECOND invoice against a real customer');
  });
} else {
  await test('a first claim is fresh; a retry after success returns the first invoice', async () => {
    const first = await claim();
    assert.equal(first.already, false);
    assert.equal(first.status, 'pending');

    const inFlight = await claim();
    assert.equal(inFlight.already, true);
    assert.equal(inFlight.status, 'pending',
      'a concurrent attempt must be told to wait, not allowed to create a second invoice');

    await q(`select public.stripe_complete_invoice_request($1,'succeeded','in_first')`, [reqId]);
    const afterSuccess = await claim();
    assert.equal(afterSuccess.already, true);
    assert.equal(afterSuccess.stripe_object_id, 'in_first',
      'the lost-response retry gets the ORIGINAL invoice back');
  });

  await test('a failed attempt is re-claimable -- nothing was created', async () => {
    const failedId = randomUUID();
    await claim(failedId);
    await q(`select public.stripe_complete_invoice_request($1,'failed',null,'card_declined')`, [failedId]);
    const retry = await claim(failedId);
    assert.equal(retry.already, false, 'a failed request must not strand its id forever');
  });

  await refused(
    () => claim(reqId, companyB),
    /not issued for this company and action/,
    "another company's request id");

  await refused(
    () => claim(reqId, companyA, 'create_customer'),
    /not issued for this company and action/,
    'a create_invoice id replayed as create_customer (it would return a customer id as an invoice)');
}

await test('a failed request that DID create something is not re-claimable', async () => {
  // The handler records the Stripe id alongside the failure whenever Stripe had
  // already made the draft before a later step failed. Re-claiming that hands
  // the caller a fresh key, so Stripe will not collapse the retry either, and
  // a second real invoice reaches somebody's customer.
  const partial = randomUUID();
  await claim(partial);
  await q(`select public.stripe_complete_invoice_request($1,'failed','in_half_built','line 3 rejected')`, [partial]);

  const retry = await claim(partial);
  assert.equal(retry.already, true, 'the draft exists; this request is closed for creation');
  assert.equal(retry.status, 'failed');
  assert.equal(retry.stripe_object_id, 'in_half_built',
    'the caller must be handed the draft to finish or void, never a licence to make another');

  // A failure BEFORE anything was created stays re-claimable -- that is the
  // case the re-claim exists for.
  const clean = randomUUID();
  await claim(clean);
  await q(`select public.stripe_complete_invoice_request($1,'failed',null,'currency rejected')`, [clean]);
  assert.equal((await claim(clean)).already, false, 'nothing was created, so retrying is correct');
});

await test('a pending claim older than ten minutes is re-claimable', async () => {
  // An edge function killed mid-call (the gateway stops a request at 150s)
  // completes neither the success nor the failure path. Without this the row
  // stays 'pending' forever and that invoice can never be created OR retried,
  // with no way out but a service-role UPDATE.
  const stuck = randomUUID();
  await claim(stuck);
  await q(`update public.stripe_invoice_requests
              set created_at = now() - interval '11 minutes' where request_id = $1`, [stuck]);
  const retry = await claim(stuck);
  assert.equal(retry.already, false, 'a stranded attempt must be recoverable');

  const fresh = randomUUID();
  await claim(fresh);
  const immediate = await claim(fresh);
  assert.equal(immediate.already, true,
    'a genuinely concurrent attempt is still blocked -- the escape hatch is time-based, not free');
});

await test('deauthorization clears the capabilities and keeps the history', async () => {
  await q('select public.stripe_mark_connect_disconnected($1,$2,now())', [companyA, acctA]);
  const row = await one('select * from public.stripe_connect_accounts where company_entity_id=$1', [companyA]);
  assert.equal(row.charges_enabled, false);
  assert.equal(row.disabled_reason, 'deauthorized');
  assert.equal(row.country, 'US', 'the real account facts survive -- a stub payload would have erased them');
  assert.ok(row.raw && Object.keys(row.raw).length > 1, 'the last known Stripe object is kept');
  const invoices = await q('select 1 from public.stripe_invoices where company_entity_id=$1', [companyA]);
  assert.ok(invoices.length > 0, 'those invoices really were issued; disconnecting does not unsay it');
  // Put it back for the assertions that follow.
  await syncAccount(companyA, acctA);
});

await refused(
  () => q('select public.stripe_sync_billing_invoice($1,$2,now())', [companyB, JSON.stringify({
    id: 'in_billing_A', customer: 'cus_platform_A', status: 'paid', currency: 'usd',
    amount_due: 49900, amount_paid: 49900,
  })]).then(() => q('select public.stripe_sync_billing_invoice($1,$2,now())', [companyA, JSON.stringify({
    id: 'in_billing_A', customer: 'cus_platform_A', status: 'paid', currency: 'usd',
    amount_due: 49900, amount_paid: 49900,
  })])),
  /belongs to another company/,
  "a SILO invoice being adopted by a second company (the conflict target is the invoice id alone)");

// ── 9. Derived facts ────────────────────────────────────────────────────────
await test('a paid invoice past its due date is not overdue', async () => {
  await as(finance, async () => {
    const row = await one('select is_overdue, status from public.stripe_invoices_v where id=$1', [invA]);
    assert.equal(row.status, 'paid');
    assert.equal(row.is_overdue, false,
      'overdue is money still owed past the due date, not simply a date in the past');
  });
});

await test('an open invoice past its due date IS overdue', async () => {
  await syncInvoice(companyA, acctA, invoicePayload('in_A2', {
    number: 'BB-0002',
    due_date: Math.floor(Date.UTC(2026, 0, 1) / 1000),
  }), '2026-09-19T12:00:00Z');
  await as(finance, async () => {
    const row = await one(
      `select is_overdue from public.stripe_invoices_v where stripe_invoice_id='in_A2'`);
    assert.equal(row.is_overdue, true);
  });
});

await test('a line with no inline price mirrors instead of aborting the whole invoice', async () => {
  // Stripe sends `unit_amount_excluding_tax` as a DECIMAL STRING, and a line
  // has no inline `price.unit_amount` whenever the price is metered or tiered,
  // or the item was added in the Stripe dashboard. Read strictly, that string
  // RAISED -- inside the line loop, so the whole stripe_sync_invoice call
  // aborted, the webhook answered 500, and Stripe retried a legitimate invoice
  // for three days while no mirror row ever appeared. Every other fixture in
  // this file supplies price.unit_amount, which is exactly why nothing caught
  // it.
  const id = (await syncInvoice(companyA, acctA, invoicePayload('in_nolineprice', {
    lines: { data: [
      { id: 'il_m1', description: 'Metered API calls', quantity: 4200, amount: 84000,
        unit_amount_excluding_tax: '20', currency: 'usd' },
      { id: 'il_m2', description: 'Dashboard item', quantity: 1, amount: 15000,
        unit_amount_excluding_tax: '150.5', currency: 'usd' },
    ] },
  }), t1)).id;
  const lines = await q(
    'select * from public.stripe_invoice_lines where invoice_id=$1 order by stripe_line_id', [id]);
  assert.equal(lines.length, 2, 'the invoice must mirror, not raise');
  assert.equal(Number(lines[0].unit_amount_cents), 20,
    'a decimal string is a unit price, not a reason to fail');
  assert.equal(lines[1].unit_amount_cents, null,
    'a fractional minor unit is unrepresentable -- null (unknown), never a rounded guess');
  assert.equal(Number(lines[1].amount_cents), 15000,
    'the line AMOUNT is carried separately and is what the total comes from');
});


// ── One in-flight Checkout per company ──────────────────────────────────────
// The preflight in stripe-billing asks Stripe rather than believing the
// mirror, which closes the stale-mirror window. It does not close the
// concurrency window: read-then-create is check-then-act, and two requests can
// both read "no live subscription" and both create a session. Two completed
// sessions are two subscriptions and two charges.
const claimCheckout = (co, user) => one(
  'select * from public.stripe_claim_checkout($1,$2)', [co, user]);

await test('only one of two concurrent checkout attempts may create a session', async () => {
  const co = randomUUID();
  await q(`insert into public.entities(id,module,entity_type,entity_key,title)
           values ($1,'finance_hub','company','race','Race Co')`, [co]);

  const first = await claimCheckout(co, blake);
  const second = await claimCheckout(co, finance);
  assert.equal(first.outcome, 'claimed');
  assert.ok(first.attempt_id, 'the claim carries the attempt the Stripe key is scoped to');
  assert.equal(second.outcome, 'in_flight',
    'the second request must be refused, not handed a second session');
  assert.equal(second.attempt_id, null);
});

await test('an attempt that made a session hands back THAT session, not a new one', async () => {
  const co = randomUUID();
  await q(`insert into public.entities(id,module,entity_type,entity_key,title)
           values ($1,'finance_hub','company','resume','Resume Co')`, [co]);

  const claim = await claimCheckout(co, blake);
  await q('select public.stripe_note_checkout_session($1,$2,$3,$4)',
    [co, claim.attempt_id, 'cs_test_1', 'price_growth:1']);

  const next = await claimCheckout(co, blake);
  assert.equal(next.outcome, 'existing');
  assert.equal(next.stripe_session_id, 'cs_test_1',
    'the caller resolves this against Stripe -- open, complete or expired -- rather than guessing');

  // And a claim holding a session is NOT stolen on a timer, however old: that
  // session may be open, or may already have been paid. Only Stripe knows.
  await q(`update public.billing_checkout_claims
              set claimed_at = now() - interval '2 hours' where company_entity_id = $1`, [co]);
  const stale = await claimCheckout(co, finance);
  assert.equal(stale.outcome, 'existing',
    'age is not evidence that a session was abandoned');
  assert.equal(stale.stripe_session_id, 'cs_test_1');
});

await test('a takeover REUSES the dead attempt\'s id, so Stripe replays its session', async () => {
  const co = randomUUID();
  await q(`insert into public.entities(id,module,entity_type,entity_key,title)
           values ($1,'finance_hub','company','killed','Killed Co')`, [co]);

  const first = await claimCheckout(co, blake);
  assert.equal(first.outcome, 'claimed');
  assert.equal((await claimCheckout(co, finance)).outcome, 'in_flight');

  // An edge function killed between the claim and Stripe's answer. Stripe may
  // well have created a session -- we simply never heard. The claim must not
  // block the company forever, so it is taken over; but the attempt id is
  // PRESERVED, because the Stripe idempotency key is derived from it and
  // replaying that key returns the session the dead attempt made. Minting a
  // fresh id here mints a fresh key, and a fresh key opens a SECOND session
  // the customer can also pay -- which is the double subscription this whole
  // table exists to prevent. The first version of this test asserted the
  // opposite, and was wrong.
  await q(`update public.billing_checkout_claims
              set claimed_at = now() - interval '11 minutes' where company_entity_id = $1`, [co]);
  const taken = await claimCheckout(co, finance);
  assert.equal(taken.outcome, 'takeover',
    'a takeover is distinguishable from a first claim -- the caller must read a replay');
  assert.equal(taken.attempt_id, first.attempt_id,
    'the key must replay, not diverge');
});

await test('a new attempt is minted only once the old one is established dead', async () => {
  const co = randomUUID();
  await q(`insert into public.entities(id,module,entity_type,entity_key,title)
           values ($1,'finance_hub','company','rotate','Rotate Co')`, [co]);

  const first = await claimCheckout(co, blake);
  await q('select public.stripe_note_checkout_session($1,$2,$3,$4)',
    [co, first.attempt_id, 'cs_dead', 'price_growth:3']);

  // Rotation is the ONLY way to a new attempt id, and the caller reaches it
  // only after Stripe has said the previous session is expired or gone.
  const rotated = await one('select public.stripe_rotate_checkout_attempt($1,$2) as id',
    [co, first.attempt_id]);
  assert.ok(rotated.id);
  assert.notEqual(rotated.id, first.attempt_id);
  const after = await claimCheckout(co, blake);
  assert.equal(after.stripe_session_id, null, 'rotating clears the dead session');
  assert.equal(after.plan_fingerprint, null);

  // And a rotation naming a stale attempt does nothing, so a late caller
  // cannot reset an attempt somebody else is holding.
  assert.equal((await one('select public.stripe_rotate_checkout_attempt($1,$2) as id',
    [co, first.attempt_id])).id, null);
});

await test('a claim remembers what its session was FOR', async () => {
  const co = randomUUID();
  await q(`insert into public.entities(id,module,entity_type,entity_key,title)
           values ($1,'finance_hub','company','fingerprint','Fingerprint Co')`, [co]);

  const claim = await claimCheckout(co, blake);
  const noted = await one('select public.stripe_note_checkout_session($1,$2,$3,$4) as ok',
    [co, claim.attempt_id, 'cs_growth', 'price_growth:3']);
  assert.equal(noted.ok, true, 'the caller needs to know the write landed');

  const resumed = await claimCheckout(co, blake);
  assert.equal(resumed.plan_fingerprint, 'price_growth:3',
    'without this, choosing a different plan hands back the old plan\'s URL');

  // A note naming an attempt that is no longer current must report failure
  // rather than silently doing nothing -- the caller fails closed on it.
  assert.equal((await one('select public.stripe_note_checkout_session($1,$2,$3,$4) as ok',
    [co, randomUUID(), 'cs_other', 'x'])).ok, false);
});

await test('a release names the session it saw, so it cannot drop a live claim', async () => {
  const co = randomUUID();
  await q(`insert into public.entities(id,module,entity_type,entity_key,title)
           values ($1,'finance_hub','company','release','Release Co')`, [co]);

  const first = await claimCheckout(co, blake);
  await q('select public.stripe_note_checkout_session($1,$2,$3,$4)',
    [co, first.attempt_id, 'cs_old', 'price_growth:1']);
  await q('select public.stripe_release_checkout($1,$2)', [co, 'cs_old']);
  assert.equal((await claimCheckout(co, blake)).outcome, 'claimed',
    'releasing the session it saw frees the company for a fresh attempt');

  // A webhook for the long-finished cs_old arrives late, while a second
  // attempt is mid-flight. Unscoped, it would drop that live claim and put the
  // race straight back.
  const second = await one('select * from public.billing_checkout_claims where company_entity_id=$1', [co]);
  await q('select public.stripe_note_checkout_session($1,$2,$3,$4)',
    [co, second.attempt_id, 'cs_new', 'price_growth:1']);
  await q('select public.stripe_release_checkout($1,$2)', [co, 'cs_old']);
  const survived = await claimCheckout(co, finance);
  assert.equal(survived.outcome, 'existing');
  assert.equal(survived.stripe_session_id, 'cs_new',
    'a stale release must not free a claim it never saw');
});

await refused(
  () => as(blake, () => q('select * from public.billing_checkout_claims')),
  /permission denied/,
  'a client reading the checkout claim table');

// ── verify_v2_schema.sql's own Stripe checks, executed ──────────────────────
// A check nobody runs is a check that cannot go red. These are extracted by
// their markers and run against this database, so a typo -- or a check that
// reads 'ok' whatever the schema says -- fails here rather than sitting green
// in the daily drift run.
const verifyStatements = async () => {
  const verify = await readFile(new URL('supabase/verify_v2_schema.sql', root), 'utf8');
  const start = verify.indexOf("-- ── Stripe: billing (SILO's revenue)");
  const end = verify.indexOf('-- ── Company onboarding (20260918120000)');
  assert.ok(start > 0 && end > start, 'the Stripe checks must sit above the onboarding marker');
  const out = verify.slice(start, end).split(/;\s*\n/)
    .filter((x) => /^\s*(--[^\n]*\n)*\s*select/i.test(x));
  assert.equal(out.length, 4, 'four Stripe checks');
  return out;
};

await test("verify_v2_schema.sql's Stripe checks pass against the migrated schema", async () => {
  for (const stmt of await verifyStatements()) {
    const row = await one(stmt + ';');
    assert.equal(row.status, 'ok', `${row.check_name}: ${row.status}`);
  }
});

await test('the Stripe verify checks go red when what they guard breaks', async () => {
  const statements = await verifyStatements();
  const check = async (i) => (await one(statements[i] + ';')).status;

  // The strict reader is the production bug: restore it and the check must
  // notice, because the function's EXISTENCE never was the failure.
  await db.exec(`create or replace function public.stripe_decimal_cents(p_payload jsonb, p_key text)
                 returns bigint language sql immutable as
                 $x$ select public.stripe_cents(p_payload, p_key) $x$;`);
  // Red by either route: the probe returns CRITICAL, or the strict function
  // raises and the check itself errors. Both fail the daily drift run, which
  // goes red on a non-ok cell AND on a statement that will not execute -- and
  // a raise here is the same raise production would hit on the next metered
  // invoice, so it is not a softer signal.
  const red = await check(2).then((x) => x, (e) => `RAISED: ${e.message}`);
  assert.match(red, /^CRITICAL|^RAISED/,
    'a decimal-string unit price that raises must not read as ok');
  await db.exec(sql);
  assert.equal(await check(2), 'ok', 're-applying the migration must restore it');
});

// ── 10. The subscription side ───────────────────────────────────────────────
await q(`insert into public.billing_plans (plan_key,title,stripe_price_id,unit_amount_cents,billing_interval,sort_order)
         values ('growth','Growth','price_growth',49900,'month',1)
         on conflict (plan_key) do nothing`);

await test('a subscription is mirrored with its plan resolved from the price id', async () => {
  await q('select public.stripe_sync_subscription($1,$2,$3)', [companyA, JSON.stringify({
    id: 'sub_1', customer: 'cus_platform_A', status: 'active',
    current_period_start: 1757000000, current_period_end: 1759592000,
    cancel_at_period_end: false,
    items: { data: [{ quantity: 3, price: { id: 'price_growth', currency: 'usd', unit_amount: 49900 } }] },
  }), t1]);
  const row = await one('select * from public.billing_subscriptions where company_entity_id=$1', [companyA]);
  assert.equal(row.plan_key, 'growth');
  assert.equal(row.status, 'active');
  assert.equal(Number(row.quantity), 3);
  assert.equal(row.collection_issue, null);
  assert.ok(row.current_period_end, 'the renewal date must be readable');
});

await test('the checkout placeholder never outranks the first real sync', async () => {
  // stripe_begin_checkout records WHICH Stripe customer to attribute the
  // coming webhook to. It knows nothing about Stripe's state, so it must not
  // claim a sync time -- if it stamped now(), the staleness guard would drop
  // the first real sync whenever that fetch began earlier (a replayed webhook,
  // a backfill, a sync racing the redirect), and the subscription would sit at
  // `incomplete` with a null plan forever. This is how that was found: the
  // suite stamps its sync with a FIXED PAST timestamp, so a placeholder
  // stamped now() fails here every run after 10:05 UTC.
  const late = randomUUID();
  await q(`insert into auth.users(id,email) values ($1,'late@x.test')`, [late]);
  const lateCo = randomUUID();
  await q(`insert into public.entities(id,module,entity_type,entity_key,title)
           values ($1,'finance_hub','company','late','Late Co')`, [lateCo]);

  await q(`select public.stripe_begin_checkout($1,'cus_late')`, [lateCo]);
  const placeholder = await one(
    'select stripe_synced_at, status from public.billing_subscriptions where company_entity_id=$1', [lateCo]);
  assert.equal(placeholder.status, 'incomplete');

  await q('select public.stripe_sync_subscription($1,$2,$3)', [lateCo, JSON.stringify({
    id: 'sub_late', customer: 'cus_late', status: 'active',
    items: { data: [{ quantity: 1, price: { id: 'price_growth', currency: 'usd', unit_amount: 49900 } }] },
  }), t1]);

  const synced = await one(
    'select status, plan_key from public.billing_subscriptions where company_entity_id=$1', [lateCo]);
  assert.equal(synced.status, 'active',
    'a real sync must land whatever time its fetch began -- the placeholder claims no sync time');
  assert.equal(synced.plan_key, 'growth');
});

await test('a superseded subscription cannot bury the live one', async () => {
  // One row per company, so this mirror holds ONE subscription -- but a tenant
  // who cancels and resubscribes has two at Stripe, and the old one's
  // `customer.subscription.deleted` can arrive (or be re-delivered) after the
  // new one synced. Ordered by fetch time alone, that terminal event lands
  // last and a paying customer reads `canceled` until somebody presses Sync.
  const co = randomUUID();
  await q(`insert into public.entities(id,module,entity_type,entity_key,title)
           values ($1,'finance_hub','company','resub','Resub Co')`, [co]);
  const item = { data: [{ quantity: 1, price: { id: 'price_growth', currency: 'usd', unit_amount: 49900 } }] };

  await q('select public.stripe_sync_subscription($1,$2,$3)', [co, JSON.stringify({
    id: 'sub_new', customer: 'cus_resub', status: 'active', items: item }), t1]);
  await q('select public.stripe_sync_subscription($1,$2,$3)', [co, JSON.stringify({
    id: 'sub_old', customer: 'cus_resub', status: 'canceled', items: item }), t2]);

  const row = await one(
    'select stripe_subscription_id, status from public.billing_subscriptions where company_entity_id=$1', [co]);
  assert.equal(row.stripe_subscription_id, 'sub_new');
  assert.equal(row.status, 'active',
    'a terminal event for a DIFFERENT subscription is about one this row no longer describes');

  // The identity guard must not freeze the row: the LIVE subscription's own
  // cancellation still has to land, or a cancelled tenant reads as paying.
  await q('select public.stripe_sync_subscription($1,$2,$3)', [co, JSON.stringify({
    id: 'sub_new', customer: 'cus_resub', status: 'canceled', items: item }), t2]);
  assert.equal((await one(
    'select status from public.billing_subscriptions where company_entity_id=$1', [co])).status,
    'canceled', 'the subscription on file can always cancel itself');
});

await test('a past_due subscription records WHY money is not arriving', async () => {
  await q('select public.stripe_sync_subscription($1,$2,$3)', [companyA, JSON.stringify({
    id: 'sub_1', customer: 'cus_platform_A', status: 'past_due',
    items: { data: [{ quantity: 3, price: { id: 'price_growth', currency: 'usd', unit_amount: 49900 } }] },
  }), t2]);
  const row = await one('select status, collection_issue from public.billing_subscriptions where company_entity_id=$1', [companyA]);
  assert.equal(row.collection_issue, 'past_due');
});

await test('the period falls back to the item when Stripe moves it there', async () => {
  await q('select public.stripe_sync_subscription($1,$2,$3)', [companyB, JSON.stringify({
    id: 'sub_2', customer: 'cus_platform_B', status: 'active',
    items: { data: [{ quantity: 1, current_period_end: 1759592000,
      price: { id: 'price_growth', currency: 'usd', unit_amount: 49900 } }] },
  }), t1]);
  const row = await one('select current_period_end from public.billing_subscriptions where company_entity_id=$1', [companyB]);
  assert.ok(row.current_period_end,
    'a newer Stripe API version must degrade to the item-level period, not write NULL');
});

await test('an admin sees their own subscription and not the other company\'s', async () => {
  await as(finance, async () => {
    const rows = await q('select company_entity_id from public.billing_subscriptions');
    assert.deepEqual(rows.map((r) => r.company_entity_id), [companyA]);
  });
});

await refused(
  () => q(`select public.stripe_begin_checkout($1,'cus_platform_A')`, [companyB]),
  /already belongs to another company/,
  "binding company A's Stripe customer to company B");

// ── 11. stripe_cents refuses rather than zeroes ─────────────────────────────
await test('a non-numeric amount is refused, never silently zeroed', async () => {
  const { v } = await one(`select public.stripe_cents('{"amount_due":1250}'::jsonb,'amount_due') as v`);
  assert.equal(Number(v), 1250);
  const { n } = await one(`select public.stripe_cents('{}'::jsonb,'amount_due') as n`);
  assert.equal(n, null, 'absent is null, which reads as unknown rather than as nothing owed');
  await assert.rejects(
    () => q(`select public.stripe_cents('{"amount_due":"lots"}'::jsonb,'amount_due')`),
    /not a number/);
});

console.log(`\n${passed} assertions passed`);
if (mutation) {
  console.error(`\nFAILED: mutation ${mutation} did not break the suite -- `
    + 'the property it removes is untested');
  process.exit(1);
}
