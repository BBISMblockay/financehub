import {loadJourneyRecords} from './silo-attribution-overview.js';
import {loadSpend} from './silo-attribution-spend.js';
import {mountReport,loadRows} from './silo-attribution-report.js';
const cfg=window.__SILO_CONFIG__||{},root=document.querySelector('#attribution'),status=root.querySelector('#status');
function fail(message){status.textContent=message;status.className='bcn-status bcn-status--neg';status.hidden=false;}
async function boot(){
  if(!cfg.SUPABASE_URL||!cfg.SUPABASE_ANON_KEY)throw Error('Missing Supabase configuration');
  const db=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY);
  const {data,error}=await db.auth.getSession();if(error)throw error;
  if(!data.session){window.location.href='/pages/login.html';return;}
  const company=await cfg.ensureActiveCompany?.(db);if(!company?.id)throw Error('Select an active company first');
  const profile=await db.from('profiles').select('role,active_company_id').eq('id',data.session.user.id).single();if(profile.error)throw profile.error;
  window.SiloChrome?.mount({appEl:'#silo-app',active:'reports/silo-attribution',user:{email:data.session.user.email,role:profile.data.role},crumbs:['Marketing','Silo Attribution'],supabaseClient:db});
  function assertCompany(profileData){
   if(profileData?.active_company_id!==company.id || !window.SiloNav?.isSiloAttributionEnabled(company)){
     root.querySelector('#load').disabled=true;root.querySelector('#results').hidden=true;root.querySelector('#journey').close();
     root.querySelectorAll?.('#overview dialog[open]').forEach(d=>d.close());
     throw Error('Silo Attribution is available only in the Baseballism pilot workspace. Select that workspace and reload.');
   }
 }
 assertCompany(profile.data);
 async function withCompany(action){
   const check=async()=>{const current=await db.from('profiles').select('active_company_id').eq('id',data.session.user.id).single();if(current.error)throw current.error;assertCompany(current.data);};
   await check();const result=await action();await check();return result;
 }
  const {data:connected,error:storeError}=await db.from('shopify_connections').select('id,shop_domain').eq('company_entity_id',company.id).eq('is_active',true).order('shop_domain');if(storeError)throw storeError;
  if(!connected.length)throw Error('No active Shopify stores');
  // One row per store the attribution sync has collected: its newest collected day, and how many
  // of those days carry money. A retail location with no online orders is collected in full and
  // reports nothing but zeroes, so it is not a store worth offering. Aggregated in the database
  // because the day table grows without bound and the 1000-row page cap would otherwise start
  // dropping stores from this list silently.
  if(!/^[0-9a-f-]{36}$/i.test(company.id))throw Error('Invalid active company');
  const {data:collected,error:collectedError}=await db.rpc('chat_run_readonly_query',{query:`select connection_id, max(day) as last_day, count(*) filter (where total_cents <> 0 or net_cents <> 0) as funded_days from public.shopify_attribution_days where company_entity_id='${company.id}'::uuid group by connection_id`});
  if(collectedError)throw collectedError;
  if(!Array.isArray(collected))throw Error('Unexpected reporting result');
  const coverage=new Map(collected.map(row=>[row.connection_id,row]));
  const funded=connected.filter(store=>Number(coverage.get(store.id)?.funded_days||0)>0);
  // Nothing collected yet (a new workspace, or the sync's first run still pending): offer every
  // active store rather than an empty picker.
  const stores=funded.length?funded:connected;
  for(const store of stores){const option=document.createElement('option');option.value=store.id;option.textContent=store.shop_domain;root.querySelector('#store').append(option);}
  const app=mountReport(root,{journeys:(orders,args)=>withCompany(()=>loadJourneyRecords(db,company.id,args.connectionId,orders)),spend:args=>withCompany(()=>loadSpend(db,company.id,args.start,args.end)),load:args=>withCompany(()=>loadRows(db,company.id,args.connectionId,args.start,args.end,args.windowDays)),evidence:row=>withCompany(async()=>{
    const {data,error}=await db.from('shopify_attribution_orders').select('evidence,fetched_at').eq('company_entity_id',company.id).eq('connection_id',row.connection_id).eq('order_id',row.order_id).single();if(error)throw error;return data;
  })});
  const params=new URLSearchParams(location.search);
  const requested=params.get('store'),selected=stores.some(s=>s.id===requested)?requested:stores[0].id;
  root.querySelector('#store').value=selected;
  // Dates follow the store that is actually selected; reading the first store's newest day dated
  // the period from a store the report was not about.
  const latest=coverage.get(selected)?.last_day;
  const yesterday=latest||new Date(Date.now()-86400000).toISOString().slice(0,10);root.querySelector('#end').value=yesterday;root.querySelector('#start').value=new Date(Date.parse(yesterday)-29*86400000).toISOString().slice(0,10);
  for(const id of ['start','end'])if(/^\d{4}-\d{2}-\d{2}$/.test(params.get(id)||''))root.querySelector('#'+id).value=params.get(id);
  if(['7','14','30','60'].includes(params.get('window')))root.querySelector('#window').value=params.get('window');
  await app.refresh();
}
boot().catch(e=>fail(e.message||String(e)));
