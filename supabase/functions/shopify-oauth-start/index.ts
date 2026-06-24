import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CLIENT_ID = Deno.env.get('SHOPIFY_CLIENT_ID') ?? '';
const CALLBACK_URL = 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/shopify-oauth-callback';

const SCOPES = [
  'read_all_orders','read_analytics','read_app_proxy','read_apps',
  'read_assigned_fulfillment_orders','read_audit_events','read_customer_events',
  'read_cart_transforms','read_all_cart_transforms','read_validations',
  'read_channels','read_checkout_branding_settings','read_companies',
  'read_custom_fulfillment_services','read_custom_pixels','read_customers',
  'read_customer_data_erasure','read_customer_merge','read_delivery_customizations',
  'read_delivery_option_generators','read_discounts','read_discounts_allocator_functions',
  'read_discovery','read_draft_orders','read_files','read_fulfillment_constraint_rules',
  'read_fulfillments','read_gift_card_transactions','read_gift_cards','read_inventory',
  'read_inventory_shipments','read_inventory_shipments_received_items',
  'read_inventory_transfers','read_legal_policies','read_locales','read_locations',
  'read_marketing_events','read_marketing_integrated_campaigns','read_markets',
  'read_markets_home','read_merchant_managed_fulfillment_orders',
  'read_metaobject_definitions','read_metaobjects','read_online_store_navigation',
  'read_online_store_pages','read_order_edits','read_orders','read_packing_slip_templates',
  'read_payment_customizations','read_payment_terms','read_pixels','read_price_rules',
  'read_privacy_settings','read_product_feeds','read_product_listings','read_products',
  'read_publications','read_purchase_options','read_reports','read_resource_feedbacks',
  'read_returns','read_script_tags','read_shipping','read_shopify_payments_accounts',
  'read_shopify_payments_bank_accounts','read_shopify_payments_disputes',
  'read_shopify_payments_payouts','read_content','read_store_credit_account_transactions',
  'read_store_credit_accounts','read_third_party_fulfillment_orders','read_translations',
].join(',');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  if (!CLIENT_ID) {
    return new Response(JSON.stringify({ error: 'SHOPIFY_CLIENT_ID not configured' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: { user }, error: authErr } = await supabase.auth.getUser(
    authHeader.replace('Bearer ', ''),
  );
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { shop_domain, company_entity_id } = await req.json();
  if (!shop_domain || !company_entity_id) {
    return new Response(JSON.stringify({ error: 'shop_domain and company_entity_id required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const shop = shop_domain.includes('.') ? shop_domain : `${shop_domain}.myshopify.com`;
  const nonce = crypto.randomUUID();

  const { error: stateErr } = await supabase.from('shopify_oauth_states').insert({
    nonce,
    company_entity_id,
    user_id: user.id,
    shop_domain: shop,
  });

  if (stateErr) {
    return new Response(JSON.stringify({ error: stateErr.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const authorizeUrl = `https://${shop}/admin/oauth/authorize?` + new URLSearchParams({
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: CALLBACK_URL,
    state: nonce,
  }).toString();

  return new Response(JSON.stringify({ url: authorizeUrl }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
