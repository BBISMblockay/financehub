// The customer-onboarding Edge Function handler, EXECUTED, plus the webhook's
// new setup-capture path.
//
// What this suite is for: this function is PUBLIC. It has no JWT, no RLS
// behind it (it holds the service-role key), and it can create a Stripe
// customer and a payment-method capture session. Every guard it has is a line
// of orchestration, and CLAUDE.md records what happens in this repo when
// orchestration is only `deno check`ed -- a dead-zone reference shipped inside
// a callback whose core had 91 passing assertions.
//
// Only Stripe and Supabase are synthetic. The code under test is the code that
// deploys, loaded from handler.ts and type-stripped.
//
// Mutations (each must make a specific assertion fail):
//   CUSTOMER_ONBOARDING_MUTATION=body-account        (the account comes from the request body)
//   CUSTOMER_ONBOARDING_MUTATION=note-ignored        (a failed session record still hands out the URL)
//   CUSTOMER_ONBOARDING_MUTATION=unknown-status-restarts (an unreadable session status restarts)
//   CUSTOMER_ONBOARDING_MUTATION=attempt-not-bumped  (a restart reuses the released attempt's key)
//   CUSTOMER_ONBOARDING_MUTATION=no-reclaim          (a restart creates a session without re-claiming)
//   CUSTOMER_ONBOARDING_MUTATION=consent-from-page   (the stored consent text is what the page sent)
//   CUSTOMER_ONBOARDING_MUTATION=consent-not-checked (a session is created without consent)
//   CUSTOMER_ONBOARDING_MUTATION=webhook-any-mode    (a non-setup Checkout is acted on)
//   CUSTOMER_ONBOARDING_MUTATION=webhook-default-fatal (a failed default-PM update throws)
//   CUSTOMER_ONBOARDING_MUTATION=webhook-trusts-session (the SetupIntent is read from the payload)
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e && e.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import { fakeSupabase, fakeStripe, loadHandler } from './lib/stripe-handler-harness.mjs';
import * as rules from '../../supabase/functions/customer-onboarding/onboarding-rules.mjs';
import * as routing from '../../supabase/functions/stripe-webhook/event-routing.mjs';
const { CONNECT_EVENTS, PLATFORM_EVENTS, routeEvent } = routing;

const mutation = process.env.CUSTOMER_ONBOARDING_MUTATION || '';
assert.ok([
  '', 'body-account', 'note-ignored', 'unknown-status-restarts', 'attempt-not-bumped', 'no-reclaim',
  'consent-from-page', 'consent-not-checked', 'webhook-any-mode', 'webhook-default-fatal',
  'webhook-trusts-session',
].includes(mutation), `Unknown mutation: ${mutation}`);

const HANDLER_MUTATIONS = {
  'body-account': (s) => s.replace(
    "  const tok = await resolve(body?.token, 'card_setup');\n  const account = await loadAccount(tok.accountId);",
    "  const tok = await resolve(body?.token, 'card_setup');\n  if (body?.customer_account_id) tok.accountId = body.customer_account_id;\n  const account = await loadAccount(tok.accountId);"),
  'note-ignored': (s) => s.replace(
    `  if (noted !== true) {
    throw new OnboardingError(
      'The card step could not be started just now — please try again shortly', 503);
  }`, '  // mutated: the record is not checked'),
  'unknown-status-restarts': (s) => s.replace(
    "      const decision = decideSetupSession(existing.status);",
    "      const decision = existing.status === 'open' ? { action: 'replay' } : { action: 'restart' };"),
  'attempt-not-bumped': (s) => s.replace(
    '      attempt = reclaim.attempt as number;', '      attempt = 0;'),
  'no-reclaim': (s) => s.replace(
    /      const \{ data: reclaimRows, error: reclaimErr \} = await db\.rpc\([\s\S]*?      attempt = reclaim\.attempt as number;/,
    '      attempt = bumped as number;'),
  'consent-from-page': (s) => s.replace(
    '    p_text: CONSENT_TEXT,', '    p_text: body?.text ?? CONSENT_TEXT,'),
  'consent-not-checked': (s) => s.replace(
    `  if (!consentIsCurrent(account)) {
    throw new OnboardingError('Authorization is required before a card can be saved', 428);
  }`, '  // mutated: consent is not checked'),
};

const WEBHOOK_MUTATIONS = {
  'webhook-any-mode': (s) => s.replace(
    "      if (session.mode !== 'setup') return;\n\n      const setupIntentId",
    "      const setupIntentId"),
  'webhook-default-fatal': (s) => s.replace(
    `        console.error('default_payment_method update failed', customerId,
          (e as Error)?.message);`,
    '        throw e;'),
  'webhook-trusts-session': (s) => s.replace(
    '      const intent = await stripe.setupIntents.retrieve(setupIntentId, opts);',
    '      const intent = (event.data.object as any).setup_intent_object;'),
};

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT = '22222222-2222-4222-8222-222222222222';
const COMPANY = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'a'.repeat(48);

function accountRow(over = {}) {
  return {
    id: ACCOUNT,
    company_entity_id: COMPANY,
    status: 'submitted',
    account_type: 'wholesale',
    legal_name: 'Dugout Sports LLC',
    contact_email: 'buyer@dugout.test',
    stripe_customer_id: null,
    card_setup_status: 'not_started',
    card_setup_session_id: null,
    card_setup_attempt: 0,
    card_payment_method_id: null,
    card_brand: null,
    card_last4: null,
    card_exp_month: null,
    card_exp_year: null,
    default_payment_method_set_at: null,
    off_session_consent_at: '2026-09-19T10:00:00Z',
    off_session_consent_version: rules.CONSENT_VERSION,
    ...over,
  };
}

function baseDb({ account = accountRow(), resolve = null, rpcs = {}, storage = {} } = {}) {
  return fakeSupabase({
    tables: {
      customer_accounts: [account, accountRow({ id: OTHER_ACCOUNT, legal_name: 'Someone Else' })],
      entities: [{ id: COMPANY, title: 'Baseballism' }],
      stripe_connect_accounts: [
        { company_entity_id: COMPANY, stripe_account_id: 'acct_tenant', charges_enabled: true },
      ],
      customer_account_tax_profiles: [],
    },
    storage,
    rpcs: {
      customer_onboarding_resolve_token: resolve ?? (() => [{
        ok: true, reason: 'ok', invite_id: 'inv-1',
        customer_account_id: ACCOUNT, company_entity_id: COMPANY, email: 'buyer@dugout.test',
      }]),
      ...rpcs,
    },
  });
}

async function onboarding(opts = {}) {
  return await loadHandler('customer-onboarding', {
    ...opts,
    modules: { ...rules },
    mutate: HANDLER_MUTATIONS[mutation],
  });
}

// ════════════════════════════════════════════════════════════════════════════
// The token IS the authorization
// ════════════════════════════════════════════════════════════════════════════

await test('an expired token is refused with 410 and a reason a person can act on', async () => {
  const db = baseDb({
    resolve: () => [{ ok: false, reason: 'expired', invite_id: 'inv-1',
      customer_account_id: ACCOUNT, company_entity_id: COMPANY, email: 'buyer@dugout.test' }],
  });
  const call = await onboarding({ db, stripe: fakeStripe() });
  const res = await call({ body: { action: 'peek', token: TOKEN } });
  assert.equal(res.status, 410);
  assert.match(res.body.error, /expired/i);
});

await test('a consumed token is refused, and not as "expired"', async () => {
  const db = baseDb({
    resolve: () => [{ ok: false, reason: 'consumed', invite_id: null,
      customer_account_id: null, company_entity_id: null, email: null }],
  });
  const call = await onboarding({ db, stripe: fakeStripe() });
  const res = await call({ body: { action: 'peek', token: TOKEN } });
  assert.equal(res.status, 404);
  assert.match(res.body.error, /already been used/i);
});

await test('a replayed onboarding token after approval is refused, not reopened', async () => {
  const db = baseDb({
    rpcs: {
      submit_customer_account: () => ({
        data: null, error: { code: '28000', message: 'account_approved' },
      }),
    },
  });
  const call = await onboarding({ db, stripe: fakeStripe() });
  const res = await call({ body: { action: 'submit', token: TOKEN, form: validForm() } });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /already been completed/i);
});

await test('the request body cannot name which account is acted on', async () => {
  let claimedFor = null;
  const db = baseDb({
    account: accountRow({ card_setup_status: 'succeeded' }),
    rpcs: {
      claim_customer_card_setup: (args) => {
        claimedFor = args.p_account_id;
        return [{ allowed: false, reason: 'already_captured', existing_session_id: null, attempt: 0 }];
      },
    },
  });
  const call = await onboarding({ db, stripe: fakeStripe() });
  await call({
    body: {
      action: 'start_card_setup',
      token: TOKEN,
      // Everything an attacker would try. The token resolves to ACCOUNT.
      customer_account_id: OTHER_ACCOUNT,
      company_entity_id: 'not-a-company',
      stripe_customer_id: 'cus_attacker',
    },
  });
  assert.equal(claimedFor, ACCOUNT,
    'the account acted on must come from the resolved token, never the body');
});

// ════════════════════════════════════════════════════════════════════════════
// Submission
// ════════════════════════════════════════════════════════════════════════════

function validForm(over = {}) {
  return {
    legal_name: 'Dugout Sports LLC',
    dba_name: 'Dugout',
    federal_ein: '12-3456789',
    resale_tax_id: 'CA-998877',
    addresses: [
      { address_type: 'business', street1: '1 Main St', city: 'Portland', region: 'OR',
        postal_code: '97201', country: 'US' },
      { address_type: 'shipping', same_as_address_type: 'business', attention_name: 'Receiving' },
      { address_type: 'billing', same_as_address_type: 'business' },
    ],
    contacts: [
      { contact_type: 'primary', first_name: 'Sam', last_name: 'Reed',
        title: 'Owner', email: 'sam@dugout.test', phone: '503-555-0101' },
    ],
    ...over,
  };
}

await test('a submission cannot set internal terms, links or card columns', async () => {
  let sent = null;
  const db = baseDb({
    rpcs: {
      submit_customer_account: (args) => {
        sent = args.p_payload;
        return { continuation_token: 'cont', expires_at: '2026-09-19T12:00:00Z' };
      },
    },
  });
  const call = await onboarding({ db, stripe: fakeStripe() });
  const res = await call({
    body: {
      action: 'submit',
      token: TOKEN,
      form: validForm({
        approved_payment_terms: 'Net 90',
        credit_limit: 9999999,
        price_tier: 'platinum',
        stripe_customer_id: 'cus_attacker',
        qbo_customer_id: '42',
        ar_customer_id: ACCOUNT,
        status: 'approved',
        card_payment_method_id: 'pm_attacker',
      }),
    },
  });
  assert.equal(res.status, 200);
  for (const forbidden of [
    'approved_payment_terms', 'credit_limit', 'price_tier', 'stripe_customer_id',
    'qbo_customer_id', 'ar_customer_id', 'status', 'card_payment_method_id',
  ]) {
    assert.ok(!(forbidden in sent),
      `${forbidden} must not be constructible from a submission payload`);
  }
  // The applicant's own request IS carried -- it is a different fact.
  assert.equal(sent.requested_payment_terms ?? null, null);
});

await test('the submission hands back a continuation token, not the original', async () => {
  const db = baseDb({
    rpcs: {
      submit_customer_account: () => ({
        continuation_token: 'continuation-xyz', expires_at: '2026-09-19T12:00:00Z',
      }),
    },
  });
  const call = await onboarding({ db, stripe: fakeStripe() });
  const res = await call({ body: { action: 'submit', token: TOKEN, form: validForm() } });
  assert.equal(res.body.continuation_token, 'continuation-xyz');
  assert.notEqual(res.body.continuation_token, TOKEN);
});

await test('an incomplete submission is refused before the database is touched', async () => {
  const db = baseDb({ rpcs: { submit_customer_account: () => { throw new Error('reached'); } } });
  const call = await onboarding({ db, stripe: fakeStripe() });
  const res = await call({
    body: { action: 'submit', token: TOKEN, form: validForm({ legal_name: '  ' }) },
  });
  assert.equal(res.status, 422);
  assert.match(res.body.error, /Legal business name is required/);
});

// ════════════════════════════════════════════════════════════════════════════
// Consent
// ════════════════════════════════════════════════════════════════════════════

await test('the stored consent text is the function\'s own, not what the page sent', async () => {
  let stored = null;
  const db = baseDb({
    rpcs: { record_customer_account_consent: (args) => { stored = args; return null; } },
  });
  const call = await onboarding({ db, stripe: fakeStripe() });
  await call({
    body: { action: 'consent', token: TOKEN, accepted: true, text: 'I agree to anything at all' },
  });
  assert.equal(stored.p_text, rules.CONSENT_TEXT);
  assert.equal(stored.p_version, rules.CONSENT_VERSION);
  assert.match(stored.p_text, /when I am not present/,
    'the authorisation must state that charges may occur off-session');
  assert.match(stored.p_text, /equal the total of the invoice/,
    'the authorisation must state how the amount is determined');
});

await test('a card session is refused when consent is missing or stale', async () => {
  for (const account of [
    accountRow({ off_session_consent_at: null }),
    accountRow({ off_session_consent_version: '2020-01-01.v0' }),
  ]) {
    const db = baseDb({
      account,
      rpcs: { claim_customer_card_setup: () => { throw new Error('must not be reached'); } },
    });
    const call = await onboarding({ db, stripe: fakeStripe() });
    const res = await call({ body: { action: 'start_card_setup', token: TOKEN } });
    assert.equal(res.status, 428);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Card setup: replay, never a second payable session
// ════════════════════════════════════════════════════════════════════════════

function setupStripe(script = {}) {
  return fakeStripe({
    'customers.create': { id: 'cus_new', object: 'customer' },
    'checkout.sessions.create': { id: 'cs_new', url: 'https://checkout.test/cs_new' },
    ...script,
  });
}

function setupRpcs(over = {}) {
  return {
    claim_customer_card_setup: () => [
      { allowed: true, reason: 'ok', existing_session_id: null, attempt: 0 },
    ],
    bind_customer_account_stripe_customer: () => ({ ok: true }),
    stripe_sync_invoice_customer: () => null,
    note_customer_card_setup_session: () => true,
    release_customer_card_setup: () => 1,
    ...over,
  };
}

await test('an open session is replayed, and no second session is created', async () => {
  const db = baseDb({
    account: accountRow({
      stripe_customer_id: 'cus_existing',
      card_setup_status: 'session_open', card_setup_session_id: 'cs_open',
    }),
    rpcs: setupRpcs({
      claim_customer_card_setup: () => [
        { allowed: false, reason: 'session_open', existing_session_id: 'cs_open', attempt: 0 },
      ],
    }),
  });
  const stripe = setupStripe({
    'checkout.sessions.retrieve': { id: 'cs_open', status: 'open', url: 'https://checkout.test/cs_open' },
  });
  const call = await onboarding({ db, stripe });
  const res = await call({ body: { action: 'start_card_setup', token: TOKEN } });

  assert.equal(res.body.replayed, true);
  assert.equal(res.body.url, 'https://checkout.test/cs_open');
  assert.ok(!stripe.pathsCalled().includes('checkout.sessions.create'),
    'a retry must replay the open session, never mint a second payable one');
});

await test('a session Stripe cannot report on REFUSES rather than restarting', async () => {
  const db = baseDb({
    account: accountRow({
      stripe_customer_id: 'cus_existing',
      card_setup_status: 'session_open', card_setup_session_id: 'cs_open',
    }),
    rpcs: setupRpcs({
      claim_customer_card_setup: () => [
        { allowed: false, reason: 'session_open', existing_session_id: 'cs_open', attempt: 0 },
      ],
    }),
  });
  // A 500 from Stripe -- NOT a 404. The lookup must not read this as "gone".
  const stripe = setupStripe({
    'checkout.sessions.retrieve': Object.assign(new Error('Stripe is having a moment'),
      { statusCode: 500 }),
  });
  const call = await onboarding({ db, stripe });
  const res = await call({ body: { action: 'start_card_setup', token: TOKEN } });

  assert.equal(res.status, 503);
  assert.ok(!stripe.pathsCalled().includes('checkout.sessions.create'),
    'an unreadable status must never open a second session beside one still open');
});

await test('a definitively expired session restarts with a NEW idempotency key', async () => {
  // The claim is state-dependent, like the real one: refused while the dead
  // session is still on the row, granted once the release has cleared it. A
  // stub that always refused would hide the fact that the handler has to
  // RE-CLAIM before creating -- the row is 'abandoned' after a release, and
  // note_customer_card_setup_session() only writes against a live claim.
  let released = false;
  const db = baseDb({
    account: accountRow({
      stripe_customer_id: 'cus_existing',
      card_setup_status: 'session_open', card_setup_session_id: 'cs_dead',
    }),
    rpcs: setupRpcs({
      claim_customer_card_setup: () => [released
        ? { allowed: true, reason: 'ok', existing_session_id: null, attempt: 1 }
        : { allowed: false, reason: 'session_open', existing_session_id: 'cs_dead', attempt: 0 }],
      release_customer_card_setup: () => { released = true; return 1; },
      note_customer_card_setup_session: () => released,
    }),
  });
  const stripe = setupStripe({
    'checkout.sessions.retrieve': { id: 'cs_dead', status: 'expired', url: null },
  });
  const call = await onboarding({ db, stripe });
  const res = await call({ body: { action: 'start_card_setup', token: TOKEN } });

  assert.equal(res.body.replayed, false);
  const create = stripe.calls.find((c) => c.path === 'checkout.sessions.create');
  assert.ok(create, 'a restart must create a session');
  assert.equal(create.args[1].idempotencyKey, `silo-setup-${ACCOUNT}-1`,
    'the restart must carry the BUMPED attempt -- reusing the released one replays the dead session');
  const claims = db.calls.filter((c) => c.rpc === 'claim_customer_card_setup');
  assert.equal(claims.length, 2,
    'the released row is abandoned -- it must be claimed again or the new session is never recorded');
  assert.equal(res.status, 200, 'and the applicant must actually get a URL');
  assert.ok(res.body.url);
});

await test('a completed session reports captured rather than creating another', async () => {
  const db = baseDb({
    account: accountRow({
      stripe_customer_id: 'cus_existing',
      card_setup_status: 'session_open', card_setup_session_id: 'cs_done',
    }),
    rpcs: setupRpcs({
      claim_customer_card_setup: () => [
        { allowed: false, reason: 'session_open', existing_session_id: 'cs_done', attempt: 0 },
      ],
    }),
  });
  const stripe = setupStripe({
    'checkout.sessions.retrieve': { id: 'cs_done', status: 'complete', url: null },
  });
  const call = await onboarding({ db, stripe });
  const res = await call({ body: { action: 'start_card_setup', token: TOKEN } });
  assert.equal(res.body.already_captured, true);
  assert.ok(!stripe.pathsCalled().includes('checkout.sessions.create'));
});

await test('the Stripe customer is keyed on the ACCOUNT, so a retry cannot make a second one', async () => {
  const db = baseDb({ rpcs: setupRpcs() });
  const stripe = setupStripe();
  const call = await onboarding({ db, stripe });
  await call({ body: { action: 'start_card_setup', token: TOKEN } });

  const create = stripe.calls.find((c) => c.path === 'customers.create');
  assert.equal(create.args[1].idempotencyKey, `silo-customer-account-${ACCOUNT}`);
  assert.equal(create.args[1].stripeAccount, 'acct_tenant',
    'the customer belongs in the TENANT\'s connected account, not the platform');
});

await test('a session whose id cannot be recorded is never handed out', async () => {
  const db = baseDb({
    rpcs: setupRpcs({ note_customer_card_setup_session: () => false }),
  });
  const stripe = setupStripe();
  const call = await onboarding({ db, stripe });
  const res = await call({ body: { action: 'start_card_setup', token: TOKEN } });

  assert.equal(res.status, 503);
  assert.ok(!res.body.url,
    'a session SILO cannot match to its completion must not reach the applicant');
});

await test('the customer is bound BEFORE the session exists', async () => {
  const order = [];
  const db = baseDb({
    rpcs: setupRpcs({
      bind_customer_account_stripe_customer: () => { order.push('bind'); return { ok: true }; },
    }),
  });
  const stripe = fakeStripe({
    'customers.create': { id: 'cus_new', object: 'customer' },
    'checkout.sessions.create': () => { order.push('session'); return { id: 'cs_new', url: 'u' }; },
  });
  const call = await onboarding({ db, stripe });
  await call({ body: { action: 'start_card_setup', token: TOKEN } });
  assert.deepEqual(order, ['bind', 'session'],
    'a session against a customer SILO has no record of would be rejected by its own webhook');
});

// ════════════════════════════════════════════════════════════════════════════
// The certificate upload
// ════════════════════════════════════════════════════════════════════════════

await test('the certificate path is derived from the account, never from a filename', async () => {
  const db = baseDb({});
  const call = await onboarding({ db, stripe: fakeStripe() });
  const res = await call({
    body: {
      action: 'certificate_url',
      token: TOKEN,
      content_type: 'application/pdf',
      filename: '../../../other-account/steal.pdf',
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.path, `${ACCOUNT}/resale-certificate.pdf`);
  assert.ok(res.body.path.startsWith(`${ACCOUNT}/`),
    'the first path segment is what the storage policy reads');
});

await test('the tax profile row is written BEFORE the object can be uploaded', async () => {
  const db = baseDb({});
  const call = await onboarding({ db, stripe: fakeStripe() });
  await call({ body: { action: 'certificate_url', token: TOKEN, content_type: 'image/png' } });

  const tp = db.calls.findIndex((c) => c.query === 'customer_account_tax_profiles');
  const signed = db.calls.findIndex((c) => c.op === 'createSignedUploadUrl');
  assert.ok(tp >= 0 && signed >= 0 && tp < signed,
    'the storage policy EXISTS reads the tax profile -- an object uploaded without it is unreadable by everyone');
});

await test('an executable or unknown upload type is refused', async () => {
  const db = baseDb({});
  const call = await onboarding({ db, stripe: fakeStripe() });
  for (const type of ['application/x-msdownload', 'text/html', '', 'application/pdf; charset=x']) {
    const res = await call({ body: { action: 'certificate_url', token: TOKEN, content_type: type } });
    assert.equal(res.status, 415, `${type} must be refused`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// The webhook's setup-capture path
// ════════════════════════════════════════════════════════════════════════════

await test('checkout.session.completed means different things on the two endpoints', () => {
  assert.equal(PLATFORM_EVENTS['checkout.session.completed'], 'checkout');
  assert.equal(CONNECT_EVENTS['checkout.session.completed'], 'connect_setup');
  // And the endpoint is still decided before the table is consulted.
  const platform = routeEvent('platform', {
    id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } },
  });
  assert.equal(platform.kind, 'checkout');
  const connect = routeEvent('connect', {
    id: 'evt_2', type: 'checkout.session.completed', account: 'acct_tenant',
    data: { object: { id: 'cs_2', customer: 'cus_1' } },
  });
  assert.equal(connect.kind, 'connect_setup');
  assert.equal(connect.accountId, 'acct_tenant');
});

async function webhook({ stripe, rpcs = {} }) {
  const db = fakeSupabase({
    rpcs: {
      stripe_resolve_event_company: () => COMPANY,
      stripe_record_webhook_event: () => 'claimed',
      stripe_finish_webhook_event: () => null,
      record_customer_card_setup: () => ({ ok: true, customer_account_id: ACCOUNT }),
      release_customer_card_setup: () => 1,
      ...rpcs,
    },
  });
  const call = await loadHandler('stripe-webhook', {
    db, stripe, modules: { ...routing }, mutate: WEBHOOK_MUTATIONS[mutation],
    config: { STRIPE_WEBHOOK_SECRET: 'whsec_platform', STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect' },
  });
  return { call, db };
}

function setupEvent(over = {}) {
  return {
    id: 'evt_setup_1',
    type: 'checkout.session.completed',
    account: 'acct_tenant',
    created: 1758000000,
    data: { object: { id: 'cs_new', customer: 'cus_new', mode: 'setup', ...over } },
  };
}

function webhookStripe(script = {}) {
  return fakeStripe({
    // The endpoint is decided by WHICH SECRET VERIFIES, so the double must
    // refuse the platform secret -- otherwise every delivery here would verify
    // as a platform event and be refused for carrying an account id.
    'webhooks.constructEventAsync': (args) => {
      if (args[2] !== 'whsec_connect') throw new Error('signature mismatch');
      return JSON.parse(args[0]);
    },
    'checkout.sessions.retrieve': { id: 'cs_new', mode: 'setup', setup_intent: 'seti_1' },
    'setupIntents.retrieve': { id: 'seti_1', customer: 'cus_new', payment_method: 'pm_1' },
    'customers.update': { id: 'cus_new' },
    'paymentMethods.retrieve': {
      id: 'pm_1', card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030 },
    },
    ...script,
  });
}

await test('a saved card is explicitly made the customer\'s invoice default', async () => {
  const stripe = webhookStripe();
  const { call } = await webhook({ stripe });
  const res = await call({
    body: setupEvent(), headers: { 'stripe-signature': 'sig' }, jwt: null,
  });
  assert.equal(res.status, 200);

  const update = stripe.calls.find((c) => c.path === 'customers.update');
  assert.ok(update, 'Checkout ATTACHES the method; making it the invoice default is a separate call');
  assert.equal(update.args[0], 'cus_new');
  assert.equal(JSON.stringify(update.args[1]),
    JSON.stringify({ invoice_settings: { default_payment_method: 'pm_1' } }));
  assert.equal(update.args[2].stripeAccount, 'acct_tenant');
});

await test('a failed default-payment-method update still records the card, marked not-default', async () => {
  let recorded = null;
  const stripe = webhookStripe({
    'customers.update': Object.assign(new Error('card_declined_on_update'), { statusCode: 402 }),
  });
  const { call } = await webhook({
    stripe,
    rpcs: { record_customer_card_setup: (args) => { recorded = args; return { ok: true }; } },
  });
  const res = await call({
    body: setupEvent(), headers: { 'stripe-signature': 'sig' }, jwt: null,
  });

  assert.equal(res.status, 200, 'the card IS saved -- asking Stripe to redeliver eight times fixes nothing');
  assert.equal(recorded.p_payment_method_id, 'pm_1');
  assert.equal(recorded.p_is_default, false,
    '"saved but not yet default" must stay a visible state, not a silent half-configuration');
});

await test('a non-setup Checkout on a connected account is left alone', async () => {
  let recorded = false;
  // SUBSCRIPTION mode, not payment -- and deliberately so. A subscription
  // Checkout DOES carry a SetupIntent, so this is the shape that actually
  // distinguishes the mode guard from the "no setup intent, nothing to do"
  // early return. A payment-mode session has no SetupIntent and would bail for
  // the wrong reason, which is how the first version of this test passed
  // against the bug it claims to catch.
  const stripe = webhookStripe({
    'checkout.sessions.retrieve': { id: 'cs_sub', mode: 'subscription', setup_intent: 'seti_sub' },
    'setupIntents.retrieve': { id: 'seti_sub', customer: 'cus_theirs', payment_method: 'pm_theirs' },
  });
  const { call } = await webhook({
    stripe,
    rpcs: { record_customer_card_setup: () => { recorded = true; return { ok: true }; } },
  });
  await call({
    body: setupEvent({ id: 'cs_sub', mode: 'subscription' }),
    headers: { 'stripe-signature': 'sig' }, jwt: null,
  });
  assert.equal(recorded, false,
    'a tenant\'s own subscription Checkout must not attach a card to a customer_accounts row');
  assert.ok(!stripe.pathsCalled().includes('customers.update'),
    'and must not rewrite that customer\'s invoice default');
});

await test('a mismatched customer is recorded as refused, and not retried forever', async () => {
  const stripe = webhookStripe();
  const { call, db } = await webhook({
    stripe,
    rpcs: { record_customer_card_setup: () => ({ ok: false, reason: 'customer_mismatch' }) },
  });
  const res = await call({
    body: setupEvent(), headers: { 'stripe-signature': 'sig' }, jwt: null,
  });
  // A mismatch is just as mismatched on the eighth delivery.
  assert.equal(res.status, 200);
  const finish = db.calls.filter((c) => c.rpc === 'stripe_finish_webhook_event').pop();
  assert.equal(finish.args.p_status, 'processed');
});

await test('a repeated completion of the same session is harmless', async () => {
  const stripe = webhookStripe();
  const calls = [];
  const { call } = await webhook({
    stripe,
    rpcs: { record_customer_card_setup: (args) => { calls.push(args); return { ok: true }; } },
  });
  const delivery = { body: setupEvent(), headers: { 'stripe-signature': 'sig' }, jwt: null };
  await call(delivery);
  await call(delivery);
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(calls[0]), JSON.stringify(calls[1]),
    'the second delivery must write exactly what the first did -- the RPC is the idempotency');
});

await test('an abandoned card step releases the claim so a fresh session can start', async () => {
  let released = null;
  const stripe = webhookStripe({
    'checkout.sessions.retrieve': { id: 'cs_new', mode: 'setup', setup_intent: null },
  });
  const { call } = await webhook({
    stripe,
    rpcs: { release_customer_card_setup: (args) => { released = args; return 1; } },
  });
  const res = await call({
    body: { ...setupEvent(), id: 'evt_exp', type: 'checkout.session.expired' },
    headers: { 'stripe-signature': 'sig' }, jwt: null,
  });
  assert.equal(res.status, 200);
  assert.equal(released.p_session, 'cs_new');
  assert.equal(released.p_company, COMPANY);
});

// ════════════════════════════════════════════════════════════════════════════
// Pure rules
// ════════════════════════════════════════════════════════════════════════════

await test('an unknown session status is never read as "gone"', () => {
  assert.equal(rules.decideSetupSession('open').action, 'replay');
  assert.equal(rules.decideSetupSession('expired').action, 'restart');
  assert.equal(rules.decideSetupSession('missing').action, 'restart');
  assert.equal(rules.decideSetupSession('complete').action, 'refuse');
  for (const unknown of [null, undefined, '', 'something_new_stripe_added']) {
    assert.equal(rules.decideSetupSession(unknown).action, 'refuse',
      `${unknown} must refuse -- a blip reading as expired opens a second payable session`);
  }
});

await test('an address cannot point at itself, a missing row, or up the wrong chain', () => {
  const cases = [
    [{ address_type: 'business', same_as_address_type: 'shipping' },
      /business address cannot be "same as"/],
    [{ address_type: 'shipping', same_as_address_type: 'billing' },
      /shipping address can only be the same as the business/],
    [{ address_type: 'billing', same_as_address_type: 'billing' },
      /same as itself/],
  ];
  for (const [addr, pattern] of cases) {
    const { ok, errors } = rules.validateSubmission({
      legal_name: 'X',
      addresses: [
        { address_type: 'business', street1: '1 Main', city: 'PDX', country: 'US' },
        addr,
      ].filter((a, i) => !(i === 0 && addr.address_type === 'business')),
      contacts: [{ contact_type: 'primary', first_name: 'A', last_name: 'B', email: 'a@b.test' }],
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => pattern.test(e)), `expected ${pattern} in ${errors.join('; ')}`);
  }

  const dangling = rules.validateSubmission({
    legal_name: 'X',
    addresses: [
      { address_type: 'business', street1: '1 Main', city: 'PDX', country: 'US' },
      { address_type: 'billing', same_as_address_type: 'shipping' },
    ],
    contacts: [{ contact_type: 'primary', first_name: 'A', last_name: 'B', email: 'a@b.test' }],
  });
  assert.equal(dangling.ok, false);
  assert.ok(dangling.errors.some((e) => /refers to a shipping address that was not supplied/.test(e)));
});

await test('a "same as" address stores no street, so it cannot drift from the one it names', () => {
  const { ok, payload } = rules.validateSubmission(validForm());
  assert.equal(ok, true);
  const billing = payload.addresses.find((a) => a.address_type === 'billing');
  assert.equal(billing.same_as_address_type, 'business');
  assert.ok(!('street1' in billing) || billing.street1 == null);
});

await test('a business address is required and a second one is refused', () => {
  const none = rules.validateSubmission({
    legal_name: 'X', addresses: [],
    contacts: [{ contact_type: 'primary', first_name: 'A', last_name: 'B', email: 'a@b.test' }],
  });
  assert.ok(none.errors.some((e) => /business address is required/i.test(e)));

  const twice = rules.validateSubmission({
    legal_name: 'X',
    addresses: [
      { address_type: 'business', street1: '1 Main', city: 'PDX', country: 'US' },
      { address_type: 'business', street1: '2 Main', city: 'PDX', country: 'US' },
    ],
    contacts: [{ contact_type: 'primary', first_name: 'A', last_name: 'B', email: 'a@b.test' }],
  });
  assert.ok(twice.errors.some((e) => /More than one business address/.test(e)));
});

await test('consent recorded against an older version does not carry forward', () => {
  assert.equal(rules.consentIsCurrent({
    off_session_consent_at: '2026-09-19T10:00:00Z',
    off_session_consent_version: rules.CONSENT_VERSION,
  }), true);
  assert.equal(rules.consentIsCurrent({
    off_session_consent_at: '2026-09-19T10:00:00Z',
    off_session_consent_version: '2020-01-01.v0',
  }), false, 'different words were authorised');
  assert.equal(rules.consentIsCurrent({ off_session_consent_at: null }), false);
  assert.equal(rules.consentIsCurrent(null), false);
});

console.log(`\n${passed} customer onboarding scenarios passed`);
