// stripe-billing -- JWT-auth: what a tenant company pays SILO.
//
// This is the OTHER Stripe, and the one that is easy to confuse with
// stripe-invoice: here SILO is the merchant and the company is the customer,
// so every call uses the platform key with NO Stripe-Account header. Nothing
// in this file touches a connected account.
//
// Actions:
//   checkout -- a Stripe Checkout session for a plan from billing_plans.
//   portal   -- a Stripe Billing Portal session (change card, change plan,
//               cancel, download receipts).
//   sync     -- re-fetch the subscription and its recent invoices.
//
// WHY CHECKOUT AND THE PORTAL RATHER THAN A PRICING UI IN SILO: card details
// never reach SILO's origin, so SILO stays out of PCI scope entirely, and
// "cancel my plan" is Stripe's screen with Stripe's rules rather than a
// cancel button whose edge cases (proration, mid-period, reactivation) SILO
// would have to reimplement and get wrong.
//
// Gate: is_owner_admin_of_active_company(). Committing the company to a
// recurring charge -- or cancelling one -- is an owner's act, not an admin's.
//
// The customer id is recorded BEFORE the browser leaves for Stripe
// (stripe_begin_checkout), because the subscription webhook is attributed by
// customer id and it can arrive before the user comes back.
//
// Secret: STRIPE_SECRET_KEY. Link base: SILO_SITE_URL.
import { createClient } from 'npm:@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17.7.0';
import { checkoutDecision, LIVE_STATUSES } from './subscription-state.mjs';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const SITE_URL = Deno.env.get('SILO_SITE_URL') ?? 'https://silo-baseballism.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

const db = createClient(SUPABASE_URL, SERVICE_KEY);
const stripe = new Stripe(STRIPE_KEY, { httpClient: Stripe.createFetchHttpClient() });

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

export async function handleStripeBilling(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);
  if (!STRIPE_KEY) return reply({ error: 'STRIPE_SECRET_KEY is not configured' }, 500);

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: { user }, error: authErr } = await db.auth.getUser(jwt);
  if (authErr || !user) return reply({ error: 'Unauthorized' }, 401);

  const { data: profile } = await db
    .from('profiles').select('active_company_id, is_active, email, name').eq('id', user.id).single();
  if (!profile?.is_active) return reply({ error: 'Account is not active' }, 403);
  const company = profile.active_company_id;
  if (!company) return reply({ error: 'No active company' }, 400);

  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: isOwnerAdmin } = await caller.rpc('is_owner_admin_of_active_company');
  if (!isOwnerAdmin) {
    return reply({ error: 'Only an owner-admin can change the company subscription' }, 403);
  }

  const body = await req.json().catch(() => ({}));

  try {
    switch (body?.action) {
      case 'checkout': return reply(await checkout(company, profile, user.id, body));
      case 'portal':   return reply(await portal(company));
      case 'sync':     return reply(await sync(company));
      default:         return reply({ error: `Unknown action ${body?.action}` }, 400);
    }
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    console.error('stripe-billing failed', body?.action, message);
    return reply({ error: message }, 502);
  }
}

async function customerFor(company: string, profile: any): Promise<string> {
  const { data: existing } = await db
    .from('billing_subscriptions')
    .select('stripe_customer_id')
    .eq('company_entity_id', company)
    .maybeSingle();
  if (existing?.stripe_customer_id) return existing.stripe_customer_id;

  const { data: entity } = await db
    .from('entities').select('title').eq('id', company).maybeSingle();

  const customer = await stripe.customers.create({
    name: entity?.title ?? undefined,
    email: profile.email ?? undefined,
    metadata: { silo_company_entity_id: company },
  }, { idempotencyKey: `silo-billing-customer-${company}` });

  // Recorded before the session is created, not after: the subscription
  // webhook is attributed BY this id, and it can land before the browser
  // returns from Checkout. Written through the RPC, which refuses to bind a
  // customer already claimed by another company.
  const { error } = await db.rpc('stripe_begin_checkout', {
    p_company: company, p_customer: customer.id,
  });
  if (error) throw new Error(`stripe_begin_checkout: ${error.message}`);
  return customer.id;
}

async function checkout(company: string, profile: any, userId: string, body: any) {
  const planKey = String(body?.plan_key ?? '').trim();
  if (!planKey) throw new Error('plan_key is required');

  // The price comes from billing_plans, never from the request. A
  // client-supplied price id is a client-chosen price.
  const { data: plan } = await db
    .from('billing_plans')
    .select('plan_key, stripe_price_id, seat_based, is_active')
    .eq('plan_key', planKey)
    .maybeSingle();
  if (!plan?.is_active) throw new Error(`Plan ${planKey} is not available`);

  // Checkout in subscription mode CREATES a subscription -- it never switches
  // one. Opening a second for a live subscriber leaves the first running and
  // bills for both, while billing_subscriptions holds one row per company and
  // would show only whichever synced last. Refused here, at the boundary,
  // rather than only in the page that offers the button.
  const { data: current } = await db
    .from('billing_subscriptions')
    .select('status, plan_key, stripe_subscription_id, stripe_customer_id')
    .eq('company_entity_id', company)
    .maybeSingle();

  const decision = checkoutDecision(current);
  if (!decision.allowed) throw new Error(decision.reason);

  // The mirror said no live subscription. That is the answer to trust ONLY if
  // the mirror is current, and the case where it is not is precisely the
  // dangerous one: the first Checkout completed at Stripe, its webhook has not
  // landed, the redirect was lost, and the row is still the `incomplete`
  // placeholder. Reopening Billing then offers Subscribe again.
  //
  // So when a customer already exists, Stripe is asked directly before a
  // second Checkout is opened. Stripe is the record; the mirror is a cache,
  // and this is the one read where believing the cache costs money.
  if (current?.stripe_customer_id) {
    const remote = await stripe.subscriptions.list({
      customer: current.stripe_customer_id, status: 'all', limit: 10,
    });
    const live = remote.data.find((s) => LIVE_STATUSES.has(s.status));
    if (live) {
      // Reconcile while we are here, so the page stops offering it too.
      await db.rpc('stripe_sync_subscription', {
        p_company: company,
        p_payload: JSON.parse(JSON.stringify(live)),
        p_synced_at: new Date().toISOString(),
      });
      throw new Error(
        'This company already has a live subscription at Stripe (' + live.status + ') that SILO '
        + 'had not yet recorded — the webhook is still in flight. Nothing was charged twice; '
        + 'reload Billing to see it, and change the plan through Manage billing.');
    }
  }

  const customer = await customerFor(company, profile);

  let quantity = 1;
  if (plan.seat_based) {
    // Seats are MEASURED, not asked for: the number of active members of this
    // company. Letting the page send it would let a company buy one seat and
    // invite thirty.
    // ACTIVE members, not members. `is_active` lives on profiles and
    // deactivation deliberately does not remove memberships (see the founding
    // rules in CLAUDE.md), so counting membership rows bills the tenant for
    // people who cannot sign in.
    const { count } = await db
      .from('entity_memberships')
      .select('user_id, profiles!inner(is_active)', { count: 'exact', head: true })
      .eq('entity_id', company)
      .eq('profiles.is_active', true);
    quantity = Math.max(1, count ?? 1);
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer,
    line_items: [{ price: plan.stripe_price_id, quantity }],
    success_url: `${SITE_URL}/v2/billing.html?checkout=done`,
    cancel_url: `${SITE_URL}/v2/billing.html?checkout=cancelled`,
    client_reference_id: company,
    subscription_data: {
      metadata: { silo_company_entity_id: company, silo_started_by: userId },
    },
    // Not an idempotency key: two deliberate checkout attempts an hour apart
    // are two legitimate sessions, and a stale session URL is worse than a
    // fresh one (Checkout sessions expire).
  });

  return { url: session.url, plan_key: plan.plan_key, quantity };
}

async function portal(company: string) {
  const { data: sub } = await db
    .from('billing_subscriptions')
    .select('stripe_customer_id')
    .eq('company_entity_id', company)
    .maybeSingle();
  if (!sub?.stripe_customer_id) {
    throw new Error('This company has no Stripe customer yet — subscribe first');
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: sub.stripe_customer_id,
    return_url: `${SITE_URL}/v2/billing.html`,
  });
  return { url: session.url };
}

async function sync(company: string) {
  const { data: row } = await db
    .from('billing_subscriptions')
    .select('stripe_customer_id, stripe_subscription_id')
    .eq('company_entity_id', company)
    .maybeSingle();
  if (!row?.stripe_customer_id) return { synced: false, reason: 'no customer' };

  // Listed rather than retrieved by the stored id: the stored id can be stale
  // (a subscription cancelled and a new one started in the portal), and the
  // customer id is the stable handle.
  const subs = await stripe.subscriptions.list({
    customer: row.stripe_customer_id, status: 'all', limit: 5,
  });
  const active = subs.data.find((s) => ['active', 'trialing', 'past_due', 'unpaid'].includes(s.status))
    ?? subs.data[0];

  if (active) {
    const { error } = await db.rpc('stripe_sync_subscription', {
      p_company: company,
      p_payload: JSON.parse(JSON.stringify(active)),
      p_synced_at: new Date().toISOString(),
    });
    if (error) throw new Error(`stripe_sync_subscription: ${error.message}`);
  }

  const invoices = await stripe.invoices.list({ customer: row.stripe_customer_id, limit: 24 });
  for (const invoice of invoices.data) {
    const { error } = await db.rpc('stripe_sync_billing_invoice', {
      p_company: company,
      p_payload: JSON.parse(JSON.stringify(invoice)),
      p_synced_at: new Date().toISOString(),
    });
    if (error) throw new Error(`stripe_sync_billing_invoice: ${error.message}`);
  }

  return { synced: true, subscription: active?.status ?? null, invoices: invoices.data.length };
}
