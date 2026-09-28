// Shopify's mandatory privacy (GDPR) webhooks: customers/data_request,
// customers/redact and shop/redact. PUBLIC (verify_jwt off): Shopify has no
// SILO login -- the HMAC signature is the entire authorization, checked
// against SILO's app secrets before anything is read or written.
//
// What SILO holds about a person is exactly three fields: customer_name,
// customer_email and customer_id on shopify_orders and shopify_draft_orders.
// Sales figures are not personal data and are kept. (Shopify sends
// customers/redact after the merchant erased the customer in Shopify, so a
// later sync re-fetching those orders gets no customer details back.)
//
//   customers/data_request -> recorded; a person answers the merchant. Nothing
//                             is sent automatically.
//   customers/redact       -> the three fields blanked on that customer's
//                             orders and on every order Shopify lists.
//   shop/redact            -> the connections the uninstalled app issued are
//                             closed; customer details on the store's orders
//                             are blanked unless SILO still holds a live
//                             connection to the store another way
//                             (planShopRedact).
// Every request is written to shopify_compliance_requests with what was done.
// Shopify expects 200 for a handled request and 401 for a bad signature.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  planCompliance, planShopRedact, REDACTED_CUSTOMER_FIELDS, webhookSigningApp,
} from './shopify-auth-lib.mjs';

const ENV = {
  SHOPIFY_PUBLIC_CLIENT_ID: Deno.env.get('SHOPIFY_PUBLIC_CLIENT_ID'),
  SHOPIFY_PUBLIC_CLIENT_SECRET: Deno.env.get('SHOPIFY_PUBLIC_CLIENT_SECRET'),
  SHOPIFY_CLIENT_ID: Deno.env.get('SHOPIFY_CLIENT_ID'),
  SHOPIFY_CLIENT_SECRET: Deno.env.get('SHOPIFY_CLIENT_SECRET'),
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const raw = new Uint8Array(await req.arrayBuffer());
  const app = await webhookSigningApp(raw, req.headers.get('X-Shopify-Hmac-Sha256'), ENV);
  if (!app) return new Response('Unauthorized', { status: 401 });

  const topic = String(req.headers.get('X-Shopify-Topic') ?? '').trim();
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch { /* recorded as ignored below */ }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const plan = planCompliance(topic, payload);

  const { data: conns } = plan.shop
    ? await admin.from('shopify_connections')
        .select('id, company_entity_id, auth_method, oauth_app, is_active, access_token')
        .eq('shop_domain', plan.shop)
    : { data: [] };
  const companyId = conns?.[0]?.company_entity_id ?? null;

  let status = 'recorded';
  let rows = 0;
  let note: string | null = plan.reason ?? null;
  const errors: string[] = [];

  const blank = async (table: string, filter: (q: any) => any) => {
    const { data, error } = await filter(admin.from(table).update(REDACTED_CUSTOMER_FIELDS)).select('id');
    if (error) errors.push(`${table}: ${error.message}`);
    rows += data?.length ?? 0;
  };

  if (plan.action === 'record_only') {
    status = 'needs_response';
    note = note ?? `Signed by the ${app} app. A person must send the merchant what SILO holds for this customer: name, email and Shopify id on their orders.`;
  } else if (plan.action === 'redact_customer') {
    if (plan.customerId) {
      await blank('shopify_orders', (q) => q.eq('shop_domain', plan.shop).eq('customer_id', plan.customerId));
      await blank('shopify_draft_orders', (q) => q.eq('shop_domain', plan.shop).eq('customer_id', plan.customerId));
    }
    if (plan.orderIds.length) {
      await blank('shopify_orders', (q) => q.eq('shop_domain', plan.shop).in('order_id', plan.orderIds));
    }
    status = errors.length ? 'error' : 'redacted';
  } else if (plan.action === 'redact_shop') {
    const decision = planShopRedact(conns ?? [], app);
    if (decision.closeConnectionIds.length) {
      await admin.from('shopify_client_credentials').delete().in('connection_id', decision.closeConnectionIds);
      const { error } = await admin.from('shopify_connections')
        .update({ access_token: null, is_active: false, sync_enabled: false, token_expires_at: null })
        .in('id', decision.closeConnectionIds);
      if (error) errors.push(`shopify_connections: ${error.message}`);
    }
    if (decision.redactOrders) {
      await blank('shopify_orders', (q) => q.eq('shop_domain', plan.shop));
      await blank('shopify_draft_orders', (q) => q.eq('shop_domain', plan.shop));
      status = errors.length ? 'error' : 'redacted';
    } else {
      status = errors.length ? 'error' : 'kept';
      note = `The ${app} app was uninstalled, but SILO still syncs this store through connection(s) ${decision.keptBecause.join(', ')}; customer details on its orders are held under that connection and were kept.`;
    }
  } else {
    status = 'ignored';
  }

  await admin.from('shopify_compliance_requests').insert({
    topic: topic || '(none)',
    shop_domain: plan.shop ?? null,
    company_entity_id: companyId,
    action: plan.action,
    status,
    rows_redacted: rows,
    payload,
    note: errors.length ? `${note ?? ''} Errors: ${errors.join('; ')}`.trim() : note,
    handled_at: status === 'needs_response' ? null : new Date().toISOString(),
  });

  // A failed redaction answers 500 so Shopify retries it; everything else 200.
  return new Response(errors.length ? 'Error' : 'OK', { status: errors.length ? 500 : 200 });
});
