// The four Stripe Edge Function handlers, EXECUTED.
//
// Until this file, `deno check` was the only thing that had ever looked at
// them: about a thousand lines of orchestration, holding every gate, every
// idempotency claim and every ordering guarantee this feature has, and not one
// line of it run. The database suite proves the SQL these handlers call; this
// proves the calling. CLAUDE.md records why that distinction is not academic
// here -- a dead-zone reference shipped inside an orchestrator whose core had
// 91 passing assertions and whose five calling lines had none.
//
// Only Stripe and Supabase are synthetic. The code under test is the code that
// deploys, loaded from handler.ts and type-stripped.
//
// Mutations (each must make a specific assertion fail):
//   STRIPE_HANDLER_MUTATION=webhook-trusts-payload  (sync the event body, not a re-fetch)
//   STRIPE_HANDLER_MUTATION=webhook-swallows-failure (a handler failure answers 200)
//   STRIPE_HANDLER_MUTATION=connect-body-company    (company taken from the request body)
//   STRIPE_HANDLER_MUTATION=connect-note-after-sync (account id recorded after the mirror write)
//   STRIPE_HANDLER_MUTATION=connect-release-on-error (the claim is released when sync fails)
//   STRIPE_HANDLER_MUTATION=invoice-lines-after-create (lines validated after the draft exists)
//   STRIPE_HANDLER_MUTATION=invoice-trusts-stripe-id (a Stripe id from the body is acted on)
//   STRIPE_HANDLER_MUTATION=billing-body-price      (the price comes from the request)
// Added after the cycle-3 review:
//   STRIPE_HANDLER_MUTATION=webhook-lease-is-200    (a leased delivery is acknowledged)
//   STRIPE_HANDLER_MUTATION=webhook-ignores-finish  (a failed status write is not noticed)
//   STRIPE_HANDLER_MUTATION=connect-no-idempotency  (the create carries no key)
//   STRIPE_HANDLER_MUTATION=billing-trusts-mirror   (Stripe is not consulted)
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e && e.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { fakeSupabase, fakeStripe, loadHandler } from './lib/stripe-handler-harness.mjs';
import * as routing from '../../supabase/functions/stripe-webhook/event-routing.mjs';
import * as lines from '../../supabase/functions/stripe-invoice/invoice-lines.mjs';
import * as subState from '../../supabase/functions/stripe-billing/subscription-state.mjs';

const mutation = process.env.STRIPE_HANDLER_MUTATION || '';
const MUTATIONS = {
  'webhook-trusts-payload': (s) => s.replace(
    'const invoice = await stripe.invoices.retrieve(route.objectId, opts);',
    'const invoice = event.data.object;'),
  'webhook-swallows-failure': (s) => s.replace(
    "    return reply({ error: message }, 500);", "    return reply({ error: message }, 200);"),
  'connect-body-company': (s) => s.replace(
    '  const company = profile.active_company_id;',
    '  const company = (await req.clone().json().catch(() => ({}))).company_entity_id ?? profile.active_company_id;'),
  'connect-note-after-sync': (s) => s.replace(
    `        await db.rpc('stripe_note_connect_setup_account', {
          p_company: company, p_account: account.id,
        });`, ''),
  'connect-release-on-error': (s) => s.replace(
    `      } else if (claim?.outcome === 'claimed') {`,
    `      } else if (claim?.outcome === 'claimed') {
        try {`).replace(
    `        await db.rpc('stripe_release_connect_setup', { p_company: company });
      } else {`,
    `        await db.rpc('stripe_release_connect_setup', { p_company: company });
        } catch (e) { await db.rpc('stripe_release_connect_setup', { p_company: company }); throw e; }
      } else {`),
  'invoice-lines-after-create': (s) => s.replace(
    '  const { lines, total } = normalizeInvoiceLines(body?.lines, currency);', '')
    .replace('  let invoice: Stripe.Invoice | null = null;',
      '  const { lines, total } = normalizeInvoiceLines(body?.lines, currency);\n  let invoice: Stripe.Invoice | null = null;'),
  'invoice-trusts-stripe-id': (s) => s.replace(
    "  const rowId = String(body?.invoice_id ?? '').trim();",
    "  if (body?.stripe_invoice_id) return String(body.stripe_invoice_id);\n  const rowId = String(body?.invoice_id ?? '').trim();"),
  'webhook-lease-is-200': (s) => s.replace(
    "    return reply({ received: false, leased: true }, 409);",
    "    return reply({ received: true, duplicate: true }, 200);"),
  'webhook-ignores-finish': (s) => s.replace(
    /    if \(finishErr\) \{\n      console\.error\('finish failed'[\s\S]*?\n    \}\n/,
    ''),
  'connect-no-idempotency': (s) => s.replace(
    /\}, \{\n          \/\/ The claim covers a crash AFTER Stripe answered[\s\S]*?idempotencyKey: `silo-connect-account-\$\{company\}`,\n        \}\);/,
    '});'),
  'billing-trusts-mirror': (s) => s.replace(
    /  if \(current\?\.stripe_customer_id\) \{\n    const remote = await stripe\.subscriptions\.list\([\s\S]*?\n  \}\n\n  const customer = await customerFor/,
    '  const customer = await customerFor'),
  'billing-body-price': (s) => s.replace(
    '    line_items: [{ price: plan.stripe_price_id, quantity }],',
    '    line_items: [{ price: body?.price_id ?? plan.stripe_price_id, quantity }],'),
};
assert.ok(mutation === '' || mutation in MUTATIONS, `Unknown handler mutation: ${mutation}`);
const mutate = mutation ? MUTATIONS[mutation] : undefined;
const only = (fn) => (mutation && !mutation.startsWith(fn.replace('stripe-', '')) ? undefined : mutate);

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

const USER = { id: '00000000-0000-0000-0000-0000000000aa', email: 'finance@baseballism.com' };
const COMPANY = '00000000-0000-0000-0000-0000000000c1';
const OTHER_COMPANY = '00000000-0000-0000-0000-0000000000c2';
const ACCOUNT = 'acct_connected_1';
const profileRow = { id: USER.id, active_company_id: COMPANY, is_active: true, email: USER.email, name: 'Fin' };

// ── stripe-webhook ──────────────────────────────────────────────────────────

const EVENT = {
  id: 'evt_1', type: 'invoice.paid', created: 1758278400, account: ACCOUNT,
  data: { object: { id: 'in_1', customer: 'cus_1', status: 'open', amount_paid: 0 } },
};

async function webhookFixture(over = {}) {
  const db = fakeSupabase({
    rpcs: {
      // `in`, not `??`: the case under test IS null, which `??` would replace
      // with the company and quietly assert nothing.
      stripe_resolve_event_company: 'resolve' in over ? over.resolve : COMPANY,
      stripe_record_webhook_event: 'record' in over ? over.record : 'claimed',
      stripe_finish_webhook_event: null,
      stripe_sync_invoice: 'row-1',
      stripe_sync_subscription: null,
      stripe_sync_billing_invoice: null,
      stripe_sync_connect_account: null,
      stripe_mark_connect_disconnected: null,
      stripe_sync_invoice_customer: 'cust-1',
      ...over.rpcs,
    },
  });
  const stripe = fakeStripe({
    // The signature check is the authentication, so the double honours the
    // secret: an event verifies against ONE of them, exactly as in production.
    'webhooks.constructEventAsync': ([, , secret]) => {
      const valid = over.validSecret ?? 'whsec_connect';
      if (secret !== valid) throw new Error('No signatures found matching the expected signature');
      return over.event ?? EVENT;
    },
    'invoices.retrieve': { ...(over.event ?? EVENT).data.object, status: 'paid', amount_paid: 125000 },
    'subscriptions.retrieve': { id: 'sub_1', status: 'active', customer: 'cus_1', items: { data: [] } },
    'accounts.retrieve': { id: ACCOUNT, charges_enabled: true, details_submitted: true },
    'customers.retrieve': { id: 'cus_1', name: 'Acme' },
    'checkout.sessions.retrieve': { id: 'cs_1', subscription: 'sub_1' },
    ...over.stripe,
  });
  const request = await loadHandler('stripe-webhook', {
    db, stripe, modules: routing, mutate: only('stripe-webhook'),
    config: { STRIPE_WEBHOOK_SECRET: 'whsec_platform', STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect' },
  });
  return { db, stripe, request };
}

await test('a forged signature is rejected before anything is read or recorded', async () => {
  const f = await webhookFixture({ validSecret: 'whsec_nobody-has-this' });
  const out = await f.request({ headers: { 'stripe-signature': 'forged' }, jwt: null });
  assert.equal(out.status, 400);
  assert.equal(f.db.calls.length, 0, 'a forged delivery must not even be logged');
});

await test('the endpoint is decided by which secret verifies, not by the payload', async () => {
  const connect = await webhookFixture({ validSecret: 'whsec_connect' });
  await connect.request({ headers: { 'stripe-signature': 't=1,v1=x' }, jwt: null });
  const connectRecord = connect.db.calls.find((c) => c.rpc === 'stripe_record_webhook_event');
  assert.equal(connectRecord.args.p_endpoint, 'connect');

  // The SAME event type, verified by the platform secret, is refused rather
  // than filed as SILO revenue -- it carries an account id.
  const platform = await webhookFixture({ validSecret: 'whsec_platform' });
  const out = await platform.request({ headers: { 'stripe-signature': 't=1,v1=x' }, jwt: null });
  const record = platform.db.calls.find((c) => c.rpc === 'stripe_record_webhook_event');
  assert.equal(record.args.p_endpoint, 'platform');
  const finish = platform.db.calls.find((c) => c.rpc === 'stripe_finish_webhook_event');
  assert.equal(finish.args.p_status, 'error');
  assert.match(finish.args.p_error, /connected account/);
  assert.equal(out.status, 200, 'a mis-routed event is not worth retrying');
});

await test('the mirror is written from a RE-FETCH, never from the event body', async () => {
  // Stripe does not order deliveries, so the event body can be older than the
  // current state. This is the assertion that the ordering guarantee is real.
  const f = await webhookFixture();
  await f.request({ headers: { 'stripe-signature': 't=1,v1=x' }, jwt: null });
  assert.ok(f.stripe.pathsCalled().includes('invoices.retrieve'), 'the object is re-fetched');
  const sync = f.db.calls.find((c) => c.rpc === 'stripe_sync_invoice');
  assert.equal(sync.args.p_payload.status, 'paid', 'the FETCHED state is stored');
  assert.equal(sync.args.p_payload.amount_paid, 125000);
  assert.equal(sync.args.p_account, ACCOUNT);
});

await test('the connected account is passed to Stripe, so the fetch is scoped to the tenant', async () => {
  const f = await webhookFixture();
  await f.request({ headers: { 'stripe-signature': 't=1,v1=x' }, jwt: null });
  const call = f.stripe.calls.find((c) => c.path === 'invoices.retrieve');
  // Field by field, not deepEqual: objects built inside the vm carry that
  // realm's Object.prototype, and assert/strict compares prototypes.
  assert.equal(call.args[1]?.stripeAccount, ACCOUNT,
    'without Stripe-Account this reads SILO\'s own account, not the tenant\'s');
});

await test('a duplicate delivery is answered 200 and syncs nothing', async () => {
  const f = await webhookFixture({ record: 'terminal' });
  const out = await f.request({ headers: { 'stripe-signature': 't=1,v1=x' }, jwt: null });
  assert.equal(out.status, 200);
  assert.equal(out.body.duplicate, true);
  assert.equal(f.stripe.pathsCalled().filter((p) => p !== 'webhooks.constructEventAsync').length, 0);
  assert.equal(f.db.calls.some((c) => c.rpc === 'stripe_sync_invoice'), false);
});

await test('a handler failure answers 500, so Stripe delivers it again', async () => {
  const f = await webhookFixture({ stripe: { 'invoices.retrieve': new Error('Stripe is down') } });
  const out = await f.request({ headers: { 'stripe-signature': 't=1,v1=x' }, jwt: null });
  assert.equal(out.status, 500, 'a 200 here is the bug that loses an invoice.paid for good');
  const finish = f.db.calls.find((c) => c.rpc === 'stripe_finish_webhook_event');
  assert.equal(finish.args.p_status, 'error', 'and the row is left reclaimable');
});

await test('a LEASED delivery gets a non-2xx, so Stripe comes back', async () => {
  // The case that loses an event: a handler failed AND its status write failed
  // in the same outage, leaving the row `received`. Stripe's prompt retry
  // arrives inside the ten-minute lease. Answering 200 ends the retries on an
  // event nothing has processed.
  const f = await webhookFixture({ record: 'leased' });
  const out = await f.request({ headers: { 'stripe-signature': 't=1,v1=x' }, jwt: null });
  assert.ok(out.status >= 400, `a lease must not be acknowledged (got ${out.status})`);
  assert.equal(f.db.calls.some((c) => c.rpc === 'stripe_sync_invoice'), false);
});

await test('a failed STATUS WRITE answers 500 even when the handler succeeded', async () => {
  // Without this the row stays `received` with no recorded outcome, Stripe is
  // told 200, and nothing can reclaim it for ten minutes.
  const f = await webhookFixture({
    rpcs: { stripe_finish_webhook_event: { data: null, error: { message: 'db unreachable' } } },
  });
  const out = await f.request({ headers: { 'stripe-signature': 't=1,v1=x' }, jwt: null });
  assert.equal(out.status, 500);
  assert.match(out.body.error, /status write failed/);
});

await test('an event nobody owns is recorded unresolved, not guessed at', async () => {
  const f = await webhookFixture({ resolve: null });
  const out = await f.request({ headers: { 'stripe-signature': 't=1,v1=x' }, jwt: null });
  assert.equal(out.status, 200);
  const finish = f.db.calls.find((c) => c.rpc === 'stripe_finish_webhook_event');
  assert.equal(finish.args.p_status, 'unresolved');
  assert.equal(f.db.calls.some((c) => c.rpc === 'stripe_sync_invoice'), false);
});

await test('a deauthorization clears capabilities without a synthetic sync', async () => {
  const f = await webhookFixture({
    event: { ...EVENT, type: 'account.application.deauthorized', data: { object: { id: ACCOUNT } } },
  });
  await f.request({ headers: { 'stripe-signature': 't=1,v1=x' }, jwt: null });
  assert.ok(f.db.calls.some((c) => c.rpc === 'stripe_mark_connect_disconnected'));
  assert.equal(f.db.calls.some((c) => c.rpc === 'stripe_sync_connect_account'), false,
    'syncing a stub would erase the real country, currency and business name');
});

// ── stripe-connect ──────────────────────────────────────────────────────────

async function connectFixture(over = {}) {
  const db = fakeSupabase({
    user: over.user === undefined ? USER : over.user,
    tables: {
      profiles: [{ ...profileRow, ...(over.profile ?? {}) }],
      entities: [{ id: COMPANY, title: 'Baseballism' }, { id: OTHER_COMPANY, title: 'Rival' }],
      stripe_connect_accounts: over.connected
        ? [{ company_entity_id: COMPANY, stripe_account_id: ACCOUNT, account_type: 'standard' }] : [],
    },
    gates: { is_owner_admin_of_active_company: over.ownerAdmin ?? true },
    rpcs: {
      stripe_claim_connect_setup: over.claim ?? [{ outcome: 'claimed', stripe_account_id: null }],
      stripe_note_connect_setup_account: null,
      stripe_release_connect_setup: null,
      stripe_sync_connect_account: null,
      ...over.rpcs,
    },
  });
  const stripe = fakeStripe({
    'accounts.create': { id: 'acct_new_1', type: 'standard', charges_enabled: false },
    'accounts.retrieve': { id: ACCOUNT, charges_enabled: true, payouts_enabled: true, details_submitted: true, requirements: {} },
    'accountLinks.create': { url: 'https://connect.stripe.test/setup/xyz' },
    ...over.stripe,
  });
  const request = await loadHandler('stripe-connect', { db, stripe, mutate: only('stripe-connect') });
  return { db, stripe, request };
}

await test('connect: no session is 401, and a non-owner-admin is 403 before Stripe', async () => {
  const anon = await connectFixture({ user: null });
  assert.equal((await anon.request({ body: { action: 'start' } })).status, 401);

  const admin = await connectFixture({ ownerAdmin: false });
  const out = await admin.request({ body: { action: 'start' } });
  assert.equal(out.status, 403);
  assert.equal(admin.stripe.calls.length, 0, 'a refused caller must not reach Stripe');
});

await test('connect: the gate is the database\'s answer about THIS user', async () => {
  const f = await connectFixture();
  await f.request({ body: { action: 'start' } });
  const gate = f.db.calls.find((c) => c.gate === 'is_owner_admin_of_active_company');
  assert.ok(gate, 'the gate must be asked, not assumed');
  assert.equal(gate.key, 'anon-key', 'asked with the anon key...');
  assert.equal(gate.authorization, 'Bearer good-jwt', '...carrying the caller\'s own token');
});

await test('connect: the company comes from the profile, never from the body', async () => {
  const f = await connectFixture();
  await f.request({ body: { action: 'start', company_entity_id: OTHER_COMPANY } });
  const claim = f.db.calls.find((c) => c.rpc === 'stripe_claim_connect_setup');
  assert.equal(claim.args.p_company, COMPANY,
    'a body-supplied company would attach a Stripe account to somebody else\'s tenant');
});

await test('connect: the account id is recorded BEFORE the mirror write', async () => {
  // This is what makes a crash in the next few milliseconds recoverable rather
  // than a second merchant account ten minutes later.
  const f = await connectFixture();
  const out = await f.request({ body: { action: 'start' } });
  assert.equal(out.status, 200);
  const order = f.db.calls.filter((c) => c.rpc).map((c) => c.rpc);
  const note = order.indexOf('stripe_note_connect_setup_account');
  const sync = order.indexOf('stripe_sync_connect_account');
  assert.ok(note >= 0 && sync >= 0, 'both must happen');
  assert.ok(note < sync, 'recording the account id after the mirror write closes nothing');
  assert.ok(order.indexOf('stripe_release_connect_setup') > sync, 'released only once mirrored');
});

await test('connect: the create carries a company-scoped idempotency key', async () => {
  // The claim covers a crash after Stripe answered. This covers the answer
  // never arriving: without the key, the stale claim is legitimately retaken
  // ten minutes later and opens a SECOND merchant identity in the client's
  // Stripe. Keyed on the company, not the attempt, so every attempt collapses
  // onto one account.
  const f = await connectFixture();
  await f.request({ body: { action: 'start' } });
  const create = f.stripe.calls.find((c) => c.path === 'accounts.create');
  assert.equal(create.args[1]?.idempotencyKey, `silo-connect-account-${COMPANY}`);
});

await test('connect: a second tab is refused, and creates nothing', async () => {
  const f = await connectFixture({ claim: [{ outcome: 'in_flight', stripe_account_id: null }] });
  const out = await f.request({ body: { action: 'start' } });
  assert.equal(out.status, 409);
  assert.match(out.body.error, /already in progress/);
  assert.equal(f.stripe.pathsCalled().includes('accounts.create'), false,
    'the whole point is that a second merchant account is never opened');
});

await test('connect: a crashed attempt is ADOPTED, not duplicated', async () => {
  const f = await connectFixture({
    claim: [{ outcome: 'adopt', stripe_account_id: 'acct_orphan_1' }],
    stripe: { 'accounts.retrieve': { id: 'acct_orphan_1', charges_enabled: false, requirements: {} } },
  });
  const out = await f.request({ body: { action: 'start' } });
  assert.equal(out.status, 200);
  assert.equal(f.stripe.pathsCalled().includes('accounts.create'), false);
  const sync = f.db.calls.find((c) => c.rpc === 'stripe_sync_connect_account');
  assert.equal(sync.args.p_payload.id, 'acct_orphan_1');
});

await test('connect: when the mirror write fails, the claim is KEPT', async () => {
  const f = await connectFixture({ rpcs: { stripe_sync_connect_account: { data: null, error: { message: 'db down' } } } });
  const out = await f.request({ body: { action: 'start' } });
  assert.equal(out.status, 502);
  assert.equal(f.db.calls.some((c) => c.rpc === 'stripe_release_connect_setup'), false,
    'releasing here lets the next attempt open a second Stripe account');
});

await test('connect: refresh reports what Stripe says, not what the mirror holds', async () => {
  const f = await connectFixture({ connected: true });
  const out = await f.request({ body: { action: 'refresh' } });
  assert.equal(out.body.charges_enabled, true);
  assert.ok(f.stripe.pathsCalled().includes('accounts.retrieve'));
});

// ── stripe-invoice ──────────────────────────────────────────────────────────

const GOOD_LINES = [{ description: 'Spring order', quantity: 10, unit_amount: '19.99' }];
const REQ_ID = '11111111-2222-4333-8444-555555555555';

async function invoiceFixture(over = {}) {
  const db = fakeSupabase({
    user: over.user === undefined ? USER : over.user,
    tables: {
      profiles: [{ ...profileRow, ...(over.profile ?? {}) }],
      stripe_connect_accounts: over.connected === false ? []
        : [{ company_entity_id: COMPANY, stripe_account_id: ACCOUNT, charges_enabled: true, details_submitted: true }],
      stripe_invoices: over.invoices ?? [
        { id: 'row-1', company_entity_id: COMPANY, stripe_invoice_id: 'in_existing', request_id: null },
        { id: 'row-2', company_entity_id: OTHER_COMPANY, stripe_invoice_id: 'in_other', request_id: null },
      ],
    },
    gates: { can_manage_client_invoices: over.canInvoice ?? true },
    rpcs: {
      stripe_begin_invoice_request: over.claim ?? [{ already: false, status: 'pending', stripe_object_id: null }],
      stripe_complete_invoice_request: null,
      stripe_sync_invoice: 'row-9',
      stripe_sync_invoice_customer: 'cust-9',
      ...over.rpcs,
    },
  });
  const stripe = fakeStripe({
    'invoices.create': { id: 'in_new', status: 'draft', total: 199900 },
    'invoiceItems.create': { id: 'ii_1' },
    'invoices.retrieve': { id: 'in_new', status: 'draft', total: 199900, lines: { data: [] } },
    'invoices.sendInvoice': { id: 'in_existing', status: 'open', hosted_invoice_url: 'https://pay.test/x' },
    'invoices.voidInvoice': { id: 'in_existing', status: 'void' },
    'customers.create': { id: 'cus_new', name: 'Acme' },
    ...over.stripe,
  });
  const request = await loadHandler('stripe-invoice', { db, stripe, modules: lines, mutate: only('stripe-invoice') });
  return { db, stripe, request };
}

await test('invoice: a user without the gate is refused before Stripe', async () => {
  const f = await invoiceFixture({ canInvoice: false });
  const out = await f.request({ body: { action: 'create_invoice', request_id: REQ_ID, customer_id: 'cus_1', lines: GOOD_LINES } });
  assert.equal(out.status, 403);
  assert.equal(f.stripe.calls.length, 0);
});

await test('invoice: a company with no connected account gets 409, not a confusing Stripe error', async () => {
  const f = await invoiceFixture({ connected: false });
  const out = await f.request({ body: { action: 'create_invoice', request_id: REQ_ID, customer_id: 'cus_1', lines: GOOD_LINES } });
  assert.equal(out.status, 409);
  assert.equal(f.stripe.calls.length, 0);
});

await test('invoice: every line is validated BEFORE anything exists in Stripe', async () => {
  const f = await invoiceFixture();
  const out = await f.request({ body: {
    action: 'create_invoice', request_id: REQ_ID, customer_id: 'cus_1',
    lines: [...GOOD_LINES, { description: '', unit_amount: '5.00' }],
  } });
  assert.equal(out.status, 400);
  assert.match(out.body.error, /Line 2/);
  assert.equal(f.stripe.calls.length, 0,
    'a failure partway through leaves a half-built draft in the client\'s real Stripe');
});

await test('invoice: a missing request id is refused -- the ledger is not optional', async () => {
  const f = await invoiceFixture();
  const out = await f.request({ body: { action: 'create_invoice', customer_id: 'cus_1', lines: GOOD_LINES } });
  assert.equal(out.status, 400);
  assert.match(out.body.error, /request_id/);
  assert.equal(f.stripe.calls.length, 0);
});

await test('invoice: a create claims the ledger, then builds draft-then-items', async () => {
  const f = await invoiceFixture();
  const out = await f.request({ body: { action: 'create_invoice', request_id: REQ_ID, customer_id: 'cus_1', lines: GOOD_LINES } });
  assert.equal(out.status, 200);
  const order = f.db.calls.filter((c) => c.rpc).map((c) => c.rpc);
  assert.ok(order.indexOf('stripe_begin_invoice_request') === 0, 'the key is claimed before Stripe');
  const paths = f.stripe.pathsCalled();
  assert.ok(paths.indexOf('invoices.create') < paths.indexOf('invoiceItems.create'),
    'pending invoice items attach themselves to whatever invoice is created next');
  const item = f.stripe.calls.find((c) => c.path === 'invoiceItems.create');
  assert.equal(item.args[0].unit_amount, 1999, 'the amount is minor units, computed server-side');
  assert.equal(item.args[1].idempotencyKey, `silo-invoice-${REQ_ID}-line-0`);
  const complete = f.db.calls.find((c) => c.rpc === 'stripe_complete_invoice_request');
  assert.equal(complete.args.p_status, 'succeeded');
});

await test('invoice: a replayed request returns the FIRST invoice and creates nothing', async () => {
  const f = await invoiceFixture({
    claim: [{ already: true, status: 'succeeded', stripe_object_id: 'in_first' }],
    stripe: { 'invoices.retrieve': { id: 'in_first', status: 'open', lines: { data: [] } } },
  });
  const out = await f.request({ body: { action: 'create_invoice', request_id: REQ_ID, customer_id: 'cus_1', lines: GOOD_LINES } });
  assert.equal(out.status, 200);
  assert.equal(out.body.repeated, true);
  assert.equal(f.stripe.pathsCalled().includes('invoices.create'), false,
    'the lost-response retry must not bill the customer twice');
});

await test('invoice: an attempt still in flight is refused rather than duplicated', async () => {
  const f = await invoiceFixture({ claim: [{ already: true, status: 'pending', stripe_object_id: null }] });
  const out = await f.request({ body: { action: 'create_invoice', request_id: REQ_ID, customer_id: 'cus_1', lines: GOOD_LINES } });
  assert.equal(out.status, 400);
  assert.match(out.body.error, /already being created/);
  assert.equal(f.stripe.pathsCalled().includes('invoices.create'), false);
});

await test('invoice: a half-built draft is still mirrored, never left invisible', async () => {
  const f = await invoiceFixture({ stripe: { 'invoiceItems.create': new Error('card_error') } });
  const out = await f.request({ body: { action: 'create_invoice', request_id: REQ_ID, customer_id: 'cus_1', lines: GOOD_LINES } });
  assert.equal(out.status, 502);
  const complete = f.db.calls.find((c) => c.rpc === 'stripe_complete_invoice_request');
  assert.equal(complete.args.p_status, 'failed');
  assert.equal(complete.args.p_object_id, 'in_new');
  assert.ok(f.db.calls.some((c) => c.rpc === 'stripe_sync_invoice'),
    'it exists in the client\'s Stripe either way -- an orphan nobody can see is one nobody can void');
});

await test('invoice: an action names a SILO row, never a Stripe id from the body', async () => {
  const f = await invoiceFixture();
  // The body carries BOTH a legitimate row id and a Stripe id for somebody
  // else's invoice. Only the row is consulted -- `in_xxx` ids appear in
  // customers' emails, so accepting one would make voiding an invoice a matter
  // of knowing its id.
  const out = await f.request({ body: {
    action: 'send', invoice_id: 'row-1', stripe_invoice_id: 'in_someone_elses',
  } });
  assert.equal(out.status, 200);
  assert.equal(f.stripe.calls.find((c) => c.path === 'invoices.sendInvoice').args[0], 'in_existing',
    'the Stripe id is read from the row, never taken from the request');

  // Another company's row is not this caller's to send, and `in_xxx` ids appear
  // in customers' emails.
  const other = await invoiceFixture();
  const denied = await other.request({ body: { action: 'send', invoice_id: 'row-2' } });
  assert.equal(denied.status, 400);
  assert.match(denied.body.error, /No such invoice/);
  assert.equal(other.stripe.calls.length, 0);
});

// ── stripe-billing ──────────────────────────────────────────────────────────

async function billingFixture(over = {}) {
  const db = fakeSupabase({
    user: over.user === undefined ? USER : over.user,
    tables: {
      profiles: [{ ...profileRow, ...(over.profile ?? {}) }],
      entities: [{ id: COMPANY, title: 'Baseballism' }],
      billing_plans: [{ plan_key: 'growth', stripe_price_id: 'price_growth', seat_based: over.seatBased ?? false, is_active: true }],
      billing_subscriptions: over.subscription ? [{ company_entity_id: COMPANY, ...over.subscription }] : [],
      entity_memberships: (over.members ?? 3) > 0
        ? Array.from({ length: over.members ?? 3 }, (_, i) => ({ entity_id: COMPANY, user_id: `u${i}` })) : [],
    },
    gates: { is_owner_admin_of_active_company: over.ownerAdmin ?? true },
    rpcs: { stripe_begin_checkout: null, stripe_sync_subscription: null, stripe_sync_billing_invoice: null, ...over.rpcs },
  });
  const stripe = fakeStripe({
    'customers.create': { id: 'cus_platform_1' },
    'checkout.sessions.create': { url: 'https://checkout.stripe.test/c/pay/cs_1' },
    'billingPortal.sessions.create': { url: 'https://billing.stripe.test/p/session/x' },
    ...over.stripe,
  });
  const request = await loadHandler('stripe-billing', { db, stripe, modules: subState, mutate: only('stripe-billing') });
  return { db, stripe, request };
}

await test('billing: only an owner-admin may change the subscription', async () => {
  const f = await billingFixture({ ownerAdmin: false });
  const out = await f.request({ body: { action: 'checkout', plan_key: 'growth' } });
  assert.equal(out.status, 403);
  assert.equal(f.stripe.calls.length, 0);
});

await test('billing: a live subscriber cannot open a second Checkout', async () => {
  for (const status of ['active', 'trialing', 'past_due', 'unpaid']) {
    const f = await billingFixture({ subscription: { status, plan_key: 'growth', stripe_customer_id: 'cus_1' } });
    const out = await f.request({ body: { action: 'checkout', plan_key: 'growth' } });
    assert.equal(out.status, 502, `${status} must be refused`);
    assert.match(out.body.error, /billing portal/i);
    assert.equal(f.stripe.pathsCalled().includes('checkout.sessions.create'), false,
      `${status}: a second subscription would bill the tenant twice`);
  }
});

await test('billing: a stale mirror does not permit a second subscription', async () => {
  // The first Checkout completed at Stripe, its webhook has not landed, the
  // redirect was lost, and the local row is still the `incomplete` placeholder.
  // Trusting the mirror here offers Subscribe again and bills twice.
  const f = await billingFixture({
    subscription: { status: 'incomplete', stripe_customer_id: 'cus_1' },
    stripe: { 'subscriptions.list': { data: [{ id: 'sub_live', status: 'active' }] } },
  });
  const out = await f.request({ body: { action: 'checkout', plan_key: 'growth' } });
  assert.equal(out.status, 502);
  assert.match(out.body.error, /already has a live subscription at Stripe/);
  assert.equal(f.stripe.pathsCalled().includes('checkout.sessions.create'), false,
    'Stripe is the record; the mirror is a cache, and this is the read where believing it costs money');
  assert.ok(f.db.calls.some((c) => c.rpc === 'stripe_sync_subscription'),
    'and the mirror is reconciled while we are here, so the page stops offering it too');
});

await test('billing: with the customer known and Stripe clear, Checkout proceeds', async () => {
  const f = await billingFixture({
    subscription: { status: 'canceled', stripe_customer_id: 'cus_1' },
    stripe: { 'subscriptions.list': { data: [{ id: 'sub_old', status: 'canceled' }] } },
  });
  const out = await f.request({ body: { action: 'checkout', plan_key: 'growth' } });
  assert.equal(out.status, 200);
  assert.ok(f.stripe.pathsCalled().includes('subscriptions.list'), 'Stripe was asked');
});

await test('billing: a cancelled subscriber may subscribe again', async () => {
  const f = await billingFixture({
    subscription: { status: 'canceled', plan_key: 'growth', stripe_customer_id: 'cus_1' },
    stripe: { 'subscriptions.list': { data: [] } },
  });
  const out = await f.request({ body: { action: 'checkout', plan_key: 'growth' } });
  assert.equal(out.status, 200);
  assert.ok(out.body.url.startsWith('https://checkout.stripe.test/'));
  assert.equal(f.stripe.pathsCalled().includes('customers.create'), false,
    'the existing Stripe customer is reused, not duplicated');
});

await test('billing: the price comes from billing_plans, never from the request', async () => {
  const f = await billingFixture();
  await f.request({ body: { action: 'checkout', plan_key: 'growth', price_id: 'price_one_cent' } });
  const session = f.stripe.calls.find((c) => c.path === 'checkout.sessions.create');
  assert.equal(session.args[0].line_items[0].price, 'price_growth',
    'a client-supplied price is a client-chosen price');
});

await test('billing: seats are MEASURED from memberships, not asked for', async () => {
  const f = await billingFixture({ seatBased: true, members: 7 });
  await f.request({ body: { action: 'checkout', plan_key: 'growth', quantity: 1 } });
  const session = f.stripe.calls.find((c) => c.path === 'checkout.sessions.create');
  assert.equal(session.args[0].line_items[0].quantity, 7,
    'otherwise a company buys one seat and invites thirty');
});

await test('billing: the customer is recorded before the browser leaves for Stripe', async () => {
  const f = await billingFixture();
  await f.request({ body: { action: 'checkout', plan_key: 'growth' } });
  const order = [
    ...f.db.calls.filter((c) => c.rpc === 'stripe_begin_checkout').map(() => 'record'),
    ...f.stripe.calls.filter((c) => c.path === 'checkout.sessions.create').map(() => 'session'),
  ];
  assert.deepEqual(order, ['record', 'session'],
    'the subscription webhook is attributed by that customer id and can arrive first');
});

await test('billing: an unknown or inactive plan is refused', async () => {
  const f = await billingFixture();
  const out = await f.request({ body: { action: 'checkout', plan_key: 'enterprise-unlimited' } });
  assert.equal(out.status, 502);
  assert.match(out.body.error, /not available/);
  assert.equal(f.stripe.calls.length, 0);
});

console.log(`\n${passed} handler scenarios passed`);
if (mutation) {
  console.error(`\nFAILED: mutation ${mutation} did not break the suite -- `
    + 'the property it removes is untested');
  process.exit(1);
}
