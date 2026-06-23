import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  SHOPIFY_API_VERSION,
  missingForJob,
  missingForSync,
  normalizeGranted,
} from './shopify-scopes.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function shopifyGet(domain: string, token: string, path: string) {
  return fetch(`https://${domain}/admin/api/${SHOPIFY_API_VERSION}${path}`, {
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json();
    const { shop_domain, access_token } = body as { shop_domain: string; access_token: string };

    if (!shop_domain || !access_token) {
      return new Response(JSON.stringify({ error: 'shop_domain and access_token are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const domain = shop_domain.replace(/^https?:\/\//, '').replace(/\/$/, '');

    const shopRes = await shopifyGet(domain, access_token, '/shop.json');
    if (!shopRes.ok) {
      const text = await shopRes.text();
      return new Response(
        JSON.stringify({ ok: false, status: shopRes.status, error: text }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { shop } = await shopRes.json();

    let scopesGranted: string[] = [];
    let scopesError: string | null = null;

    const scopesRes = await shopifyGet(domain, access_token, '/oauth/access_scopes.json');
    if (scopesRes.ok) {
      const scopesJson = await scopesRes.json();
      scopesGranted = normalizeGranted(scopesJson);
    } else {
      scopesError = await scopesRes.text();
    }

    const scopesMissing = missingForSync(scopesGranted);
    const missingByJob = {
      history_import: missingForJob(scopesGranted, 'history_import'),
      incremental_sales: missingForJob(scopesGranted, 'incremental_sales'),
      inventory_snapshot: missingForJob(scopesGranted, 'inventory_snapshot'),
      catalog_sync: missingForJob(scopesGranted, 'catalog_sync'),
    };

    return new Response(
      JSON.stringify({
        ok: true,
        shop: {
          name: shop.name,
          domain: shop.domain,
          myshopify_domain: shop.myshopify_domain,
          currency: shop.currency,
          plan_name: shop.plan_name,
          country_name: shop.country_name,
        },
        scopes_granted: scopesGranted,
        scopes_missing: scopesMissing,
        scopes_ready_for_sync: scopesMissing.length === 0,
        missing_by_job: missingByJob,
        scopes_error: scopesError,
        scopes_checked_at: new Date().toISOString(),
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
