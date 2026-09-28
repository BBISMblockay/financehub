import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { chooseOAuthApp, mayConnect, normalizeShopDomain, PUBLIC_SCOPES } from './shopify-auth-lib.mjs';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Which of SILO's two Shopify apps starts the flow: the public app once its
// keys are set, the legacy custom app until then (shopify-auth-lib.mjs).
const APP = chooseOAuthApp({
  SHOPIFY_PUBLIC_CLIENT_ID: Deno.env.get('SHOPIFY_PUBLIC_CLIENT_ID'),
  SHOPIFY_PUBLIC_CLIENT_SECRET: Deno.env.get('SHOPIFY_PUBLIC_CLIENT_SECRET'),
  SHOPIFY_CLIENT_ID: Deno.env.get('SHOPIFY_CLIENT_ID'),
  SHOPIFY_CLIENT_SECRET: Deno.env.get('SHOPIFY_CLIENT_SECRET'),
});
const CALLBACK_URL = 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/shopify-oauth-callback';

// The LEGACY app's scopes, unchanged: Baseballism's stores were installed
// with these (read_all_orders included) and a reconnect must not quietly lose
// any. The public app asks for PUBLIC_SCOPES -- what the sync reads, since
// Shopify's review rejects unused scopes.
const LEGACY_SCOPES = [
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

  if (!APP) {
    return new Response(JSON.stringify({ error: 'Shopify app keys not configured' }), {
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

  const shop = normalizeShopDomain(shop_domain);
  if (!shop) {
    return new Response(JSON.stringify({ error: 'Enter the store\'s myshopify.com address' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // The caller must administer the company they name, with an active
  // account. This function runs with the service role, so RLS is not doing it;
  // before 2026-09-28 any signed-in user could start a flow for any company.
  const { data: profile, error: profileError } = await supabase
    .from('profiles').select('role, active_company_id, is_active').eq('id', user.id).maybeSingle();
  const { data: membership, error: membershipError } = await supabase
    .from('entity_memberships').select('role').eq('entity_id', company_entity_id).eq('user_id', user.id).maybeSingle();
  if (!mayConnect({ profile, profileError, membership, membershipError, companyId: company_entity_id })) {
    return new Response(JSON.stringify({ error: 'Admin access required for this company' }), {
      status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const nonce = crypto.randomUUID();

  const { error: stateErr } = await supabase.from('shopify_oauth_states').insert({
    nonce,
    company_entity_id,
    user_id: user.id,
    shop_domain: shop,
    oauth_app: APP.app,
  });

  if (stateErr) {
    return new Response(JSON.stringify({ error: stateErr.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const authorizeUrl = `https://${shop}/admin/oauth/authorize?` + new URLSearchParams({
    client_id: APP.clientId,
    scope: APP.app === 'public' ? PUBLIC_SCOPES.join(',') : LEGACY_SCOPES,
    redirect_uri: CALLBACK_URL,
    state: nonce,
  }).toString();

  return new Response(JSON.stringify({ url: authorizeUrl }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
