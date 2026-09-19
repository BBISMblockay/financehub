// stripe-webhook -- PUBLIC (verify_jwt off): the single receiver for BOTH of
// SILO's Stripe surfaces.
//
// One function rather than two, deliberately. The two endpoints deliver the
// same event TYPES (`invoice.paid` is a tenant paying SILO on one and a
// tenant's customer paying them on the other) and the whole risk is confusing
// them -- so the decision lives in exactly one place, `routeEvent()`, with one
// test file over it. Two functions would be two copies of that decision, and
// the second one to be corrected would be the one nobody remembered.
//
// The endpoint is decided by WHICH SIGNING SECRET VERIFIES THE SIGNATURE, not
// by looking at the payload. Both secrets are tried; the one that verifies
// names the surface. A forged body verifies against neither and is rejected
// with 400 before anything is read out of it.
//
// Ordering: every handler RE-FETCHES the object from Stripe and syncs what
// came back, stamping stripe_synced_at with the fetch time. Stripe does not
// order deliveries, and a retry of a three-minute-old event arrives after the
// current state -- so a handler that wrote `event.data.object` would revert a
// paid invoice to open at random. The sync functions drop an older fetch.
//
// Retries: a non-2xx asks Stripe to send it again, for up to three days. That
// is right for "the database was briefly unreachable" and wrong for everything
// else -- a mis-routed event or an unknown account is still mis-routed on the
// eighth attempt. See shouldAskStripeToRetry().
//
// Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (platform endpoint),
//          STRIPE_CONNECT_WEBHOOK_SECRET (connected-accounts endpoint).
import { createClient } from 'npm:@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17.7.0';
import { routeEvent, shouldAskStripeToRetry, statusFor } from './event-routing.mjs';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const PLATFORM_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';
const CONNECT_SECRET = Deno.env.get('STRIPE_CONNECT_WEBHOOK_SECRET') ?? '';

const db = createClient(SUPABASE_URL, SERVICE_KEY);
// No apiVersion override: the SDK pin above IS the version pin, and naming a
// literal here that the pinned SDK's types do not know fails `deno check`.
// What the pin buys is object SHAPE -- in particular `invoice.subscription`
// and the subscription's top-level `current_period_*`, both of which later
// Stripe versions move. stripe_sync_subscription() reads the item-level period
// as a fallback anyway, so a future bump degrades rather than breaks.
const stripe = new Stripe(STRIPE_KEY, {
  httpClient: Stripe.createFetchHttpClient(),
});
// Deno has no node crypto: Stripe's own SubtleCrypto provider is required for
// asynchronous signature verification.
const cryptoProvider = Stripe.createSubtleCryptoProvider();

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Verify against the platform secret, then the connect secret. Whichever
 * verifies names the endpoint -- this is the only place the two surfaces are
 * told apart.
 */
async function verify(body: string, signature: string) {
  const candidates: Array<['platform' | 'connect', string]> = [];
  if (PLATFORM_SECRET) candidates.push(['platform', PLATFORM_SECRET]);
  if (CONNECT_SECRET) candidates.push(['connect', CONNECT_SECRET]);

  for (const [endpoint, secret] of candidates) {
    try {
      const event = await stripe.webhooks.constructEventAsync(
        body, signature, secret, undefined, cryptoProvider,
      );
      return { endpoint, event };
    } catch (_) { /* try the other secret */ }
  }
  return null;
}

export async function handleStripeWebhook(req: Request): Promise<Response> {
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);
  if (!STRIPE_KEY || (!PLATFORM_SECRET && !CONNECT_SECRET)) {
    // Fail loudly rather than 200-ing: a webhook that silently accepts and
    // discards is indistinguishable from one that works.
    return reply({ error: 'Stripe secrets are not configured' }, 500);
  }

  const signature = req.headers.get('stripe-signature') ?? '';
  const body = await req.text();
  const verified = await verify(body, signature);
  if (!verified) return reply({ error: 'Signature verification failed' }, 400);

  const { endpoint, event } = verified;
  const route = routeEvent(endpoint, event);

  // Resolve the owning company BEFORE recording, so the log row names it.
  let company: string | null = null;
  if (route.action === 'handle') {
    const { data, error } = await db.rpc('stripe_resolve_event_company', {
      p_endpoint: endpoint,
      p_account: route.accountId,
      p_customer: route.customerId,
    });
    if (error) {
      // A database failure IS transient: ask Stripe to try again.
      console.error('resolve failed', error.message);
      return reply({ error: 'resolve failed' }, 500);
    }
    company = data ?? null;
  }

  // Insert-first deduplication: the primary key is what makes Stripe's own
  // retries harmless. The claim answers with WHICH of three states it found,
  // because a duplicate that is genuinely finished and one that is merely
  // leased by an attempt that never reported back need opposite answers.
  const { data: claim, error: recordErr } = await db.rpc('stripe_record_webhook_event', {
    p_event_id: event.id,
    p_endpoint: endpoint,
    p_event_type: event.type,
    p_account: route.action === 'handle' ? route.accountId : (event.account ?? null),
    p_company: company,
    p_created: event.created ? new Date(event.created * 1000).toISOString() : null,
  });
  if (recordErr) {
    console.error('record failed', recordErr.message);
    return reply({ error: 'record failed' }, 500);
  }
  if (claim === 'terminal') return reply({ received: true, duplicate: true });
  if (claim !== 'claimed') {
    // `leased`: an attempt holds this event and has not reported back. Saying
    // 200 here is what loses an event during a database outage -- the handler
    // failed, its status write failed too, the row stayed `received`, and
    // Stripe's prompt retry was told the work was done. Non-2xx keeps Stripe
    // coming back until the lease goes stale and the retry can claim it.
    return reply({ received: false, leased: true }, 409);
  }

  const finish = async (outcome: string, message?: string) => {
    const { error: finishErr } = await db.rpc('stripe_finish_webhook_event', {
      p_event_id: event.id,
      p_status: statusFor(outcome),
      p_error: message ?? null,
    });
    // If the status write itself failed, the row is still `received` and this
    // delivery's outcome was never recorded. Answering 200 would end Stripe's
    // retries on a row that nothing can reclaim for ten minutes -- so the
    // answer is 500 whatever the outcome was, and the retry finds either a
    // recorded status or a lease that has since expired.
    if (finishErr) {
      console.error('finish failed', event.id, finishErr.message);
      return reply({ error: `status write failed: ${finishErr.message}` }, 500);
    }
    return reply(
      { received: true, outcome, message: message ?? null },
      shouldAskStripeToRetry(outcome) ? 500 : 200,
    );
  };

  if (route.action === 'refuse') return await finish('refused', route.reason);
  if (route.action === 'ignore') return await finish('ignored', route.reason);
  if (!company) {
    return await finish(
      'unresolved',
      `no company owns ${route.accountId ?? route.customerId ?? 'this object'}`,
    );
  }

  try {
    await handle(route, event, company);
    return await finish('handled');
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    console.error('handler failed', event.type, message);
    // Handler failures are treated as transient: the usual cause is Stripe or
    // the database being briefly unavailable mid-fetch, and a re-delivery of
    // the same event is safe because every path is an idempotent upsert.
    // Already answering 500, so a failed status write cannot make the response
    // wrong -- but it is logged, because it is the difference between a row
    // the retry can reclaim and one it must wait out.
    const { error: finishErr } = await db.rpc('stripe_finish_webhook_event', {
      p_event_id: event.id, p_status: 'error', p_error: message,
    });
    if (finishErr) console.error('finish failed after handler failure', event.id, finishErr.message);
    return reply({ error: message }, 500);
  }
}

/**
 * Did Stripe REACH this request and refuse it, or did the attempt not land?
 *
 * Only the first is terminal. A 402/404/400 will refuse identically on the
 * eighth delivery; a 429, a 5xx, or a connection that died says nothing about
 * the request's validity and is exactly what Stripe's redelivery exists for.
 * An error carrying no status at all (a DNS failure, an aborted socket) is
 * treated as transient, because assuming otherwise is the direction that loses
 * work silently.
 */
function isTerminalStripeError(e: unknown): boolean {
  const status = (e as any)?.statusCode;
  if (typeof status !== 'number') return false;
  if (status === 429) return false;
  return status >= 400 && status < 500;
}

async function handle(route: any, event: any, company: string) {
  const account: string | null = route.accountId;
  const opts = account ? { stripeAccount: account } : undefined;
  // One fetch clock for the whole handler, taken BEFORE the fetch: if the
  // fetch is slow, stamping the later time could out-rank a newer sync that
  // started and finished while this one was in flight.
  const syncedAt = new Date().toISOString();

  switch (route.kind) {
    case 'checkout': {
      // A completed Checkout Session is only the starting gun -- the
      // subscription object is what carries status, period and price, and it
      // is what the billing page reads. Fetch it rather than mapping the
      // session, which carries none of that.
      const session = await stripe.checkout.sessions.retrieve(route.objectId);
      // This attempt is over either way -- paid or expired -- so the company's
      // in-flight claim is released. Scoped to THIS session id, so a late
      // delivery for a finished session can never drop the claim a second
      // attempt is holding right now.
      await rpc('stripe_release_checkout', { p_company: company, p_session: session.id });
      const subId = typeof session.subscription === 'string'
        ? session.subscription : session.subscription?.id;
      if (!subId) return;
      const sub = await stripe.subscriptions.retrieve(subId);
      await rpc('stripe_sync_subscription', {
        p_company: company, p_payload: sub, p_synced_at: syncedAt,
      });
      return;
    }
    case 'subscription': {
      const sub = await stripe.subscriptions.retrieve(route.objectId);
      await rpc('stripe_sync_subscription', {
        p_company: company, p_payload: sub, p_synced_at: syncedAt,
      });
      return;
    }
    case 'billing_invoice': {
      const invoice = await stripe.invoices.retrieve(route.objectId);
      await rpc('stripe_sync_billing_invoice', {
        p_company: company, p_payload: invoice, p_synced_at: syncedAt,
      });
      // A failed payment changes the SUBSCRIPTION's status too (active ->
      // past_due), and nothing else would tell the billing page that.
      if (invoice.subscription) {
        const subId = typeof invoice.subscription === 'string'
          ? invoice.subscription : invoice.subscription.id;
        const sub = await stripe.subscriptions.retrieve(subId);
        await rpc('stripe_sync_subscription', {
          p_company: company, p_payload: sub, p_synced_at: new Date().toISOString(),
        });
      }
      return;
    }
    case 'connect_account': {
      const acct = await stripe.accounts.retrieve(account!);
      await rpc('stripe_sync_connect_account', {
        p_company: company, p_payload: acct, p_synced_at: syncedAt,
      });
      return;
    }
    case 'connect_deauthorized': {
      // The client disconnected SILO from their Stripe account. The mirror is
      // deliberately KEPT -- those invoices really were issued -- and only the
      // capability flags are cleared. Note this cannot go through
      // stripe_sync_connect_account: there is no account left to re-fetch, and
      // syncing a synthetic payload would overwrite the real country, currency
      // and business name with a stub.
      const { error } = await db.rpc('stripe_mark_connect_disconnected', {
        p_company: company, p_account: account, p_synced_at: syncedAt,
      });
      if (error) throw new Error(`stripe_mark_connect_disconnected: ${error.message}`);
      return;
    }
    case 'connect_customer': {
      const customer = await stripe.customers.retrieve(route.objectId, opts);
      if ((customer as any).deleted) return;
      await rpc('stripe_sync_invoice_customer', {
        p_company: company, p_account: account, p_payload: customer, p_synced_at: syncedAt,
      });
      return;
    }
    case 'connect_setup': {
      // A completed Checkout on a CONNECTED account. Re-fetched rather than
      // read from the payload, like every other handler here.
      const session = await stripe.checkout.sessions.retrieve(route.objectId, opts);
      // A connected account can run Checkout for its own reasons -- a payment,
      // a subscription of its own. Only `setup` is SILO's, and acting on
      // anything else would attach a payment method to a customer_accounts row
      // on the strength of an event that was never about it.
      if (session.mode !== 'setup') return;

      // ── Ownership BEFORE any mutation ────────────────────────────────────
      // The tenant owns their Connect account outright and can create a
      // setup-mode Checkout from their own Stripe dashboard or another
      // integration. Those land on this same endpoint and resolve to this same
      // company, so "it is a setup session for a company we know" is NOT
      // evidence the session is ours. Establishing that first is what stops
      // SILO re-pointing the invoice default on a customer it was never asked
      // about -- and it is checked before the next Stripe read, so a foreign
      // session costs one API call, not four.
      const { data: ownerRows, error: ownerErr } = await db.rpc(
        'customer_card_setup_session_owner',
        { p_company: company, p_session_id: session.id },
      );
      if (ownerErr) throw new Error(`customer_card_setup_session_owner: ${ownerErr.message}`);
      const owner = (Array.isArray(ownerRows) ? ownerRows[0] : ownerRows) as any;
      if (!owner?.customer_account_id) {
        // Not a session this feature created. Recorded as handled: a retry
        // would reach the same conclusion eight times over.
        console.error('connect setup session is not SILO-owned', session.id);
        return;
      }

      const setupIntentId = typeof session.setup_intent === 'string'
        ? session.setup_intent
        : session.setup_intent?.id;
      if (!setupIntentId) return;

      // The SetupIntent, not the session, carries the PaymentMethod. Fetched
      // under the same connected account: a SetupIntent id from one account
      // does not resolve under another, so this is also the check that the
      // delivery and the object agree.
      const intent = await stripe.setupIntents.retrieve(setupIntentId, opts);
      const customerId = typeof intent.customer === 'string'
        ? intent.customer : intent.customer?.id ?? null;
      const paymentMethodId = typeof intent.payment_method === 'string'
        ? intent.payment_method : intent.payment_method?.id ?? null;
      if (!customerId || !paymentMethodId) return;

      // The session is ours, but the intent must also name the Stripe customer
      // this account is bound to. A mismatch means the account was re-pointed
      // mid-flight, or the session was reused; either way, writing a payment
      // method here attaches somebody's card to somebody else's account.
      if (owner.stripe_customer_id !== customerId) {
        console.error('connect setup customer mismatch', session.id,
          owner.stripe_customer_id, customerId);
        return;
      }

      // Display metadata only. Stripe's own card object, never anything typed.
      let brand: string | null = null;
      let last4: string | null = null;
      let expMonth: number | null = null;
      let expYear: number | null = null;
      try {
        const pm = await stripe.paymentMethods.retrieve(paymentMethodId, opts);
        brand = pm.card?.brand ?? null;
        last4 = pm.card?.last4 ?? null;
        expMonth = pm.card?.exp_month ?? null;
        expYear = pm.card?.exp_year ?? null;
      } catch (e) {
        // The card is saved either way; losing the last four costs a label.
        console.error('payment method read failed', paymentMethodId, (e as Error)?.message);
      }

      // Record the card FIRST, as not-default. This is also the second
      // ownership check (the function re-validates company and customer on its
      // own), and recording before the default attempt means a card that is
      // attached at Stripe is never absent from SILO just because the
      // follow-up call failed.
      const { data: recorded, error: recErr } = await db.rpc('record_customer_card_setup', {
        p_company: company,
        p_session_id: session.id,
        p_setup_intent_id: setupIntentId,
        p_customer_id: customerId,
        p_payment_method_id: paymentMethodId,
        p_brand: brand,
        p_last4: last4,
        p_exp_month: expMonth,
        p_exp_year: expYear,
        p_is_default: false,
      });
      if (recErr) throw new Error(`record_customer_card_setup: ${recErr.message}`);
      if (recorded && (recorded as any).ok === false) {
        console.error('card setup not recorded', session.id, (recorded as any).reason);
        return;
      }

      // ── Attached is not the same as default ──────────────────────────────
      // Checkout ATTACHES the method to the Customer. It does NOT make it the
      // customer's invoice default, so an invoice created later would have no
      // payment method to charge and would sit open while everyone believed a
      // card was on file.
      try {
        await stripe.customers.update(
          customerId,
          { invoice_settings: { default_payment_method: paymentMethodId } },
          opts,
        );
        const { error: defErr } = await db.rpc('mark_customer_card_default', {
          p_company: company, p_session_id: session.id,
        });
        if (defErr) throw new Error(`mark_customer_card_default: ${defErr.message}`);
      } catch (e) {
        // A TERMINAL refusal (Stripe reached the request and rejected it) is
        // recorded and left: retrying it eight times changes nothing, and the
        // row already says the card is saved but not default, which the
        // customer list shows and docs/ops/customer-onboarding.md says how to
        // remedy.
        //
        // Anything else -- a 5xx, a rate limit, a dropped connection -- is
        // TRANSIENT, and swallowing it is how a card ends up permanently
        // unusable by invoice automation: the account reads 'succeeded', so
        // start_card_setup answers `already_captured` and nothing ever retries.
        // Rethrowing hands it back to the webhook's own retry ledger, and
        // every step above is idempotent, so the redelivery is safe.
        if (!isTerminalStripeError(e)) throw e;
        console.error('default_payment_method update refused', customerId,
          (e as Error)?.message);
      }
      return;
    }
    case 'connect_setup_expired': {
      const session = await stripe.checkout.sessions.retrieve(route.objectId, opts);
      if (session.mode !== 'setup') return;
      const { error } = await db.rpc('release_customer_card_setup', {
        p_company: company, p_session_id: session.id,
      });
      if (error) throw new Error(`release_customer_card_setup: ${error.message}`);
      return;
    }
    case 'connect_invoice': {
      const invoice = await stripe.invoices.retrieve(route.objectId, opts);
      await rpc('stripe_sync_invoice', {
        p_company: company, p_account: account, p_payload: invoice, p_synced_at: syncedAt,
      });
      return;
    }
  }
}

async function rpc(name: string, args: Record<string, unknown>) {
  // Stripe objects are class instances with non-enumerable internals; the
  // round trip through JSON is what the RPC's jsonb parameter needs, and it is
  // also what guarantees the stored `raw` is exactly what was mapped.
  const payload = args.p_payload
    ? JSON.parse(JSON.stringify(args.p_payload))
    : args.p_payload;
  const { error } = await db.rpc(name, { ...args, p_payload: payload });
  if (error) throw new Error(`${name}: ${error.message}`);
}
