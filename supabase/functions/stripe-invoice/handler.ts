// stripe-invoice -- JWT-auth: the tenant invoices THEIR OWN customers through
// their connected Stripe account. Money moves to their balance; SILO's own
// Stripe account is only the API caller (platform key + Stripe-Account
// header), and takes no cut and holds no funds.
//
// Actions: create_customer | create_invoice | finalize | send | void |
//          uncollectible | sync
//
// THREE THINGS THIS FUNCTION REFUSES TO DO, each because the alternative is
// a real invoice sent to a real customer that nobody meant to send:
//
//   1. It never takes the company from the request body. The company is the
//      caller's own profiles.active_company_id, and the connected account is
//      whatever stripe_connect_accounts holds for it. A body-supplied account
//      id would let one tenant bill through another's Stripe.
//   2. It never creates without a claimed request id. The browser mints a
//      uuid, stripe_invoice_requests records it BEFORE Stripe is called, and a
//      retry carrying that id gets the FIRST attempt's invoice back. Stripe's
//      own Idempotency-Key is sent as well, but it only covers a retry that
//      reuses the key -- not the reload that mints a new one, which is the
//      retry that actually happens.
//   3. It never writes the mirror from what it believes it did. Every action
//      ends by re-fetching the invoice and syncing THAT, so SILO can never
//      show a state Stripe does not have.
//
// `finalize` is the point of no return: a finalized Stripe invoice cannot be
// edited or deleted, only voided. The page says so; this function does not
// second-guess it.
//
// Gate: can_manage_client_invoices(), evaluated by a caller-scoped client so
// it is the database's answer about this user. Deliberately narrower than
// is_admin_user() -- see the migration header.
//
// Secret: STRIPE_SECRET_KEY.
import { createClient } from 'npm:@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17.7.0';
import {
  InvoiceInputError, normalizeInvoiceLines, fingerprintInvoice,
  createOutcome,
} from './invoice-lines.mjs';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';

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

export async function handleStripeInvoice(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);
  if (!STRIPE_KEY) return reply({ error: 'STRIPE_SECRET_KEY is not configured' }, 500);

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: { user }, error: authErr } = await db.auth.getUser(jwt);
  if (authErr || !user) return reply({ error: 'Unauthorized' }, 401);

  const { data: profile } = await db
    .from('profiles').select('active_company_id, is_active').eq('id', user.id).single();
  if (!profile?.is_active) return reply({ error: 'Account is not active' }, 403);
  const company = profile.active_company_id;
  if (!company) return reply({ error: 'No active company' }, 400);

  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: permitted } = await caller.rpc('can_manage_client_invoices');
  if (!permitted) {
    return reply({ error: 'Invoicing is limited to finance, exec and owner-admins' }, 403);
  }

  const { data: connected } = await db
    .from('stripe_connect_accounts')
    .select('stripe_account_id, charges_enabled, details_submitted')
    .eq('company_entity_id', company)
    .maybeSingle();

  if (!connected?.stripe_account_id) {
    return reply({ error: 'This company has not connected a Stripe account yet' }, 409);
  }
  const account = connected.stripe_account_id;
  const opts = { stripeAccount: account };

  const body = await req.json().catch(() => ({}));
  const action = body?.action;

  try {
    switch (action) {
      case 'create_customer':  return reply(await createCustomer(company, account, opts, body, user.id));
      case 'create_invoice':   return reply(await createInvoice(company, account, opts, body, user.id, connected));
      case 'finalize':         return reply(await transition(company, account, opts, body, 'finalize'));
      case 'send':             return reply(await transition(company, account, opts, body, 'send'));
      case 'void':             return reply(await transition(company, account, opts, body, 'void'));
      case 'uncollectible':    return reply(await transition(company, account, opts, body, 'uncollectible'));
      case 'sync':             return reply(await syncOne(company, account, opts, body));
      default:                 return reply({ error: `Unknown action ${action}` }, 400);
    }
  } catch (e) {
    if (e instanceof InvoiceInputError) return reply({ error: e.message }, 400);
    const message = (e as Error)?.message ?? String(e);
    console.error('stripe-invoice failed', action, message);
    return reply({ error: message }, 502);
  }
}

async function createCustomer(
  company: string, account: string, opts: any, body: any, userId: string,
) {
  const requestId = requireRequestId(body);
  const name = String(body?.name ?? '').trim();
  const email = String(body?.email ?? '').trim();
  if (!name && !email) throw new InvoiceInputError('A customer needs a name or an email address');

  const claim = await beginRequest(requestId, company, account, 'create_customer', userId,
    `${name}\u0001${email}`);
  if (claim.already) {
    if (claim.status === 'pending') {
      throw new InvoiceInputError('That customer is already being created — refresh in a moment');
    }
    return { stripe_customer_id: claim.stripe_object_id, repeated: true };
  }

  let customer: any = null;
  try {
    customer = await stripe.customers.create(
      {
        name: name || undefined,
        email: email || undefined,
        phone: String(body?.phone ?? '').trim() || undefined,
        metadata: { silo_company_entity_id: company },
      },
      { ...opts, idempotencyKey: `silo-customer-${requestId}` },
    );
    await rpc('stripe_sync_invoice_customer', {
      p_company: company, p_account: account, p_payload: customer,
      p_synced_at: new Date().toISOString(),
    });
    await completeRequest(requestId, 'succeeded', customer.id);
    return { stripe_customer_id: customer.id, repeated: false };
  } catch (e) {
    // The same three-way decision createInvoice makes, and for the same
    // reason: `customers.create` can commit at Stripe and lose its answer, and
    // recording that as a plain `failed` tells the browser nothing exists --
    // so it mints a fresh request id, hence a fresh `silo-customer-<id>` key,
    // hence a SECOND customer for the same person, splitting their invoice
    // history. A 4xx reached Stripe and was refused, so that stays reclaimable.
    await completeRequest(
      requestId,
      customer?.id ? 'failed' : createOutcome(e),
      customer?.id ?? null,
      (e as Error)?.message,
    );
    throw e;
  }
}

async function createInvoice(
  company: string, account: string, opts: any, body: any, userId: string, connected: any,
) {
  const requestId = requireRequestId(body);
  const customer = String(body?.customer_id ?? '').trim();
  if (!customer) throw new InvoiceInputError('Pick a customer');

  const currency = String(body?.currency ?? 'usd').toLowerCase();
  const dueDays = body?.due_days == null ? null : Number(body.due_days);
  if (dueDays != null && (!Number.isInteger(dueDays) || dueDays < 0 || dueDays > 365)) {
    throw new InvoiceInputError('Payment terms must be a whole number of days, 0–365');
  }

  // Every line is validated before ANYTHING is created: a failure partway
  // through leaves a half-built draft in the client's real Stripe account.
  const { lines, total } = normalizeInvoiceLines(body?.lines, currency);

  const claim = await beginRequest(
    requestId, company, account, 'create_invoice', userId,
    fingerprintInvoice({ customer, currency, dueDays, lines, memo: body?.memo }),
  );
  if (claim.already) {
    if (claim.status === 'pending') {
      throw new InvoiceInputError('That invoice is already being created — refresh in a moment');
    }
    const existing = await stripe.invoices.retrieve(claim.stripe_object_id!, opts);
    const id = await syncInvoice(company, account, existing);
    return { invoice_id: id, stripe_invoice_id: existing.id, repeated: true, total_cents: total };
  }

  // A draft invoice is created FIRST and each item is attached to it by id.
  // The alternative -- creating pending invoice items and letting the next
  // invoice sweep them up -- is Stripe's older flow and it is dangerous here:
  // a failure between the items and the invoice leaves them pending on the
  // customer, where they attach themselves to whatever invoice is created
  // next, possibly weeks later.
  let invoice: Stripe.Invoice | null = null;
  try {
    invoice = await stripe.invoices.create(
      {
        customer,
        currency,
        collection_method: 'send_invoice',
        days_until_due: dueDays ?? 30,
        description: String(body?.memo ?? '').trim() || undefined,
        footer: String(body?.footer ?? '').trim() || undefined,
        auto_advance: false,
        metadata: { silo_request_id: requestId, silo_company_entity_id: company },
      },
      { ...opts, idempotencyKey: `silo-invoice-${requestId}` },
    );

    for (const [i, line] of lines.entries()) {
      await stripe.invoiceItems.create(
        {
          customer,
          invoice: invoice.id,
          currency,
          description: line.description,
          quantity: line.quantity,
          unit_amount: line.unit_amount,
        },
        { ...opts, idempotencyKey: `silo-invoice-${requestId}-line-${i}` },
      );
    }

    const fresh = await stripe.invoices.retrieve(invoice.id, opts);
    const id = await syncInvoice(company, account, fresh, requestId, userId);
    await completeRequest(requestId, 'succeeded', fresh.id);
    return {
      invoice_id: id,
      stripe_invoice_id: fresh.id,
      status: fresh.status,
      total_cents: fresh.total,
      charges_enabled: connected.charges_enabled,
      repeated: false,
    };
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    // A draft we KNOW exists is recorded against its id. Otherwise the
    // question is whether Stripe committed one we never heard about: a 4xx
    // says it did not, anything else says we cannot tell -- and "cannot tell"
    // must keep this request id alive, because the retry's Stripe idempotency
    // key is derived from it and is the only thing that stops a second real
    // draft reaching the client's customer.
    await completeRequest(
      requestId,
      invoice?.id ? 'failed' : createOutcome(e),
      invoice?.id ?? null,
      message,
    );
    // A draft that was created before the failure is MIRRORED anyway rather
    // than left invisible: it exists in the client's Stripe either way, and an
    // orphan nobody can see is one nobody can void.
    if (invoice?.id) {
      try {
        const partial = await stripe.invoices.retrieve(invoice.id, opts);
        await syncInvoice(company, account, partial, requestId, userId);
      } catch (_) { /* the original error is the one worth reporting */ }
    }
    throw e;
  }
}

async function transition(
  company: string, account: string, opts: any, body: any, kind: string,
) {
  const stripeInvoiceId = await resolveInvoice(company, body);

  let updated: Stripe.Invoice;
  switch (kind) {
    case 'finalize':
      updated = await stripe.invoices.finalizeInvoice(stripeInvoiceId, {}, opts);
      break;
    case 'send':
      // sendInvoice finalizes a draft on the way through, so a draft never
      // needs finalizing first -- but the page still shows finalize
      // separately, because "lock it" and "email it" are different decisions.
      updated = await stripe.invoices.sendInvoice(stripeInvoiceId, opts);
      break;
    case 'void':
      updated = await stripe.invoices.voidInvoice(stripeInvoiceId, {}, opts);
      break;
    case 'uncollectible':
      updated = await stripe.invoices.markUncollectible(stripeInvoiceId, {}, opts);
      break;
    default:
      throw new InvoiceInputError(`Unknown transition ${kind}`);
  }

  const id = await syncInvoice(company, account, updated);
  return { invoice_id: id, status: updated.status, hosted_invoice_url: updated.hosted_invoice_url };
}

async function syncOne(company: string, account: string, opts: any, body: any) {
  const stripeInvoiceId = await resolveInvoice(company, body);
  const invoice = await stripe.invoices.retrieve(stripeInvoiceId, opts);
  const id = await syncInvoice(company, account, invoice);
  return { invoice_id: id, status: invoice.status };
}

/**
 * Turn whatever the page sent into a Stripe invoice id THIS company owns.
 *
 * The page sends SILO's own row id, and the Stripe id is read from that row.
 * Accepting a Stripe id straight from the body would mean voiding an invoice
 * is a matter of knowing its id -- and `in_xxx` ids appear in customers'
 * emails.
 */
async function resolveInvoice(company: string, body: any): Promise<string> {
  const rowId = String(body?.invoice_id ?? '').trim();
  if (!rowId) throw new InvoiceInputError('invoice_id is required');
  const { data } = await db
    .from('stripe_invoices')
    .select('stripe_invoice_id')
    .eq('company_entity_id', company)
    .eq('id', rowId)
    .maybeSingle();
  if (!data?.stripe_invoice_id) throw new InvoiceInputError('No such invoice for this company');
  return data.stripe_invoice_id;
}

async function syncInvoice(
  company: string, account: string, invoice: Stripe.Invoice,
  requestId?: string, userId?: string,
) {
  const { data, error } = await db.rpc('stripe_sync_invoice', {
    p_company: company,
    p_account: account,
    p_payload: JSON.parse(JSON.stringify(invoice)),
    p_synced_at: new Date().toISOString(),
  });
  if (error) throw new Error(`stripe_sync_invoice: ${error.message}`);

  // Attribution is SILO's own, not Stripe's, so it is stamped after the sync
  // rather than mapped from the payload -- and only on creation, so a later
  // sync by a colleague does not re-attribute the invoice to them.
  if (data && requestId) {
    await db.from('stripe_invoices')
      .update({ request_id: requestId, created_by: userId ?? null })
      .eq('id', data)
      .is('request_id', null);
  }
  return data as string;
}

function requireRequestId(body: any): string {
  const id = String(body?.request_id ?? '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new InvoiceInputError('request_id must be a uuid minted by the caller');
  }
  return id;
}

async function beginRequest(
  requestId: string, company: string, account: string,
  action: string, userId: string, fingerprint: string,
) {
  const { data, error } = await db.rpc('stripe_begin_invoice_request', {
    p_request_id: requestId,
    p_company: company,
    p_account: account,
    p_action: action,
    p_user: userId,
    p_fingerprint: fingerprint,
  });
  if (error) throw new Error(`stripe_begin_invoice_request: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return {
    already: !!row?.already,
    status: row?.status as string,
    stripe_object_id: row?.stripe_object_id as string | null,
  };
}

async function completeRequest(
  requestId: string, status: string, objectId?: string | null, error?: string,
) {
  await db.rpc('stripe_complete_invoice_request', {
    p_request_id: requestId,
    p_status: status,
    p_object_id: objectId ?? null,
    p_error: error ?? null,
  });
}

async function rpc(name: string, args: Record<string, unknown>) {
  const payload = JSON.parse(JSON.stringify(args.p_payload));
  const { error } = await db.rpc(name, { ...args, p_payload: payload });
  if (error) throw new Error(`${name}: ${error.message}`);
}
