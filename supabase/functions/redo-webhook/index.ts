// redo-webhook -- PUBLIC (verify_jwt off): receives Redo's "Return event"
// webhook and upserts the return's dollar breakdown into redo_returns.
// Redo authenticates outbound webhook calls with a subscriber-supplied
// Bearer secret (not a Supabase JWT), so this function must stay public and
// do its own auth against redo_connections.webhook_secret.
//
// URL shape: POST /functions/v1/redo-webhook/{company_entity_id}
// The company id is in the path (not inferred from the payload) because
// Redo's webhook config is per-store -- each company points its own Redo
// store at its own URL, same reasoning as review-portal's token-is-the-auth
// model but keyed by path segment instead of a token.
//
// Payload shape (from Redo's docs, same object as GET /returns/{id}.return):
//   { type, at, merchantName, return: {...}, order: {...} }
// `return.totals` carries the amounts that matter for reconciliation --
// refund/exchange/storeCredit/charge/shippingFee -- since Shopify's own
// refund record only ever reflects the `refund` slice.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const db = createClient(SUPABASE_URL, SERVICE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

function moneyAmount(node: { amount?: { amount?: string } } | undefined): number {
  const raw = node?.amount?.amount;
  return raw ? Number(raw) || 0 : 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);

  try {
    const url = new URL(req.url);
    const companyEntityId = url.pathname.split('/').filter(Boolean).pop();
    if (!companyEntityId) return reply({ error: 'company_entity_id required in path' }, 400);

    const { data: connection } = await db
      .from('redo_connections')
      .select('id, webhook_secret, is_active')
      .eq('company_entity_id', companyEntityId)
      .single();

    if (!connection || !connection.is_active) {
      return reply({ error: 'No active Redo connection for this company' }, 404);
    }

    const authHeader = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!connection.webhook_secret || authHeader !== connection.webhook_secret) {
      return reply({ error: 'Not authenticated' }, 401);
    }

    const event = await req.json();
    const ret = event?.return;
    if (!ret?.id) return reply({ error: 'Missing return.id in payload' }, 400);

    const currency =
      ret.totals?.refund?.amount?.currency ||
      ret.totals?.exchange?.amount?.currency ||
      'USD';

    const row = {
      company_entity_id: companyEntityId,
      redo_return_id: ret.id,
      redo_order_id: ret.order?.id ?? null,
      shopify_order_name: ret.order?.name ?? null,
      shopify_order_id: ret.externalOrderIds?.[0] ?? ret.shopifyOrderIds?.[0] ?? null,
      return_type: ret.type ?? null,
      status: ret.status ?? null,
      compensation_methods: ret.compensationMethods ?? [],
      refund_amount: moneyAmount(ret.totals?.refund),
      exchange_amount: moneyAmount(ret.totals?.exchange),
      store_credit_amount: moneyAmount(ret.totals?.storeCredit),
      charge_amount: moneyAmount(ret.totals?.charge),
      shipping_fee_amount: moneyAmount(ret.totals?.shippingFee),
      currency,
      last_event_type: event?.type ?? null,
      redo_created_at: ret.createdAt ?? null,
      redo_updated_at: ret.updatedAt ?? null,
      raw: ret,
      updated_at: new Date().toISOString(),
    };

    const { error: upsertErr } = await db
      .from('redo_returns')
      .upsert(row, { onConflict: 'company_entity_id,redo_return_id' });
    if (upsertErr) throw upsertErr;

    await db
      .from('redo_connections')
      .update({ last_event_at: new Date().toISOString(), last_event_type: event?.type ?? null })
      .eq('id', connection.id);

    return reply({ ok: true });
  } catch (err) {
    console.error('[redo-webhook]', err);
    return reply({ error: String((err as Error)?.message || err) }, 500);
  }
});
