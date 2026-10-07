// Manual bounded backfill, or opt-in scheduled trailing-seven-day refresh.
import { createClient } from '@supabase/supabase-js';
import { ensureShopifyAccessToken } from './lib/shopify-auth-lib.mjs';
import { shopifyGraphql,shopifyql,fetchWithRetry } from './lib/shopify-sync-core.mjs';
import { normalizeShopDomain } from './lib/shopify-auth-lib.mjs';
import { collectDay,dayRange } from './lib/shopify-attribution-evidence.mjs';

import {allocationWindows} from '../v2/silo-attribution-model.js';
import {loadCatalog} from './lib/silo-attribution-catalog.mjs';
import {coverageConfig,runCoverage,canPublish,storeToday} from './lib/shopify-attribution-coverage.mjs';

const env=process.env, scheduled=env.ATTRIBUTION_MODE === 'scheduled';
const coverage=env.ATTRIBUTION_MODE === 'coverage';
if (coverage && env.ATTRIBUTION_COVERAGE_ENABLED !== 'true') {
  console.log('Attribution coverage disabled'); process.exit(0);
}
if (scheduled && env.ATTRIBUTION_SYNC_ENABLED !== 'true') {
  console.log('Attribution scheduled sync disabled'); process.exit(0);
}
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || (!coverage && !env.ATTRIBUTION_CONNECTION_ID)) throw Error('Supabase credentials and one explicit connection required');
const db=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
if (coverage) {
  if (env.ATTRIBUTION_START || env.ATTRIBUTION_END || env.ATTRIBUTION_CONNECTION_ID) throw Error('Coverage cannot also supply single-store inputs');
  const config=coverageConfig(env), catalogs=new Map();
  const checked=async query=>{const {data,error}=await query;if(error)throw Error('Coverage database operation failed');return data;};
  const result=await runCoverage({config,deadline:Date.now()+270*60*1000,
    listConnections:async()=>{
      const rows=[];
      for(let offset=0;;offset+=500){
        let q=db.from('shopify_connections').select('id,company_entity_id,is_active,sync_enabled').eq('is_active',true).eq('sync_enabled',true).order('id').range(offset,offset+499);
        if(!config.companies.includes('*'))q=q.in('company_entity_id',config.companies);
        const page=await checked(q);rows.push(...page);if(page.length<500)return rows;
      }
    },
    currentConnection:id=>checked(db.from('shopify_connections').select('*').eq('id',id).maybeSingle()),
    loadState:id=>checked(db.from('shopify_attribution_coverage').select('*').eq('connection_id',id).maybeSingle()),
    saveState:state=>checked(db.from('shopify_attribution_coverage').upsert(state,{onConflict:'connection_id'})),
    loadSnapshots:async(id,start)=>{
      const rows=[];
      for(let offset=0;;offset+=500){
        const page=await checked(db.from('shopify_attribution_days').select('day,extracted_at').eq('connection_id',id).gte('day',start).order('day').range(offset,offset+499));
        rows.push(...page);if(page.length<500)return rows;
      }
    },
    prepare:async connection=>{
      if(!normalizeShopDomain(connection.shop_domain))throw Error('Invalid Shopify domain');
      await ensureShopifyAccessToken(db,connection);connection.api_version='2026-07';
      const shop=(await shopifyGraphql(connection,'query AttributionCalendar { shop { ianaTimezone } }')).shop;
      connection.coverageTimezone=shop.ianaTimezone;
      catalogs.set(connection.id,await loadCatalog(db,connection.company_entity_id));return shop.ianaTimezone;
    },
    runDay:(connection,day)=>publishDay(connection,day,true,catalogs.get(connection.id),async()=>{
      const fresh=await checked(db.from('shopify_connections').select('*').eq('id',connection.id).maybeSingle());
      if(!canPublish(fresh,connection,config,day,storeToday(connection.coverageTimezone))) throw Error('Coverage eligibility changed');
    }),
  });
  if(result.failures)process.exitCode=1;
} else {
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
const catalog=await loadCatalog(db,connection.company_entity_id);
const days=dayRange(start,end),commit=scheduled || env.ATTRIBUTION_COMMIT === 'true';
for(const day of days){
  await publishDay(connection,day,commit,catalog);
}
}
async function publishDay(connection,day,commit,catalog,beforePublish=async()=>{}){
  console.log(JSON.stringify({day,status:'collecting',commit}));
  const result=await collectDay(connection,day,{
    ql:shopifyql,gql:shopifyGraphql,commit,decorate:evidence=>allocationWindows(evidence,catalog),
    rest:async(c,id)=>{
      const response=await fetchWithRetry(`https://${c.shop_domain}/admin/api/${c.api_version}/orders/${id}.json?fields=id,landing_site`,{headers:{'X-Shopify-Access-Token':c.access_token}});
      if(!response.ok)throw Error('Order landing fetch failed: '+response.status);
      return (await response.json()).order;
    },
    publish:async args=>{await beforePublish();const {data,error}=await db.rpc('publish_shopify_attribution_day',args);if(error)throw Error('Snapshot publication failed: '+error.message);if(!data)throw Error('Snapshot superseded by a newer extraction');},
  });
  console.log(JSON.stringify({...result,status:'success'}));
}
