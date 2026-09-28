import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  SHOPIFY_API_VERSION,
  missingForJob,
  missingForSync,
  normalizeGranted,
} from './shopify-scopes.ts';
import { ensureShopifyAccessToken, hasFullOrderHistory, ShopifyTokenError } from './shopify-auth-lib.mjs';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function shopifyAdminGet(domain: string, token: string, apiPath: string) {
  return fetch(`https://${domain}/admin/api/${SHOPIFY_API_VERSION}${apiPath}`, {
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
  });
}

/** OAuth metadata routes are NOT under /admin/api/{version}/ */
async function shopifyOAuthGet(domain: string, token: string, oauthPath: string) {
  return fetch(`https://${domain}/admin/oauth/${oauthPath}`, {
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
    let { shop_domain, access_token } = body as { shop_domain: string; access_token: string };
    const connectionId = String((body as { connection_id?: string }).connection_id ?? '').trim();

    // By connection id: read the row as the CALLER (RLS scopes it to their
    // active company), then get its token with the service role -- which is
    // what mints a fresh one for a client-credentials store, whose client
    // secret the browser can never read. The browser never handles the token.
    if (connectionId) {
      // The caller's read proves the row is in their company; access_token
      // is not a column members may select, so the token itself comes from
      // the service-role read that follows, by that same id.
      const { data: visible, error: visErr } = await supabase
        .from('shopify_connections')
        .select('id')
        .eq('id', connectionId)
        .maybeSingle();
      const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      const { data: conn, error: connErr } = visible && !visErr
        ? await admin.from('shopify_connections')
            .select('id, shop_domain, access_token, auth_method, token_expires_at')
            .eq('id', visible.id)
            .maybeSingle()
        : { data: null, error: visErr };
      if (connErr || !conn) {
        return new Response(JSON.stringify({ ok: false, error: 'Connection not found' }), {
          status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      try {
        access_token = await ensureShopifyAccessToken(admin, conn) ?? '';
      } catch (err) {
        const message = err instanceof ShopifyTokenError ? err.message : String(err);
        return new Response(JSON.stringify({ ok: false, error: message }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      shop_domain = conn.shop_domain;
    }

    if (!shop_domain || !access_token) {
      return new Response(JSON.stringify({ error: 'shop_domain and access_token are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const domain = shop_domain.replace(/^https?:\/\//, '').replace(/\/$/, '');

    const shopRes = await shopifyAdminGet(domain, access_token, '/shop.json');
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

    const scopesRes = await shopifyOAuthGet(domain, access_token, 'access_scopes.json');
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
    const checkedAt = new Date().toISOString();

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
        scopes_checked_at: checkedAt,
        // Without read_all_orders Shopify returns only the last 60 days of
        // orders, with no error -- a history import would silently start
        // two months ago. The page says so rather than showing an empty past.
        full_order_history: hasFullOrderHistory(scopesGranted),
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
