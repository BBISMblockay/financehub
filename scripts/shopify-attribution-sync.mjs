// Manual bounded backfill, or opt-in scheduled trailing-seven-day refresh.
import { createClient } from '@supabase/supabase-js';
import { ensureShopifyAccessToken } from './lib/shopify-auth-lib.mjs';
import { shopifyGraphql,shopifyql,fetchWithRetry } from './lib/shopify-sync-core.mjs';
import { normalizeShopDomain } from './lib/shopify-auth-lib.mjs';
import { collectDay,dayRange } from './lib/shopify-attribution-evidence.mjs';

const env=process.env, scheduled=env.ATTRIBUTION_MODE === 'scheduled';
if (scheduled && env.ATTRIBUTION_SYNC_ENABLED !== 'true') {
  console.log('Attribution scheduled sync disabled'); process.exit(0);
}
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.ATTRIBUTION_CONNECTION_ID) throw Error('Supabase credentials and one explicit connection required');
const db=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const {data:connection,error}=await db.from('shopify_connections').select('*').eq('id',env.ATTRIBUTION_CONNECTION_ID).single();
if(error || !connection?.is_active || !connection.sync_enabled) throw Error('Active sync-enabled connection required');
if (!normalizeShopDomain(connection.shop_domain)) throw Error('Invalid Shopify domain');
await ensureShopifyAccessToken(db,connection);
// Pin the version measured by the pilot rather than an old connection default.
connection.api_version='2026-07';
let start=env.ATTRIBUTION_START,end=env.ATTRIBUTION_END;
if(scheduled){
  if(start || end)throw Error('Scheduled mode cannot also supply explicit dates');
  const shop=(await shopifyGraphql(connection,'query AttributionCalendar { shop { ianaTimezone } }')).shop;
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:shop.ianaTimezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const shift=n=>new Date(Date.parse(today)-n*86400000).toISOString().slice(0,10);
  start=shift(7);end=shift(1);
}
const days=dayRange(start,end),commit=scheduled || env.ATTRIBUTION_COMMIT === 'true';
for(const day of days){
  console.log(JSON.stringify({day,status:'collecting',commit}));
  const result=await collectDay(connection,day,{
    ql:shopifyql,gql:shopifyGraphql,commit,
    rest:async(c,id)=>{
      const response=await fetchWithRetry(`https://${c.shop_domain}/admin/api/${c.api_version}/orders/${id}.json?fields=id,landing_site`,{headers:{'X-Shopify-Access-Token':c.access_token}});
      if(!response.ok)throw Error('Order landing fetch failed: '+response.status);
      return (await response.json()).order;
    },
    publish:async args=>{const {data,error}=await db.rpc('publish_shopify_attribution_day',args);if(error)throw Error('Snapshot publication failed: '+error.message);if(!data)throw Error('Snapshot superseded by a newer extraction');},
  });
  console.log(JSON.stringify({...result,status:'success'}));
}
