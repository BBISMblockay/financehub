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
  'placeholder-claims-now',
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
let sql = await readFile(
  new URL('supabase/migrations/20260919120000_stripe_billing_and_connect.sql', root), 'utf8');

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
if (mutation === 'sync-open-to-anon') {
  sql = sql.replace(
    "execute format('revoke all on function public.%s from public, anon, authenticated', f);", '');
}

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
  assert.equal(first.v, true, 'the first delivery is handled');
  assert.equal(second.v, false, "Stripe's retry of the same event is not handled twice");
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
