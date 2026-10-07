// One-order verification only: SELECT a connection, query Shopify, report counts.
// No collector, catalog, token refresh, snapshot publication or credential writes.
import {pathToFileURL} from 'node:url';
import {normalizeShopDomain,tokenNeedsRefresh} from './lib/shopify-auth-lib.mjs';
import {shopifyGraphql} from './lib/shopify-sync-core.mjs';
import {fetchJourney} from './lib/shopify-attribution-evidence.mjs';

class ProbeError extends Error {}
export async function runAttributionProbe(env,{createClient,gql=shopifyGraphql,now=Date.now()}={}) {
  const id=env.ATTRIBUTION_PROBE_ORDER_ID;
  if (!/^[1-9]\d*$/.test(id || '')) throw new ProbeError('One numeric Shopify order ID required');
  if (env.ATTRIBUTION_MODE === 'scheduled' || env.ATTRIBUTION_START || env.ATTRIBUTION_END ||
      env.ATTRIBUTION_COMMIT && env.ATTRIBUTION_COMMIT !== 'false') {
    throw new ProbeError('Probe requires manual mode, blank dates and commit=false');
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY ||
      !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(env.ATTRIBUTION_CONNECTION_ID || '')) {
    throw new ProbeError('Existing Supabase secrets and one connection UUID required');
  }
  const db=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:connection,error}=await db.from('shopify_connections')
    .select('id,shop_domain,access_token,auth_method,token_expires_at,is_active,sync_enabled')
    .eq('id',env.ATTRIBUTION_CONNECTION_ID).single();
  if (error || !connection?.is_active || !connection.sync_enabled) throw new ProbeError('Active sync-enabled connection required');
  const domain=normalizeShopDomain(connection.shop_domain);
  if (!domain) throw new ProbeError('Invalid Shopify domain');
  const expiry=connection.token_expires_at;
  if (!connection.access_token || tokenNeedsRefresh(connection,now) ||
      expiry && (!Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= now)) {
    throw new ProbeError('Stored token missing or expired/near expiry; probe will not refresh credentials');
  }
  const order=await fetchJourney({...connection,shop_domain:domain,api_version:'2026-07'},id,{gql,maxPages:10});
  if (order.evidence_status === 'unavailable') throw new ProbeError('Order unavailable; probe did not verify a real order');
  if (order.customerJourneySummary?.ready !== true) throw new ProbeError('Journey unavailable or not ready; verification pending');
  return {status:'success',mode:'one_order_probe',orders:1,api_version:'2026-07',
    ready:true,visits:order.customerJourneySummary.moments.nodes.length,committed:false};
}

export async function probeMain(env,deps) {
  try {
    console.log(JSON.stringify(await runAttributionProbe(env,deps)));
    return 0;
  } catch (error) {
    // Upstream responses may contain customer data or credentials. Never log them.
    console.error(JSON.stringify({status:'failed',mode:'one_order_probe',committed:false,
      reason:error instanceof ProbeError ? error.message : 'Connection or Shopify query failed; no writes performed'}));
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {createClient}=await import('@supabase/supabase-js');
  process.exitCode=await probeMain(process.env,{createClient});
}
