import {loadJourneyRecords} from './silo-attribution-overview.js';
import {saveReviewTask} from './silo-attribution-actions.js';
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
  const {data:stores,error:storeError}=await db.from('shopify_connections').select('id,shop_domain').eq('company_entity_id',company.id).eq('is_active',true).order('shop_domain');if(storeError)throw storeError;
  for(const store of stores){const option=document.createElement('option');option.value=store.id;option.textContent=store.shop_domain;root.querySelector('#store').append(option);}
  if(!stores.length)throw Error('No active Shopify stores');
  const membership=await db.from('entity_memberships').select('user_id').eq('entity_id',company.id);
  const memberIds=(membership.data||[]).map(m=>m.user_id);
  const people=memberIds.length?await db.from('profiles').select('id,name,email').in('id',memberIds):{data:[]};
  const owners=(people.data||[]).map(p=>({id:p.id,name:p.name||p.email||p.id}));
  const app=mountReport(root,{owners,journeys:(orders,args)=>withCompany(()=>loadJourneyRecords(db,company.id,args.connectionId,orders)),saveDraft:fields=>saveReviewTask({db,...fields,context:{...fields.context,companyId:company.id,userId:data.session.user.id},checkCompany:()=>withCompany(async()=>{})}),load:args=>withCompany(()=>loadRows(db,company.id,args.connectionId,args.start,args.end,args.windowDays)),evidence:row=>withCompany(async()=>{
    const {data,error}=await db.from('shopify_attribution_orders').select('evidence,fetched_at').eq('company_entity_id',company.id).eq('connection_id',row.connection_id).eq('order_id',row.order_id).single();if(error)throw error;return data;
  })});
  const {data:latest,error:latestError}=await db.from('shopify_attribution_days').select('day').eq('company_entity_id',company.id).eq('connection_id',stores[0].id).order('day',{ascending:false}).limit(1);if(latestError)throw latestError;
  const yesterday=latest?.[0]?.day||new Date(Date.now()-86400000).toISOString().slice(0,10);root.querySelector('#end').value=yesterday;root.querySelector('#start').value=new Date(Date.parse(yesterday)-29*86400000).toISOString().slice(0,10);
  const params=new URLSearchParams(location.search);
  if(stores.some(s=>s.id===params.get('store')))root.querySelector('#store').value=params.get('store');
  for(const id of ['start','end'])if(/^\d{4}-\d{2}-\d{2}$/.test(params.get(id)||''))root.querySelector('#'+id).value=params.get(id);
  if(['7','14','30','60'].includes(params.get('window')))root.querySelector('#window').value=params.get('window');
  await app.refresh();
}
boot().catch(e=>fail(e.message||String(e)));
