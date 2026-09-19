// The two pure modules behind the Stripe edge functions, executed as node.
//
// They are separate files precisely so they can be run here: the alternative
// is finding out in production that an amount was scaled wrong or that a
// connected-account event was filed as SILO revenue. What each protects:
//
//   event-routing.mjs -- the two Stripe surfaces deliver the SAME event types
//     (`invoice.paid` is a tenant paying SILO on one and a tenant's customer
//     paying THEM on the other) and are told apart only by which signing
//     secret verified the delivery. The rules asserted here are that the
//     endpoint decides, that a delivery contradicting its endpoint is REFUSED
//     rather than guessed at, and that a refusal is not re-requested from
//     Stripe (a mis-routed event is mis-routed on the eighth attempt too).
//
//   invoice-lines.mjs -- the conversion from what somebody typed to the
//     integer minor units Stripe charges. One definition, server-side, and it
//     refuses what it cannot represent exactly instead of rounding a price
//     nobody agreed to.
//
//   subscription-state.mjs -- whether a company may open a new subscription
//     Checkout. Stripe Checkout in subscription mode CREATES a subscription;
//     it never switches one. The page offered "Switch to this plan" and called
//     it, which would have left the old plan running and billed for both.
//
//   v2/invoice-request.js -- the idempotency key held across a RELOAD. The
//     page minted a fresh uuid every time the dialog opened, so the retry the
//     ledger exists for (lost response, reload, fill it in again) carried a
//     new key and made a second real invoice.
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e && e.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import {
  routeEvent, shouldAskStripeToRetry, statusFor, customerIdOf,
} from '../../supabase/functions/stripe-webhook/event-routing.mjs';
import {
  toMinorUnits, normalizeInvoiceLines, fingerprintInvoice, InvoiceInputError,
} from '../../supabase/functions/stripe-invoice/invoice-lines.mjs';
import {
  LIVE_STATUSES, isLive, checkoutDecision, planAction,
} from '../../supabase/functions/stripe-billing/subscription-state.mjs';
import { readFileSync } from 'node:fs';

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

const evt = (over = {}) => ({
  id: 'evt_1', type: 'invoice.paid', created: 1758278400,
  data: { object: { id: 'in_1', customer: 'cus_1' } },
  ...over,
});

// ── Routing ─────────────────────────────────────────────────────────────────

test('the same event type means different things on the two endpoints', () => {
  const platform = routeEvent('platform', evt());
  const connect = routeEvent('connect', evt({ account: 'acct_1' }));
  assert.equal(platform.kind, 'billing_invoice', 'on the platform it is SILO being paid');
  assert.equal(connect.kind, 'connect_invoice', "on connect it is a tenant's customer paying them");
});

test('a connect event with no account id is refused, not guessed', () => {
  const r = routeEvent('connect', evt());
  assert.equal(r.action, 'refuse');
  assert.match(r.reason, /no account id/);
});

test('a platform event carrying an account is refused', () => {
  // This is what a crossed pair of endpoint secrets looks like, and attributing
  // it by customer would file a tenant's own sales as SILO revenue.
  const r = routeEvent('platform', evt({ account: 'acct_1' }));
  assert.equal(r.action, 'refuse');
  assert.match(r.reason, /connected account acct_1/);
});

test('an unhandled type is ignored, and ignored is not refused', () => {
  const r = routeEvent('platform', evt({ type: 'radar.early_fraud_warning.created' }));
  assert.equal(r.action, 'ignore');
  assert.equal(statusFor('ignored'), 'ignored');
  assert.equal(statusFor('refused'), 'error',
    'a delivery SILO does not use and one it could not make sense of are different facts');
});

test('a subscription event routes to the subscription handler on the platform only', () => {
  assert.equal(routeEvent('platform', evt({ type: 'customer.subscription.updated' })).kind, 'subscription');
  assert.equal(routeEvent('connect', evt({ type: 'customer.subscription.updated', account: 'acct_1' })).action,
    'ignore', 'a connected account\'s own subscriptions are its business, not SILO\'s');
});

test('account.updated is a connect event and carries its account id through', () => {
  const r = routeEvent('connect', evt({
    type: 'account.updated', account: 'acct_9',
    data: { object: { id: 'acct_9', charges_enabled: true } },
  }));
  assert.equal(r.kind, 'connect_account');
  assert.equal(r.accountId, 'acct_9');
});

test('an expanded customer object is read as well as a bare id', () => {
  assert.equal(customerIdOf({ customer: 'cus_a' }), 'cus_a');
  assert.equal(customerIdOf({ customer: { id: 'cus_b', object: 'customer' } }), 'cus_b',
    'Stripe expands `customer` when the request that produced the event asked it to');
  assert.equal(customerIdOf({}), null);
});

test('only a transient failure asks Stripe to deliver again', () => {
  assert.equal(shouldAskStripeToRetry('transient'), true,
    'a database blip should be retried -- every handler is an idempotent upsert');
  for (const outcome of ['refused', 'ignored', 'unresolved', 'handled']) {
    assert.equal(shouldAskStripeToRetry(outcome), false,
      `${outcome} will be just as true on the eighth attempt`);
  }
});

test('an unresolved delivery is recorded, never silently dropped', () => {
  assert.equal(statusFor('unresolved'), 'unresolved',
    'ignoring a payment notification is indistinguishable from never receiving one');
});

test('a malformed event is refused before anything is read out of it', () => {
  assert.equal(routeEvent('platform', null).action, 'refuse');
  assert.equal(routeEvent('platform', { type: 'invoice.paid' }).action, 'refuse');
  assert.equal(routeEvent('nonsense', evt()).action, 'refuse');
});

// ── Amounts ─────────────────────────────────────────────────────────────────

test('major units become integer minor units', () => {
  assert.equal(toMinorUnits('1250', 'usd'), 125000);
  assert.equal(toMinorUnits('1,250.00', 'usd'), 125000);
  assert.equal(toMinorUnits('0.07', 'usd'), 7);
  assert.equal(toMinorUnits('10.10', 'usd'), 1010);
});

test('the classic float error does not happen here', () => {
  // 1.15 * 100 is 114.99999999999999 in IEEE 754. Math.round hides that at
  // this scale and stops hiding it at others, which is why the conversion
  // reads the decimal STRING rather than multiplying a float.
  assert.equal(toMinorUnits('1.15', 'usd'), 115);
  assert.equal(toMinorUnits('4.35', 'usd'), 435);
  assert.equal(toMinorUnits('1000000.07', 'usd'), 100000007);
});

test('a zero-decimal currency is not divided by a hundred', () => {
  assert.equal(toMinorUnits('500', 'jpy'), 500, 'JPY 500 is five hundred yen, not five');
  assert.throws(() => toMinorUnits('5.50', 'jpy'), InvoiceInputError);
});

test('three-decimal currencies are refused by name rather than mis-scaled', () => {
  assert.throws(() => toMinorUnits('10.500', 'kwd'), /three-decimal currency/);
});

test('more decimals than the currency has is a refusal, not a rounding', () => {
  assert.throws(() => toMinorUnits('10.005', 'usd'), /more than 2 decimal places/);
  // Trailing zeros are not extra precision.
  assert.equal(toMinorUnits('10.5000', 'usd'), 1050);
});

test('a line set is validated as a whole before Stripe is touched', () => {
  const { lines, total } = normalizeInvoiceLines(
    [{ description: 'Tees', quantity: 10, unit_amount: '19.99' },
     { description: 'Freight', unit_amount: '250' }], 'usd');
  assert.equal(lines[0].amount, 19990);
  assert.equal(lines[1].quantity, 1, 'quantity defaults to one');
  assert.equal(total, 19990 + 25000);
});

test('an empty, zero or negative-total invoice is refused', () => {
  assert.throws(() => normalizeInvoiceLines([], 'usd'), /at least one line/);
  assert.throws(() => normalizeInvoiceLines(
    [{ description: 'x', unit_amount: '0' }], 'usd'), /no effect/);
  assert.throws(() => normalizeInvoiceLines(
    [{ description: 'Order', unit_amount: '100' },
     { description: 'Credit', unit_amount: '-150' }], 'usd'), /totals zero or less/);
});

test('a negative line is allowed inside a positive invoice (a discount)', () => {
  const { total } = normalizeInvoiceLines(
    [{ description: 'Order', unit_amount: '500' },
     { description: 'Loyalty credit', unit_amount: '-50' }], 'usd');
  assert.equal(total, 45000);
});

test('a missing description is refused, naming the line', () => {
  assert.throws(() => normalizeInvoiceLines(
    [{ description: 'ok', unit_amount: '10' }, { unit_amount: '10' }], 'usd'),
    /Line 2: a description is required/);
});

test('a fractional quantity is refused rather than truncated', () => {
  assert.throws(() => normalizeInvoiceLines(
    [{ description: 'Hours', quantity: 1.5, unit_amount: '100' }], 'usd'),
    /whole number/);
});

test('the fingerprint distinguishes a lost response from an edited form', () => {
  const base = { customer: 'cus_1', currency: 'usd', dueDays: 30,
    lines: [{ description: 'Tees', quantity: 1, unit_amount: 1999 }] };
  assert.equal(fingerprintInvoice(base), fingerprintInvoice({ ...base }));
  assert.notEqual(fingerprintInvoice(base),
    fingerprintInvoice({ ...base, lines: [{ description: 'Tees', quantity: 2, unit_amount: 1999 }] }));
});

// ── Who may open a Checkout ─────────────────────────────────────────────────

test('a live subscriber cannot open a second subscription Checkout', () => {
  for (const status of ['active', 'trialing', 'past_due', 'unpaid']) {
    const decision = checkoutDecision({ status, plan_key: 'growth' });
    assert.equal(decision.allowed, false, `${status} must not open a second subscription`);
    assert.match(decision.reason, /billing portal/i, 'the refusal names where to go instead');
  }
});

test('past_due and unpaid are live -- the subscription still exists at Stripe', () => {
  // The tempting reading is "they are not paying, so let them start again".
  // They CAN recover when the card is fixed, and a second subscription then
  // bills twice for good.
  assert.equal(isLive({ status: 'past_due' }), true);
  assert.equal(isLive({ status: 'unpaid' }), true);
});

test('an incomplete, expired or cancelled subscription may subscribe again', () => {
  for (const status of ['incomplete', 'incomplete_expired', 'canceled']) {
    assert.equal(checkoutDecision({ status }).allowed, true,
      `${status} never became a live subscription, or is over`);
  }
  assert.equal(checkoutDecision(null).allowed, true, 'and so may a company with no row at all');
});

test('the plan buttons can never offer what the function will refuse', () => {
  const live = { status: 'active', plan_key: 'growth' };
  assert.equal(planAction(live, 'growth').kind, 'current');
  assert.equal(planAction(live, 'scale').kind, 'portal', 'a plan CHANGE goes to the portal');
  assert.equal(planAction({ status: 'canceled' }, 'scale').kind, 'checkout');
  assert.equal(planAction(null, 'scale').kind, 'checkout');
});

test('the billing PAGE agrees with the function on every status', () => {
  // The page cannot import the module (it is a plain script tag), so it
  // carries a copy. A copy that drifts is how "Switch to this plan" came to
  // call an endpoint that would refuse it -- so the copy is pinned here.
  const page = readFileSync(new URL('../../v2/billing.html', import.meta.url), 'utf8');
  const listed = page.match(/const LIVE_STATUSES = \[([^\]]*)\]/);
  assert.ok(listed, 'the page must carry the status list');
  const pageStatuses = listed[1].split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean);
  assert.deepEqual(pageStatuses.sort(), [...LIVE_STATUSES].sort(),
    'the page and the edge function must admit exactly the same statuses');
});

// ── The key that survives a reload ──────────────────────────────────────────

function loadRequestModule() {
  // The module is a browser script, so it is loaded the way the page loads it.
  const store = new Map();
  const sandbox = {
    sessionStorage: {
      setItem: (k, v) => store.set(k, String(v)),
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      removeItem: (k) => store.delete(k),
    },
    crypto: { randomUUID: () => `uuid-${store.size}-${Math.random().toString(16).slice(2)}` },
  };
  const src = readFileSync(new URL('../../v2/invoice-request.js', import.meta.url), 'utf8');
  const load = new Function('window', `${src}; return window.SiloInvoiceRequest;`);
  return { api: load(sandbox), store, sandbox };
}

test('the same form resumes the same key -- a reload does not mint a new one', () => {
  const { api } = loadRequestModule();
  const sig = api.formSignature({
    customer: 'cus_1', currency: 'usd', dueDays: 30,
    lines: [{ description: 'Tees', quantity: 10, unit_amount: '19.99' }],
  });
  const first = api.begin('k', sig);
  assert.equal(first.resumed, false);
  assert.equal(first.durable, true, 'it must actually be written down, or a reload loses it');

  const second = api.begin('k', sig);
  assert.equal(second.request_id, first.request_id,
    'the retry after a lost response must carry the ORIGINAL key');
  assert.equal(second.resumed, true);
});

test('an edited form takes a new key -- a different invoice is a different request', () => {
  const { api } = loadRequestModule();
  const a = api.begin('k', 'sig-a');
  const b = api.begin('k', 'sig-b');
  assert.notEqual(b.request_id, a.request_id);
});

test('the signature changes with anything that changes the invoice', () => {
  const base = { customer: 'cus_1', currency: 'usd', dueDays: 30, memo: '',
    lines: [{ description: 'Tees', quantity: 1, unit_amount: '10.00' }] };
  const sig = (o) => loadRequestModule().api.formSignature(o);
  assert.equal(sig(base), sig({ ...base }));
  for (const [field, value] of [['customer', 'cus_2'], ['currency', 'eur'], ['dueDays', 14], ['memo', 'x']]) {
    assert.notEqual(sig(base), sig({ ...base, [field]: value }), `${field} must change the signature`);
  }
  assert.notEqual(sig(base), sig({ ...base,
    lines: [{ description: 'Tees', quantity: 2, unit_amount: '10.00' }] }), 'quantity');
  assert.notEqual(sig(base), sig({ ...base,
    lines: [{ description: 'Tees', quantity: 1, unit_amount: '10.01' }] }), 'price');
});

test('what to do about an outstanding key, by what the server says', () => {
  const { api } = loadRequestModule();
  const marker = { request_id: 'r1', signature: 'sig-a' };

  assert.deepEqual(api.decide(marker, 'sig-a', 'succeeded', 'in_9'),
    { action: 'completed', request_id: 'r1', object_id: 'in_9' },
    'the first attempt DID reach Stripe -- show it, never resend');
  assert.deepEqual(api.decide(marker, 'sig-a', 'pending'), { action: 'reuse', request_id: 'r1' });
  assert.deepEqual(api.decide(marker, 'sig-a', 'failed'), { action: 'fresh' });
  assert.deepEqual(api.decide(marker, 'sig-a', 'unknown'), { action: 'fresh' },
    'no row means the create never reached the database, so nothing was made');
  assert.deepEqual(api.decide(marker, 'sig-DIFFERENT', 'pending'), { action: 'blocked', request_id: 'r1' },
    'an in-flight attempt for a DIFFERENT invoice must block, not mint a second key');
  assert.deepEqual(api.decide(null, 'sig-a', 'unknown'), { action: 'fresh' });
});

test('blocked storage degrades instead of refusing to work', () => {
  const src = readFileSync(new URL('../../v2/invoice-request.js', import.meta.url), 'utf8');
  const hostile = {
    get sessionStorage() { throw new Error('The operation is insecure.'); },
    crypto: { randomUUID: () => 'uuid-x' },
  };
  const api = new Function('window', `${src}; return window.SiloInvoiceRequest;`)(hostile);
  assert.equal(api.storageAvailable(), false);
  const claim = api.begin('k', 'sig');
  assert.equal(claim.request_id, 'uuid-x', 'an invoice can still be created');
  assert.equal(claim.durable, false, 'and the page is told the key will not survive a reload');
  assert.equal(api.pending('k'), null);
});

// ── The mutations CI actually runs ──────────────────────────────────────────

test('every declared mutation is executed by the workflow', () => {
  // A mutation that CI never runs is coverage that does not exist. Four of
  // these went three commits without being executed, while the PR body said
  // twelve mutations ran -- the job was green because it was running eight.
  // Asserting the two lists match is cheaper than remembering.
  const suite = readFileSync(
    new URL('./stripe-billing-database.test.mjs', import.meta.url), 'utf8');
  const declaredBlock = suite.slice(
    suite.indexOf('assert.ok(['), suite.indexOf('].includes(mutation)'));
  const declared = new Set(
    [...declaredBlock.matchAll(/'([a-z][a-z-]+)'/g)].map((m) => m[1]));

  const workflow = readFileSync(
    new URL('../../.github/workflows/sync-tests.yml', import.meta.url), 'utf8');
  const start = workflow.indexOf('for m in mirror-writable');
  assert.ok(start > 0, 'the Stripe mutation loop must exist in sync-tests.yml');
  const loop = workflow.slice(start, workflow.indexOf('; do', start));
  const run = new Set(
    loop.replace('for m in', '').split(/[\s\\]+/).map((x) => x.trim()).filter(Boolean));

  assert.deepEqual([...declared].sort(), [...run].sort(),
    'the suite\'s STRIPE_MUTATION allowlist and the workflow loop must be the same set');
  assert.ok(declared.size >= 12, `expected at least 12 mutations, found ${declared.size}`);
});

console.log(`\n${passed} assertions passed`);
