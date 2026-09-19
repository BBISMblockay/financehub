// What a Stripe delivery means, and which of SILO's two Stripe surfaces it
// belongs to. Pure: no network, no database, no Deno -- so it is unit-tested
// from node (scripts/tests/stripe-edge-logic.test.mjs) rather than only
// exercised in production.
//
// The routing decision that matters is the FIRST one: which endpoint signed
// this delivery. SILO runs two Stripe webhook endpoints with two different
// signing secrets --
//
//   platform -- SILO's own account. `invoice.paid` here is a tenant paying
//               SILO.
//   connect  -- events forwarded from a CONNECTED account. The identical
//               `invoice.paid` type here is a tenant's customer paying THEM.
//
// The two carry the same event types and differ only by the signing secret and
// by the presence of `event.account`. Getting that backwards would file a
// client's own sales as SILO subscription revenue, so the endpoint is decided
// by WHICH SECRET VERIFIED THE SIGNATURE -- never by inspecting the payload --
// and the shape is then checked against it: a connect event with no account,
// or a platform event carrying one, is refused rather than guessed at.

export const PLATFORM_EVENTS = {
  'checkout.session.completed': 'checkout',
  'customer.subscription.created': 'subscription',
  'customer.subscription.updated': 'subscription',
  'customer.subscription.deleted': 'subscription',
  'customer.subscription.paused': 'subscription',
  'customer.subscription.resumed': 'subscription',
  'invoice.finalized': 'billing_invoice',
  'invoice.paid': 'billing_invoice',
  'invoice.payment_failed': 'billing_invoice',
  'invoice.voided': 'billing_invoice',
};

export const CONNECT_EVENTS = {
  'account.updated': 'connect_account',
  'account.application.deauthorized': 'connect_deauthorized',
  'customer.created': 'connect_customer',
  'customer.updated': 'connect_customer',
  'customer.deleted': 'connect_customer',
  'invoice.created': 'connect_invoice',
  'invoice.updated': 'connect_invoice',
  'invoice.finalized': 'connect_invoice',
  'invoice.sent': 'connect_invoice',
  'invoice.paid': 'connect_invoice',
  'invoice.payment_failed': 'connect_invoice',
  'invoice.voided': 'connect_invoice',
  'invoice.marked_uncollectible': 'connect_invoice',
};

/**
 * Decide what to do with a verified event.
 *
 * Returns one of:
 *   { action: 'handle',  kind, objectId, customerId, accountId }
 *   { action: 'ignore',  reason }   -- a type SILO does not use. Recorded, 200.
 *   { action: 'refuse',  reason }   -- the delivery contradicts its endpoint.
 *                                      Recorded as an error, 200: a retry of a
 *                                      mis-routed event is mis-routed too, so
 *                                      asking Stripe to send it again just
 *                                      turns one wrong delivery into eight.
 */
export function routeEvent(endpoint, event) {
  if (endpoint !== 'platform' && endpoint !== 'connect') {
    return { action: 'refuse', reason: `unknown endpoint ${endpoint}` };
  }
  if (!event || typeof event.type !== 'string' || !event.id) {
    return { action: 'refuse', reason: 'event has no id or type' };
  }

  const account = event.account || null;
  if (endpoint === 'connect' && !account) {
    return { action: 'refuse', reason: 'connect endpoint delivered an event with no account id' };
  }
  if (endpoint === 'platform' && account) {
    return {
      action: 'refuse',
      reason: `platform endpoint delivered an event for connected account ${account}`,
    };
  }

  const table = endpoint === 'platform' ? PLATFORM_EVENTS : CONNECT_EVENTS;
  const kind = table[event.type];
  if (!kind) return { action: 'ignore', reason: `unhandled type ${event.type}` };

  const object = event.data?.object ?? {};
  return {
    action: 'handle',
    kind,
    accountId: account,
    objectId: object.id ?? null,
    // Stripe sends `customer` as an id, or as an expanded object when the
    // request that produced the event asked for expansion. Both shapes reach
    // production; reading only the first silently loses attribution.
    customerId: customerIdOf(object),
  };
}

export function customerIdOf(object) {
  const c = object?.customer;
  if (!c) return null;
  if (typeof c === 'string') return c;
  return c.id ?? null;
}

/**
 * Is this failure worth a Stripe retry?
 *
 * Stripe re-delivers on any non-2xx for up to three days. That is exactly what
 * should happen when SILO's database was briefly unreachable, and exactly what
 * should NOT happen when the event names an account no company here owns --
 * that will still be true on the eighth attempt, and the retries only bury the
 * one delivery somebody needs to find in the log.
 */
export function shouldAskStripeToRetry(outcome) {
  return outcome === 'transient';
}

/**
 * The status recorded on stripe_webhook_events for each outcome. Kept beside
 * the routing so "what happened to this delivery" has one vocabulary, and so a
 * new outcome cannot be added without choosing its recorded name.
 */
export function statusFor(outcome) {
  switch (outcome) {
    case 'handled':    return 'processed';
    case 'ignored':    return 'ignored';
    case 'unresolved': return 'unresolved';
    case 'refused':    return 'error';
    case 'transient':  return 'error';
    default:           return 'error';
  }
}
