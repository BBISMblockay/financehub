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
process.on('uncaughtException', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e && e.message || e); process.exit(1); });
import assert from 'node:assert/strict';
import {
  routeEvent, shouldAskStripeToRetry, statusFor, customerIdOf,
} from '../../supabase/functions/stripe-webhook/event-routing.mjs';
import {
  toMinorUnits, normalizeInvoiceLines, fingerprintInvoice, InvoiceInputError,
} from '../../supabase/functions/stripe-invoice/invoice-lines.mjs';

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

console.log(`\n${passed} assertions passed`);
