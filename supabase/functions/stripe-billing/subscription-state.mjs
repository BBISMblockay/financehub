// What a stored subscription status means for what the page may offer.
//
// One definition, in one place, because the same question is asked twice and a
// disagreement between the two answers bills somebody twice: the PAGE asks it
// to decide whether to show "Subscribe" or "Change plan", and the FUNCTION
// asks it to decide whether to open a Checkout Session at all.
//
// The failure this exists to prevent: Stripe Checkout in `mode: 'subscription'`
// creates a NEW subscription every time it completes. It does not switch a
// plan. A page that offers "Switch to this plan" and calls Checkout therefore
// leaves the old subscription running and starts a second one, and the tenant
// is charged for both -- while `billing_subscriptions` holds ONE row per
// company and would show only whichever synced last, so nothing in SILO would
// look wrong.
//
// Pure: no network, no Deno. Unit-tested from node.

/**
 * Statuses where money is still expected to move. `past_due` and `unpaid` are
 * deliberately in this set: the subscription still EXISTS at Stripe and can
 * recover when the card is fixed, so opening a second one is exactly as wrong
 * as it is for an active subscriber.
 *
 * `incomplete` and `incomplete_expired` are not: Stripe's initial payment
 * never succeeded, and the subscription will never activate. `canceled` is
 * over. Both should be able to subscribe again.
 */
export const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);

export function isLive(subscription) {
  return !!subscription && LIVE_STATUSES.has(subscription.status);
}

/**
 * May this company open a new subscription Checkout Session?
 *
 * Returns `{ allowed: true }` or `{ allowed: false, reason }` — a sentence
 * meant to be read by the person who clicked, not a code.
 */
export function checkoutDecision(subscription) {
  if (!isLive(subscription)) return { allowed: true };
  return {
    allowed: false,
    reason:
      'This company already has a live SILO subscription'
      + (subscription.plan_key ? ` (${subscription.plan_key})` : '')
      + '. Stripe Checkout always creates a NEW subscription, so this would leave the '
      + 'current one running and bill for both. Change the plan in the Stripe billing '
      + 'portal instead — use Manage billing.',
  };
}

/**
 * What the plan buttons should do. The page renders from this rather than from
 * its own reading of the status, so the button can never offer what the
 * function will refuse.
 */
export function planAction(subscription, planKey) {
  if (isLive(subscription)) {
    return subscription.plan_key === planKey
      ? { kind: 'current' }
      : { kind: 'portal', label: 'Change plan in Stripe' };
  }
  return { kind: 'checkout', label: 'Subscribe' };
}
